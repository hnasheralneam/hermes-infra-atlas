"""Markdown knowledge-base reader/writer.

Two input shapes are supported and always produce the same node dict:

* an entry with YAML frontmatter (deterministic — this is what ``infra_upsert``
  writes), and
* a legacy free-form entry (our own registry today): id/kind from the folder and
  filename, then regex heuristics for IPs, ports, systemd units, VMIDs, the
  management method and the known-pitfall bullet.

Writes are atomic and never truncate the runbook prose: the frontmatter block is
merged in place and the body below it is preserved byte for byte.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

FOLDERS = {"servers": "server", "services": "service", "projects": "project"}
KIND_PREFIX = {"server": "srv", "service": "svc", "project": "proj", "vm": "vm", "lxc": "lxc", "container": "ct"}
KIND_STRATUM = {"server": 1, "network": 1, "vm": 2, "lxc": 2, "container": 2, "service": 3, "project": 3}

_FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_PRIVATE_IP_RE = re.compile(
    r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b"
)
_TAILNET_IP_RE = re.compile(r"\b100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b")
_UNIT_RE = re.compile(r"\b([A-Za-z0-9@._-]+\.service)\b")
_VMID_RE = re.compile(r"\b(?:VM|LXC|CT|guest)\s*#?\s*(\d{3,4})\b", re.I)
# Deliberately strict: a bare ":8000" in prose is usually a timestamp ("12:02")
# or a heading, so ports only come from an address, a tcp suffix or a label.
_PORT_RES = (
    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}:(\d{2,5})\b"),
    re.compile(r"\blocalhost:(\d{2,5})\b", re.I),
    re.compile(r"\b[A-Za-z0-9][A-Za-z0-9.-]*\.(?:local|lan|dev|com|net|org|io|edu):(\d{2,5})\b", re.I),
    re.compile(r"\b(\d{2,5})/tcp\b", re.I),
    re.compile(r"\bport\s*(?:number)?\s*[:=]?\s*(\d{2,5})\b", re.I),
    re.compile(r"\blistens?\s+on\s+(?:port\s+)?(\d{2,5})\b", re.I),
    re.compile(r"^\s*[-*]?\s*(?:\*\*)?ports?(?:\*\*)?\s*:\s*\**\s*(\d{2,5})\b", re.I),
    re.compile(r"^\s*\|\s*(?:port|listen)\s*\|\s*(\d{2,5})\b", re.I),
)
_MANAGED_RES = (
    (re.compile(r"systemctl\s+--user|systemd\s*-{0,1}\s*user", re.I), "systemd-user"),
    (re.compile(r"\bsystemctl\b|\bsystemd\b", re.I), "systemd-system"),
    (re.compile(r"docker[ -]?compose|podman[ -]?compose", re.I), "docker-compose"),
    (re.compile(r"llama-dashboard\s+Control|llama-ctl", re.I), "llama-control"),
    (re.compile(r"\b(?:qm|pct|pvesh)\b", re.I), "proxmox"),
)
_REMOVED_RE = re.compile(r"\b(REMOVED|DECOMMISSIONED|DEPRECATED|RETIRED|GONE)\b")
_PITFALL_HEADING_RE = re.compile(r"^#{2,6}\s*(pitfalls?|gotchas?|caveats?|important|warnings?|do not|don't)\b", re.I)
_BOLD_RULE_RE = re.compile(r"^\s*(?:[-*]\s*)?\*\*(never|do not|don't|always|must)\b.*?\*\*", re.I)


def _first_ip(body: str) -> Optional[str]:
    """First usable private IPv4 in the entry head (title/table), else anywhere in the body.

    Network/broadcast addresses (``x.x.x.0`` / ``x.x.x.255``) are skipped: registry
    prose names subnets far more often than it names a host by such an address.
    """
    head = "\n".join(body.splitlines()[:30])
    for candidate in (head, body):
        for match in _PRIVATE_IP_RE.finditer(candidate):
            ip = match.group(0)
            if ip.rsplit(".", 1)[-1] in {"0", "255"}:
                continue
            return ip
    return None


def _clean_label(text: str) -> str:
    cleaned = re.sub(r"`([^`]*)`", r"\1", text)
    cleaned = re.sub(r"\s*[—–]\s*", " — ", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip(" *#")


def _now_est() -> str:
    try:
        from zoneinfo import ZoneInfo

        return _dt.datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d %H:%M %Z")
    except Exception:  # pragma: no cover
        return _dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def load_yaml(text: str) -> dict[str, Any]:
    """Parse frontmatter with the same YAML policy Hermes uses (ruamel, safe)."""
    if not text.strip():
        return {}
    try:
        from ruamel.yaml import YAML

        yaml = YAML(typ="safe", pure=True)
        data = yaml.load(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass
    try:  # pragma: no cover - second opinion for odd documents
        import yaml as _pyyaml

        data = _pyyaml.safe_load(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def dump_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(dump_scalar(item) for item in value) + "]"
    text = str(value)
    if text == "" or re.search(r"^[\s\-?:,\[\]{}#&*!|>'\"%@`]|:\s|\s#", text) or text.lower() in {
        "yes", "no", "on", "off", "true", "false", "null", "~",
    }:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


FRONTMATTER_ORDER = (
    "id", "kind", "label", "parent_id", "host_ip", "tailnet_ip", "vmid", "ports",
    "managed_by", "systemd_unit", "project_path", "probe", "recovery_cmd",
    "auto_heal_policy", "depends_on", "status", "aliases", "pitfalls", "verified_at",
)


def render_frontmatter(meta: dict[str, Any]) -> str:
    keys = [k for k in FRONTMATTER_ORDER if meta.get(k) not in (None, "", [])]
    keys += [k for k in meta if k not in FRONTMATTER_ORDER and meta.get(k) not in (None, "", [])]
    lines = ["---"]
    for key in keys:
        lines.append(f"{key}: {dump_scalar(meta[key])}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def split_frontmatter(text: str) -> tuple[dict[str, Any], str, str]:
    """Return ``(frontmatter_dict, raw_frontmatter, body)``."""
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, "", text
    raw = match.group(0)
    body = text[len(raw):]
    return load_yaml(match.group(1)), raw, body


def slug_for(kind: str, stem: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    prefix = KIND_PREFIX.get(kind, "node")
    return cleaned if cleaned.startswith(f"{prefix}-") else f"{prefix}-{cleaned}"


def file_for(root: Path, kind: str, node_id: str) -> Path:
    folder = {"server": "servers", "service": "services", "project": "projects"}.get(kind)
    if not folder:
        folder = "services"
    stem = node_id
    for prefix in KIND_PREFIX.values():
        if stem.startswith(f"{prefix}-"):
            stem = stem[len(prefix) + 1:]
            break
    return root / folder / f"{stem}.md"


def _clean_pitfall(text: str) -> str:
    cleaned = re.sub(r"^\s*(?:[-*+]|\d+\.)\s+", "", text.strip())
    cleaned = cleaned.replace("**", "").replace("__", "")
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def extract_pitfalls(body: str, limit: int = 400) -> str:
    collected: list[str] = []
    in_section = False
    for line in body.splitlines():
        if _PITFALL_HEADING_RE.match(line.strip()):
            in_section = True
            continue
        if in_section and line.startswith("#"):
            in_section = False
        stripped = line.strip()
        if in_section and stripped.startswith(("-", "*")) and len(collected) < 6:
            collected.append(_clean_pitfall(stripped))
        elif _BOLD_RULE_RE.match(stripped) and len(collected) < 6:
            collected.append(_clean_pitfall(stripped))
        if sum(len(c) for c in collected) > limit:
            break
    return "; ".join(item for item in collected if item)[:limit]


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _infer_recovery(meta: dict[str, Any], body: str) -> tuple[Optional[str], str]:
    """Return ``(recovery_cmd, auto_heal_policy)`` derived from registry metadata."""
    explicit = str(meta.get("recovery_cmd") or "").strip() or None
    policy = str(meta.get("auto_heal_policy") or "inherit").strip().lower()
    if policy not in {"inherit", "auto", "playbook_only", "notify_only", "off"}:
        policy = "inherit"
    if explicit:
        return explicit, policy
    managed = str(meta.get("managed_by") or "").strip().lower()
    unit = str(meta.get("systemd_unit") or "").strip()
    if managed in {"systemd-user", "systemd"} and unit:
        return f"systemctl --user restart {unit}", policy
    if managed in {"systemd-system", "system"} and unit:
        return f"systemctl restart {unit}", policy
    if managed == "docker-compose" and re.search(r"compose", body, re.I):
        return None, policy  # needs a compose dir; agent handles it
    if managed == "llama-control":
        return None, "playbook_only" if policy == "inherit" else policy
    return None, policy


def parse_entry(path: Path, root: Path, kind_hint: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Parse one Markdown entry into the normalized doc-node shape (or None)."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    folder = path.parent.name.lower()
    kind = kind_hint or FOLDERS.get(folder) or "service"
    meta, _raw, body = split_frontmatter(text)

    stem = path.stem
    node_id = str(meta.get("id") or "").strip() or slug_for(kind, stem)
    label = str(meta.get("label") or meta.get("title") or "").strip()
    if not label:
        heading = re.search(r"^#\s+(.+)$", body, re.M)
        label = heading.group(1).strip() if heading else stem.replace("-", " ").title()
    label = _clean_label(label) or node_id

    head = "\n".join(body.splitlines()[:15])
    status = str(meta.get("status") or "").strip().lower()
    if not status:
        # Only the title (or an explicit status line) retires an entry. Prose
        # that mentions "removed" — a decommissioned front-end, an old route —
        # must not turn a live service into a removed one.
        title = re.search(r"^#\s+(.+)$", body, re.M)
        title_text = title.group(1) if title else ""
        first_para = next(
            (line.strip() for line in body.splitlines() if line.strip() and not line.lstrip().startswith("#")),
            "",
        )
        retired = bool(_REMOVED_RE.search(title_text)) or bool(
            re.match(r"^\**\s*(?:status|state)\s*\**\s*:?\s*\**\s*(?:removed|decommissioned|retired)\b", first_para, re.I)
        )
        status = "removed" if retired else "active"

    ip_match = meta.get("host_ip") or _first_ip(body)
    tailnet_match = meta.get("tailnet_ip") or (_TAILNET_IP_RE.search(body).group(0) if _TAILNET_IP_RE.search(body) else None)

    ports: list[str] = []
    declared = meta.get("ports") or []
    if isinstance(declared, (list, tuple)):
        ports = [str(p) for p in declared]
    elif isinstance(declared, str):
        ports = re.findall(r"\d{2,5}", declared)
    if not ports:
        for pattern in _PORT_RES:
            for match in pattern.finditer(body):
                value = match.group(1)
                if value not in ports:
                    ports.append(value)
            if len(ports) >= 6:
                break
    ports = sorted({p for p in ports if p.isdigit() and 1 <= int(p) <= 65535}, key=int)[:8]

    # Server docs mention many other hosts' units and IDs; only a service/container
    # entry (or an explicit frontmatter field) may claim one for itself.
    unit = meta.get("systemd_unit")
    if not unit and kind != "server":
        units = _UNIT_RE.findall(body)
        if units:
            unit = max(set(units), key=units.count)

    vmid = meta.get("vmid")
    if vmid in (None, ""):
        vmid_match = _VMID_RE.search(body) if kind in {"vm", "lxc", "container"} else None
        vmid = int(vmid_match.group(1)) if vmid_match else None
    else:
        try:
            vmid = int(vmid)
        except (TypeError, ValueError):
            vmid = None

    managed = str(meta.get("managed_by") or "").strip().lower() or None
    if not managed and (unit or kind != "server"):
        for pattern, label_managed in _MANAGED_RES:
            if pattern.search(body):
                managed = label_managed
                break

    pitfalls = str(meta.get("pitfalls") or "").strip()
    if not pitfalls:
        pitfalls = extract_pitfalls(body)

    recovery_cmd, heal_policy = _infer_recovery({**meta, "systemd_unit": unit, "managed_by": managed}, body)

    aliases = meta.get("aliases") or []
    if isinstance(aliases, str):
        aliases = [a.strip() for a in aliases.split(",") if a.strip()]
    depends_on = meta.get("depends_on") or []
    if isinstance(depends_on, str):
        depends_on = [d.strip() for d in depends_on.split(",") if d.strip()]

    probe = str(meta.get("probe") or "").strip() or None
    probe_explicit = bool(probe)
    if not probe and ip_match and ports:
        probe = f"tcp://{ip_match}:{ports[0]}"

    try:
        stat = path.stat()
        mtime, digest = stat.st_mtime, hashlib.sha256(text.encode("utf-8")).hexdigest()
    except OSError:
        mtime, digest = None, None

    node = {
        "id": node_id,
        "kind": str(meta.get("kind") or kind),
        "stratum": int(meta.get("stratum") or KIND_STRATUM.get(kind, 3)),
        "label": label,
        "parent_id": str(meta.get("parent_id") or "").strip() or None,
        "host_ip": str(ip_match).strip() if ip_match else None,
        "tailnet_ip": str(tailnet_match).strip() if tailnet_match else None,
        "vmid": vmid,
        "ports": ports,
        "managed_by": managed,
        "systemd_unit": unit,
        "project_path": str(meta.get("project_path") or "").strip() or None,
        "registry_path": str(path.relative_to(root)),
        "registry_mtime": mtime,
        "registry_hash": digest,
        "pitfalls_summary": pitfalls or None,
        "recovery_cmd": recovery_cmd,
        "auto_heal_policy": heal_policy,
        "probe": probe,
        "probe_inferred": bool(probe) and not probe_explicit,
        "depends_on": [str(d) for d in depends_on],
        "aliases": [str(a) for a in aliases],
        "doc_status": status,
        "drift_status": "doc_only" if kind == "project" else "stale",
        "health_status": "unknown",
        "doc_state": {
            "id": node_id,
            "kind": kind,
            "label": label,
            "status": status,
            "host_ip": str(ip_match).strip() if ip_match else None,
            "tailnet_ip": str(tailnet_match).strip() if tailnet_match else None,
            "vmid": vmid,
            "ports": ports,
            "managed_by": managed,
            "systemd_unit": unit,
            "recovery_cmd": recovery_cmd,
            "auto_heal_policy": heal_policy,
            "probe": probe,
            "frontmatter": bool(_raw),
        },
    }
    return node


def parse_registry(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return ``(nodes, edges)`` parsed from every entry under ``root``."""
    root = Path(root)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if not root.exists():
        return nodes, edges
    for folder, kind in FOLDERS.items():
        directory = root / folder
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            node = parse_entry(path, root, kind_hint=kind)
            if not node:
                continue
            nodes.append(node)
            if node.get("parent_id"):
                edges.append(
                    {"source_id": node["parent_id"], "target_id": node["id"], "relation": "hosts", "origin": "doc"}
                )
            for dep in node.get("depends_on") or []:
                edges.append({"source_id": node["id"], "target_id": dep, "relation": "depends_on", "origin": "doc"})
    return nodes, edges


def read_entry_text(root: Path, registry_path: str) -> str:
    root = Path(root)
    path = (root / registry_path).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        raise ValueError(f"refusing to read outside the registry: {registry_path}")
    return path.read_text(encoding="utf-8", errors="replace")


def read_index_text(root: Path) -> str:
    root = Path(root)
    path = root / "INDEX.md"
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def prepend_change_log(root: Path, heading: str, bullets: list[str]) -> None:
    """Insert one entry at the top of ``change-log.md`` (below the H1 when present)."""
    root = Path(root)
    path = root / "change-log.md"
    entry = f"\n## {heading}\n" + "\n".join(f"- {line}" for line in bullets) + "\n"
    if not path.exists():
        _atomic_write(path, "# Infrastructure change log\n" + entry)
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    insert_at = 0
    for index, line in enumerate(lines):
        if line.startswith("# "):
            insert_at = index + 1
            break
    head = "".join(lines[:insert_at])
    tail = "".join(lines[insert_at:])
    _atomic_write(path, head + entry + tail)


def update_index(root: Path, node: dict[str, Any]) -> None:
    """Best-effort INDEX.md row; never rewrites an existing mention."""
    root = Path(root)
    path = root / "INDEX.md"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    link = f"]({node['registry_path']})"
    if node["id"] in text or link in text:
        return
    section_title = {"server": "Servers", "service": "Services", "project": "Projects"}.get(node["kind"], "Services")
    detail = node.get("host_ip") or ""
    if node.get("ports"):
        detail = f"{detail}:{node['ports'][0]}" if detail else f"port {node['ports'][0]}"
    row = f"| [`{node['label']}`]({node['registry_path']}) | {detail or '—'} | {node.get('managed_by') or '—'} |\n"
    lines = text.splitlines(keepends=True)
    header_index = None
    heading_re = re.compile(rf"^#+\s*{section_title}\b", re.I)
    for index, line in enumerate(lines):
        if heading_re.match(line):
            header_index = index
            break
    if header_index is None:
        body = text if text.endswith("\n") else text + "\n"
        _atomic_write(path, body + f"\n## {section_title}\n\n| Entry | Address | Managed by |\n|---|---|---|\n" + row)
        return
    insert_at = len(lines)
    for index in range(header_index + 1, len(lines)):
        if lines[index].startswith("#"):
            insert_at = index
            break
    block = lines[header_index:insert_at]
    if not any(line.strip().startswith("|") for line in block):
        block = block + ["\n", "| Entry | Address | Managed by |\n", "|---|---|---|\n"]
    block.append(row)
    _atomic_write(path, "".join(lines[:header_index] + block + lines[insert_at:]))


def upsert_entry(
    root: Path,
    node: dict[str, Any],
    reason: str,
    session_id: str = "",
    body_append: str = "",
    create_body: str = "",
) -> dict[str, Any]:
    """Create/merge one registry entry, refresh INDEX.md and prepend a change-log entry."""
    root = Path(root)
    kind = str(node.get("kind") or "service")
    node_id = str(node.get("id") or "").strip()
    if not node_id:
        raise ValueError("node_id is required")
    path = file_for(root, kind, node_id)
    existed = path.exists()
    old_text = path.read_text(encoding="utf-8", errors="replace") if existed else ""
    _meta, _raw, old_body = split_frontmatter(old_text)

    meta: dict[str, Any] = {}
    if existed:
        meta.update(_meta)
    meta.update(
        {
            "id": node_id,
            "kind": kind,
            "label": node.get("label") or meta.get("label") or node_id,
            "status": node.get("status") or meta.get("status") or "active",
        }
    )
    for source_key, target_key in (
        ("parent_id", "parent_id"),
        ("host_ip", "host_ip"),
        ("tailnet_ip", "tailnet_ip"),
        ("vmid", "vmid"),
        ("ports", "ports"),
        ("managed_by", "managed_by"),
        ("systemd_unit", "systemd_unit"),
        ("project_path", "project_path"),
        ("probe", "probe"),
        ("recovery_cmd", "recovery_cmd"),
        ("auto_heal_policy", "auto_heal_policy"),
        ("depends_on", "depends_on"),
        ("pitfalls", "pitfalls"),
    ):
        value = node.get(source_key)
        if value not in (None, "", [], "inherit"):
            meta[target_key] = value
    meta["verified_at"] = _dt.date.today().isoformat()

    body = old_body
    if body_append.strip():
        body = body.rstrip("\n") + "\n\n" + body_append.strip() + "\n"
    if not existed:
        label = meta.get("label") or node_id
        body = body or f"\n# {label}\n\n{create_body.strip()}\n"
    if existed and len(body.splitlines()) < len(old_body.splitlines()):
        raise RuntimeError("refusing to write: the new body is shorter than the existing runbook")

    text = render_frontmatter(meta) + (body if body.startswith("\n") else "\n" + body.lstrip("\n"))
    _atomic_write(path, text)

    parsed = parse_entry(path, root, kind_hint=kind) or {
        "id": node_id,
        "kind": kind,
        "label": meta.get("label"),
        "registry_path": str(path.relative_to(root)),
    }
    update_index(root, parsed)
    action = "Created entry" if not existed else "Updated entry"
    bullets = [
        f"**Node:** `{node_id}` (`{parsed.get('registry_path')}`)",
        f"**Change:** {action} — {reason.strip() or 'no reason recorded'}",
    ]
    details = []
    for key in ("host_ip", "tailnet_ip", "vmid", "ports", "managed_by", "systemd_unit", "status"):
        if meta.get(key) not in (None, "", []):
            details.append(f"{key}={meta[key]}")
    if details:
        bullets.append("**Fields:** " + ", ".join(details))
    if session_id:
        bullets.append(f"**Source:** session `{session_id}` (infra-atlas)")
    else:
        bullets.append("**Source:** infra-atlas")
    prepend_change_log(root, f"{_now_est()} — [infra-atlas] {action}: {node_id}", bullets)

    return {**parsed, "created": not existed}


def mark_removed(root: Path, node: dict[str, Any], reason: str, session_id: str = "") -> dict[str, Any]:
    return upsert_entry(root, {**node, "status": "removed"}, reason, session_id=session_id)


def bootstrap_annotate(root: Path, dry_run: bool = False) -> dict[str, Any]:
    """Add frontmatter to legacy entries without touching their prose."""
    root = Path(root)
    annotated: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []
    if not root.exists():
        return {"annotated": [], "skipped": [], "errors": [f"registry path does not exist: {root}"]}
    for folder, kind in FOLDERS.items():
        directory = root / folder
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            text = path.read_text(encoding="utf-8", errors="replace")
            meta, raw, body = split_frontmatter(text)
            if raw and meta.get("id"):
                skipped.append(str(path.relative_to(root)))
                continue
            try:
                node = parse_entry(path, root, kind_hint=kind)
                if not node:
                    continue
                if dry_run:
                    annotated.append(str(path.relative_to(root)))
                    continue
                front = {
                    "id": node["id"],
                    "kind": node["kind"],
                    "label": node["label"],
                    "status": node["doc_status"],
                }
                for key in ("parent_id", "host_ip", "tailnet_ip", "vmid", "ports", "managed_by",
                            "systemd_unit", "project_path", "probe", "recovery_cmd", "pitfalls_summary"):
                    if node.get(key):
                        front["pitfalls" if key == "pitfalls_summary" else key] = node[key]
                front["verified_at"] = _dt.date.today().isoformat()
                new_text = render_frontmatter(front) + (body if body.startswith("\n") else "\n" + body.lstrip("\n"))
                _atomic_write(path, new_text)
                annotated.append(str(path.relative_to(root)))
            except Exception as exc:  # one bad file must not abort the sweep
                errors.append(f"{path.name}: {exc}")
    return {"annotated": annotated, "skipped": skipped, "errors": errors}
