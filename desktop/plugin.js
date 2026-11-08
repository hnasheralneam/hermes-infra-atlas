/**
 * Infra Atlas — full-page infrastructure graph for Hermes Desktop.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls (no JSX syntax). Only
 * @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 *
 * The page reads /api/plugins/infra-atlas/* through ctx.rest and subscribes to
 * `plugin.infra-atlas.*` events for live activity, sweeps and incidents.
 */

import { cn, host, STATUSBAR_AREAS, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, TRANSCRIPT_DIRECTIVE_AREA, useQuery } from '@hermes/plugin-sdk'
import * as React from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const ID = 'infra-atlas'
const PAGE_PATH = '/infra-atlas'

let API = null // ctx, kept for ctx.rest / ctx.storage
let pendingSelect = null

const DRIFT_ORDER = ['changed', 'unregistered', 'stale', 'matched', 'doc_only']
const DRIFT_LABEL = {
  matched: 'matched',
  changed: 'drift',
  unregistered: 'unregistered',
  stale: 'stale',
  doc_only: 'doc only'
}
const HEALTH_COLOR = {
  up: 'var(--ui-success, #10b981)',
  degraded: 'var(--ui-warning, #f59e0b)',
  down: 'var(--ui-danger, #ef4444)',
  unknown: 'var(--ui-text-quaternary, #6b7280)'
}
const DRIFT_COLOR = {
  matched: 'var(--ui-success, #10b981)',
  changed: 'var(--ui-warning, #f59e0b)',
  unregistered: 'var(--ui-info, #06b6d4)',
  stale: 'var(--ui-danger, #ef4444)',
  doc_only: 'var(--ui-text-quaternary, #6b7280)'
}

// ── helpers ────────────────────────────────────────────────────────────────
const rest = (path, options) => {
  if (!API) return Promise.reject(new Error('plugin not ready'))
  return API.rest(path, options)
}

const pct = value => (value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`)
const ago = ts => {
  if (!ts) return 'never'
  const delta = Math.max(0, Date.now() / 1000 - Number(ts))
  if (delta < 90) return `${Math.round(delta)}s ago`
  if (delta < 5400) return `${Math.round(delta / 60)}m ago`
  if (delta < 172800) return `${Math.round(delta / 3600)}h ago`
  return `${Math.round(delta / 86400)}d ago`
}
const addressOf = node => {
  const ip = node.host_ip || node.tailnet_ip
  const port = (node.ports || [])[0]
  if (!ip && !port) return ''
  return port ? `${ip || '—'}:${port}` : ip
}

function useGraph(interval = 10000) {
  return useQuery({
    queryKey: ['infra-atlas', 'graph'],
    queryFn: () => rest('/graph'),
    refetchInterval: interval,
    staleTime: 4000
  })
}

function useNode(nodeId) {
  return useQuery({
    queryKey: ['infra-atlas', 'node', nodeId],
    queryFn: () => rest(`/node/${encodeURIComponent(nodeId)}`),
    enabled: Boolean(nodeId),
    staleTime: 4000
  })
}

// ── layout ─────────────────────────────────────────────────────────────────
function layoutNodes(nodes) {
  const byStratum = new Map()
  nodes.forEach(node => {
    const stratum = Number(node.stratum || 3)
    if (!byStratum.has(stratum)) byStratum.set(stratum, [])
    byStratum.get(stratum).push(node)
  })
  const strata = Array.from(byStratum.keys()).sort((a, b) => a - b)
  const positioned = new Map()
  const width = 1220
  const rowHeight = 168
  strata.forEach((stratum, rowIndex) => {
    const row = byStratum.get(stratum).sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)))
    const columns = Math.max(1, Math.min(row.length, 6))
    const rows = Math.ceil(row.length / columns)
    row.forEach((node, index) => {
      const column = index % columns
      const line = Math.floor(index / columns)
      const cellWidth = width / columns
      positioned.set(node.id, {
        node,
        x: cellWidth * column + cellWidth / 2,
        y: rowIndex * (rowHeight + Math.min(rows, 3) * 74) + line * 74 + 70
      })
    })
  })
  const height = Math.max(520, strata.length * (rowHeight + 40) + 80)
  return { positioned, width, height, strata }
}

// ── page ───────────────────────────────────────────────────────────────────
function InfraAtlasPage() {
  const [selectedId, setSelectedId] = React.useState(pendingSelect)
  const [filter, setFilter] = React.useState('all')
  const [search, setSearch] = React.useState('')
  const [activity, setActivity] = React.useState([])
  const [pulses, setPulses] = React.useState({})
  const [busy, setBusy] = React.useState('')

  const { data, isLoading, error, refetch } = useGraph(10000)

  React.useEffect(() => {
    pendingSelect = null
  }, [])

  React.useEffect(() => {
    if (!API) return undefined
    const disposers = [
      host.onEvent('plugin.infra-atlas.activity', frame => {
        const payload = (frame && frame.payload) || frame || {}
        if (!payload.node_id) return
        setPulses(current => ({
          ...current,
          [payload.node_id]: { kind: payload.action_kind, at: Date.now(), tool: payload.tool_name }
        }))
        setActivity(current => [{ ...payload, ts: payload.ts || Date.now() / 1000, live: true }, ...current].slice(0, 40))
      }),
      host.onEvent('plugin.infra-atlas.sweep.completed', () => void refetch()),
      host.onEvent('plugin.infra-atlas.incident.opened', frame => {
        const payload = (frame && frame.payload) || {}
        host.notify({ kind: 'warning', message: `Infra Atlas: ${payload.node_id || 'a node'} is down` })
        void refetch()
      }),
      host.onEvent('plugin.infra-atlas.incident.resolved', frame => {
        const payload = (frame && frame.payload) || {}
        host.notify({ kind: 'info', message: `Infra Atlas: ${payload.node_id || 'node'} recovered` })
        void refetch()
      }),
      host.onEvent('plugin.infra-atlas.node.updated', () => void refetch())
    ]
    return () => disposers.forEach(dispose => dispose && dispose())
  }, [refetch])

  const nodes = (data && data.nodes) || []
  const edges = (data && data.edges) || []
  const counts = (data && data.counts) || {}
  const incidents = (data && data.incidents) || []
  const config = (data && data.config) || {}

  const visible = nodes.filter(node => {
    if (filter !== 'all' && node.drift_status !== filter) return false
    if (!search.trim()) return true
    const needle = search.trim().toLowerCase()
    return [node.id, node.label, node.host_ip, node.tailnet_ip, node.systemd_unit, (node.ports || []).join(' ')]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(needle))
  })

  const selected = visible.find(node => node.id === selectedId) || nodes.find(node => node.id === selectedId) || null

  const runAction = async (label, fn) => {
    setBusy(label)
    try {
      await fn()
      await refetch()
    } catch (err) {
      host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
    } finally {
      setBusy('')
    }
  }

  const sweep = () =>
    runAction('sweep', async () => {
      const summary = await rest('/sweep', { method: 'POST', body: {} })
      host.notify({
        kind: 'info',
        message: `Sweep ${summary.sweep_id}: ${summary.counts ? summary.counts.matched : 0} matched, ${
          summary.counts ? summary.counts.changed + summary.counts.unregistered + summary.counts.stale : 0
        } need attention`
      })
    })

  const toggleSetting = (key, value) =>
    runAction(key, async () => {
      // Persist through the public plugins RPC (the agent half reads the same settings),
      // then ask the backend to reload the data source the toggle affects.
      await host.request('plugins.manage', { action: 'settings', key: ID, values: { [key]: value } })
      await rest('/settings', { method: 'POST', body: { [key]: value } })
    })

  const nodePulse = nodeId => {
    const pulse = pulses[nodeId]
    if (!pulse) return null
    if (Date.now() - pulse.at > 8000) return null
    return pulse.kind
  }

  return jsxs('div', {
    className: 'ia-root',
    children: [
      jsx('style', { children: CSS }),
      jsxs('div', {
        className: 'ia-header',
        children: [
          jsxs('div', {
            className: 'ia-title',
            children: [
              jsx('span', { className: 'ia-globe', children: '◉' }),
              jsx('span', { children: 'Infra Atlas' }),
              jsx('span', { className: 'ia-sub', children: config.registry_path || '' })
            ]
          }),
          jsxs('div', {
            className: 'ia-pills',
            children: [
              pill('all', `All (${counts.total || 0})`, filter, setFilter),
              pill('matched', `Matched (${counts.matched || 0})`, filter, setFilter, DRIFT_COLOR.matched),
              pill('changed', `Changed (${counts.changed || 0})`, filter, setFilter, DRIFT_COLOR.changed),
              pill('unregistered', `Unregistered (${counts.unregistered || 0})`, filter, setFilter, DRIFT_COLOR.unregistered),
              pill('stale', `Stale (${counts.stale || 0})`, filter, setFilter, DRIFT_COLOR.stale),
              incidents.length
                ? jsx('span', {
                    className: 'ia-pill ia-pill-incident',
                    children: `Incidents (${incidents.length})`
                  })
                : null
            ]
          }),
          jsxs('div', {
            className: 'ia-controls',
            children: [
              jsx('input', {
                className: 'ia-search',
                placeholder: 'Search nodes, IPs, ports…',
                value: search,
                onChange: event => setSearch(event.target.value)
              }),
              select('Guardrail', config.guardrail_mode, ['block', 'warn', 'off'], value =>
                toggleSetting('guardrail_mode', value)
              ),
              select('Auto-heal', config.auto_heal_mode, ['auto', 'playbook_only', 'notify_only', 'off'], value =>
                toggleSetting('auto_heal_mode', value)
              ),
              jsx('button', {
                type: 'button',
                className: cn('ia-btn', config.demo_mode && 'ia-btn-on'),
                onClick: () => toggleSetting('demo_mode', !config.demo_mode),
                children: config.demo_mode ? 'Demo fleet' : 'Live fleet'
              }),
              jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-primary',
                disabled: busy === 'sweep',
                onClick: sweep,
                children: busy === 'sweep' ? 'Sweeping…' : '↻ Sweep now'
              })
            ]
          })
        ]
      }),

      incidents.length ? IncidentStrip({ incidents, onHeal: nodeId => healNode(nodeId, setBusy, refetch) }) : null,

      jsxs('div', {
        className: 'ia-body',
        children: [
          jsx('div', {
            className: 'ia-canvas',
            children: error
              ? jsx('div', { className: 'ia-empty', children: `Could not load the graph: ${error.message || error}` })
              : isLoading && !nodes.length
                ? jsx('div', { className: 'ia-empty', children: 'Loading infrastructure graph…' })
                : nodes.length
                  ? Topology({ nodes: visible, edges, selectedId, onSelect: setSelectedId, pulseFor: nodePulse })
                  : jsx('div', {
                      className: 'ia-empty',
                      children:
                        'No nodes yet. Run a sweep, or switch on the demo fleet to see the graph populated with a sanitized fleet.'
                    })
          }),
          jsx(Inspector, {
            node: selected,
            busy,
            onClose: () => setSelectedId(null),
            onRefetch: refetch,
            setBusy,
            guardrail: config.guardrail_mode
          })
        ]
      }),

      jsx(ActivityStream, { entries: activity.length ? activity : (data && data.activity) || [], incidents })
    ]
  })
}

function pill(key, label, active, setActive, color) {
  return jsx('button', {
    type: 'button',
    className: cn('ia-pill', active === key && 'ia-pill-active'),
    style: color ? { borderColor: active === key ? color : 'transparent' } : undefined,
    onClick: () => setActive(active === key ? 'all' : key),
    children: label
  })
}

function select(label, value, options, onChange) {
  return jsxs('label', {
    className: 'ia-select',
    children: [
      jsx('span', { children: label }),
      jsx('select', {
        value: value || options[0],
        onChange: event => onChange(event.target.value),
        children: options.map(option => jsx('option', { value: option, children: option }, option))
      })
    ]
  })
}

// ── topology ───────────────────────────────────────────────────────────────
function Topology({ nodes, edges, selectedId, onSelect, pulseFor }) {
  const { positioned, width, height } = React.useMemo(() => layoutNodes(nodes), [nodes])
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const dragRef = React.useRef(null)

  const viewBox = `${-offset.x} ${-offset.y} ${width / zoom} ${height / zoom}`

  const onPointerDown = event => {
    if (event.target && event.target.dataset && event.target.dataset.nodeId) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = event => {
    if (!dragRef.current) return
    const dx = (event.clientX - dragRef.current.x) / zoom
    const dy = (event.clientY - dragRef.current.y) / zoom
    setOffset({ x: dragRef.current.ox - dx, y: dragRef.current.oy - dy })
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  return jsxs('div', {
    className: 'ia-graph-wrap',
    children: [
      jsxs('div', {
        className: 'ia-zoom',
        children: [
          jsx('button', { type: 'button', onClick: () => setZoom(z => Math.min(2.2, z * 1.2)), children: '+' }),
          jsx('button', { type: 'button', onClick: () => setZoom(z => Math.max(0.5, z / 1.2)), children: '−' }),
          jsx('button', {
            type: 'button',
            onClick: () => {
              setZoom(1)
              setOffset({ x: 0, y: 0 })
            },
            children: '⤢'
          })
        ]
      }),
      jsxs('svg', {
        className: 'ia-svg',
        viewBox,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerLeave: onPointerUp,
        children: [
          jsx('defs', {
            children: jsx('marker', {
              id: 'ia-arrow',
              viewBox: '0 0 10 10',
              refX: '9',
              refY: '5',
              markerWidth: '6',
              markerHeight: '6',
              orient: 'auto-start-reverse',
              children: jsx('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--ui-text-quaternary, #6b7280)' })
            })
          }),
          edges.map((edge, index) => {
            const from = positioned.get(edge.source_id)
            const to = positioned.get(edge.target_id)
            if (!from || !to) return null
            const midY = (from.y + to.y) / 2
            const path = `M ${from.x} ${from.y + 22} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y - 24}`
            return jsx('path', {
              d: path,
              className: cn('ia-edge', `ia-edge-${edge.relation}`),
              markerEnd: 'url(#ia-arrow)',
              key: `edge-${index}`
            })
          }),
          nodes.map(node => {
            const position = positioned.get(node.id)
            if (!position) return null
            const pulse = pulseFor(node.id)
            return React.cloneElement(NodeCard({
              node,
              x: position.x,
              y: position.y,
              active: node.id === selectedId,
              pulse,
              onSelect
            }), { key: node.id })
          })
        ]
      })
    ]
  })
}

function NodeCard({ node, x, y, active, pulse, onSelect }) {
  const drift = node.drift_status || 'matched'
  const color = DRIFT_COLOR[drift] || DRIFT_COLOR.matched
  const health = node.health_status || 'unknown'
  const width = 152
  return jsxs('g', {
    className: cn('ia-node', active && 'ia-node-active', pulse && `ia-pulse-${pulse}`),
    transform: `translate(${x - width / 2}, ${y - 24})`,
    'data-node-id': node.id,
    onClick: event => {
      event.stopPropagation()
      onSelect(node.id)
    },
    children: [
      jsx('rect', {
        width,
        height: 52,
        rx: 9,
        className: 'ia-node-rect',
        stroke: color,
        strokeWidth: active ? 2.2 : 1.3,
        'data-node-id': node.id
      }),
      jsx('circle', { cx: 13, cy: 15, r: 4.2, fill: HEALTH_COLOR[health] || HEALTH_COLOR.unknown, 'data-node-id': node.id }),
      jsx('text', { x: 24, y: 19, className: 'ia-node-title', 'data-node-id': node.id, children: truncate(node.label || node.id, 19) }),
      jsx('text', { x: 12, y: 35, className: 'ia-node-sub', 'data-node-id': node.id, children: addressOf(node) || node.kind || '' }),
      node.uptime_24h_pct !== null && node.uptime_24h_pct !== undefined
        ? jsx('text', {
            x: 12,
            y: 47,
            className: 'ia-node-sub',
            'data-node-id': node.id,
            children: `${pct(node.uptime_24h_pct)} up${node.latency_ms ? ` · ${Math.round(node.latency_ms)}ms` : ''}`
          })
        : null,
      drift !== 'matched'
        ? jsx('text', { x: width - 10, y: 19, textAnchor: 'end', className: 'ia-node-badge', fill: color, 'data-node-id': node.id, children: DRIFT_LABEL[drift] })
        : null,
      pulse
        ? jsx('circle', { cx: width / 2, cy: 26, r: 34, className: `ia-ring ia-ring-${pulse}`, fill: 'none', stroke: pulseColor(pulse), strokeWidth: 1.6 })
        : null
    ]
  })
}

const pulseColor = kind =>
  kind === 'touch_blocked'
    ? 'var(--ui-danger, #ef4444)'
    : kind === 'touch_allowed'
      ? 'var(--ui-success, #10b981)'
      : kind === 'touch_warned'
        ? 'var(--ui-warning, #f59e0b)'
        : 'var(--ui-info, #06b6d4)'

const truncate = (text, limit) => {
  const value = String(text || '')
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

// ── incident strip ─────────────────────────────────────────────────────────
function IncidentStrip({ incidents, onHeal }) {
  const primary = incidents[0]
  if (!primary) return null
  return jsxs('div', {
    className: 'ia-incident',
    children: [
      jsx('span', { className: 'ia-incident-icon', children: '🚨' }),
      jsxs('div', {
        className: 'ia-incident-body',
        children: [
          jsxs('div', {
            className: 'ia-incident-title',
            children: [
              jsx('strong', { children: `Incident #${primary.id}: ${primary.node_label}` }),
              jsx('span', { className: 'ia-incident-state', children: primary.status }),
              incidents.length > 1 ? jsx('span', { className: 'ia-incident-more', children: `+${incidents.length - 1} more` }) : null
            ]
          }),
          jsx('div', { className: 'ia-incident-detail', children: primary.trigger_error || '' }),
          primary.root_cause_hint ? jsx('div', { className: 'ia-incident-hint', children: primary.root_cause_hint }) : null
        ]
      }),
      jsxs('div', {
        className: 'ia-incident-actions',
        children: [
          jsx('button', {
            type: 'button',
            className: 'ia-btn',
            onClick: () => onHeal(primary.node_id),
            children: '⚡ Run playbook'
          }),
          jsx('button', {
            type: 'button',
            className: 'ia-btn ia-btn-primary',
            onClick: () => {
              pendingSelect = primary.node_id
              host.navigate(PAGE_PATH)
            },
            children: 'Open node'
          })
        ]
      })
    ]
  })
}

async function healNode(nodeId, setBusy, refetch) {
  setBusy(`heal:${nodeId}`)
  try {
    const outcome = await rest('/heal', { method: 'POST', body: { node_id: nodeId } })
    host.notify({
      kind: outcome.ok ? 'info' : 'warning',
      message: outcome.ok
        ? `Healed ${nodeId} via ${outcome.command} (${outcome.status})`
        : `${nodeId}: ${outcome.reason || outcome.detail || 'heal did not succeed'}`
    })
    await refetch()
  } catch (err) {
    host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
  } finally {
    setBusy('')
  }
}

// ── inspector ──────────────────────────────────────────────────────────────
function Inspector({ node, busy, onClose, onRefetch, setBusy, guardrail }) {
  const [tab, setTab] = React.useState('overview')
  const detail = useNode(node ? node.id : null)

  React.useEffect(() => {
    setTab('overview')
  }, [node && node.id])

  if (!node) {
    return jsxs('div', {
      className: 'ia-inspector ia-inspector-empty',
      children: [
        jsx('div', { className: 'ia-inspector-title', children: 'Inspector' }),
        jsx('div', {
          className: 'ia-muted',
          children: 'Select a node on the graph to see its registry entry, the live diff, uptime and recovery commands.'
        })
      ]
    })
  }

  const data = detail.data || {}
  const diff = data.diff || []
  const incidents = data.incidents || []
  const probes = data.probe_history || []
  const item = data.node || node
  const drift = item.drift_status || 'matched'

  const doReconcile = action =>
    healBusy(setBusy, `reconcile:${node.id}`, async () => {
      await rest('/reconcile', { method: 'POST', body: { node_id: node.id, action } })
      host.notify({ kind: 'info', message: `${item.id}: ${action.replace('_', ' ')} written to the registry` })
      await onRefetch()
      await detail.refetch()
    })

  const doUnlock = () =>
    healBusy(setBusy, `unlock:${node.id}`, async () => {
      const sessionId = host.state.focusedSessionId && host.state.focusedSessionId.get ? host.state.focusedSessionId.get() : null
      await rest('/session-unlock', { method: 'POST', body: { session_id: sessionId || 'desktop', node_id: node.id } })
      host.notify({ kind: 'info', message: `${item.id} unlocked for this session` })
    })

  const dispatchBrief = () =>
    healBusy(setBusy, `dispatch:${node.id}`, async () => {
      const brief = await rest('/heal', { method: 'POST', body: { node_id: node.id, mode: 'agent_brief' } })
      const sessionId = host.state.focusedSessionId && host.state.focusedSessionId.get ? host.state.focusedSessionId.get() : null
      const sent = host.composer.submit(sessionId ?? null, brief.remediation_brief)
      host.notify({
        kind: sent ? 'info' : 'warning',
        message: sent ? 'Incident brief sent to the active chat' : 'Open a chat to dispatch the brief'
      })
    })

  return jsxs('div', {
    className: 'ia-inspector',
    children: [
      jsxs('div', {
        className: 'ia-inspector-head',
        children: [
          jsxs('div', {
            children: [
              jsx('div', { className: 'ia-inspector-title', children: item.label || item.id }),
              jsxs('div', {
                className: 'ia-inspector-meta',
                children: [
                  jsx('span', { className: 'ia-tag', style: { borderColor: DRIFT_COLOR[drift] }, children: DRIFT_LABEL[drift] || drift }),
                  jsx('span', { className: 'ia-tag', style: { borderColor: HEALTH_COLOR[item.health_status] }, children: item.health_status || 'unknown' }),
                  jsx('span', { className: 'ia-muted', children: item.kind || '' }),
                  item.vmid ? jsx('span', { className: 'ia-muted', children: `vmid ${item.vmid}` }) : null
                ]
              })
            ]
          }),
          jsx('button', { type: 'button', className: 'ia-close', onClick: onClose, children: '✕' })
        ]
      }),
      jsxs('div', {
        className: 'ia-tabs',
        children: [
          tabButton('overview', 'Overview & diff', tab, setTab),
          tabButton('uptime', 'Uptime & auto-heal', tab, setTab),
          tabButton('runbook', 'Runbook', tab, setTab),
          tabButton('raw', 'Raw JSON', tab, setTab)
        ]
      }),
      jsxs('div', {
        className: 'ia-tab-body',
        children: [
          tab === 'overview' ? OverviewTab({ item, diff, guardrail, doReconcile, doUnlock, busy }) : null,
          tab === 'uptime'
            ? UptimeTab({ item, probes, incidents, busy, nodeId: node.id, setBusy, onRefetch, detail })
            : null,
          tab === 'runbook' ? RunbookTab({ item, markdown: data.registry_markdown, pitfalls: item.pitfalls_summary }) : null,
          tab === 'raw' ? RawTab({ data }) : null
        ]
      }),
      jsxs('div', {
        className: 'ia-inspector-foot',
        children: [
          jsx('button', {
            type: 'button',
            className: 'ia-btn',
            disabled: busy === `dispatch:${node.id}`,
            onClick: dispatchBrief,
            children: '🤖 Dispatch brief'
          }),
          jsx('button', {
            type: 'button',
            className: 'ia-btn',
            disabled: busy === `heal:${node.id}`,
            onClick: () => healNode(node.id, setBusy, onRefetch),
            children: '⚡ Heal'
          })
        ]
      })
    ]
  })
}

async function healBusy(setBusy, label, fn) {
  setBusy(label)
  try {
    await fn()
  } catch (err) {
    host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
  } finally {
    setBusy('')
  }
}

function tabButton(key, label, tab, setTab) {
  return jsx('button', {
    type: 'button',
    className: cn('ia-tab', tab === key && 'ia-tab-active'),
    onClick: () => setTab(key),
    children: label
  })
}

function OverviewTab({ item, diff, guardrail, doReconcile, doUnlock, busy }) {
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'ia-kv',
        children: [
          kv('id', item.id),
          kv('address', addressOf(item) || '—'),
          kv('tailnet', item.tailnet_ip || '—'),
          kv('managed by', item.managed_by || '—'),
          kv('unit', item.systemd_unit || '—'),
          kv('registry', item.registry_path || 'no entry'),
          kv('guardrail', guardrail),
          kv('last seen', ago(item.last_seen_live_at))
        ]
      }),
      (item.drift_reasons || []).length
        ? jsxs('div', {
            className: 'ia-block',
            children: [
              jsx('div', { className: 'ia-block-title', children: 'Drift evidence' }),
              jsx('ul', { className: 'ia-list', children: (item.drift_reasons || []).map((reason, index) => jsx('li', { children: reason }, `reason-${index}`)) })
            ]
          })
        : null,
      diff.length
        ? jsxs('div', {
            className: 'ia-block',
            children: [
              jsx('div', { className: 'ia-block-title', children: 'Registry vs live' }),
              jsx('table', {
                className: 'ia-table',
                children: [
                  jsx('thead', {
                    children: jsxs('tr', {
                      children: [jsx('th', { children: 'field' }), jsx('th', { children: 'registry' }), jsx('th', { children: 'live' })]
                    })
                  }),
                  jsx('tbody', {
                    children: diff.map((row, index) =>
                      jsxs('tr', { children: [jsx('td', { children: row.field }), jsx('td', { children: format(row.doc) }), jsx('td', { children: format(row.live) })] }, `diff-${index}`)
                    )
                  })
                ]
              }),
              jsxs('div', {
                className: 'ia-row',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: 'ia-btn ia-btn-primary',
                    disabled: Boolean(busy),
                    onClick: () => doReconcile('adopt_live'),
                    children: '✓ Adopt live into registry'
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'ia-btn',
                    disabled: Boolean(busy),
                    onClick: () => doReconcile('mark_removed'),
                    children: 'Mark removed'
                  })
                ]
              })
            ]
          })
        : jsx('div', { className: 'ia-block', children: jsx('div', { className: 'ia-muted', children: 'Registry and live state agree.' }) }),
      jsxs('div', {
        className: 'ia-row',
        children: [
          jsx('button', { type: 'button', className: 'ia-btn', disabled: Boolean(busy), onClick: doUnlock, children: '🔓 Unlock for this chat' }),
          item.registry_path
            ? jsx('button', {
                type: 'button',
                className: 'ia-btn',
                onClick: () => {
                  pendingSelect = item.id
                  host.navigate(PAGE_PATH)
                },
                children: '⊙ Focus on graph'
              })
            : null
        ]
      })
    ]
  })
}

function UptimeTab({ item, probes, incidents, busy, nodeId, setBusy, onRefetch, detail }) {
  const history = probes || []
  const max = Math.max(1, ...history.map(sample => Number(sample.latency_ms) || 0))
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'ia-stats',
        children: [
          stat('24h uptime', pct(item.uptime_24h_pct)),
          stat('latency', item.latency_ms ? `${Math.round(item.latency_ms)} ms` : '—'),
          stat('failures', String(item.failure_streak || 0)),
          stat('policy', item.auto_heal_policy || 'inherit')
        ]
      }),
      jsxs('div', {
        className: 'ia-block',
        children: [
          jsx('div', { className: 'ia-block-title', children: 'Recent probes' }),
          history.length
            ? jsx('div', {
                className: 'ia-spark',
                children: history.map((sample, index) =>
                  jsx('span', {
                    className: cn('ia-spark-bar', sample.status !== 'up' && 'ia-spark-down'),
                    style: { height: `${Math.max(6, Math.round(((Number(sample.latency_ms) || 0) / max) * 100))}%` },
                    title: `${sample.status} · ${sample.latency_ms ? Math.round(sample.latency_ms) + 'ms' : 'no latency'} · ${sample.detail || ''}`
                  }, `probe-${index}`)
                )
              })
            : jsx('div', { className: 'ia-muted', children: 'No probes recorded yet.' })
        ]
      }),
      jsxs('div', {
        className: 'ia-kv',
        children: [
          kv('recovery command', item.recovery_cmd || 'none (agent decides)'),
          kv('probe', (item.live_state && item.live_state.probe) || (item.doc_state && item.doc_state.probe) || 'none'),
          kv('last heal attempt', ago(item.last_heal_attempt_at))
        ]
      }),
      jsxs('div', {
        className: 'ia-block',
        children: [
          jsx('div', { className: 'ia-block-title', children: 'Incidents' }),
          incidents.length
            ? jsx('ul', {
                className: 'ia-list',
                children: incidents.map(incident =>
                  jsx('li', {
                    children: `#${incident.id} ${incident.status} — ${incident.trigger_error}${incident.resolution_summary ? ` → ${incident.resolution_summary}` : ''}`
                  }, `incident-${incident.id}`)
                )
              })
            : jsx('div', { className: 'ia-muted', children: 'No incidents recorded for this node.' })
        ]
      }),
      jsx('div', {
        className: 'ia-row',
        children: jsx('button', {
          type: 'button',
          className: 'ia-btn',
          disabled: Boolean(busy),
          onClick: () => healNode(nodeId, setBusy, async () => {
            await onRefetch()
            await detail.refetch()
          }),
          children: '⚡ Run recovery playbook'
        })
      })
    ]
  })
}

function RunbookTab({ item, markdown, pitfalls }) {
  if (!item.registry_path) {
    return jsx('div', {
      className: 'ia-block',
      children: jsx('div', {
        className: 'ia-muted',
        children: 'This node has no registry entry yet. Adopt it from the Overview tab to start its runbook.'
      })
    })
  }
  return jsxs(Fragment, {
    children: [
      pitfalls
        ? jsxs('div', {
            className: 'ia-block ia-pitfall',
            children: [jsx('div', { className: 'ia-block-title', children: '⚠ Known pitfalls' }), jsx('div', { children: pitfalls })]
          })
        : null,
      jsx('pre', { className: 'ia-runbook', children: markdown || 'Loading runbook…' })
    ]
  })
}

function RawTab({ data }) {
  return jsx('pre', {
    className: 'ia-runbook ia-json',
    children: JSON.stringify(data || {}, null, 2)
  })
}

function ActivityStream({ entries, incidents }) {
  const rows = (entries || []).slice(0, 12)
  return jsxs('div', {
    className: 'ia-stream',
    children: [
      jsx('div', { className: 'ia-stream-title', children: 'Live activity & guardrail' }),
      rows.length
        ? jsx('div', {
            className: 'ia-stream-rows',
            children: rows.map((entry, index) => {
              const kind = entry.action_kind || 'info'
              return jsxs('div', {
                className: cn('ia-stream-row', `ia-kind-${kind}`),
                children: [
                  jsx('span', { className: 'ia-stream-time', children: entry.ts ? new Date(Number(entry.ts) * 1000).toLocaleTimeString() : '' }),
                  jsx('span', { className: 'ia-stream-kind', children: kind.replace('_', ' ') }),
                  jsx('span', { className: 'ia-stream-text', children: entry.summary || entry.tool_name || '' })
                ]
              }, `activity-${index}`)
            })
          })
        : jsx('div', { className: 'ia-muted', children: 'No activity yet. Agent reads and touches appear here in real time.' }),
      incidents && incidents.length
        ? jsx('div', { className: 'ia-stream-foot', children: `${incidents.length} open incident(s)` })
        : null
    ]
  })
}

const kv = (key, value) =>
  jsxs('div', { className: 'ia-kv-row', children: [jsx('span', { className: 'ia-kv-key', children: key }), jsx('span', { className: 'ia-kv-value', children: String(value) })] })

const stat = (label, value) =>
  jsxs('div', { className: 'ia-stat', children: [jsx('div', { className: 'ia-stat-value', children: value }), jsx('div', { className: 'ia-stat-label', children: label })] })

const format = value => {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ── status bar ─────────────────────────────────────────────────────────────
function AtlasChip() {
  const { data } = useGraph(15000)
  const [flash, setFlash] = React.useState('')
  const counts = (data && data.counts) || {}
  const incidents = ((data && data.incidents) || []).length
  const total = counts.total || 0
  const healthy = counts.matched || 0
  const attention = (counts.changed || 0) + (counts.unregistered || 0) + (counts.stale || 0)

  // A vetoed tool call is the moment the operator most wants to see: flash the
  // chip instead of waiting for the next poll to change a number.
  React.useEffect(() => {
    if (!API) return undefined
    return API.onEvent('plugin.infra-atlas.activity', frame => {
      const payload = (frame && frame.payload) || frame || {}
      if (payload.action_kind !== 'touch_blocked') return
      setFlash('block')
      const timer = API.setTimeout ? API.setTimeout(() => setFlash(''), 4000) : setTimeout(() => setFlash(''), 4000)
      return () => {
        if (typeof timer === 'function') timer()
      }
    })
  }, [])

  const label = total
    ? `${incidents ? '🚨' : '◉'} Atlas ${healthy}/${total}${attention ? ` · ${attention} drift` : ''}${incidents ? ` · ${incidents} down` : ''}`
    : '◉ Atlas'
  return jsx('button', {
    type: 'button',
    className: cn('ia-chip', incidents && 'ia-chip-alert', flash === 'block' && 'ia-chip-blocked'),
    title: flash === 'block' ? 'Infra Atlas — a tool call was blocked: read the registry entry first' : 'Infra Atlas — open the infrastructure graph',
    onClick: () => host.navigate(PAGE_PATH),
    children: flash === 'block' ? `⛔ ${label}` : label
  })
}

// ── transcript directives ──────────────────────────────────────────────────
function InfraCard({ nodeId }) {
  const { data, error } = useNode(nodeId)
  if (error) return jsx('div', { className: 'ia-card ia-muted', children: `infra-atlas: ${error.message || error}` })
  if (!data || !data.node) return jsx('div', { className: 'ia-card ia-muted', children: `Loading ${nodeId}…` })
  const node = data.node
  const drift = node.drift_status || 'matched'
  return jsxs('div', {
    className: 'ia-card',
    children: [
      jsxs('div', {
        className: 'ia-card-head',
        children: [
          jsx('span', { className: 'ia-card-dot', style: { background: HEALTH_COLOR[node.health_status] || HEALTH_COLOR.unknown } }),
          jsx('strong', { children: node.label || node.id }),
          jsx('span', { className: 'ia-tag', style: { borderColor: DRIFT_COLOR[drift] }, children: DRIFT_LABEL[drift] || drift }),
          node.uptime_24h_pct !== null && node.uptime_24h_pct !== undefined
            ? jsx('span', { className: 'ia-muted', children: `${pct(node.uptime_24h_pct)} up` })
            : null
        ]
      }),
      jsx('div', { className: 'ia-card-sub', children: `${addressOf(node) || '—'}${node.managed_by ? ` · ${node.managed_by}` : ''}` }),
      (node.drift_reasons || []).length
        ? jsx('ul', { className: 'ia-list', children: node.drift_reasons.slice(0, 3).map((reason, index) => jsx('li', { children: reason }, `r-${index}`)) })
        : null,
      jsxs('div', {
        className: 'ia-row',
        children: [
          jsx('button', {
            type: 'button',
            className: 'ia-btn',
            onClick: () => {
              pendingSelect = node.id
              host.navigate(PAGE_PATH)
            },
            children: 'Open in Infra Atlas'
          }),
          drift === 'changed' || drift === 'unregistered'
            ? jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-primary',
                onClick: async () => {
                  try {
                    await rest('/reconcile', { method: 'POST', body: { node_id: node.id, action: 'adopt_live' } })
                    host.notify({ kind: 'info', message: `${node.id} adopted into the registry` })
                  } catch (err) {
                    host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
                  }
                },
                children: 'Adopt drift'
              })
            : null
        ]
      })
    ]
  })
}

function DriftCard() {
  const { data } = useGraph(15000)
  const nodes = ((data && data.nodes) || []).filter(node => node.drift_status && node.drift_status !== 'matched' && node.drift_status !== 'doc_only')
  const incidents = (data && data.incidents) || []
  return jsxs('div', {
    className: 'ia-card',
    children: [
      jsxs('div', {
        className: 'ia-card-head',
        children: [
          jsx('strong', { children: 'Fleet drift' }),
          jsx('span', { className: 'ia-muted', children: `${nodes.length} need attention` }),
          incidents.length ? jsx('span', { className: 'ia-tag', style: { borderColor: DRIFT_COLOR.stale }, children: `${incidents.length} incident(s)` }) : null
        ]
      }),
      nodes.length
        ? jsx('ul', {
            className: 'ia-list',
            children: nodes.slice(0, 8).map(node =>
              jsx('li', {
                children: `${node.label || node.id} — ${node.drift_status}${(node.drift_reasons || []).length ? `: ${node.drift_reasons[0]}` : ''}`
              }, `drift-${node.id}`)
            )
          })
        : jsx('div', { className: 'ia-muted', children: 'Registry and reality agree across the fleet.' }),
      jsxs('div', {
        className: 'ia-row',
        children: [
          jsx('button', { type: 'button', className: 'ia-btn', onClick: () => host.navigate(PAGE_PATH), children: 'Open Infra Atlas' }),
          jsx('button', {
            type: 'button',
            className: 'ia-btn ia-btn-primary',
            onClick: async () => {
              try {
                await rest('/sweep', { method: 'POST', body: {} })
                host.notify({ kind: 'info', message: 'Sweep queued — the graph is refreshing' })
              } catch (err) {
                host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
              }
            },
            children: 'Sweep now'
          })
        ]
      })
    ]
  })
}

// ── styles ─────────────────────────────────────────────────────────────────
const CSS = `
.ia-root { display:flex; flex-direction:column; height:100%; min-height:0; font-size:12px; color:var(--ui-text-primary, inherit); }
.ia-header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 14px; border-bottom:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); }
.ia-title { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13px; }
.ia-globe { color:var(--ui-accent, #6366f1); }
.ia-sub { font-weight:400; font-size:11px; color:var(--ui-text-quaternary, #6b7280); }
.ia-pills { display:flex; gap:6px; flex-wrap:wrap; }
.ia-pill { border:1px solid transparent; background:transparent; color:var(--ui-text-secondary, #9ca3af); border-radius:999px; padding:2px 9px; font-size:11px; cursor:pointer; }
.ia-pill:hover { background:var(--ui-bg-secondary, rgba(128,128,128,.12)); }
.ia-pill-active { background:var(--ui-bg-secondary, rgba(128,128,128,.16)); color:var(--ui-text-primary, inherit); }
.ia-pill-incident { border-color:var(--ui-danger, #ef4444); color:var(--ui-danger, #ef4444); }
.ia-controls { display:flex; gap:8px; align-items:center; margin-left:auto; flex-wrap:wrap; }
.ia-search { background:var(--ui-bg-secondary, rgba(128,128,128,.12)); border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); color:inherit; border-radius:7px; padding:4px 9px; font-size:11px; min-width:190px; }
.ia-select { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--ui-text-quaternary, #6b7280); }
.ia-select select { background:var(--ui-bg-secondary, rgba(128,128,128,.12)); color:inherit; border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); border-radius:6px; padding:3px 6px; font-size:11px; }
.ia-btn { background:var(--ui-bg-secondary, rgba(128,128,128,.12)); border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); color:inherit; border-radius:7px; padding:4px 10px; font-size:11px; cursor:pointer; white-space:nowrap; }
.ia-btn:hover { border-color:var(--ui-accent, #6366f1); }
.ia-btn:disabled { opacity:.55; cursor:default; }
.ia-btn-primary { border-color:var(--ui-accent, #6366f1); color:var(--ui-accent, #6366f1); }
.ia-btn-on { border-color:var(--ui-accent, #6366f1); }
.ia-incident { display:flex; gap:10px; align-items:center; padding:8px 14px; background:color-mix(in srgb, var(--ui-danger, #ef4444) 12%, transparent); border-bottom:1px solid var(--ui-danger, #ef4444); }
.ia-incident-icon { font-size:16px; }
.ia-incident-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
.ia-incident-title { display:flex; gap:8px; align-items:center; }
.ia-incident-state { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--ui-danger, #ef4444); }
.ia-incident-more { font-size:10px; color:var(--ui-text-quaternary, #6b7280); }
.ia-incident-detail, .ia-incident-hint { font-size:11px; color:var(--ui-text-secondary, #9ca3af); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-incident-actions { margin-left:auto; display:flex; gap:6px; }
.ia-body { display:flex; flex:1 1 auto; min-height:0; }
.ia-canvas { flex:1 1 auto; min-width:0; position:relative; overflow:hidden; }
.ia-graph-wrap { position:absolute; inset:0; }
.ia-svg { width:100%; height:100%; cursor:grab; }
.ia-svg:active { cursor:grabbing; }
.ia-zoom { position:absolute; right:10px; top:10px; z-index:2; display:flex; flex-direction:column; gap:4px; }
.ia-zoom button { width:24px; height:24px; border-radius:6px; border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.28)); background:var(--ui-bg-secondary, rgba(128,128,128,.16)); color:inherit; cursor:pointer; font-size:12px; }
.ia-edge { fill:none; stroke:var(--ui-stroke-secondary, rgba(128,128,128,.45)); stroke-width:1.1; }
.ia-edge-depends_on { stroke-dasharray:3 3; }
.ia-edge-uses_model { stroke:var(--ui-info, #06b6d4); stroke-opacity:.55; }
.ia-edge-monitors { stroke:var(--ui-warning, #f59e0b); stroke-opacity:.45; stroke-dasharray:2 4; }
.ia-node { cursor:pointer; }
.ia-node-rect { fill:var(--ui-bg-secondary, rgba(128,128,128,.10)); }
.ia-node:hover .ia-node-rect { fill:var(--ui-bg-primary, rgba(128,128,128,.18)); }
.ia-node-active .ia-node-rect { fill:var(--ui-bg-primary, rgba(128,128,128,.22)); }
.ia-node-title { font-size:11px; font-weight:600; fill:var(--ui-text-primary, currentColor); }
.ia-node-sub { font-size:9px; fill:var(--ui-text-quaternary, #6b7280); }
.ia-node-badge { font-size:8px; letter-spacing:.04em; text-transform:uppercase; }
.ia-ring { animation:ia-ring-pulse 1.4s ease-out 4; transform-origin:center; }
@keyframes ia-ring-pulse { 0% { opacity:.9; r:20; } 100% { opacity:0; r:44; } }
/* Live agent overlay: blocked calls shake, reads and touches pulse their kind. */
.ia-pulse-touch_blocked .ia-node-rect { animation:ia-shake .42s ease-in-out 3; }
@keyframes ia-shake { 0%,100% { transform:translateX(0); } 25% { transform:translateX(-3.5px); } 75% { transform:translateX(3.5px); } }
.ia-pulse-touch_allowed .ia-node-rect { animation:ia-flash-allowed 1.5s ease-out 1; }
@keyframes ia-flash-allowed { 0% { stroke-width:3.4; } 100% { stroke-width:1.3; } }
.ia-pulse-read_doc .ia-node-rect { animation:ia-flash-read 1.5s ease-out 1; }
@keyframes ia-flash-read { 0% { stroke-width:3.4; stroke-dasharray:6 3; } 100% { stroke-width:1.3; stroke-dasharray:none; } }
.ia-empty { display:flex; align-items:center; justify-content:center; height:100%; padding:24px; text-align:center; color:var(--ui-text-quaternary, #6b7280); }
.ia-inspector { width:352px; flex:0 0 352px; border-left:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); display:flex; flex-direction:column; min-height:0; }
.ia-inspector-empty { padding:16px; gap:8px; }
.ia-inspector-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:12px 12px 8px; }
.ia-inspector-title { font-size:13px; font-weight:600; }
.ia-inspector-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px; }
.ia-close { background:transparent; border:none; color:var(--ui-text-quaternary, #6b7280); cursor:pointer; font-size:12px; }
.ia-tabs { display:flex; gap:2px; padding:0 10px; border-bottom:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.18)); }
.ia-tab { background:transparent; border:none; border-bottom:2px solid transparent; color:var(--ui-text-quaternary, #6b7280); padding:6px 8px; font-size:11px; cursor:pointer; }
.ia-tab-active { color:var(--ui-text-primary, inherit); border-bottom-color:var(--ui-accent, #6366f1); }
.ia-tab-body { flex:1 1 auto; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.ia-inspector-foot { display:flex; gap:6px; padding:8px 12px; border-top:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.18)); }
.ia-kv { display:flex; flex-direction:column; gap:3px; }
.ia-kv-row { display:flex; gap:8px; font-size:11px; }
.ia-kv-key { width:110px; flex:0 0 110px; color:var(--ui-text-quaternary, #6b7280); }
.ia-kv-value { min-width:0; overflow-wrap:anywhere; color:var(--ui-text-secondary, #9ca3af); }
.ia-block { display:flex; flex-direction:column; gap:6px; }
.ia-block-title { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--ui-text-quaternary, #6b7280); }
.ia-pitfall { border:1px solid var(--ui-warning, #f59e0b); border-radius:8px; padding:8px; background:color-mix(in srgb, var(--ui-warning, #f59e0b) 10%, transparent); }
.ia-list { margin:0; padding-left:16px; display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--ui-text-secondary, #9ca3af); }
.ia-muted { color:var(--ui-text-quaternary, #6b7280); font-size:11px; }
.ia-row { display:flex; gap:6px; flex-wrap:wrap; }
.ia-tag { border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.32)); border-radius:999px; padding:1px 7px; font-size:9px; text-transform:uppercase; letter-spacing:.05em; color:var(--ui-text-secondary, #9ca3af); }
.ia-table { width:100%; border-collapse:collapse; font-size:11px; }
.ia-table th { text-align:left; font-weight:500; color:var(--ui-text-quaternary, #6b7280); padding:2px 4px; }
.ia-table td { padding:3px 4px; border-top:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.16)); vertical-align:top; overflow-wrap:anywhere; }
.ia-stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; }
.ia-stat { border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); border-radius:8px; padding:6px; }
.ia-stat-value { font-size:13px; font-weight:600; }
.ia-stat-label { font-size:9px; text-transform:uppercase; letter-spacing:.05em; color:var(--ui-text-quaternary, #6b7280); }
.ia-spark { display:flex; align-items:flex-end; gap:2px; height:44px; }
.ia-spark-bar { flex:1 1 0; background:var(--ui-accent, #6366f1); opacity:.75; border-radius:2px 2px 0 0; min-height:4px; }
.ia-spark-down { background:var(--ui-danger, #ef4444); opacity:.9; }
.ia-runbook { margin:0; font-size:11px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--ui-bg-secondary, rgba(128,128,128,.08)); border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.18)); border-radius:8px; padding:8px; max-height:none; }
.ia-stream { border-top:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.22)); padding:6px 14px 8px; max-height:150px; overflow:auto; }
.ia-stream-title { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--ui-text-quaternary, #6b7280); margin-bottom:4px; }
.ia-stream-rows { display:flex; flex-direction:column; gap:2px; }
.ia-stream-row { display:flex; gap:8px; font-size:11px; }
.ia-stream-time { color:var(--ui-text-quaternary, #6b7280); width:64px; flex:0 0 64px; }
.ia-stream-kind { width:96px; flex:0 0 96px; text-transform:uppercase; font-size:9px; letter-spacing:.04em; color:var(--ui-text-secondary, #9ca3af); padding-top:2px; }
.ia-stream-text { color:var(--ui-text-secondary, #9ca3af); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-kind-touch_blocked .ia-stream-kind, .ia-kind-touch_blocked .ia-stream-text { color:var(--ui-danger, #ef4444); }
.ia-kind-touch_allowed .ia-stream-kind { color:var(--ui-success, #10b981); }
.ia-kind-read_doc .ia-stream-kind { color:var(--ui-info, #06b6d4); }
.ia-stream-foot { margin-top:4px; font-size:10px; color:var(--ui-danger, #ef4444); }
.ia-chip { font-size:11px; padding:0 6px; color:var(--ui-text-tertiary, #9ca3af); background:transparent; border:none; cursor:pointer; }
.ia-chip:hover { color:var(--ui-text-primary, inherit); }
.ia-chip-alert { color:var(--ui-danger, #ef4444); }
.ia-chip-blocked { color:var(--ui-danger, #ef4444); animation:ia-chip-flash .9s ease-in-out 4; }
@keyframes ia-chip-flash { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.ia-json { font-size:10px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.ia-card { border:1px solid var(--ui-stroke-secondary, rgba(128,128,128,.24)); border-radius:10px; padding:9px 11px; display:flex; flex-direction:column; gap:6px; font-size:11px; }
.ia-card-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.ia-card-dot { width:7px; height:7px; border-radius:50%; display:inline-block; }
.ia-card-sub { color:var(--ui-text-quaternary, #6b7280); }
`

// ── registration ───────────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'Infra Atlas',
  defaultEnabled: true,
  register(ctx) {
    API = ctx

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        title: 'Infra Atlas',
        render: () => jsx(InfraAtlasPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 62,
        data: { codicon: 'globe', label: 'Infra Atlas', path: PAGE_PATH }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 90,
        render: () => jsx(AtlasChip, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'infra-atlas.open',
          label: 'Infra Atlas: open the infrastructure graph',
          keywords: ['infra', 'atlas', 'topology', 'drift', 'registry', 'uptime'],
          run: () => host.navigate(PAGE_PATH)
        }
      },
      {
        id: 'sweep',
        area: PALETTE_AREA,
        data: {
          id: 'infra-atlas.sweep',
          label: 'Infra Atlas: run a discovery + health sweep',
          keywords: ['sweep', 'discover', 'probe', 'drift'],
          run: () => {
            void rest('/sweep', { method: 'POST', body: {} }).then(
              summary =>
                host.notify({
                  kind: 'info',
                  message: summary.demo ? 'Demo fleet reloaded' : `Sweep ${summary.sweep_id} finished in ${summary.duration_ms}ms`
                }),
              error => host.notify({ kind: 'error', message: `Infra Atlas: ${error.message || error}` })
            )
          }
        }
      },
      {
        id: 'demo',
        area: PALETTE_AREA,
        data: {
          id: 'infra-atlas.demo',
          label: 'Infra Atlas: toggle the sanitized demo fleet',
          keywords: ['demo', 'fixture', 'sample', 'screenshot'],
          run: () => {
            void rest('/health')
              .then(state =>
                host
                  .request('plugins.manage', {
                    action: 'settings',
                    key: ID,
                    values: { demo_mode: !state.demo_mode }
                  })
                  .then(() =>
                    rest('/settings', { method: 'POST', body: { demo_mode: !state.demo_mode } }).then(result => {
                      host.notify({
                        kind: 'info',
                        message: result.ok ? `Demo fleet ${state.demo_mode ? 'off' : 'on'}` : 'Could not switch the fleet'
                      })
                      host.navigate(PAGE_PATH)
                    })
                  )
              )
              .catch(error => host.notify({ kind: 'error', message: `Infra Atlas: ${error.message || error}` }))
          }
        }
      },
      {
        id: 'infra-card',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'infra',
          render: ({ attrs }) => {
            const nodeId = String((attrs && attrs.id) || '').trim()
            if (!nodeId || nodeId.length > 120) return null
            return jsx(InfraCard, { nodeId })
          }
        }
      },
      {
        id: 'drift-card',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'drift',
          render: () => jsx(DriftCard, {})
        }
      }
    ])
  }
}
