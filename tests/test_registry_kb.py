"""Knowledge-base parsing, frontmatter merging and the change-log protocol."""

from __future__ import annotations

import _harness as H


def test_legacy_entry_is_parsed_without_frontmatter(plugin_home, legacy_registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    nodes, _edges = kb.parse_registry(legacy_registry)
    by_id = {node["id"]: node for node in nodes}

    litellm = by_id["svc-litellm"]
    assert litellm["host_ip"] == "10.0.0.212"
    assert "4000" in litellm["ports"]
    assert litellm["systemd_unit"] == "litellm.service"
    assert litellm["managed_by"] == "systemd-user"
    # inferred, so it must not count as an explicit uptime watch
    assert litellm["probe"] and litellm["probe_inferred"] is True
    assert litellm["recovery_cmd"] == "systemctl --user restart litellm.service"
    assert litellm["doc_status"] == "active"
    assert "Do NOT point clients" in (litellm["pitfalls_summary"] or "")

    athena = by_id["srv-athena"]
    assert athena["host_ip"] == "10.0.0.50"
    assert athena["tailnet_ip"] == "100.64.0.50"
    # a server doc never claims another host's unit
    assert athena["systemd_unit"] is None

    # "REMOVED" in the title retires the entry
    assert by_id["svc-gone"]["doc_status"] == "removed"


def test_server_entry_with_a_vmid_is_parsed_as_a_vm(plugin_home, registry):
    """A vmid is the one thing a guest has and a hypervisor does not."""
    H.load_plugin()
    kb = H.submodule("registry_kb")
    (registry / "servers" / "guest.md").write_text(
        "---\n"
        "id: srv-guest\n"
        "kind: server\n"
        "label: guest (VM 207)\n"
        "parent_id: srv-host\n"
        "host_ip: 10.0.0.40\n"
        "vmid: 207\n"
        "managed_by: proxmox\n"
        "status: active\n"
        "---\n\nGuest box.\n",
        encoding="utf-8",
    )
    (registry / "servers" / "metal.md").write_text(
        "---\n"
        "id: srv-metal\n"
        "kind: server\n"
        "label: metal host\n"
        "host_ip: 10.0.0.41\n"
        "managed_by: proxmox\n"
        "status: active\n"
        "---\n\nHypervisor.\n",
        encoding="utf-8",
    )
    (registry / "servers" / "guest-by-parent.md").write_text(
        "---\n"
        "id: srv-guest-2\n"
        "kind: server\n"
        "label: guest without vmid\n"
        "parent_id: srv-metal\n"
        "host_ip: 10.0.0.42\n"
        "managed_by: proxmox\n"
        "status: active\n"
        "---\n\nGuest on the hypervisor.\n",
        encoding="utf-8",
    )
    nodes, _ = kb.parse_registry(registry)
    by_id = {node["id"]: node for node in nodes}

    assert by_id["srv-guest"]["kind"] == "vm"
    assert by_id["srv-guest"]["stratum"] == 2
    assert by_id["srv-guest-2"]["kind"] == "vm"
    # a bare hypervisor stays hardware
    assert by_id["srv-metal"]["kind"] == "server"
    assert by_id["srv-metal"]["stratum"] == 1


def test_removed_in_prose_does_not_retire_a_live_service(plugin_home, registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    (registry / "services" / "kept.md").write_text(
        "# Kept Service\n\nMoved here after the old front end was REMOVED in 2026-10.\nHost 10.9.9.9 port 9000.\n",
        encoding="utf-8",
    )
    nodes, _ = kb.parse_registry(registry)
    assert nodes[0]["doc_status"] == "active"


def test_upsert_preserves_prose_and_writes_changelog(plugin_home, legacy_registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    path = legacy_registry / "services" / "litellm.md"
    before = path.read_text(encoding="utf-8")

    kb.upsert_entry(
        legacy_registry,
        {
            "id": "svc-litellm",
            "kind": "service",
            "label": "LiteLLM Gateway",
            "host_ip": "10.0.0.212",
            "ports": ["4000"],
            "managed_by": "systemd-system",
            "systemd_unit": "litellm.service",
            "probe": "http://10.0.0.212:4000/health/liveliness",
            "pitfalls": "Dial 212 directly.",
        },
        "moved off the old front end",
        session_id="test-session",
    )

    after = path.read_text(encoding="utf-8")
    assert after.startswith("---\n")
    assert "id: svc-litellm" in after
    assert "probe: http://10.0.0.212:4000/health/liveliness" in after
    # every prose line survives the merge
    for line in before.splitlines():
        if line.strip():
            assert line in after, f"lost prose line: {line!r}"

    changelog = (legacy_registry / "change-log.md").read_text(encoding="utf-8")
    assert "svc-litellm" in changelog
    assert "moved off the old front end" in changelog
    assert changelog.index("svc-litellm") > changelog.index("# Infrastructure change log")

    index = (legacy_registry / "INDEX.md").read_text(encoding="utf-8")
    assert "services/litellm.md" in index


def test_upsert_creates_new_entry_and_second_write_is_stable(plugin_home, registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    first = kb.upsert_entry(
        registry,
        {"id": "svc-wazuh", "kind": "service", "label": "Wazuh", "host_ip": "10.0.0.218", "ports": ["443"]},
        "adopted from live discovery",
    )
    assert first["created"] is True
    path = registry / "services" / "wazuh.md"
    assert path.exists()

    second = kb.upsert_entry(
        registry,
        {"id": "svc-wazuh", "kind": "service", "ports": ["443", "55000"], "recovery_cmd": "docker compose up -d"},
        "added the second port",
    )
    assert second["created"] is False
    text = path.read_text(encoding="utf-8")
    assert "ports: [443, 55000]" in text
    assert "recovery_cmd: docker compose up -d" in text


def test_bootstrap_annotate_is_idempotent(plugin_home, legacy_registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    dry = kb.bootstrap_annotate(legacy_registry, dry_run=True)
    assert len(dry["annotated"]) == 3
    path = legacy_registry / "services" / "litellm.md"
    assert not path.read_text(encoding="utf-8").startswith("---")

    real = kb.bootstrap_annotate(legacy_registry)
    assert len(real["annotated"]) == 3
    assert path.read_text(encoding="utf-8").startswith("---\n")
    assert "Runs on `10.0.0.212`" in path.read_text(encoding="utf-8")

    again = kb.bootstrap_annotate(legacy_registry)
    assert again["annotated"] == []
    assert len(again["skipped"]) == 3


def test_udp_ports_and_index_decommissioned_entries(plugin_home, registry):
    H.load_plugin()
    kb = H.submodule("registry_kb")
    (registry / "services" / "stk.md").write_text(
        "# Supertuxkart Server\n\n| Field | Value |\n|---|---|\n| **Network** | 192.168.100.83 |\n| **Port** | UDP **2759** |\n",
        encoding="utf-8",
    )
    (registry / "services" / "old-relay.md").write_text(
        "# Old Relay\n\nHost 10.0.0.143 port 8090.\n",
        encoding="utf-8",
    )
    (registry / "INDEX.md").write_text(
        "# Index\n\n## Decommissioned / Superseded / Down Services\n\n| Service | File |\n|---|---|\n| Old Relay | `services/old-relay.md` |\n",
        encoding="utf-8",
    )
    nodes, _ = kb.parse_registry(registry)
    by_id = {n["id"]: n for n in nodes}
    assert by_id["svc-stk"]["probe"] is None
    assert by_id["svc-old-relay"]["doc_status"] == "removed"
    assert by_id["svc-old-relay"]["probe"] is None
