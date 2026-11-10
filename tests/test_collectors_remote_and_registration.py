"""Remote collectors (Proxmox, Headscale), plugin registration and the surfaces.

Both collectors talk HTTP to real infrastructure, so the request layer is stubbed:
what matters here is the mapping from API payload to graph nodes, and the failure
modes when the API is unreachable or unconfigured.
"""

from __future__ import annotations

import json

import _harness as H


# ── Proxmox ────────────────────────────────────────────────────────────────
def test_proxmox_is_idle_until_configured(plugin_home):
    H.load_plugin()
    H.configure({"proxmox_url": "", "proxmox_token_id": ""})
    proxmox = H.submodule("collectors.proxmox")
    result = proxmox.collect()
    assert result.nodes == []
    assert result.errors == []


def test_proxmox_base_url_is_normalised(plugin_home):
    H.load_plugin()
    proxmox = H.submodule("collectors.proxmox")
    for raw, expected in (
        ("10.0.0.150", "https://10.0.0.150:8006"),
        ("https://10.0.0.150:8006", "https://10.0.0.150:8006"),
        ("https://10.0.0.150:8006/", "https://10.0.0.150:8006"),
        ("https://10.0.0.150:8006/api2/json", "https://10.0.0.150:8006"),
        ("http://pve.local:8006", "http://pve.local:8006"),
    ):
        H.configure({"proxmox_url": raw})
        assert proxmox._base_url() == expected, raw


def test_proxmox_maps_cluster_and_running_guests(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"proxmox_url": "10.0.0.150", "proxmox_token_id": "root@pam!atlas"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "s3cret" if name.endswith("PROXMOX_TOKEN_SECRET") else None)
    proxmox = H.submodule("collectors.proxmox")

    payloads = {
        "/nodes": [
            {"node": "pve-one", "status": "online", "cpu": 0.12, "maxmem": 64, "mem": 32, "uptime": 999},
            {"node": "pve-two", "status": "offline"},
        ],
        "/nodes/pve-one/qemu": [
            {"vmid": 130, "name": "bossagent", "status": "running", "tags": "infrastructure"},
            {"vmid": 131, "name": "stopped-one", "status": "stopped"},
            {"vmid": 9000, "name": "template", "status": "running", "template": 1},
            {"name": "no-vmid", "status": "running"},
        ],
        "/nodes/pve-one/lxc": [
            {"vmid": 201, "name": "litellm", "status": "running"},
            {"vmid": 202, "name": "paused-ct", "status": "paused"},
        ],
        "/nodes/pve-two/qemu": [],
        "/nodes/pve-two/lxc": [],
    }
    calls = []

    def fake_request(base, path, token_id, secret, verify, timeout=5.0):
        calls.append((path, token_id, secret, verify))
        return payloads[path]

    monkeypatch.setattr(proxmox, "_request", fake_request)
    result = proxmox.collect()
    by_id = {node["id"]: node for node in result.nodes}

    assert set(by_id) == {"srv-pve-one", "srv-pve-two", "vm-130", "lxc-201"}
    assert by_id["srv-pve-one"]["health_status"] == "up"
    assert by_id["srv-pve-two"]["health_status"] == "down"
    # stopped guests and templates are not drawn as nodes at all
    assert "vm-131" not in by_id and "vm-9000" not in by_id
    assert by_id["vm-130"]["parent_id"] == "srv-pve-one"
    assert by_id["vm-130"]["stratum"] == 2
    assert by_id["lxc-201"]["kind"] == "lxc"
    assert by_id["lxc-201"]["live_state"]["pve_status"] == "running"
    assert ("/nodes/pve-one/qemu", "root@pam!atlas", "s3cret", False) in calls
    hosted = {(edge["source_id"], edge["target_id"], edge["relation"]) for edge in result.edges}
    assert ("srv-pve-one", "vm-130", "hosts") in hosted
    assert ("srv-pve-one", "lxc-201", "hosts") in hosted


def test_proxmox_hides_untagged_vms_only_on_a_large_farm(plugin_home, monkeypatch):
    """A 40-VM workshop cluster would drown the graph; tagged infra still shows."""
    H.load_plugin()
    H.configure({"proxmox_url": "10.0.0.150", "proxmox_token_id": "root@pam!atlas"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "s3cret")
    proxmox = H.submodule("collectors.proxmox")

    farm = [{"vmid": 500 + index, "name": f"student-{index}", "status": "running"} for index in range(30)]
    farm.append({"vmid": 999, "name": "controller", "status": "running", "tags": "infrastructure"})
    payloads = {
        "/nodes": [{"node": "farm", "status": "online"}],
        "/nodes/farm/qemu": farm,
        "/nodes/farm/lxc": [],
    }
    monkeypatch.setattr(proxmox, "_request", lambda *args, **kwargs: payloads[args[1]])
    result = proxmox.collect()
    ids = {node["id"] for node in result.nodes}
    assert "vm-999" in ids
    assert "vm-500" not in ids


def test_proxmox_api_error_is_reported_not_raised(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"proxmox_url": "10.0.0.150", "proxmox_token_id": "root@pam!atlas"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "s3cret")
    proxmox = H.submodule("collectors.proxmox")

    def boom(*args, **kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(proxmox, "_request", boom)
    result = proxmox.collect()
    assert result.nodes == []
    assert result.errors and "proxmox /nodes" in result.errors[0]


def test_proxmox_guest_endpoint_failure_keeps_the_host(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"proxmox_url": "10.0.0.150", "proxmox_token_id": "root@pam!atlas"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "s3cret")
    proxmox = H.submodule("collectors.proxmox")

    def flaky(base, path, *args, **kwargs):
        if path == "/nodes":
            return [{"node": "pve-one", "status": "online"}]
        raise OSError("guest listing failed")

    monkeypatch.setattr(proxmox, "_request", flaky)
    result = proxmox.collect()
    assert [node["id"] for node in result.nodes] == ["srv-pve-one"]
    assert len(result.errors) == 2  # qemu + lxc


# ── Headscale ──────────────────────────────────────────────────────────────
def test_headscale_is_idle_until_configured(plugin_home):
    H.load_plugin()
    H.configure({"headscale_url": ""})
    headscale = H.submodule("collectors.headscale")
    assert headscale.collect().nodes == []


def test_headscale_maps_peers_and_online_state(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"headscale_url": "https://headscale.example"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "key" if name.endswith("HEADSCALE_API_KEY") else None)
    headscale = H.submodule("collectors.headscale")

    payload = {
        "nodes": [
            {"givenName": "laptop", "ipAddresses": ["100.64.0.5", "fd7a::5"], "online": True},
            {"name": "Phone", "ipAddresses": ["100.64.0.6"], "online": False},
            {"hostname": "", "ipAddresses": []},
            "not-a-node",
        ]
    }
    monkeypatch.setattr(headscale, "_fetch", lambda base, path, key, timeout=5.0: payload)
    result = headscale.collect()
    by_id = {node["id"]: node for node in result.nodes}

    assert set(by_id) == {"srv-laptop", "srv-phone"}
    assert by_id["srv-laptop"]["tailnet_ip"] == "100.64.0.5"
    assert by_id["srv-laptop"]["health_status"] == "up"
    assert by_id["srv-laptop"]["kind"] == "peer"
    assert by_id["srv-phone"]["health_status"] == "unknown"
    assert by_id["srv-phone"]["live_state"]["online"] is False


def test_headscale_falls_back_to_the_legacy_endpoint(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"headscale_url": "https://headscale.example"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "key")
    headscale = H.submodule("collectors.headscale")

    seen = []

    def fetch(base, path, key, timeout=5.0):
        seen.append(path)
        if path == "/api/v1/node":
            raise OSError("404")
        return {"machines": [{"name": "old-api", "ipAddresses": ["100.64.0.9"], "connected": True}]}

    monkeypatch.setattr(headscale, "_fetch", fetch)
    result = headscale.collect()
    assert seen == ["/api/v1/node", "/api/v1/machine"]
    assert [node["id"] for node in result.nodes] == ["srv-old-api"]
    assert result.nodes[0]["health_status"] == "up"


def test_headscale_unreachable_records_both_attempts(plugin_home, monkeypatch):
    H.load_plugin()
    H.configure({"headscale_url": "https://headscale.example"})
    config = H.submodule("config")
    monkeypatch.setattr(config, "secret", lambda name: "key")
    headscale = H.submodule("collectors.headscale")

    def boom(*args, **kwargs):
        raise OSError("timeout")

    monkeypatch.setattr(headscale, "_fetch", boom)
    result = headscale.collect()
    assert result.nodes == []
    assert len(result.errors) == 2


# ── registration ───────────────────────────────────────────────────────────
def test_register_wires_every_surface(plugin_home):
    """`register(ctx)` is the only thing Hermes calls: if it drifts, all is lost."""
    module = H.load_plugin()
    ctx = H.FakeCtx()
    module.register(ctx)

    assert set(ctx.tools) == {"infra_query", "infra_sweep", "infra_diff", "infra_upsert", "infra_bootstrap", "infra_incidents"}
    for name, tool in ctx.tools.items():
        assert tool["schema"]["name"] == name
        assert callable(tool["handler"])
        assert tool["toolset"]
        assert tool["schema"].get("description")
    assert set(ctx.hooks) == {"pre_tool_call", "post_tool_call", "on_session_start"}
    assert ctx.skills and ctx.skills[0][0] == "infra-atlas"
    assert "atlas" in ctx.commands
    assert ctx.blueprints and ctx.blueprints[0][0] == "uptime-watchdog"


def test_atlas_command_reports_counts_and_sweeps(plugin_home, registry):
    module = H.load_plugin()
    H.configure({"registry_path": str(registry)})
    ctx = H.FakeCtx()
    ctx.settings = {"registry_path": str(registry)}
    module.register(ctx)
    handle = ctx.commands["atlas"]

    status = handle("")
    assert "Infra Atlas" in status
    assert "matched" in status

    swept = handle("sweep")
    assert "sweep" in swept.lower()
    assert ctx.dispatched == []
