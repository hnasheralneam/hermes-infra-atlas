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


# Kinds that own an address. When a token is claimed by one machine and by the
# services running on it, the machine is the referent.
_MACHINE_KINDS = {"server", "vm", "lxc", "peer", "host"}

# Identifier-shaped runs in free text, then the parts an id/unit/path is made of.
_SEGMENT_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")      # words, units, dotted ids
_PATH_SEGMENT_RE = re.compile(r"[a-z0-9][a-z0-9._/-]*")  # the same, allowing a path


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
    # address:port is what actually names a service on a shared host: several
    # nodes document the same IP, so the bare address is ambiguous while the
    # pair is unique.
    for host_key in ("host_ip", "tailnet_ip"):
        host = str(node.get(host_key) or "").strip()
        if not host:
            continue
        for port in node.get("ports") or []:
            text = str(port).strip()
            if text.isdigit():
                tokens.add(f"{host}:{text}")
    return {token for token in tokens if _IDENTIFIER_RE.match(token)}


_IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9._:@/-]{2,63}$")


def _primary_tokens(node: dict[str, Any]) -> set[str]:
    """Names that identify the node itself, not a phrase it appears in."""
    primary: set[str] = set()
    if node.get("id"):
        primary.add(str(node["id"]).lower())
    if node.get("registry_path"):
        primary.add(str(node["registry_path"]).rsplit("/", 1)[-1].removesuffix(".md").lower())
    if node.get("project_path"):
        primary.add(_slug(str(node["project_path"]).rstrip("/").split("/")[-1]))
    return {token for token in primary if token}


def _specific_tokens(node: dict[str, Any]) -> set[str]:
    """Tokens that name *this* node: ids, labels, units, paths — not addresses."""
    specific: set[str] = set()
    for key in ("id", "label", "systemd_unit", "project_path", "registry_path"):
        value = node.get(key)
        if value:
            specific.add(str(value).strip().lower())
    if node.get("registry_path"):
        specific.add(str(node["registry_path"]).rsplit("/", 1)[-1].removesuffix(".md").lower())
    if node.get("systemd_unit"):
        specific.add(str(node["systemd_unit"]).removesuffix(".service").lower())
    if node.get("label"):
        specific.add(_slug(str(node["label"])))
    return {token for token in specific if token and len(token) >= 3}


def _build(store) -> dict[str, Any]:
    # Hooks call this on every tool call: read through the plugin's read-only
    # connection so a writer (a sweep, another process) can never make the
    # guardrail wait.
    reader = getattr(store, "list_nodes_ro", None)
    nodes = reader() if reader is not None else store.list_nodes()
    signature = (len(nodes), max((node.get("updated_at") or 0) for node in nodes) if nodes else 0)
    with _lock:
        if _cache["key"] == signature:
            return _cache
        by_id: dict[str, dict[str, Any]] = {}
        vmid_index: dict[int, str] = {}
        # token -> every node that claims it. Values are shared all the time (a
        # host and its services carry the same address), so resolving a token to
        # one node here would make the first alphabetical owner answer for all.
        claims: dict[str, set[str]] = {}
        for node in nodes:
            by_id[node["id"]] = node
            if node.get("vmid"):
                vmid_index[int(node["vmid"])] = node["id"]
            for token in _tokens_for(node):
                claims.setdefault(token, set()).add(node["id"])
        _cache.update({"key": signature, "claims": claims, "nodes": by_id, "vmid": vmid_index})
        return _cache


def refresh() -> None:
    with _lock:
        _cache["key"] = None


def match_text(store, text: str) -> list[dict[str, Any]]:
    """Nodes a free-form string references (see ``_match_scored``)."""
    return [node for node, _score in _match_scored(store, text)]


def required_nodes(store, text: str) -> list[dict[str, Any]]:
    """Entries a touch must have read first: the most specific matches only.

    ``curl host:8090`` names the service on that port, so reading that entry is
    enough — demanding the host's entry too turned every service-level command
    into a two-entry read. A bare address (no port, no name) keeps every claimant.
    """
    scored = _match_scored(store, text)
    if not scored:
        return []
    best = max(score for _node, score in scored)
    if best >= 2:
        return [node for node, score in scored if score == best]
    return [node for node, _score in scored]


def _match_scored(store, text: str) -> list[tuple[dict[str, Any], int]]:
    """Nodes a free-form string (command, path, prompt) actually references.

    Specificity beats breadth: ``curl 10.0.0.212:4000`` names the service on that
    port, not the machine that shares the address, while ``ssh root@10.0.0.212``
    names the machine. A value claimed by several machines (every VM on a cluster
    documenting the node's IP) is not treated as a reference at all.
    """
    if not text:
        return []
    cache = _build(store)
    haystack = str(text).lower()
    # Whole identifiers only. Substring matching made "llama-dashboard" a
    # reference to "llama-ctl" and "llama-server" through the shared word
    # "llama", so two unrelated services were named for one command.
    candidates: set[str] = set(_SEGMENT_RE.findall(haystack))
    candidates.update(_PATH_SEGMENT_RE.findall(haystack))
    for segment in list(candidates):
        for part in segment.split("."):
            if part:
                candidates.add(part)
    hits: dict[str, set[str]] = {}
    for candidate in candidates:
        owners = cache["claims"].get(candidate)
        if not owners:
            continue
        for node_id in owners:
            hits.setdefault(node_id, set()).add(candidate)
    if not hits:
        # An explicit `qm <vmid>` / `pct <vmid>` still resolves.
        for match in _VMID_CMD_RE.finditer(haystack):
            node_id = cache.get("vmid", {}).get(int(match.group(1)))
            if node_id in cache["nodes"]:
                return [(cache["nodes"][node_id], 4)]
        return []

    def score(node_id: str) -> int:
        node = cache["nodes"].get(node_id) or {}
        # The entry that declares this probe owns this address:port, even when a
        # noisy neighbour lists the same port.
        probe = str(node.get("probe") or "").strip().lower()
        if probe:
            target = probe.replace("tcp://", "").replace("http://", "").replace("https://", "").rstrip("/")
            if probe in haystack or (target and target in haystack):
                return 4
        # Naming the node (unit, id, label, entry path) beats sharing an address
        # with it; an address:port pair names the service on that port.
        if hits[node_id] & _primary_tokens(node):
            return 3
        if hits[node_id] & _specific_tokens(node):
            return 2
        address = str(node.get("host_ip") or "").lower()
        ports = [str(port) for port in (node.get("ports") or [])]
        if address and address in haystack and any(f"{address}:{port}" in haystack for port in ports):
            return 2
        return 1

    scores = {node_id: score(node_id) for node_id in hits}
    best = max(scores.values())
    candidates = [node_id for node_id, value in scores.items() if value == best]
    if best == 1 and len(candidates) > 1:
        machines = [
            node_id
            for node_id in candidates
            if str((cache["nodes"].get(node_id) or {}).get("kind") or "") in _MACHINE_KINDS
        ]
        if len(machines) == 1:
            candidates = machines
        else:
            # Several machines share this value; a shared address is not a
            # reference, so only an unambiguous id/label hit counts.
            ids = [node_id for node_id in candidates if node_id in hits.get(node_id, set())]
            if len(ids) == 1:
                candidates = ids
            else:
                return []
    return [(cache["nodes"][node_id], scores[node_id]) for node_id in candidates if node_id in cache["nodes"]]


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
        nodes = required_nodes(store, command)
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
