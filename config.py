"""Settings and secret access for infra-atlas.

Two entry points read the same values:

* the agent half (`register(ctx)`) installs ``ctx.get_config`` via :func:`configure`,
  so every tool/hook reads the user's live settings;
* the dashboard backend (`dashboard/plugin_api.py`) is imported in a separate
  module namespace, so it reads ``plugins.entries.infra-atlas.settings`` through
  ``load_config_readonly()`` instead.

Secrets never come from here: they go through ``agent.secret_scope.get_secret``
(catalog rule 11) and are only fetched at the moment a collector is enabled.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = "infra-atlas"

# Path defaults are resolved at read time, not baked into this table: they live
# under the *active profile's* data dir so two profiles never share one vault
# (see :func:`data_dir`). ``None`` means "profile-scoped default".
DEFAULTS: dict[str, Any] = {
    "registry_path": None,
    "credentials_path": None,
    "credentials_key_path": None,
    "guardrail_mode": "block",
    # Heals touch real services, so automation is opt-in: the default only
    # records the incident and wakes the agent. ``auto`` runs the restart
    # playbook, and even then every command goes through Hermes approval.
    "auto_heal_mode": "notify_only",
    "failure_threshold": 2,
    "heal_cooldown_sec": 300,
    "enable_local_collector": True,
    "enable_hermes_collector": True,
    "enable_probes": True,
    "probe_timeout_sec": 1.5,
    "history_retention_days": 90,
    "proxmox_url": "",
    "proxmox_token_id": "",
    "proxmox_verify_tls": False,
    "headscale_url": "",
}

LEGACY_REGISTRY = "~/.hermes/infra-registry"

_getter: Optional[Callable[[str, Any], Any]] = None
_data_dir: Optional[Path] = None
_approver: Optional[Callable[..., Any]] = None


def configure(getter: Optional[Callable[[str, Any], Any]]) -> None:
    """Install the host-provided settings getter (``ctx.get_config``)."""
    global _getter
    _getter = getter


def configure_data_dir(path: Optional[Path]) -> None:
    """Install the profile-scoped data dir (``ctx.state.data_dir``)."""
    global _data_dir
    _data_dir = Path(path) if path else None


def configure_approver(fn: Optional[Callable[..., Any]]) -> None:
    """Install the restart approver.

    The approver runs one allow-listed command through Hermes' own approval
    gate (the host ``terminal`` tool) and reports what happened. With none
    installed — the dashboard process, a cron watchdog, a bare test — no
    restart is ever executed: the caller gets ``needs_approval`` instead.
    """
    global _approver
    _approver = fn


def approver() -> Optional[Callable[..., Any]]:
    return _approver


def data_dir() -> Path:
    """Profile-scoped directory for plugin-owned state (never the install dir)."""
    if _data_dir is not None:
        return _data_dir
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "plugin-data" / PLUGIN_ID
    except Exception:  # pragma: no cover - trimmed installs
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        return Path(home) / "plugin-data" / PLUGIN_ID


def _from_config_file(key: str, default: Any) -> Any:
    try:
        from hermes_cli.config import load_config_readonly
    except Exception:  # pragma: no cover - trimmed installs
        return default
    try:
        config = load_config_readonly() or {}
        entry = ((config.get("plugins") or {}).get("entries") or {}).get(PLUGIN_ID) or {}
        for subtree in ("settings", "config"):
            node: Any = entry.get(subtree) or {}
            parts = key.split(".")
            for part in parts[:-1]:
                node = (node or {}).get(part) if isinstance(node, dict) else None
            if isinstance(node, dict) and parts[-1] in node:
                return node[parts[-1]]
        # Manifest defaults are also mirrored into config.yaml on enable in some
        # versions; either way, fall through to our own default table.
    except Exception as exc:  # pragma: no cover
        logger.debug("infra-atlas: config read failed for %s: %s", key, exc)
    return default


def setting(key: str, default: Any = None) -> Any:
    """Read one plugin setting, falling back to the manifest default."""
    fallback = DEFAULTS.get(key, default)
    if _getter is not None:
        try:
            value = _getter(key, fallback)
        except Exception as exc:  # pragma: no cover
            logger.debug("infra-atlas: ctx.get_config(%s) failed: %s", key, exc)
            value = fallback
    else:
        value = _from_config_file(key, fallback)
    return fallback if value is None else value


def registry_root() -> Path:
    """Absolute path of the Markdown knowledge base.

    Defaults to the profile's data dir, and an unset/legacy ``~/.hermes/infra-registry``
    keeps working for existing installs.
    """
    raw = setting("registry_path")
    if not raw:
        candidate = data_dir() / "infra-registry"
        legacy = Path(os.path.expanduser(LEGACY_REGISTRY))
        raw = str(legacy if legacy.exists() else candidate)
    path = Path(os.path.expandvars(os.path.expanduser(str(raw))))
    return path


def state_path(default_name: str) -> Path:
    """A plugin-owned file under the active profile's data dir."""
    return data_dir() / default_name


def secret(name: str) -> Optional[str]:
    """Read a declared secret through Hermes' secret scope (never ``.env`` directly)."""
    try:
        from agent.secret_scope import get_secret

        value = get_secret(name)
    except Exception as exc:  # pragma: no cover - no secret scope in this process
        logger.debug("infra-atlas: secret scope unavailable for %s: %s", name, exc)
        return None
    return value or None


def guardrail_mode() -> str:
    mode = str(setting("guardrail_mode") or "block").strip().lower()
    return mode if mode in {"block", "warn", "off"} else "block"


def registry_write_gate() -> str:
    """How raw writes to registry-owned files are treated.

    ``block`` (default) vetoes them and names ``infra_upsert``; ``warn`` records
    only; ``off`` disables the gate. This is separate from ``guardrail_mode``
    because the two answer different questions: the read-before-touch gate
    protects *hosts*, this one protects the *knowledge base's* single writer.
    """
    mode = str(setting("registry_write_gate") or "block").strip().lower()
    return mode if mode in {"block", "warn", "off"} else "block"


def auto_heal_mode() -> str:
    mode = str(setting("auto_heal_mode") or "notify_only").strip().lower()
    return mode if mode in {"auto", "playbook_only", "notify_only", "off"} else "notify_only"
