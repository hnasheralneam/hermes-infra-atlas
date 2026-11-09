---
id: srv-pve-one
kind: server
label: pve-one
host_ip: 10.20.0.11
ports: [8006, 22]
managed_by: proxmox
probe: tcp://10.20.0.11:8006
status: active
---

# pve-one

Example hypervisor for the sample registry that ships with this plugin. Nothing here is
real: the addresses are documentation range (`10.20.0.0/24`), so pointing
`registry_path` at `examples/registry` renders a populated topology with zero access.

Proxmox VE 8 cluster with two nodes. Guests live in `../servers/*` and `../services/*`.
