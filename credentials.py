"""Private credential vault for infra-atlas.

The Markdown knowledge base is documentation: it is read by agents, mirrored to
Nextcloud every 30 minutes and committed to git. Credentials therefore never
live there. An entry *references* a credential by name::

    ---
    id: srv-cyberfield
    credentials: [cyberfield-pve-token, cyberfield-root-ssh]
    ---

and the value lives in this vault, outside the registry, mode 0600, encrypted
with Fernet when ``cryptography`` is available (a 0600 key file beside it) and
written as plaintext only as a degraded fallback — the file records which mode
it is in so a reader never has to guess.

Everything here is stdlib except the optional ``cryptography`` import, matching
the rest of the plugin (import-time must stay cheap and dependency-free).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from . import config as plugin_config

logger = logging.getLogger(__name__)

DEFAULT_NAME = "credentials.json"
DEFAULT_KEY_NAME = "credentials.key"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")

# A value that is obviously a pointer, not a secret. These are the shapes a
# runbook should use, so the literal scanner must not flag them.
_PLACEHOLDER_MARKERS = (
    "example", "placeholder", "redacted", "dummy", "not-needed", "nokey", "xxxx",
    "replace-me", "replace_me", "your-", "your_", "...", "…",
)

# ``password: hunter2`` / ``PASSWORD=hunter2`` / ``**Password:** `hunter2```
# (markdown bold and a colon inside the emphasis are both tolerated)
_PASSWORD_RE = re.compile(
    r"(?i)\b(?:password|passwd|passphrase|pwd|app[_-]?password|db[_-]?password)\b"
    r"[\s*]*[:=][\s*]*[\"'`]?([^\s\"'`,;)]{4,})"
)
# ``token=abc`` / ``api_key: abc`` / ``secret=abc`` (long enough to be real)
_TOKEN_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret)\b"
    r"\s*[:=]\s*[\"'`]?([A-Za-z0-9_\-./+~=]{8,})"
)
_SSHPASS_RE = re.compile(r"sshpass\s+-p\s*(?:'([^']+)'|\"([^\"]+)\"|([^\s'\"]+))")
_PVE_TOKEN_RE = re.compile(r"PVEA?PI?Token=([A-Za-z0-9@!._\-]{8,})")
_LDAP_PW_RE = re.compile(r"(?i)\buserPassword\s*:\s*(\S+)")


class CredentialError(RuntimeError):
    """Raised when the vault cannot be read or written safely."""


# --------------------------------------------------------------------------- paths

def _default_data_file(filename: str) -> Path:
    """Profile-safe default path under ``$HERMES_HOME/plugin-data/infra-atlas``."""
    try:
        from plugins.plugin_storage import plugin_data_dir  # noqa: PLC0415

        return Path(plugin_data_dir("infra-atlas")) / filename
    except Exception:  # pragma: no cover - standalone interpreter
        home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
        return home / "plugin-data" / "infra-atlas" / filename


def vault_path() -> Path:
    """The vault file, profile-scoped by default (``ctx.state.data_dir``)."""
    raw = plugin_config.setting("credentials_path")
    if not raw:
        return plugin_config.state_path(DEFAULT_NAME)
    return Path(os.path.expandvars(os.path.expanduser(str(raw))))


def key_path() -> Path:
    """The vault's encryption key, profile-scoped by default."""
    raw = plugin_config.setting("credentials_key_path")
    if not raw:
        return plugin_config.state_path(DEFAULT_KEY_NAME)
    return Path(os.path.expandvars(os.path.expanduser(str(raw))))


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:  # pragma: no cover - exotic filesystems
        logger.debug("infra-atlas: could not chmod %s to 0700", path)


def _write_private(path: Path, text: str) -> None:
    """Atomic 0600 write: temp file in the same directory, then rename."""
    _ensure_dir(path.parent)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():  # pragma: no cover - only on a failed replace
            try:
                tmp.unlink()
            except OSError:
                pass
    try:
        os.chmod(path, 0o600)
    except OSError:  # pragma: no cover
        pass


# --------------------------------------------------------------------- encryption

def _fernet(create: bool = False):
    """Return a Fernet for the vault key, or None when crypto is unavailable."""
    try:
        from cryptography.fernet import Fernet  # noqa: PLC0415 - optional dependency
    except Exception:  # pragma: no cover - trimmed install
        return None
    path = key_path()
    if not path.exists():
        if not create:
            return None
        _ensure_dir(path.parent)
        _write_private(path, Fernet.generate_key().decode())
    try:
        return Fernet(path.read_bytes().strip())
    except Exception:  # pragma: no cover - corrupt key file
        logger.warning("infra-atlas: unusable credential key at %s", path)
        return None


def _encrypt(value: str) -> str:
    vpath, kpath = vault_path(), key_path()
    if vpath.exists() and not kpath.exists():
        try:
            existing = json.loads(vpath.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
        if isinstance(existing, dict) and existing.get("encrypted") and existing.get("entries"):
            raise CredentialError(
                f"encrypted vault at {vpath} already holds entries, but its key at {kpath} is missing; "
                "refusing to mint a new key that would orphan existing secrets"
            )
    fernet = _fernet(create=True)
    if fernet is None:
        raise CredentialError(
            "the vault is encrypted but no usable key is available; refusing to store a secret in plaintext"
        )
    return fernet.encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt(blob: str) -> Optional[str]:
    fernet = _fernet()
    if fernet is None:
        raise CredentialError(f"vault is encrypted but the key at {key_path()} is missing or unusable")
    try:
        return fernet.decrypt(blob.encode("ascii")).decode("utf-8")
    except Exception:  # noqa: BLE001 - wrong key / corrupt token
        raise CredentialError(f"could not decrypt a vault entry with the key at {key_path()}") from None


# -------------------------------------------------------------------------- store

def _crypto_available() -> bool:
    try:
        import cryptography.fernet  # noqa: F401,PLC0415 - capability probe only
    except Exception:  # pragma: no cover - trimmed install
        return False
    return True


def _empty(encrypted: bool) -> dict[str, Any]:
    return {"version": 1, "encrypted": encrypted, "entries": {}}


def load() -> dict[str, Any]:
    path = vault_path()
    if not path.exists():
        # A brand-new vault is encrypted iff this interpreter *can* encrypt; the
        # key file itself is created on the first write.
        return _empty(_crypto_available())
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CredentialError(f"cannot read the credential vault at {path}: {exc}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("entries"), dict):
        raise CredentialError(f"malformed credential vault at {path}")
    doc.setdefault("version", 1)
    doc["encrypted"] = bool(doc.get("encrypted"))
    return doc


def _save(doc: dict[str, Any]) -> None:
    _write_private(vault_path(), json.dumps(doc, indent=2, sort_keys=True) + "\n")


def store_info() -> dict[str, Any]:
    doc = load()
    path = vault_path()
    try:
        mode = oct(path.stat().st_mode & 0o777)
    except OSError:
        mode = None
    return {
        "path": str(path),
        "exists": path.exists(),
        "encrypted": bool(doc.get("encrypted")),
        "key_path": str(key_path()) if doc.get("encrypted") else None,
        "mode": mode,
        "count": len(doc.get("entries") or {}),
    }


def _meta(name: str, entry: dict[str, Any], *, value_length: Optional[int]) -> dict[str, Any]:
    return {
        "name": name,
        "node_id": entry.get("node_id"),
        "kind": entry.get("kind"),
        "notes": entry.get("notes") or "",
        "value_length": value_length,
        "created_at": entry.get("created_at"),
        "updated_at": entry.get("updated_at"),
        "updated_by": entry.get("updated_by") or "",
    }


def list_entries() -> list[dict[str, Any]]:
    """Every credential's metadata — never a value."""
    doc = load()
    out: list[dict[str, Any]] = []
    for name, entry in sorted((doc.get("entries") or {}).items()):
        length: Optional[int] = entry.get("value_length")
        if length is None:
            try:
                length = len(_decrypt(entry["secret"]) or "") if doc.get("encrypted") else len(str(entry.get("secret") or ""))
            except CredentialError:
                length = None
        out.append(_meta(name, entry, value_length=length))
    return out


def has(name: str) -> bool:
    return name in (load().get("entries") or {})


def set_value(
    name: str,
    value: str,
    *,
    node_id: Optional[str] = None,
    kind: Optional[str] = None,
    notes: str = "",
    session_id: str = "",
    rotate: bool = False,
) -> dict[str, Any]:
    """Create or replace one credential. Returns metadata, never the value."""
    name = str(name or "").strip().lower()
    if not _NAME_RE.match(name):
        raise CredentialError(
            "credential name must be 2-64 chars of lowercase letters, digits, dot, dash or underscore (e.g. 'cyberfield-root-ssh')"
        )
    if value is None or str(value) == "":
        raise CredentialError("value must not be empty")
    doc = load()
    entries = doc.setdefault("entries", {})
    if name in entries and not rotate:
        raise CredentialError(f"credential {name!r} already exists — pass rotate=true to replace its value")
    now = time.time()
    existing = entries.get(name) or {}
    secret = _encrypt(value) if doc.get("encrypted") else str(value)
    entries[name] = {
        "node_id": node_id or existing.get("node_id"),
        "kind": kind or existing.get("kind") or "generic",
        "notes": notes or existing.get("notes") or "",
        "secret": secret,
        "value_length": len(str(value)),
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
        "updated_by": session_id or "agent",
    }
    _save(doc)
    return _meta(name, entries[name], value_length=len(str(value)))


def get_value(name: str) -> Optional[str]:
    """Return one credential's value, or None when it is not stored."""
    name = str(name or "").strip().lower()
    doc = load()
    entry = (doc.get("entries") or {}).get(name)
    if not entry:
        return None
    if doc.get("encrypted"):
        return _decrypt(entry["secret"])
    return str(entry.get("secret") or "")


def delete_value(name: str) -> bool:
    name = str(name or "").strip().lower()
    doc = load()
    entries = doc.get("entries") or {}
    if name not in entries:
        return False
    del entries[name]
    _save(doc)
    return True


# ------------------------------------------------------------ registry integration

def declared_refs(root: Path) -> dict[str, list[str]]:
    """``{node_id: [credential names]}`` as declared in registry frontmatter."""
    from . import registry_kb  # noqa: PLC0415 - avoid an import cycle at module load

    nodes, _edges = registry_kb.parse_registry(Path(root))
    return {node["id"]: list(node.get("credentials") or []) for node in nodes if node.get("credentials")}


def unreferenced() -> list[str]:
    """Stored credentials that no registry entry declares (orphans)."""
    declared = {name for names in declared_refs(plugin_config.registry_root()).values() for name in names}
    return [entry["name"] for entry in list_entries() if entry["name"] not in declared]


def missing() -> list[dict[str, Any]]:
    """Credentials a registry entry declares but the vault does not hold."""
    out = []
    for node_id, names in declared_refs(plugin_config.registry_root()).items():
        for name in names:
            if not has(name):
                out.append({"node_id": node_id, "name": name})
    return out


def node_credentials(node_id: str, node: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Declared credential names for one node plus whether each is stored."""
    names = list((node or {}).get("credentials") or [])
    if not names:
        names = declared_refs(plugin_config.registry_root()).get(node_id, [])
    stored = load().get("entries") or {}
    return {
        "declared": names,
        "refs": [
            {"name": name, "stored": name in stored, "kind": (stored.get(name) or {}).get("kind")}
            for name in names
        ],
        "missing": [name for name in names if name not in stored],
    }


def status_map(root: Optional[Path] = None) -> dict[str, dict[str, Any]]:
    """``{node_id: node_credentials(...)}`` in one registry parse (for list payloads)."""
    root = Path(root or plugin_config.registry_root())
    stored = load().get("entries") or {}
    out: dict[str, dict[str, Any]] = {}
    for node_id, names in declared_refs(root).items():
        out[node_id] = {
            "declared": names,
            "refs": [
                {"name": name, "stored": name in stored, "kind": (stored.get(name) or {}).get("kind")}
                for name in names
            ],
            "missing": [name for name in names if name not in stored],
        }
    return out


# ----------------------------------------------------------------- literal scan

def _is_placeholder(value: str, kind: str = "") -> bool:
    raw = value.strip().strip("\"'`")
    if not raw:
        return True
    low = raw.lower()
    if any(marker in low for marker in _PLACEHOLDER_MARKERS):
        return True
    if raw.startswith(("$", "<", "{", "%", "~", "/", "http://", "https://")):
        return True
    if raw.lower() in {"true", "false", "none", "null", "enabled", "disabled"}:
        return True
    if set(raw) <= {"*", "•", ".", "x", "X", "-", "…"}:
        return True
    # a path or a command, not a value
    if "/" in raw and " " not in raw and len(raw) > 12:
        return True
    # prose: a capitalized single word after "password:" ("…local password: Forgejo refuses")
    if re.fullmatch(r"[A-Z][a-z]+", raw):
        return True
    # a kebab-case *identifier* where an identifier is what the field means
    # ("Token: guac-provisioner" is the Proximo token's NAME, not its secret);
    # a kebab-case password ("ironclad-defense") is a real credential.
    if kind in {"token", "pve-api-token"} and re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)+", raw) and not re.search(r"\d", raw):
        return True
    return False


def _value_in_context(line: str, match: re.Match, value: str, kind: str = "") -> tuple[int, bool]:
    """Return ``(start, ok)`` — position of the value and whether it is a real literal.

    Drops the shapes that look like secrets but are not: a CLI flag
    (``--must-change-password=…``), the ``username/password`` phrasing, and
    anything :func:`_is_placeholder` recognises.
    """
    start = match.start(1) if match.lastindex else match.start()
    for index, group in enumerate(match.groups(), 1):
        if group == value:
            start = match.start(index)
            break
    before = line[max(0, start - 24):start]
    # a CLI flag: the dash-dash belongs to the KEY, not the value
    if line[max(0, match.start() - 2):match.start()] == "--":
        return start, False
    if re.search(r"\w/\s*$", before):
        return start, False
    return start, not _is_placeholder(value, kind)


def mask(value: str) -> str:
    text = str(value or "")
    if len(text) <= 4:
        return "…"
    return text[:2] + "…"


def scan_literals(root: Optional[Path] = None, *, include_generic: bool = False) -> list[dict[str, Any]]:
    """Find credential-shaped literals in the Markdown KB (never returns a full value)."""
    root = Path(root or plugin_config.registry_root())
    findings: list[dict[str, Any]] = []
    if not root.exists():
        return findings
    for folder in ("servers", "services", "projects"):
        directory = root / folder
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:  # pragma: no cover
                continue
            for number, line in enumerate(lines, 1):
                for regex, kind in (
                    (_PASSWORD_RE, "password"),
                    (_SSHPASS_RE, "ssh-password"),
                    (_PVE_TOKEN_RE, "pve-api-token"),
                    (_LDAP_PW_RE, "ldap-password"),
                    (_TOKEN_RE, "token"),
                ):
                    match = regex.search(line)
                    if not match:
                        continue
                    value = next((group for group in match.groups() if group), "") if match.groups() else ""
                    if not value:
                        continue
                    _, ok = _value_in_context(line, match, value, kind)
                    if not ok:
                        continue
                    excerpt = line.strip().replace(value, mask(value))[:160]
                    findings.append(
                        {
                            "file": str(path.relative_to(root)),
                            "line": number,
                            "kind": kind,
                            "preview": mask(value),
                            "length": len(value),
                            "excerpt": excerpt,
                        }
                    )
                    break
    return findings


def _suggest_name(finding: dict[str, Any]) -> str:
    stem = Path(finding["file"]).stem.lower()
    return re.sub(r"[^a-z0-9]+", "-", f"{stem}-{finding['kind']}").strip("-")[:64]


def scan_report(root: Optional[Path] = None) -> dict[str, Any]:
    findings = scan_literals(root)
    for finding in findings:
        finding["suggested_name"] = _suggest_name(finding)
    by_file: dict[str, int] = {}
    for finding in findings:
        by_file[finding["file"]] = by_file.get(finding["file"], 0) + 1
    return {
        "findings": findings,
        "count": len(findings),
        "files": by_file,
        "note": (
            "Registry entries should reference credentials by name (`credentials: [name]`) "
            "and store the value with infra_credentials(action='set'). Values are never shown here."
        ),
    }


__all__ = [
    "CredentialError",
    "declared_refs",
    "delete_value",
    "get_value",
    "has",
    "key_path",
    "list_entries",
    "load",
    "mask",
    "missing",
    "node_credentials",
    "scan_literals",
    "scan_report",
    "set_value",
    "store_info",
    "status_map",
    "unreferenced",
    "vault_path",
]
