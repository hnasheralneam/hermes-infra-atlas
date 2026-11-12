"""The remaining tool handlers and backend routes: sweep, diff, activity, incidents, watchdog."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import _harness as H

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _api():
    import importlib.util

    spec = importlib.util.spec_from_file_location("atlas_plugin_api_extra", PLUGIN_DIR / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def _setup(registry, **settings):
    H.load_plugin()
    H.configure({"registry_path": str(registry), **settings})
    return H.submodule("store").get_store()


def _entry(registry, name="svc-sample", body="# Sample\n\nRunbook.\n", **fields):
    fields.setdefault("id", name)
    fields.setdefault("kind", "service")
    front = "---\n" + "".join(f"{key}: {value}\n" for key, value in fields.items()) + "---\n"
    path = registry / "services" / f"{name}.md"
    path.write_text(front + body, encoding="utf-8")
    return path


# ── tools ──────────────────────────────────────────────────────────────────
def test_infra_sweep_tool_returns_a_serialisable_summary(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    _entry(registry)
    tools = H.submodule("atlas_tools")

    payload = json.loads(tools.infra_sweep({"sources": ["kb"]}))
    assert payload["sweep_id"] >= 1
    assert payload["counts"]["total"] >= 1
    assert isinstance(payload["duration_ms"], int)


def test_infra_diff_reports_transitions_incidents_and_activity(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    _entry(registry)
    tools = H.submodule("atlas_tools")
    store = H.submodule("store").get_store()

    tools.infra_sweep({"sources": ["kb"]})
    store.log_activity("s1", "infra_query", "svc-sample", "read_doc", summary="read")

    payload = json.loads(tools.infra_diff({"since": "1h"}))
    assert set(payload) == {"since", "latest_sweep", "counts", "drift_transitions", "incidents", "activity"}
    assert payload["latest_sweep"] is not None
    assert payload["since"].endswith("+00:00")
    assert any(entry["node_id"] == "svc-sample" for entry in payload["activity"])

    narrowed = json.loads(tools.infra_diff({"since": "1h", "node_id": "svc-sample"}))
    assert narrowed["counts"]["total"] >= 1


def test_infra_diff_rejects_a_bad_since(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")
    payload = json.loads(tools.infra_diff({"since": "not-a-duration"}))
    # falls back to the 24h default rather than raising
    assert payload["since"]


# ── backend routes ─────────────────────────────────────────────────────────
def test_api_sweep_route_sweeps_and_reports(plugin_home, registry):
    _setup(registry)
    _entry(registry)
    api = _api()

    result = asyncio.run(api.sweep({"sources": ["kb"]}))
    assert result["sweep_id"] >= 1
    assert result["counts"]["total"] >= 1


def test_api_activity_route_shape(plugin_home, registry):
    store = _setup(registry)
    api = _api()
    store.log_activity("s1", "infra_query", "svc-x", "read_doc", summary="read")

    payload = asyncio.run(api.activity(limit=5))
    assert set(payload) == {"activity", "incidents", "counts"}
    assert payload["activity"] and payload["activity"][0]["node_id"] == "svc-x"


def test_api_watchdog_writes_an_executable_script_outside_the_plugin(plugin_home):
    H.load_plugin()
    api = _api()
    result = asyncio.run(api.watchdog({}))

    script = Path(result["script"])
    assert result["ok"] is True
    assert script.exists()
    assert os.access(script, os.X_OK)
    text = script.read_text(encoding="utf-8")
    assert str(PLUGIN_DIR) in text
    # never inside the plugin tree: installs can be read-only and a stray script
    # there would land in the user's repository
    assert PLUGIN_DIR not in script.parents


def test_api_resolve_incident_writes_the_change_log(plugin_home, registry):
    store = _setup(registry)
    _entry(registry)
    api = _api()
    store.upsert_node({"id": "svc-sample", "kind": "service", "label": "Sample", "registry_path": "services/svc-sample.md"})
    incident_id = store.open_incident("svc-sample", "Sample", "probe failed", failure_count=2)["id"]
    assert incident_id

    result = asyncio.run(api.resolve_incident(incident_id, {"summary": "restarted by hand"}))
    assert result["ok"] is True and result["status"] == "resolved"
    incident = store.get_incident(incident_id)
    assert incident["status"] == "resolved"
    assert incident["resolved_at"]
    log = (registry / "change-log.md").read_text(encoding="utf-8")
    assert "restarted by hand" in log

    assert asyncio.run(api.resolve_incident(9999, {}))["ok"] is False


def test_api_resolve_incident_can_escalate(plugin_home, registry):
    store = _setup(registry)
    _entry(registry)
    api = _api()
    store.upsert_node({"id": "svc-sample", "kind": "service", "label": "Sample", "registry_path": "services/svc-sample.md"})
    incident_id = store.open_incident("svc-sample", "Sample", "probe failed", failure_count=2)["id"]

    result = asyncio.run(api.resolve_incident(incident_id, {"escalate": True}))
    assert result["status"] == "escalated"
    incident = store.get_incident(incident_id)
    assert incident["status"] == "escalated"
    assert incident["resolved_at"] is None


def test_api_settings_ignores_unknown_keys(plugin_home, registry):
    _setup(registry, guardrail_mode="block")
    api = _api()
    result = asyncio.run(api.update_settings({"guardrail_mode": "warn", "not_a_setting": 1}))
    assert result["written"] == ["guardrail_mode"]
    assert set(result["config"]) == {"guardrail_mode", "auto_heal_mode"}


def test_api_node_detail_unknown_node_is_an_error_payload(plugin_home, registry):
    _setup(registry)
    api = _api()
    payload = asyncio.run(api.node_detail("nope-not-here"))
    assert payload.get("ok") is False or payload.get("error")


def test_infra_bootstrap_scaffold_writes_entries_for_unregistered_nodes(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")
    store = H.submodule("store").get_store()
    # The handler sweeps first; stub the sweep so the seeded node stays unregistered.
    monkeypatch.setattr(tools.fusion, "run_sweep", lambda **kwargs: {"counts": {"unregistered": 1}})
    store.upsert_node(
        {"id": "svc-found", "kind": "service", "label": "found service", "host_ip": "10.9.9.9",
         "drift_status": "unregistered"}
    )

    preview = json.loads(tools.infra_bootstrap({"mode": "scaffold_from_live", "dry_run": True}))
    assert "svc-found" in preview["created"]
    assert not (registry / "services" / "svc-found.md").exists()

    real = json.loads(tools.infra_bootstrap({"mode": "scaffold_from_live"}))
    assert "svc-found" in real["created"]
    node = store.get_node("svc-found")
    assert node["registry_path"], "scaffolding must record where it wrote the entry"
    entry = registry / node["registry_path"]
    assert entry.exists()
    text = entry.read_text(encoding="utf-8")
    assert "kind: service" in text and "id: svc-found" in text
    assert node["drift_status"] == "matched"


def test_infra_incidents_list_and_unknown_action(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")

    listing = json.loads(tools.infra_incidents({"action": "list"}))
    assert set(listing) >= {"fleet", "open_incidents"}
    assert isinstance(listing["open_incidents"], list)

    unknown = json.loads(tools.infra_incidents({"action": "wat"}))
    assert "error" in unknown or unknown.get("ok") is False


def test_infra_incidents_setup_watchdog_reports_a_path(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")
    payload = json.loads(tools.infra_incidents({"action": "setup_watchdog"}))
    assert Path(payload["script"]).exists()
    assert payload["interval_min"] >= 1
    # outside an agent session there is no plugin context to register the cron job
    assert payload["cron"]["ok"] is False


def test_setup_watchdog_refuses_inside_a_cron_run(plugin_home, registry, monkeypatch):
    """A cron run may not schedule cron jobs unless cron.allow_agent_scheduling is on."""
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")
    ctx = H.FakeCtx()
    tools.bind_context(ctx)

    monkeypatch.setenv("HERMES_CRON_SESSION", "job-42")
    monkeypatch.setattr(tools, "_agent_scheduling_allowed", lambda: False)
    payload = json.loads(tools.infra_incidents({"action": "setup_watchdog"}))
    assert payload["cron"]["ok"] is False
    assert "allow_agent_scheduling" in payload["cron"]["reason"]
    assert ctx.dispatched == []

    monkeypatch.setattr(tools, "_agent_scheduling_allowed", lambda: True)
    payload = json.loads(tools.infra_incidents({"action": "setup_watchdog"}))
    assert payload["cron"]["ok"] is True
    assert ctx.dispatched and ctx.dispatched[0][0] == "cronjob_manage"


def test_setup_watchdog_still_works_in_an_interactive_session(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    tools = H.submodule("atlas_tools")
    ctx = H.FakeCtx()
    tools.bind_context(ctx)
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.setattr(tools, "_agent_scheduling_allowed", lambda: False)
    payload = json.loads(tools.infra_incidents({"action": "setup_watchdog"}))
    assert payload["cron"]["ok"] is True


def test_paths_default_under_the_profile_data_dir(plugin_home, monkeypatch):
    """No hardcoded ~/.hermes: the vault and registry follow the active profile."""
    H.load_plugin()
    config = H.submodule("config")
    credentials = H.submodule("credentials")
    # No legacy tree on this machine, so the profile default is what applies.
    monkeypatch.setattr(config, "LEGACY_REGISTRY", str(plugin_home / "no-legacy-here"))
    H.configure({"registry_path": None})
    config.configure_data_dir(plugin_home / "plugin-data" / "infra-atlas")

    assert credentials.vault_path() == plugin_home / "plugin-data" / "infra-atlas" / "credentials.json"
    assert credentials.key_path() == plugin_home / "plugin-data" / "infra-atlas" / "credentials.key"
    assert config.registry_root() == plugin_home / "plugin-data" / "infra-atlas" / "infra-registry"


def test_the_legacy_registry_path_still_resolves(plugin_home, monkeypatch):
    """An existing ~/.hermes/infra-registry keeps being used when it is there."""
    H.load_plugin()
    config = H.submodule("config")
    legacy = plugin_home / "infra-registry"
    (legacy / "services").mkdir(parents=True)
    monkeypatch.setattr(config, "LEGACY_REGISTRY", str(legacy))
    H.configure({"registry_path": None})
    config.configure_data_dir(plugin_home / "plugin-data" / "infra-atlas")
    assert config.registry_root() == legacy
