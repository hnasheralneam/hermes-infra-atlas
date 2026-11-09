"""Collector behaviour that does not need the real host: parsing, timeouts, probes."""

from __future__ import annotations

import json
import socket
import time

import _harness as H


def test_systemd_json_units_are_normalized(plugin_home, monkeypatch):
    H.load_plugin()
    local = H.submodule("collectors.local_host")

    payload = json.dumps(
        [
            {"unit": "llama-dashboard.service", "active": "active", "sub": "running"},
            {"unit": "old-thing.service", "active": "inactive", "sub": "dead"},
            {"unit": "broken.service", "active": "failed", "sub": "failed"},
        ]
    )
    monkeypatch.setattr(local, "_run", lambda argv, timeout=2.0: (0, payload) if "--output=json" in argv else (1, ""))
    units = local._systemd_units("user")
    assert [unit["unit"] for unit in units] == ["llama-dashboard.service", "old-thing.service", "broken.service"]

    result = local.collect()
    ids = {node["id"] for node in result.nodes}
    # inactive units are not nodes; the failed one is, and only it is incident-eligible
    assert "svc-old-thing" not in ids
    assert "svc-broken" in ids
    broken = next(node for node in result.nodes if node["id"] == "svc-broken")
    assert broken["health_status"] == "down"
    assert broken["live_state"]["incident_eligible"] is True


def test_docker_containers_are_parsed(plugin_home, monkeypatch):
    H.load_plugin()
    local = H.submodule("collectors.local_host")
    monkeypatch.setattr(local.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(
        local,
        "_run",
        lambda argv, timeout=2.0: (0, "wazuh|wazuh/wazuh:4.9|Up 3 hours|0.0.0.0:443->443/tcp\n")
        if "ps" in argv
        else (1, ""),
    )
    containers = local._docker_containers()
    assert containers[0]["name"] == "wazuh"
    assert containers[0]["ports"] == ["443"]
    assert containers[0]["running"] is True


def test_tcp_probe_against_a_real_socket(plugin_home):
    H.load_plugin()
    probes = H.submodule("collectors.probes")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    try:
        status, latency, detail = probes.probe_url(f"tcp://127.0.0.1:{port}", timeout=1.0)
        assert status == "up"
        assert detail.startswith("TCP")
        assert latency is not None
    finally:
        server.close()

    status, latency, detail = probes.probe_url(f"tcp://127.0.0.1:{port}", timeout=0.5)
    assert status == "down"
    assert latency is None


def test_probe_eligibility_requires_an_explicit_probe(plugin_home):
    H.load_plugin()
    probes = H.submodule("collectors.probes")

    inferred = {"id": "svc-a", "kind": "service", "probe": "tcp://10.0.0.5:1", "probe_inferred": True}
    observation = probes.probe_node(inferred, timeout=0.2)
    assert observation["live_state"]["incident_eligible"] is False
    assert observation["live_state"]["probe_declared"] is False

    declared = {"id": "svc-b", "kind": "service", "probe": "tcp://10.0.0.5:1"}
    observation = probes.probe_node(declared, timeout=0.2)
    assert observation["live_state"]["incident_eligible"] is True


def test_cron_staleness_is_reported(plugin_home):
    H.load_plugin()
    runtime = H.submodule("collectors.hermes_runtime")

    cron_dir = plugin_home / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    jobs = {
        "jobs": [
            {
                "id": "aaaa1111",
                "name": "fresh",
                "schedule": {"kind": "interval", "minutes": 5, "display": "every 5m"},
                "last_run_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - 60)) + "+00:00",
                "last_status": "ok",
                "enabled": True,
                "state": "scheduled",
            },
            {
                "id": "bbbb2222",
                "name": "stale",
                "schedule": {"kind": "interval", "minutes": 5, "display": "every 5m"},
                "last_run_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - 3600)) + "+00:00",
                "last_status": "ok",
                "enabled": True,
                "state": "scheduled",
            },
            {
                "id": "cccc3333",
                "name": "failing",
                "schedule": {"kind": "cron", "expr": "0 7 * * *"},
                "last_run_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - 120)) + "+00:00",
                "last_status": "error",
                "enabled": True,
                "state": "scheduled",
            },
        ]
    }
    (cron_dir / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")

    result = runtime.collect()
    cron_nodes = {node["label"]: node for node in result.nodes if node["kind"] == "cron"}
    assert cron_nodes["cron: fresh"]["health_status"] == "up"
    assert cron_nodes["cron: stale"]["health_status"] == "degraded"
    assert "stale" in " ".join(cron_nodes["cron: stale"]["live_state"]["reasons"])
    assert cron_nodes["cron: failing"]["health_status"] == "degraded"


def test_period_parsing():
    H.load_plugin()
    runtime = H.submodule("collectors.hermes_runtime")
    assert runtime._period_seconds({"kind": "interval", "minutes": 5}) == 300
    assert runtime._period_seconds({"kind": "cron", "expr": "*/5 * * * *"}) == 300
    assert runtime._period_seconds({"kind": "cron", "expr": "0 7 * * *"}) == 86400
    assert runtime._period_seconds({"kind": "cron", "expr": "0 9 * * 1-5"}) == 7 * 86400
    assert runtime._period_seconds({"kind": "cron", "expr": "nonsense"}) is None


def test_an_unresolvable_host_does_not_stall_the_sweep(plugin_home):
    """DNS hangs used to cost minutes: getaddrinfo ignores the socket timeout."""
    import time

    H.load_plugin()
    probes = H.submodule("collectors.probes")

    started = time.monotonic()
    result = probes.collect(
        [
            {"id": "n-dns", "probe": "http://host.invalid:8080/health"},
            {"id": "n-tcp", "probe": "tcp://host.invalid:9"},
        ],
        timeout=1.0,
    )
    elapsed = time.monotonic() - started

    assert elapsed < 8, f"probe sweep took {elapsed:.1f}s on an unresolvable host"
    assert {node["id"] for node in result.nodes} == {"n-dns", "n-tcp"}
    assert all(node["health_status"] in {"unknown", "down"} for node in result.nodes)


def test_a_url_probe_targets_its_host_not_its_scheme(plugin_home):
    """Regression: "http://10.0.0.143:3017/" was parsed as host "http://10.0.0.143".

    Every URL probe then failed resolution and the whole fleet looked down.
    """
    H.load_plugin()
    probes = H.submodule("collectors.probes")

    assert probes._host_of("http://10.0.0.143:3017/") == "10.0.0.143"
    assert probes._host_of("https://ctf.example.edu/health") == "ctf.example.edu"
    assert probes._host_of("10.0.0.143:3017") == "10.0.0.143"
    assert probes._host_of("tcp://[fd00::1]:80") == "[fd00::1]"
    assert probes._is_ip_literal("10.0.0.143")
    assert not probes._is_ip_literal("ctf.example.edu")

    # A literal-IP URL must be probed directly: a closed port is "down", not
    # "hostname did not resolve".
    result = probes.collect([{"id": "n-ip", "probe": "http://127.0.0.1:9/"}], timeout=0.8)
    node = result.nodes[0]
    assert node["health_status"] == "down", node
    assert "did not resolve" not in str(node["live_state"].get("probe_detail"))


def test_any_declared_port_answering_means_the_node_is_up(plugin_home):
    """Forgejo's entry lists LDAP 389 before its HTTP port; probing only the
    first port reported a healthy service as down."""
    import socket

    H.load_plugin()
    probes = H.submodule("collectors.probes")

    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    live_port = server.getsockname()[1]
    try:
        result = probes.collect(
            [{"id": "n-multi", "host_ip": "127.0.0.1", "ports": ["9", str(live_port)]}], timeout=0.8
        )
    finally:
        server.close()

    node = result.nodes[0]
    assert node["health_status"] == "up", node["live_state"].get("probe_detail")


def test_unreachable_is_not_the_same_as_down(plugin_home):
    """A probe run from the wrong network must not declare a service dead."""
    H.load_plugin()
    probes = H.submodule("collectors.probes")

    # Reserved TEST-NET-1 address: the packet goes nowhere, nothing refuses it.
    result = probes.collect([{"id": "n-unreach", "probe": "tcp://192.0.2.1:9"}], timeout=0.6)
    node = result.nodes[0]
    assert node["health_status"] == "unknown", node["live_state"].get("probe_detail")
    assert "unreachable" in str(node["live_state"].get("probe_detail"))

    # A closed port on a host that answers is a real outage.
    result = probes.collect([{"id": "n-refused", "probe": "tcp://127.0.0.1:9"}], timeout=0.6)
    assert result.nodes[0]["health_status"] == "down"
