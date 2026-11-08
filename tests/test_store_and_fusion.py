"""Correlation and drift classification: the core of the plugin."""

from __future__ import annotations

import _harness as H


def _seed_registry(registry):
    (registry / "services" / "alpha.md").write_text(
        "---\nid: svc-alpha\nkind: service\nlabel: Alpha\nhost_ip: 10.0.0.5\nports: [4000]\n"
        "managed_by: systemd-user\nsystemd_unit: alpha.service\nstatus: active\n---\n\n# Alpha\n\nRunbook.\n",
        encoding="utf-8",
    )
    (registry / "servers" / "host1.md").write_text(
        "---\nid: srv-host1\nkind: server\nlabel: host1\nhost_ip: 10.0.0.5\nstatus: active\n---\n\n# host1\n",
        encoding="utf-8",
    )
    (registry / "projects" / "notes.md").write_text(
        "---\nid: proj-notes\nkind: project\nlabel: notes\nstatus: active\n---\n\n# notes\n",
        encoding="utf-8",
    )


def test_drift_states(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure(
        {
            "registry_path": str(registry),
            "enable_local_collector": False,
            "enable_hermes_collector": False,
            "enable_probes": False,
            "demo_mode": False,
        }
    )
    _seed_registry(registry)
    fusion = H.submodule("fusion")
    collectors = H.submodule("collectors")

    live = collectors.CollectorResult(
        source="fake",
        nodes=[
            # alpha: same id, but the port moved and the unit is failing
            {"id": "svc-alpha", "kind": "service", "ports": ["4001"], "health_status": "down",
             "live_state": {"probe_detail": "connection refused"}},
            # host1 answers
            {"id": "srv-host1", "kind": "server", "host_ip": "10.0.0.5", "health_status": "up"},
            # discovered, undocumented
            {"id": "svc-shadow", "kind": "service", "host_ip": "10.0.0.9", "ports": ["9000"],
             "health_status": "up"},
        ],
    )
    monkeypatch.setattr(fusion, "run_sources", lambda *a, **kw: [live])

    summary = fusion.run_sweep(sources=["kb"], trigger_auto_heal=False)
    store = H.submodule("store").get_store()
    statuses = {node["id"]: node["drift_status"] for node in store.list_nodes()}

    assert statuses["svc-alpha"] == "changed"
    assert statuses["srv-host1"] == "matched"
    assert statuses["svc-shadow"] == "unregistered"
    assert statuses["proj-notes"] == "doc_only"
    assert summary["counts"]["changed"] >= 1

    alpha = store.get_node("svc-alpha")
    assert any("ports" in reason for reason in alpha["drift_reasons"])


def test_stale_requires_probe_evidence(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure(
        {
            "registry_path": str(registry),
            "enable_local_collector": False,
            "enable_hermes_collector": False,
            "enable_probes": False,
        }
    )
    _seed_registry(registry)
    fusion = H.submodule("fusion")
    collectors = H.submodule("collectors")
    monkeypatch.setattr(fusion, "run_sources", lambda *a, **kw: [])

    fusion.run_sweep(sources=["kb"], trigger_auto_heal=False)
    store = H.submodule("store").get_store()
    # Nothing was probed, so "nothing answered" must not be invented.
    assert store.get_node("svc-alpha")["drift_status"] == "doc_only"


def test_probe_failure_marks_stale(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure(
        {
            "registry_path": str(registry),
            "enable_local_collector": False,
            "enable_hermes_collector": False,
            "enable_probes": True,
            "probe_timeout_sec": 0.2,
            "failure_threshold": 2,
        }
    )
    _seed_registry(registry)
    fusion = H.submodule("fusion")
    collectors = H.submodule("collectors")

    monkeypatch.setattr(fusion, "run_sources", lambda *a, **kw: [])
    monkeypatch.setattr(
        fusion,
        "run_source",
        lambda source, **kw: collectors.CollectorResult(
            source="probes",
            nodes=[
                {
                    "id": "svc-alpha",
                    "health_status": "down",
                    "latency_ms": None,
                    "live_state": {"probe_detail": "connection refused", "incident_eligible": True},
                }
            ],
        ),
    )

    fusion.run_sweep(sources=["kb", "probes"], trigger_auto_heal=False)
    store = H.submodule("store").get_store()
    node = store.get_node("svc-alpha")
    assert node["drift_status"] == "stale"
    assert node["health_status"] == "down"


def test_blast_radius_follows_host_edges(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure({"registry_path": str(registry), "enable_probes": False})
    _seed_registry(registry)
    fusion = H.submodule("fusion")
    monkeypatch.setattr(fusion, "run_sources", lambda *a, **kw: [])
    fusion.run_sweep(sources=["kb"], trigger_auto_heal=False)

    store = H.submodule("store").get_store()
    radius = fusion.blast_radius(store, "svc-alpha")
    assert [item["id"] for item in radius["upstream"]] == ["srv-host1"]
