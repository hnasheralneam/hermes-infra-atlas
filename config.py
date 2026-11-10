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

DEFAULTS: dict[str, Any] = {
    "registry_path": "~/.hermes/infra-registry",
    "credentials_path": "~/.hermes/plugin-data/infra-atlas/credentials.json",
    "credentials_key_path": "~/.hermes/plugin-data/infra-atlas/credentials.key",
    "guardrail_mode": "block",
    "auto_heal_mode": "auto",
    "failure_threshold": 2,
    "heal_cooldown_sec": 300,
    "enable_local_collector": True,
    "enable_hermes_collector": True,
    "enable_probes": True,
    "probe_timeout_sec": 1.5,
    "proxmox_url": "",
    "proxmox_token_id": "",
    "proxmox_verify_tls": False,
    "headscale_url": "",
}

_getter: Optional[Callable[[str, Any], Any]] = None


def configure(getter: Optional[Callable[[str, Any], Any]]) -> None:
    """Install the host-provided settings getter (``ctx.get_config``)."""
    global _getter
    _getter = getter


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
    """Absolute path of the Markdown knowledge base."""
    raw = str(setting("registry_path") or DEFAULTS["registry_path"])
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    return path


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


def auto_heal_mode() -> str:
    mode = str(setting("auto_heal_mode") or "auto").strip().lower()
    return mode if mode in {"auto", "playbook_only", "notify_only", "off"} else "auto"
