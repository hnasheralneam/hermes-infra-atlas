"""Map a tool call onto graph nodes.

Used by the guardrail (is this call touching registered infrastructure?) and by
the activity overlay (which node lights up?). The index is rebuilt only when the
node table changes, keyed on its size and newest ``updated_at``.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Optional

# Verbs that mean "this command changes or inspects a live system".
TOUCH_VERBS = (
    "ssh", "scp", "sftp", "rsync", "systemctl", "journalctl", "service", "docker", "podman",
    "docker-compose", "scp", "qm", "pct", "pvesh", "curl", "wget", "nc", "ncat", "nmap",
    "tailscale", "headscale", "ufw", "iptables", "nft", "kill", "pkill", "killall", "rm",
    "mv", "cp", "tee", "ansible", "terraform", "kubectl", "helm", "psql", "mysql", "redis-cli",
)
READ_COMMANDS = ("cat ", "less ", "tail ", "head ", "grep ", "ls ", "stat ", "systemctl status", "systemctl show")

_VMID_CMD_RE = re.compile(r"\b(?:qm|pct)\s+\w+(?:\s+\w+)?\s+(\d{3,4})\b")
_WORD_RE = re.compile(r"[A-Za-z0-9_.:@/-]{2,}")

_lock = threading.Lock()
_cache: dict[str, Any] = {"key": None, "index": {}, "nodes": {}}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def _tokens_for(node: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in ("id", "label", "host_ip", "tailnet_ip", "systemd_unit", "project_path", "registry_path"):
        value = node.get(key)
        if value:
            tokens.add(str(value).strip().lower())
    if node.get("project_path"):
        tokens.add(str(node["project_path"]).rstrip("/").lower())
        tokens.add(_slug(str(node["project_path"]).rstrip("/").split("/")[-1]))
    if node.get("registry_path"):
        stem = str(node["registry_path"]).rsplit("/", 1)[-1].removesuffix(".md")
        tokens.add(stem.lower())
    if node.get("systemd_unit"):
        tokens.add(str(node["systemd_unit"]).removesuffix(".service").lower())
    if node.get("label"):
        tokens.add(_slug(str(node["label"])))
    return {token for token in tokens if token and len(token) >= 3}


def _build(store) -> dict[str, Any]:
    nodes = store.list_nodes()
    signature = (len(nodes), max((node.get("updated_at") or 0) for node in nodes) if nodes else 0)
    with _lock:
        if _cache["key"] == signature:
            return _cache
        index: dict[str, str] = {}
        by_id: dict[str, dict[str, Any]] = {}
        vmid_index: dict[int, str] = {}
        for node in nodes:
            by_id[node["id"]] = node
            if node.get("vmid"):
                vmid_index[int(node["vmid"])] = node["id"]
            for token in _tokens_for(node):
                # First writer wins: an exact id never gets shadowed by a label.
                index.setdefault(token, node["id"])
        _cache.update({"key": signature, "index": index, "nodes": by_id, "vmid": vmid_index})
        return _cache


def refresh() -> None:
    with _lock:
        _cache["key"] = None


def match_text(store, text: str) -> list[dict[str, Any]]:
    """Nodes referenced by a free-form string (command, path, prompt)."""
    if not text:
        return []
    cache = _build(store)
    haystack = str(text).lower()
    found: dict[str, dict[str, Any]] = {}
    for token, node_id in cache["index"].items():
        if len(token) < 4 and not token[0].isdigit():
            continue
        if token in haystack:
            node = cache["nodes"].get(node_id)
            if node:
                found[node_id] = node
    for match in _VMID_CMD_RE.finditer(haystack):
        node_id = cache.get("vmid", {}).get(int(match.group(1)))
        if node_id and node_id in cache["nodes"]:
            found[node_id] = cache["nodes"][node_id]
    return list(found.values())


def nodes_for_registry_path(store, path: str) -> list[dict[str, Any]]:
    """Nodes whose registry entry is the given file."""
    if not path:
        return []
    import os

    cache = _build(store)
    normalised = str(path).replace("\\", "/")
    hits = []
    for node in cache["nodes"].values():
        registry_path = str(node.get("registry_path") or "")
        if not registry_path:
            continue
        if normalised.endswith(registry_path) or normalised.endswith(registry_path.replace("/", os.sep)):
            hits.append(node)
    return hits


def _command_words(command: str) -> set[str]:
    return {word.lower() for word in _WORD_RE.findall(command)}


def classify(store, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Return ``{"role": "read"|"touch"|"none", "nodes": [...]}`` for one tool call."""
    args = args or {}
    if tool_name in {"infra_query", "infra_upsert", "infra_incidents", "infra_sweep", "infra_diff", "infra_bootstrap"}:
        return {"role": "plugin", "nodes": []}

    if tool_name in {"read_file", "search_files"}:
        path = str(args.get("path") or args.get("file_path") or args.get("pattern") or "")
        nodes = nodes_for_registry_path(store, path)
        if nodes:
            return {"role": "read", "nodes": nodes}
        if path:
            hits = match_text(store, path)
            # reading a project file is a legitimate way to learn context
            project_hits = [node for node in hits if node.get("project_path") and path.startswith(str(node["project_path"]))]
            if project_hits:
                return {"role": "read", "nodes": project_hits}
        return {"role": "none", "nodes": []}

    if tool_name in {"write_file", "patch"}:
        path = str(args.get("path") or args.get("file_path") or "")
        hits = [
            node
            for node in match_text(store, path)
            if node.get("project_path") and path.startswith(str(node["project_path"]))
        ]
        return {"role": "touch", "nodes": hits} if hits else {"role": "none", "nodes": []}

    if tool_name == "terminal":
        command = str(args.get("command") or "")
        if not command:
            return {"role": "none", "nodes": []}
        words = _command_words(command)
        verb_hit = any(
            word == verb or word.startswith(f"{verb}.") or word.endswith(f"/{verb}")
            for word in words
            for verb in TOUCH_VERBS
        )
        if not verb_hit:
            # A pure read (`cat`, `grep`, `systemctl status`) still names nodes, but
            # it is not a mutation: treat it as a read for the guardrail.
            read_only = any(marker in command for marker in READ_COMMANDS) and "systemctl restart" not in command
            nodes = match_text(store, command)
            return {"role": "read" if (read_only and nodes) else "none", "nodes": nodes}
        nodes = match_text(store, command)
        return {"role": "touch", "nodes": nodes} if nodes else {"role": "none", "nodes": []}

    return {"role": "none", "nodes": []}


def preview(args: dict[str, Any], limit: int = 240) -> str:
    """Short, redacted-ish rendering of tool arguments for the ledger."""
    for key in ("command", "path", "file_path", "goal", "query"):
        value = args.get(key)
        if value:
            return str(value)[:limit]
    try:
        import json

        return json.dumps(args, default=str)[:limit]
    except Exception:
        return str(args)[:limit]


def now() -> float:
    return time.time()
