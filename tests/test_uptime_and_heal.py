"""Incident lifecycle and the two-stage downtime response."""

from __future__ import annotations

import _harness as H


def _node(**kw):
    base = {
        "id": "svc-test",
        "kind": "service",
        "label": "test service",
        "health_status": "down",
        "stratum": 3,
        "ports": [],
        "live_state": {"incident_eligible": True, "probe_detail": "connection refused"},
        "recovery_cmd": None,
        "auto_heal_policy": "inherit",
        # documented nodes are the ones allowed to page (see incident_eligible)
        "registry_path": "services/test-service.md",
    }
    base.update(kw)
    return base


def _prepare(mode="notify_only", threshold=2):
    H.load_plugin()
    H.configure(
        {
            "auto_heal_mode": mode,
            "failure_threshold": threshold,
            "heal_cooldown_sec": 300,
            "guardrail_mode": "warn",
        }
    )
    store = H.submodule("store").get_store()
    uptime = H.submodule("uptime")
    return store, uptime


def test_incident_opens_only_after_the_threshold(plugin_home):
    store, uptime = _prepare(threshold=2)
    node = _node()
    store.upsert_node({**node, "health_status": "down"})

    first = uptime.evaluate(store, [node], sweep_id=1, trigger_auto_heal=False)
    assert first["opened"] == []
    assert store.get_node("svc-test")["failure_streak"] == 1

    second = uptime.evaluate(store, [node], sweep_id=2, trigger_auto_heal=False)
    assert len(second["opened"]) == 1
    incident = store.active_incident_for("svc-test")
    assert incident and incident["status"] == "open"
    assert "connection refused" in incident["trigger_error"]


def test_not_eligible_nodes_never_open_an_incident(plugin_home):
    store, uptime = _prepare(threshold=1)
    node = _node(live_state={"incident_eligible": False})
    store.upsert_node({**node, "health_status": "down"})
    summary = uptime.evaluate(store, [node], sweep_id=1, trigger_auto_heal=False)
    assert summary["opened"] == []
    assert store.active_incident_for("svc-test") is None


def test_down_parent_is_named_and_blocks_child_healing(plugin_home):
    store, uptime = _prepare(mode="auto", threshold=1)
    store.upsert_node(
        {
            "id": "lxc-1",
            "kind": "lxc",
            "label": "parent",
            "health_status": "down",
            "ports": [],
            "registry_path": "servers/lxc-1.md",
        }
    )
    child = _node(id="svc-child", parent_id="lxc-1", recovery_cmd="systemctl --user restart child.service")
    store.upsert_node({**child, "health_status": "down"})

    summary = uptime.evaluate(store, [child], sweep_id=1, trigger_auto_heal=True)
    assert len(summary["opened"]) == 1
    incident = store.active_incident_for("svc-child")
    assert "parent" in (incident["root_cause_hint"] or "")
    # the playbook did not run: restarting a child inside a stopped guest is noise
    assert incident["heal_attempts"] == 0


def test_recovery_resolves_the_incident(plugin_home):
    store, uptime = _prepare(threshold=1)
    down = _node()
    store.upsert_node({**down, "health_status": "down"})
    uptime.evaluate(store, [down], sweep_id=1, trigger_auto_heal=False)
    assert store.active_incident_for("svc-test")["status"] == "open"

    up = _node(health_status="up")
    summary = uptime.evaluate(store, [up], sweep_id=2, trigger_auto_heal=False)
    assert summary["healed"]
    assert store.active_incident_for("svc-test") is None
    assert store.get_node("svc-test")["failure_streak"] == 0


def test_playbook_refuses_unsafe_or_remote_commands(plugin_home):
    store, uptime = _prepare(mode="auto", threshold=1)
    unsafe = _node(id="svc-unsafe", recovery_cmd="rm -rf /")
    store.upsert_node({**unsafe, "health_status": "down"})
    outcome = uptime.playbook_heal(store, store.get_node("svc-unsafe"))
    assert outcome["ok"] is False
    assert "allowlisted" in outcome["reason"]

    remote = _node(id="svc-remote", host_ip="10.99.99.99", recovery_cmd="systemctl restart x.service")
    store.upsert_node({**remote, "health_status": "down"})
    outcome = uptime.playbook_heal(store, store.get_node("svc-remote"))
    assert outcome["ok"] is False
    assert "needs the agent" in outcome["reason"]


def test_playbook_runs_and_records_the_attempt(plugin_home):
    store, uptime = _prepare(mode="auto", threshold=1)
    node = _node(id="svc-playbook", recovery_cmd="systemctl --user restart atlas-does-not-exist.service")
    store.upsert_node({**node, "health_status": "down"})
    incident = store.open_incident("svc-playbook", "playbook", "connection refused", 2)

    outcome = uptime.playbook_heal(store, store.get_node("svc-playbook"), incident)
    assert outcome["command"] == "systemctl --user restart atlas-does-not-exist.service"
    assert outcome["ok"] is False  # nothing to probe/verify, and the unit does not exist
    refreshed = store.get_incident(incident["id"])
    assert refreshed["heal_attempts"] == 1
    assert refreshed["status"] == "healing"


def test_remediation_brief_carries_the_runbook(plugin_home):
    store, uptime = _prepare(threshold=1)
    node = _node(
        id="svc-brief",
        registry_path="services/brief.md",
        managed_by="systemd-user",
        systemd_unit="brief.service",
        recovery_cmd="systemctl --user restart brief.service",
        pitfalls_summary="Never start it directly.",
        parent_id="srv-parent",
    )
    store.upsert_node({**node, "health_status": "down"})
    store.upsert_node({"id": "srv-parent", "kind": "server", "label": "parent-host", "health_status": "up", "ports": []})
    incident = store.open_incident("svc-brief", "brief", "connection refused", 3)

    brief = uptime.remediation_brief(store, store.get_node("svc-brief"), incident)
    assert "AUTONOMOUS DOWNTIME RESPONDER" in brief
    assert "services/brief.md" in brief
    assert "systemctl --user restart brief.service" in brief
    assert "Never start it directly." in brief
    assert "parent-host is up" in brief
    assert 'infra_query(node_id="svc-brief")' in brief
    assert "infra_incidents(action=\"resolve\"" in brief


def test_an_undocumented_unit_never_pages(plugin_home):
    """A discovered system unit with no entry has no runbook: drift, not an outage."""
    store, uptime = _prepare(mode="auto", threshold=1)
    discovered = _node(id="svc-fwupd-refresh", label="fwupd-refresh", registry_path=None)
    store.upsert_node({**discovered, "health_status": "down"})

    summary = uptime.evaluate(store, [discovered], sweep_id=1, trigger_auto_heal=True)
    assert summary["opened"] == []
    assert store.active_incident_for("svc-fwupd-refresh") is None


def test_an_incident_closes_when_its_node_disappears(plugin_home):
    store, uptime = _prepare(mode="notify_only", threshold=1)
    node = _node(id="svc-vanish")
    store.upsert_node({**node, "health_status": "down"})
    uptime.evaluate(store, [node], sweep_id=1, trigger_auto_heal=False)
    incident = store.active_incident_for("svc-vanish")
    assert incident is not None

    store._run("DELETE FROM nodes WHERE id = ?", ("svc-vanish",))
    closed = store.close_incidents_for_missing_nodes()

    assert closed == [incident["id"]]
    assert store.get_incident(incident["id"])["status"] == "resolved"
