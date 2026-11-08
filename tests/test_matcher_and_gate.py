"""The read-before-you-touch gate: block, warn, and unlock."""

from __future__ import annotations

import _harness as H


def _seed(store):
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
            "pitfalls_summary": "Dial 10.0.0.212:4000 directly.",
            "doc_state": {"id": "svc-litellm"},
        }
    )
    store.upsert_node(
        {"id": "lxc-201", "kind": "lxc", "label": "litellm lxc", "host_ip": "10.0.0.212", "vmid": 201,
         "stratum": 2, "registry_path": "servers/lxc-201.md"}
    )
    H.submodule("matcher").refresh()


def test_blocks_blind_terminal_touch(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    verdict = hooks.on_pre_tool_call(
        tool_name="terminal",
        args={"command": "ssh root@10.0.0.212 'systemctl --user restart litellm.service'"},
        session_id="s1",
    )
    assert verdict and verdict["action"] == "block"
    assert "infra_query" in verdict["message"]
    assert "services/litellm.md" in verdict["message"]
    # the pitfall the operator documented is surfaced in the block message
    assert "Dial 10.0.0.212:4000" in verdict["message"]

    hooks.drain_activity()
    blocked = store.recent_activity(limit=5)
    assert any(entry["action_kind"] == "touch_blocked" and entry["blocked"] for entry in blocked)


def test_query_unlocks_and_the_same_command_passes(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    tools = H.submodule("atlas_tools")
    _seed(store)

    tools.infra_query({"node_id": "svc-litellm"}, session_id="s1")
    assert store.has_session_read("s1", "svc-litellm")

    verdict = hooks.on_pre_tool_call(
        tool_name="terminal",
        args={"command": "curl -sS http://10.0.0.212:4000/health/liveliness"},
        session_id="s1",
    )
    assert verdict is None


def test_reading_the_registry_file_unlocks(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    hooks.on_pre_tool_call(
        tool_name="read_file",
        args={"path": str(registry / "services" / "litellm.md")},
        session_id="s2",
    )
    assert store.has_session_read("s2", "svc-litellm")
    assert hooks.on_pre_tool_call(
        tool_name="terminal", args={"command": "systemctl --user status litellm.service"}, session_id="s2"
    ) is None


def test_index_read_does_not_unlock(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    hooks.on_pre_tool_call(tool_name="read_file", args={"path": str(registry / "INDEX.md")}, session_id="s3")
    # INDEX is not a node: nothing unlocked, and touching a node is still blocked
    assert not store.has_session_read("s3", "svc-litellm")
    assert hooks.on_pre_tool_call(
        tool_name="terminal", args={"command": "ssh root@10.0.0.212 uptime"}, session_id="s3"
    )["action"] == "block"


def test_warn_mode_allows_but_records(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "warn", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    assert hooks.on_pre_tool_call(tool_name="terminal", args={"command": "ssh root@10.0.0.212 uptime"}, session_id="s4") is None
    hooks.drain_activity()
    kinds = [entry["action_kind"] for entry in store.recent_activity(limit=5)]
    assert "touch_warned" in kinds


def test_proxmox_vmid_commands_match_the_guest(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    verdict = hooks.on_pre_tool_call(
        tool_name="terminal", args={"command": "qm stop 201"}, session_id="s5"
    )
    assert verdict and verdict["action"] == "block"
    assert "lxc-201" in verdict["message"]


def test_off_mode_never_blocks(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "off", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    _seed(store)
    hooks = H.submodule("hooks")
    assert hooks.on_pre_tool_call(tool_name="terminal", args={"command": "ssh root@10.0.0.212 uptime"}, session_id="s6") is None


def test_guardrail_ignores_unregistered_targets(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)
    # 10.0.0.99 is not in the graph: nothing to read, so nothing to block
    assert hooks.on_pre_tool_call(tool_name="terminal", args={"command": "ssh root@10.0.0.99 uptime"}, session_id="s7") is None


def test_blocked_call_is_not_also_logged_as_allowed(plugin_home, registry):
    """post_tool_call fires for a vetoed call; it must not claim the touch happened."""
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    args = {"command": "ssh root@10.0.0.212 uptime"}
    assert hooks.on_pre_tool_call(tool_name="terminal", args=args, session_id="s8")["action"] == "block"
    hooks.on_post_tool_call(tool_name="terminal", args=args, result="blocked", session_id="s8")

    hooks.drain_activity()
    kinds = [entry["action_kind"] for entry in store.recent_activity(limit=10)]
    assert kinds.count("touch_blocked") == 1
    assert "touch_allowed" not in kinds


def test_infra_query_records_the_read_in_the_stream(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    _seed(store)
    tools = H.submodule("atlas_tools")

    tools.infra_query({"node_id": "svc-litellm"}, session_id="s9")
    entries = store.recent_activity(limit=10)
    assert any(entry["action_kind"] == "read_doc" and entry["node_id"] == "svc-litellm" for entry in entries)


def test_shared_address_resolves_to_the_machine_not_the_service(plugin_home, registry):
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    matcher = H.submodule("matcher")
    _seed(store)

    found = [node["id"] for node in matcher.match_text(store, "ssh root@10.0.0.212 uptime")]
    assert found == ["lxc-201"], found

    per_port = [node["id"] for node in matcher.match_text(store, "curl -sS http://10.0.0.212:4000/health")]
    assert per_port == ["svc-litellm"], per_port


def test_a_value_several_machines_share_is_not_a_reference(plugin_home, registry):
    """Every VM on a cluster documents the node IP; mentioning it accuses nobody."""
    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    matcher = H.submodule("matcher")
    _seed(store)
    for vmid in (201, 207):
        store.upsert_node(
            {
                "id": f"lxc-{vmid}-cluster",
                "kind": "lxc",
                "label": f"guest {vmid}",
                "host_ip": "10.0.0.150",
                "vmid": vmid,
                "registry_path": f"servers/guest-{vmid}.md",
            }
        )
    matcher.refresh()

    assert matcher.match_text(store, "ping -c1 10.0.0.150") == []
    # ... while the entry path still identifies exactly one node
    paths = [node["id"] for node in matcher.match_text(store, "server_id=guest-207")]
    assert paths == ["lxc-207-cluster"], paths


def test_the_gate_never_waits_on_a_locked_database(plugin_home, registry):
    """The regression that wedged every tool call: a writer held the DB and the
    pre-hook waited on the shared connection's lock."""
    import sqlite3
    import threading
    import time

    H.load_plugin()
    H.configure({"guardrail_mode": "block", "registry_path": str(registry)})
    store = H.submodule("store").get_store()
    hooks = H.submodule("hooks")
    _seed(store)

    row = store.conn.execute("PRAGMA database_list").fetchone()
    peer = sqlite3.connect(str(row[2]), timeout=0.1, isolation_level=None)
    peer.execute("BEGIN EXCLUSIVE" if peer.execute("PRAGMA journal_mode").fetchone()[0] != "wal" else "BEGIN IMMEDIATE")

    started = time.monotonic()
    verdict = hooks.on_pre_tool_call(
        tool_name="terminal", args={"command": "systemctl --user status litellm.service"}, session_id="s-lock"
    )
    elapsed = time.monotonic() - started
    peer.rollback()
    peer.close()

    assert elapsed < 2.0, f"the guardrail waited {elapsed:.1f}s on a locked database"
    # Unknown answer = fail open: the agent is never blocked by a busy database.
    assert verdict is None
