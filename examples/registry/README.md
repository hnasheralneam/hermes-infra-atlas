# Sample registry

A fictional fleet for trying the plugin without touching a real host. Set the plugin's
`registry_path` to this directory (`examples/registry`) and run `infra_sweep`:

- `pve-one` + `ops-vm` (hosts)
- `edge-gateway`, `render-farm` (services, one with a playbook)
- `legacy-indexer` (a `status: removed` entry, to show how retired docs are handled)
- `sample-app` (project)

Everything is `10.20.0.0/24` documentation space, so probes fail fast and the page renders
from documentation alone. Swap in your own directory when you are ready.
