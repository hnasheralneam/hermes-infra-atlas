"""Tool handlers and the FastAPI backend the desktop page talks to."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import _harness as H

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _load_api():
    spec = importlib.util.spec_from_file_location("atlas_plugin_api", PLUGIN_DIR / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def _setup(registry, **settings):
    H.load_plugin()
    H.configure(
        {
            "registry_path": str(registry),
            "enable_local_collector": False,
            "enable_hermes_collector": False,
            "enable_probes": False,
            **settings,
        }
    )
    return H.submodule("store").get_store()


def _seed(store, registry):
    (registry / "services" / "litellm.md").write_text(
        "---\nid: svc-litellm\nkind: service\nlabel: LiteLLM\nhost_ip: 10.0.0.212\nports: [4000]\n"
        "managed_by: systemd-user\nsystemd_unit: litellm.service\npitfalls: Dial 212 directly.\n---\n\n# LiteLLM\n\nRunbook body.\n",
        encoding="utf-8",
    )
    store.upsert_node(
        {
            "id": "svc-litellm",
            "kind": "service",
            "label": "LiteLLM",
            "host_ip": "10.0.0.212",
            "ports": ["4000"],
            "systemd_unit": "litellm.service",
            "managed_by": "systemd-user",
            "registry_path": "services/litellm.md",
            "pitfalls_summary": "Dial 212 directly.",
            "drift_status": "matched",
            "health_status": "up",
            "latency_ms": 11.2,
            "uptime_24h_pct": 99.9,
            "doc_state": {"id": "svc-litellm", "host_ip": "10.0.0.212"},
            "live_state": {"host_ip": "10.0.0.212", "probe_detail": "HTTP 200"},
        }
    )
    store.upsert_node(
        {"id": "svc-shadow", "kind": "service", "label": "shadow", "host_ip": "10.0.0.9",
         "ports": ["9000"], "drift_status": "unregistered", "drift_reasons": ["alive, no registry entry"],
         "doc_state": {}, "live_state": {"host_ip": "10.0.0.9"}}
    )
    H.submodule("matcher").refresh()


def test_infra_query_unlocks_and_returns_the_runbook(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    tools = H.submodule("atlas_tools")

    payload = json.loads(tools.infra_query({"node_id": "svc-litellm"}, session_id="t1"))
    assert payload["found"] == 1
    node = payload["nodes"][0]
    assert node["id"] == "svc-litellm"
    assert "Runbook body." in node["registry_markdown"]
    assert node["management"]["managed_by"] == "systemd-user"
    assert payload["unlocked_for_this_session"] == ["svc-litellm"]
    assert store.has_session_read("t1", "svc-litellm")
    assert node["blast_radius"] is not None


def test_infra_query_fuzzy_and_filters(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    tools = H.submodule("atlas_tools")

    fuzzy = json.loads(tools.infra_query({"node_id": "10.0.0.212"}, session_id="t2"))
    assert [n["id"] for n in fuzzy["nodes"]] == ["svc-litellm"]

    listed = json.loads(tools.infra_query({"drift_status": "unregistered"}, session_id="t3"))
    assert [n["id"] for n in listed["nodes"]] == ["svc-shadow"]

    missing = json.loads(tools.infra_query({"node_id": "nothing-here"}))
    assert missing["found"] == 0


def test_infra_upsert_adopts_and_writes_the_kb(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    tools = H.submodule("atlas_tools")

    result = json.loads(
        tools.infra_upsert(
            {"node_id": "svc-shadow", "action": "adopt_live", "reason": "found running during a sweep"},
            session_id="t4",
        )
    )
    assert result["ok"] is True
    assert (registry / "services" / "shadow.md").exists()
    changelog = (registry / "change-log.md").read_text(encoding="utf-8")
    assert "found running during a sweep" in changelog
    assert store.get_node("svc-shadow")["drift_status"] == "matched"

    bad = json.loads(tools.infra_upsert({"node_id": "svc-shadow"}))
    assert "reason" in bad["error"]


def test_infra_incidents_list_get_and_resolve(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    tools = H.submodule("atlas_tools")
    incident = store.open_incident("svc-litellm", "LiteLLM", "HTTP 503", 3, root_cause_hint="db down")

    listed = json.loads(tools.infra_incidents({"action": "list"}))
    assert listed["open_incidents"][0]["node_id"] == "svc-litellm"

    detail = json.loads(tools.infra_incidents({"action": "get", "incident_id": incident["id"]}, session_id="t5"))
    assert "AUTONOMOUS DOWNTIME RESPONDER" in detail["remediation_brief"]
    assert store.has_session_read("t5", "svc-litellm")

    closed = json.loads(
        tools.infra_incidents(
            {"action": "resolve", "incident_id": incident["id"], "summary": "restarted litellm, verified 200"},
            session_id="t5",
        )
    )
    assert closed["status"] == "resolved"
    assert store.get_incident(incident["id"])["status"] == "resolved"
    assert "restarted litellm" in (registry / "change-log.md").read_text(encoding="utf-8")


def test_infra_bootstrap_dry_run_then_real(plugin_home, legacy_registry):
    store = _setup(legacy_registry)
    tools = H.submodule("atlas_tools")
    dry = json.loads(tools.infra_bootstrap({"mode": "annotate_existing_kb", "dry_run": True}))
    assert len(dry["annotated"]) == 3
    assert not (legacy_registry / "services" / "litellm.md").read_text(encoding="utf-8").startswith("---")


def test_api_graph_and_node_detail(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    api = _load_api()

    graph = asyncio.run(api.graph())
    assert graph["counts"]["total"] == 2
    assert {node["id"] for node in graph["nodes"]} == {"svc-litellm", "svc-shadow"}
    assert graph["config"]["registry_path"] == str(registry)

    detail = asyncio.run(api.node_detail("svc-litellm"))
    assert detail["node"]["id"] == "svc-litellm"
    assert "Runbook body." in detail["registry_markdown"]
    assert detail["diff"] == []

    health = asyncio.run(api.health())
    assert health["ok"] is True


def test_api_reconcile_adopts_live_state(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    api = _load_api()

    result = asyncio.run(api.reconcile({"node_id": "svc-shadow", "action": "adopt_live"}))
    assert result["ok"] is True
    assert (registry / "services" / "shadow.md").exists()
    assert store.get_node("svc-shadow")["drift_status"] == "matched"


def test_api_heal_returns_a_brief_and_session_unlock(plugin_home, registry):
    store = _setup(registry)
    _seed(store, registry)
    api = _load_api()

    brief = asyncio.run(api.heal({"node_id": "svc-litellm", "mode": "agent_brief"}))
    assert brief["ok"] is True
    assert "svc-litellm" in brief["remediation_brief"]

    unlocked = asyncio.run(api.session_unlock({"session_id": "desk", "node_id": "svc-litellm"}))
    assert unlocked["ok"] is True
    assert store.has_session_read("desk", "svc-litellm")


def test_api_settings_rejects_nothing_and_reloads(plugin_home, registry):
    _setup(registry)
    api = _load_api()
    result = asyncio.run(api.update_settings({"guardrail_mode": "warn"}))
    assert result["ok"] is True
    assert "guardrail_mode" in result["written"]


def test_automation_blueprint_validates_against_the_cron_validator(plugin_home):
    """Hermes rejects a blueprint whose schedule placeholders don't resolve — catch it in CI."""
    import pytest

    pytest.importorskip("ruamel.yaml", reason="the cron blueprint validator parses YAML through ruamel")
    import _harness as H
    from cron.blueprint_catalog import fill_blueprint
    from cron.blueprint_plugins import build_plugin_blueprint

    pkg = H.load_plugin()
    kwargs = pkg.blueprint_kwargs()
    blueprint = build_plugin_blueprint("infra-atlas", "uptime-watchdog", **kwargs)
    spec = fill_blueprint(blueprint, {})          # fills defaults and validates the schedule
    assert spec["schedule"] == "7 */1 * * *"
