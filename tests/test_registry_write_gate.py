"""The registry write gate: the KB stays open, but only through `infra_upsert`.

The gate must cover exactly the files `infra_upsert` owns and nothing else — a
gate with no sanctioned exit is an obstacle, and one that also freezes `plans/`
or `LIVE-STATE.md` would block work no tool can do.
"""

from __future__ import annotations

import _harness as H


def _setup(registry, mode="block"):
    H.load_plugin()
    H.configure({"guardrail_mode": "off", "registry_write_gate": mode, "registry_path": str(registry)})
    return H.submodule("hooks")


def test_a_direct_entry_write_is_blocked_and_names_the_tool(plugin_home, registry):
    hooks = _setup(registry)
    for tool, args in (
        ("write_file", {"path": str(registry / "services" / "litellm.md"), "content": "x"}),
        ("patch", {"path": str(registry / "services" / "litellm.md"), "old_string": "a", "new_string": "b"}),
        ("write_file", {"path": str(registry / "INDEX.md"), "content": "x"}),
        ("write_file", {"path": str(registry / "servers" / "cyber-realm.md"), "content": "x"}),
        ("write_file", {"path": str(registry / "projects" / "app.md"), "content": "x"}),
    ):
        verdict = hooks.on_pre_tool_call(tool_name=tool, args=args, session_id="s-w")
        assert verdict and verdict["action"] == "block", (tool, args)
        assert "infra_upsert" in verdict["message"], verdict["message"]
        assert "infra_credentials" in verdict["message"], verdict["message"]


def test_shell_writes_to_an_entry_are_blocked(plugin_home, registry):
    hooks = _setup(registry)
    entry = str(registry / "services" / "litellm.md")
    for command in (
        f"sed -i 's/a/b/' {entry}",
        f"echo hi | tee {entry}",
        f"cat > {entry} <<'EOF'\nhi\nEOF",
        f"mv {entry} /tmp/x",
        f"rm {entry}",
        f"python3 -c \"open('{entry}','w').write('x')\"",
    ):
        verdict = hooks.on_pre_tool_call(tool_name="terminal", args={"command": command}, session_id="s-sh")
        assert verdict and verdict["action"] == "block", command


def test_reading_and_grepping_the_registry_is_never_blocked(plugin_home, registry):
    hooks = _setup(registry)
    entry = str(registry / "services" / "litellm.md")
    for command in (
        f"cat {entry}",
        f"grep -n docker {entry}",
        f"ls {registry}/services/",
        f"head -20 {registry}/change-log.md",
        f"wc -l {entry}",
    ):
        assert hooks.on_pre_tool_call(tool_name="terminal", args={"command": command}, session_id="s-r") is None, command
    assert hooks.on_pre_tool_call(
        tool_name="read_file", args={"path": entry}, session_id="s-r"
    ) is None


def test_files_no_tool_owns_stay_hand_editable(plugin_home, registry):
    """plans/, conventions.md, LIVE-STATE.md and tracker files have no infra_upsert path."""
    hooks = _setup(registry)
    for path in (
        registry / "plans" / "infra-atlas-spec.md",
        registry / "conventions.md",
        registry / "LIVE-STATE.md",
        registry / "ccdc-team-channels.md",
        registry / "services" / "notes.txt",
    ):
        assert hooks.on_pre_tool_call(
            tool_name="write_file", args={"path": str(path), "content": "x"}, session_id="s-o"
        ) is None, path


def test_a_path_outside_the_registry_is_untouched(plugin_home, registry):
    hooks = _setup(registry)
    assert hooks.on_pre_tool_call(
        tool_name="write_file",
        args={"path": "/home/sysadmin/dev/dawgsec/some-repo/services/app.md", "content": "x"},
        session_id="s-x",
    ) is None


def test_warn_mode_allows_but_records(plugin_home, registry):
    hooks = _setup(registry, mode="warn")
    verdict = hooks.on_pre_tool_call(
        tool_name="write_file",
        args={"path": str(registry / "services" / "litellm.md"), "content": "x"},
        session_id="s-warn",
    )
    assert verdict is None


def test_off_mode_never_blocks(plugin_home, registry):
    hooks = _setup(registry, mode="off")
    assert hooks.on_pre_tool_call(
        tool_name="write_file",
        args={"path": str(registry / "INDEX.md"), "content": "x"},
        session_id="s-off",
    ) is None


def test_the_gate_does_not_depend_on_reading_the_entry(plugin_home, registry):
    """A session that already unlocked the node still cannot hand-edit its file."""
    hooks = _setup(registry)
    store = H.submodule("store").get_store()
    store.upsert_node(
        {"id": "svc-litellm", "kind": "service", "label": "LiteLLM", "host_ip": "10.0.0.212",
         "registry_path": "services/litellm.md"}
    )
    H.submodule("matcher").refresh()
    store.record_session_read("s-unlocked", "svc-litellm", "read_file")
    verdict = hooks.on_pre_tool_call(
        tool_name="write_file",
        args={"path": str(registry / "services" / "litellm.md"), "content": "x"},
        session_id="s-unlocked",
    )
    assert verdict and verdict["action"] == "block"


def test_infra_upsert_itself_is_never_gated(plugin_home, registry):
    hooks = _setup(registry)
    assert hooks.on_pre_tool_call(
        tool_name="infra_upsert",
        args={"node_id": "svc-x", "reason": "r", "markdown_body": "body"},
        session_id="s-up",
    ) is None
