"""Shared fixtures: an isolated HERMES_HOME and a fresh plugin store per test."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


def _ensure_fastapi() -> None:
    """Run the backend tests on interpreters without FastAPI installed.

    Hermes always ships FastAPI for the dashboard mount; the tests only need the
    router decorators to record the handlers so they can be awaited directly.
    """
    try:
        import fastapi  # noqa: F401

        return
    except ImportError:
        pass

    module = types.ModuleType("fastapi")

    class APIRouter:  # noqa: D401 - minimal stand-in
        def __init__(self) -> None:
            self.routes = []

        def _register(self, path, **kwargs):
            def decorator(func):
                self.routes.append(types.SimpleNamespace(path=path, endpoint=func))
                return func

            return decorator

        def get(self, path, **kwargs):
            return self._register(path)

        def post(self, path, **kwargs):
            return self._register(path)

    module.APIRouter = APIRouter
    sys.modules["fastapi"] = module


_ensure_fastapi()

import _harness as H  # noqa: E402


def _reset_hermes_home_cache() -> None:
    """Drop any cached profile home so HERMES_HOME is honoured per test."""
    try:
        import hermes_constants

        for name in ("_PROCESS_HERMES_HOME", "_hermes_home"):
            if hasattr(hermes_constants, name):
                setattr(hermes_constants, name, None)
    except Exception:  # pragma: no cover
        pass


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path):
    """No test may write into the operator's real registry.

    Incident resolve/escalate and ``infra_upsert`` write to
    ``config.registry_root()``; without this baseline a test that never calls
    ``H.configure`` inherits the live KB and pollutes its change-log.
    """
    root = tmp_path / "autoreg"
    for folder in ("servers", "services", "projects"):
        (root / folder).mkdir(parents=True, exist_ok=True)
    (root / "INDEX.md").write_text("# Infrastructure index\n", encoding="utf-8")
    (root / "change-log.md").write_text("# Infrastructure change log\n", encoding="utf-8")
    H.configure({"registry_path": str(root)})
    yield root


@pytest.fixture()
def plugin_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    (home / "scripts").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    _reset_hermes_home_cache()
    yield home
    store_module = H.submodule("store")
    store_module.reset_store()


@pytest.fixture()
def registry(tmp_path):
    root = tmp_path / "registry"
    for folder in ("servers", "services", "projects"):
        (root / folder).mkdir(parents=True, exist_ok=True)
    (root / "INDEX.md").write_text(
        "# Infrastructure index\n\n## Servers\n\n| Entry | Address | Managed by |\n|---|---|---|\n\n"
        "## Services\n\n| Entry | Address | Managed by |\n|---|---|---|\n\n## Projects\n",
        encoding="utf-8",
    )
    (root / "change-log.md").write_text("# Infrastructure change log\n", encoding="utf-8")
    return root


@pytest.fixture()
def legacy_registry(registry):
    """A registry in the club's current style: prose only, no frontmatter."""
    (registry / "services" / "litellm.md").write_text(
        """# LiteLLM Gateway

Runs on `10.0.0.212` and listens on 4000.

## Management

Managed via `systemctl --user restart litellm.service` on the host.

**Do NOT** point clients at the old 10.0.0.143 address.
""",
        encoding="utf-8",
    )
    (registry / "servers" / "athena.md").write_text(
        """# athena-ai

Primary inference host at 10.0.0.50 with `100.64.0.50` on the tailnet.

Ports: 8080
""",
        encoding="utf-8",
    )
    (registry / "services" / "gone.md").write_text(
        "# Gone Service — REMOVED 2026-10-01\n\nDecommissioned.\n", encoding="utf-8"
    )
    return registry
