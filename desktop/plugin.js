/**
 * Infra Atlas — full-page infrastructure graph for Hermes Desktop.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls (no JSX syntax). Only
 * @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 *
 * The page reads /api/plugins/infra-atlas/* through ctx.rest and subscribes to
 * `plugin.infra-atlas.*` events for live activity, sweeps and incidents.
 *
 * The topology is a terraced isometric diorama drawn as SVG: one platform per
 * stratum (hardware at the back, agents at the front), a distinct 3-D shape
 * per node kind, and edges routed on the tile grid — wrapped in a minimal,
 * floating glass HUD with a slide-over inspector drawer.
 */

import { cn, host, STATUSBAR_AREAS, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, TRANSCRIPT_DIRECTIVE_AREA, useQuery } from '@hermes/plugin-sdk'
import * as React from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const ID = 'infra-atlas'
const PAGE_PATH = '/infra-atlas'

let API = null // ctx, kept for ctx.rest / ctx.storage
let pendingSelect = null

const DRIFT_LABEL = {
  matched: 'Matched',
  changed: 'Drift',
  unregistered: 'Unregistered',
  stale: 'Stale',
  observed: 'Peer',
  doc_only: 'Doc only'
}
const HEALTH_COLOR = {
  up: 'var(--ui-success, #10b981)',
  degraded: 'var(--ui-warning, #f59e0b)',
  down: 'var(--ui-danger, #ef4444)',
  unknown: 'var(--muted-foreground, var(--ui-text-quaternary, #6b7280))'
}
const DRIFT_COLOR = {
  matched: 'var(--ui-success, #10b981)',
  changed: 'var(--ui-warning, #f59e0b)',
  unregistered: 'var(--ui-info, #06b6d4)',
  stale: 'var(--ui-danger, #ef4444)',
  observed: 'var(--muted-foreground, var(--ui-text-tertiary, #8b8f98))',
  doc_only: 'var(--muted-foreground, var(--ui-text-quaternary, #6b7280))'
}
const DRIFT_GROUP = {
  matched: 'matched',
  changed: 'attention',
  unregistered: 'attention',
  stale: 'attention',
  observed: 'other',
  doc_only: 'other'
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
const truncate = (text, limit) => {
  const value = String(text || '')
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
const format = value => {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
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

// ── isometric scene ────────────────────────────────────────────────────────
// The topology is a terraced isometric diorama: one platform per stratum,
// stepping down toward the viewer — hardware at the back, agents at the
// front — so dependency edges flow downhill. Every kind of node is a distinct
// 3-D shape standing on its platform, and edges are routed on the tile grid
// like circuit traces, fanning into parallel lanes where they run together.

// Bumped whenever the bundle changes, so a reload can be verified from the page:
//   document.querySelector('.ia-root').dataset.build
const BUILD = '20261110-1552'

const ISO = { tileW: 64, tileH: 32, stepZ: 13, slab: 10, pitch: 2, pad: 30 }
const ISO_HW = ISO.tileW / 2
const ISO_HH = ISO.tileH / 2
const STRATUM_NAME = { 1: 'HARDWARE', 2: 'COMPUTE', 3: 'SERVICES', 4: 'AGENTS · MODELS' }

const projX = (x, y) => (x - y) * ISO_HW
const projY = (x, y, z) => (x + y) * ISO_HH - z * ISO.stepZ
const r2 = n => Math.round(n * 10) / 10
const sid = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')

function seeded(id, salt) {
  let h = 2166136261 ^ Math.imul(salt + 1, 0x9e3779b1)
  const s = String(id)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

// `mat` is the dark-theme body colour, `matLight` its light-theme twin. Keeping
// both per kind preserves the material differences between a rack, a tank and a
// crate instead of flattening every node to one grey.
const KIND_SCENE = {
  server: { shape: 'rack', accent: '#dbe3f0', mat: '#4a5060', top: 54, shadow: 34 },
  vm: { shape: 'tower', accent: '#818cf8', mat: '#424a5e', top: 52, shadow: 26 },
  lxc: { shape: 'tank', accent: '#fbbf24', mat: '#4c5262', top: 38, shadow: 21 },
  container: { shape: 'cargo', accent: '#22c1d6', mat: '#4e5866', top: 27, shadow: 38 },
  service: { shape: 'pad', accent: '#a78bfa', mat: '#40465c', top: 10, shadow: 26 },
  project: { shape: 'plate', accent: '#eab308', mat: '#4a4e60', top: 8, shadow: 32 },
  agent: { shape: 'bot', accent: '#38bdf8', mat: '#414a63', top: 50, shadow: 17 },
  model_endpoint: { shape: 'orb', accent: '#e879f9', mat: '#453f5e', top: 40, shadow: 15 },
  inference: { shape: 'gpu', accent: '#fb923c', mat: '#4a4046', top: 46, shadow: 30 },
  cron: { shape: 'clock', accent: '#4ade80', mat: '#3f4a4c', top: 33, shadow: 21 },
  peer: { shape: 'beacon', accent: '#818cf8', mat: '#484e66', top: 40, shadow: 23 },
  network: { shape: 'pad', accent: '#22d3ee', mat: '#3e4a5c', top: 10, shadow: 26 }
}
const kindScene = kind => KIND_SCENE[kind] || KIND_SCENE.service

const RELATION_STYLE = {
  hosts: { color: '#96a0b5', width: 1.7, dash: '', flow: 26 },
  depends_on: { color: '#a78bfa', width: 1.4, dash: '5 4', flow: 15 },
  uses_model: { color: '#22d3ee', width: 1.4, dash: '', flow: 19 },
  provides_model: { color: '#e879f9', width: 1.4, dash: '3 3', flow: 18 },
  monitors: { color: '#f59e0b', width: 1.2, dash: '2 4', flow: 12 },
  proxies_to: { color: '#f472b6', width: 1.4, dash: '4 3', flow: 17 },
  routes_via: { color: '#2dd4bf', width: 1.4, dash: '4 3', flow: 17 },
  touches: { color: '#38bdf8', width: 1.3, dash: '3 4', flow: 14 }
}
const relationStyle = relation =>
  RELATION_STYLE[relation] || { color: '#7d8798', width: 1.3, dash: '', flow: 22 }

const byLabel = (a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id))

const MAX_MEMO_ENTRIES = 64
const scenePlanCache = new Map()
const edgeRouteCache = new Map()
const geometryCache = new Map()

function rememberMemo(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > MAX_MEMO_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break
    map.delete(oldestKey)
  }
  return value
}

function nodeTopologySignature(nodes) {
  return nodes
    .map(node => [node.id || '', node.label || '', node.stratum ?? 3, node.parent_id || '', node.kind || ''].join('\u0001'))
    .join('\u0002')
}

function edgeTopologySignature(edges) {
  return edges
    .map(edge => [edge.source_id || '', edge.target_id || '', edge.relation || ''].join('\u0001'))
    .join('\u0002')
}

function planScene(nodes) {
  if (!nodes.length) {
    return { platforms: [], placed: new Map(), zAt: () => 0, latticeOk: () => false, hugCost: () => 0, stepAt: () => false, width: 760, height: 420, origin: { x: 0, y: 0 }, signature: 'empty' }
  }
  const sig = nodeTopologySignature(nodes)
  if (scenePlanCache.has(sig)) return scenePlanCache.get(sig)

  const byStratum = new Map()
  nodes.forEach(node => {
    const stratum = Math.min(4, Math.max(1, Number(node.stratum || 3)))
    if (!byStratum.has(stratum)) byStratum.set(stratum, [])
    byStratum.get(stratum).push(node)
  })
  const strata = Array.from(byStratum.keys()).sort((a, b) => a - b)

  const placed = new Map()
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const stratumOf = node => Math.min(4, Math.max(1, Number(node.stratum || 3)))

  // Order inside a terrace: a node whose parent sits in a lower terrace takes that
  // parent's position as its sort key, so guests land in the same part of the grid
  // as the hypervisor above them instead of wherever the alphabet puts them.
  // Terraces are processed bottom-up, so every parent index is already known
  // (the old code consulted the placement map before anything had been placed,
  // which is why this never ran).
  const orderIndex = new Map()
  const orderedByStratum = new Map()
  strata.forEach(stratum => {
    const keyed = byStratum.get(stratum).map(node => {
      const parent = node.parent_id ? nodeById.get(node.parent_id) : null
      const parentIndex = parent && stratumOf(parent) < stratum ? orderIndex.get(parent.id) : undefined
      return { node, parentIndex, parentId: String(node.parent_id || ''), label: String(node.label || node.id) }
    })
    keyed.sort((a, b) => {
      const left = a.parentIndex === undefined ? Infinity : a.parentIndex
      const right = b.parentIndex === undefined ? Infinity : b.parentIndex
      if (left !== right) return left - right
      if (a.parentId !== b.parentId) return a.parentId < b.parentId ? -1 : 1
      return a.label.localeCompare(b.label)
    })
    keyed.forEach(({ node }, index) => orderIndex.set(node.id, index))
    orderedByStratum.set(stratum, keyed.map(({ node }) => node))
  })

  const specs = strata.map((stratum, t) => ({
    t,
    stratum,
    count: byStratum.get(stratum).length,
    ordered: orderedByStratum.get(stratum),
    z: strata.length - 1 - t
  }))

  // Terrace shape: a single row makes a 30-tile ribbon, one tile deep. Packing a
  // tier up to three rows deep trades width for depth and keeps the diorama
  // roughly 1.4:1 instead of a letterbox. Every combination is cheap (at most
  // 3^4), so pick the one whose projected footprint is closest to that.
  const buildPlatforms = rowsList => {
    const sized = specs.map((spec, index) => {
      const wanted = rowsList[index] || 1
      const rows = Math.max(1, Math.min(3, Math.min(spec.count, wanted)))
      const cols = Math.max(1, Math.ceil(spec.count / rows))
      return { ...spec, rows, cols, D: rows * ISO.pitch + 2 }
    })
    const W = Math.max(...sized.map(spec => spec.cols * ISO.pitch + 4))
    let cursorY = 0
    return sized.map(spec => {
      const platform = { t: spec.t, stratum: spec.stratum, cols: spec.cols, rows: spec.rows, L: 0, P: cursorY, W, D: spec.D, z: spec.z, nodes: spec.ordered }
      cursorY += spec.D + 1
      return platform
    })
  }

  const measure = list => {
    let lo = Infinity
    let hi = -Infinity
    let top = Infinity
    let bottom = -Infinity
    const cliff = 16 + ISO.stepZ
    list.forEach(item => {
      const corners = [
        [projX(item.L, item.P), projY(item.L, item.P, item.z)],
        [projX(item.L + item.W, item.P), projY(item.L + item.W, item.P, item.z)],
        [projX(item.L + item.W, item.P + item.D), projY(item.L + item.W, item.P + item.D, item.z)],
        [projX(item.L, item.P + item.D), projY(item.L, item.P + item.D, item.z)]
      ]
      corners.forEach(([cx, cy]) => {
        lo = Math.min(lo, cx)
        hi = Math.max(hi, cx)
        top = Math.min(top, cy)
        bottom = Math.max(bottom, cy + cliff)
      })
    })
    return { width: hi - lo, height: Math.max(1, bottom - top) }
  }

  const TARGET_ASPECT = 1.4
  const combos = specs.reduce(
    (acc, spec) => {
      const next = []
      acc.forEach(prefix => {
        const cap = Math.min(3, Math.max(1, spec.count))
        for (let rows = 1; rows <= cap; rows++) next.push([...prefix, rows])
      })
      return next
    },
    [[]]
  )
  // Aspect first, area second: an isometric terrace is inherently 2:1, so on a
  // scene where every packing scores the same shape the winner should be the
  // most compact one (fewest empty tiles, least zoom-out), not the first tried.
  const scored = combos.map(rowsList => {
    const candidate = buildPlatforms(rowsList)
    const size = measure(candidate)
    return {
      platforms: candidate,
      aspectErr: Math.abs(Math.log(size.width / size.height / TARGET_ASPECT)),
      area: size.width * size.height
    }
  })
  const closest = Math.min(...scored.map(item => item.aspectErr))
  const platforms = scored
    .filter(item => item.aspectErr <= closest + 0.02)
    .sort((a, b) => a.area - b.area)[0].platforms
  platforms.forEach(p => {
    p.nodes.forEach((node, index) => {
      placed.set(node.id, {
        node,
        gx: p.L + 2 + ISO.pitch * (index % p.cols),
        gy: p.P + 2 + ISO.pitch * Math.floor(index / p.cols),
        col: index % p.cols,
        t: p.t,
        z: p.z
      })
    })
    delete p.nodes
  })

  const shiftX = -Math.min(...platforms.map(p => p.L))
  platforms.forEach(p => {
    p.L += shiftX
  })
  placed.forEach(info => {
    info.gx += shiftX
    info.u = info.gx + info.gy
  })

  const occupied = new Set()
  placed.forEach(info => occupied.add(`${info.gx},${info.gy}`))

  const bands = []
  platforms.forEach((p, index) => {
    bands.push({ y0: p.P, y1: p.P + p.D, z: p.z })
    const next = platforms[index + 1]
    if (next) bands.push({ y0: p.P + p.D, y1: next.P, z: next.z })
  })
  const zAt = y => {
    for (const band of bands) if (y >= band.y0 && y < band.y1) return band.z
    return platforms[platforms.length - 1].z
  }
  const zBoundary = (ya, yb) => {
    const lo = Math.min(ya, yb)
    const hi = Math.max(ya, yb)
    for (const band of bands) if (band.y1 > lo && band.y1 <= hi) return band.y1
    return hi
  }
  const platformAt = (gx, gy) =>
    platforms.find(p => gx >= p.L && gx < p.L + p.W && gy >= p.P && gy < p.P + p.D)
  const stepAt = (gx, gy) => {
    for (let index = 0; index < platforms.length - 1; index++) {
      const a = platforms[index]
      const b = platforms[index + 1]
      if (gy >= a.P + a.D && gy < b.P && gx >= Math.max(a.L, b.L) && gx < Math.min(a.L + a.W, b.L + b.W)) return true
    }
    return false
  }
  const latticeOk = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    return Boolean(platformAt(mx, my) || stepAt(mx, my))
  }
  const hugCost = (x1, y1, x2, y2) => {
    if (y1 === y2) {
      return occupied.has(`${x1},${y1 - 1}`) || occupied.has(`${x1},${y1}`) ? 2.4 : 0
    }
    return occupied.has(`${x1 - 1},${y1}`) || occupied.has(`${x1},${y1}`) ? 2.4 : 0
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  platforms.forEach(p => {
    const cliff = 16 + ISO.stepZ
    const corners = [
      { x: projX(p.L, p.P), y: projY(p.L, p.P, p.z) },
      { x: projX(p.L + p.W, p.P), y: projY(p.L + p.W, p.P, p.z) },
      { x: projX(p.L + p.W, p.P + p.D), y: projY(p.L + p.W, p.P + p.D, p.z) },
      { x: projX(p.L, p.P + p.D), y: projY(p.L, p.P + p.D, p.z) }
    ]
    corners.forEach(c => {
      minX = Math.min(minX, c.x)
      maxX = Math.max(maxX, c.x)
      minY = Math.min(minY, c.y)
      maxY = Math.max(maxY, c.y + cliff)
    })
  })
  minX -= 44
  maxX += 44
  minY -= 156
  maxY += 48
  return rememberMemo(scenePlanCache, sig, {
    platforms,
    placed,
    occupied,
    zAt,
    zBoundary,
    latticeOk,
    hugCost,
    stepAt,
    width: maxX - minX + ISO.pad * 2,
    height: maxY - minY + ISO.pad * 2,
    origin: { x: ISO.pad - minX, y: ISO.pad - minY },
    signature: sig
  })
}

// ── edge routing ───────────────────────────────────────────────────────────
const DIRS = [[1, 0, 0], [-1, 0, 1], [0, 1, 2], [0, -1, 3]]

const portPoint = (info, side) =>
  side === 'E' ? { x: info.gx + 1, y: info.gy + 0.5 }
    : side === 'W' ? { x: info.gx, y: info.gy + 0.5 }
      : side === 'S' ? { x: info.gx + 0.5, y: info.gy + 1 }
        : { x: info.gx + 0.5, y: info.gy }

const exitCorner = (info, side, tx, ty) => {
  if (side === 'E') return { x: info.gx + 1, y: ty >= info.gy ? info.gy + 1 : info.gy }
  if (side === 'W') return { x: info.gx, y: ty >= info.gy ? info.gy + 1 : info.gy }
  if (side === 'S') return { x: tx >= info.gx ? info.gx + 1 : info.gx, y: info.gy + 1 }
  return { x: tx >= info.gx ? info.gx + 1 : info.gx, y: info.gy }
}

const edgeKey = (x1, y1, x2, y2) => {
  if (x2 < x1 || (x2 === x1 && y2 < y1)) return `${x2},${y2},${x1},${y1}`
  return `${x1},${y1},${x2},${y2}`
}

function findPath(plan, congestion, start, goal) {
  const key = (x, y, dir) => (y * 512 + x) * 4 + dir
  const open = []
  const push = item => {
    open.push(item)
    let i = open.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (open[p].f <= open[i].f) break
      const swap = open[p]
      open[p] = open[i]
      open[i] = swap
      i = p
    }
  }
  const pop = () => {
    const top = open[0]
    const last = open.pop()
    if (open.length) {
      open[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < open.length && open[l].f < open[m].f) m = l
        if (r < open.length && open[r].f < open[m].f) m = r
        if (m === i) break
        const swap = open[m]
        open[m] = open[i]
        open[i] = swap
        i = m
      }
    }
    return top
  }
  const heuristic = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y)
  const best = new Map()
  const cameFrom = new Map()
  push({ f: heuristic(start.x, start.y), g: 0, x: start.x, y: start.y, dir: -1 })
  let found = null
  let guard = 0
  while (open.length && guard++ < 60000 && !found) {
    const current = pop()
    if (current.x === goal.x && current.y === goal.y) {
      found = current
      break
    }
    const ck = key(current.x, current.y, current.dir)
    if (best.has(ck) && best.get(ck) < current.g) continue
    best.set(ck, current.g)
    DIRS.forEach(d => {
      const nx = current.x + d[0]
      const ny = current.y + d[1]
      if (!plan.latticeOk(current.x, current.y, nx, ny)) return
      const turn = current.dir >= 0 && current.dir !== d[2] ? 0.95 : 0
      const joint = plan.stepAt((current.x + nx) / 2, (current.y + ny) / 2) ? 0.5 : 0
      const cost =
        1 +
        turn +
        joint +
        plan.hugCost(current.x, current.y, nx, ny) +
        1.15 * (congestion.get(edgeKey(current.x, current.y, nx, ny)) || 0)
      const next = { g: current.g + cost, x: nx, y: ny, dir: d[2] }
      const nk = key(nx, ny, d[2])
      if (best.has(nk) && best.get(nk) <= next.g) return
      best.set(nk, next.g)
      cameFrom.set(nk, current)
      push({ ...next, f: next.g + heuristic(nx, ny) })
    })
  }
  if (!found) return null
  const tiles = []
  let node = found
  let guardWalk = 0
  while (node && guardWalk++ < 5000) {
    tiles.unshift({ x: node.x, y: node.y })
    node = cameFrom.get(key(node.x, node.y, node.dir))
  }
  return tiles
}

const pointTo = (from, to, distance) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.max(0.001, Math.hypot(dx, dy))
  const k = Math.min(distance, len / 2) / len
  return { x: from.x + dx * k, y: from.y + dy * k }
}

function smoothPath(points) {
  if (points.length < 2) return { d: '', length: 0, angle: 0, end: points[0] || { x: 0, y: 0 } }
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  let d = `M ${r2(points[0].x)} ${r2(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]
    const radius = Math.min(6.5, Math.hypot(corner.x - prev.x, corner.y - prev.y) * 0.42, Math.hypot(next.x - corner.x, next.y - corner.y) * 0.42)
    const a = pointTo(corner, prev, radius)
    const b = pointTo(corner, next, radius)
    d += ` L ${r2(a.x)} ${r2(a.y)} Q ${r2(corner.x)} ${r2(corner.y)} ${r2(b.x)} ${r2(b.y)}`
  }
  const last = points[points.length - 1]
  d += ` L ${r2(last.x)} ${r2(last.y)}`
  const before = points[points.length - 2]
  const angle = (Math.atan2(last.y - before.y, last.x - before.x) * 180) / Math.PI
  return { d, length, angle, end: last }
}

function routeEdges(edges, plan) {
  if (!plan.platforms.length) return []
  const routeKey = `${plan.signature || ''}::${edgeTopologySignature(edges)}`
  if (edgeRouteCache.has(routeKey)) return edgeRouteCache.get(routeKey)

  const congestion = new Map()

  const ordered = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => plan.placed.has(edge.source_id) && plan.placed.has(edge.target_id) && edge.source_id !== edge.target_id)
    .sort((a, b) => String(a.edge.source_id).localeCompare(String(b.edge.source_id)) || a.index - b.index)

  const result = ordered.map(({ edge }) => {
    const from = plan.placed.get(edge.source_id)
    const to = plan.placed.get(edge.target_id)
    const dx = to.gx - from.gx
    const dy = to.gy - from.gy
    const outSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N')
    const inSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'W' : 'E') : (dy >= 0 ? 'N' : 'S')

    const a = portPoint(from, outSide)
    const b = portPoint(to, inSide)
    const start = exitCorner(from, outSide, to.gx, to.gy)
    const goal = exitCorner(to, inSide, from.gx, from.gy)
    let lattice = start && goal ? findPath(plan, congestion, start, goal) : null
    if (!lattice && start && goal) {
      const bend = start.y === goal.y || start.x === goal.x
        ? []
        : Math.abs(goal.x - start.x) >= Math.abs(goal.y - start.y)
          ? [{ x: goal.x, y: start.y }]
          : [{ x: start.x, y: goal.y }]
      lattice = [...bend, goal]
    }

    const gridPoints = [a, start, ...lattice, goal, b].filter(Boolean)
    const dedup = []
    gridPoints.forEach(p => {
      const last = dedup[dedup.length - 1]
      if (!last || last.x !== p.x || last.y !== p.y) dedup.push(p)
    })
    for (let i = 1; i < dedup.length; i++) {
      const p1 = dedup[i - 1]
      const p2 = dedup[i]
      if (Number.isInteger(p1.x) && Number.isInteger(p1.y) && Number.isInteger(p2.x) && Number.isInteger(p2.y)) {
        const k = edgeKey(p1.x, p1.y, p2.x, p2.y)
        congestion.set(k, (congestion.get(k) || 0) + 1)
      }
    }

    const simple = []
    dedup.forEach((p, i) => {
      if (i === 0 || i === dedup.length - 1) {
        simple.push(p)
        return
      }
      const prev = simple[simple.length - 1]
      const next = dedup[i + 1]
      const cross = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x)
      if (Math.abs(cross) > 0.02) simple.push(p)
    })
    const screenPoints = []
    simple.forEach((p, i) => {
      if (i) {
        const prev = simple[i - 1]
        const z1 = plan.zAt(prev.y)
        const z2 = plan.zAt(p.y)
        if (z1 !== z2 && prev.x === p.x) {
          const yB = plan.zBoundary(prev.y, p.y)
          screenPoints.push({ x: projX(p.x, yB), y: projY(p.x, yB, z1) })
          screenPoints.push({ x: projX(p.x, yB), y: projY(p.x, yB, z2) })
        }
      }
      screenPoints.push({ x: projX(p.x, p.y), y: projY(p.x, p.y, plan.zAt(p.y)) })
    })
    const smooth = smoothPath(screenPoints)

    const style = relationStyle(edge.relation)
    const dur = Math.max(3.2, Math.min(11, smooth.length / 55))
    const phase = seeded(edge.source_id + edge.target_id + String(edge.relation), 3)
    const back = pointTo(smooth.end, screenPoints[screenPoints.length - 2] || smooth.end, 8)
    return {
      key: `${edge.source_id}>${edge.target_id}#${edge.relation}`,
      edge,
      d: smooth.d,
      length: smooth.length,
      angle: smooth.angle,
      chevron: back,
      dur,
      phase,
      style
    }
  })

  return rememberMemo(edgeRouteCache, routeKey, result)
}

// ── iso shape primitives ───────────────────────────────────────────────────
function boxGeom(ax, ay, h, baseY = 0) {
  const gKey = `${ax}:${ay}:${h}:${baseY}`
  if (geometryCache.has(gKey)) return geometryCache.get(gKey)
  const raw = [
    [-ax, -ay],
    [ax, -ay],
    [ax, ay],
    [-ax, ay]
  ]
  const p = raw.map(c => ({ x: projX(c[0], c[1]), y: projY(c[0], c[1], 0) - baseY }))
  const A = p[0]
  const B = p[1]
  const C = p[2]
  const D = p[3]
  const up = corner => ({ x: corner.x, y: corner.y - h })
  const At = up(A)
  const Bt = up(B)
  const Ct = up(C)
  const Dt = up(D)
  const path = (...pts) => `M ${pts.map(pt => `${r2(pt.x)} ${r2(pt.y)}`).join(' L ')} Z`
  return rememberMemo(geometryCache, gKey, {
    A, B, C, D, At, Bt, Ct, Dt,
    top: path(At, Bt, Ct, Dt),
    left: path(Dt, Ct, C, D),
    right: path(Ct, Bt, B, C),
    backL: path(At, Dt, D, A),
    backR: path(Bt, At, A, B),
    faceTop: [At, Bt, Ct, Dt],
    faceLeft: [Dt, Ct, C, D],
    faceRight: [Ct, Bt, B, C]
  })
}

const lerp = (p1, p2, f) => ({ x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f })
const along = (p1, p2, f) => `M ${r2(lerp(p1, p2, f).x)} ${r2(lerp(p1, p2, f).y)} L ${r2(lerp(p1, p2, 1 - f).x)} ${r2(lerp(p1, p2, 1 - f).y)}`

// ── per-kind shape bodies (children of the .ia-lift group) ────────────────
function RackBody({ node, scene }) {
  const g = boxGeom(0.62, 0.3, 54)
  const units = [0.16, 0.32, 0.48, 0.64, 0.8].map(f => along(lerp(g.Bt, g.B, f), lerp(g.Ct, g.C, f), 0.04))
  const leds = [0.2, 0.36, 0.52, 0.68].map(f => lerp(lerp(g.Bt, g.B, 0.07), lerp(g.Ct, g.C, 0.07), f + 0.02))
  return [
    jsx('path', { d: g.backL, className: 'ia-f-back' }, 'bl'),
    jsx('path', { d: g.backR, className: 'ia-f-back' }, 'br'),
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('path', { d: along(g.At, g.Dt, 0.18), className: 'ia-detail' }, 'd1'),
    jsx('path', { d: along(g.Bt, g.Ct, 0.18), className: 'ia-detail' }, 'd2'),
    jsx('path', { d: units.join(' '), className: 'ia-groove' }, 'u'),
    jsx('path', { d: along(lerp(g.Dt, g.D, 0.5), lerp(g.Ct, g.C, 0.5), 0.48), className: 'ia-groove' }, 'g'),
    ...leds.map((p, i) =>
      jsx('circle', {
        cx: r2(p.x),
        cy: r2(p.y),
        r: 1.5,
        className: cn('ia-led', seeded(node.id, i) > 0.5 ? 'ia-led-b' : 'ia-led-f'),
        style: { animationDelay: `${(seeded(node.id, i + 40) * 2.4).toFixed(2)}s`, fill: i % 3 === 0 ? scene.accent : '#7ee2a8' }
      }, `led-${i}`)
    )
  ]
}

function TowerBody({ node, scene }) {
  const base = boxGeom(0.46, 0.46, 6)
  const g = boxGeom(0.33, 0.33, 44, 6)
  const screen = [
    lerp(g.Ct, lerp(g.Bt, g.B, 0.24), 0.2),
    lerp(lerp(g.Ct, g.Bt, 0.2), lerp(g.Bt, g.B, 0.06), 0.78),
    lerp(lerp(g.Ct, g.Bt, 0.2), lerp(g.Bt, g.B, 0.94), 0.78),
    lerp(g.Ct, lerp(g.Bt, g.B, 0.76), 0.2)
  ]
  const screenD = `M ${screen.map(p => `${r2(p.x)} ${r2(p.y)}`).join(' L ')} Z`
  const scanTop = lerp(screen[0], screen[1], 0.1)
  const scanBottom = lerp(screen[3], screen[2], 0.1)
  return [
    jsx('path', { d: base.left, className: 'ia-f-left' }, 'bl'),
    jsx('path', { d: base.right, className: 'ia-f-right' }, 'br'),
    jsx('path', { d: base.top, className: 'ia-f-top' }, 'bt'),
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('path', { d: screenD, className: 'ia-screen', style: { stroke: scene.accent } }, 'scr'),
    jsx('clipPath', { id: `ia-clip-${sid(node.id)}`, children: jsx('path', { d: screenD }) }, 'clip'),
    jsx('line', {
      x1: r2(scanTop.x), y1: r2(scanTop.y), x2: r2(scanBottom.x), y2: r2(scanBottom.y),
      className: 'ia-scan', style: { animationDelay: `${(seeded(node.id, 7) * 2.8).toFixed(2)}s` },
      clipPath: `url(#ia-clip-${sid(node.id)})`
    }, 'scan'),
    jsx('circle', { cx: r2(lerp(g.At, g.Ct, 0.5).x), cy: r2(lerp(g.At, g.Ct, 0.5).y - 2), r: 1.6, style: { fill: scene.accent }, className: 'ia-blink' }, 'dot')
  ]
}

function TankBody({ node, scene }) {
  const rx = 15
  const ry = 7.5
  const h = 34
  const level = Math.min(0.96, Math.max(0.1, (Number(node.uptime_24h_pct) || 92) / 100))
  const ySurface = -h * level
  const body = `M ${-rx} ${-h} L ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 L ${rx} ${-h} Z`
  const liquid = `M ${-rx} ${r2(ySurface)} L ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 L ${rx} ${r2(ySurface)} A ${rx} ${ry} 0 0 1 ${-rx} ${r2(ySurface)} Z`
  const health = HEALTH_COLOR[node.health_status] || HEALTH_COLOR.unknown
  return [
    jsx('clipPath', { id: `ia-clip-${sid(node.id)}`, children: jsx('path', { d: body }) }, 'clip'),
    jsx('path', { d: body, className: 'ia-glass' }, 'glass'),
    jsx('path', { d: liquid, style: { fill: health }, className: 'ia-liquid' }, 'liq'),
    jsxs('g', {
      className: 'ia-slosh',
      style: { animationDelay: `${(seeded(node.id, 5) * 3).toFixed(2)}s` },
      clipPath: `url(#ia-clip-${sid(node.id)})`,
      children: [
        jsx('ellipse', { cx: 0, cy: r2(ySurface), rx, ry, style: { fill: health }, className: 'ia-meniscus' })
      ]
    }, 'slosh'),
    jsx('ellipse', { cx: 0, cy: -h, rx, ry, className: 'ia-rim', style: { stroke: scene.accent } }, 'rim'),
    jsx('ellipse', { cx: -rx * 0.3, cy: -h * 0.62, rx: 2.4, ry: 5, className: 'ia-glass-shine' }, 'shine')
  ]
}

function CargoBody({ scene }) {
  const g = boxGeom(0.9, 0.36, 25)
  const ridges = [0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86].map(f =>
    along(lerp(g.D, g.Dt, 0.12), lerp(g.C, g.Ct, 0.12), 1 - f - 0.07)
  )
  return [
    jsxs('g', { className: 'ia-hum', children: [
      jsx('path', { d: g.left, className: 'ia-f-left' }),
      jsx('path', { d: g.right, className: 'ia-f-right' }),
      jsx('path', { d: g.top, className: 'ia-f-top' })
    ] }, 'hum'),
    jsx('path', { d: ridges.join(' '), className: 'ia-groove' }, 'ridges'),
    jsx('path', { d: along(g.Ct, g.Dt, 0.3), className: 'ia-groove' }, 'g1'),
    jsx('path', {
      d: `M ${r2(lerp(g.C, g.Ct, 0.18).x)} ${r2(lerp(g.C, g.Ct, 0.18).y)} L ${r2(lerp(g.B, g.Bt, 0.18).x)} ${r2(lerp(g.B, g.Bt, 0.18).y)} L ${r2(lerp(g.B, g.Bt, 0.82).x)} ${r2(lerp(g.B, g.Bt, 0.82).y)} L ${r2(lerp(g.C, g.Ct, 0.82).x)} ${r2(lerp(g.C, g.Ct, 0.82).y)} Z`,
      className: 'ia-door',
      style: { stroke: scene.accent }
    }, 'door'),
    jsx('path', { d: along(lerp(g.C, g.Ct, 0.3), lerp(g.B, g.Bt, 0.3), 0.4), className: 'ia-groove' }, 'g2'),
    jsx('path', { d: along(lerp(g.C, g.Ct, 0.7), lerp(g.B, g.Bt, 0.7), 0.4), className: 'ia-groove' }, 'g3')
  ]
}

// Inference server: a low chassis with two spinning fan discs and accelerator
// blades on the deck. Deliberately unlike the flat service pad and the container
// crate — you should be able to tell at a glance what is eating the GPU.
function GpuBody({ node, scene }) {
  const g = boxGeom(0.66, 0.4, 26)
  const faceCentre = (a, at, bt, b) => ({
    x: (a.x + at.x + bt.x + b.x) / 4,
    y: (a.y + at.y + bt.y + b.y) / 4
  })
  const fan = (centre, key) => {
    const cx = r2(centre.x)
    const cy = r2(centre.y)
    // Blades are drawn around 0,0 inside a translated group so the CSS rotation
    // pivots on the hub instead of the group's bounding box.
    const blades = [0, 60, 120, 180, 240, 300].map(deg =>
      jsx(
        'path',
        {
          d: `M 0 0 l ${r2(6.4 * Math.cos((deg * Math.PI) / 180))} ${r2(2.6 * Math.sin((deg * Math.PI) / 180))}`,
          className: 'ia-fan-blade'
        },
        `blade-${deg}`
      )
    )
    return jsxs(
      'g',
      {
        className: 'ia-fan',
        transform: `translate(${cx} ${cy})`,
        children: [
          jsx('ellipse', { cx: 0, cy: 0, rx: 8.6, ry: 4.4, className: 'ia-fan-rim', style: { stroke: scene.accent } }, 'rim'),
          jsxs('g', { className: 'ia-fan-blades', children: blades }, 'blades'),
          jsx('ellipse', { cx: 0, cy: 0, rx: 2.4, ry: 1.2, className: 'ia-fan-hub', style: { fill: scene.accent } }, 'hub')
        ]
      },
      key
    )
  }
  const deckFins = [0.22, 0.4, 0.58, 0.76].map(f => along(lerp(g.At, g.Dt, f), lerp(g.Bt, g.Ct, f), 0.86))
  return [
    jsx('path', { d: g.backL, className: 'ia-f-back' }, 'bl'),
    jsx('path', { d: g.backR, className: 'ia-f-back' }, 'br'),
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('path', { d: deckFins.join(' '), className: 'ia-groove' }, 'fins'),
    jsx('path', { d: along(g.At, g.Dt, 0.08), className: 'ia-detail' }, 'd1'),
    fan(faceCentre(g.D, g.Dt, g.Ct, g.C), 'fan-l'),
    fan(faceCentre(g.C, g.Ct, g.Bt, g.B), 'fan-r'),
    jsx('ellipse', { cx: 0, cy: 3, rx: 22, ry: 10, className: 'ia-heat', style: { stroke: scene.accent } }, 'heat'),
    jsx('circle', { cx: r2(lerp(g.Ct, g.Bt, 0.5).x), cy: r2(lerp(g.Ct, g.Bt, 0.5).y - 2), r: 1.6, className: 'ia-led ia-led-f', style: { fill: scene.accent } }, 'led')
  ]
}

function PadBody({ scene }) {
  const g = boxGeom(0.46, 0.46, 8)
  const top = lerp(g.At, g.Ct, 0.5)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('path', {
      d: `M ${r2(top.x)} ${r2(top.y - 6)} L ${r2(top.x + 8)} ${r2(top.y - 2)} L ${r2(top.x)} ${r2(top.y + 2)} L ${r2(top.x - 8)} ${r2(top.y - 2)} Z`,
      style: { stroke: scene.accent },
      className: 'ia-glyph'
    }, 'glyph'),
    jsx('circle', { cx: r2(top.x), cy: r2(top.y - 2), r: 1.7, style: { fill: scene.accent }, className: 'ia-blink' }, 'dot')
  ]
}

function PlateBody() {
  const g = boxGeom(0.7, 0.4, 6)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('path', { d: along(g.Dt, g.D, 0.4), className: 'ia-detail' }, 'd1'),
    jsx('path', { d: along(lerp(g.Ct, g.C, 0.45), lerp(g.Bt, g.B, 0.45), 0.3), className: 'ia-detail' }, 'd2')
  ]
}

function BotBody({ node, scene }) {
  const g = boxGeom(0.3, 0.3, 18, 24)
  const antennaBase = lerp(g.At, g.Ct, 0.5)
  return [
    jsxs('g', {
      className: 'ia-bob',
      style: { animationDelay: `${(seeded(node.id, 2) * 3.4).toFixed(2)}s` },
      children: [
        jsx('path', { d: g.left, className: 'ia-f-left' }),
        jsx('path', { d: g.right, className: 'ia-f-right' }),
        jsx('path', { d: g.top, className: 'ia-f-top' }),
        jsx('path', { d: along(lerp(g.Ct, g.Bt, 0.1), lerp(g.C, g.B, 0.1), 0.55), style: { stroke: scene.accent }, className: 'ia-visor' }),
        jsx('line', { x1: r2(antennaBase.x), y1: r2(antennaBase.y - 1), x2: r2(antennaBase.x), y2: r2(antennaBase.y - 9), className: 'ia-detail' }),
        jsx('circle', { cx: r2(antennaBase.x), cy: r2(antennaBase.y - 10.5), r: 1.9, style: { fill: scene.accent }, className: 'ia-blink' })
      ]
    }, 'bot')
  ]
}

function OrbBody({ node, scene }) {
  return [
    jsxs('g', {
      className: 'ia-bob ia-bob-slow',
      style: { animationDelay: `${(seeded(node.id, 9) * 4.6).toFixed(2)}s` },
      children: [
        jsx('circle', { cx: 0, cy: -29, r: 10.5, className: 'ia-orb', style: { fill: scene.accent } }),
        jsx('circle', { cx: -3, cy: -33, r: 3.1, className: 'ia-orb-shine' }),
        jsx('ellipse', { cx: 0, cy: -29, rx: 15.5, ry: 5.2, className: 'ia-orbit-ring' }),
        jsxs('g', { className: 'ia-orbiter', children: [
          jsx('circle', { cx: 0, cy: 0, r: 2.1, style: { fill: scene.accent } }),
          jsx('animateMotion', { path: 'M 0 -24.2 A 15.5 5.2 0 1 0 0.05 -24.2 Z', dur: '5s', repeatCount: 'indefinite', calcMode: 'linear' })
        ] })
      ]
    }, 'orb')
  ]
}

function ClockBody({ scene }) {
  const g = boxGeom(0.4, 0.4, 12)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }, 'l'),
    jsx('path', { d: g.right, className: 'ia-f-right' }, 'r'),
    jsx('path', { d: g.top, className: 'ia-f-top' }, 't'),
    jsx('circle', { cx: 0, cy: -21, r: 11, className: 'ia-clock-face' }, 'face'),
    ...[0, 90, 180, 270].map(deg =>
      jsx('circle', {
        cx: r2(Math.sin((deg * Math.PI) / 180) * 8.2),
        cy: r2(-21 - Math.cos((deg * Math.PI) / 180) * 8.2),
        r: 1.1,
        className: 'ia-clock-tick'
      }, `tick-${deg}`)
    ),
    jsxs('g', { transform: 'translate(0 -21)', children: [
      jsxs('g', { children: [
        jsx('line', { x1: 0, y1: 2, x2: 0, y2: -8, style: { stroke: scene.accent }, className: 'ia-clock-hand' }),
        jsx('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0', to: '360', dur: '8s', repeatCount: 'indefinite' })
      ] })
    ] }, 'hand'),
    jsx('circle', { cx: 0, cy: -21, r: 1.5, style: { fill: scene.accent } }, 'pin')
  ]
}

function BeaconBody({ node, scene }) {
  const g = boxGeom(0.5, 0.5, 0)
  const apex = { x: (g.A.x + g.C.x) / 2, y: (g.A.y + g.C.y) / 2 - 38 }
  const face = (p1, p2) => `M ${r2(p1.x)} ${r2(p1.y)} L ${r2(p2.x)} ${r2(p2.y)} L ${r2(apex.x)} ${r2(apex.y)} Z`
  const band = (p1, p2, f) => {
    const a = { x: p1.x + (apex.x - p1.x) * f, y: p1.y + (apex.y - p1.y) * f }
    const b = { x: p2.x + (apex.x - p2.x) * f, y: p2.y + (apex.y - p2.y) * f }
    return `M ${r2(a.x)} ${r2(a.y)} L ${r2(b.x)} ${r2(b.y)}`
  }
  return [
    jsx('path', { d: face(g.D, g.C), className: 'ia-f-left' }, 'l'),
    jsx('path', { d: face(g.C, g.B), className: 'ia-f-right' }, 'r'),
    jsx('path', { d: band(g.D, g.C, 0.55), className: 'ia-groove' }, 'b1'),
    jsx('path', { d: band(g.C, g.B, 0.55), className: 'ia-groove' }, 'b2'),
    jsx('circle', { cx: r2(apex.x), cy: r2(apex.y - 1), r: 2.3, style: { fill: scene.accent }, className: 'ia-blink' }, 'dot'),
    jsx('ellipse', { cx: 0, cy: 1, rx: 18, ry: 9, className: 'ia-ping', style: { animationDelay: `${(seeded(node.id, 11) * 3).toFixed(2)}s`, stroke: scene.accent } }, 'p1'),
    jsx('ellipse', { cx: 0, cy: 1, rx: 18, ry: 9, className: 'ia-ping', style: { animationDelay: `${(1.5 + seeded(node.id, 12) * 3).toFixed(2)}s`, stroke: scene.accent } }, 'p2')
  ]
}

const SHAPE_BODIES = {
  rack: RackBody,
  gpu: GpuBody,
  tower: TowerBody,
  tank: TankBody,
  cargo: CargoBody,
  pad: PadBody,
  plate: PlateBody,
  bot: BotBody,
  orb: OrbBody,
  clock: ClockBody,
  beacon: BeaconBody
}

const pulseColor = kind =>
  kind === 'touch_blocked'
    ? 'var(--ui-danger, #ef4444)'
    : kind === 'touch_allowed'
      ? 'var(--ui-success, #10b981)'
      : kind === 'touch_warned'
        ? 'var(--ui-warning, #f59e0b)'
        : 'var(--ui-info, #06b6d4)'

const IsoNode = React.memo(function IsoNode({ node, info, active, pulse, fresh, delay, showTitle, showAddress, animated, onSelect }) {
  const scene = kindScene(node.kind)
  const drift = node.drift_status || 'matched'
  const driftColor = DRIFT_COLOR[drift] || DRIFT_COLOR.matched
  const health = node.health_status || 'unknown'
  const body = (SHAPE_BODIES[scene.shape] || PadBody)({ node, scene })
  const cleanLabel = String(node.label || node.id).replace(/^cron:\s*/i, '')
  const title = truncate(cleanLabel, 16)
  const sub = addressOf(node) || node.kind || ''
  const top = scene.top
  const retired = String((node.doc_state && node.doc_state.status) || node.doc_status || '') === 'removed'
  return jsxs('g', {
    className: cn(
      'ia-node',
      `ia-kind-${node.kind}`,
      retired && 'ia-node-retired',
      active && 'ia-node-active',
      !showTitle && 'ia-node-compact',
      pulse && `ia-pulse-${pulse}`,
      fresh && animated && 'ia-enter',
      !animated && 'ia-still'
    ),
    transform: `translate(${r2(projX(info.gx + 0.5, info.gy + 0.5))} ${r2(projY(info.gx + 0.5, info.gy + 0.5, info.z || 0))})`,
    'data-node-id': node.id,
    onClick: event => {
      event.stopPropagation()
      onSelect(node.id)
    },
    style: { '--acc': scene.accent, '--d': `${delay}ms` },
    children: [
      jsx('title', { children: `${node.label || node.id} (${node.kind}${sub ? ' · ' + sub : ''})` }),
      jsx('path', { d: `M 0 ${r2(2.5 - scene.shadow / 2)} L ${r2(scene.shadow)} 2.5 L 0 ${r2(2.5 + scene.shadow / 2)} L ${r2(-scene.shadow)} 2.5 Z`, className: 'ia-shadow' }),
      drift !== 'matched'
        ? jsx('path', { d: `M 0 ${r2(1.5 - scene.shadow * 0.46)} L ${r2(scene.shadow * 0.92)} 1.5 L 0 ${r2(1.5 + scene.shadow * 0.46)} L ${r2(-scene.shadow * 0.92)} 1.5 Z`, className: 'ia-dglow', style: { fill: driftColor } })
        : null,
      active
        ? jsx('path', {
            d: 'M 0 -21 L 36 0 L 0 21 L -36 0 Z',
            className: 'ia-sel-ring'
          })
        : null,
      health === 'down'
        ? [
            jsx('path', { d: 'M 0 -17 L 29 0 L 0 17 L -29 0 Z', className: 'ia-alert-base' }, 'alert-base'),
            ...[0, 1].map(i => jsx('ellipse', {
              cx: 0, cy: 1.5, rx: 30, ry: 15,
              className: 'ia-alert',
              style: { animationDelay: `${i * 0.9}s` }
            }, `alert-${i}`))
          ]
        : null,
      pulse
        ? [0, 1].map(i => jsx('ellipse', {
            cx: 0, cy: 1.5, rx: 30, ry: 15,
            className: cn('ia-ripple', `ia-ripple-${pulse}`),
            stroke: pulseColor(pulse),
            style: { animationDelay: `${i * 0.45}s` }
          }, `ripple-${i}`))
        : null,
      jsxs('g', {
        className: 'ia-lift',
        children: [
          ...body,
          jsx('circle', { cx: 0, cy: -top - 4, r: 2.5, className: cn('ia-beacon', `ia-beacon-${health}`), style: { fill: HEALTH_COLOR[health] || HEALTH_COLOR.unknown } }),
          drift !== 'matched' && drift !== 'observed' && drift !== 'doc_only'
            ? jsxs('g', { className: 'ia-chipf', style: { animationDelay: `${(seeded(node.id, 21) * 3).toFixed(2)}s` }, children: [
                jsx('rect', { x: -(DRIFT_LABEL[drift] || drift).length * 2.9 - 6, y: -(top + 48), width: (DRIFT_LABEL[drift] || drift).length * 5.8 + 12, height: 13, rx: 6.5, className: 'ia-chip-box', style: { stroke: driftColor } }),
                jsx('text', { x: 0, y: -(top + 38.5), textAnchor: 'middle', className: 'ia-chip-text', style: { fill: driftColor }, children: DRIFT_LABEL[drift] || drift })
              ] })
            : null,
          jsx('text', { x: 0, y: -(top + 26), textAnchor: 'middle', className: 'ia-node-title', children: title }),
          showTitle && (showAddress || active)
            ? jsx('text', { x: 0, y: -(top + 15), textAnchor: 'middle', className: 'ia-node-sub2', children: node.vmid ? `${sub} · vm ${node.vmid}` : sub })
            : null
        ]
      })
    ]
  })
})

const PlatformView = React.memo(function PlatformView({ platform, next }) {
  const p = platform
  const z = p.z
  const A = { x: projX(p.L, p.P), y: projY(p.L, p.P, z) }
  const B = { x: projX(p.L + p.W, p.P), y: projY(p.L + p.W, p.P, z) }
  const C = { x: projX(p.L + p.W, p.P + p.D), y: projY(p.L + p.W, p.P + p.D, z) }
  const D = { x: projX(p.L, p.P + p.D), y: projY(p.L, p.P + p.D, z) }
  const dz = 16 + ISO.stepZ
  const face = (p1, p2, depth) =>
    `M ${r2(p1.x)} ${r2(p1.y)} L ${r2(p2.x)} ${r2(p2.y)} L ${r2(p2.x)} ${r2(p2.y + depth)} L ${r2(p1.x)} ${r2(p1.y + depth)} Z`
  const riser = next
    ? `M ${r2(D.x)} ${r2(D.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(projX(next.L + next.W, next.P))} ${r2(projY(next.L + next.W, next.P, next.z))} L ${r2(projX(next.L, next.P))} ${r2(projY(next.L, next.P, next.z))} Z`
    : null
  let grid = ''
  for (let gx = p.L + 1; gx < p.L + p.W; gx++) grid += `M ${r2(projX(gx, p.P))} ${r2(projY(gx, p.P, z))} L ${r2(projX(gx, p.P + p.D))} ${r2(projY(gx, p.P + p.D, z))} `
  for (let gy = p.P + 1; gy < p.P + p.D; gy++) grid += `M ${r2(projX(p.L, gy))} ${r2(projY(p.L, gy, z))} L ${r2(projX(p.L + p.W, gy))} ${r2(projY(p.L + p.W, gy, z))} `
  return jsxs('g', {
    className: cn('ia-plat', `ia-plat-${p.t % 4}`),
    'data-plat-stratum': p.stratum,
    'data-plat-cols': p.cols,
    'data-plat-rows': p.rows,
    style: { '--t': p.t, animationDelay: `${p.t * 110}ms` },
    children: [
      riser ? jsx('path', { d: riser, className: 'ia-plat-riser' }) : null,
      jsx('path', { d: face(D, A, dz), className: 'ia-plat-left' }),
      jsx('path', { d: face(A, B, dz), className: 'ia-plat-right' }),
      jsx('path', { d: face(C, D, dz), className: 'ia-plat-left' }),
      jsx('path', { d: face(B, C, dz), className: 'ia-plat-right' }),
      jsx('path', { d: `M ${r2(A.x)} ${r2(A.y)} L ${r2(B.x)} ${r2(B.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(D.x)} ${r2(D.y)} Z`, className: 'ia-plat-top' }),
      jsx('path', { d: grid, className: 'ia-plat-grid' }),
      jsx('path', { d: `M ${r2(B.x)} ${r2(B.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(D.x)} ${r2(D.y)}`, className: 'ia-plat-edge' })
    ]
  })
})

const PlatformLabel = React.memo(function PlatformLabel({ platform }) {
  const p = platform
  const C = { x: projX(p.L + p.W, p.P + p.D), y: projY(p.L + p.W, p.P + p.D, p.z) }
  return jsx('text', {
    x: 0,
    y: 0,
    textAnchor: 'end',
    className: 'ia-plat-label',
    transform: `translate(${r2(C.x - 12)} ${r2(C.y + 19)}) matrix(0.894 0.447 0 1 0 0)`,
    children: STRATUM_NAME[p.stratum] || `TIER ${p.stratum}`
  })
})

const EdgeView = React.memo(function EdgeView({ route, selectedId, burst, labelHint, animated }) {
  const { edge, style } = route
  const hot = Boolean(selectedId) && (edge.source_id === selectedId || edge.target_id === selectedId)
  const dim = Boolean(selectedId) && !hot
  return jsxs('g', {
    className: cn('ia-edge', `ia-edge-${edge.relation}`, hot && 'ia-edge-hot', dim && 'ia-edge-dim', !animated && 'ia-edge-still'),
    style: { '--edge-c': style.color, '--ew': style.width, '--flow-dur': `${style.flow}s` },
    children: [
      jsx('path', { d: route.d, className: 'ia-edge-line', strokeDasharray: style.dash || undefined }),
      jsx('path', {
        d: 'M -1.4 -3.6 L 5.8 0 L -1.4 3.6 Z',
        transform: `translate(${r2(route.chevron.x)} ${r2(route.chevron.y)}) rotate(${r2(route.angle)})`,
        className: 'ia-edge-head'
      }),
      animated
        ? jsxs('g', { className: 'ia-packet', children: [
            jsx('circle', { r: route.length > 430 ? 2.5 : 2, className: 'ia-packet-core' }),
            jsx('circle', { r: 4.8, className: 'ia-packet-halo' }),
            jsx('animateMotion', { path: route.d, dur: `${route.dur}s`, begin: `${(-route.phase * route.dur).toFixed(2)}s`, repeatCount: 'indefinite', calcMode: 'linear' })
          ] })
        : null,
      burst
        ? [0, 1, 2].map(i =>
            jsxs('g', { className: 'ia-burst', style: { animationDelay: `${i * 0.24}s` }, children: [
              jsx('circle', { r: 3 }),
              jsx('animateMotion', { path: route.d, dur: '1.7s', begin: `${(i * 0.22).toFixed(2)}s`, repeatCount: '3', calcMode: 'linear' })
            ] }, `burst-${i}`))
        : null,
      jsx('path', { d: route.d, className: 'ia-edge-hit', children: jsx('title', { children: labelHint }) })
    ]
  })
})

// ── theme ──────────────────────────────────────────────────────────────────
// The diorama has its own palette, so it needs to know whether the app is light or
// dark. Custom properties compute to their token stream (a color-mix string), so
// the only reliable probe is to paint one and read it back.
function useLightTheme() {
  const [light, setLight] = React.useState(false)
  React.useEffect(() => {
    if (typeof document === 'undefined' || !document.documentElement) return undefined
    let media = null
    let timer = 0
    let last = null

    // Custom properties compute to their token stream, so the only reliable probe
    // is to paint one and read the used value back.
    const sample = (host, declaration) => {
      const probe = document.createElement('span')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.cssText = `position:absolute;width:0;height:0;opacity:0;pointer-events:none;${declaration}`
      host.appendChild(probe)
      const style = getComputedStyle(probe)
      const value = { color: style.color, background: style.backgroundColor }
      probe.remove()
      return value
    }
    const luminance = value => {
      const parts = String(value || '').match(/[\d.]+/g)
      if (!parts || parts.length < 3) return null
      const [r, g, b] = parts.slice(0, 3).map(Number)
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    }
    const alpha = value => {
      const parts = String(value || '').match(/[\d.]+/g)
      return parts && parts.length > 3 ? Number(parts[3]) : 1
    }

    const read = () => {
      try {
        const host = document.querySelector('.ia-root') || document.body
        if (!host) return
        // The frame hands the surface and ink to us as --card / --foreground.
        const surface = sample(host, 'background-color: var(--card, var(--ui-bg-primary, transparent))')
        const ink = sample(host, 'color: var(--foreground, var(--ui-text-primary, currentColor))')
        const surfaceLum = alpha(surface.background) > 0.2 ? luminance(surface.background) : null
        const inkLum = luminance(ink.color)
        let next = null
        if (surfaceLum !== null) next = surfaceLum > 0.55
        else if (inkLum !== null) next = inkLum < 0.5
        if (next === null || next === last) return
        last = next
        setLight(next)
      } catch (error) {
        /* keep whatever we had */
      }
    }

    read()
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(read)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'] })
      if (document.body) {
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      }
      // Theme switches also arrive as a stylesheet swap on a wrapper with no
      // attribute change we can see, so poll gently as well.
      timer = setInterval(read, 2000)
      if (typeof window !== 'undefined' && window.matchMedia) {
        media = window.matchMedia('(prefers-color-scheme: light)')
        if (media.addEventListener) media.addEventListener('change', read)
      }
      const onVisible = () => {
        if (document.visibilityState !== 'hidden') read()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        observer.disconnect()
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
        if (media && media.removeEventListener) media.removeEventListener('change', read)
      }
    }
    return undefined
  }, [])
  return light
}

// ── viewport ───────────────────────────────────────────────────────────────
// Pan and zoom are handled imperatively: the SVG viewBox attribute is written
// directly inside a rAF, and React state is only synced once the gesture ends.
// Routing a pointermove through setState re-rendered every node, edge and
// platform on each frame, which is what made dragging feel like mud.
const MIN_ZOOM = 0.42
const MAX_ZOOM = 3

function Topology({ nodes, edges, selectedId, onSelect, pulseFor, zoom, setZoom, offset, setOffset, api, onInteract }) {
  const plan = React.useMemo(() => planScene(nodes), [nodes])
  // Route by topology, not by array identity: `useQuery` hands back a fresh `edges`
  // array on every poll, and re-running A* for seventy edges mid-drag drops a frame.
  const routeCache = React.useRef({ key: '', value: [] })
  const routed = React.useMemo(() => {
    const key = `${plan.signature}|${edges.map(edge => `${edge.source_id}>${edge.target_id}:${edge.relation}`).join('|')}`
    if (routeCache.current.key === key) return routeCache.current.value
    const value = routeEdges(edges, plan)
    routeCache.current = { key, value }
    return value
  }, [edges, plan])
  const svgRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const seenRef = React.useRef(null)
  const viewRef = React.useRef({ x: offset.x, y: offset.y, z: zoom })
  const frameRef = React.useRef(0)
  const commitRef = React.useRef(0)

  // CSS px per world unit for the current viewBox: the SVG satisfies
  // `preserveAspectRatio` by letterboxing, so the shorter side rules.
  const scaleFor = (rect, z) => {
    if (!rect || !rect.width || !rect.height) return 1
    return Math.max(0.0001, Math.min(rect.width / (plan.width / z), rect.height / (plan.height / z)))
  }

  // The viewBox is written as an attribute, never as a React prop: a re-render
  // during a drag (poll tick, hover, drawer) used to stamp the stale prop back
  // over the live camera, which is what made panning fight itself.
  const writeViewBox = React.useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const v = viewRef.current
    svg.setAttribute('viewBox', `${r2(-v.x)} ${r2(-v.y)} ${r2(plan.width / v.z)} ${r2(plan.height / v.z)}`)
  }, [plan.width, plan.height])

  const paint = React.useCallback(() => {
    if (!svgRef.current) return
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      writeViewBox()
    })
  }, [writeViewBox])

  const commit = React.useCallback(
    immediate => {
      if (commitRef.current) clearTimeout(commitRef.current)
      const flush = () => {
        commitRef.current = 0
        const v = viewRef.current
        setOffset(prev => (Math.abs(prev.x - v.x) < 0.5 && Math.abs(prev.y - v.y) < 0.5 ? prev : { x: v.x, y: v.y }))
        setZoom(prev => (Math.abs(prev - v.z) < 0.001 ? prev : v.z))
      }
      if (immediate) flush()
      else commitRef.current = setTimeout(flush, 240)
    },
    [setOffset, setZoom]
  )

  const touched = React.useCallback(() => {
    if (onInteract) onInteract()
  }, [onInteract])

  // Keep the world point under (px, py) pinned while the zoom changes.
  const zoomAround = React.useCallback(
    (z, rect, px, py) => {
      const v = viewRef.current
      const z2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
      if (Math.abs(z2 - v.z) < 1e-4) return false
      const k0 = scaleFor(rect, v.z)
      const k1 = scaleFor(rect, z2)
      const w0 = plan.width / v.z
      const h0 = plan.height / v.z
      const w1 = plan.width / z2
      const h1 = plan.height / z2
      const ox0 = (rect.width - w0 * k0) / 2
      const oy0 = (rect.height - h0 * k0) / 2
      const wx = -v.x + (px - ox0) / k0
      const wy = -v.y + (py - oy0) / k0
      const ox1 = (rect.width - w1 * k1) / 2
      const oy1 = (rect.height - h1 * k1) / 2
      v.z = z2
      v.x = -wx + (px - ox1) / k1
      v.y = -wy + (py - oy1) / k1
      paint()
      return true
    },
    [paint, plan.width, plan.height]
  )

  // A short "camera moving" flag for the wheel/double-click path, so text does not
  // re-rasterise on every notch.
  const zoomFlashRef = React.useRef(0)
  const flashZooming = React.useCallback(() => {
    const svg = svgRef.current
    if (!svg || !svg.classList) return
    svg.classList.add('ia-svg-zooming')
    if (zoomFlashRef.current) clearTimeout(zoomFlashRef.current)
    zoomFlashRef.current = setTimeout(() => {
      zoomFlashRef.current = 0
      if (svg.classList) svg.classList.remove('ia-svg-zooming')
    }, 160)
  }, [])

  const zoomBy = React.useCallback(
    factor => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (zoomAround(viewRef.current.z * factor, rect, rect.width / 2, rect.height / 2)) {
        flashZooming()
        commit(true)
        touched()
      }
    },
    [commit, flashZooming, touched, zoomAround]
  )

  const reset = React.useCallback(() => {
    viewRef.current = { x: 0, y: 0, z: 1 }
    paint()
    commit(true)
  }, [commit, paint])

  const fit = React.useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const gap = 60
    const z = Math.max(
      MIN_ZOOM,
      Math.min(1.6, Math.min((rect.width - gap) / plan.width, (rect.height - gap) / plan.height) * 1.0)
    )
    viewRef.current = { x: 0, y: 0, z }
    paint()
    commit(true)
  }, [commit, paint, plan.width, plan.height])

  React.useEffect(() => {
    if (api) api.current = { zoomBy, reset, fit }
    return () => {
      if (api) api.current = null
    }
  }, [api, zoomBy, reset, fit])

  // Adopt viewport changes that came from outside (buttons, reset, remount).
  // A drag owns the camera: touching it here mid-gesture would yank the map.
  React.useLayoutEffect(() => {
    if (dragRef.current) return
    const v = viewRef.current
    if (Math.abs(v.z - zoom) > 1e-3 || Math.abs(v.x - offset.x) > 0.5 || Math.abs(v.y - offset.y) > 0.5) {
      viewRef.current = { x: offset.x, y: offset.y, z: zoom }
    }
    writeViewBox()
  }, [zoom, offset, writeViewBox])

  React.useLayoutEffect(() => {
    writeViewBox()
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      if (commitRef.current) clearTimeout(commitRef.current)
    }
  }, [writeViewBox])

  // Wheel and trackpad must reach us non-passively so we can stop the page from
  // scrolling underneath the map. React attaches onWheel passively.
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg || !svg.addEventListener) return undefined
    // Two-finger trackpad scrolling arrives as deltaMode 0 with small, fractional
    // deltas; a mouse wheel arrives as one big notch (deltaMode 1, or |deltaY| >= 50).
    // Treating a trackpad pan as a zoom is what made "panning around" feel wrong.
    const isTrackpadScroll = event =>
      event.deltaMode === 0 && Math.abs(event.deltaY) < 50 && Math.abs(event.deltaX) < 50
    const onWheel = event => {
      const v = viewRef.current
      const rect = svg.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      const dy = event.deltaY * unit
      const dx = event.deltaX * unit
      const pinch = event.ctrlKey || event.metaKey
      event.preventDefault()
      const k = scaleFor(rect, v.z)
      const pans = !pinch && (event.shiftKey || isTrackpadScroll(event))
      if (pans) {
        // Content follows the fingers: scroll down/right moves the world with it.
        v.x += (event.shiftKey ? dy : dx) * k
        v.y += (event.shiftKey ? 0 : dy) * k
        paint()
        commit()
        touched()
        return
      }
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      // Exponential so a mouse notch and a trackpad pinch both feel linear.
      if (zoomAround(v.z * Math.exp(-dy * 0.0022), rect, px, py)) {
        flashZooming()
        commit()
        touched()
      }
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [commit, paint, touched, zoomAround])

  // Drag callbacks live in a ref so the window listeners can be attached once.
  const dragHandlers = React.useRef({})
  dragHandlers.current = { commit, paint, touched, onSelect, selectedId }

  const beginDrag = event => {
    if (event.button !== undefined && event.button > 0) return
    if (event.target && event.target.closest && event.target.closest('[data-node-id]')) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const v = viewRef.current
    dragRef.current = {
      px: event.clientX,
      py: event.clientY,
      x: v.x,
      y: v.y,
      z: v.z,
      k: scaleFor(rect, v.z),
      moved: false,
      pointerId: event.pointerId
    }
    if (event.preventDefault) event.preventDefault()
    try {
      svg.setPointerCapture?.(event.pointerId)
    } catch (error) {
      /* capture is a nicety; the window listeners carry the drag anyway */
    }
    if (svg.classList) svg.classList.add('ia-svg-dragging')
  }

  // Window-scoped so the drag survives the pointer crossing the toolbar, the
  // drawer or the window edge — leaving the SVG used to abort the gesture.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return undefined
    const finish = () => {
      const drag = dragRef.current
      const svg = svgRef.current
      if (svg && svg.classList) svg.classList.remove('ia-svg-dragging')
      dragRef.current = null
      if (!drag) return
      const { commit: commitNow, touched: touchedNow, onSelect: selectNow, selectedId: current } = dragHandlers.current
      if (drag.moved) {
        commitNow?.(true)
        touchedNow?.()
      } else if (current && selectNow) {
        selectNow(null)
      }
    }
    const onMove = event => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.pointerId !== undefined && event.pointerId !== undefined && drag.pointerId !== event.pointerId) return
      // A release outside the window shows up as buttons === 0 on the next move.
      // Only trust that once the browser has actually reported a held button, so
      // synthetic events (and browsers that omit `buttons`) still drag.
      if (event.buttons && drag.held !== true) drag.held = true
      if (drag.held === true && event.buttons === 0) {
        finish()
        return
      }
      const dx = event.clientX - drag.px
      const dy = event.clientY - drag.py
      if (!drag.moved && Math.hypot(dx, dy) < 3) return
      drag.moved = true
      // Content follows the cursor: dragging right moves the world right.
      viewRef.current.x = drag.x + dx * drag.k
      viewRef.current.y = drag.y + dy * drag.k
      dragHandlers.current.paint?.()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [])

  const onDoubleClick = event => {
    if (event.target && event.target.closest && event.target.closest('[data-node-id]')) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const factor = event.shiftKey ? 1 / 1.7 : 1.7
    if (zoomAround(viewRef.current.z * factor, rect, event.clientX - rect.left, event.clientY - rect.top)) {
      flashZooming()
      commit(true)
      touched()
    }
  }

  const ordered = React.useMemo(() => {
    const seen = seenRef.current || (seenRef.current = new Set())
    return Array.from(plan.placed.values())
      .sort((a, b) => a.u - b.u || a.gx - b.gx)
      .map(info => {
        const fresh = !seen.has(info.node.id)
        seen.add(info.node.id)
        return { info, fresh }
      })
  }, [plan])

  const notable = node =>
    (node.drift_status && node.drift_status !== 'matched' && node.drift_status !== 'observed' && node.drift_status !== 'doc_only') ||
    node.health_status === 'down' ||
    node.health_status === 'degraded'

  // A big fleet does not need every LED, scan line and packet running forever:
  // keep the decoration where it carries information and leave the rest static.
  const reducedMotion = React.useMemo(() => {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (error) {
      return false
    }
  }, [])
  const lean = reducedMotion || nodes.length > 44

  const dense = nodes.length > 26 && zoom < 1.18
  const primaryKind = node => ['server', 'vm', 'lxc', 'agent', 'model_endpoint'].includes(node.kind)
  const showTitleFor = node =>
    node.id === selectedId || notable(node) || (!dense ? zoom >= 0.78 : primaryKind(node))
  const showAddress = zoom >= 1.25

  const labelHintOf = route => {
    const from = plan.placed.get(route.edge.source_id)
    const to = plan.placed.get(route.edge.target_id)
    return `${(from && from.node && from.node.label) || route.edge.source_id} —${route.edge.relation}→ ${(to && to.node && to.node.label) || route.edge.target_id}`
  }

  return jsx('div', {
    className: 'ia-graph-wrap',
    children: jsxs('svg', {
      className: 'ia-svg',
      ref: svgRef,
      preserveAspectRatio: 'xMidYMid meet',
      onPointerDown: beginDrag,
      onDoubleClick,
      onContextMenu: event => event.preventDefault(),
      children: [
        jsxs('g', {
          className: 'ia-iso',
          transform: `translate(${r2(plan.origin.x)} ${r2(plan.origin.y)})`,
          children: [
            plan.platforms.map((p, i) => jsx(PlatformView, { platform: p, next: plan.platforms[i + 1] }, `plat-${p.t}`)),
            plan.platforms.map(p => jsx(PlatformLabel, { platform: p }, `plat-label-${p.t}`)),
            routed.map(route => {
              const hot =
                Boolean(selectedId) && (route.edge.source_id === selectedId || route.edge.target_id === selectedId)
              const blocked =
                pulseFor &&
                (pulseFor(route.edge.source_id) === 'touch_blocked' || pulseFor(route.edge.target_id) === 'touch_blocked')
              return jsx(
                EdgeView,
                {
                  route,
                  selectedId,
                  burst: Boolean(blocked),
                  labelHint: labelHintOf(route),
                  animated: !lean || Boolean(hot) || Boolean(blocked)
                },
                route.key
              )
            }),
            ordered.map(({ info, fresh }) =>
              jsx(
                IsoNode,
                {
                  node: info.node,
                  info,
                  active: info.node.id === selectedId,
                  pulse: pulseFor(info.node.id),
                  fresh,
                  delay: Math.min(920, info.u * 20),
                  showTitle: showTitleFor(info.node),
                  showAddress,
                  animated: !lean || info.node.id === selectedId || Boolean(pulseFor(info.node.id)) || notable(info.node),
                  onSelect
                },
                info.node.id
              )
            )
          ]
        })
      ]
    })
  })
}

// ── glyphs & marks ─────────────────────────────────────────────────────────
const IsoCubeMark = () =>
  jsxs('svg', {
    className: 'ia-mark',
    width: 18,
    height: 20,
    viewBox: '-16 -11 32 32',
    'aria-hidden': true,
    children: [
      jsx('path', { d: 'M 0 -10 L 15 -1 L 0 8 L -15 -1 Z', className: 'ia-mark-top' }),
      jsx('path', { d: 'M -15 -1 L 0 8 L 0 20 L -15 11 Z', className: 'ia-mark-left' }),
      jsx('path', { d: 'M 15 -1 L 0 8 L 0 20 L 15 11 Z', className: 'ia-mark-right' })
    ]
  })

const LegendGlyph = React.memo(function LegendGlyph({ kind }) {
  const scene = kindScene(kind)
  const c = scene.accent
  const m = scene.mat
  const common = { fill: m, stroke: c, strokeWidth: 1 }
  let inner
  switch (scene.shape) {
    case 'rack':
      inner = [
        jsx('rect', { x: 4, y: 1, width: 10, height: 12, ...common }, 'r'),
        jsx('path', { d: 'M 6 4 H 12 M 6 7 H 12 M 6 10 H 12', stroke: c, strokeWidth: 1, fill: 'none', opacity: 0.8 }, 'p')
      ]
      break
    case 'tower':
      inner = [jsx('rect', { x: 6, y: 1, width: 6, height: 12, ...common }, 'r'), jsx('path', { d: 'M 7.5 4 H 10.5', stroke: c, fill: 'none' }, 'p')]
      break
    case 'tank':
      inner = [
        jsx('rect', { x: 5, y: 3, width: 8, height: 9, ...common }, 'r'),
        jsx('ellipse', { cx: 9, cy: 3, rx: 4, ry: 1.6, fill: 'none', stroke: c }, 'e')
      ]
      break
    case 'cargo':
      inner = [
        jsx('rect', { x: 1, y: 4, width: 16, height: 7, ...common }, 'r'),
        jsx('path', { d: 'M 4.5 4 V 11 M 7.5 4 V 11 M 10.5 4 V 11 M 13.5 4 V 11', stroke: c, strokeWidth: 0.8, fill: 'none', opacity: 0.7 }, 'p')
      ]
      break
    case 'plate':
      inner = jsx('rect', { x: 2, y: 5, width: 14, height: 5, ...common })
      break
    case 'bot':
      inner = [
        jsx('rect', { x: 6, y: 5, width: 6, height: 7, ...common }, 'r'),
        jsx('path', { d: 'M 9 5 V 2', stroke: c, fill: 'none' }, 'p'),
        jsx('circle', { cx: 9, cy: 1.5, r: 1, fill: c }, 'c')
      ]
      break
    case 'orb':
      inner = [
        jsx('circle', { cx: 9, cy: 7, r: 3.2, fill: c }, 'c'),
        jsx('ellipse', { cx: 9, cy: 7, rx: 6.5, ry: 2.2, fill: 'none', stroke: c, opacity: 0.55 }, 'e')
      ]
      break
    case 'clock':
      inner = [
        jsx('circle', { cx: 9, cy: 7, r: 4.6, fill: '#141d2c', stroke: c }, 'c'),
        jsx('path', { d: 'M 9 7 V 3.6', stroke: c, strokeWidth: 1.2, fill: 'none' }, 'p')
      ]
      break
    case 'beacon':
      inner = jsx('path', { d: 'M 9 1.5 L 13.5 12.5 L 4.5 12.5 Z', ...common })
      break
    default:
      inner = [jsx('rect', { x: 4, y: 4, width: 10, height: 6, ...common }, 'r'), jsx('path', { d: 'M 9 5.5 L 11 7 L 9 8.5 L 7 7 Z', fill: c }, 'p')]
  }
  return Array.isArray(inner)
    ? jsxs('svg', { width: 18, height: 14, viewBox: '0 0 18 14', 'aria-hidden': true, children: inner })
    : jsx('svg', { width: 18, height: 14, viewBox: '0 0 18 14', 'aria-hidden': true, children: inner })
})

const LEGEND_KINDS = [
  ['server', 'Server'], ['vm', 'Virtual machine'], ['lxc', 'LXC container'], ['container', 'Docker container'],
  ['service', 'Service'], ['inference', 'Inference server'], ['project', 'Project'], ['agent', 'Hermes agent'],
  ['model_endpoint', 'Model endpoint'], ['cron', 'Cron job'], ['peer', 'Tailnet peer']
]
const LEGEND_LINKS = [
  ['hosts', 'Hosts'], ['depends_on', 'Depends on'], ['uses_model', 'Uses model'],
  ['provides_model', 'Provides model'], ['monitors', 'Monitors'], ['proxies_to', 'Proxies to']
]

// ── page & floating chrome ─────────────────────────────────────────────────
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

async function runWithBusy(setBusy, label, fn) {
  setBusy(label)
  try {
    await fn()
  } catch (err) {
    host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
  } finally {
    setBusy('')
  }
}

function InfraAtlasPage() {
  const [selectedId, setSelectedId] = React.useState(pendingSelect)
  const [filter, setFilter] = React.useState('active')
  const [search, setSearch] = React.useState('')
  const [activity, setActivity] = React.useState([])
  const [pulses, setPulses] = React.useState({})
  const [busy, setBusy] = React.useState('')
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const [interacted, setInteracted] = React.useState(false)
  const mapApi = React.useRef(null)
  const lightTheme = useLightTheme()
  const [policyOpen, setPolicyOpen] = React.useState(false)
  const [legendOpen, setLegendOpen] = React.useState(false)
  const [activityOpen, setActivityOpen] = React.useState(false)

  const { data, isLoading, error, refetch } = useGraph(10000)

  React.useEffect(() => {
    pendingSelect = null
  }, [])

  // The gesture hint is a first-run nudge, not furniture: it retires on first
  // interaction or after a few seconds, whichever comes first.
  React.useEffect(() => {
    if (interacted) return undefined
    const timer = setTimeout(() => setInteracted(true), 9000)
    return () => clearTimeout(timer)
  }, [interacted])

  React.useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        if (policyOpen) setPolicyOpen(false)
        else if (legendOpen) setLegendOpen(false)
        else if (activityOpen) setActivityOpen(false)
        else if (selectedId) setSelectedId(null)
      }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    return undefined
  }, [policyOpen, legendOpen, activityOpen, selectedId])

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
  const fleet = (data && data.fleet) || {}
  const incidents = (data && data.incidents) || []
  const config = (data && data.config) || {}
  const lastSweep = (data && data.last_sweep) || null
  const sessionReads = (data && data.session_reads) || []

  const attentionCount = (counts.changed || 0) + (counts.unregistered || 0) + (counts.stale || 0)
  const activeCount = (counts.matched || 0) + attentionCount

  // A retired entry documents something that no longer exists: drawing it as an
  // empty box on the hardware terrace is noise, and its panel has no telemetry
  // to show. Keep the map to infrastructure that is (or should be) real.
  const isRetired = node => String((node.doc_state && node.doc_state.status) || node.doc_status || '') === 'removed'
  const sceneNodes = nodes.filter(node => !isRetired(node))

  const visible = sceneNodes.filter(node => {
    const group = DRIFT_GROUP[node.drift_status] || 'other'
    if (filter === 'active' && group === 'other') return false
    if (filter === 'matched' && group !== 'matched') return false
    if (filter === 'attention' && group !== 'attention') return false
    if (!search.trim()) return true
    const needle = search.trim().toLowerCase()
    return [node.id, node.label, node.host_ip, node.tailnet_ip, node.systemd_unit, (node.ports || []).join(' ')]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(needle))
  })

  // Fall back to all nodes when a small synthetic fleet has only doc_only/peer items
  const displayNodes = visible.length || search.trim() || filter !== 'active' ? visible : sceneNodes

  const selected = nodes.find(node => node.id === selectedId) || null

  const sweep = () =>
    runWithBusy(setBusy, 'sweep', async () => {
      const summary = await rest('/sweep', { method: 'POST', body: {} })
      await refetch()
      const attn = summary.counts ? summary.counts.changed + summary.counts.unregistered + summary.counts.stale : 0
      host.notify({
        kind: 'info',
        message: `Sweep #${summary.sweep_id} (${summary.duration_ms}ms): ${summary.counts ? summary.counts.matched : 0} matched${attn ? `, ${attn} need attention` : ''}`
      })
    })

  const toggleSetting = (key, value) =>
    runWithBusy(setBusy, key, async () => {
      await host.request('plugins.manage', { action: 'settings', key: ID, values: { [key]: value } })
      await rest('/settings', { method: 'POST', body: { [key]: value } })
      await refetch()
    })

  const nodePulse = nodeId => {
    const pulse = pulses[nodeId]
    if (!pulse) return null
    if (Date.now() - pulse.at > 8000) return null
    return pulse.kind
  }

  const allActivity = activity.length ? activity : (data && data.activity) || []
  const sweepAgo = ago(lastSweep && (lastSweep.ts || lastSweep.finished_at))
  const guardrailMode = config.guardrail_mode || 'block'
  const healMode = config.auto_heal_mode || 'auto'

  return jsxs('div', {
    className: cn('ia-root', lightTheme && 'ia-light'),
    'data-build': BUILD,
    children: [
      jsx('style', { children: CSS }),

      // 1. Full-bleed Isometric Canvas
      jsxs('div', {
        className: 'ia-canvas',
        children: [
          error
            ? jsx('div', { className: 'ia-empty', children: `Could not load infrastructure graph: ${error.message || error}` })
            : isLoading && !nodes.length
              ? jsx('div', { className: 'ia-empty', children: 'Loading infrastructure topology…' })
              : displayNodes.length
                ? jsx(Topology, {
                    nodes: displayNodes,
                    edges,
                    selectedId,
                    onSelect: setSelectedId,
                    pulseFor: nodePulse,
                    zoom,
                    setZoom,
                    offset,
                    setOffset,
                    api: mapApi,
                    onInteract: () => setInteracted(true)
                  })
                : jsx('div', {
                    className: 'ia-empty',
                    children: jsxs('div', {
                      className: 'ia-empty-box',
                      children: [
                        jsx('div', { className: 'ia-empty-title', children: 'No matching nodes in this view' }),
                        jsx('div', { className: 'ia-muted', children: 'Switch filter segments above or clear the search query.' }),
                        jsx('button', {
                          type: 'button',
                          className: 'ia-btn',
                          onClick: () => {
                            setFilter('all')
                            setSearch('')
                          },
                          children: 'Show all nodes'
                        })
                      ]
                    })
                  }),

          // One-line affordance hint; disappears the moment the map is used.
          !interacted && displayNodes.length
            ? jsx('div', {
                className: 'ia-map-hint',
                children: 'drag to pan · scroll to zoom · double-click to zoom in'
              })
            : null
        ]
      }),

      // 2. Unified Floating Top Bar
      jsxs('header', {
        className: 'ia-topbar ia-glass',
        children: [
          jsxs('div', {
            className: 'ia-brand',
            children: [
              jsx(IsoCubeMark, {}),
              jsxs('div', {
                className: 'ia-brand-text',
                children: [
                  jsx('span', { className: 'ia-brand-title', children: 'Infra Atlas' }),
                  jsxs('span', {
                    className: 'ia-brand-meta',
                    children: [
                      fleet.avg_uptime_24h_pct !== undefined && fleet.avg_uptime_24h_pct !== null
                        ? `${pct(fleet.avg_uptime_24h_pct)} 24h`
                        : `${counts.matched || 0} healthy`,
                      ' · ',
                      `swept ${sweepAgo}`
                    ]
                  })
                ]
              })
            ]
          }),

          jsxs('nav', {
            className: 'ia-seg',
            'aria-label': 'Filter topology nodes',
            children: [
              segButton('active', 'Live', activeCount, filter, setFilter),
              segButton('attention', 'Alerts', attentionCount, filter, setFilter, attentionCount > 0 ? 'warn' : ''),
              segButton('matched', 'Synced', counts.matched || 0, filter, setFilter),
              segButton('all', 'All', sceneNodes.length, filter, setFilter)
            ]
          }),

          jsxs('div', {
            className: 'ia-actions',
            children: [
              jsxs('div', {
                className: 'ia-search-wrap',
                children: [
                  jsx('span', { className: 'ia-search-icon', 'aria-hidden': true, children: '⌕' }),
                  jsx('input', {
                    className: 'ia-search',
                    placeholder: 'Search fleet…',
                    value: search,
                    onChange: event => setSearch(event.target.value)
                  }),
                  search
                    ? jsx('button', {
                        type: 'button',
                        className: 'ia-search-clear',
                        title: 'Clear search',
                        onClick: () => setSearch(''),
                        children: '✕'
                      })
                    : null
                ]
              }),

              jsxs('div', {
                className: 'ia-pop-anchor',
                children: [
                  jsxs('button', {
                    type: 'button',
                    className: cn('ia-btn ia-btn-ghost', policyOpen && 'ia-btn-active'),
                    title:
                      guardrailMode === 'off'
                        ? 'Read-before-touch is off: tools can change this infrastructure without reading its registry entry first. Click to change.'
                        : guardrailMode === 'warn'
                          ? 'Read-before-touch is on but only warns: tools may touch a node before its registry entry is read. Click to change.'
                          : 'Read-before-touch is on: tools that touch a node are blocked until its registry entry has been read. Click to change.',
                    onClick: () => {
                      setPolicyOpen(o => !o)
                      setLegendOpen(false)
                    },
                    children: [
                      jsx('span', {
                        className: 'ia-dot',
                        style: {
                          background:
                            guardrailMode === 'block'
                              ? 'var(--ui-success, #10b981)'
                              : guardrailMode === 'warn'
                                ? 'var(--ui-warning, #f59e0b)'
                                : 'var(--muted-foreground, var(--ui-text-quaternary, #6b7280))'
                        }
                      }),
                      guardrailMode === 'off'
                        ? 'Guardrail: off'
                        : guardrailMode === 'warn'
                          ? 'Guardrail: warns'
                          : 'Guardrail: blocking'
                    ]
                  }),
                  policyOpen
                    ? jsxs('div', {
                        className: 'ia-popover ia-glass',
                        children: [
                          jsx('div', { className: 'ia-pop-title', children: 'Read-Before-Touch Guardrail' }),
                          jsx('div', {
                            className: 'ia-pop-desc',
                            children: 'Requires sessions to read a node’s registry entry before running terminal or file mutations on it.'
                          }),
                          jsxs('div', {
                            className: 'ia-choice-row',
                            children: ['block', 'warn', 'off'].map(mode =>
                              jsx('button', {
                                type: 'button',
                                className: cn('ia-choice', guardrailMode === mode && 'ia-choice-on'),
                                onClick: () => toggleSetting('guardrail_mode', mode),
                                children: mode
                              }, mode)
                            )
                          }),
                          jsx('div', { className: 'ia-pop-sep' }),
                          jsx('div', { className: 'ia-pop-title', children: 'Autonomous Downtime Response' }),
                          jsx('div', {
                            className: 'ia-pop-desc',
                            children: 'Controls whether failed probes run the local restart playbook and wake the agent.'
                          }),
                          jsxs('div', {
                            className: 'ia-choice-row',
                            children: [
                              ['auto', 'Auto'],
                              ['playbook_only', 'Playbook'],
                              ['notify_only', 'Notify'],
                              ['off', 'Off']
                            ].map(([mode, label]) =>
                              jsx('button', {
                                type: 'button',
                                className: cn('ia-choice', healMode === mode && 'ia-choice-on'),
                                onClick: () => toggleSetting('auto_heal_mode', mode),
                                children: label
                              }, mode)
                            )
                          }),
                          jsx('div', { className: 'ia-pop-sep' }),
                          jsx('div', { className: 'ia-pop-title', children: 'Background Uptime Watchdog' }),
                          jsx('div', {
                            className: 'ia-pop-desc',
                            children: 'Zero-token Hermes cron pre-check that only wakes the agent when an endpoint is down.'
                          }),
                          jsxs('div', {
                            className: 'ia-choice-row',
                            children: [
                              jsx('button', {
                                type: 'button',
                                className: 'ia-choice',
                                disabled: Boolean(busy),
                                onClick: () =>
                                  runWithBusy(setBusy, 'watchdog', async () => {
                                    const res = await rest('/watchdog', { method: 'POST', body: { enabled: true, interval_min: 2 } })
                                    host.notify({
                                      kind: res && res.ok !== false ? 'info' : 'warning',
                                      message: res && res.ok !== false ? 'Uptime watchdog enabled (every 2m)' : 'Watchdog script installed'
                                    })
                                    await refetch()
                                  }),
                                children: 'Enable (2m)'
                              }),
                              jsx('button', {
                                type: 'button',
                                className: 'ia-choice',
                                disabled: Boolean(busy),
                                onClick: () =>
                                  runWithBusy(setBusy, 'watchdog', async () => {
                                    await rest('/watchdog', { method: 'POST', body: { enabled: false } })
                                    host.notify({ kind: 'info', message: 'Uptime watchdog paused' })
                                    await refetch()
                                  }),
                                children: 'Pause'
                              })
                            ]
                          }),
                          config.registry_path
                            ? jsxs('div', {
                                className: 'ia-pop-foot',
                                children: ['Registry: ', jsx('code', { children: config.registry_path })]
                              })
                            : null
                        ]
                      })
                    : null
                ]
              }),

              jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-primary',
                disabled: busy === 'sweep',
                onClick: sweep,
                children: busy === 'sweep' ? 'Sweeping…' : '↻ Sweep'
              })
            ]
          })
        ]
      }),

      // 3. Floating Incident Banner (only when an outage is active)
      incidents.length
        ? jsx(IncidentBanner, {
            incidents,
            shifted: Boolean(selected),
            onInspect: nodeId => setSelectedId(nodeId),
            onHeal: nodeId => healNode(nodeId, setBusy, refetch)
          })
        : null,

      // 4. Bottom-Left Collapsible Activity Dock
      jsx(ActivityDock, {
        entries: allActivity,
        open: activityOpen,
        setOpen: setActivityOpen,
        compact: Boolean(selected),
        onSelectNode: nodeId => {
          if (nodeId) setSelectedId(nodeId)
        }
      }),

      // 5. Bottom-Right Unified Map Controls & Legend
      jsxs('div', {
        className: cn('ia-map-dock', selected && 'ia-map-dock-shifted'),
        children: [
          legendOpen
            ? jsxs('div', {
                className: 'ia-legend-card ia-glass',
                children: [
                  jsxs('div', {
                    className: 'ia-legend-head',
                    children: [
                      jsx('span', { className: 'ia-pop-title', children: 'Topology Legend' }),
                      jsx('button', { type: 'button', className: 'ia-icon-btn', onClick: () => setLegendOpen(false), children: '✕' })
                    ]
                  }),
                  jsx('div', { className: 'ia-legend-sub', children: '3D Node Silhouettes' }),
                  jsx('div', {
                    className: 'ia-legend-grid',
                    children: LEGEND_KINDS.map(([kind, label]) =>
                      jsxs('div', {
                        className: 'ia-legend-row',
                        children: [jsx(LegendGlyph, { kind }), jsx('span', { children: label })]
                      }, kind)
                    )
                  }),
                  jsx('div', { className: 'ia-legend-sub', children: 'Dependency Traces' }),
                  jsx('div', {
                    className: 'ia-legend-grid',
                    children: LEGEND_LINKS.map(([rel, label]) => {
                      const style = relationStyle(rel)
                      return jsxs('div', {
                        className: 'ia-legend-row',
                        children: [
                          jsx('svg', {
                            width: 18,
                            height: 14,
                            'aria-hidden': true,
                            children: jsx('line', {
                              x1: 1,
                              y1: 7,
                              x2: 17,
                              y2: 7,
                              stroke: style.color,
                              strokeWidth: 2,
                              strokeDasharray: style.dash || undefined
                            })
                          }),
                          jsx('span', { children: label })
                        ]
                      }, rel)
                    })
                  }),
                  jsx('div', {
                    className: 'ia-legend-note',
                    children: `${nodes.length - sceneNodes.length} retired entr${nodes.length - sceneNodes.length === 1 ? 'y' : 'ies'} hidden from the map (still in the registry).`
                  })
                ]
              })
            : null,
          jsxs('div', {
            className: 'ia-map-bar ia-glass',
            children: [
              jsx('button', {
                type: 'button',
                className: 'ia-map-btn',
                title: 'Zoom out (scroll or pinch anywhere on the map)',
                onClick: () => (mapApi.current ? mapApi.current.zoomBy(1 / 1.25) : setZoom(z => Math.max(0.42, z / 1.25))),
                children: '−'
              }),
              jsx('button', {
                type: 'button',
                className: 'ia-map-btn ia-map-pct',
                title: 'Reset view (zoom 100%, pan centred)',
                onClick: () => {
                  if (mapApi.current) mapApi.current.reset()
                  setZoom(1)
                  setOffset({ x: 0, y: 0 })
                },
                children: `${Math.round(zoom * 100)}%`
              }),
              jsx('button', {
                type: 'button',
                className: 'ia-map-btn',
                title: 'Zoom in (scroll up, or double-click the map)',
                onClick: () => (mapApi.current ? mapApi.current.zoomBy(1.25) : setZoom(z => Math.min(2.6, z * 1.25))),
                children: '+'
              }),
              jsx('span', { className: 'ia-map-sep' }),
              jsx('button', {
                type: 'button',
                className: cn('ia-map-btn ia-map-legend', legendOpen && 'ia-btn-active'),
                title: 'Toggle shape & link legend',
                onClick: () => {
                  setLegendOpen(o => !o)
                  setPolicyOpen(false)
                },
                children: '? Legend'
              })
            ]
          })
        ]
      }),

      // 6. Slide-Over Node Inspector Drawer (only open when a node is selected)
      selected
        ? jsx(InspectorDrawer, {
            node: selected,
            busy,
            setBusy,
            onClose: () => setSelectedId(null),
            onSelectNode: nodeId => setSelectedId(nodeId),
            onRefetch: refetch,
            guardrail: guardrailMode,
            sessionReads
          })
        : null
    ]
  })
}

function segButton(key, label, count, active, setActive, tone = '') {
  return jsxs('button', {
    type: 'button',
    className: cn('ia-seg-btn', active === key && 'ia-seg-active', tone && `ia-seg-${tone}`),
    onClick: () => setActive(key),
    children: [
      jsx('span', { children: label }),
      jsx('span', { className: 'ia-seg-count', children: String(count) })
    ]
  })
}

function IncidentBanner({ incidents, shifted, onInspect, onHeal }) {
  const primary = incidents[0]
  if (!primary) return null
  return jsxs('div', {
    className: cn('ia-incident-banner ia-glass', shifted && 'ia-incident-shifted'),
    children: [
      jsx('span', { className: 'ia-incident-pulse' }),
      jsxs('div', {
        className: 'ia-incident-info',
        children: [
          jsxs('div', {
            className: 'ia-incident-line',
            children: [
              jsx('strong', { children: `Incident #${primary.id} · ${primary.node_label || primary.node_id}` }),
              jsx('span', { className: 'ia-badge ia-badge-danger', children: primary.status }),
              incidents.length > 1 ? jsx('span', { className: 'ia-muted', children: `+${incidents.length - 1} more` }) : null
            ]
          }),
          jsx('div', { className: 'ia-incident-err', children: primary.trigger_error || 'Endpoint failed health checks' })
        ]
      }),
      jsxs('div', {
        className: 'ia-incident-btns',
        children: [
          jsx('button', {
            type: 'button',
            className: 'ia-btn ia-btn-ghost',
            onClick: () => onHeal(primary.node_id),
            children: '↻ Heal'
          }),
          jsx('button', {
            type: 'button',
            className: 'ia-btn ia-btn-primary',
            onClick: () => onInspect(primary.node_id),
            children: 'Inspect'
          })
        ]
      })
    ]
  })
}

function ActivityDock({ entries, open, setOpen, compact, onSelectNode }) {
  const rows = (entries || []).slice(0, 18)
  const latest = rows[0] || null
  return jsxs('div', {
    className: 'ia-activity-dock',
    children: [
      open
        ? jsxs('div', {
            className: 'ia-activity-card ia-glass',
            children: [
              jsxs('div', {
                className: 'ia-activity-head',
                children: [
                  jsxs('div', {
                    className: 'ia-activity-head-left',
                    children: [
                      jsx('span', { className: 'ia-live-dot' }),
                      jsx('span', { className: 'ia-pop-title', children: 'Live Activity & Guardrail' })
                    ]
                  }),
                  jsx('button', { type: 'button', className: 'ia-icon-btn', onClick: () => setOpen(false), children: '✕' })
                ]
              }),
              rows.length
                ? jsx('div', {
                    className: 'ia-activity-list',
                    children: rows.map((entry, index) => {
                      const kind = entry.action_kind || 'info'
                      return jsxs('button', {
                        type: 'button',
                        className: cn('ia-activity-row', `ia-act-${kind}`),
                        onClick: () => entry.node_id && onSelectNode(entry.node_id),
                        children: [
                          jsx('span', { className: 'ia-activity-badge', children: kind.replace('touch_', '').replace('_doc', '') }),
                          jsx('span', { className: 'ia-activity-summary', children: entry.summary || entry.tool_name || '' }),
                          jsx('span', { className: 'ia-activity-time', children: ago(entry.ts) })
                        ]
                      }, `act-${entry.id || index}`)
                    })
                  })
                : jsx('div', { className: 'ia-muted ia-pad', children: 'No recent tool activity recorded.' })
            ]
          })
        : null,
      jsxs('button', {
        type: 'button',
        className: cn('ia-activity-pill ia-glass', open && 'ia-btn-active'),
        onClick: () => setOpen(o => !o),
        children: [
          jsx('span', { className: 'ia-live-dot' }),
          jsx('span', { className: 'ia-activity-pill-label', children: 'Activity' }),
          !compact && latest
            ? jsx('span', {
                className: cn('ia-activity-peek', latest.action_kind === 'touch_blocked' && 'ia-peek-danger'),
                children: truncate(latest.summary || latest.node_id || '', 28)
              })
            : null,
          rows.length ? jsx('span', { className: 'ia-seg-count', children: String(rows.length) }) : null
        ]
      })
    ]
  })
}

function InspectorDrawer({ node, busy, setBusy, onClose, onSelectNode, onRefetch, guardrail, sessionReads }) {
  const [tab, setTab] = React.useState('overview')
  const detail = useNode(node ? node.id : null)

  React.useEffect(() => {
    setTab('overview')
  }, [node && node.id])

  const data = detail.data || {}
  const diff = data.diff || []
  const incidents = data.incidents || []
  const probes = data.probe_history || []
  const blast = data.blast_radius || { upstream: [], downstream: [] }
  const item = data.node || node
  const drift = item.drift_status || 'matched'
  const health = item.health_status || 'unknown'

  const activeSession =
    host.state && host.state.focusedSessionId && host.state.focusedSessionId.get
      ? host.state.focusedSessionId.get() || 'desktop'
      : 'desktop'
  const isUnlocked = (sessionReads || []).some(
    r => r.node_id === item.id && (r.session_id === activeSession || r.session_id === 'desktop')
  )

  const doReconcile = action =>
    runWithBusy(setBusy, `reconcile:${item.id}`, async () => {
      await rest('/reconcile', { method: 'POST', body: { node_id: item.id, action } })
      host.notify({ kind: 'info', message: `${item.id}: ${action.replace('_', ' ')} saved to registry` })
      await onRefetch()
      await detail.refetch()
    })

  const doUnlock = () =>
    runWithBusy(setBusy, `unlock:${item.id}`, async () => {
      await rest('/session-unlock', { method: 'POST', body: { session_id: activeSession, node_id: item.id } })
      host.notify({
        kind: 'info',
        message: `Agent actions on ${item.label || item.id} are allowed for the rest of this chat`
      })
      await onRefetch()
    })

  const dispatchBrief = () =>
    runWithBusy(setBusy, `dispatch:${item.id}`, async () => {
      const brief = await rest('/heal', { method: 'POST', body: { node_id: item.id, mode: 'agent_brief' } })
      const sessionId = host.state.focusedSessionId && host.state.focusedSessionId.get ? host.state.focusedSessionId.get() : null
      const sent = host.composer.submit(sessionId ?? null, brief.remediation_brief)
      host.notify({
        kind: sent ? 'info' : 'warning',
        message: sent ? 'Remediation brief sent to active chat' : 'Open a chat to dispatch the brief'
      })
    })

  const needsAdoption = drift === 'changed' || drift === 'unregistered'
  const isDown = health === 'down' || incidents.some(inc => inc.status === 'open' || inc.status === 'healing')
  // A retired entry is documentation of something that is gone, not a node we
  // expect to answer: it has no health, no uptime and nothing to heal.
  const docStatus = String((item.doc_state && item.doc_state.status) || item.doc_status || 'active')
  const isRetired = docStatus === 'removed'

  return jsxs('aside', {
    className: 'ia-drawer ia-glass',
    children: [
      // Drawer Header
      jsxs('div', {
        className: 'ia-drawer-head',
        children: [
          jsxs('div', {
            className: 'ia-drawer-title-row',
            children: [
              jsx('div', { className: 'ia-kind-badge', children: jsx(LegendGlyph, { kind: item.kind }) }),
              jsxs('div', {
                className: 'ia-drawer-titles',
                children: [
                  jsx('div', { className: 'ia-drawer-title', children: item.label || item.id }),
                  jsx('div', {
                    className: 'ia-drawer-sub',
                    children: [item.kind, item.vmid ? `VMID ${item.vmid}` : null, addressOf(item)].filter(Boolean).join(' · ')
                  })
                ]
              }),
              jsx('button', { type: 'button', className: 'ia-icon-btn', title: 'Close inspector (Esc)', onClick: onClose, children: '✕' })
            ]
          }),

          jsxs('div', {
            className: 'ia-badges',
            children: isRetired
              ? [jsx('span', { className: 'ia-badge ia-badge-retired', children: 'Retired · not monitored' }, 'retired')]
              : [
                  jsx('span', {
                    className: 'ia-badge',
                    style: { borderColor: DRIFT_COLOR[drift], color: DRIFT_COLOR[drift] },
                    children: DRIFT_LABEL[drift] || drift
                  }, 'drift'),
                  health !== 'unknown'
                    ? jsx('span', {
                        className: 'ia-badge',
                        style: { borderColor: HEALTH_COLOR[health], color: HEALTH_COLOR[health] },
                        children: health
                      }, 'health')
                    : null,
                  item.uptime_24h_pct !== null && item.uptime_24h_pct !== undefined
                    ? jsx('span', { className: 'ia-badge ia-badge-neutral', children: `${pct(item.uptime_24h_pct)} 24h` }, 'uptime')
                    : null,
                  item.latency_ms
                    ? jsx('span', { className: 'ia-badge ia-badge-neutral', children: `${Math.round(item.latency_ms)} ms` }, 'lat')
                    : null
                ]
          }),

          // Single Contextual Action Bar
          jsxs('div', {
            className: 'ia-drawer-actions',
            children: [
              isRetired
                ? jsx('button', {
                    type: 'button',
                    className: 'ia-btn ia-btn-primary ia-btn-full',
                    disabled: Boolean(busy),
                    onClick: () => doReconcile('adopt_live'),
                    title: 'Set this entry back to status: active and re-adopt whatever the collectors see',
                    children: '↻ Restore to active'
                  })
                : null,
              !isRetired && needsAdoption
                ? jsx('button', {
                    type: 'button',
                    className: 'ia-btn ia-btn-primary ia-btn-full',
                    disabled: Boolean(busy),
                    onClick: () => doReconcile('adopt_live'),
                    title:
                      drift === 'unregistered'
                        ? 'Write a registry entry for this live node so it stops counting as undocumented drift.'
                        : 'Rewrite the registry fields (address, ports, unit) to match what is actually running.',
                    children: drift === 'unregistered' ? '✓ Add to registry' : '✓ Update registry to match live'
                  })
                : null,
              !isRetired && isDown && item.recovery_cmd
                ? jsx('button', {
                    type: 'button',
                    className: 'ia-btn ia-btn-primary ia-btn-full',
                    disabled: Boolean(busy),
                    onClick: () =>
                      healNode(item.id, setBusy, async () => {
                        await onRefetch()
                        await detail.refetch()
                      }),
                    title: `Run the documented recovery command: ${item.recovery_cmd}`,
                    children: '↻ Run recovery command'
                  })
                : null,
              !isRetired && item.registry_path && guardrail !== 'off'
                ? jsx('button', {
                    type: 'button',
                    className: cn('ia-btn ia-btn-ghost ia-btn-flex', isUnlocked && 'ia-btn-unlocked'),
                    disabled: Boolean(busy) || isUnlocked,
                    title: isUnlocked
                      ? 'Agent tool calls may touch this node for the rest of this chat.'
                      : 'The guardrail blocks tools that touch a node until its registry entry has been read. Unlock to lift that for this node until the chat ends.',
                    onClick: doUnlock,
                    children: isUnlocked ? '✓ Agent actions allowed' : '🔓 Allow agent actions'
                  })
                : null,
              jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-ghost ia-btn-flex',
                disabled: Boolean(busy),
                onClick: dispatchBrief,
                title: 'Send context & runbook brief to active chat',
                children: '✦ Ask Hermes'
              })
            ]
          })
        ]
      }),

      // Segmented Tabs
      jsxs('div', {
        className: 'ia-drawer-tabs',
        children: [
          drawerTab('overview', 'Overview', tab, setTab),
          drawerTab('uptime', 'Uptime', tab, setTab),
          drawerTab('runbook', 'Runbook', tab, setTab)
        ]
      }),

      // Tab Content
      jsxs('div', {
        className: 'ia-drawer-body',
        children: [
          tab === 'overview'
            ? jsx(OverviewSection, {
                item,
                diff,
                blast,
                busy,
                doReconcile,
                onSelectNode,
                isRetired
              })
            : null,
          tab === 'uptime'
            ? jsx(UptimeSection, {
                item,
                probes,
                incidents,
                busy,
                setBusy,
                onRefetch,
                detail,
                isRetired
              })
            : null,
          tab === 'runbook'
            ? jsx(RunbookSection, {
                item,
                markdown: data.registry_markdown,
                raw: data
              })
            : null
        ]
      })
    ]
  })
}

function drawerTab(key, label, tab, setTab) {
  return jsx('button', {
    type: 'button',
    className: cn('ia-dtab', tab === key && 'ia-dtab-active'),
    onClick: () => setTab(key),
    children: label
  })
}

function OverviewSection({ item, diff, blast, busy, doReconcile, onSelectNode, isRetired }) {
  const reasons = item.drift_reasons || []
  const upstream = (blast && blast.upstream) || []
  const downstream = (blast && blast.downstream) || []
  // Only render properties that carry a real value: eight rows of em-dashes read
  // as a broken panel, not as "this node has no address of its own".
  const properties = [
    ['Node ID', item.id],
    ['LAN Address', addressOf(item)],
    ['Tailnet IP', item.tailnet_ip],
    ['VMID', item.vmid ? String(item.vmid) : ''],
    ['Managed By', item.managed_by],
    ['Systemd Unit', item.systemd_unit],
    ['Registry Entry', item.registry_path || 'Unregistered'],
    ['Last Seen Alive', item.last_seen_live_at ? ago(item.last_seen_live_at) : ''],
    ['Auto-Heal Policy', item.auto_heal_policy && item.auto_heal_policy !== 'inherit' ? item.auto_heal_policy : ''],
    ['Probe', item.probe]
  ].filter(([, value]) => value !== null && value !== undefined && !['', '—', 'never'].includes(String(value).trim()))

  return jsxs(Fragment, {
    children: [
      // 0. Retired entries have no telemetry to show — say so, don't render blanks.
      isRetired
        ? jsxs('div', {
            className: 'ia-callout ia-callout-muted',
            children: [
              jsx('div', { className: 'ia-callout-title', children: 'Retired entry' }),
              jsx('div', {
                className: 'ia-callout-body',
                children:
                  'The registry marks this entry “removed”, so Infra Atlas does not probe it, page on it or count it in the live fleet. The runbook is kept as history — restore it to active if the node comes back.'
              })
            ]
          })
        : null,

      // 1. Operational Pitfalls Callout (surfaced prominently!)
      item.pitfalls_summary
        ? jsxs('div', {
            className: 'ia-callout ia-callout-warn',
            children: [
              jsx('div', { className: 'ia-callout-title', children: '⚠ Operational Guardrail & Pitfalls' }),
              jsx('div', { className: 'ia-callout-body', children: item.pitfalls_summary })
            ]
          })
        : null,

      // 2. Drift Diff Card (only when drifted)
      !isRetired && (diff.length || (reasons.length && item.drift_status !== 'observed'))
        ? jsxs('div', {
            className: 'ia-section',
            children: [
              jsx('div', { className: 'ia-section-title', children: 'Drift Evidence (Registry vs. Live)' }),
              diff.length
                ? jsx('table', {
                    className: 'ia-table',
                    children: [
                      jsx('thead', {
                        children: jsxs('tr', {
                          children: [
                            jsx('th', { children: 'Field' }),
                            jsx('th', { children: 'Registry' }),
                            jsx('th', { children: 'Live' })
                          ]
                        })
                      }, 'thead'),
                      jsx('tbody', {
                        children: diff.map((row, index) =>
                          jsxs('tr', {
                            children: [
                              jsx('td', { className: 'ia-td-key', children: row.field }),
                              jsx('td', { children: format(row.doc) }),
                              jsx('td', { className: 'ia-td-live', children: format(row.live) })
                            ]
                          }, `diff-${index}`)
                        )
                      }, 'tbody')
                    ]
                  })
                : jsx('ul', {
                    className: 'ia-list',
                    children: reasons.map((reason, index) => jsx('li', { children: reason }, `r-${index}`))
                  })
            ]
          })
        : null,

      // 3. Key-Value Properties Grid
      jsxs('div', {
        className: 'ia-section',
        children: [
          jsx('div', { className: 'ia-section-title', children: 'Node Properties' }),
          properties.length
            ? jsx('div', {
                className: 'ia-prop-grid',
                children: properties.map(([label, value]) => propCard(label, value, label))
              })
            : jsx('div', { className: 'ia-muted', children: 'No live state recorded for this node.' })
        ]
      }),

      // 4. Interactive Blast Radius
      upstream.length || downstream.length
        ? jsxs('div', {
            className: 'ia-section',
            children: [
              jsx('div', { className: 'ia-section-title', children: 'Topology & Blast Radius' }),
              upstream.length
                ? jsxs('div', {
                    className: 'ia-blast-group',
                    children: [
                      jsx('div', { className: 'ia-blast-label', children: '↑ Upstream Hosts & Dependencies' }),
                      jsx('div', {
                        className: 'ia-chip-list',
                        children: upstream.map(dep =>
                          jsxs('button', {
                            type: 'button',
                            className: 'ia-node-chip',
                            onClick: () => onSelectNode(dep.id),
                            children: [
                              jsx(LegendGlyph, { kind: dep.kind }),
                              jsx('span', { children: dep.label || dep.id })
                            ]
                          }, `up-${dep.id}`)
                        )
                      })
                    ]
                  })
                : null,
              downstream.length
                ? jsxs('div', {
                    className: 'ia-blast-group',
                    children: [
                      jsx('div', { className: 'ia-blast-label', children: '↓ Downstream Dependents (Impact)' }),
                      jsx('div', {
                        className: 'ia-chip-list',
                        children: downstream.map(dep =>
                          jsxs('button', {
                            type: 'button',
                            className: 'ia-node-chip',
                            onClick: () => onSelectNode(dep.id),
                            children: [
                              jsx(LegendGlyph, { kind: dep.kind }),
                              jsx('span', { children: dep.label || dep.id })
                            ]
                          }, `dn-${dep.id}`)
                        )
                      })
                    ]
                  })
                : null
            ]
          })
        : null,

      // 5. Subtle Retire Action at bottom if documented and still active
      item.registry_path && !isRetired && item.drift_status !== 'doc_only'
        ? jsx('div', {
            className: 'ia-section-foot',
            children: jsx('button', {
              type: 'button',
              className: 'ia-link-btn',
              disabled: Boolean(busy),
              onClick: () => doReconcile('mark_removed'),
              children: 'Mark entry as decommissioned in registry…'
            })
          })
        : null
    ]
  })
}

function propCard(label, value, key) {
  return jsxs(
    'div',
    {
      className: 'ia-prop',
      children: [
        jsx('div', { className: 'ia-prop-label', children: label }),
        jsx('div', { className: 'ia-prop-val', children: String(value) })
      ]
    },
    key
  )
}

function UptimeSection({ item, probes, incidents, busy, setBusy, onRefetch, detail, isRetired }) {
  const history = probes || []
  const max = Math.max(1, ...history.map(sample => Number(sample.latency_ms) || 0))
  const probeUrl = (item.live_state && item.live_state.probe) || (item.doc_state && item.doc_state.probe) || item.probe || 'None configured'

  if (isRetired) {
    return jsx('div', {
      className: 'ia-muted',
      children: 'Retired entry — no probes, uptime or incidents are tracked. Restore it to active to start monitoring again.'
    })
  }

  const resolveIncident = incidentId =>
    runWithBusy(setBusy, `resolve:${incidentId}`, async () => {
      await rest(`/incidents/${incidentId}/resolve`, { method: 'POST', body: { summary: 'Resolved from Infra Atlas inspector' } })
      host.notify({ kind: 'info', message: `Incident #${incidentId} resolved` })
      await onRefetch()
      await detail.refetch()
    })

  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'ia-metric-strip',
        children: [
          metricBox('24h Uptime', pct(item.uptime_24h_pct)),
          metricBox('Latency', item.latency_ms ? `${Math.round(item.latency_ms)} ms` : '—'),
          metricBox('Fail Streak', String(item.failure_streak || 0))
        ]
      }),

      jsxs('div', {
        className: 'ia-section',
        children: [
          jsxs('div', {
            className: 'ia-section-head-row',
            children: [
              jsx('span', { className: 'ia-section-title', children: 'Probe Latency Sparkline' }),
              jsx('span', { className: 'ia-muted', children: `${history.length} samples` })
            ]
          }),
          history.length
            ? jsx('div', {
                className: 'ia-spark',
                children: history.map((sample, index) =>
                  jsx('span', {
                    className: cn('ia-spark-bar', sample.status !== 'up' && 'ia-spark-down'),
                    style: { height: `${Math.max(10, Math.round(((Number(sample.latency_ms) || 1) / max) * 100))}%` },
                    title: `${sample.status.toUpperCase()} · ${sample.latency_ms ? Math.round(sample.latency_ms) + ' ms' : 'no latency'} · ${sample.detail || ''} (${ago(sample.ts)})`
                  }, `probe-${index}`)
                )
              })
            : jsx('div', { className: 'ia-muted', children: 'No probe samples recorded for this node yet.' })
        ]
      }),

      jsxs('div', {
        className: 'ia-section',
        children: [
          jsx('div', { className: 'ia-section-title', children: 'Health Check & Playbook' }),
          jsxs('div', {
            className: 'ia-prop-grid',
            children: [
              propCard('Probe Endpoint', probeUrl),
              propCard('Recovery Command', item.recovery_cmd || 'Agent-managed'),
              propCard('Last Heal Attempt', ago(item.last_heal_attempt_at)),
              propCard('Latest Detail', (item.live_state && item.live_state.probe_detail) || '—')
            ]
          }),
          item.recovery_cmd
            ? jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-ghost',
                disabled: Boolean(busy),
                onClick: () =>
                  healNode(item.id, setBusy, async () => {
                    await onRefetch()
                    await detail.refetch()
                  }),
                children: '↻ Test Recovery Playbook Now'
              })
            : null
        ]
      }),

      jsxs('div', {
        className: 'ia-section',
        children: [
          jsx('div', { className: 'ia-section-title', children: 'Incident History' }),
          incidents.length
            ? jsx('div', {
                className: 'ia-inc-cards',
                children: incidents.map(incident =>
                  jsxs('div', {
                    className: 'ia-inc-card',
                    children: [
                      jsxs('div', {
                        className: 'ia-inc-card-head',
                        children: [
                          jsx('strong', { children: `#${incident.id} · ${incident.status}` }),
                          jsx('span', { className: 'ia-muted', children: ago(incident.started_at || incident.opened_at) }),
                          incident.status !== 'resolved'
                            ? jsx('button', {
                                type: 'button',
                                className: 'ia-btn ia-btn-xs',
                                disabled: Boolean(busy),
                                onClick: () => resolveIncident(incident.id),
                                children: 'Resolve'
                              })
                            : null
                        ]
                      }),
                      jsx('div', { className: 'ia-inc-card-err', children: incident.trigger_error }),
                      incident.resolution_summary
                        ? jsx('div', { className: 'ia-inc-card-res', children: `↳ ${incident.resolution_summary}` })
                        : null
                    ]
                  }, `inc-${incident.id}`)
                )
              })
            : jsx('div', { className: 'ia-muted', children: 'Zero downtime incidents recorded.' })
        ]
      })
    ]
  })
}

function metricBox(label, value) {
  return jsxs('div', {
    className: 'ia-metric',
    children: [
      jsx('div', { className: 'ia-metric-val', children: value }),
      jsx('div', { className: 'ia-metric-lbl', children: label })
    ]
  })
}

function RunbookSection({ item, markdown, raw }) {
  const [showRaw, setShowRaw] = React.useState(false)
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'ia-section-head-row',
        children: [
          jsx('span', { className: 'ia-section-title', children: item.registry_path || 'Node Payload' }),
          jsx('button', {
            type: 'button',
            className: 'ia-link-btn',
            onClick: () => setShowRaw(r => !r),
            children: showRaw ? 'Show Runbook Markdown' : 'View Raw JSON'
          })
        ]
      }),
      showRaw
        ? jsx('pre', { className: 'ia-runbook ia-json', children: JSON.stringify(raw || {}, null, 2) })
        : item.registry_path
          ? jsx('pre', { className: 'ia-runbook', children: markdown || 'Loading runbook…' })
          : jsx('div', {
              className: 'ia-muted',
              children: 'This node does not have a Markdown registry entry yet. Click "Register in KB" above to create one.'
            })
    ]
  })
}

// ── status bar chip ────────────────────────────────────────────────────────
function AtlasChip() {
  const { data } = useGraph(15000)
  const [flash, setFlash] = React.useState('')
  const counts = (data && data.counts) || {}
  const incidents = ((data && data.incidents) || []).length
  const total = counts.total || 0
  const healthy = counts.matched || 0
  const attention = (counts.changed || 0) + (counts.unregistered || 0) + (counts.stale || 0)

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
    ? `${incidents ? '! ' : '◉ '}Atlas ${healthy} ok${attention ? ` · ${attention} drift` : ''}${incidents ? ` · ${incidents} down` : ''}`
    : '◉ Atlas'
  return jsx('button', {
    type: 'button',
    className: cn('ia-chip', incidents && 'ia-chip-alert', flash === 'block' && 'ia-chip-blocked'),
    title: flash === 'block' ? 'Infra Atlas — a tool call was blocked: read the registry entry first' : 'Infra Atlas — open the infrastructure graph',
    onClick: () => host.navigate(PAGE_PATH),
    children: flash === 'block' ? `! ${label}` : label
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
    className: 'ia-card ia-glass',
    children: [
      jsxs('div', {
        className: 'ia-card-head',
        children: [
          jsx('span', { className: 'ia-dot', style: { background: HEALTH_COLOR[node.health_status] || HEALTH_COLOR.unknown } }),
          jsx('strong', { children: node.label || node.id }),
          jsx('span', { className: 'ia-badge', style: { borderColor: DRIFT_COLOR[drift], color: DRIFT_COLOR[drift] }, children: DRIFT_LABEL[drift] || drift }),
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
            className: 'ia-btn ia-btn-ghost',
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
  const { data, refetch } = useGraph(15000)
  const nodes = ((data && data.nodes) || []).filter(
    node => node.drift_status && node.drift_status !== 'matched' && node.drift_status !== 'doc_only' && node.drift_status !== 'observed'
  )
  const adoptable = nodes.filter(node => node.drift_status === 'changed' || node.drift_status === 'unregistered')
  const incidents = (data && data.incidents) || []
  return jsxs('div', {
    className: 'ia-card ia-glass',
    children: [
      jsxs('div', {
        className: 'ia-card-head',
        children: [
          jsx('strong', { children: 'Fleet Drift Summary' }),
          jsx('span', { className: 'ia-muted', children: `${nodes.length} need attention` }),
          incidents.length ? jsx('span', { className: 'ia-badge ia-badge-danger', children: `${incidents.length} incident(s)` }) : null
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
        : jsx('div', { className: 'ia-muted', children: 'Registry and live fleet agree across all monitored nodes.' }),
      jsxs('div', {
        className: 'ia-row',
        children: [
          jsx('button', { type: 'button', className: 'ia-btn ia-btn-ghost', onClick: () => host.navigate(PAGE_PATH), children: 'Open Infra Atlas' }),
          adoptable.length
            ? jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-ghost',
                onClick: async () => {
                  try {
                    for (const item of adoptable) {
                      await rest('/reconcile', { method: 'POST', body: { node_id: item.id, action: 'adopt_live' } })
                    }
                    await refetch()
                    host.notify({ kind: 'info', message: `Adopted ${adoptable.length} drifted node(s) into the registry` })
                  } catch (err) {
                    host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
                  }
                },
                children: `✓ Reconcile All (${adoptable.length})`
              })
            : null,
          jsx('button', {
            type: 'button',
            className: 'ia-btn ia-btn-primary',
            onClick: async () => {
              try {
                await rest('/sweep', { method: 'POST', body: {} })
                await refetch()
                host.notify({ kind: 'info', message: 'Sweep completed — graph refreshed' })
              } catch (err) {
                host.notify({ kind: 'error', message: `Infra Atlas: ${err.message || err}` })
              }
            },
            children: '↻ Sweep Now'
          })
        ]
      })
    ]
  })
}

// ── styles ─────────────────────────────────────────────────────────────────
const CSS = `
/* ── layout & glassmorphic surfaces ──────────────────────────────────────── */
.ia-root {
  /* The diorama derives every colour from the two values the plugin host gives us
     (--card surface, --foreground ink), so it is correct in a dark *and* a light
     theme without guessing which one is on. No hard-coded light palette to drift. */
  --ia-void: color-mix(in srgb, var(--card, #0b1120) 96%, var(--foreground, #e2e8f0) 4%);
  --ia-void-glow: color-mix(in srgb, var(--foreground, #cbd5e1) 5%, transparent);
  --ia-mat: color-mix(in srgb, var(--card, #0f1523) 72%, var(--foreground, #e2e8f0) 28%);
  --ia-shade-top: #ffffff;
  --ia-shade-side: #000000;
  --ia-ink: var(--foreground, #e6ebf5);
  --ia-ink-muted: color-mix(in srgb, var(--foreground, #e2e8f0) 72%, transparent);
  --ia-halo: color-mix(in srgb, var(--card, #0b1120) 92%, transparent);
  --ia-halo-soft: color-mix(in srgb, var(--card, #0b1120) 78%, transparent);
  --ia-grid: color-mix(in srgb, var(--foreground, #cbd5e1) 16%, transparent);
  --ia-plat-edge: color-mix(in srgb, var(--foreground, #cbd5e1) 20%, transparent);
  --ia-detail: color-mix(in srgb, var(--foreground, #e2e8f0) 16%, transparent);
  --ia-groove: rgba(0, 0, 0, 0.34);
  --ia-shadow: rgba(0, 0, 0, 0.34);
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--foreground, var(--ui-text-primary, #e2e8f0));
  background: radial-gradient(ellipse at 50% 35%, var(--ia-void-glow) 0%, var(--card, var(--ui-bg-primary, #090d16)) 78%);
  user-select: none;
}

/* Light theme only tunes the things that genuinely differ: shadows and the glow.
   Bodies, ink and halos already derive from --card/--foreground. */
.ia-root.ia-light {
  --ia-void: color-mix(in srgb, var(--card, #ffffff) 97%, var(--foreground, #1b2432) 3%);
  --ia-void-glow: color-mix(in srgb, var(--foreground, #1b2432) 4%, transparent);
  --ia-mat: color-mix(in srgb, var(--card, #ffffff) 74%, var(--foreground, #1b2432) 26%);
  --ia-shade-side: color-mix(in srgb, var(--foreground, #1b2432) 70%, var(--card, #ffffff));
  --ia-shadow: rgba(20, 32, 54, 0.18);
  --ia-groove: rgba(20, 32, 54, 0.28);
}

.ia-glass {
  background: color-mix(in srgb, var(--card, var(--ui-bg-secondary, #0f1523)) 86%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.14));
  box-shadow: 0 10px 30px -6px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.ia-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.ia-graph-wrap { position: absolute; inset: 0; contain: strict; }
.ia-svg {
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.ia-svg:active, .ia-svg-dragging { cursor: grabbing; }
/* Labels are the expensive part of a viewBox change (text re-rasterises every
   frame). Hide them while the camera moves, exactly like a map tiles out. */
.ia-svg-dragging .ia-node-title,
.ia-svg-dragging .ia-node-sub2,
.ia-svg-dragging .ia-plat-label,
.ia-svg-zooming .ia-node-sub2,
.ia-svg-zooming .ia-plat-label { opacity: 0; }
.ia-svg-dragging .ia-beacon, .ia-svg-zooming .ia-beacon { animation: none; }
.ia-map-hint {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  z-index: 18;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 10.5px;
  letter-spacing: 0.01em;
  color: var(--muted-foreground, var(--ui-text-tertiary, #94a3b8));
  background: color-mix(in srgb, var(--ia-void, #080c16) 72%, transparent);
  border: 1px solid rgba(148, 163, 184, 0.16);
  pointer-events: none;
  animation: ia-fade 0.4s ease 1.2s both;
}

/* ── top floating bar ────────────────────────────────────────────────────── */
.ia-topbar {
  position: absolute;
  top: 12px;
  left: 16px;
  right: 16px;
  height: 44px;
  box-sizing: border-box;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  border-radius: 12px;
  flex-wrap: nowrap;
}

.ia-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.ia-mark-top { fill: #38bdf8; }
.ia-mark-left { fill: #0284c7; }
.ia-mark-right { fill: #0369a1; }
.ia-brand-text { display: flex; flex-direction: column; gap: 0; white-space: nowrap; }
.ia-brand-title { font-weight: 600; font-size: 12.5px; letter-spacing: -0.01em; color: var(--foreground, var(--ui-text-primary, #f1f5f9)); line-height: 1.15; }
.ia-brand-meta { font-size: 10px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); font-variant-numeric: tabular-nums; line-height: 1.15; }

/* ── segmented filter pills ──────────────────────────────────────────────── */
.ia-seg {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.1);
  flex: 0 0 auto;
}
.ia-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ia-seg-btn:hover { color: var(--foreground, var(--ui-text-primary, #f1f5f9)); background: rgba(255, 255, 255, 0.04); }
.ia-seg-active {
  background: rgba(56, 189, 248, 0.16);
  color: color-mix(in srgb, var(--accent, #38bdf8) 62%, var(--foreground, #e2e8f0));
  box-shadow: inset 0 0 0 1px rgba(56, 189, 248, 0.32);
}
.ia-seg-warn .ia-seg-count {
  background: rgba(245, 158, 11, 0.22);
  color: color-mix(in srgb, #f59e0b 62%, var(--foreground, #e2e8f0));
}
.ia-seg-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.12);
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  font-variant-numeric: tabular-nums;
}

/* ── top right controls ──────────────────────────────────────────────────── */
.ia-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ia-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.ia-search-icon {
  position: absolute;
  left: 9px;
  font-size: 12px;
  color: var(--muted-foreground, var(--ui-text-quaternary, #64748b));
  pointer-events: none;
}
.ia-search {
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 8px;
  color: var(--foreground, var(--ui-text-primary, #f1f5f9));
  padding: 5px 20px 5px 24px;
  font-size: 11px;
  width: 116px;
  outline: none;
  transition: border-color 0.15s ease, width 0.2s ease;
}
.ia-search:focus {
  border-color: rgba(56, 189, 248, 0.55);
  width: 148px;
}
.ia-search::placeholder { color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); }
.ia-search-clear {
  position: absolute;
  right: 6px;
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ui-text-quaternary, #64748b));
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
}
.ia-search-clear:hover { color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }

/* ── buttons & badges ────────────────────────────────────────────────────── */
.ia-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(30, 41, 59, 0.65);
  color: var(--foreground, var(--ui-text-primary, #e2e8f0));
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}
.ia-btn:hover:not(:disabled) {
  background: rgba(51, 65, 85, 0.75);
  border-color: rgba(148, 163, 184, 0.3);
}
.ia-btn:disabled { opacity: 0.5; cursor: default; }
.ia-btn-primary {
  background: linear-gradient(180deg, #0284c7 0%, #0369a1 100%);
  border-color: rgba(125, 211, 252, 0.35);
  color: #f8fafc;
  font-weight: 600;
}
.ia-btn-primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%);
  border-color: rgba(125, 211, 252, 0.55);
}
.ia-btn-ghost {
  background: rgba(15, 23, 42, 0.45);
}
.ia-btn-active {
  border-color: rgba(56, 189, 248, 0.55);
  background: rgba(56, 189, 248, 0.12);
}
.ia-btn-unlocked {
  border-color: rgba(16, 185, 129, 0.4);
  color: #6ee7b7;
}
.ia-btn-full { flex: 1 1 100%; }
.ia-btn-flex { flex: 1 1 0; }
.ia-btn-xs { padding: 2px 8px; font-size: 10.5px; border-radius: 6px; }

.ia-icon-btn {
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ui-text-quaternary, #64748b));
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
}
.ia-icon-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }

.ia-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  display: inline-block;
  flex: 0 0 7px;
}

.ia-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(15, 23, 42, 0.5);
}
.ia-badge-neutral {
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  border-color: rgba(148, 163, 184, 0.18);
  text-transform: none;
}
.ia-badge-danger {
  color: color-mix(in srgb, #ef4444 58%, var(--foreground, #e2e8f0));
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.12);
}
.ia-badge-retired {
  color: var(--muted-foreground, var(--ui-text-tertiary, #94a3b8));
  border-color: rgba(148, 163, 184, 0.28);
  background: rgba(148, 163, 184, 0.08);
  text-transform: none;
  letter-spacing: 0.01em;
  font-weight: 500;
}

/* ── policy popover ──────────────────────────────────────────────────────── */
.ia-pop-anchor { position: relative; }
.ia-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 280px;
  padding: 12px;
  border-radius: 12px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ia-pop-title { font-size: 11px; font-weight: 600; color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }
.ia-pop-desc { font-size: 11px; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); line-height: 1.4; }
.ia-pop-sep { height: 1px; background: rgba(148, 163, 184, 0.12); margin: 2px 0; }
.ia-pop-foot { font-size: 10px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ia-choice-row { display: flex; gap: 4px; }
.ia-choice {
  flex: 1 1 0;
  padding: 5px 6px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(15, 23, 42, 0.55);
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  font-size: 11px;
  font-weight: 500;
  text-transform: capitalize;
  cursor: pointer;
}
.ia-choice:hover { color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }
.ia-choice-on {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.5);
  color: color-mix(in srgb, var(--accent, #38bdf8) 62%, var(--foreground, #e2e8f0));
}

/* ── floating incident banner ────────────────────────────────────────────── */
.ia-incident-banner {
  position: absolute;
  top: 64px;
  left: 16px;
  z-index: 19;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-radius: 10px;
  border-color: rgba(239, 68, 68, 0.45);
  background: color-mix(in srgb, rgba(127, 29, 29, 0.65) 75%, var(--card, var(--ui-bg-secondary, #0f1523)));
  max-width: min(520px, calc(100% - 32px));
}
.ia-incident-shifted {
  max-width: calc(100% - 376px);
}
.ia-incident-pulse {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #ef4444;
  box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.25);
  animation: ia-beacon-hard 1.4s ease-in-out infinite;
  flex: 0 0 9px;
}
.ia-incident-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ia-incident-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ia-incident-err { font-size: 11px; color: color-mix(in srgb, #ef4444 55%, var(--foreground, #e2e8f0)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ia-incident-btns { display: flex; gap: 6px; margin-left: 8px; }

/* ── bottom-left activity dock ───────────────────────────────────────────── */
.ia-activity-dock {
  position: absolute;
  left: 16px;
  bottom: 16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.ia-activity-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  color: var(--foreground, var(--ui-text-primary, #e2e8f0));
  font-size: 11.5px;
  max-width: 270px;
  cursor: pointer;
}
.ia-activity-pill:hover { border-color: rgba(148, 163, 184, 0.3); }
.ia-activity-pill-label { font-weight: 600; flex: 0 0 auto; }
.ia-activity-peek { color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ia-peek-danger { color: color-mix(in srgb, #ef4444 58%, var(--foreground, #e2e8f0)); }
.ia-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #38bdf8;
  animation: ia-beacon-soft 2s ease-in-out infinite;
}
.ia-activity-card {
  width: 400px;
  max-width: calc(100vw - 32px);
  max-height: 280px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ia-activity-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.ia-activity-head-left { display: flex; align-items: center; gap: 8px; }
.ia-activity-list {
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ia-activity-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.ia-activity-row:hover { background: rgba(255, 255, 255, 0.05); }
.ia-activity-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.15);
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  flex: 0 0 auto;
}
.ia-act-touch_blocked .ia-activity-badge { background: rgba(239, 68, 68, 0.22); color: color-mix(in srgb, #ef4444 58%, var(--foreground, #e2e8f0)); }
.ia-act-touch_allowed .ia-activity-badge { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
.ia-act-read_doc .ia-activity-badge { background: rgba(6, 182, 212, 0.2); color: #67e8f9; }
.ia-activity-summary { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ia-activity-time { flex: 0 0 auto; font-size: 10px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); font-variant-numeric: tabular-nums; }

/* ── bottom-right map controls & legend ──────────────────────────────────── */
.ia-map-dock {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  transition: right 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.ia-map-dock-shifted { right: 358px; }
.ia-map-bar {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 10px;
}
.ia-map-btn {
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  padding: 4px 9px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ia-map-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }
.ia-map-pct { font-size: 10.5px; font-variant-numeric: tabular-nums; min-width: 44px; }
.ia-map-legend { font-size: 11px; font-weight: 500; }
.ia-map-sep { width: 1px; height: 16px; background: rgba(148, 163, 184, 0.16); margin: 0 2px; }

.ia-legend-card {
  width: 260px;
  padding: 12px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ia-legend-head { display: flex; align-items: center; justify-content: space-between; }
.ia-legend-sub { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); }
.ia-legend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; }
.ia-legend-row { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); white-space: nowrap; }
.ia-legend-note { font-size: 10px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); line-height: 1.35; padding-top: 2px; border-top: 1px solid rgba(148, 163, 184, 0.12); }

/* ── slide-over node inspector drawer ────────────────────────────────────── */
.ia-drawer {
  position: absolute;
  top: 64px;
  right: 16px;
  bottom: 16px;
  width: 332px;
  max-width: calc(100vw - 32px);
  z-index: 25;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: ia-drawer-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes ia-drawer-in {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}
.ia-drawer-head {
  padding: 14px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.ia-drawer-title-row { display: flex; align-items: flex-start; gap: 10px; }
.ia-kind-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.16);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
}
.ia-drawer-titles { flex: 1 1 auto; min-width: 0; }
.ia-drawer-title { font-size: 14px; font-weight: 600; color: var(--foreground, var(--ui-text-primary, #f8fafc)); line-height: 1.25; word-break: break-word; }
.ia-drawer-sub { font-size: 11px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); margin-top: 2px; }
.ia-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.ia-drawer-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.ia-drawer-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 14px;
  background: rgba(15, 23, 42, 0.35);
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.ia-dtab {
  flex: 1 1 0;
  padding: 5px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}
.ia-dtab:hover { color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }
.ia-dtab-active {
  background: rgba(56, 189, 248, 0.16);
  color: color-mix(in srgb, var(--accent, #38bdf8) 62%, var(--foreground, #e2e8f0));
  box-shadow: inset 0 0 0 1px rgba(56, 189, 248, 0.3);
}

.ia-drawer-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  user-select: text;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.24) transparent;
}
.ia-drawer-body::-webkit-scrollbar, .ia-activity-list::-webkit-scrollbar { width: 6px; }
.ia-drawer-body::-webkit-scrollbar-track, .ia-activity-list::-webkit-scrollbar-track { background: transparent; }
.ia-drawer-body::-webkit-scrollbar-thumb, .ia-activity-list::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.22); border-radius: 999px; }
.ia-drawer-body::-webkit-scrollbar-thumb:hover, .ia-activity-list::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.4); }

.ia-section { display: flex; flex-direction: column; gap: 8px; }
.ia-section-head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ia-section-title { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); }
.ia-section-foot { padding-top: 4px; border-top: 1px solid rgba(148, 163, 184, 0.1); }

.ia-callout {
  padding: 10px 12px;
  border-radius: 9px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ia-callout-warn {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.32);
}
.ia-callout-title { font-size: 10.5px; font-weight: 600; color: color-mix(in srgb, #f59e0b 62%, var(--foreground, #e2e8f0)); }
.ia-callout-body { font-size: 11.5px; color: var(--foreground, #e2e8f0); line-height: 1.45; }
.ia-callout-muted {
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid rgba(148, 163, 184, 0.2);
}
.ia-callout-muted .ia-callout-title { color: var(--muted-foreground, var(--ui-text-secondary, #cbd5e1)); }
.ia-callout-muted .ia-callout-body { color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); }

.ia-prop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.ia-prop {
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.45);
  border: 1px solid rgba(148, 163, 184, 0.1);
  min-width: 0;
}
.ia-prop-label { font-size: 9.5px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); text-transform: uppercase; letter-spacing: 0.04em; }
.ia-prop-val { font-size: 11.5px; font-weight: 500; color: var(--foreground, var(--ui-text-primary, #e2e8f0)); margin-top: 2px; overflow-wrap: anywhere; }

.ia-blast-group { display: flex; flex-direction: column; gap: 5px; }
.ia-blast-label { font-size: 10.5px; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); }
.ia-chip-list { display: flex; flex-wrap: wrap; gap: 5px; }
.ia-node-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.16);
  color: var(--foreground, var(--ui-text-primary, #e2e8f0));
  font-size: 11px;
  cursor: pointer;
}
.ia-node-chip:hover { border-color: rgba(56, 189, 248, 0.5); background: rgba(56, 189, 248, 0.1); }

.ia-metric-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.ia-metric {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.45);
  border: 1px solid rgba(148, 163, 184, 0.1);
}
.ia-metric-val { font-size: 15px; font-weight: 700; color: var(--foreground, var(--ui-text-primary, #f8fafc)); font-variant-numeric: tabular-nums; }
.ia-metric-lbl { font-size: 9.5px; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }

.ia-spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 48px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.45);
  border: 1px solid rgba(148, 163, 184, 0.1);
}
.ia-spark-bar { flex: 1 1 0; background: #38bdf8; border-radius: 2px; opacity: 0.85; min-height: 4px; }
.ia-spark-down { background: #ef4444; opacity: 0.95; }

.ia-inc-cards { display: flex; flex-direction: column; gap: 6px; }
.ia-inc-card {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.45);
  border: 1px solid rgba(148, 163, 184, 0.12);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ia-inc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; }
.ia-inc-card-err { font-size: 11px; color: color-mix(in srgb, #ef4444 58%, var(--foreground, #e2e8f0)); }
.ia-inc-card-res { font-size: 11px; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); }

.ia-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.ia-table th { text-align: left; font-weight: 600; font-size: 9.5px; text-transform: uppercase; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); padding: 4px 6px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
.ia-table td { padding: 5px 6px; border-top: 1px solid rgba(148, 163, 184, 0.08); vertical-align: top; overflow-wrap: anywhere; }
.ia-td-key { font-weight: 500; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); }
.ia-td-live { color: #7dd3fc; }

.ia-runbook {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.12);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--foreground, var(--ui-text-primary, #e2e8f0));
}
.ia-json { font-size: 10px; }

.ia-link-btn {
  border: none;
  background: transparent;
  color: #38bdf8;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.ia-link-btn:hover { text-decoration: underline; }

.ia-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8)); }
.ia-muted { color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); font-size: 11px; }
.ia-pad { padding: 12px; }
.ia-row { display: flex; gap: 6px; flex-wrap: wrap; }
.ia-empty { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; text-align: center; color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); }
.ia-empty-box { display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 320px; }
.ia-empty-title { font-size: 13px; font-weight: 600; color: var(--foreground, var(--ui-text-primary, #e2e8f0)); }

/* ── status bar chip & inline cards ──────────────────────────────────────── */
.ia-chip {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  color: var(--muted-foreground, var(--ui-text-secondary, #94a3b8));
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.22);
  cursor: pointer;
}
.ia-chip:hover { color: var(--foreground, var(--ui-text-primary, #f1f5f9)); }
.ia-chip-alert { color: #fca5a5; border-color: rgba(239, 68, 68, 0.5); }
.ia-chip-blocked { color: #fca5a5; animation: ia-chip-flash 0.9s ease-in-out 4; }
@keyframes ia-chip-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

.ia-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 11.5px;
}
.ia-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ia-card-sub { color: var(--muted-foreground, var(--ui-text-quaternary, #64748b)); font-size: 11px; }

/* ── isometric scene (untouched 3D diorama styling) ──────────────────────── */
.ia-plat { animation: ia-rise 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) both; }
.ia-plat-top { fill: color-mix(in srgb, var(--plat, #333a4a) 92%, var(--ia-shade-top, #ffffff)); }
.ia-plat-left { fill: color-mix(in srgb, var(--plat, #333a4a) 68%, var(--ia-shade-side, #000000)); }
.ia-plat-right { fill: color-mix(in srgb, var(--plat, #333a4a) 44%, var(--ia-shade-side, #000000)); }
/* Tier tints ride on the theme-derived body colour, so a light theme gets light
   terraces (and dark ink stays readable) without a second palette. */
.ia-plat-0 { --plat: color-mix(in srgb, var(--ia-mat, #3d3a47) 93%, #8b7bd8 7%); }
.ia-plat-1 { --plat: color-mix(in srgb, var(--ia-mat, #353c50) 93%, #4f8fd8 7%); }
.ia-plat-2 { --plat: color-mix(in srgb, var(--ia-mat, #3b3550) 93%, #b06bd0 7%); }
.ia-plat-3 { --plat: color-mix(in srgb, var(--ia-mat, #2f4744) 93%, #3fb6a8 7%); }
.ia-plat-riser { fill: color-mix(in srgb, var(--plat, #333a4a) 34%, var(--ia-shade-side, #000000)); }
.ia-plat-grid { fill: none; stroke: var(--ia-grid, rgba(190, 205, 235, 0.13)); stroke-width: 1; }
.ia-plat-edge { fill: none; stroke: var(--ia-plat-edge, rgba(220, 235, 255, 0.16)); stroke-width: 1.1; }
.ia-plat-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.22em; fill: var(--ia-ink, rgba(235, 242, 255, 0.78)); paint-order: stroke; stroke: var(--ia-halo-soft, rgba(8, 10, 16, 0.75)); stroke-width: 2.2px; }

.ia-edge-line { fill: none; stroke: var(--edge-c, #96a0b5); stroke-width: var(--ew, 1.4); stroke-opacity: 0.78; stroke-linecap: round; animation: ia-flow var(--flow-dur, 24s) linear infinite; }
.ia-edge:hover .ia-edge-line { stroke-opacity: 1; stroke-width: calc(var(--ew, 1.4) + 0.9); }
.ia-edge-hot .ia-edge-line { stroke-opacity: 1; stroke-width: calc(var(--ew, 1.4) + 0.8); }
.ia-edge-dim { opacity: 0.13; transition: opacity 0.3s ease; }
.ia-edge { transition: opacity 0.3s ease; }
.ia-edge-head { fill: var(--edge-c, #96a0b5); fill-opacity: 0.85; }
.ia-edge-hit { fill: none; stroke: transparent; stroke-width: 11; pointer-events: stroke; cursor: pointer; }
.ia-packet-core { fill: var(--edge-c, #96a0b5); }
.ia-packet-halo { fill: none; stroke: var(--edge-c, #96a0b5); stroke-width: 1; opacity: 0.45; }
.ia-burst circle { fill: var(--ui-danger, #ef4444); opacity: 0; animation: ia-burst-fade 1.7s ease-out 3; }

.ia-node { cursor: pointer; --mat: color-mix(in srgb, var(--ia-mat, #454c5e) 86%, var(--acc, #8892a6) 14%); }

/* Inference server: spinning fans and a heat shimmer. */
.ia-fan-blades { transform-box: view-box; transform-origin: 0 0; animation: ia-spin 2.6s linear infinite; }
.ia-fan-rim { fill: none; stroke-width: 1; opacity: 0.75; }
.ia-fan-hub { opacity: 0.9; }
.ia-fan-blade { stroke: rgba(226, 232, 240, 0.55); stroke-width: 1.1; stroke-linecap: round; }
.ia-heat { fill: none; stroke-width: 1.2; opacity: 0.28; animation: ia-heat-pulse 3.4s ease-in-out infinite; }
@keyframes ia-spin { to { transform: rotate(360deg); } }
@keyframes ia-heat-pulse { 0%, 100% { opacity: 0.12; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.06); } }

/* A lean fleet: decoration is data. Everything else holds still so panning a
   hundred nodes does not animate a hundred independent compositor layers. */
.ia-still, .ia-still * { animation: none !important; }
.ia-edge-still .ia-edge-line { animation: none; stroke-dashoffset: 0; }
.ia-node-retired .ia-lift { opacity: 0.45; }
.ia-node-retired .ia-beacon { display: none; }
.ia-node-retired:hover .ia-lift { opacity: 0.85; }
.ia-lift { transition: transform 0.18s ease, filter 0.18s ease; }
.ia-node:hover .ia-lift { transform: translateY(-2.5px); }
.ia-node-active .ia-lift { transform: translateY(-5px); }
.ia-f-top { fill: color-mix(in srgb, var(--mat, #424a5e) 84%, var(--ia-shade-top, #ffffff)); stroke: var(--ia-detail, rgba(255, 255, 255, 0.09)); stroke-width: 0.6; }
.ia-f-left { fill: color-mix(in srgb, var(--mat, #424a5e) 74%, var(--ia-shade-side, #000000)); stroke: var(--ia-detail, rgba(255, 255, 255, 0.05)); stroke-width: 0.6; }
.ia-f-right { fill: color-mix(in srgb, var(--mat, #424a5e) 50%, var(--ia-shade-side, #000000)); stroke: var(--ia-detail, rgba(255, 255, 255, 0.04)); stroke-width: 0.6; }
.ia-f-back { fill: color-mix(in srgb, var(--mat, #424a5e) 34%, var(--ia-shade-side, #000000)); stroke: none; }
.ia-detail { stroke: var(--ia-detail, rgba(255, 255, 255, 0.14)); stroke-width: 1; fill: none; }
.ia-groove { stroke: var(--ia-groove, rgba(0, 0, 0, 0.34)); stroke-width: 1; fill: none; }
.ia-shadow { fill: var(--ia-shadow, rgba(3, 6, 14, 0.42)); }
.ia-dglow { opacity: 0.26; animation: ia-glowp 3s ease-in-out infinite; }
.ia-sel-ring { fill: color-mix(in srgb, var(--accent, var(--ui-accent, #38bdf8)) 12%, transparent); stroke: var(--accent, var(--ui-accent, #38bdf8)); stroke-width: 1.5; stroke-dasharray: 7 5; animation: ia-ants 1.1s linear infinite; }
.ia-node-title { font-size: 10px; font-weight: 600; fill: var(--ui-text-primary, var(--ia-ink, currentColor)); paint-order: stroke; stroke: var(--ia-halo, rgba(8, 10, 16, 0.92)); stroke-width: 3.4px; stroke-linejoin: round; transition: opacity 0.15s ease; }
.ia-node-compact .ia-node-title { opacity: 0; pointer-events: none; }
.ia-node-compact:hover .ia-node-title { opacity: 1; }
.ia-node-sub2 { font-size: 8.5px; fill: var(--ia-ink-muted, #cbd5e1); paint-order: stroke; stroke: var(--ia-halo, rgba(8, 10, 16, 0.92)); stroke-width: 3px; stroke-linejoin: round; }
.ia-chipf { animation: ia-chipf 3.2s ease-in-out infinite; }
.ia-chip-box { fill: rgba(10, 12, 18, 0.82); stroke-width: 1; }
.ia-chip-text { font-size: 8.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.ia-alert-base { fill: color-mix(in srgb, var(--ui-danger, #ef4444) 9%, transparent); stroke: var(--ui-danger, #ef4444); stroke-width: 1.3; stroke-dasharray: 4 4; stroke-opacity: 0.85; }

.ia-led { animation: ia-led-b 2.2s ease-in-out infinite; }
.ia-led-b { animation: ia-led-b 3.4s ease-in-out infinite; }
.ia-led-f { animation: ia-led-f 1.1s steps(2, jump-none) infinite; }
.ia-screen { fill: #0b1120; fill-opacity: 0.92; stroke-width: 1; stroke-opacity: 0.75; }
.ia-scan { stroke: rgba(190, 210, 255, 0.85); stroke-width: 1.6; animation: ia-scan 2.8s linear infinite; }
.ia-glass { fill: color-mix(in srgb, var(--mat, #4c5262) 34%, var(--ia-void, #0e1420)); }
path.ia-glass { stroke: var(--ia-detail, rgba(255, 255, 255, 0.16)); stroke-width: 1; }
.ia-liquid { opacity: 0.82; }
.ia-meniscus { opacity: 0.55; animation: ia-meniscus 3s ease-in-out infinite; }
.ia-rim { fill: color-mix(in srgb, var(--mat, #4c5262) 20%, var(--ia-void, #0e1420)); stroke-width: 1.6; }
.ia-glass-shine { fill: rgba(255, 255, 255, 0.12); }
.ia-hum { transform-box: fill-box; transform-origin: center; animation: ia-hum 2.6s ease-in-out infinite; }
.ia-door { fill: color-mix(in srgb, var(--acc, #22c1d6) 38%, var(--ia-void, #0e1420)); stroke-width: 1.4; fill-opacity: 0.95; }
.ia-glyph { fill: none; stroke-width: 1.3; }
.ia-visor { stroke-width: 2.8; stroke-linecap: round; opacity: 0.98; }
.ia-bob { animation: ia-bob 3.4s ease-in-out infinite; }
.ia-bob-slow { animation-duration: 4.6s; }
.ia-orb { opacity: 0.95; }
.ia-orb-shine { fill: rgba(255, 255, 255, 0.55); }
.ia-orbit-ring { fill: none; stroke: var(--acc, #e879f9); stroke-width: 0.8; stroke-opacity: 0.4; }
.ia-clock-face { fill: #141d2c; stroke: rgba(255, 255, 255, 0.38); stroke-width: 1.3; }
.ia-clock-tick { fill: rgba(255, 255, 255, 0.55); }
.ia-clock-hand { stroke-width: 1.9; stroke-linecap: round; }
.ia-ping { fill: none; stroke-width: 1.2; transform-box: fill-box; transform-origin: center; animation: ia-ping 3s ease-out infinite; opacity: 0; }

.ia-beacon { stroke: rgba(8, 10, 16, 0.8); stroke-width: 0.8; }
.ia-beacon-up { animation: ia-beacon-soft 2.6s ease-in-out infinite; }
.ia-beacon-degraded { animation: ia-beacon-hard 1.2s ease-in-out infinite; }
.ia-beacon-down { animation: ia-beacon-hard 0.55s ease-in-out infinite; }
.ia-beacon-unknown, .ia-beacon-observed { opacity: 0.5; }
.ia-alert { fill: none; stroke: var(--ui-danger, #ef4444); stroke-width: 1.4; transform-box: fill-box; transform-origin: center; animation: ia-ping 1.8s ease-out infinite; opacity: 0; }
.ia-ripple { fill: none; stroke-width: 1.8; transform-box: fill-box; transform-origin: center; animation: ia-ping 1.25s ease-out 3; opacity: 0; }

.ia-enter .ia-lift { animation: ia-drop 0.62s cubic-bezier(0.22, 0.9, 0.34, 1.18) both; animation-delay: var(--d, 0ms); }
.ia-enter .ia-shadow { animation: ia-fade 0.5s ease both; animation-delay: var(--d, 0ms); }

.ia-pulse-touch_blocked .ia-lift { animation: ia-shake 0.4s ease-in-out 4; }
.ia-pulse-touch_allowed .ia-lift { animation: ia-flash-allowed 1.4s ease-out 1; }
.ia-pulse-read_doc .ia-lift { animation: ia-flash-read 1.4s ease-out 1; }

@keyframes ia-rise { 0% { opacity: 0; transform: translateY(14px); } 100% { opacity: 1; transform: translateY(0); } }
@keyframes ia-drop { 0% { opacity: 0; transform: translateY(-30px); } 55% { opacity: 1; transform: translateY(3px); } 76% { transform: translateY(-2px); } 100% { opacity: 1; transform: translateY(0); } }
@keyframes ia-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ia-flow { to { stroke-dashoffset: -220; } }
@keyframes ia-ants { to { stroke-dashoffset: -24; } }
@keyframes ia-glowp { 0%,100% { opacity: 0.16; } 50% { opacity: 0.38; } }
@keyframes ia-led-b { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes ia-led-f { 0% { opacity: 1; } 50% { opacity: 0.15; } 62% { opacity: 0.9; } 74% { opacity: 0.2; } }
@keyframes ia-scan { 0% { transform: translateY(0); opacity: 0; } 10% { opacity: 0.85; } 86% { opacity: 0.85; } 100% { transform: translateY(24px); opacity: 0; } }
@keyframes ia-meniscus { 0%,100% { transform: translate(0,0); opacity: 0.55; } 50% { transform: translate(1.4px, 0.7px); opacity: 0.75; } }
@keyframes ia-slosh { 0%,100% { transform: translate(0,0); } 25% { transform: translate(1.5px, 0.8px); } 75% { transform: translate(-1.5px, -0.3px); } }
@keyframes ia-hum { 0%,100% { transform: scale(1); } 50% { transform: scale(1.013); } }
@keyframes ia-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5.5px); } }
@keyframes ia-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.18; } }
@keyframes ia-ping { 0% { transform: scale(0.3); opacity: 0.9; } 70% { opacity: 0.4; } 100% { transform: scale(1.75); opacity: 0; } }
@keyframes ia-beacon-soft { 0%,100% { opacity: 0.95; } 50% { opacity: 0.45; } }
@keyframes ia-beacon-hard { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
@keyframes ia-chipf { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.6px); } }
@keyframes ia-burst-fade { 0% { opacity: 0; } 12% { opacity: 1; } 80% { opacity: 0.9; } 100% { opacity: 0; } }
@keyframes ia-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3.5px); } 75% { transform: translateX(3.5px); } }
@keyframes ia-flash-allowed { 0% { opacity: 0.45; } 100% { opacity: 1; } }
@keyframes ia-flash-read { 0% { opacity: 0.45; } 100% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .ia-plat, .ia-edge-line, .ia-packet, .ia-burst, .ia-led, .ia-led-b, .ia-led-f, .ia-scan, .ia-meniscus,
  .ia-hum, .ia-bob, .ia-blink, .ia-ping, .ia-beacon-up, .ia-beacon-degraded, .ia-beacon-down, .ia-alert,
  .ia-chipf, .ia-dglow, .ia-sel-ring, .ia-enter .ia-lift, .ia-enter .ia-shadow,
  .ia-pulse-touch_blocked .ia-lift, .ia-pulse-touch_allowed .ia-lift, .ia-pulse-read_doc .ia-lift,
  .ia-incident-pulse, .ia-live-dot, .ia-fan-blades, .ia-heat { animation: none; }
  .ia-packet, .ia-burst { display: none; }
}
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
                  message: `Sweep ${summary.sweep_id} finished in ${summary.duration_ms}ms`
                }),
              error => host.notify({ kind: 'error', message: `Infra Atlas: ${error.message || error}` })
            )
          }
        }
      },
      {
        id: 'guardrail',
        area: PALETTE_AREA,
        data: {
          id: 'infra-atlas.guardrail',
          label: 'Infra Atlas: cycle read-before-touch guardrail (block / warn / off)',
          keywords: ['infra', 'atlas', 'guardrail', 'block', 'warn', 'policy'],
          run: () => {
            const order = ['block', 'warn', 'off']
            void rest('/health')
              .then(state => {
                const current = (state && state.guardrail_mode) || 'block'
                const next = order[(order.indexOf(current) + 1) % order.length]
                return host
                  .request('plugins.manage', { action: 'settings', key: ID, values: { guardrail_mode: next } })
                  .then(() => rest('/settings', { method: 'POST', body: { guardrail_mode: next } }))
                  .then(() => host.notify({ kind: 'info', message: `Infra Atlas guardrail set to ${next}` }))
              })
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

// Exposed for tools/viewport_test_run.mjs; the Desktop only consumes the default.
export { planScene }
