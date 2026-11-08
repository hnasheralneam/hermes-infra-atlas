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
