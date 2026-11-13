"""Text surfaces: the atlas subcommands, the node brief, and what kind a node is drawn as.

Three operator-facing defects are pinned here:

* ``/atlas`` was a status line with one magic word (``sweep``). It is now a
  command family shared with ``hermes atlas`` — including the two sources an
  operator actually compares: the graph the sweep fused and the registry on disk.
* "Ask Hermes" used to hand a *healthy* node an outage brief ("node is DOWN"),
  because the only brief that existed was the downtime one.
* An inference server whose label never says so ("flash-8 (Dipa's fedora box)")
  was drawn as a generic service; the probe tells you what it is.
"""

from __future__ import annotations

import argparse
import asyncio
import json

import _harness as H


def _seed(registry):
    """One registry with a matched service, a drifted LXC and an inference box."""
    (registry / "services" / "litellm.md").write_text(
        "---\n"
        "id: svc-litellm\n"
        "kind: service\n"
        "label: LiteLLM Gateway\n"
        "host_ip: 10.0.0.212\n"
        "ports: [4000]\n"
        "managed_by: docker\n"
        "probe: http://10.0.0.212:4000/health/liveliness\n"
        "---\n\n# LiteLLM Gateway\n\nRuns on `10.0.0.212:4000`.\n",
        encoding="utf-8",
    )
    (registry / "servers" / "cache-tank.md").write_text(
        "---\n"
        "id: lxc-202\n"
        "kind: lxc\n"
        "label: cache-tank\n"
        "host_ip: 10.0.0.22\n"
        "ports: [6379]\n"
        "managed_by: proxmox\n"
        "---\n\n# cache-tank\n\nRedis for the labs.\n",
        encoding="utf-8",
    )
    # The one that used to be drawn as a plain service: llama.cpp on Dipa's box,
    # labelled by owner instead of by function.
    (registry / "services" / "flash-8.md").write_text(
        "---\n"
        "id: svc-flash-8\n"
        "kind: service\n"
        "label: flash-8 (Dipa's fedora box)\n"
        "tailnet_ip: 100.64.0.8\n"
        "ports: [8080]\n"
        "managed_by: manual\n"
        "probe: http://10.0.0.75:18090/v1/models\n"
        "---\n\n# flash-8\n\nllama.cpp serving `qwen3.8-flash-next` on :8080.\n",
        encoding="utf-8",
    )
    # A control plane that *mentions* vLLM must not become one.
    (registry / "services" / "vllm-metrics-shim.md").write_text(
        "---\n"
        "id: svc-vllm-metrics-shim\n"
        "kind: service\n"
        "label: vLLM Metrics Shim\n"
        "host_ip: 10.0.0.143\n"
        "ports: [9100]\n"
        "managed_by: systemd-system\n"
        "---\n\n# vLLM Metrics Shim\n\nScrapes the vLLM container's /metrics.\n",
        encoding="utf-8",
    )
    fusion = H.submodule("fusion")
    fusion.run_sweep(sources=["kb"], trigger_auto_heal=False)
    return H.submodule("store").get_store()


def _store_with_drift(registry):
    store = _seed(registry)
    store.set_fields(
        "lxc-202",
        drift_status="changed",
        health_status="up",
        drift_reasons=["host_ip: registry says 10.0.0.30, live is 10.0.0.22"],
    )
    store.set_fields("svc-litellm", drift_status="matched", health_status="up", uptime_24h_pct=99.5)
    return store


# -- kind classification ----------------------------------------------------
def test_inference_servers_are_drawn_as_inference_not_service(plugin_home, registry):
    """A /v1 probe means the entry IS a model server, whatever its label says."""
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    store = _seed(registry)

    flash = store.get_node("svc-flash-8")
    assert flash is not None
    assert flash["kind"] == "inference", flash
    # ... and a control plane that merely mentions vLLM stays a service.
    assert store.get_node("svc-vllm-metrics-shim")["kind"] == "service"


def test_registry_kind_is_not_rewritten_by_the_classifier(plugin_home, registry):
    """The silhouette is inferred; the documented kind stays what the entry says."""
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    registry_kb = H.submodule("registry_kb")
    _seed(registry)
    entries, _edges = registry_kb.parse_registry(registry)
    by_id = {entry["id"]: entry for entry in entries}
    assert by_id["svc-flash-8"]["kind"] == "inference"
    text = (registry / "services" / "flash-8.md").read_text(encoding="utf-8")
    assert "kind: service" in text  # the file still documents a service entry


# -- the brief --------------------------------------------------------------
def test_healthy_node_brief_is_an_inspection_mission_not_an_outage(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    store = _store_with_drift(registry)
    uptime = H.submodule("uptime")

    brief = uptime.dispatch_brief(store, store.get_node("svc-litellm"), None)
    assert "NODE BRIEF" in brief
    assert "svc-litellm" in brief
    assert "is DOWN" not in brief
    assert "read-only inspection only" in brief
    assert "services/litellm.md" in brief


def test_drifted_node_brief_asks_for_reconciliation(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    store = _store_with_drift(registry)
    uptime = H.submodule("uptime")

    brief = uptime.dispatch_brief(store, store.get_node("lxc-202"), None)
    assert "drift" in brief.lower()
    assert "10.0.0.30" in brief  # the drift reason travels with the brief
    assert "adopt_live" in brief
    assert "is DOWN" not in brief


def test_down_node_brief_keeps_the_recovery_steps_without_a_fake_incident_id(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    store = _store_with_drift(registry)
    store.set_fields("svc-litellm", health_status="down")
    uptime = H.submodule("uptime")

    brief = uptime.dispatch_brief(store, store.get_node("svc-litellm"), None)
    assert "is DOWN" in brief
    assert "dispatched by hand" in brief
    assert "Incident #0" not in brief
    assert "infra_sweep" in brief  # verify step survives
    assert "no incident is open to resolve" in brief


def test_brief_endpoint_returns_text_and_marks_the_node_read(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    store = _store_with_drift(registry)
    api = H.load_dashboard_api()

    resp = asyncio.run(api.brief({"node_id": "svc-flash-8"}))
    body = json.loads(resp.body.decode("utf-8")) if hasattr(resp, "body") else resp
    assert body["ok"] is True
    assert body["node_id"] == "svc-flash-8"
    assert "svc-flash-8" in body["brief"]
    assert store.has_session_read("desktop", "svc-flash-8")

    unknown = asyncio.run(api.brief({"node_id": "nope"}))
    payload = json.loads(unknown.body.decode("utf-8")) if hasattr(unknown, "body") else unknown
    assert payload["ok"] is False


# -- the command family -----------------------------------------------------
def test_atlas_cli_subcommands_render_the_two_sources(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    _store_with_drift(registry)
    cli = H.submodule("atlas_cli")

    status = cli.run("status")
    assert "Infra Atlas" in status and "Registry:" in status

    nodes = cli.run("nodes")
    assert "svc-litellm" in nodes and "inference" in nodes

    drift = cli.run("drift")
    assert "lxc-202" in drift and "10.0.0.30" in drift

    show = cli.run("show svc-flash-8")
    assert "flash-8" in show and "inference" in show

    entries = cli.run("entries litellm")
    assert "services/litellm.md" in entries

    # A near-miss lists candidates instead of a dead end.
    ambiguous = cli.run("show flash")
    assert "svc-flash-8" in ambiguous


def test_atlas_cli_shows_no_values_from_the_vault(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    monkeypatch.setenv("HERMES_HOME", str(plugin_home))
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: plugin_home, raising=False)
    credentials = H.submodule("credentials")
    credentials.set_value("cache-ssh", "hunter2-never-print", node_id="lxc-202", kind="ssh-password")

    rendered = H.submodule("atlas_cli").run("creds")
    assert "cache-ssh" in rendered
    assert "hunter2-never-print" not in rendered


def test_atlas_cli_rejects_unknown_subcommands_with_usage(plugin_home, registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    rendered = H.submodule("atlas_cli").run("frobnicate")
    assert "usage: /atlas" in rendered


def test_hermes_atlas_cli_parses_the_same_subcommands(plugin_home, registry, capsys):
    """``hermes atlas nodes --kind inference`` must parse through the host parser."""
    module = H.load_plugin()
    H.configure({"registry_path": str(registry)})
    _store_with_drift(registry)
    ctx = H.FakeCtx()
    module.register(ctx)
    entry = ctx.cli_commands["atlas"]

    parser = argparse.ArgumentParser(prog="hermes atlas")
    entry["setup_fn"](parser)
    args = parser.parse_args(["nodes", "--kind", "inference"])
    code = entry["handler_fn"](args)
    assert code == 0
    out = capsys.readouterr().out
    assert "svc-flash-8" in out
