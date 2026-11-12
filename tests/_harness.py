"""Test harness: import the plugin exactly the way Hermes' loader does.

The directory is ``infra-atlas`` (a hyphen, so not importable by name), and the
loader registers it as ``hermes_plugins.infra_atlas`` with relative imports
intact. Tests must use the same shape or they exercise a different import graph
than production.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import types
from pathlib import Path
from typing import Any, Optional

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PACKAGE = "hermes_plugins.infra_atlas"


def _ensure_namespace() -> None:
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace


def load_plugin() -> types.ModuleType:
    """Import (or return) the plugin package."""
    _ensure_namespace()
    if PACKAGE in sys.modules:
        return sys.modules[PACKAGE]
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


def submodule(name: str):
    load_plugin()
    return importlib.import_module(f"{PACKAGE}.{name}")


def configure(settings: Optional[dict[str, Any]] = None, registry: Optional[Path] = None) -> None:
    """Point the plugin at a temp registry and a fixed settings table."""
    settings = dict(settings or {})
    config = submodule("config")
    if registry is not None:
        settings.setdefault("registry_path", str(registry))
    else:
        # Preserve the registry this test suite is already pointed at (conftest's
        # autouse temp KB) — dropping the key would silently fall back to the
        # operator's live registry and let a test write into it.
        settings.setdefault("registry_path", str(config.registry_root()))
    settings.setdefault("enable_local_collector", False)
    settings.setdefault("enable_hermes_collector", False)
    settings.setdefault("enable_probes", False)
    config.configure(lambda key, default=None: settings.get(key, default))


class FakeCtx:
    """Minimal PluginContext stand-in for unit tests."""

    def __init__(self) -> None:
        self.tools: dict[str, Any] = {}
        self.hooks: dict[str, list] = {}
        self.skills: list[tuple] = []
        self.commands: dict[str, Any] = {}
        self.blueprints: list[tuple] = []
        self.settings: dict[str, Any] = {}
        self.dispatched: list[tuple[str, dict]] = []
        self.profile_name = "test"
        self.reply: str = '{"ok": true}'

    # -- registration ---------------------------------------------------
    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}
        return None

    def register_hook(self, event, callback, **kwargs):
        self.hooks.setdefault(event, []).append(callback)
        return None

    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills.append((name, path, description))
        return None

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler
        return None

    def register_automation_blueprint(self, key, **kwargs):
        self.blueprints.append((key, kwargs))
        return None

    # -- settings -------------------------------------------------------
    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def set_config(self, key, value):
        self.settings[key] = value

    def dispatch_tool(self, name, args, **kwargs):
        self.dispatched.append((name, args))
        return self.reply
