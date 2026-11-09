---
id: svc-render-farm
kind: service
label: render-farm
parent_id: srv-ops-vm
host_ip: 10.20.0.32
ports: [8081]
managed_by: systemd-user
systemd_unit: render-farm.service
probe: tcp://10.20.0.32:8081
auto_heal_policy: playbook_only
status: active
pitfalls: "Start it through the queue controller on :8081 — never call the worker directly."
---

# render-farm

Second example service. Point it at an address that does not answer (or leave the registry
alone and it will still be documented) and a sweep reports it `stale` with the probe error
as evidence.
