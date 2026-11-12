---
id: svc-edge-gateway
kind: service
label: edge-gateway
parent_id: srv-ops-vm
host_ip: 10.20.0.31
ports: [443]
managed_by: systemd-system
systemd_unit: edge-gateway.service
probe: tcp://10.20.0.31:443
recovery_cmd: systemctl restart edge-gateway.service
status: active
pitfalls: "Terminate TLS here only; the origin speaks plain HTTP."
---

# edge-gateway

Example service with a `recovery_cmd`, so the playbook has something to propose — the restart
still runs through Hermes' command approval, never silently.
