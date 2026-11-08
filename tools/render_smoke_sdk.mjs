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
      { id: 'srv-realm', kind: 'server', label: 'realm-pve', stratum: 1, drift_status: 'matched', health_status: 'up', host_ip: '10.0.0.150', ports: [8006], managed_by: 'proxmox', registry_path: 'servers/realm-pve.md' },
      { id: 'lxc-201-litellm', kind: 'lxc', label: 'litellm-gateway', stratum: 2, drift_status: 'changed', health_status: 'up', host_ip: '10.0.0.212', ports: [4000], managed_by: 'proxmox', registry_path: 'services/litellm.md', drift_reasons: ['host_ip: registry says 10.0.0.143, live is 10.0.0.212'] },
      { id: 'svc-wazuh', kind: 'service', label: 'wazuh', stratum: 3, drift_status: 'unregistered', health_status: 'up', host_ip: '10.0.0.218', ports: [443], managed_by: 'docker', drift_reasons: ['alive, no registry entry'] },
      { id: 'svc-llama-dashboard', kind: 'service', label: 'llama-dashboard', stratum: 3, drift_status: 'stale', health_status: 'down', host_ip: '10.0.0.143', ports: [8081], managed_by: 'systemd-user', registry_path: 'services/llama-dashboard.md', pitfalls_summary: 'Start it through Control on :8081.', drift_reasons: ['probe failed: connect refused'] },
      { id: 'agent-bossagent', kind: 'agent', label: 'bossagent', stratum: 4, drift_status: 'matched', health_status: 'up' }
    ],
    edges: [
      { source: 'srv-realm', target: 'lxc-201-litellm', relation: 'runs' },
      { source: 'lxc-201-litellm', target: 'svc-llama-dashboard', relation: 'serves' },
      { source: 'agent-bossagent', target: 'svc-llama-dashboard', relation: 'manages' }
    ],
    incidents: [{ id: 7, node_id: 'svc-llama-dashboard', status: 'open', trigger_error: 'connect refused 127.0.0.1:8081', opened_at: 1794000000, attempts: 1 }],
    counts: { matched: 2, changed: 1, unregistered: 1, stale: 1, doc_only: 0, total: 5 },
    fleet: { monitored_nodes: 5, down_nodes: 1, avg_uptime_24h_pct: 98.6 },
    last_sweep: { sweep_id: 'sw-1', finished_at: 1794000100, duration_ms: 900 },
    activity: [{ ts: 1794000000, session_id: 's1', tool_name: 'terminal', node_id: 'svc-llama-dashboard', action_kind: 'touch_blocked', blocked: 1, summary: 'ssh root@10.0.0.143' }],
    config: { guardrail_mode: 'block', auto_heal_mode: 'auto' }
  },
  node: {
    node: {
      id: 'lxc-201-litellm', kind: 'lxc', label: 'litellm-gateway', stratum: 2,
      drift_status: 'changed', health_status: 'up', host_ip: '10.0.0.212', ports: [4000],
      managed_by: 'proxmox', registry_path: 'services/litellm.md',
      doc_state: { host_ip: '10.0.0.143', ports: [4000] },
      live_state: { host_ip: '10.0.0.212', ports: [4000] },
      drift_reasons: ['host_ip: registry says 10.0.0.143, live is 10.0.0.212'],
      uptime_24h_pct: 99.4, latency_ms: 12, pitfalls_summary: 'Dial 10.0.0.212:4000 directly.'
    },
    diff: [{ field: 'host_ip', doc: '10.0.0.143', live: '10.0.0.212', state: 'changed' }],
    blast_radius: { upstream: [{ id: 'srv-realm', label: 'realm-pve', kind: 'server' }], downstream: [{ id: 'svc-llama-dashboard', label: 'llama-dashboard', kind: 'service' }] },
    probes: [{ ts: 1794000000, ok: 1, latency_ms: 12 }, { ts: 1793999700, ok: 1, latency_ms: 15 }],
    incidents: [{ id: 3, status: 'resolved', trigger_error: 'timeout', opened_at: 1793900000, closed_at: 1793900300 }],
    uptime: { uptime_24h_pct: 99.4, samples: 240 },
    registry_markdown: '# LiteLLM\n\nDial 10.0.0.212:4000 directly.',
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
