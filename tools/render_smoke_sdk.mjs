// Stub of @hermes/plugin-sdk, faithful only to the shapes desktop/plugin.js
// touches: the area constants, cn, host, and useQuery. Fixture data is shaped
// exactly like the real /api/plugins/infra-atlas responses (drift_reasons are
// strings, counts/fleet/incidents are present).

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const PALETTE_AREA = 'palette'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript-directive'
export const STATUSBAR_AREAS = { left: 'statusbar-left', right: 'statusbar-right' }

export const cn = (...parts) => parts.filter(Boolean).join(' ')

export const FIXTURE = {
  graph: {
    nodes: [
      { id: 'srv-pve', kind: 'server', label: 'pve-one', stratum: 1, drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.11', ports: [8006], managed_by: 'proxmox', registry_path: 'servers/pve-one.md' },
      { id: 'peer-relay', kind: 'peer', label: 'tail-relay', stratum: 1, drift_status: 'observed', health_status: 'unknown', tailnet_ip: '100.64.0.7' },
      { id: 'vm-101-ops', kind: 'vm', label: 'ops-vm', stratum: 2, vmid: 101, parent_id: 'srv-pve', drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.21', managed_by: 'proxmox', registry_path: 'servers/ops-vm.md' },
      { id: 'lxc-202-cache', kind: 'lxc', label: 'cache-tank', stratum: 2, vmid: 202, parent_id: 'srv-pve', drift_status: 'changed', health_status: 'up', host_ip: '10.20.0.22', managed_by: 'proxmox', registry_path: 'servers/cache-tank.md', drift_reasons: ['host_ip: registry says 10.20.0.30, live is 10.20.0.22'] },
      { id: 'ct-redis', kind: 'container', label: 'redis', stratum: 2, parent_id: 'srv-pve', drift_status: 'matched', health_status: 'degraded', host_ip: '10.20.0.23', managed_by: 'docker', uptime_24h_pct: 97.2 },
      { id: 'svc-gateway', kind: 'service', label: 'edge-gateway', stratum: 3, parent_id: 'lxc-202-cache', drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.31', ports: [443], managed_by: 'docker', registry_path: 'services/edge-gateway.md', last_seen_live_at: 1794000040, uptime_24h_pct: 99.9, latency_ms: 6 },
      { id: 'ct-docker-wazuh', kind: 'container', label: 'wazuh', stratum: 3, parent_id: 'lxc-202-cache', drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.24', ports: [443], managed_by: 'docker' },
      { id: 'svc-llama', kind: 'inference', label: 'llama-server', stratum: 3, parent_id: 'vm-101-ops', drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.25', ports: [8080], managed_by: 'llama-control', registry_path: 'services/llama-server.md', latency_ms: 9, uptime_24h_pct: 99.1 },
      { id: 'svc-render', kind: 'service', label: 'render-farm', stratum: 3, parent_id: 'vm-101-ops', drift_status: 'stale', health_status: 'down', host_ip: '10.20.0.32', ports: [8081], managed_by: 'systemd-user', registry_path: 'services/render-farm.md', pitfalls_summary: 'Start it through Control on :8081.', drift_reasons: ['probe failed: connect refused'] },
      { id: 'proj-migration', kind: 'project', label: 'pve8-migration', stratum: 3, parent_id: 'vm-101-ops', drift_status: 'doc_only', health_status: 'unknown', project_path: '/srv/migration' },
      { id: 'agent-hermes', kind: 'agent', label: 'hermes', stratum: 4, drift_status: 'matched', health_status: 'up' },
      { id: 'cron-backups', kind: 'cron', label: 'nightly-backups', stratum: 4, parent_id: 'agent-hermes', drift_status: 'matched', health_status: 'up' },
      { id: 'mdl-gpt-bridge', kind: 'model_endpoint', label: 'gpt-bridge', stratum: 4, drift_status: 'matched', health_status: 'up' },
      { id: 'srv-old-sandbox', kind: 'server', label: 'retired-sandbox', stratum: 1, drift_status: 'doc_only', health_status: 'unknown', registry_path: 'servers/old-sandbox.md', doc_state: { status: 'removed' } }
    ],
    edges: [
      { source_id: 'srv-pve', target_id: 'vm-101-ops', relation: 'hosts' },
      { source_id: 'srv-pve', target_id: 'lxc-202-cache', relation: 'hosts' },
      { source_id: 'srv-pve', target_id: 'ct-redis', relation: 'hosts' },
      { source_id: 'vm-101-ops', target_id: 'svc-render', relation: 'hosts' },
      { source_id: 'lxc-202-cache', target_id: 'svc-gateway', relation: 'hosts' },
      { source_id: 'vm-101-ops', target_id: 'proj-migration', relation: 'hosts' },
      { source_id: 'agent-hermes', target_id: 'cron-backups', relation: 'hosts' },
      { source_id: 'agent-hermes', target_id: 'mdl-gpt-bridge', relation: 'uses_model' },
      { source_id: 'cron-backups', target_id: 'svc-gateway', relation: 'monitors' },
      { source_id: 'svc-gateway', target_id: 'ct-redis', relation: 'depends_on' }
    ],
    incidents: [{ id: 7, node_id: 'svc-render', node_label: 'render-farm', status: 'open', trigger_error: 'connect refused 10.20.0.32:8081', opened_at: 1794000000, attempts: 1 }],
    counts: { matched: 9, changed: 1, unregistered: 1, stale: 1, observed: 1, doc_only: 2, total: 14 },
    fleet: { monitored_nodes: 11, down_nodes: 1, avg_uptime_24h_pct: 98.6 },
    last_sweep: { sweep_id: 'sw-1', finished_at: 1794000100, duration_ms: 900 },
    activity: [{ ts: 1794000000, session_id: 's1', tool_name: 'terminal', node_id: 'svc-render', action_kind: 'touch_blocked', blocked: 1, summary: 'ssh root@10.20.0.32' }],
    config: { guardrail_mode: 'block', auto_heal_mode: 'auto' }
  },
  node: {
    node: {
      id: 'lxc-202-cache', kind: 'lxc', label: 'cache-tank', stratum: 2,
      drift_status: 'changed', health_status: 'up', host_ip: '10.20.0.22', ports: [6379],
      managed_by: 'proxmox', registry_path: 'servers/cache-tank.md',
      doc_state: { host_ip: '10.20.0.30', ports: [6379] },
      live_state: { host_ip: '10.20.0.22', ports: [6379] },
      drift_reasons: ['host_ip: registry says 10.20.0.30, live is 10.20.0.22'],
      uptime_24h_pct: 99.4, latency_ms: 12, pitfalls_summary: 'Dial 10.20.0.22:6379 directly.'
    },
    diff: [{ field: 'host_ip', doc: '10.20.0.30', live: '10.20.0.22', state: 'changed' }],
    blast_radius: { upstream: [{ id: 'srv-pve', label: 'pve-one', kind: 'server' }], downstream: [{ id: 'svc-gateway', label: 'edge-gateway', kind: 'service' }] },
    probe_history: [{ ts: 1794000000, status: 'up', latency_ms: 12 }, { ts: 1793999700, status: 'up', latency_ms: 15 }],
    incidents: [{ id: 3, status: 'resolved', trigger_error: 'timeout', opened_at: 1793900000, closed_at: 1793900300 }],
    registry_markdown: '# cache-tank\n\nDial 10.20.0.22:6379 directly.',
    guardrail: { unlocked: false }
  }
}

export const useQuery = options => {
  const key = Array.isArray(options?.queryKey) ? options.queryKey : []
  const data = key[1] === 'node' ? FIXTURE.node : FIXTURE.graph
  return { data, isLoading: false, isPending: false, error: null, refetch: async () => data }
}

export const host = {
  navigate: () => {},
  notify: () => {},
  onEvent: () => () => {},
  request: async () => ({ ok: true }),
  state: { focusedSessionId: { get: () => 'session-render' } },
  composer: { submit: () => {}, setDraft: () => {}, focus: () => {} }
}
