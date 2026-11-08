// Dev-only preview server for the isometric desktop scene.
//
//   node tools/iso_preview.mjs [port]        # default 8377, then open the URL
//
// Serves desktop/plugin.js against a browser stub of @hermes/plugin-sdk and
// mounts the real page with react-dom. ?fleet=stub (default) uses the render
// smoke fixture; ?fleet=demo loads the sanitized 22-node demo fleet. The
// control panel can fire guardrail pulses so the animations can be inspected.
// React itself is loaded from esm.sh via an import map — no build step.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FIXTURE } from './render_smoke_sdk.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2]) || 8377

const REACT_VERSION = '19.2.7'

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Infra Atlas — isometric preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #12151d; color: #e5e9f0;
    font-family: ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #root { position: absolute; inset: 0 0 52px 0; }
  #panel { position: fixed; left: 0; right: 0; bottom: 0; height: 52px; display: flex;
    align-items: center; gap: 8px; padding: 0 14px; background: #171b26;
    border-top: 1px solid rgba(128,128,140,.25); font-size: 12px; z-index: 10; }
  #panel button, #panel a { background: rgba(128,128,140,.14); color: inherit; border: 1px solid rgba(128,128,140,.3);
    border-radius: 7px; padding: 4px 10px; font-size: 11px; cursor: pointer; text-decoration: none; }
  #panel .lbl { color: #8b93a5; }
  #panel .spacer { flex: 1; }
  #panel .danger { border-color: #ef4444; color: #ef4444; }
</style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@${REACT_VERSION}",
    "react/jsx-runtime": "https://esm.sh/react@${REACT_VERSION}/jsx-runtime",
    "react-dom/client": "https://esm.sh/react-dom@${REACT_VERSION}/client",
    "@hermes/plugin-sdk": "/sdk.mjs"
  }
}
</script>
</head>
<body>
<div id="root"></div>
<div id="panel">
  <span class="lbl">iso preview</span>
  <button data-pulse="touch_blocked" class="danger">⛔ pulse: blocked</button>
  <button data-pulse="touch_allowed">✅ pulse: allowed</button>
  <button data-pulse="read_doc">📖 pulse: read</button>
  <span class="spacer"></span>
  <span class="lbl">fleet:</span>
  <a href="?fleet=stub">stub</a>
  <a href="?fleet=demo">demo (22 nodes)</a>
  <a href="?fleet=single">single</a>
  <a href="?fleet=flat">flat (no terraces)</a>
</div>
<script type="module">
  window.__atlasErrors = []
  window.addEventListener('error', e => window.__atlasErrors.push(String(e.message)))
  window.addEventListener('unhandledrejection', e => window.__atlasErrors.push('reject: ' + String(e.reason)))

  const fail = message => {
    const el = document.getElementById('root')
    if (el && !el.innerHTML.trim()) {
      el.innerHTML = '<pre style="padding:24px;color:#f87171;font-size:12px;white-space:pre-wrap">' + message + '</pre>'
    }
  }

  try {
    const { createRoot } = await import('react-dom/client')
    const plugin = (await import('/plugin.mjs')).default

    const surfaces = []
    plugin.register({
      rest: async () => ({}),
      storage: { get: async () => null, set: async () => {}, delete: async () => {} },
      onEvent: () => () => {},
      registerMany: list => { surfaces.push(...list); return () => {} },
      register: item => { surfaces.push(item); return () => {} }
    })
    const page = surfaces.find(s => s.id === 'page')
    createRoot(document.getElementById('root')).render(page.render({}))
    setTimeout(() => fail('page mounted but rendered nothing — errors: ' + window.__atlasErrors.join(' | ')), 5000)
  } catch (e) {
    fail('preview failed to load: ' + (e && e.stack ? e.stack : String(e)))
  }

  const pulse = kind => {
    const nodes = window.__atlasNodes || []
    if (!nodes.length) return
    const node = nodes[Math.floor(Math.random() * nodes.length)]
    window.__atlasEmit({ payload: { node_id: node.id, action_kind: kind, tool_name: 'terminal', ts: Date.now() / 1000 } })
  }
  document.querySelectorAll('[data-pulse]').forEach(btn => { btn.addEventListener('click', () => pulse(btn.dataset.pulse)) })
</script>
</body>
</html>`

const SDK = `
import * as React from 'react'

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const PALETTE_AREA = 'palette'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript-directive'
export const STATUSBAR_AREAS = { left: 'statusbar-left', right: 'statusbar-right' }

export const cn = (...parts) => parts.filter(Boolean).join(' ')

const listeners = []
export const host = {
  navigate: () => {},
  notify: () => {},
  onEvent: (topic, fn) => { listeners.push(fn); return () => {} },
  request: async () => ({ ok: true }),
  state: { focusedSessionId: { get: () => 'preview' } },
  composer: { submit: () => {}, setDraft: () => {}, focus: () => {} }
}
window.__atlasEmit = frame => { listeners.slice().forEach(fn => { try { fn(frame) } catch {} }) }

const cache = new Map()

export function useQuery(options) {
  const key = (options && options.queryKey) || []
  const cacheKey = JSON.stringify(key)
  const [state, setState] = React.useState(() => cache.get(cacheKey) || { data: undefined, isLoading: true, error: null })
  const refetch = React.useCallback(async () => {
    if (key[1] === 'node') {
      // the preview only serves the graph fixture; keep node detail empty-ish
      setState(current => ({ ...current, data: current.data || { node: null }, isLoading: false }))
      return state
    }
    try {
      const response = await fetch('/fixture.json' + window.location.search)
      const data = await response.json()
      cache.set(cacheKey, { data, isLoading: false, error: null })
      window.__atlasNodes = data.nodes || []
      setState({ data, isLoading: false, error: null })
      return { data }
    } catch (error) {
      setState({ data: undefined, isLoading: false, error })
      return { data: undefined, error }
    }
  }, [cacheKey])
  React.useEffect(() => { void refetch() }, [refetch])
  return { ...state, refetch }
}
`

function countsOf(nodes) {
  const counts = { matched: 0, changed: 0, unregistered: 0, stale: 0, observed: 0, doc_only: 0, total: nodes.length }
  nodes.forEach(node => {
    if (counts[node.drift_status] !== undefined) counts[node.drift_status] += 1
  })
  return counts
}

async function demoFleet() {
  const raw = JSON.parse(await readFile(join(here, '..', 'fixtures', 'sample_fleet.json'), 'utf8'))
  return {
    nodes: raw.nodes || [],
    edges: raw.edges || [],
    incidents: raw.incidents || [],
    counts: countsOf(raw.nodes || []),
    fleet: { monitored_nodes: (raw.nodes || []).length, down_nodes: (raw.incidents || []).length, avg_uptime_24h_pct: 99 },
    last_sweep: null,
    config: { guardrail_mode: 'block', auto_heal_mode: 'auto', demo_mode: true },
    activity: []
  }
}

// tiny synthetic fleets for the degenerate cases the renderer must survive
const singleFleet = () => ({
  nodes: [{ id: 'srv-solo', kind: 'server', label: 'solo-host', stratum: 1, drift_status: 'matched', health_status: 'up', host_ip: '10.20.0.9' }],
  edges: [],
  incidents: [],
  counts: countsOf([{ drift_status: 'matched' }]),
  fleet: { monitored_nodes: 1 },
  last_sweep: null,
  config: { guardrail_mode: 'block', auto_heal_mode: 'auto' },
  activity: []
})

const flatFleet = () => {
  const nodes = [1, 2, 3, 4, 5, 6].map(i => ({
    id: `svc-flat-${i}`,
    kind: i % 2 ? 'service' : 'container',
    label: `flat-${i}`,
    stratum: 3,
    drift_status: 'matched',
    health_status: 'up',
    host_ip: `10.20.1.${i}`
  }))
  return {
    nodes,
    edges: [
      { source_id: 'svc-flat-1', target_id: 'svc-flat-2', relation: 'depends_on' },
      { source_id: 'svc-flat-1', target_id: 'svc-flat-4', relation: 'depends_on' },
      { source_id: 'svc-flat-1', target_id: 'svc-flat-6', relation: 'depends_on' },
      { source_id: 'svc-flat-3', target_id: 'svc-flat-5', relation: 'monitors' },
      { source_id: 'svc-flat-5', target_id: 'svc-flat-6', relation: 'depends_on' }
    ],
    incidents: [],
    counts: countsOf(nodes),
    fleet: { monitored_nodes: nodes.length },
    last_sweep: null,
    config: { guardrail_mode: 'block', auto_heal_mode: 'auto' },
    activity: []
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }
    if (url.pathname === '/sdk.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(SDK)
      return
    }
    if (url.pathname === '/plugin.mjs') {
      const source = await readFile(join(here, '..', 'desktop', 'plugin.js'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(source)
      return
    }
    if (url.pathname === '/fixture.json') {
      const fleet = url.searchParams.get('fleet')
      const graph =
        fleet === 'demo' ? await demoFleet()
          : fleet === 'single' ? singleFleet()
            : fleet === 'flat' ? flatFleet()
              : FIXTURE.graph
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(graph))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(error && error.stack ? error.stack : error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`iso preview → http://127.0.0.1:${port}/?fleet=stub  (or ?fleet=demo)`)
})
