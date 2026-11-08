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
 * per node kind, and edges routed on the tile grid — see the iso scene section.
 */

import { cn, host, STATUSBAR_AREAS, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, TRANSCRIPT_DIRECTIVE_AREA, useQuery } from '@hermes/plugin-sdk'
import * as React from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const ID = 'infra-atlas'
const PAGE_PATH = '/infra-atlas'

let API = null // ctx, kept for ctx.rest / ctx.storage
let pendingSelect = null

const DRIFT_ORDER = ['changed', 'unregistered', 'stale', 'observed', 'matched', 'doc_only']
const DRIFT_LABEL = {
  matched: 'matched',
  changed: 'drift',
  unregistered: 'unregistered',
  stale: 'stale',
  observed: 'peer',
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
  observed: 'var(--ui-text-tertiary, #8b8f98)',
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

// ── isometric scene ────────────────────────────────────────────────────────
// The topology is a terraced isometric diorama: one platform per stratum,
// stepping down toward the viewer — hardware at the back, agents at the
// front — so dependency edges flow downhill. Every kind of node is a distinct
// 3-D shape standing on its platform, and edges are routed on the tile grid
// like circuit traces, fanning into parallel lanes where they run together.

const ISO = { tileW: 64, tileH: 32, stepZ: 13, slab: 10, pitch: 2, pad: 30 }
const ISO_HW = ISO.tileW / 2
const ISO_HH = ISO.tileH / 2
const STRATUM_NAME = { 1: 'HARDWARE', 2: 'COMPUTE', 3: 'SERVICES', 4: 'AGENTS · MODELS' }

// continuous grid coordinates → screen px; z counts terrace steps
const projX = (x, y) => (x - y) * ISO_HW
const projY = (x, y, z) => (x + y) * ISO_HH - z * ISO.stepZ
const r2 = n => Math.round(n * 10) / 10
const sid = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')

// deterministic 0…1 per node id + salt: micro-animation phases stay stable
// across polls and never flicker
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

// per-kind visual identity: silhouette, accent, material, label anchor
const KIND_SCENE = {
  server: { shape: 'rack', accent: '#dbe3f0', mat: '#4a5060', top: 54, shadow: 34 },
  vm: { shape: 'tower', accent: '#818cf8', mat: '#424a5e', top: 52, shadow: 26 },
  lxc: { shape: 'tank', accent: '#fbbf24', mat: '#4c5262', top: 38, shadow: 21 },
  container: { shape: 'cargo', accent: '#22c1d6', mat: '#4e5866', top: 27, shadow: 38 },
  service: { shape: 'pad', accent: '#a78bfa', mat: '#40465c', top: 10, shadow: 26 },
  project: { shape: 'plate', accent: '#eab308', mat: '#4a4e60', top: 8, shadow: 32 },
  agent: { shape: 'bot', accent: '#38bdf8', mat: '#414a63', top: 50, shadow: 17 },
  model_endpoint: { shape: 'orb', accent: '#e879f9', mat: '#453f5e', top: 40, shadow: 15 },
  cron: { shape: 'clock', accent: '#4ade80', mat: '#3f4a4c', top: 33, shadow: 21 },
  peer: { shape: 'beacon', accent: '#818cf8', mat: '#484e66', top: 40, shadow: 23 },
  network: { shape: 'pad', accent: '#22d3ee', mat: '#3e4a5c', top: 10, shadow: 26 }
}
const kindScene = kind => KIND_SCENE[kind] || KIND_SCENE.service

const RELATION_STYLE = {
  hosts: { color: '#96a0b5', width: 1.7, dash: '', flow: 26 },
  depends_on: { color: '#a78bfa', width: 1.4, dash: '5 4', flow: 15 },
  uses_model: { color: '#22d3ee', width: 1.4, dash: '', flow: 19 },
  monitors: { color: '#f59e0b', width: 1.2, dash: '2 4', flow: 12 },
  proxies_to: { color: '#f472b6', width: 1.4, dash: '4 3', flow: 17 },
  routes_via: { color: '#2dd4bf', width: 1.4, dash: '4 3', flow: 17 }
}
const relationStyle = relation =>
  RELATION_STYLE[relation] || { color: '#7d8798', width: 1.3, dash: '', flow: 22 }

const byLabel = (a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id))

// Plan the scene: strata → terraced platforms, nodes → tile slots (children
// clustered under their parent so host edges stay short), plus the occupancy
// and z maps the edge router walks.
function planScene(nodes) {
  if (!nodes.length) {
    return { platforms: [], placed: new Map(), zAt: () => 0, latticeOk: () => false, hugCost: () => 0, stepAt: () => false, width: 760, height: 420, origin: { x: 0, y: 0 } }
  }
  const byStratum = new Map()
  nodes.forEach(node => {
    const stratum = Math.min(4, Math.max(1, Number(node.stratum || 3)))
    if (!byStratum.has(stratum)) byStratum.set(stratum, [])
    byStratum.get(stratum).push(node)
  })
  const strata = Array.from(byStratum.keys()).sort((a, b) => a - b)

  const placed = new Map() // id → { node, gx, gy, col, t }
  const platforms = []
  let cursorY = 0
  strata.forEach((stratum, t) => {
    const members = byStratum.get(stratum)
    const groups = new Map()
    const loose = []
    members.forEach(node => {
      if (node.parent_id && placed.has(node.parent_id)) {
        if (!groups.has(node.parent_id)) groups.set(node.parent_id, [])
        groups.get(node.parent_id).push(node)
      } else loose.push(node)
    })
    const ordered = []
    Array.from(groups.entries())
      .sort((a, b) => placed.get(a[0]).col - placed.get(b[0]).col)
      .forEach(([, group]) => {
        group.sort(byLabel)
        ordered.push(...group)
      })
    loose.sort(byLabel)
    ordered.push(...loose)

    // shallow terraces (1–2 rows): keeps the whole stack's screen footprint
    // tight, which is what decides how large the shapes render
    const rows = ordered.length > 6 ? 2 : 1
    const cols = Math.max(1, Math.ceil(ordered.length / rows))
    platforms.push({
      t,
      stratum,
      cols,
      rows,
      P: 0,
      D: rows * ISO.pitch + 2,
      z: strata.length - 1 - t,
      ordered
    })
  })

  // every terrace shares one grid x: the stack then cascades diagonally down
  // the screen in a tight staircase (centering each terrace in grid space
  // would grow the bounding box quadratically and shrink all the shapes)
  const sharedW = Math.max(...platforms.map(p => p.cols * ISO.pitch + 4))
  platforms.forEach(p => {
    p.W = sharedW
    p.P = cursorY
    p.L = 0
    p.ordered.forEach((node, index) => {
      placed.set(node.id, {
        node,
        gx: p.L + 2 + ISO.pitch * (index % p.cols),
        gy: p.P + 2 + ISO.pitch * Math.floor(index / p.cols),
        col: index % p.cols,
        t: p.t,
        z: p.z
      })
    })
    cursorY = p.P + p.D + 1 // one open joint row between terraces
    delete p.ordered
  })

  // normalise x so all grid coordinates are ≥ 0
  const shiftX = -Math.min(...platforms.map(p => p.L))
  const GW = Math.max(...platforms.map(p => p.L + p.W)) + shiftX + 1
  const GH = cursorY
  platforms.forEach(p => {
    p.L += shiftX
  })
  placed.forEach(info => {
    info.gx += shiftX
    info.u = info.gx + info.gy
  })

  const occupied = new Set()
  placed.forEach(info => occupied.add(`${info.gx},${info.gy}`))

  // z bands: platform surfaces + the open step rows between them (at the
  // lower terrace's level, so crossing segments slope downhill)
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
  const platformAt = (gx, gy) =>
    platforms.find(p => gx >= p.L && gx < p.L + p.W && gy >= p.P && gy < p.P + p.D)
  const stepAt = (gx, gy) => {
    for (let index = 0; index < platforms.length - 1; index++) {
      const a = platforms[index]
      const b = platforms[index + 1]
      // only across the cliff where both terraces exist — never through the void wings
      if (gy >= a.P + a.D && gy < b.P && gx >= Math.max(a.L, b.L) && gx < Math.min(a.L + a.W, b.L + b.W)) return true
    }
    return false
  }
  // a lattice step is rideable when the middle of its grid-line segment lies
  // on a platform top or across an open step joint
  const latticeOk = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    return Boolean(platformAt(mx, my) || stepAt(mx, my))
  }
  // edges running directly along a footprint border cost extra: traces should
  // keep a tile between themselves and shapes unless a port stub needs the edge
  const hugCost = (x1, y1, x2, y2) => {
    if (y1 === y2) {
      return occupied.has(`${x1},${y1 - 1}`) || occupied.has(`${x1},${y1}`) ? 2.4 : 0
    }
    return occupied.has(`${x1 - 1},${y1}`) || occupied.has(`${x1},${y1}`) ? 2.4 : 0
  }

  // projected scene bounds (platform slabs + room for labels and overhangs)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  platforms.forEach(p => {
    const cliff = p.z * ISO.stepZ + ISO.slab // terrace fronts reach down to the base plane
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
  minX -= 30
  maxX += 30
  minY -= 104
  maxY += 10
  return {
    platforms,
    placed,
    occupied,
    zAt,
    latticeOk,
    hugCost,
    stepAt,
    width: maxX - minX + ISO.pad * 2,
    height: maxY - minY + ISO.pad * 2,
    origin: { x: ISO.pad - minX, y: ISO.pad - minY }
  }
}

// ── edge routing ───────────────────────────────────────────────────────────
// Traces ride the lattice lines BETWEEN grid squares, like circuit traces in
// grooves: routes are walks on the integer grid (the same lines the platform
// tops have etched). Footprints are never entered — a lattice segment only
// ever runs on tile borders. Earlier traces make a lattice edge expensive,
// which fans parallel connections onto neighbouring grid lines instead of
// stacking them; edges hugging a footprint cost extra so traces keep their
// distance from shapes unless a port stub requires it.

const DIRS = [[1, 0, 0], [-1, 0, 1], [0, 1, 2], [0, -1, 3]]

const portPoint = (info, side) =>
  side === 'E' ? { x: info.gx + 1, y: info.gy + 0.5 }
    : side === 'W' ? { x: info.gx, y: info.gy + 0.5 }
      : side === 'S' ? { x: info.gx + 0.5, y: info.gy + 1 }
        : { x: info.gx + 0.5, y: info.gy }

// a trace leaves/enters a shape through the footprint corner that faces the
// other endpoint, then continues along the lattice from there
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
      // crossing a terrace joint costs extra so traces cut across it squarely
      // instead of running laterally along the step
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

// polyline with rounded corners: grid-aligned segments, quarter-bezier turns
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
  const congestion = new Map()

  const ordered = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => plan.placed.has(edge.source_id) && plan.placed.has(edge.target_id) && edge.source_id !== edge.target_id)
    .sort((a, b) => String(a.edge.source_id).localeCompare(String(b.edge.source_id)) || a.index - b.index)

  return ordered.map(({ edge }) => {
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
      // fallback: a manhattan walk along lattice lines (may hug shapes when
      // the grid is packed, but never leaves them)
      const bend = start.y === goal.y || start.x === goal.x
        ? []
        : Math.abs(goal.x - start.x) >= Math.abs(goal.y - start.y)
          ? [{ x: goal.x, y: start.y }]
          : [{ x: start.x, y: goal.y }]
      lattice = [...bend, goal]
    }

    // port → corner → lattice walk → corner → port, all on grid lines
    const gridPoints = [a, start, ...lattice, goal, b].filter(Boolean)
    const dedup = []
    gridPoints.forEach(p => {
      const last = dedup[dedup.length - 1]
      if (!last || last.x !== p.x || last.y !== p.y) dedup.push(p)
    })
    // remember which lattice edges are taken so later traces fan aside
    for (let i = 1; i < dedup.length; i++) {
      const p1 = dedup[i - 1]
      const p2 = dedup[i]
      if (Number.isInteger(p1.x) && Number.isInteger(p1.y) && Number.isInteger(p2.x) && Number.isInteger(p2.y)) {
        const k = edgeKey(p1.x, p1.y, p2.x, p2.y)
        congestion.set(k, (congestion.get(k) || 0) + 1)
      }
    }

    // drop collinear middles, project to screen, round the corners
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
    const screenPoints = simple.map(p => ({ x: projX(p.x, p.y), y: projY(p.x, p.y, plan.zAt(p.y)) }))
    const smooth = smoothPath(screenPoints)

    const style = relationStyle(edge.relation)
    const dur = Math.max(3.2, Math.min(11, smooth.length / 55))
    const phase = seeded(edge.source_id + edge.target_id + String(edge.relation), 3)
    // pull the chevron back so it kisses the target shape instead of stabbing it
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
}

// ── iso shape primitives ───────────────────────────────────────────────────
// A box footprint spans ±ax/±ay grid units around the local origin (which sits
// on the platform surface); h is its pixel height. Corners: A back, B right,
// C front, D left; *t variants are the top face.

function boxGeom(ax, ay, h, baseY = 0) {
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
  return {
    A, B, C, D, At, Bt, Ct, Dt,
    top: path(At, Bt, Ct, Dt),
    left: path(Dt, Ct, C, D),
    right: path(Ct, Bt, B, C),
    backL: path(At, Dt, D, A),
    backR: path(Bt, At, A, B),
    faceTop: [At, Bt, Ct, Dt],
    faceLeft: [Dt, Ct, C, D],
    faceRight: [Ct, Bt, B, C]
  }
}

const lerp = (p1, p2, f) => ({ x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f })
const along = (p1, p2, f) => `M ${r2(lerp(p1, p2, f).x)} ${r2(lerp(p1, p2, f).y)} L ${r2(lerp(p1, p2, 1 - f).x)} ${r2(lerp(p1, p2, 1 - f).y)}`

// ── per-kind shape bodies (children of the .ia-lift group) ────────────────

function RackBody({ node, geom, scene }) {
  const g = boxGeom(0.62, 0.3, 54)
  const units = [0.16, 0.32, 0.48, 0.64, 0.8].map(f => along(lerp(g.Bt, g.B, f), lerp(g.Ct, g.C, f), 0.04))
  const leds = [0.2, 0.36, 0.52, 0.68].map((f, i) => lerp(lerp(g.Bt, g.B, 0.07), lerp(g.Ct, g.C, 0.07), f + 0.02))
  return [
    jsx('path', { d: g.backL, className: 'ia-f-back' }),
    jsx('path', { d: g.backR, className: 'ia-f-back' }),
    jsx('path', { d: g.left, className: 'ia-f-left' }),
    jsx('path', { d: g.right, className: 'ia-f-right' }),
    jsx('path', { d: g.top, className: 'ia-f-top' }),
    jsx('path', { d: along(g.At, g.Dt, 0.18), className: 'ia-detail' }),
    jsx('path', { d: along(g.Bt, g.Ct, 0.18), className: 'ia-detail' }),
    jsx('path', { d: units.join(' '), className: 'ia-groove' }),
    jsx('path', { d: along(lerp(g.Dt, g.D, 0.5), lerp(g.Ct, g.C, 0.5), 0.48), className: 'ia-groove' }),
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

function TowerBody({ node, geom, scene }) {
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
    jsx('path', { d: base.left, className: 'ia-f-left' }),
    jsx('path', { d: base.right, className: 'ia-f-right' }),
    jsx('path', { d: base.top, className: 'ia-f-top' }),
    jsx('path', { d: g.left, className: 'ia-f-left' }),
    jsx('path', { d: g.right, className: 'ia-f-right' }),
    jsx('path', { d: g.top, className: 'ia-f-top' }),
    jsx('path', { d: screenD, className: 'ia-screen', style: { stroke: scene.accent } }),
    jsx('clipPath', { id: `ia-clip-${sid(node.id)}`, children: jsx('path', { d: screenD }) }),
    jsx('line', {
      x1: r2(scanTop.x), y1: r2(scanTop.y), x2: r2(scanBottom.x), y2: r2(scanBottom.y),
      className: 'ia-scan', style: { animationDelay: `${(seeded(node.id, 7) * 2.8).toFixed(2)}s` },
      clipPath: `url(#ia-clip-${sid(node.id)})`
    }),
    jsx('circle', { cx: r2(lerp(g.At, g.Ct, 0.5).x), cy: r2(lerp(g.At, g.Ct, 0.5).y - 2), r: 1.6, style: { fill: scene.accent }, className: 'ia-blink' })
  ]
}

function TankBody({ node, geom, scene }) {
  const rx = 15
  const ry = 7.5
  const h = 34
  const level = Math.min(0.96, Math.max(0.1, (Number(node.uptime_24h_pct) || 92) / 100))
  const ySurface = -h * level
  const body = `M ${-rx} ${-h} L ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 L ${rx} ${-h} Z`
  const liquid = `M ${-rx} ${r2(ySurface)} L ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 L ${rx} ${r2(ySurface)} A ${rx} ${ry} 0 0 1 ${-rx} ${r2(ySurface)} Z`
  const health = HEALTH_COLOR[node.health_status] || HEALTH_COLOR.unknown
  return [
    jsx('clipPath', { id: `ia-clip-${sid(node.id)}`, children: jsx('path', { d: body }) }),
    jsx('path', { d: body, className: 'ia-glass' }),
    jsx('path', { d: liquid, style: { fill: health }, className: 'ia-liquid' }),
    jsxs('g', {
      className: 'ia-slosh',
      style: { animationDelay: `${(seeded(node.id, 5) * 3).toFixed(2)}s` },
      clipPath: `url(#ia-clip-${sid(node.id)})`,
      children: [
        jsx('ellipse', { cx: 0, cy: r2(ySurface), rx, ry, style: { fill: health }, className: 'ia-meniscus' })
      ]
    }),
    jsx('ellipse', { cx: 0, cy: -h, rx, ry, className: 'ia-rim', style: { stroke: scene.accent } }),
    jsx('ellipse', { cx: -rx * 0.3, cy: -h * 0.62, rx: 2.4, ry: 5, className: 'ia-glass-shine' })
  ]
}

function CargoBody({ node, geom, scene }) {
  const g = boxGeom(0.9, 0.36, 25)
  const ridges = [0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86].map(f =>
    along(lerp(g.D, g.Dt, 0.12), lerp(g.C, g.Ct, 0.12), 1 - f - 0.07)
  )
  return [
    jsxs('g', { className: 'ia-hum', children: [
      jsx('path', { d: g.left, className: 'ia-f-left' }),
      jsx('path', { d: g.right, className: 'ia-f-right' }),
      jsx('path', { d: g.top, className: 'ia-f-top' })
    ] }),
    jsx('path', { d: ridges.join(' '), className: 'ia-groove' }),
    jsx('path', { d: along(g.Ct, g.Dt, 0.3), className: 'ia-groove' }),
    jsx('path', {
      d: `M ${r2(lerp(g.C, g.Ct, 0.18).x)} ${r2(lerp(g.C, g.Ct, 0.18).y)} L ${r2(lerp(g.B, g.Bt, 0.18).x)} ${r2(lerp(g.B, g.Bt, 0.18).y)} L ${r2(lerp(g.B, g.Bt, 0.82).x)} ${r2(lerp(g.B, g.Bt, 0.82).y)} L ${r2(lerp(g.C, g.Ct, 0.82).x)} ${r2(lerp(g.C, g.Ct, 0.82).y)} Z`,
      className: 'ia-door',
      style: { stroke: scene.accent }
    }),
    jsx('path', { d: along(lerp(g.C, g.Ct, 0.3), lerp(g.B, g.Bt, 0.3), 0.4), className: 'ia-groove' }),
    jsx('path', { d: along(lerp(g.C, g.Ct, 0.7), lerp(g.B, g.Bt, 0.7), 0.4), className: 'ia-groove' })
  ]
}

function PadBody({ node, geom, scene }) {
  const g = boxGeom(0.46, 0.46, 8)
  const top = lerp(g.At, g.Ct, 0.5)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }),
    jsx('path', { d: g.right, className: 'ia-f-right' }),
    jsx('path', { d: g.top, className: 'ia-f-top' }),
    jsx('path', {
      d: `M ${r2(top.x)} ${r2(top.y - 6)} L ${r2(top.x + 8)} ${r2(top.y - 2)} L ${r2(top.x)} ${r2(top.y + 2)} L ${r2(top.x - 8)} ${r2(top.y - 2)} Z`,
      style: { stroke: scene.accent },
      className: 'ia-glyph'
    }),
    jsx('circle', { cx: r2(top.x), cy: r2(top.y - 2), r: 1.7, style: { fill: scene.accent }, className: 'ia-blink' })
  ]
}

function PlateBody({ node, geom, scene }) {
  const g = boxGeom(0.7, 0.4, 6)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }),
    jsx('path', { d: g.right, className: 'ia-f-right' }),
    jsx('path', { d: g.top, className: 'ia-f-top' }),
    jsx('path', { d: along(g.Dt, g.D, 0.4), className: 'ia-detail' }),
    jsx('path', { d: along(lerp(g.Ct, g.C, 0.45), lerp(g.Bt, g.B, 0.45), 0.3), className: 'ia-detail' })
  ]
}

function BotBody({ node, geom, scene }) {
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
    })
  ]
}

function OrbBody({ node, geom, scene }) {
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
    })
  ]
}

function ClockBody({ node, geom, scene }) {
  const g = boxGeom(0.4, 0.4, 12)
  return [
    jsx('path', { d: g.left, className: 'ia-f-left' }),
    jsx('path', { d: g.right, className: 'ia-f-right' }),
    jsx('path', { d: g.top, className: 'ia-f-top' }),
    jsx('circle', { cx: 0, cy: -21, r: 11, className: 'ia-clock-face' }),
    [0, 90, 180, 270].map(deg =>
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
    ] }),
    jsx('circle', { cx: 0, cy: -21, r: 1.5, style: { fill: scene.accent } })
  ]
}

function BeaconBody({ node, geom, scene }) {
  const g = boxGeom(0.5, 0.5, 0)
  const apex = { x: (g.A.x + g.C.x) / 2, y: (g.A.y + g.C.y) / 2 - 38 }
  const face = (p1, p2) => `M ${r2(p1.x)} ${r2(p1.y)} L ${r2(p2.x)} ${r2(p2.y)} L ${r2(apex.x)} ${r2(apex.y)} Z`
  const band = (p1, p2, f) => {
    const a = { x: p1.x + (apex.x - p1.x) * f, y: p1.y + (apex.y - p1.y) * f }
    const b = { x: p2.x + (apex.x - p2.x) * f, y: p2.y + (apex.y - p2.y) * f }
    return `M ${r2(a.x)} ${r2(a.y)} L ${r2(b.x)} ${r2(b.y)}`
  }
  return [
    jsx('path', { d: face(g.D, g.C), className: 'ia-f-left' }),
    jsx('path', { d: face(g.C, g.B), className: 'ia-f-right' }),
    jsx('path', { d: band(g.D, g.C, 0.55), className: 'ia-groove' }),
    jsx('path', { d: band(g.C, g.B, 0.55), className: 'ia-groove' }),
    jsx('circle', { cx: r2(apex.x), cy: r2(apex.y - 1), r: 2.3, style: { fill: scene.accent }, className: 'ia-blink' }),
    jsx('ellipse', { cx: 0, cy: 1, rx: 18, ry: 9, className: 'ia-ping', style: { animationDelay: `${(seeded(node.id, 11) * 3).toFixed(2)}s`, stroke: scene.accent } }),
    jsx('ellipse', { cx: 0, cy: 1, rx: 18, ry: 9, className: 'ia-ping', style: { animationDelay: `${(1.5 + seeded(node.id, 12) * 3).toFixed(2)}s`, stroke: scene.accent } })
  ]
}

const SHAPE_BODIES = {
  rack: RackBody,
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

// ── node assembly: shadow, drift underglow, shape, beacon, chip, labels ────
function IsoNode({ node, info, active, pulse, fresh, delay, showTitle, showAddress, onSelect }) {
  const scene = kindScene(node.kind)
  const drift = node.drift_status || 'matched'
  const driftColor = DRIFT_COLOR[drift] || DRIFT_COLOR.matched
  const health = node.health_status || 'unknown'
  const body = (SHAPE_BODIES[scene.shape] || PadBody)({ node, scene })
  const title = truncate(node.label || node.id, 14)
  const sub = addressOf(node) || node.kind || ''
  const top = scene.top
  return jsxs('g', {
    className: cn('ia-node', `ia-kind-${node.kind}`, active && 'ia-node-active', pulse && `ia-pulse-${pulse}`, fresh && 'ia-enter'),
    transform: `translate(${r2(projX(info.gx + 0.5, info.gy + 0.5))} ${r2(projY(info.gx + 0.5, info.gy + 0.5, info.z || 0))})`,
    'data-node-id': node.id,
    onClick: event => {
      event.stopPropagation()
      onSelect(node.id)
    },
    style: { '--mat': scene.mat, '--acc': scene.accent, '--d': `${delay}ms` },
    children: [
      jsx('ellipse', { cx: 0, cy: 2.5, rx: scene.shadow, ry: scene.shadow / 2.1, className: 'ia-shadow' }),
      drift !== 'matched'
        ? jsx('ellipse', { cx: 0, cy: 1.5, rx: scene.shadow * 0.95, ry: scene.shadow * 0.5, className: 'ia-dglow', style: { fill: driftColor } })
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
          drift !== 'matched'
            ? jsxs('g', { className: 'ia-chipf', style: { animationDelay: `${(seeded(node.id, 21) * 3).toFixed(2)}s` }, children: [
                jsx('rect', { x: -(DRIFT_LABEL[drift] || drift).length * 2.9 - 6, y: -(top + 48), width: (DRIFT_LABEL[drift] || drift).length * 5.8 + 12, height: 13, rx: 6.5, className: 'ia-chip-box', style: { stroke: driftColor } }),
                jsx('text', { x: 0, y: -(top + 38.5), textAnchor: 'middle', className: 'ia-chip-text', style: { fill: driftColor }, children: DRIFT_LABEL[drift] || drift })
              ] })
            : null,
          showTitle
            ? jsx('text', { x: 0, y: -(top + 26), textAnchor: 'middle', className: 'ia-node-title', children: title })
            : null,
          showTitle && (showAddress || active)
            ? jsx('text', { x: 0, y: -(top + 15), textAnchor: 'middle', className: 'ia-node-sub2', children: node.vmid ? `${sub} · vm ${node.vmid}` : sub })
            : null
        ]
      })
    ]
  })
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
              jsx(IsoCubeMark, {}),
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
              counts.observed
                ? pill('observed', `Peers (${counts.observed})`, filter, setFilter, DRIFT_COLOR.observed)
                : null,
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
                  ? jsx(Topology, { nodes: visible, edges, selectedId, onSelect: setSelectedId, pulseFor: nodePulse })
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

// ── chrome primitives ──────────────────────────────────────────────────────
// HUD frame: hairline border + chamfered corners, for the floating cards.
const hud = (className, children) => {
  const inner = Array.isArray(children)
    ? jsxs('div', { className: 'ia-hud-in', children })
    : jsx('div', { className: 'ia-hud-in', children })
  return jsx('div', { className: cn('ia-hud', className), children: inner })
}

const IsoCubeMark = () =>
  jsxs('svg', {
    className: 'ia-mark',
    width: 15,
    height: 17,
    viewBox: '-16 -11 32 32',
    'aria-hidden': true,
    children: [
      jsx('path', { d: 'M 0 -10 L 15 -1 L 0 8 L -15 -1 Z', className: 'ia-mark-top' }),
      jsx('path', { d: 'M -15 -1 L 0 8 L 0 20 L -15 11 Z', className: 'ia-mark-left' }),
      jsx('path', { d: 'M 15 -1 L 0 8 L 0 20 L 15 11 Z', className: 'ia-mark-right' })
    ]
  })

// ── topology ───────────────────────────────────────────────────────────────
function PlatformView({ platform, next }) {
  const p = platform
  const z = p.z
  const A = { x: projX(p.L, p.P), y: projY(p.L, p.P, z) }
  const B = { x: projX(p.L + p.W, p.P), y: projY(p.L + p.W, p.P, z) }
  const C = { x: projX(p.L + p.W, p.P + p.D), y: projY(p.L + p.W, p.P + p.D, z) }
  const D = { x: projX(p.L, p.P + p.D), y: projY(p.L, p.P + p.D, z) }
  // terrace fronts drop to the base plane: one hillside, not islands (front-most
  // terrace keeps a plinth so its cliff still carries the stratum label)
  const dz = Math.max(26, z * ISO.stepZ + ISO.slab)
  const face = (p1, p2, depth) =>
    `M ${r2(p1.x)} ${r2(p1.y)} L ${r2(p2.x)} ${r2(p2.y)} L ${r2(p2.x)} ${r2(p2.y + depth)} L ${r2(p1.x)} ${r2(p1.y + depth)} Z`
  // the joint row becomes a visible slope riser, fusing the terraces together
  const riser = next
    ? `M ${r2(D.x)} ${r2(D.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(projX(next.L + next.W, next.P))} ${r2(projY(next.L + next.W, next.P, next.z))} L ${r2(projX(next.L, next.P))} ${r2(projY(next.L, next.P, next.z))} Z`
    : null
  let grid = ''
  for (let gx = p.L + 1; gx < p.L + p.W; gx++) grid += `M ${r2(projX(gx, p.P))} ${r2(projY(gx, p.P, z))} L ${r2(projX(gx, p.P + p.D))} ${r2(projY(gx, p.P + p.D, z))} `
  for (let gy = p.P + 1; gy < p.P + p.D; gy++) grid += `M ${r2(projX(p.L, gy))} ${r2(projY(p.L, gy, z))} L ${r2(projX(p.L + p.W, gy))} ${r2(projY(p.L + p.W, gy, z))} `
  const labelPos = { x: D.x + 13, y: D.y + Math.min(dz * 0.66, dz - 4) }
  return jsxs('g', {
    className: cn('ia-plat', `ia-plat-${p.t % 4}`),
    style: { '--t': p.t, animationDelay: `${p.t * 110}ms` },
    children: [
      riser ? jsx('path', { d: riser, className: 'ia-plat-riser' }) : null,
      jsx('path', { d: face(D, A, dz), className: 'ia-plat-left' }),
      jsx('path', { d: face(A, B, dz), className: 'ia-plat-right' }),
      jsx('path', { d: face(C, D, dz), className: 'ia-plat-left' }),
      jsx('path', { d: face(B, C, dz), className: 'ia-plat-right' }),
      jsx('path', { d: `M ${r2(A.x)} ${r2(A.y)} L ${r2(B.x)} ${r2(B.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(D.x)} ${r2(D.y)} Z`, className: 'ia-plat-top' }),
      jsx('path', { d: grid, className: 'ia-plat-grid' }),
      jsx('path', { d: `M ${r2(B.x)} ${r2(B.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(D.x)} ${r2(D.y)}`, className: 'ia-plat-edge' }),
      jsx('text', {
        x: 0,
        y: 0,
        className: 'ia-plat-label',
        transform: `translate(${r2(labelPos.x)} ${r2(labelPos.y)}) matrix(0.894 0.447 0 1 0 0)`,
        children: STRATUM_NAME[p.stratum] || `TIER ${p.stratum}`
      })
    ]
  })
}

function EdgeView({ route, selectedId, pulseFor, labelHint }) {
  const { edge, style } = route
  const hot = Boolean(selectedId) && (edge.source_id === selectedId || edge.target_id === selectedId)
  const dim = Boolean(selectedId) && !hot
  const burst = pulseFor && (pulseFor(edge.source_id) === 'touch_blocked' || pulseFor(edge.target_id) === 'touch_blocked')
  return jsxs('g', {
    className: cn('ia-edge', `ia-edge-${edge.relation}`, hot && 'ia-edge-hot', dim && 'ia-edge-dim'),
    style: { '--edge-c': style.color, '--ew': style.width, '--flow-dur': `${style.flow}s` },
    children: [
      jsx('path', { d: route.d, className: 'ia-edge-line', strokeDasharray: style.dash || undefined }),
      jsx('path', {
        d: 'M -1.4 -3.6 L 5.8 0 L -1.4 3.6 Z',
        transform: `translate(${r2(route.chevron.x)} ${r2(route.chevron.y)}) rotate(${r2(route.angle)})`,
        className: 'ia-edge-head'
      }),
      jsxs('g', { className: 'ia-packet', children: [
        jsx('circle', { r: route.length > 430 ? 2.5 : 2, className: 'ia-packet-core' }),
        jsx('circle', { r: 4.8, className: 'ia-packet-halo' }),
        jsx('animateMotion', { path: route.d, dur: `${route.dur}s`, begin: `${(-route.phase * route.dur).toFixed(2)}s`, repeatCount: 'indefinite', calcMode: 'linear' })
      ] }),
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
}

function Topology({ nodes, edges, selectedId, onSelect, pulseFor }) {
  const plan = React.useMemo(() => planScene(nodes), [nodes])
  const routed = React.useMemo(() => routeEdges(edges, plan), [edges, plan])
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const dragRef = React.useRef(null)
  const seenRef = React.useRef(null)

  const viewBox = `${-offset.x} ${-offset.y} ${plan.width / zoom} ${plan.height / zoom}`

  const onPointerDown = event => {
    if (event.target && event.target.closest && event.target.closest('[data-node-id]')) return
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

  // depth order (painter's algorithm); new ids get the drop-in entrance
  const ordered = React.useMemo(() => {
    const seen = seenRef.current || (seenRef.current = new Set())
    const list = Array.from(plan.placed.values())
      .sort((a, b) => a.u - b.u || a.gx - b.gx)
      .map(info => {
        const fresh = !seen.has(info.node.id)
        seen.add(info.node.id)
        return { info, fresh }
      })
    return list
  }, [plan])

  const notable = node =>
    (node.drift_status && node.drift_status !== 'matched') ||
    node.health_status === 'down' ||
    node.health_status === 'degraded'
  const showTitle = zoom >= 0.8
  const showAddress = zoom >= 1.25

  const labelHintOf = route => {
    const from = plan.placed.get(route.edge.source_id)
    const to = plan.placed.get(route.edge.target_id)
    return `${(from && from.node && from.node.label) || route.edge.source_id} —${route.edge.relation}→ ${(to && to.node && to.node.label) || route.edge.target_id}`
  }

  return jsxs('div', {
    className: 'ia-graph-wrap',
    children: [
      jsxs('div', {
        className: 'ia-zoom',
        children: [
          jsx('button', { type: 'button', onClick: () => setZoom(z => Math.min(2.4, z * 1.2)), children: '+' }),
          jsx('button', { type: 'button', onClick: () => setZoom(z => Math.max(0.42, z / 1.2)), children: '−' }),
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
            children: jsx('filter', {
              id: 'ia-soft',
              x: '-60%',
              y: '-60%',
              width: '220%',
              height: '220%',
              children: jsx('feGaussianBlur', { stdDeviation: 2.4 })
            })
          }),
          jsxs('g', {
            className: 'ia-iso',
            transform: `translate(${r2(plan.origin.x)} ${r2(plan.origin.y)})`,
            children: [
              plan.platforms.map((p, i) => jsx(PlatformView, { platform: p, next: plan.platforms[i + 1] }, `plat-${p.t}`)),
              routed.map(route => jsx(EdgeView, { route, selectedId, pulseFor, labelHint: labelHintOf(route) }, route.key)),
              ordered.map(({ info, fresh }) =>
                jsx(IsoNode, {
                  node: info.node,
                  info,
                  active: info.node.id === selectedId,
                  pulse: pulseFor(info.node.id),
                  fresh,
                  delay: Math.min(920, info.u * 20),
                  showTitle: showTitle || notable(info.node) || info.node.id === selectedId,
                  showAddress,
                  onSelect
                }, info.node.id))
            ]
          })
        ]
      })
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
      jsxs('div', { className: 'ia-stream-title', children: [jsx('span', { className: 'ia-live-dot' }), 'Live activity & guardrail'] }),
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
  jsxs('div', { className: 'ia-kv-row', children: [
    jsx('span', { className: 'ia-kv-key', children: key }),
    jsx('span', { className: 'ia-kv-lead' }),
    jsx('span', { className: 'ia-kv-value', children: String(value) })
  ] })

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
  return hud('ia-card', [
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
  ])
}

function DriftCard() {
  const { data } = useGraph(15000)
  const nodes = ((data && data.nodes) || []).filter(node => node.drift_status && node.drift_status !== 'matched' && node.drift_status !== 'doc_only')
  const incidents = (data && data.incidents) || []
  return hud('ia-card', [
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
  ])
}

// ── styles ─────────────────────────────────────────────────────────────────
const CSS = `
/* ── chrome: ops-console HUD ─────────────────────────────────────────────── */
.ia-root { display:flex; flex-direction:column; height:100%; min-height:0; font-size:12px; color:#d9e4f5; background:#0b0f1a; }
.ia-header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 14px; position:relative; border-bottom:1px solid rgba(96,126,190,.16); }
.ia-title { display:flex; align-items:center; gap:9px; font-weight:700; font-size:13px; letter-spacing:.04em; text-transform:uppercase; }
.ia-mark-top { fill:#38bdf8; }
.ia-mark-left { fill:#1e6fa8; }
.ia-mark-right { fill:#14486e; }
.ia-sub { font-weight:400; font-size:10px; color:#5f6f8f; letter-spacing:.06em; }
.ia-pills { display:flex; gap:5px; flex-wrap:wrap; }
.ia-pill { border:none; background:rgba(30,40,64,.55); color:#9fb0cc; clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); padding:3px 10px; font-size:10.5px; letter-spacing:.03em; cursor:pointer; transition:background .15s ease, color .15s ease; }
.ia-pill:hover { background:rgba(44,58,92,.7); color:#d9e4f5; }
.ia-pill-active { background:rgba(42,66,102,.9); color:#eaf4ff; box-shadow:inset 0 0 0 1px rgba(125,211,252,.4); }
.ia-pill-incident { color:#fca5a5; box-shadow:inset 0 0 0 1px rgba(239,68,68,.45); }
.ia-controls { display:flex; gap:7px; align-items:center; margin-left:auto; flex-wrap:wrap; }
.ia-search { background:rgba(17,23,38,.8); border:none; box-shadow:inset 0 0 0 1px rgba(96,126,190,.28); color:#d9e4f5; clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); padding:5px 11px; font-size:11px; min-width:190px; outline:none; }
.ia-search:focus { box-shadow:inset 0 0 0 1px rgba(56,189,248,.65); }
.ia-search::placeholder { color:#5f6f8f; }
.ia-select { display:flex; align-items:center; gap:5px; font-size:9px; text-transform:uppercase; letter-spacing:.12em; color:#5f6f8f; }
.ia-select select { background:rgba(17,23,38,.8); color:#bcd2ee; border:none; box-shadow:inset 0 0 0 1px rgba(96,126,190,.28); clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); padding:4px 7px; font-size:11px; }
.ia-btn { background:rgba(30,40,64,.85); border:none; box-shadow:inset 0 0 0 1px rgba(96,126,190,.3); color:#cddcf2; clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px); padding:5px 12px; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; cursor:pointer; white-space:nowrap; transition:background .15s ease; }
.ia-btn:hover { box-shadow:inset 0 0 0 1px rgba(125,211,252,.6); color:#eaf4ff; }
.ia-btn:disabled { opacity:.5; cursor:default; }
.ia-btn-primary { background:#1e6fba; color:#f2f8ff; font-weight:700; box-shadow:inset 0 0 0 1px rgba(190,230,255,.35); }
.ia-btn-primary:hover { background:#2a80cf; }
.ia-btn-on { box-shadow:inset 0 0 0 1px rgba(56,189,248,.8); color:#9fd8ff; }
.ia-hud { padding:1px; background:rgba(96,146,210,.42); clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px); }
.ia-hud-in { clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px); background:#0d1322; position:relative; }
.ia-incident { display:flex; gap:12px; align-items:center; padding:9px 16px; flex:0 0 auto; color:#ffd7d7; background:rgba(239,68,68,.09); border-bottom:1px solid rgba(239,68,68,.4); }
.ia-incident-icon { font-size:15px; animation:ia-beacon-hard 1.6s ease-in-out infinite; }
.ia-incident-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
.ia-incident-title { display:flex; gap:8px; align-items:center; font-size:12px; }
.ia-incident-state { font-size:9px; text-transform:uppercase; letter-spacing:.16em; color:#f87171; }
.ia-incident-more { font-size:10px; color:#8b93a5; }
.ia-incident-detail { font-size:11px; color:#c1a9b2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-incident-hint { font-size:11px; color:#a8b6cf; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-incident-actions { margin-left:auto; display:flex; gap:6px; }
.ia-body { display:flex; flex:1 1 auto; min-height:0; }
.ia-canvas { flex:1 1 auto; min-width:0; position:relative; overflow:hidden; background:transparent; }
.ia-graph-wrap { position:absolute; inset:0; }
.ia-svg { width:100%; height:100%; cursor:grab; }
.ia-svg:active { cursor:grabbing; }
.ia-zoom { position:absolute; right:12px; top:12px; z-index:2; display:flex; flex-direction:column; gap:4px; }
.ia-zoom button { width:26px; height:26px; border:none; clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); background:rgba(17,23,38,.85); box-shadow:inset 0 0 0 1px rgba(96,126,190,.3); color:#9fd8ff; cursor:pointer; font-size:12px; }
.ia-zoom button:hover { box-shadow:inset 0 0 0 1px rgba(125,211,252,.7); }

/* ── isometric scene ───────────────────────────────────────────────────── */
.ia-plat { animation:ia-rise .7s cubic-bezier(.2,.7,.3,1) both; }
.ia-plat-top { fill:color-mix(in srgb, var(--plat, #333a4a) 92%, #ffffff); }
.ia-plat-left { fill:color-mix(in srgb, var(--plat, #333a4a) 68%, #000000); }
.ia-plat-right { fill:color-mix(in srgb, var(--plat, #333a4a) 44%, #000000); }
.ia-plat-0 { --plat:#3d3a47; }
.ia-plat-1 { --plat:#353c50; }
.ia-plat-2 { --plat:#3b3550; }
.ia-plat-3 { --plat:#2f4744; }
.ia-plat-riser { fill:color-mix(in srgb, var(--plat, #333a4a) 34%, #000000); }
.ia-plat-grid { fill:none; stroke:rgba(190,205,235,.09); stroke-width:1; }
.ia-plat-edge { fill:none; stroke:rgba(220,235,255,.16); stroke-width:1.1; }
.ia-plat-label { font-size:10px; font-weight:600; letter-spacing:.24em; fill:rgba(238,243,252,.6); }

.ia-edge-line { fill:none; stroke:var(--edge-c, #96a0b5); stroke-width:var(--ew, 1.4); stroke-opacity:.78; stroke-linecap:round; animation:ia-flow var(--flow-dur, 24s) linear infinite; }
.ia-edge:hover .ia-edge-line { stroke-opacity:1; stroke-width:calc(var(--ew, 1.4) + .9); }
.ia-edge-hot .ia-edge-line { stroke-opacity:1; stroke-width:calc(var(--ew, 1.4) + .8); }
.ia-edge-dim { opacity:.13; transition:opacity .3s ease; }
.ia-edge { transition:opacity .3s ease; }
.ia-edge-head { fill:var(--edge-c, #96a0b5); fill-opacity:.85; }
.ia-edge-hit { fill:none; stroke:transparent; stroke-width:11; pointer-events:stroke; cursor:pointer; }
.ia-packet-core { fill:var(--edge-c, #96a0b5); }
.ia-packet-halo { fill:var(--edge-c, #96a0b5); opacity:.22; }
.ia-burst circle { fill:var(--ui-danger, #ef4444); opacity:0; animation:ia-burst-fade 1.7s ease-out 3; }

.ia-node { cursor:pointer; }
.ia-lift { transition:transform .18s ease, filter .18s ease; }
.ia-node:hover .ia-lift { transform:translateY(-2.5px); }
.ia-node-active .ia-lift { transform:translateY(-5px); }
.ia-f-top { fill:color-mix(in srgb, var(--mat, #424a5e) 84%, #ffffff); stroke:rgba(255,255,255,.09); stroke-width:.6; }
.ia-f-left { fill:color-mix(in srgb, var(--mat, #424a5e) 74%, #000000); stroke:rgba(255,255,255,.05); stroke-width:.6; }
.ia-f-right { fill:color-mix(in srgb, var(--mat, #424a5e) 50%, #000000); stroke:rgba(255,255,255,.04); stroke-width:.6; }
.ia-f-back { fill:color-mix(in srgb, var(--mat, #424a5e) 34%, #000000); stroke:none; }
.ia-detail { stroke:rgba(255,255,255,.14); stroke-width:1; fill:none; }
.ia-groove { stroke:rgba(0,0,0,.34); stroke-width:1; fill:none; }
.ia-shadow { fill:rgba(3,6,14,.35); filter:url(#ia-soft); }
.ia-dglow { opacity:.28; filter:url(#ia-soft); animation:ia-glowp 3s ease-in-out infinite; }
.ia-sel-ring { fill:color-mix(in srgb, var(--ui-accent, #6366f1) 10%, transparent); stroke:var(--ui-accent, #6366f1); stroke-width:1.5; stroke-dasharray:7 5; animation:ia-ants 1.1s linear infinite; }
.ia-node-title { font-size:10px; font-weight:600; fill:var(--ui-text-primary, currentColor); paint-order:stroke; stroke:rgba(8,10,16,.72); stroke-width:2.6px; stroke-linejoin:round; }
.ia-node-sub2 { font-size:8px; fill:var(--ui-text-quaternary, #9ca3af); paint-order:stroke; stroke:rgba(8,10,16,.72); stroke-width:2.2px; stroke-linejoin:round; }
.ia-chipf { animation:ia-chipf 3.2s ease-in-out infinite; }
.ia-chip-box { fill:rgba(10,12,18,.82); stroke-width:1; }
.ia-chip-text { font-size:8.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.ia-alert-base { fill:color-mix(in srgb, var(--ui-danger, #ef4444) 9%, transparent); stroke:var(--ui-danger, #ef4444); stroke-width:1.3; stroke-dasharray:4 4; stroke-opacity:.85; }

/* per-kind signature details */
.ia-led { animation:ia-led-b 2.2s ease-in-out infinite; }
.ia-led-b { animation:ia-led-b 3.4s ease-in-out infinite; }
.ia-led-f { animation:ia-led-f 1.1s steps(2, jump-none) infinite; }
.ia-screen { fill:#0b1120; fill-opacity:.92; stroke-width:1; stroke-opacity:.75; }
.ia-scan { stroke:rgba(190,210,255,.85); stroke-width:1.6; animation:ia-scan 2.8s linear infinite; }
.ia-glass { fill:color-mix(in srgb, var(--mat, #4c5262) 34%, #0e1420); stroke:rgba(255,255,255,.16); stroke-width:1; }
.ia-liquid { opacity:.82; }
.ia-meniscus { opacity:.55; animation:ia-meniscus 3s ease-in-out infinite; }
.ia-rim { fill:color-mix(in srgb, var(--mat, #4c5262) 20%, #0e1420); stroke-width:1.6; }
.ia-glass-shine { fill:rgba(255,255,255,.12); }
.ia-hum { transform-box:fill-box; transform-origin:center; animation:ia-hum 2.6s ease-in-out infinite; }
.ia-door { fill:color-mix(in srgb, var(--acc, #22c1d6) 38%, #0e1420); stroke-width:1.4; fill-opacity:.95; }
.ia-glyph { fill:none; stroke-width:1.3; }
.ia-visor { stroke-width:2.8; stroke-linecap:round; opacity:.98; }
.ia-bob { animation:ia-bob 3.4s ease-in-out infinite; }
.ia-bob-slow { animation-duration:4.6s; }
.ia-orb { opacity:.92; filter:url(#ia-soft); }
.ia-orb-shine { fill:rgba(255,255,255,.55); }
.ia-orbit-ring { fill:none; stroke:var(--acc, #e879f9); stroke-width:.8; stroke-opacity:.4; }
.ia-clock-face { fill:#141d2c; stroke:rgba(255,255,255,.38); stroke-width:1.3; }
.ia-clock-tick { fill:rgba(255,255,255,.55); }
.ia-clock-hand { stroke-width:1.9; stroke-linecap:round; }
.ia-ping { fill:none; stroke-width:1.2; transform-box:fill-box; transform-origin:center; animation:ia-ping 3s ease-out infinite; opacity:0; }

/* health beacons */
.ia-beacon { filter:url(#ia-soft); }
.ia-beacon-up { animation:ia-beacon-soft 2.6s ease-in-out infinite; }
.ia-beacon-degraded { animation:ia-beacon-hard 1.2s ease-in-out infinite; }
.ia-beacon-down { animation:ia-beacon-hard .55s ease-in-out infinite; }
.ia-beacon-unknown, .ia-beacon-observed { opacity:.5; }
.ia-alert { fill:none; stroke:var(--ui-danger, #ef4444); stroke-width:1.4; transform-box:fill-box; transform-origin:center; animation:ia-ping 1.8s ease-out infinite; opacity:0; }
.ia-ripple { fill:none; stroke-width:1.8; transform-box:fill-box; transform-origin:center; animation:ia-ping 1.25s ease-out 3; opacity:0; }

/* entrance choreography: platforms rise, nodes drop in by depth wave */
.ia-enter .ia-lift { animation:ia-drop .62s cubic-bezier(.22,.9,.34,1.18) both; animation-delay:var(--d, 0ms); }
.ia-enter .ia-shadow { animation:ia-fade .5s ease both; animation-delay:var(--d, 0ms); }

/* live agent overlay: blocked calls shake, reads and touches ripple */
.ia-pulse-touch_blocked .ia-lift { animation:ia-shake .4s ease-in-out 4; }
.ia-pulse-touch_allowed .ia-lift { animation:ia-flash-allowed 1.4s ease-out 1; }
.ia-pulse-read_doc .ia-lift { animation:ia-flash-read 1.4s ease-out 1; }

@keyframes ia-rise { 0% { opacity:0; transform:translateY(14px); } 100% { opacity:1; transform:translateY(0); } }
@keyframes ia-drop { 0% { opacity:0; transform:translateY(-30px); } 55% { opacity:1; transform:translateY(3px); } 76% { transform:translateY(-2px); } 100% { opacity:1; transform:translateY(0); } }
@keyframes ia-fade { from { opacity:0; } to { opacity:1; } }
@keyframes ia-flow { to { stroke-dashoffset:-220; } }
@keyframes ia-ants { to { stroke-dashoffset:-24; } }
@keyframes ia-glowp { 0%,100% { opacity:.16; } 50% { opacity:.38; } }
@keyframes ia-led-b { 0%,100% { opacity:1; } 50% { opacity:.25; } }
@keyframes ia-led-f { 0% { opacity:1; } 50% { opacity:.15; } 62% { opacity:.9; } 74% { opacity:.2; } }
@keyframes ia-scan { 0% { transform:translateY(0); opacity:0; } 10% { opacity:.85; } 86% { opacity:.85; } 100% { transform:translateY(24px); opacity:0; } }
@keyframes ia-meniscus { 0%,100% { transform:translate(0,0); opacity:.55; } 50% { transform:translate(1.4px,.7px); opacity:.75; } }
@keyframes ia-slosh { 0%,100% { transform:translate(0,0); } 25% { transform:translate(1.5px,.8px); } 75% { transform:translate(-1.5px,-.3px); } }
@keyframes ia-hum { 0%,100% { transform:scale(1); } 50% { transform:scale(1.013); } }
@keyframes ia-bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-5.5px); } }
@keyframes ia-blink { 0%,100% { opacity:1; } 50% { opacity:.18; } }
@keyframes ia-ping { 0% { transform:scale(.3); opacity:.9; } 70% { opacity:.4; } 100% { transform:scale(1.75); opacity:0; } }
@keyframes ia-beacon-soft { 0%,100% { opacity:.95; } 50% { opacity:.45; } }
@keyframes ia-beacon-hard { 0%,100% { opacity:1; } 50% { opacity:.15; } }
@keyframes ia-chipf { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-1.6px); } }
@keyframes ia-burst-fade { 0% { opacity:0; } 12% { opacity:1; } 80% { opacity:.9; } 100% { opacity:0; } }
@keyframes ia-shake { 0%,100% { transform:translateX(0); } 25% { transform:translateX(-3.5px); } 75% { transform:translateX(3.5px); } }
@keyframes ia-flash-allowed { 0% { filter:drop-shadow(0 0 6px var(--ui-success, #10b981)); } 100% { filter:none; } }
@keyframes ia-flash-read { 0% { filter:drop-shadow(0 0 7px var(--ui-info, #06b6d4)); } 100% { filter:none; } }

@media (prefers-reduced-motion: reduce) {
  .ia-plat, .ia-edge-line, .ia-packet, .ia-burst, .ia-led, .ia-led-b, .ia-led-f, .ia-scan, .ia-meniscus,
  .ia-hum, .ia-bob, .ia-blink, .ia-ping, .ia-beacon-up, .ia-beacon-degraded, .ia-beacon-down, .ia-alert,
  .ia-chipf, .ia-dglow, .ia-sel-ring, .ia-enter .ia-lift, .ia-enter .ia-shadow,
  .ia-pulse-touch_blocked .ia-lift, .ia-pulse-touch_allowed .ia-lift, .ia-pulse-read_doc .ia-lift,
  .ia-incident-icon, .ia-live-dot { animation:none; }
  .ia-packet, .ia-burst { display:none; }
}

.ia-empty { display:flex; align-items:center; justify-content:center; height:100%; padding:24px; text-align:center; color:#5f6f8f; }
.ia-inspector { flex:0 0 354px; width:354px; display:flex; flex-direction:column; min-height:0; min-width:0; border-left:1px solid rgba(96,126,190,.2); }
.ia-inspector-empty { padding:16px; gap:8px; }
.ia-inspector-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:13px 14px 8px; }
.ia-inspector-title { font-size:13px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
.ia-inspector-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px; }
.ia-close { background:transparent; border:none; color:#5f6f8f; cursor:pointer; font-size:12px; }
.ia-close:hover { color:#9fd8ff; }
.ia-tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid rgba(96,126,190,.16); }
.ia-tab { background:transparent; border:none; border-bottom:2px solid transparent; color:#5f6f8f; padding:7px 9px; font-size:10px; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; }
.ia-tab:hover { color:#9fb0cc; }
.ia-tab-active { color:#9fd8ff; border-bottom-color:#38bdf8; }
.ia-tab-body { flex:1 1 auto; overflow:auto; padding:11px 13px; display:flex; flex-direction:column; gap:11px; }
.ia-inspector-foot { display:flex; gap:6px; padding:9px 13px; border-top:1px solid rgba(96,126,190,.16); background:rgba(10,14,24,.6); }
.ia-kv { display:flex; flex-direction:column; gap:4px; }
.ia-kv-row { display:flex; align-items:baseline; font-size:11px; }
.ia-kv-key { color:#5f6f8f; text-transform:uppercase; font-size:9px; letter-spacing:.1em; flex:0 0 auto; }
.ia-kv-lead { flex:1 1 auto; min-width:10px; border-bottom:1px dotted rgba(96,126,190,.3); margin:0 7px; transform:translateY(-3px); }
.ia-kv-value { min-width:0; overflow-wrap:anywhere; color:#bcd2ee; text-align:right; }
.ia-block { display:flex; flex-direction:column; gap:6px; }
.ia-block-title { font-size:9px; text-transform:uppercase; letter-spacing:.16em; color:#7fa7d9; }
.ia-block-title::before { content:'// '; color:#38bdf8; }
.ia-pitfall { box-shadow:inset 0 0 0 1px rgba(245,158,11,.4); clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px); padding:9px; background:rgba(245,158,11,.08); }
.ia-list { margin:0; padding-left:14px; display:flex; flex-direction:column; gap:3px; font-size:11px; color:#9fb0cc; }
.ia-muted { color:#5f6f8f; font-size:11px; }
.ia-row { display:flex; gap:6px; flex-wrap:wrap; }
.ia-tag { box-shadow:inset 0 0 0 1px rgba(96,126,190,.35); clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px); padding:2px 8px; font-size:8.5px; text-transform:uppercase; letter-spacing:.1em; color:#9fb0cc; background:rgba(17,23,38,.6); }
.ia-table { width:100%; border-collapse:collapse; font-size:11px; }
.ia-table th { text-align:left; font-weight:600; text-transform:uppercase; font-size:8.5px; letter-spacing:.12em; color:#5f6f8f; padding:3px 4px; border-bottom:1px solid rgba(96,126,190,.25); }
.ia-table td { padding:4px; border-top:1px solid rgba(96,126,190,.12); vertical-align:top; overflow-wrap:anywhere; color:#bcd2ee; }
.ia-stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; }
.ia-stat { clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px); background:rgba(17,23,38,.7); box-shadow:inset 0 0 0 1px rgba(96,126,190,.22); padding:7px; }
.ia-stat-value { font-size:13px; font-weight:700; color:#eaf4ff; font-variant-numeric:tabular-nums; }
.ia-stat-label { font-size:8px; text-transform:uppercase; letter-spacing:.12em; color:#5f6f8f; margin-top:2px; }
.ia-spark { display:flex; align-items:flex-end; gap:2px; height:44px; }
.ia-spark-bar { flex:1 1 0; background:#38bdf8; opacity:.8; min-height:4px; }
.ia-spark-down { background:#ef4444; opacity:.9; }
.ia-runbook { margin:0; font-size:11px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; background:rgba(10,14,24,.7); box-shadow:inset 0 0 0 1px rgba(96,126,190,.2); padding:9px; max-height:none; color:#bcd2ee; }
.ia-stream { flex:0 0 auto; max-height:150px; overflow:auto; padding:8px 14px 10px; border-top:1px solid rgba(96,126,190,.18); }
.ia-stream-title { font-size:9px; text-transform:uppercase; letter-spacing:.18em; color:#7fa7d9; margin-bottom:5px; display:flex; align-items:center; gap:7px; }
.ia-live-dot { width:6px; height:6px; flex:0 0 6px; background:#38bdf8; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); animation:ia-beacon-soft 1.8s ease-in-out infinite; }
.ia-stream-rows { display:flex; flex-direction:column; gap:2px; }
.ia-stream-row { display:flex; gap:8px; font-size:11px; padding:2px 0 2px 10px; border-left:2px solid rgba(96,126,190,.25); }
.ia-stream-row.ia-kind-touch_blocked { border-left-color:#ef4444; }
.ia-stream-row.ia-kind-touch_allowed { border-left-color:#10b981; }
.ia-stream-row.ia-kind-read_doc { border-left-color:#22d3ee; }
.ia-stream-time { color:#5f6f8f; width:64px; flex:0 0 64px; font-variant-numeric:tabular-nums; }
.ia-stream-kind { width:96px; flex:0 0 96px; text-transform:uppercase; font-size:8.5px; letter-spacing:.08em; color:#9fb0cc; padding-top:2px; }
.ia-stream-text { color:#9fb0cc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-kind-touch_blocked .ia-stream-kind, .ia-kind-touch_blocked .ia-stream-text { color:#f87171; }
.ia-kind-touch_allowed .ia-stream-kind { color:#34d399; }
.ia-kind-read_doc .ia-stream-kind { color:#22d3ee; }
.ia-stream-foot { margin-top:5px; font-size:10px; color:#f87171; }
.ia-chip { font-size:11px; padding:1px 8px; color:#9fb0cc; background:rgba(17,23,38,.7); border:none; box-shadow:inset 0 0 0 1px rgba(96,126,190,.3); clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); cursor:pointer; }
.ia-chip:hover { color:#eaf4ff; }
.ia-chip-alert { color:#fca5a5; box-shadow:inset 0 0 0 1px rgba(239,68,68,.5); }
.ia-chip-blocked { color:#fca5a5; animation:ia-chip-flash .9s ease-in-out 4; }
@keyframes ia-chip-flash { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.ia-json { font-size:10px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.ia-card { display:flex; flex-direction:column; gap:6px; font-size:11px; padding:1px; background:rgba(96,146,210,.42); clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px); }
.ia-card .ia-hud-in { padding:10px 12px; display:flex; flex-direction:column; gap:6px; font-size:11px; }
.ia-card-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.ia-card-dot { width:7px; height:7px; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); display:inline-block; }
.ia-card-sub { color:#5f6f8f; }
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
