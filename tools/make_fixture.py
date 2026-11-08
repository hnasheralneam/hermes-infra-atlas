#!/usr/bin/env python3
"""Regenerate fixtures/sample_fleet.json.

The demo fleet is sanitized on purpose: RFC1918 addresses in two dedicated
ranges, generic hostnames, and a fixed set of drift/incident states that show
every status the UI can render. Run from the repo root:

    python3 tools/make_fixture.py
"""

from __future__ import annotations

import json
import pathlib
import time

NOW = time.time()


def node(**kw):
    base = {
        "kind": "service", "stratum": 3, "parent_id": None, "host_ip": None, "tailnet_ip": None,
        "vmid": None, "ports": [], "managed_by": None, "systemd_unit": None, "project_path": None,
        "registry_path": None, "pitfalls_summary": None, "recovery_cmd": None,
        "auto_heal_policy": "auto", "drift_status": "matched", "drift_reasons": [],
        "health_status": "up", "latency_ms": None, "uptime_24h_pct": 100.0,
        "failure_streak": 0, "last_seen_live_at": NOW,
    }
    base.update(kw)
    base.setdefault("label", base["id"])
    base["doc_state"] = {
        key: base.get(key)
        for key in ("id", "kind", "label", "host_ip", "tailnet_ip", "vmid", "ports", "managed_by",
                    "systemd_unit", "recovery_cmd")
    }
    base["live_state"] = {
        "source": "fixture",
        **{key: base.get(key) for key in ("host_ip", "tailnet_ip", "vmid", "ports", "systemd_unit")},
    }
    return base


NODES = [
    node(id="srv-olympus-pve", kind="server", stratum=1, label="olympus-pve", host_ip="10.20.0.10",
         ports=["8006", "22"], managed_by="proxmox", latency_ms=3.1),
    node(id="srv-athena-ai", kind="server", stratum=1, label="athena-ai", host_ip="10.20.0.50",
         tailnet_ip="100.64.0.50", ports=["22", "8080"], managed_by="proxmox", latency_ms=1.8,
         pitfalls_summary="Start llama-server through the Control API on :8081/api/start, never directly."),
    node(id="srv-bastion-gw", kind="server", stratum=1, label="bastion-gw", host_ip="10.20.0.1",
         ports=["443", "8080"], managed_by="headscale", latency_ms=2.4),

    node(id="lxc-201-litellm", kind="lxc", stratum=2, label="litellm-gateway", parent_id="srv-olympus-pve",
         host_ip="10.20.0.212", vmid=201, ports=["4000"], managed_by="proxmox", latency_ms=2.9,
         uptime_24h_pct=99.98),
    node(id="lxc-218-wazuh", kind="lxc", stratum=2, label="wazuh-siem", parent_id="srv-olympus-pve",
         host_ip="10.20.0.218", vmid=218, ports=["443", "55000"], managed_by="proxmox",
         drift_status="unregistered", drift_reasons=["Live LXC 218 (wazuh-siem) has no registry entry"],
         doc_state={}, latency_ms=8.2),
    node(id="vm-104-blueteam-ad", kind="vm", stratum=2, label="blueteam-ad", parent_id="srv-olympus-pve",
         host_ip="10.20.1.104", vmid=104, ports=["389", "445"], managed_by="proxmox", latency_ms=6.4),
    node(id="vm-108-scoring-engine", kind="vm", stratum=2, label="scoring-engine", parent_id="srv-olympus-pve",
         host_ip="10.20.1.108", vmid=108, ports=["8443"], managed_by="proxmox", latency_ms=7.7),
    node(id="lxc-205-forgejo", kind="lxc", stratum=2, label="forgejo", parent_id="srv-olympus-pve",
         host_ip="10.20.0.205", vmid=205, ports=["3000", "22"], managed_by="proxmox", latency_ms=5.1),
    node(id="lxc-209-nextcloud", kind="lxc", stratum=2, label="nextcloud", parent_id="srv-olympus-pve",
         host_ip="10.20.0.209", vmid=209, ports=["443"], managed_by="proxmox", latency_ms=9.9),

    node(id="svc-litellm-proxy", label="LiteLLM proxy", parent_id="lxc-201-litellm", host_ip="10.20.0.212",
         ports=["4000"], managed_by="systemd-system", systemd_unit="litellm.service",
         registry_path="services/litellm.md", recovery_cmd="systemctl restart litellm.service",
         probe="http://10.20.0.212:4000/health/liveliness", latency_ms=11.4,
         drift_status="changed",
         drift_reasons=["host_ip: registry says 10.20.0.50, live is 10.20.0.212",
                        "ports: registry says 4000 on 10.20.0.50, live listens on 10.20.0.212:4000"],
         pitfalls_summary="Dial 10.20.0.212:4000 directly; the old 10.20.0.50 front was removed."),
    node(id="svc-llama-dashboard", label="llama-dashboard", parent_id="srv-athena-ai", host_ip="10.20.0.50",
         ports=["8081"], managed_by="systemd-user", systemd_unit="llama-dashboard.service",
         registry_path="services/llama-dashboard.md", recovery_cmd="systemctl --user restart llama-dashboard.service",
         probe="http://10.20.0.50:8081/api/status", latency_ms=4.2, uptime_24h_pct=99.91,
         pitfalls_summary="llama-server is started and stopped through Control on :8081, never from a shell."),
    node(id="svc-wazuh-siem", label="Wazuh SIEM", parent_id="lxc-218-wazuh", host_ip="10.20.0.218",
         ports=["443", "55000"], managed_by="docker-compose", probe="https://10.20.0.218/",
         drift_status="unregistered", drift_reasons=["Discovered live on 10.20.0.218:443 with no registry entry"],
         doc_state={}, latency_ms=42.0, auto_heal_policy="notify_only"),
    node(id="svc-inject-portal", label="inject-portal", parent_id="srv-athena-ai", host_ip="10.20.0.50",
         ports=["8087"], managed_by="systemd-user", systemd_unit="inject-portal.service",
         registry_path="services/inject-portal.md", recovery_cmd="systemctl --user restart inject-portal.service",
         probe="http://10.20.0.50:8087/", drift_status="stale",
         drift_reasons=["Registry says active on :8087; probe has failed 3x (connection refused)"],
         health_status="down", latency_ms=None, uptime_24h_pct=87.4, failure_streak=3,
         last_seen_live_at=NOW - 640,
         pitfalls_summary="Bound to 127.0.0.1 only; probing the tailnet address always fails."),
    node(id="svc-headscale", label="Headscale", parent_id="srv-bastion-gw", host_ip="10.20.0.1",
         ports=["8080"], managed_by="systemd-system", systemd_unit="headscale.service",
         registry_path="services/headscale.md", probe="http://10.20.0.1:8080/health", latency_ms=3.3),
    node(id="svc-forgejo", label="Forgejo", parent_id="lxc-205-forgejo", host_ip="10.20.0.205",
         ports=["3000"], managed_by="docker-compose", registry_path="services/forgejo.md",
         probe="http://10.20.0.205:3000/api/healthz", latency_ms=6.8, auto_heal_policy="playbook_only"),
    node(id="svc-quotient-scoring", label="Quotient scoring", parent_id="vm-108-scoring-engine",
         host_ip="10.20.1.108", ports=["8443"], managed_by="docker-compose",
         registry_path="services/quotient.md", probe="https://10.20.1.108:8443/health", latency_ms=18.5),
    node(id="proj-range-automation", kind="project", label="range-automation", parent_id="srv-athena-ai",
         project_path="/srv/range-automation", managed_by="git", registry_path="projects/range-automation.md",
         drift_status="doc_only", health_status="unknown"),

    node(id="agent-hermes-ops", kind="agent", stratum=4, label="Hermes (ops)", managed_by="hermes",
         registry_path="services/hermes-gateway.md", latency_ms=1.1,
         live_state={"source": "fixture", "profile": "default", "model": "qwen3.8-flash-next"}),
    node(id="model-qwen-local", kind="model_endpoint", stratum=4, label="Local vLLM (B70)",
         host_ip="10.20.0.50", ports=["8080"], managed_by="hermes-config",
         probe="http://10.20.0.50:8080/v1/models", latency_ms=21.0),
    node(id="model-litellm-pool", kind="model_endpoint", stratum=4, label="LiteLLM pool",
         host_ip="10.20.0.212", ports=["4000"], managed_by="hermes-config",
         probe="http://10.20.0.212:4000/v1/models", latency_ms=12.6),
    node(id="cron-fleet-heartbeat", kind="cron", stratum=4, label="cron: fleet-heartbeat",
         parent_id="agent-hermes-ops", managed_by="hermes-cron",
         live_state={"source": "fixture", "schedule": "every 5m", "last_status": "ok"}),
    node(id="cron-nightly-backup", kind="cron", stratum=4, label="cron: nightly-backup",
         parent_id="agent-hermes-ops", managed_by="hermes-cron", drift_status="changed",
         drift_reasons=["stale: last ran 38h ago (every 24h)"], health_status="degraded",
         live_state={"source": "fixture", "schedule": "0 7 * * *", "last_status": "ok"}),
]

EDGES = [
    ("srv-olympus-pve", "lxc-201-litellm", "hosts", "live"),
    ("srv-olympus-pve", "lxc-218-wazuh", "hosts", "live"),
    ("srv-olympus-pve", "vm-104-blueteam-ad", "hosts", "live"),
    ("srv-olympus-pve", "vm-108-scoring-engine", "hosts", "live"),
    ("srv-olympus-pve", "lxc-205-forgejo", "hosts", "live"),
    ("srv-olympus-pve", "lxc-209-nextcloud", "hosts", "live"),
    ("lxc-201-litellm", "svc-litellm-proxy", "hosts", "both"),
    ("srv-athena-ai", "svc-llama-dashboard", "hosts", "both"),
    ("srv-athena-ai", "svc-inject-portal", "hosts", "both"),
    ("lxc-218-wazuh", "svc-wazuh-siem", "hosts", "live"),
    ("srv-bastion-gw", "svc-headscale", "hosts", "both"),
    ("lxc-205-forgejo", "svc-forgejo", "hosts", "both"),
    ("vm-108-scoring-engine", "svc-quotient-scoring", "hosts", "both"),
    ("agent-hermes-ops", "model-qwen-local", "uses_model", "live"),
    ("agent-hermes-ops", "model-litellm-pool", "uses_model", "live"),
    ("cron-fleet-heartbeat", "srv-olympus-pve", "monitors", "live"),
    ("cron-nightly-backup", "lxc-209-nextcloud", "monitors", "live"),
    ("svc-litellm-proxy", "lxc-201-litellm", "depends_on", "doc"),
]

INCIDENTS = [
    {"node_id": "svc-inject-portal", "node_label": "inject-portal", "status": "open",
     "started_at": NOW - 640, "failure_count": 3,
     "trigger_error": "HTTP http://10.20.0.50:8087/ -> connection refused (3x consecutive)",
     "root_cause_hint": "Parent srv-athena-ai is up; unit inject-portal.service is failed",
     "heal_attempts": 0, "last_heal_action": None, "resolution_summary": None},
    {"node_id": "lxc-201-litellm", "node_label": "litellm-gateway", "status": "resolved",
     "started_at": NOW - 4200, "resolved_at": NOW - 3900, "failure_count": 2,
     "trigger_error": "TCP 4000 failed: timed out",
     "root_cause_hint": "Container was stopped during maintenance",
     "heal_attempts": 1, "last_heal_action": "systemctl restart litellm.service",
     "resolution_summary": "Auto-healed via local playbook in 2841ms (verified UP)"},
]


def probe_history():
    rows = []
    series = (("svc-litellm-proxy", 11.4), ("svc-llama-dashboard", 4.2),
              ("svc-inject-portal", 9.0), ("srv-olympus-pve", 3.1))
    for node_id, base in series:
        for index in range(24):
            down = node_id == "svc-inject-portal" and index > 18
            rows.append({
                "node_id": node_id,
                "ts": NOW - (23 - index) * 300,
                "status": "down" if down else "up",
                "latency_ms": None if down else round(base * (0.8 + (index % 5) * 0.09), 1),
                "detail": "connection refused" if down else "ok",
            })
    return rows


def main() -> None:
    payload = {
        "name": "DawgSec demo fleet",
        "sanitized": True,
        "generated_at": NOW,
        "nodes": NODES,
        "edges": [
            {"source_id": s, "target_id": t, "relation": r, "origin": o} for s, t, r, o in EDGES
        ],
        "incidents": INCIDENTS,
        "probe_history": probe_history(),
    }
    out = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "sample_fleet.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(NODES)} nodes)")


if __name__ == "__main__":
    main()
