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

// ============================================================================
// PERFORMANCE UTILITIES
// ============================================================================

/**
 * Deep equality check for objects/arrays - used for memoization
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!keysB.includes(key)) return false
    if (!deepEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * Create a stable key for a node based on its essential properties
 */
function nodeKey(node) {
  if (!node) return 'null'
  return `${node.id}:${node.kind}:${node.health_status}:${node.drift_status}:${(node.ports || []).join(',')}`
}

/**
 * Create a stable key for an edge
 */
function edgeCacheKey(x1, y1, x2, y2) {
  if (x2 < x1 || (x2 === x1 && y2 < y1)) return `${x2},${y2},${x1},${y1}`
  return `${x1},${y1},${x2},${y2}`
}

/**
 * Debounce function - limits how often a function can be called
 */
function debounce(fn, delay) {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

/**
 * Throttle function - ensures function is called at most once per period
 */
function throttle(fn, limit) {
  let inThrottle = false
  return (...args) => {
    if (!inThrottle) {
      fn(...args)
      inThrottle = true
      setTimeout(() => { inThrottle = false }, limit)
    }
  }
}

// ============================================================================
// PERFORMANCE CACHES
// ============================================================================

// Cache for scene plans
const scenePlanCache = new Map()

// Cache for edge routes
const edgeRouteCache = new Map()
const congestionCache = new Map()

// Cache for geometry calculations
const geometryCache = new Map()

// Cache for shape bodies
const shapeBodyCache = new Map()

// Clear all caches (call when major changes occur)
function clearAllCaches() {
  scenePlanCache.clear()
  edgeRouteCache.clear()
  congestionCache.clear()
  geometryCache.clear()
  shapeBodyCache.clear()
}

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
// drift statuses roll up into three view groups the UI filters by
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

// OPTIMIZED: Custom hooks with deep equality checking to prevent unnecessary re-renders
function useGraph(interval = 10000) {
  const result = useQuery({
    queryKey: ['infra-atlas', 'graph'],
    queryFn: () => rest('/graph'),
    refetchInterval: interval,
    staleTime: 4000
  })
  
  // Add custom comparison to avoid re-renders when data hasn't meaningfully changed
  const prevDataRef = React.useRef(null)
  const shouldSkip = React.useMemo(() => {
    const current = result.data
    const prev = prevDataRef.current
    
    if (!prev || !current) {
      prevDataRef.current = current
      return false
    }
    
    // Only skip if key data hasn't changed
    if (!deepEqual(prev.nodes, current.nodes)) return false
    if (!deepEqual(prev.edges, current.edges)) return false
    if (!deepEqual(prev.counts, current.counts)) return false
    if (!deepEqual(prev.incidents, current.incidents)) return false
    if (!deepEqual(prev.config, current.config)) return false
    
    prevDataRef.current = current
    return true
  }, [result.data])
  
  // Return previous data if we should skip
  if (shouldSkip && prevDataRef.current) {
    return { ...result, data: prevDataRef.current }
  }
  
  prevDataRef.current = result.data
  return result
}

function useNode(nodeId) {
  const result = useQuery({
    queryKey: ['infra-atlas', 'node', nodeId],
    queryFn: () => rest(`/node/${encodeURIComponent(nodeId)}`),
    enabled: Boolean(nodeId),
    staleTime: 4000
  })
  
  // For node data, we can be more aggressive with caching since it changes less frequently
  const prevDataRef = React.useRef(null)
  const shouldSkip = React.useMemo(() => {
    const current = result.data
    const prev = prevDataRef.current
    
    if (!prev || !current) {
      prevDataRef.current = current
      return false
    }
    
    // Skip if node data hasn't changed
    if (!deepEqual(prev.node, current.node)) return false
    if (!deepEqual(prev.diff, current.diff)) return false
    if (!deepEqual(prev.incidents, current.incidents)) return false
    
    prevDataRef.current = current
    return true
  }, [result.data])
  
  if (shouldSkip && prevDataRef.current) {
    return { ...result, data: prevDataRef.current }
  }
  
  prevDataRef.current = result.data
  return result
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
// OPTIMIZED: Memoized to avoid recomputation when nodes haven't changed
function sceneCacheKey(nodes) {
  if (!nodes || nodes.length === 0) return 'empty'
  return nodes.map(n => nodeKey(n)).join(';')
}

function planScene(nodes) {
  const cacheKey = sceneCacheKey(nodes)
  
  // Return cached plan if available
  if (scenePlanCache.has(cacheKey)) {
    return scenePlanCache.get(cacheKey)
  }
  
  if (!nodes.length) {
    const emptyPlan = { platforms: [], placed: new Map(), zAt: () => 0, latticeOk: () => false, hugCost: () => 0, stepAt: () => false, width: 760, height: 420, origin: { x: 0, y: 0 } }
    scenePlanCache.set(cacheKey, emptyPlan)
    return emptyPlan
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
  // the y where the terrace level changes between two grid rows (the cliff lip)
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
    const cliff = 16 + ISO.stepZ // every slab is the same thickness
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
  const plan = {
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
    origin: { x: ISO.pad - minX, y: ISO.pad - minY }
  }
  
  // Cache the result
  scenePlanCache.set(cacheKey, plan)
  return plan
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

// OPTIMIZED: Cached pathfinding with early exits
function findPath(plan, congestion, start, goal) {
  // Create cache key for this path
  const cacheKey = `${start.x},${start.y},${goal.x},${goal.y}`
  
  // Check cache first
  if (edgeRouteCache.has(cacheKey)) {
    return edgeRouteCache.get(cacheKey)
  }
  
  // Early exit for simple cases
  const dx = Math.abs(goal.x - start.x)
  const dy = Math.abs(goal.y - start.y)
  if (dx + dy <= 2) {
    const result = [start, goal]
    edgeRouteCache.set(cacheKey, result)
    return result
  }
  
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
  
  // Limit search iterations based on distance to improve performance
  const maxIterations = Math.min(60000, (dx + dy) * 100)
  
  while (open.length && guard++ < maxIterations && !found) {
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
        1.15 * (congestion.get(edgeCacheKey(current.x, current.y, nx, ny)) || 0)
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
  
  // Cache the result
  edgeRouteCache.set(cacheKey, tiles)
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

// OPTIMIZED: edge routing (caller memoizes; clear per-path cache per plan layout)
function routeEdges(edges, plan) {
  if (!plan.platforms.length) return []
  // Per-path cache is only valid for the current plan/layout; clear to keep routes correct.
  edgeRouteCache.clear()
  
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
    // project to screen; where a run crosses a terrace step the trace runs to
    // the cliff lip and drops straight down the cliff face — every segment
    // stays on an isometric grid line or plumbs vertically, no free diagonals
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
  return result
}

// ── iso shape primitives ───────────────────────────────────────────────────
// A box footprint spans ±ax/±ay grid units around the local origin (which sits
// on the platform surface); h is its pixel height. Corners: A back, B right,
// C front, D left; *t variants are the top face.
// OPTIMIZED: Cached to avoid redundant calculations

function boxGeom(ax, ay, h, baseY = 0) {
  const cacheKey = `${ax},${ay},${h},${baseY}`
  
  if (geometryCache.has(cacheKey)) {
    return geometryCache.get(cacheKey)
  }
  
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
  const result = {
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
  
  geometryCache.set(cacheKey, result)
  return result
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
    role: 'button',
    tabIndex: 0,
    'aria-label': `${node.label || node.id}, ${node.kind || 'node'}, health ${health}, drift ${DRIFT_LABEL[drift] || drift}`,
    onClick: event => {
      event.stopPropagation()
      onSelect(node.id)
    },
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        onSelect(node.id)
      }
    },
    style: { '--mat': scene.mat, '--acc': scene.accent, '--d': `${delay}ms` },
    children: [
      // crisp isometric diamonds — flat shadow plates, no soft blur
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
const IconSearch = ({ size = 14 }) =>
  jsx('svg', {
    className: 'ia-search-icon',
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    children: [
      jsx('circle', { cx: 6.7, cy: 6.7, r: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.35 }, 'search-ring'),
      jsx('path', { d: 'M 10 10 L 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }, 'search-handle')
    ]
  })

const LoadMark = () =>
  jsxs('span', {
    className: 'ia-load-mark',
    'aria-hidden': true,
    children: [0, 1, 2].map(i => jsx('span', { className: 'ia-load-diamond', style: { animationDelay: `${i * 120}ms` } }, `load-${i}`))
  })

// Canvas placeholder: what happened, one line of why, and the next action
// offered as a real button. role=status announces loading, role=alert errors.
function CanvasState({ tone, role = 'status', icon, title, detail, children }) {
  return jsx('div', {
    className: cn('ia-empty', tone && `ia-empty-${tone}`),
    role,
    children: jsxs('div', { className: 'ia-empty-in', children: [
      icon || null,
      jsx('div', { className: 'ia-empty-title', children: title }),
      detail ? jsx('div', { className: 'ia-empty-detail', children: detail }) : null,
      children ? jsx('div', { className: 'ia-empty-actions', children }) : null
    ] })
  })
}

// Skeleton loading component for better perceived performance
function GraphSkeleton() {
  return jsxs('div', {
    className: 'ia-skeleton',
    role: 'status',
    'aria-live': 'polite',
    children: [
      // Header skeleton
      jsxs('div', {
        className: 'ia-skeleton-header',
        children: [
          jsx('div', { className: 'ia-skeleton-title' }),
          jsx('div', { className: 'ia-skeleton-controls' })
        ]
      }),
      // Rail skeleton
      jsx('div', { className: 'ia-skeleton-rail' }),
      // Canvas skeleton with pulsing animation
      jsxs('div', {
        className: 'ia-skeleton-canvas',
        children: [
          // Simulate platform terraces
          jsx('div', { className: 'ia-skeleton-plat' }),
          jsx('div', { className: 'ia-skeleton-plat' }),
          jsx('div', { className: 'ia-skeleton-plat' }),
          // Simulate nodes
          Array.from({ length: 8 }).map((_, i) =>
            jsx('div', { 
              className: 'ia-skeleton-node', 
              style: { animationDelay: `${i * 0.1}s` } 
            }, `skeleton-node-${i}`)
          ),
          // Simulate edges
          Array.from({ length: 5 }).map((_, i) =>
            jsx('div', { 
              className: 'ia-skeleton-edge', 
              style: { animationDelay: `${i * 0.15}s` } 
            }, `skeleton-edge-${i}`)
          )
        ]
      })
    ]
  })
}

// header tooltips, written so someone who never saw the app understands the
// modes — wording follows the backend hooks (hooks.py, uptime.py)
const GUARDRAIL_HELP =
  'Agent guardrail — read-before-you-touch. BLOCK vetoes the agent’s commands on documented infrastructure until its registry entry has been read. WARN lets the command through and logs a warning. OFF disables the check entirely. Change it with the Guardrail selector.'
const AUTO_HEAL_HELP =
  'Downtime response when a probe reports a node down. AUTO runs the deterministic recovery playbook, then wakes the agent with the node runbook if that is not enough. PLAYBOOK ONLY stops at the playbook. NOTIFY ONLY records the incident without acting. OFF does nothing.'
const GUARDRAIL_SELECT_HELP =
  'Guardrail mode: how the read-before-you-touch policy treats agent commands on documented nodes.'
const AUTO_HEAL_SELECT_HELP =
  'Auto-heal mode: what happens automatically when a node fails its health probe.'

function InfraAtlasPage() {
  const [selectedId, setSelectedId] = React.useState(pendingSelect)
  const [filter, setFilter] = React.useState('all')
  const [search, setSearch] = React.useState('')
  const [activity, setActivity] = React.useState([])
  const [pulses, setPulses] = React.useState({})
  const [busy, setBusy] = React.useState('')
  const searchRef = React.useRef(null)

  const { data, isLoading, error, refetch } = useGraph(10000)

  React.useEffect(() => {
    pendingSelect = null
  }, [])

  // "/" anywhere focuses the fleet search — unless the user is already typing
  // in a field. Esc inside the field clears it (handled on the input itself).
  React.useEffect(() => {
    const onKey = event => {
      if (event.key !== '/' || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      const tag = target && target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
      event.preventDefault()
      if (searchRef.current) searchRef.current.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
  const lastSweep = (data && data.last_sweep) || null

  // header status cluster: sweep freshness (green < 10 min, amber when stale)
  // and the guardrail mode the agent is currently held to
  const sweepAt = Number(lastSweep && lastSweep.finished_at) || 0
  const sweepFresh = sweepAt > 0 && Date.now() / 1000 - sweepAt < 600
  const guardrailMode = String(config.guardrail_mode || 'block').toLowerCase()
  const guardrailTone = guardrailMode === 'block' || guardrailMode === 'warn' ? guardrailMode : 'off'

  const attentionCount = (counts.changed || 0) + (counts.unregistered || 0) + (counts.stale || 0)
  const otherCount = (counts.observed || 0) + (counts.doc_only || 0)

  const visible = nodes.filter(node => {
    if (filter !== 'all' && DRIFT_GROUP[node.drift_status] !== filter) return false
    if (!search.trim()) return true
    const needle = search.trim().toLowerCase()
    return [node.id, node.label, node.host_ip, node.tailnet_ip, node.systemd_unit, (node.ports || []).join(' ')]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(needle))
  })

  // from the fleet panel / rail: jump to a view, optionally pin a node open
  const focusFleet = (key, nodeId) => {
    setFilter(key)
    if (nodeId) setSelectedId(nodeId)
  }

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
      jsxs('header', {
        className: 'ia-header',
        'aria-label': 'Infra Atlas command bar',
        children: [
          jsxs('div', {
            className: 'ia-title',
            children: [
              jsx(IsoCubeMark, {}),
              jsxs('span', { className: 'ia-title-block', children: [
                jsx('span', { className: 'ia-title-word', children: 'Infra Atlas' }),
                jsx('span', {
                  className: 'ia-sub',
                  title: config.registry_path ? 'Registry the atlas is built from' : 'No registry path is configured yet',
                  children: config.registry_path || 'registry path not set'
                })
              ] })
            ]
          }),
          jsxs('div', {
            className: 'ia-controls',
            role: 'group',
            'aria-label': 'Fleet search and controls',
            children: [
              jsxs('div', { className: 'ia-search', role: 'search', children: [
                jsx(IconSearch, {}),
                jsx('input', {
                  ref: searchRef,
                  className: 'ia-search-in',
                  type: 'text',
                  placeholder: 'Find nodes, IPs, units…',
                  'aria-label': 'Find nodes by name, address, port or systemd unit',
                  autoComplete: 'off',
                  spellCheck: false,
                  value: search,
                  onChange: event => setSearch(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Escape' && search) {
                      setSearch('')
                      event.stopPropagation() // clearing the field should not also close panels
                    }
                  }
                }),
                search
                  ? jsx('button', {
                      type: 'button',
                      className: 'ia-search-clear',
                      title: 'Clear search (Esc)',
                      'aria-label': 'Clear search',
                      onClick: () => {
                        setSearch('')
                        if (searchRef.current) searchRef.current.focus()
                      },
                      children: '×'
                    })
                  : null,
                search ? null : jsx('kbd', { className: 'ia-search-kbd', 'aria-hidden': true, children: '/' })
              ] }),
              jsx('span', { className: 'ia-controls-sep', 'aria-hidden': true }),
              select('Guardrail', config.guardrail_mode, ['block', 'warn', 'off'], value =>
                toggleSetting('guardrail_mode', value), GUARDRAIL_SELECT_HELP, busy === 'guardrail_mode'
              ),
              select('Auto-heal', config.auto_heal_mode, ['auto', 'playbook_only', 'notify_only', 'off'], value =>
                toggleSetting('auto_heal_mode', value), AUTO_HEAL_SELECT_HELP, busy === 'auto_heal_mode'
              ),
              jsxs('button', {
                type: 'button',
                className: cn('ia-btn', config.demo_mode && 'ia-btn-on'),
                disabled: busy === 'demo_mode',
                title: config.demo_mode
                  ? 'You are looking at the sanitized demo fleet — click to return to your real fleet.'
                  : 'Explore the atlas with sanitized sample data first — nothing in your real fleet is touched.',
                onClick: () => toggleSetting('demo_mode', !config.demo_mode),
                children: [
                  jsx('span', {
                    className: 'ia-btn-diamond',
                    'aria-hidden': true,
                    style: { background: config.demo_mode ? '#fbbf24' : '#34d399' }
                  }),
                  config.demo_mode ? 'Live fleet' : 'Demo fleet'
                ]
              }),
              jsx('button', {
                type: 'button',
                className: 'ia-btn ia-btn-primary',
                disabled: busy === 'sweep',
                'aria-busy': busy === 'sweep' || undefined,
                title: 'Sweep now — discover hosts and services, probe health, and diff the registry against live state.',
                onClick: sweep,
                children: busy === 'sweep' ? 'Sweeping…' : '↻ Sweep now'
              })
            ]
          }),
          jsxs('div', {
            className: 'ia-status',
            role: 'group',
            'aria-label': 'Fleet status',
            children: [
              jsx('span', {
                className: cn('ia-guard', `ia-guard-${guardrailTone}`),
                title: GUARDRAIL_HELP,
                children: guardrailMode
              }),
              jsxs('span', {
                className: 'ia-status-chip',
                title: sweepAt
                  ? `Last sweep finished ${ago(sweepAt)} — the graph refreshes itself every 10 seconds.`
                  : 'No sweep has finished yet — run “Sweep now” to discover the fleet.',
                children: [
                  jsx('span', { className: cn('ia-fresh-dot', !sweepFresh && 'ia-fresh-dot-stale'), 'aria-hidden': true }),
                  sweepAt ? `swept ${ago(lastSweep && lastSweep.finished_at)}` : 'never swept'
                ]
              }),
              jsxs('span', {
                className: 'ia-status-chip',
                title: 'Nodes currently in the atlas, from hardware through agents.',
                children: [jsx('span', { className: 'ia-status-num', children: String(counts.total || 0) }), ' nodes']
              })
            ]
          })
        ]
      }),

      jsxs('div', {
        className: 'ia-rail',
        role: 'group',
        'aria-label': 'Fleet view filters',
        children: [
          jsx('span', { className: 'ia-rail-label', children: 'View' }),
          pill('all', 'All', filter, setFilter, '#38bdf8', counts.total || 0),
          pill('matched', 'Matched', filter, setFilter, '#34d399', counts.matched || 0),
          pill('attention', 'Attention', filter, setFilter, '#fbbf24', attentionCount),
          pill('other', 'Docs & peers', filter, setFilter, '#9fb0cc', otherCount),
          jsx('span', { className: 'ia-rail-spacer' }),
          jsx('span', {
            className: 'ia-rail-info',
            title: 'Nodes on the map after this view filter and the search box',
            children: `${visible.length} of ${counts.total || 0} nodes shown`
          })
        ]
      }),

      incidents.length
        ? jsx(IncidentStrip, { incidents, onHeal: nodeId => healNode(nodeId, setBusy, refetch) })
        : null,

      jsxs('div', {
        className: 'ia-body',
        children: [
          jsxs('div', {
            className: 'ia-canvas',
            children: [
              error
                ? jsxs(CanvasState, {
                    tone: 'error',
                    role: 'alert',
                    title: 'The fleet graph could not load',
                    detail: `The Infra Atlas API answered: ${error.message || error}. Check that the backend is up, then retry.`,
                    icon: jsxs('svg', {
                      className: 'ia-empty-icon',
                      width: 20,
                      height: 18,
                      viewBox: '0 0 20 18',
                      'aria-hidden': true,
                      children: [
                        jsx('path', { d: 'M 10 1.6 L 18.6 16.2 L 1.4 16.2 Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
                        jsx('path', { d: 'M 10 6.6 L 10 10.6', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
                        jsx('circle', { cx: 10, cy: 13.4, r: 1, fill: 'currentColor' })
                      ]
                    }),
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'ia-btn ia-btn-primary',
                        onClick: () => void refetch(),
                        children: '↻ Retry'
                      })
                    ]
                  })
                : isLoading && !nodes.length
                  ? jsx(GraphSkeleton, {})
                  : nodes.length
                    ? visible.length
                      ? jsx(Topology, { nodes: visible, edges, selectedId, onSelect: setSelectedId, pulseFor: nodePulse })
                      : jsxs(CanvasState, {
                          title: 'Nothing matches this view',
                          detail: 'The view pills above and the search box decide which shapes are drawn.',
                          icon: jsx(IconSearch, { size: 18 }),
                          children: [
                            jsx('button', {
                              type: 'button',
                              className: 'ia-btn',
                              onClick: () => {
                                setFilter('all')
                                setSearch('')
                              },
                              children: 'Show the whole fleet'
                            })
                          ]
                        })
                    : jsxs(CanvasState, {
                        title: 'No nodes in the atlas yet',
                        detail: 'Run a sweep to discover hosts, services and peers — or look around the sanitized demo fleet first.',
                        icon: jsx(IsoCubeMark, {}),
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: 'ia-btn ia-btn-primary',
                            disabled: busy === 'sweep',
                            onClick: sweep,
                            children: busy === 'sweep' ? 'Sweeping…' : '↻ Sweep now'
                          }),
                          config.demo_mode
                            ? null
                            : jsx('button', {
                                type: 'button',
                                className: 'ia-btn',
                                disabled: busy === 'demo_mode',
                                onClick: () => toggleSetting('demo_mode', true),
                                children: 'Turn on the demo fleet'
                              })
                        ]
                      }),
              nodes.length && !error ? jsx(Legend, {}) : null
            ]
          }),
          jsx(Inspector, {
            node: selected,
            busy,
            onClose: () => setSelectedId(null),
            onRefetch: refetch,
            setBusy,
            guardrail: config.guardrail_mode,
            counts,
            fleetIncidents: incidents,
            lastSweep,
            onFocus: focusFleet
          })
        ]
      }),

      jsx(ActivityStream, { entries: activity.length ? activity : (data && data.activity) || [], incidents })
    ]
  })
}

function pill(key, label, active, setActive, color, count) {
  const selected = active === key
  return jsxs('button', {
    type: 'button',
    className: cn('ia-pill', selected && 'ia-pill-active'),
    style: { '--pill-c': color || '#38bdf8' },
    'aria-pressed': selected,
    title: selected ? `Showing ${label.toLowerCase()} nodes` : `Show ${label.toLowerCase()} nodes`,
    onClick: () => setActive(selected ? 'all' : key),
    children: [
      jsx('span', { className: 'ia-pill-tick', 'aria-hidden': true }),
      jsx('span', { children: label }),
      jsx('span', { className: 'ia-pill-count', children: String(count ?? 0) })
    ]
  }, key)
}

function select(label, value, options, onChange, title, disabled = false) {
  return jsxs('label', {
    className: cn('ia-select', disabled && 'ia-select-disabled'),
    title,
    children: [
      jsx('span', { children: label }),
      jsx('select', {
        'aria-label': label,
        value: value || options[0],
        disabled,
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
// OPTIMIZED: Memoized platform components
const PlatformView = React.memo(function PlatformView({ platform, next, sel }) {
  const p = platform
  const z = p.z
  const A = { x: projX(p.L, p.P), y: projY(p.L, p.P, z) }
  const B = { x: projX(p.L + p.W, p.P), y: projY(p.L + p.W, p.P, z) }
  const C = { x: projX(p.L + p.W, p.P + p.D), y: projY(p.L + p.W, p.P + p.D, z) }
  const D = { x: projX(p.L, p.P + p.D), y: projY(p.L, p.P + p.D, z) }
  // every slab is the same thickness: one joint row plus one level drop, so
  // each cliff meets the next terrace's top edge exactly
  const dz = 16 + ISO.stepZ
  const face = (p1, p2, depth) =>
    `M ${r2(p1.x)} ${r2(p1.y)} L ${r2(p2.x)} ${r2(p2.y)} L ${r2(p2.x)} ${r2(p2.y + depth)} L ${r2(p1.x)} ${r2(p1.y + depth)} Z`
  // backstop seam filler under the cliff, fusing the terraces together
  const riser = next
    ? `M ${r2(D.x)} ${r2(D.y)} L ${r2(C.x)} ${r2(C.y)} L ${r2(projX(next.L + next.W, next.P))} ${r2(projY(next.L + next.W, next.P, next.z))} L ${r2(projX(next.L, next.P))} ${r2(projY(next.L, next.P, next.z))} Z`
    : null
  
  // OPTIMIZED: Pre-calculate grid lines once
  const grid = React.useMemo(() => {
    let g = ''
    for (let gx = p.L + 1; gx < p.L + p.W; gx++) g += `M ${r2(projX(gx, p.P))} ${r2(projY(gx, p.P, z))} L ${r2(projX(gx, p.P + p.D))} ${r2(projY(gx, p.P + p.D, z))} `
    for (let gy = p.P + 1; gy < p.P + p.D; gy++) g += `M ${r2(projX(p.L, gy))} ${r2(projY(p.L, gy, z))} L ${r2(projX(p.L + p.W, gy))} ${r2(projY(p.L + p.W, gy, z))} `
    return g
  }, [p.L, p.P, p.W, p.D, z])
  
  return jsxs('g', {
    className: cn('ia-plat', `ia-plat-${p.t % 4}`, sel && 'ia-plat-sel'),
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

// stratum labels ride the right end of each terrace's front face; they render
// after every platform so a lower terrace can never paint over them
// OPTIMIZED: Memoized label
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

// OPTIMIZED: Memoized EdgeView with stable props
const EdgeView = React.memo(function EdgeView({ route, selectedId, hoverId, onSelect, pulseFor, labelHint, onTagShow, onTagMove, onTagHide }) {
  const { edge, style } = route
  const touches = React.useCallback(id => edge.source_id === id || edge.target_id === id, [edge.source_id, edge.target_id])
  const hot = Boolean(selectedId) && touches(selectedId)
  const nb = !hot && Boolean(hoverId) && touches(hoverId)
  const dim = Boolean(selectedId) && !hot && !nb
  const burst = pulseFor && (pulseFor(edge.source_id) === 'touch_blocked' || pulseFor(edge.target_id) === 'touch_blocked')
  
  // OPTIMIZED: Cache regex and end point calculation
  const end = React.useMemo(() => {
    const endMatch = /L\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/.exec(route.d)
    return endMatch ? { x: Number(endMatch[1]), y: Number(endMatch[2]) } : route.chevron
  }, [route.d, route.chevron])
  
  // OPTIMIZED: Memoized event handlers
  const handleClick = React.useCallback(event => {
    event.stopPropagation()
    if (onSelect) onSelect(edge.source_id)
  }, [edge.source_id, onSelect])
  
  const handlePointerEnter = React.useCallback(event => {
    if (onTagShow) onTagShow(labelHint, style.color, event)
  }, [labelHint, style.color, onTagShow])
  
  const handlePointerMove = React.useCallback(event => {
    if (onTagMove) onTagMove(event)
  }, [onTagMove])
  
  const handlePointerLeave = React.useCallback(() => {
    if (onTagHide) onTagHide()
  }, [onTagHide])
  
  return jsxs('g', {
    className: cn('ia-edge', `ia-edge-${edge.relation}`, hot && 'ia-edge-hot', nb && 'ia-edge-nb', dim && 'ia-edge-dim'),
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
      // arrival tick: same period and phase offset as the packet, so the hairline
      // diamond flashes exactly when a packet lands at the target port
      route.length > 0
        ? jsx('g', {
            transform: `translate(${r2(end.x)} ${r2(end.y)})`,
            children: jsx('path', {
              d: 'M 0 -3.2 L 4.4 0 L 0 3.2 L -4.4 0 Z',
              className: 'ia-arrive',
              style: { animationDuration: `${route.dur}s`, animationDelay: `${(-route.phase * route.dur).toFixed(2)}s` }
            })
          })
        : null,
      burst
        ? [0, 1, 2].map(i =>
            jsxs('g', { className: 'ia-burst', style: { animationDelay: `${i * 0.24}s` }, children: [
              jsx('circle', { r: 3 }),
              jsx('animateMotion', { path: route.d, dur: '1.7s', begin: `${(i * 0.22).toFixed(2)}s`, repeatCount: '3', calcMode: 'linear' })
            ] }, `burst-${i}`))
        : null,
      jsx('path', {
        d: route.d,
        className: 'ia-edge-hit',
        'aria-label': labelHint,
        onClick: handleClick,
        onPointerEnter: handlePointerEnter,
        onPointerMove: handlePointerMove,
        onPointerLeave: handlePointerLeave
      })
    ]
  })
})

const ZOOM_MIN = 0.42
const ZOOM_MAX = 2.4
const ZOOM_STEP = 1.2

// OPTIMIZED: Memoized Topology component with useCallback for handlers
const Topology = React.memo(function Topology({ nodes, edges, selectedId, onSelect, pulseFor }) {
  const plan = React.useMemo(() => planScene(nodes), [nodes])
  const routed = React.useMemo(() => routeEdges(edges, plan), [edges, plan])
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const [hoverNode, setHoverNode] = React.useState(null) // node id under the pointer
  const [edgeTag, setEdgeTag] = React.useState(null) // { label, color } for the hovered trace
  const dragRef = React.useRef(null)
  const seenRef = React.useRef(null)
  const wrapRef = React.useRef(null)
  const tagRef = React.useRef(null)

  const viewBox = `${-offset.x} ${-offset.y} ${plan.width / zoom} ${plan.height / zoom}`

  const zoomIn = React.useCallback(() => setZoom(z => Math.min(ZOOM_MAX, z * ZOOM_STEP)), [])
  const zoomOut = React.useCallback(() => setZoom(z => Math.max(ZOOM_MIN, z / ZOOM_STEP)), [])
  const resetView = React.useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  // OPTIMIZED: Throttled pointer move for better performance
  const onPointerMove = React.useCallback(throttle(event => {
    if (!dragRef.current) return
    const dx = (event.clientX - dragRef.current.x) / zoom
    const dy = (event.clientY - dragRef.current.y) / zoom
    // grab semantics: the paper follows the pointer (viewBox.x = -offset.x)
    setOffset({ x: dragRef.current.ox + dx, y: dragRef.current.oy + dy })
  }, 16), [zoom])

  const onPointerDown = React.useCallback(event => {
    const target = event.target
    if (target && target.closest && (target.closest('[data-node-id]') || target.closest('.ia-edge-hit'))) return
    setEdgeTag(null)
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [offset.x, offset.y])

  const onPointerUp = React.useCallback(() => {
    dragRef.current = null
  }, [])

  // node hover via delegation, so IsoNode stays untouched; setState bails out
  // on identical values, so jittering inside one shape never re-renders
  const onNodeOver = React.useCallback(event => {
    const g = event.target && event.target.closest && event.target.closest('[data-node-id]')
    if (!g) return
    const id = g.getAttribute('data-node-id')
    if (id !== hoverNode) setHoverNode(id)
  }, [hoverNode])

  const onNodeOut = React.useCallback(event => {
    if (!hoverNode) return
    const to = event.relatedTarget
    if (to && to.closest && to.closest('[data-node-id]')) return // still on a shape; over() owns the switch
    setHoverNode(null)
  }, [hoverNode])

  // relation tag follows the cursor; moves are DOM-only (transform) so hover
  // never triggers a React render storm — state flips only on enter/leave
  const placeTag = React.useCallback(event => {
    const el = tagRef.current
    const wrap = wrapRef.current
    if (!el || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const flip = px > rect.width - 200
    el.style.transform = `translate(${Math.round(flip ? px - 196 : px + 14)}px, ${Math.round(py + 16)}px)`
  }, [])

  const showTag = React.useCallback((label, color, event) => {
    placeTag(event)
    setEdgeTag({ label, color })
  }, [placeTag])

  const moveTag = React.useCallback(event => {
    if (edgeTag) placeTag(event)
  }, [edgeTag, placeTag])

  const hideTag = React.useCallback(() => setEdgeTag(null), [])

  // keyboard pan/zoom on the focused canvas: arrows move the camera, +/− zoom,
  // 0 resets to the default framing
  const onKeyDown = React.useCallback(event => {
    const key = event.key
    const step = 56 / zoom
    if (key === 'ArrowLeft') { setOffset(o => ({ ...o, x: o.x + step })); event.preventDefault() }
    else if (key === 'ArrowRight') { setOffset(o => ({ ...o, x: o.x - step })); event.preventDefault() }
    else if (key === 'ArrowUp') { setOffset(o => ({ ...o, y: o.y + step })); event.preventDefault() }
    else if (key === 'ArrowDown') { setOffset(o => ({ ...o, y: o.y - step })); event.preventDefault() }
    else if (key === '+' || key === '=') { zoomIn(); event.preventDefault() }
    else if (key === '-' || key === '_') { zoomOut(); event.preventDefault() }
    else if (key === '0') { resetView(); event.preventDefault() }
  }, [zoom, zoomIn, zoomOut, resetView])

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
  
  // OPTIMIZED: Viewport culling - only render visible nodes
  const visibleOrdered = React.useMemo(() => {
    const viewLeft = -offset.x
    const viewRight = -offset.x + plan.width / zoom
    const viewTop = -offset.y
    const viewBottom = -offset.y + plan.height / zoom
    
    // Estimate average node size
    const avgNodeSize = 60
    
    return ordered.filter(({ info }) => {
      const nodeX = projX(info.gx + 0.5, info.gy + 0.5) + plan.origin.x
      const nodeY = projY(info.gx + 0.5, info.gy + 0.5, info.z || 0) + plan.origin.y
      
      return (
        nodeX + avgNodeSize > viewLeft &&
        nodeX - avgNodeSize < viewRight &&
        nodeY + avgNodeSize > viewTop &&
        nodeY - avgNodeSize < viewBottom
      )
    })
  }, [ordered, offset, zoom, plan])

  // direct neighbours of the hovered node, for the hover highlight
  const neighbors = React.useMemo(() => {
    const map = new Map()
    edges.forEach(edge => {
      if (!map.has(edge.source_id)) map.set(edge.source_id, new Set())
      if (!map.has(edge.target_id)) map.set(edge.target_id, new Set())
      map.get(edge.source_id).add(edge.target_id)
      map.get(edge.target_id).add(edge.source_id)
    })
    return map
  }, [edges])

  const selT = selectedId && plan.placed.get(selectedId) ? plan.placed.get(selectedId).t : null

  const notable = React.useCallback(node =>
    (node.drift_status && node.drift_status !== 'matched') ||
    node.health_status === 'down' ||
    node.health_status === 'degraded', [])

  const showTitle = zoom >= 0.8
  const showAddress = zoom >= 1.25

  const labelHintOf = React.useCallback(route => {
    const from = plan.placed.get(route.edge.source_id)
    const to = plan.placed.get(route.edge.target_id)
    return `${(from && from.node && from.node.label) || route.edge.source_id} —${route.edge.relation}→ ${(to && to.node && to.node.label) || route.edge.target_id}`
  }, [plan])

  return jsxs('div', {
    className: 'ia-graph-wrap',
    ref: wrapRef,
    tabIndex: 0,
    role: 'group',
    'aria-label': 'Fleet topology map. Arrow keys pan, plus and minus zoom, zero resets the view.',
    onKeyDown,
    children: [
      jsxs('div', {
        className: 'ia-zoom',
        role: 'group',
        'aria-label': 'Zoom controls',
        children: [
          jsx('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: zoomIn, disabled: zoom >= ZOOM_MAX - 1e-9, children: '+' }),
          jsx('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: zoomOut, disabled: zoom <= ZOOM_MIN + 1e-9, children: '−' }),
          jsx('span', { className: 'ia-zoom-read', 'aria-live': 'polite', title: 'Zoom level', children: `${Math.round(zoom * 100)}%` }),
          jsx('button', { type: 'button', className: 'ia-zoom-fit', title: 'Reset view', 'aria-label': 'Reset view to the default framing', onClick: resetView, children: 'FIT' })
        ]
      }),
      jsxs('svg', {
        className: 'ia-svg',
        viewBox,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerLeave: onPointerUp,
        onPointerOver: onNodeOver,
        onPointerOut: onNodeOut,
        children: [
          jsxs('g', {
            className: 'ia-iso',
            transform: `translate(${r2(plan.origin.x)} ${r2(plan.origin.y)})`,
            children: [
              plan.platforms.map((p, i) => jsx(PlatformView, { platform: p, next: plan.platforms[i + 1], sel: p.t === selT }, `plat-${p.t}`)),
              plan.platforms.map(p => jsx(PlatformLabel, { platform: p }, `plat-label-${p.t}`)),
              routed.map(route => jsx(EdgeView, {
                route,
                selectedId,
                hoverId: hoverNode,
                onSelect,
                pulseFor,
                labelHint: labelHintOf(route),
                onTagShow: showTag,
                onTagMove: moveTag,
                onTagHide: hideTag
              }, route.key)),
              // OPTIMIZED: Only render visible nodes
              visibleOrdered.map(({ info, fresh }) =>
                jsx('g', {
                  key: `node-${info.node.id}`,
                  className: cn(
                    info.node.id === hoverNode && 'ia-hn',
                    hoverNode && neighbors.get(hoverNode) && neighbors.get(hoverNode).has(info.node.id) && 'ia-nb'
                  ),
                  children: jsx(IsoNode, {
                    node: info.node,
                    info,
                    active: info.node.id === selectedId,
                    pulse: pulseFor(info.node.id),
                    fresh,
                    delay: Math.min(920, info.u * 20),
                    showTitle: showTitle || notable(info.node) || info.node.id === selectedId,
                    showAddress,
                    onSelect
                  })
                }))
            ]
          })
        ]
      }),
      jsx('div', {
        className: 'ia-edge-tag',
        ref: tagRef,
        hidden: !edgeTag,
        'aria-hidden': true,
        children: edgeTag
          ? jsxs('span', { className: 'ia-edge-tag-in', children: [
              jsx('span', { className: 'ia-edge-tag-dot', style: { background: edgeTag.color } }),
              edgeTag.label
            ] })
          : null
      })
    ]
  })
})

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
// Full-width alert bar between the view rail and the canvas. Answers "what's
// broken, how bad, what do I do" in one glance: a solid severity field with
// the open count, the newest incident as a row (the rest behind +N MORE),
// and one Heal button per incident that drives the onHeal playbook action.
// Incident rows carry both the store shape (started_at / heal_attempts /
// resolved_at) and the fixture aliases (opened_at / attempts / closed_at).
const HEAL_HELP =
  "Heal runs the deterministic restart playbook for this node, then wakes the agent with the node's runbook if the playbook is not enough."

const INCIDENT_STATES = {
  open: 'ia-incident-state-open',
  healing: 'ia-incident-state-healing',
  escalated: 'ia-incident-state-escalated',
  resolved: 'ia-incident-state-resolved'
}

const incidentChip = incident => {
  const key = String((incident && incident.status) || '').toLowerCase()
  return { label: key ? key.replace('_', ' ') : 'incident', mod: INCIDENT_STATES[key] || '' }
}

const incidentOpenedAt = incident => Number(incident && (incident.started_at || incident.opened_at)) || 0
const incidentResolvedAt = incident => Number(incident && (incident.resolved_at || incident.closed_at)) || 0
const incidentAttempts = incident =>
  Number(incident && (incident.heal_attempts != null ? incident.heal_attempts : incident.attempts)) || 0

const incidentHealHelp = incident => {
  if (String(incident.status || '').toLowerCase() === 'healing')
    return 'A playbook attempt is already running for this incident — wait for the probe to verify recovery.'
  if (incidentAttempts(incident) >= 2 || String(incident.status || '').toLowerCase() === 'escalated')
    return 'Playbook budget spent (2 attempts) — wake the agent instead: open the node and use Dispatch brief.'
  return HEAL_HELP
}

function IncidentBadge({ count }) {
  return jsxs('div', {
    className: 'ia-incident-badge',
    'aria-hidden': true,
    children: [
      jsxs('span', {
        className: 'ia-incident-badge-top',
        children: [
          jsxs('svg', {
            width: 13,
            height: 12,
            viewBox: '0 0 13 12',
            'aria-hidden': true,
            children: [
              jsx('path', { d: 'M6.5 1 L12 11 H1 Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
              jsx('path', { d: 'M6.5 4.4 V6.9', stroke: 'currentColor', strokeWidth: 1.3, fill: 'none' }),
              jsx('circle', { cx: 6.5, cy: 8.6, r: 0.8, fill: 'currentColor' })
            ]
          }),
          jsx('span', { className: 'ia-incident-badge-num', children: String(count) })
        ]
      }),
      jsx('span', { className: 'ia-incident-badge-label', children: count === 1 ? 'Incident' : 'Incidents' })
    ]
  })
}

function IncidentRow({ incident, onHeal, healing }) {
  const chip = incidentChip(incident)
  const attempts = incidentAttempts(incident)
  const openedAt = incidentOpenedAt(incident)
  const exhausted = attempts >= 2 || String(incident.status || '').toLowerCase() === 'escalated'
  return jsxs('div', {
    className: 'ia-incident-row',
    children: [
      jsx('span', { className: cn('ia-incident-state', chip.mod), children: chip.label }),
      jsxs('div', {
        className: 'ia-incident-what',
        children: [
          jsxs('div', {
            className: 'ia-incident-head',
            children: [
              jsx('button', {
                type: 'button',
                className: 'ia-incident-open',
                title: `Inspect ${incident.node_label || incident.node_id} in the inspector`,
                onClick: () => {
                  pendingSelect = incident.node_id
                  host.navigate(PAGE_PATH)
                },
                children: incident.node_label || incident.node_id
              }),
              jsx('span', { className: 'ia-incident-age', children: openedAt ? ago(openedAt) : '' }),
              attempts
                ? jsx('span', { className: 'ia-incident-age', children: `· playbook ×${attempts}` })
                : null
            ]
          }),
          jsx('div', { className: 'ia-incident-err', children: incident.trigger_error || 'probe failed' }),
          incident.root_cause_hint ? jsx('div', { className: 'ia-incident-hint', children: incident.root_cause_hint }) : null
        ]
      }),
      jsx('button', {
        type: 'button',
        className: cn('ia-btn', 'ia-incident-heal', healing && 'ia-btn-busy'),
        disabled: healing || exhausted,
        title: incidentHealHelp(incident),
        'aria-label': `Heal ${incident.node_label || incident.node_id}: run the restart playbook, then wake the agent with the runbook if needed`,
        'aria-busy': healing || undefined,
        onClick: () => onHeal(incident),
        children: healing ? 'Healing…' : '⚡ Heal'
      })
    ]
  })
}

function IncidentStrip({ incidents, onHeal }) {
  const [expanded, setExpanded] = React.useState(false)
  const [healingId, setHealingId] = React.useState(null)
  const list = incidents || []
  if (!list.length) return null

  const heal = async incident => {
    if (healingId || !onHeal) return
    setHealingId(incident.node_id)
    try {
      await onHeal(incident.node_id)
    } catch (err) {
      // onHeal (healNode) already reports failures through host.notify
    } finally {
      setHealingId(null)
    }
  }

  const rows = expanded ? list : list.slice(0, 1)
  return jsxs('div', {
    className: 'ia-incident',
    role: 'group',
    'aria-label': `Open incidents: ${list.length}`,
    children: [
      jsx(IncidentBadge, { count: list.length }),
      jsxs('div', {
        className: cn('ia-incident-rows', expanded && 'ia-incident-rows-open'),
        children: rows.map(incident =>
          jsx(IncidentRow, { incident, onHeal: heal, healing: healingId === incident.node_id }, `strip-${incident.id}`)
        )
      }),
      list.length > 1
        ? jsx('button', {
            type: 'button',
            className: 'ia-incident-more',
            'aria-expanded': expanded,
            title: expanded ? 'Collapse the incident list' : `Show all ${list.length} open incidents`,
            onClick: () => setExpanded(open => !open),
            children: expanded ? '− Less' : `+${list.length - 1} more`
          })
        : null
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
// Idle state: a fleet panel — status breakdown, open incidents and a hint —
// so the rail always carries real information instead of dead space.
function FleetPanel({ counts, incidents, lastSweep, onFocus }) {
  const attention = (counts.changed || 0) + (counts.unregistered || 0) + (counts.stale || 0)
  const rows = [
    ['matched', 'Matched', counts.matched || 0, '#34d399'],
    ['attention', 'Needs attention', attention, '#fbbf24'],
    ['other', 'Docs & peers', (counts.observed || 0) + (counts.doc_only || 0), '#9fb0cc']
  ]
  return jsxs(Fragment, { children: [
    jsxs('div', { className: 'ia-fleet-grid', children: rows.map(([key, label, n, color]) =>
      jsxs('button', {
        type: 'button',
        className: cn('ia-fleet-cell', !n && 'ia-fleet-zero'),
        onClick: () => onFocus(key),
        children: [
          jsxs('div', { className: 'ia-fleet-num', children: [
            jsx('span', { className: 'ia-fleet-diamond', style: { background: color } }),
            String(n)
          ] }),
          jsx('div', { className: 'ia-fleet-label', children: label })
        ]
      }, key))
    }),
    incidents.length
      ? jsxs('div', { className: 'ia-block', children: [
          jsx('div', { className: 'ia-block-title', children: 'Open incidents' }),
          jsx('ul', { className: 'ia-list', children: incidents.map(incident =>
            jsx('li', {
              children: jsxs('button', {
                type: 'button',
                className: 'ia-inc-item',
                onClick: () => onFocus('attention', incident.node_id),
                children: [
                  jsxs('span', { className: 'ia-inc-head', children: [
                    `#${incident.id} ${incident.node_label || incident.node_id}`,
                    jsx('span', { className: 'ia-incident-state', children: incident.status })
                  ] }),
                  jsx('span', { className: 'ia-inc-detail', children: incident.trigger_error || '' })
                ]
              })
            }, `fleet-inc-${incident.id}`))
          })
        ] })
      : null,
    lastSweep
      ? jsx('div', { className: 'ia-kv', children: kv('last sweep', ago(lastSweep.finished_at)) })
      : null,
    jsx('div', { className: 'ia-muted', children: 'Select a shape on the map — or a category above — to inspect registry state, live diff and recovery playbooks.' })
  ] })
}

// flat pictograms mirroring the diorama shapes, for the legend — each kind is
// a mini isometric solid (same 2:1 projection and face shading as the scene:
// top brightest, left mid, right darkest) so the legend reads as a key to the
// diorama, not as generic clip-art
function LegendGlyph({ kind }) {
  const scene = kindScene(kind)
  const c = scene.accent
  const m = scene.mat
  const ft = `color-mix(in srgb, ${m} 84%, #fff)` // matches .ia-f-top
  const fl = `color-mix(in srgb, ${m} 74%, #000)` // .ia-f-left
  const fr = `color-mix(in srgb, ${m} 50%, #000)` // .ia-f-right
  const face = (d, fill) => jsx('path', { d, fill, stroke: c, strokeWidth: .9, strokeLinejoin: 'round' }, d)
  // iso cube parts: (cx, ty) centers the top rhombus; w = half width, hv = body height
  const topD = (cx, ty, w) => `M ${cx} ${ty - w / 2} L ${cx + w} ${ty} L ${cx} ${ty + w / 2} L ${cx - w} ${ty} Z`
  const leftD = (cx, ty, w, hv) => `M ${cx - w} ${ty} L ${cx} ${ty + w / 2} L ${cx} ${ty + w / 2 + hv} L ${cx - w} ${ty + hv} Z`
  const rightD = (cx, ty, w, hv) => `M ${cx} ${ty + w / 2} L ${cx + w} ${ty} L ${cx + w} ${ty + hv} L ${cx} ${ty + w / 2 + hv} Z`
  const cube = (cx, ty, w, hv) => [face(leftD(cx, ty, w, hv), fl), face(rightD(cx, ty, w, hv), fr), face(topD(cx, ty, w), ft)]
  const line = (d, width = .8, opacity = 1) => jsx('path', { d, stroke: c, strokeWidth: width, fill: 'none', opacity, strokeLinecap: 'round' }, d)
  const dot = (cx, cy, r, fill) => jsx('circle', { cx, cy, r, fill: fill || c }, `d${cx}-${cy}`)
  let inner
  switch (scene.shape) {
    case 'rack':
      // LED-blinking rack: tall iso box, unit grooves across the right face
      inner = [
        ...cube(8.6, 3.3, 4.6, 7.4),
        line('M 8.6 7.7 L 13.2 5.4 M 8.6 9.4 L 13.2 7.1 M 8.6 11.2 L 13.2 8.9'),
        dot(9.5, 7.4, .7), dot(9.5, 9.1, .7, '#7ee2a8')
      ]
      break
    case 'tower':
      // VM tower: narrow box, scanning screen on the right face, blink on the left
      inner = [
        ...cube(8.4, 2.2, 3.4, 8.4),
        face('M 9 5.4 L 11.2 4.4 L 11.2 9.1 L 9 10.1 Z', '#0b1120'),
        dot(7, 8.4, .8)
      ]
      break
    case 'tank':
      // LXC tank: cylinder with rim ellipse and a liquid meniscus line
      inner = [
        jsx('path', { d: 'M 5.4 4.4 L 5.4 11.4 A 3.6 1.8 0 0 0 12.6 11.4 L 12.6 4.4 Z', fill: `color-mix(in srgb, ${m} 34%, #0e1420)`, stroke: c, strokeWidth: .9, strokeLinejoin: 'round' }, 'tankbody'),
        jsx('ellipse', { cx: 9, cy: 4.4, rx: 3.6, ry: 1.8, fill: fl, stroke: c, strokeWidth: .9 }, 'tankrim'),
        jsx('path', { d: 'M 5.4 8 A 3.6 1.8 0 0 0 12.6 8', stroke: '#7ee2a8', strokeWidth: .8, fill: 'none' }, 'tankfill')
      ]
      break
    case 'cargo':
      // container: wide low box, corrugation ridges on the left face, door on the right
      inner = [
        ...cube(9, 3, 6.4, 4.4),
        line('M 4.5 4 L 4.5 8.4 M 5.8 4.6 L 5.8 9 M 7.1 5.2 L 7.1 9.6'),
        face('M 11.2 5.9 L 13.8 4.4 L 13.8 8 L 11.2 9.4 Z', `color-mix(in srgb, ${c} 38%, #0e1420)`)
      ]
      break
    case 'pad':
      // service pad: low cube with a floating diamond glyph + status dot
      inner = [
        ...cube(9, 6.6, 4.8, 2.6),
        line('M 9 2.1 L 11.6 4.1 L 9 6.1 L 6.4 4.1 Z', 1),
        dot(9, 4.1, .9)
      ]
      break
    case 'plate':
      // project plate: flat slab, one detail seam per face
      inner = [
        ...cube(9, 8, 6, 1.8),
        line('M 3 8 L 3 9.8 M 6 9.5 L 6 11.3')
      ]
      break
    case 'bot':
      // agent bot: small hovering cube, visor line, antenna with blinking tip
      inner = [
        jsx('ellipse', { cx: 9, cy: 12.2, rx: 2.6, ry: .9, fill: 'rgba(3,6,14,.42)' }, 'botshadow'),
        ...cube(9, 5.4, 3, 4.4),
        line('M 9.5 8.2 L 11.5 7.3', 1.4),
        line('M 9 5.4 L 9 3', .8),
        dot(9, 2.4, .9)
      ]
      break
    case 'orb':
      // model endpoint: accent orb with shine, orbit ring and satellite
      inner = [
        jsx('ellipse', { cx: 9, cy: 6.2, rx: 6.6, ry: 2.2, fill: 'none', stroke: c, strokeWidth: .8, opacity: .55 }, 'oring'),
        jsx('circle', { cx: 9, cy: 6.2, r: 3.4, fill: c }, 'orb'),
        jsx('circle', { cx: 7.8, cy: 4.9, r: .9, fill: 'rgba(255,255,255,.55)' }, 'oshine'),
        dot(15, 7.1, 1)
      ]
      break
    case 'clock':
      // cron clock: dark face, cardinal ticks, accent hand
      inner = [
        jsx('circle', { cx: 9, cy: 6.6, r: 4.8, fill: '#141d2c', stroke: c, strokeWidth: 1.1 }, 'cface'),
        dot(12.4, 6.6, .55, 'rgba(255,255,255,.55)'), dot(9, 10, .55, 'rgba(255,255,255,.55)'), dot(5.6, 6.6, .55, 'rgba(255,255,255,.55)'),
        line('M 9 6.6 L 9 3.4', 1.2),
        dot(9, 6.6, .9)
      ]
      break
    case 'beacon':
      // tailnet peer: two-face pyramid with groove band, ping ellipse, apex light
      inner = [
        jsx('ellipse', { cx: 9, cy: 10.6, rx: 6.4, ry: 2.4, fill: 'none', stroke: c, strokeWidth: .8, opacity: .5 }, 'bping'),
        face('M 4.4 9.8 L 9 11.6 L 9 1.6 Z', fl),
        face('M 9 11.6 L 13.6 9.8 L 9 1.6 Z', fr),
        line('M 6.9 5.3 L 9 6.1 M 9 6.1 L 11.1 5.3'),
        dot(9, 1.6, 1)
      ]
      break
    default:
      inner = cube(9, 5, 4.4, 3.4)
  }
  return jsxs('svg', { width: 18, height: 14, viewBox: '0 0 18 14', 'aria-hidden': true, children: inner })
}

const LEGEND_KINDS = [
  ['server', 'Server'], ['vm', 'Virtual machine'], ['lxc', 'LXC container'], ['container', 'Docker / podman'],
  ['service', 'Service'], ['project', 'Project'], ['agent', 'Hermes agent'], ['model_endpoint', 'Model endpoint'],
  ['cron', 'Cron job'], ['peer', 'Tailnet peer'], ['network', 'Network']
]
const LEGEND_LINKS = [
  ['hosts', 'hosts'], ['depends_on', 'depends on'], ['uses_model', 'uses model'],
  ['monitors', 'monitors'], ['proxies_to', 'proxies to'], ['routes_via', 'routes via']
]

function Legend() {
  const [open, setOpen] = React.useState(true)
  return jsxs('div', { className: 'ia-legend-wrap', children: [
    jsx('button', {
      type: 'button',
      className: 'ia-btn ia-legend-toggle',
      'aria-expanded': open,
      'aria-controls': 'ia-legend-panel',
      onClick: () => setOpen(o => !o),
      children: open ? 'Legend −' : 'Legend +'
    }),
    open
      ? jsxs('div', { className: 'ia-legend', id: 'ia-legend-panel', children: [
          jsx('div', { className: 'ia-legend-title', children: 'Node kinds' }),
          jsx('div', { className: 'ia-legend-grid', children: LEGEND_KINDS.map(([kind, label]) =>
            jsxs('div', { className: 'ia-legend-row', children: [
              jsx(LegendGlyph, { kind }),
              jsx('span', { children: label })
            ] }, kind)) }),
          jsx('div', { className: 'ia-legend-title', children: 'Links' }),
          jsx('div', { className: 'ia-legend-grid', children: LEGEND_LINKS.map(([rel, label]) => {
            const style = relationStyle(rel)
            return jsxs('div', { className: 'ia-legend-row', children: [
              jsxs('svg', { width: 18, height: 14, 'aria-hidden': true, children: [
                jsx('line', { x1: 1, y1: 7, x2: 13.4, y2: 7, stroke: style.color, strokeWidth: 1.6, strokeDasharray: style.dash || undefined }, 'ln'),
                jsx('path', { d: 'M 13.2 4.9 L 16.8 7 L 13.2 9.1 Z', fill: style.color, fillOpacity: .85 }, 'hd')
              ] }, rel),
              jsx('span', { children: label })
            ] }, rel)
          }) })
        ] })
      : null
  ] })
}

function Inspector({ node, busy, onClose, onRefetch, setBusy, guardrail, counts, fleetIncidents, lastSweep, onFocus }) {
  const [tab, setTab] = React.useState('overview')
  const detail = useNode(node ? node.id : null)

  React.useEffect(() => {
    setTab('overview')
  }, [node && node.id])

  React.useEffect(() => {
    if (!node) return undefined
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [node && node.id, onClose])

  if (!node) {
    return hud('ia-inspector ia-inspector-empty', [
      jsx('div', { className: 'ia-inspector-title', children: 'Fleet' }),
      jsx(FleetPanel, { counts, incidents: fleetIncidents, lastSweep, onFocus })
    ])
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
          jsx('button', {
            type: 'button',
            className: 'ia-close',
            title: 'Close inspector (Esc)',
            'aria-label': 'Close inspector',
            onClick: onClose,
            children: '×'
          })
        ]
      }),
      jsxs('div', {
        className: 'ia-tabs',
        role: 'tablist',
        'aria-label': `${item.label || item.id} details`,
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
  const active = tab === key
  const tabKeys = ['overview', 'uptime', 'runbook', 'raw']
  return jsx('button', {
    type: 'button',
    className: cn('ia-tab', active && 'ia-tab-active'),
    role: 'tab',
    'aria-selected': active,
    tabIndex: active ? 0 : -1,
    onClick: () => setTab(key),
    onKeyDown: event => {
      const index = tabKeys.indexOf(key)
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault()
        const next = tabKeys[(index + 1) % tabKeys.length]
        setTab(next)
        event.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`)?.focus()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = tabKeys[(index - 1 + tabKeys.length) % tabKeys.length]
        setTab(next)
        event.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`)?.focus()
      }
    },
    'data-tab': key,
    children: label
  }, key)
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
  const history = (probes || []).slice().reverse() // oldest → newest, reads left to right
  const max = Math.max(1, ...history.map(sample => Number(sample.latency_ms) || 0))
  const nodeIncidents = incidents || []
  const lastIncidentAt = nodeIncidents.reduce((newest, incident) => Math.max(newest, incidentOpenedAt(incident)), 0)
  const healing = busy === `heal:${nodeId}`
  const sawTrouble = history.some(sample => sample.status && sample.status !== 'up')
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'ia-stats',
        children: [
          stat('24h uptime', pct(item.uptime_24h_pct)),
          stat('latency', item.latency_ms ? `${Math.round(item.latency_ms)} ms` : '—'),
          stat('failure streak', String(item.failure_streak || 0)),
          stat('last incident', lastIncidentAt ? ago(lastIncidentAt) : '—')
        ]
      }),
      jsxs('div', {
        className: 'ia-block',
        children: [
          jsxs('div', {
            className: 'ia-spark-head',
            children: [
              jsx('div', { className: 'ia-block-title', children: `Recent probes · last ${history.length || 0}` }),
              sawTrouble
                ? jsxs('div', {
                    className: 'ia-spark-legend',
                    'aria-hidden': true,
                    children: [
                      jsxs('span', { className: 'ia-spark-key', children: [jsx('span', { className: 'ia-spark-swatch' }), 'Up'] }),
                      jsxs('span', { className: 'ia-spark-key', children: [jsx('span', { className: 'ia-spark-swatch ia-spark-degraded' }), 'Degraded'] }),
                      jsxs('span', { className: 'ia-spark-key', children: [jsx('span', { className: 'ia-spark-swatch ia-spark-down' }), 'Down'] })
                    ]
                  })
                : null
            ]
          }),
          history.length
            ? jsxs('div', {
                className: 'ia-spark',
                children: history.map((sample, index) => {
                  const latency = Number(sample.latency_ms) || 0
                  const status = String(sample.status || 'up').toLowerCase()
                  return jsx('span', {
                    className: cn('ia-spark-bar', status !== 'up' && `ia-spark-${status}`),
                    style: { height: `${Math.max(6, Math.round((latency / max) * 100))}%` },
                    title: `${status}${latency ? ` · ${Math.round(latency)}ms` : ' · no latency'}${sample.ts ? ` · ${ago(sample.ts)}` : ''}${sample.detail ? ` · ${sample.detail}` : ''}`
                  }, `probe-${index}`)
                })
              })
            : jsx('div', {
                className: 'ia-muted',
                children: 'No probes recorded yet — probes start after the next sweep finds this node. Run a sweep or check back in a minute.'
              })
        ]
      }),
      jsxs('div', {
        className: 'ia-kv',
        children: [
          kv('recovery command', item.recovery_cmd || 'none (agent decides)'),
          kv('probe', (item.live_state && item.live_state.probe) || (item.doc_state && item.doc_state.probe) || 'none'),
          kv('heal policy', item.auto_heal_policy || 'inherit'),
          kv('last heal attempt', ago(item.last_heal_attempt_at))
        ]
      }),
      jsxs('div', {
        className: 'ia-block',
        children: [
          jsx('div', { className: 'ia-block-title', children: 'Incidents' }),
          nodeIncidents.length
            ? jsxs('ul', {
                className: 'ia-inc-log',
                children: nodeIncidents.map(incident => {
                  const chip = incidentChip(incident)
                  const openedAt = incidentOpenedAt(incident)
                  const resolvedAt = incidentResolvedAt(incident)
                  const attempts = incidentAttempts(incident)
                  const done =
                    incident.resolution_summary ||
                    incident.last_heal_action ||
                    (attempts ? `playbook ×${attempts}` : '')
                  return jsxs('li', {
                    className: 'ia-inc-log-row',
                    children: [
                      jsx('span', { className: cn('ia-incident-state', chip.mod), children: chip.label }),
                      jsxs('div', {
                        className: 'ia-inc-log-main',
                        children: [
                          jsxs('div', {
                            className: 'ia-inc-log-what',
                            children: [
                              jsx('span', { className: 'ia-inc-log-id', children: `#${incident.id}` }),
                              incident.trigger_error || 'probe failed'
                            ]
                          }),
                          jsx('div', {
                            className: 'ia-inc-log-when',
                            children: `${openedAt ? `opened ${ago(openedAt)}` : 'opened —'}${resolvedAt ? ` · resolved ${ago(resolvedAt)}` : ''}`
                          }),
                          done ? jsx('div', { className: 'ia-inc-log-did', children: done }) : null
                        ]
                      })
                    ]
                  }, `incident-${incident.id}`)
                })
              })
            : jsx('div', { className: 'ia-muted', children: 'No incidents recorded for this node.' })
        ]
      }),
      jsx('div', {
        className: 'ia-row',
        children: jsx('button', {
          type: 'button',
          className: cn('ia-btn', 'ia-upt-heal', healing && 'ia-btn-busy'),
          disabled: Boolean(busy),
          title: HEAL_HELP,
          'aria-label': `Heal ${nodeId}: run the restart playbook, then wake the agent with the runbook if needed`,
          'aria-busy': healing || undefined,
          onClick: () => healNode(nodeId, setBusy, async () => {
            await onRefetch()
            await detail.refetch()
          }),
          children: healing ? 'Healing…' : '⚡ Run recovery playbook'
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
  const kindLabel = kind => kind.replaceAll('_', ' ')
  const kindGlyph = kind => {
    if (kind === 'touch_blocked') return '×'
    if (kind === 'touch_allowed') return '✓'
    if (kind === 'read_doc') return '◇'
    if (kind.includes('heal')) return '⚡'
    return '·'
  }
  return jsxs('div', {
    className: 'ia-stream',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': 'Live activity and guardrail events',
    children: [
      jsxs('div', { className: 'ia-stream-title', children: [jsx('span', { className: 'ia-live-dot' }), jsx('span', { children: 'Activity' }), jsx('span', { className: 'ia-stream-count', children: rows.length ? `${rows.length} recent` : 'quiet' })] }),
      rows.length
        ? jsx('div', {
            className: 'ia-stream-rows',
            children: rows.map((entry, index) => {
              const kind = entry.action_kind || 'info'
              const subject = entry.node_label || entry.node_id || ''
              return jsxs('div', {
                className: cn('ia-stream-row', `ia-kind-${kind}`),
                title: entry.summary || entry.tool_name || kindLabel(kind),
                children: [
                  jsx('span', { className: 'ia-stream-glyph', 'aria-hidden': true, children: kindGlyph(kind) }),
                  jsx('span', { className: 'ia-stream-kind', children: kindLabel(kind) }),
                  jsx('span', { className: 'ia-stream-text', children: subject ? `${subject}${entry.summary ? ` — ${entry.summary}` : ''}` : entry.summary || entry.tool_name || '' }),
                  jsx('time', { className: 'ia-stream-time', dateTime: entry.ts ? new Date(Number(entry.ts) * 1000).toISOString() : undefined, children: entry.ts ? new Date(Number(entry.ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' })
                ]
              }, `activity-${index}`)
            })
          })
        : jsx('div', { className: 'ia-muted', children: 'No activity yet. Agent reads and touches will appear here in real time.' }),
      incidents && incidents.length
        ? jsx('div', { className: 'ia-stream-foot', children: `${incidents.length} open incident${incidents.length === 1 ? '' : 's'} · select one above to inspect it` })
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
  const tone = incidents ? 'incident' : attention ? 'attention' : total ? 'healthy' : 'unknown'

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

  const label = total ? `${healthy}/${total}` : '—'
  const title = flash === 'block'
    ? 'Infra Atlas — a tool call was blocked: read the registry entry first'
    : incidents
      ? `${incidents} open incident${incidents === 1 ? '' : 's'} · open Infra Atlas to heal`
      : attention
        ? `${attention} node${attention === 1 ? '' : 's'} need attention · open Infra Atlas to review drift`
        : 'Infra Atlas — fleet is healthy'
  return jsxs('button', {
    type: 'button',
    className: cn('ia-chip', `ia-chip-${tone}`, flash === 'block' && 'ia-chip-blocked'),
    title,
    'aria-label': title,
    onClick: () => host.navigate(PAGE_PATH),
    children: [
      jsx('span', { className: 'ia-status-chip-mark', 'aria-hidden': true }),
      jsx('span', { className: 'ia-status-chip-label', children: flash === 'block' ? 'BLOCKED' : 'ATLAS' }),
      jsx('span', { className: 'ia-chip-count', children: label }),
      incidents ? jsx('span', { className: 'ia-chip-note', children: `${incidents} down` }) : attention ? jsx('span', { className: 'ia-chip-note', children: `${attention} drift` }) : null
    ]
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
.ia-header { display:grid; grid-template-columns:minmax(170px, 1fr) auto auto; align-items:center; gap:14px; min-height:54px; padding:8px 14px; position:relative; border-bottom:1px solid #263652; background:#0e1525; }
.ia-title { display:flex; align-items:center; gap:10px; min-width:0; font-weight:700; font-size:13px; letter-spacing:.04em; text-transform:uppercase; }
.ia-title-block { display:flex; flex-direction:column; gap:3px; min-width:0; }
.ia-title-word { color:#eef6ff; letter-spacing:.14em; line-height:1; }
.ia-mark { flex:0 0 auto; }
.ia-mark-top { fill:#38bdf8; }
.ia-mark-left { fill:#1e6fa8; }
.ia-mark-right { fill:#14486e; }
.ia-sub { display:block; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:400; font-size:9px; color:#7184a4; letter-spacing:.06em; text-transform:none; }
.ia-controls { display:flex; gap:7px; align-items:center; justify-content:flex-end; flex-wrap:wrap; min-width:0; }
.ia-controls-sep { width:1px; height:20px; background:#263652; }
.ia-search { display:flex; align-items:center; gap:7px; width:210px; min-width:150px; height:28px; padding:0 7px 0 9px; background:#0a1120; border:1px solid #2d4163; color:#d9e4f5; clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); }
.ia-search:focus-within { border-color:#38bdf8; }
.ia-search-icon { flex:0 0 auto; color:#7fa7d9; }
.ia-search-in { width:100%; min-width:0; border:0; outline:0; background:transparent; color:#eaf4ff; font:inherit; font-size:11px; }
.ia-search-in::placeholder { color:#5f6f8f; }
.ia-search-kbd { flex:0 0 auto; min-width:14px; padding:1px 4px; border:1px solid #3a4c6b; color:#8fa3c1; font:inherit; font-size:9px; line-height:14px; text-align:center; }
/* Skeleton loading animation */
@keyframes ia-skeleton-pulse {
  0%, 100% { opacity: .4; }
  50% { opacity: .8; }
}
.ia-skeleton { display:flex; flex-direction:column; height:100%; padding:14px; gap:12px; }
.ia-skeleton-header { display:flex; justify-content:space-between; align-items:center; height:54px; gap:14px; }
.ia-skeleton-title { width:200px; height:24px; background:rgba(125,211,252,.1); border-radius:4px; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; }
.ia-skeleton-controls { width:300px; height:28px; background:rgba(125,211,252,.1); border-radius:4px; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; animation-delay:.2s; }
.ia-skeleton-rail { height:38px; width:200px; background:rgba(125,211,252,.1); border-radius:4px; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; animation-delay:.4s; }
.ia-skeleton-canvas { flex:1; position:relative; overflow:hidden; background:#0b0f1a; }
.ia-skeleton-plat { position:absolute; height:60px; width:80%; background:rgba(96,126,190,.1); border-radius:2px; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; }
.ia-skeleton-plat:nth-child(1) { top:20%; animation-delay:.1s; }
.ia-skeleton-plat:nth-child(2) { top:45%; animation-delay:.3s; }
.ia-skeleton-plat:nth-child(3) { top:70%; animation-delay:.5s; }
.ia-skeleton-node { position:absolute; width:40px; height:40px; background:rgba(125,211,252,.2); border-radius:50%; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; }
.ia-skeleton-edge { position:absolute; height:2px; width:100px; background:rgba(150,160,181,.3); border-radius:1px; animation:ia-skeleton-pulse 1.5s ease-in-out infinite; }
.ia-search-clear { flex:0 0 auto; width:20px; height:20px; padding:0; border:0; background:transparent; color:#8fa3c1; cursor:pointer; font:inherit; font-size:16px; line-height:1; }
.ia-search-clear:hover { color:#fff; background:#263652; }
.ia-select { display:flex; align-items:center; gap:5px; font-size:8px; text-transform:uppercase; letter-spacing:.12em; color:#7184a4; white-space:nowrap; }
.ia-select select { max-width:104px; background:#101a2d; color:#c7dcf6; border:1px solid #2d4163; clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); padding:5px 7px; font:inherit; font-size:10px; cursor:pointer; }
.ia-select select:hover { border-color:#6f8dbb; }
.ia-select select:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-select-disabled { opacity:.55; }
.ia-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:28px; background:#1a263c; border:1px solid #34496d; color:#cddcf2; clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px); padding:5px 11px; font-size:10px; letter-spacing:.05em; text-transform:uppercase; cursor:pointer; white-space:nowrap; transition:background .15s ease, border-color .15s ease, transform .1s ease; }
.ia-btn:hover { background:#243451; border-color:#7dd3fc; color:#f3f8ff; }
.ia-btn:active { transform:translateY(1px); background:#162238; }
.ia-btn:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-btn:disabled { opacity:.5; cursor:not-allowed; transform:none; }
.ia-btn-primary { background:#17639c; border-color:#62b8e8; color:#f2f8ff; font-weight:700; }
.ia-btn-primary:hover { background:#207bbd; }
.ia-btn-on { background:#1d3340; border-color:#34d399; color:#b6f4d6; }
.ia-btn-diamond { width:7px; height:7px; flex:0 0 7px; background:#34d399; transform:rotate(45deg); }
.ia-status { display:flex; align-items:center; justify-content:flex-end; gap:8px; min-width:0; }
.ia-guard, .ia-status-chip { display:inline-flex; align-items:center; gap:6px; min-height:24px; padding:4px 7px; border:1px solid #2d4163; background:#111c30; color:#9fb0cc; font-size:9px; letter-spacing:.08em; text-transform:uppercase; white-space:nowrap; font-variant-numeric:tabular-nums; }
.ia-guard { font-weight:700; }
.ia-guard-block { border-color:#ef4444; color:#fca5a5; }
.ia-guard-warn { border-color:#f59e0b; color:#fcd34d; }
.ia-guard-off { border-color:#52627d; color:#8b98ae; }
.ia-status-chip { letter-spacing:.04em; text-transform:none; color:#8fa3c1; }
.ia-status-num { color:#eef6ff; font-size:12px; font-weight:700; }
.ia-fresh-dot { width:7px; height:7px; flex:0 0 7px; background:#34d399; transform:rotate(45deg); }
.ia-fresh-dot-stale { background:#fbbf24; }
.ia-rail { display:flex; align-items:center; gap:6px; padding:6px 14px; border-bottom:1px solid #263652; background:#0c1423; flex-wrap:wrap; }
.ia-rail-label { font-size:8.5px; text-transform:uppercase; letter-spacing:.16em; color:#7184a4; margin-right:5px; }
.ia-rail-spacer { flex:1; }
.ia-rail-info { font-size:9.5px; color:#8fa3c1; letter-spacing:.05em; font-variant-numeric:tabular-nums; }
.ia-pills { display:flex; gap:5px; flex-wrap:wrap; }
.ia-pill { display:inline-flex; align-items:center; gap:6px; min-height:25px; border:1px solid #2d4163; background:#131f34; color:#9fb0cc; clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); padding:4px 9px; font-size:10px; letter-spacing:.03em; cursor:pointer; transition:background .15s ease, color .15s ease, border-color .15s ease, transform .1s ease; }
.ia-pill:hover { background:#20304c; border-color:var(--pill-c); color:#eef6ff; }
.ia-pill:active { transform:translateY(1px); }
.ia-pill:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-pill-active { background:#263b5b; border-color:var(--pill-c); color:#f3f8ff; }
.ia-pill-tick { width:6px; height:6px; flex:0 0 6px; background:var(--pill-c); transform:rotate(45deg); }
.ia-pill-count { color:#eef6ff; font-variant-numeric:tabular-nums; font-weight:700; }
.ia-pill-incident { color:#fca5a5; box-shadow:inset 0 0 0 1px rgba(239,68,68,.45); }
.ia-hud { padding:1px; background:#39567e; clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px); }
.ia-hud-in { clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px); background:#0d1322; position:relative; }
.ia-empty-in { display:flex; flex-direction:column; align-items:center; gap:9px; max-width:430px; }
.ia-empty-icon { color:#38bdf8; }
.ia-empty-title { color:#cddcf2; font-size:13px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
.ia-empty-detail { max-width:390px; color:#7184a4; line-height:1.55; }
.ia-empty-actions { display:flex; justify-content:center; gap:7px; flex-wrap:wrap; margin-top:3px; }
.ia-empty-error .ia-empty-icon { color:#f87171; }
.ia-load-mark { display:flex; gap:7px; height:15px; align-items:center; }
.ia-load-diamond { width:9px; height:9px; background:#38bdf8; transform:rotate(45deg); animation:ia-load-step 1s ease-in-out infinite; }
@keyframes ia-load-step { 0%,100% { opacity:.25; transform:rotate(45deg) translateY(0); } 50% { opacity:1; transform:rotate(45deg) translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .ia-load-diamond { animation:none; opacity:.7; } }
@media (max-width: 1200px) { 
  .ia-inspector { flex:0 0 300px; width:300px; }
}
@media (max-width: 1024px) {
  .ia-header { grid-template-columns:1fr auto; }
  .ia-controls { grid-column:1 / -1; grid-row:2; justify-content:flex-start; }
  .ia-status { position:absolute; right:14px; top:14px; }
  .ia-inspector { flex:0 0 280px; width:280px; }
}
@media (max-width: 768px) {
  .ia-header { display:flex; align-items:flex-start; flex-wrap:wrap; }
  .ia-status { position:static; margin-left:auto; flex-wrap:wrap; }
  .ia-search { width:min(100%, 260px); }
  .ia-select { display:none; }
  .ia-rail-info { width:100%; margin-top:2px; }
  .ia-inspector { flex:0 0 100%; width:100%; max-height:50vh; border-left:none; border-top:1px solid rgba(96,126,190,.2); }
  .ia-canvas { min-width:0; }
  .ia-zoom { right:auto; left:12px; }
}
@media (max-width: 620px) {
  .ia-controls { flex-wrap:wrap; gap:4px; }
  .ia-btn { padding:4px 8px; font-size:9px; }
  .ia-search { width:min(100%, 200px); }
  .ia-title-word { font-size:12px; }
}
@media (max-width: 480px) {
  .ia-search { width:min(100%, 160px); }
  .ia-status-chip { font-size:8px; padding:2px 4px; }
  .ia-pill { font-size:9px; padding:2px 6px; }
}
/* Touch targets for mobile - ensure minimum 44x44px tap area */
@media (hover: none) and (pointer: coarse) {
  .ia-btn { min-height:44px; min-width:44px; }
  .ia-pill { min-height:44px; padding:8px 12px; }
  .ia-node { cursor:pointer; }
  .ia-edge-hit { stroke-width:20px; }
  .ia-search-in { font-size:14px; }
}
/* incident strip: full-width alert bar — solid severity field, per-incident rows */
.ia-incident { display:flex; gap:12px; align-items:center; padding:8px 14px; flex:0 0 auto; color:#ffd7d7; background:rgba(239,68,68,.09); border-bottom:1px solid rgba(239,68,68,.4); }
.ia-incident-badge { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 12px 5px; background:var(--ui-danger, #ef4444); color:#fff; clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px); }
.ia-incident-badge-top { display:flex; align-items:center; gap:5px; }
.ia-incident-badge-num { font-size:16px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
.ia-incident-badge-label { font-size:7.5px; letter-spacing:.16em; text-transform:uppercase; opacity:.92; }
.ia-incident-rows { display:flex; flex-direction:column; gap:5px; flex:1 1 auto; min-width:0; }
.ia-incident-rows-open { animation:ia-strip-open .16s ease-out; }
.ia-incident-row { display:flex; gap:10px; align-items:center; min-width:0; }
.ia-incident-state { flex:0 0 auto; font-size:8px; letter-spacing:.14em; text-transform:uppercase; padding:2px 7px 1px; clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px); background:transparent; color:#9fb0cc; box-shadow:inset 0 0 0 1px rgba(96,126,190,.4); font-variant-numeric:tabular-nums; }
.ia-incident-state-open { background:var(--ui-danger, #ef4444); color:#fff; box-shadow:none; }
.ia-incident-state-healing { color:var(--ui-warning, #f59e0b); box-shadow:inset 0 0 0 1px rgba(245,158,11,.6); }
.ia-incident-state-escalated { background:var(--ui-warning, #f59e0b); color:#211300; box-shadow:none; }
.ia-incident-state-resolved { color:#9fb0cc; box-shadow:inset 0 0 0 1px rgba(96,126,190,.4); }
.ia-incident-what { display:flex; flex-direction:column; gap:1px; flex:1 1 auto; min-width:0; }
.ia-incident-head { display:flex; gap:8px; align-items:baseline; font-size:11px; min-width:0; }
.ia-incident-open { background:none; border:none; padding:0; color:#ffe3e3; font:inherit; font-weight:700; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ia-incident-open:hover { color:#fff; text-decoration:underline; }
.ia-incident-age { flex:0 0 auto; font-size:9.5px; color:#c1a9b2; letter-spacing:.03em; font-variant-numeric:tabular-nums; white-space:nowrap; }
.ia-incident-err, .ia-incident-hint { font-size:10.5px; color:#c1a9b2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-incident-hint { color:#a8b6cf; }
.ia-incident-heal { flex:0 0 auto; }
.ia-incident-more { flex:0 0 auto; background:none; border:none; box-shadow:inset 0 0 0 1px rgba(239,68,68,.45); color:#fca5a5; font-size:9px; letter-spacing:.12em; text-transform:uppercase; padding:4px 9px; cursor:pointer; clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ia-incident-more:hover { color:#fff; box-shadow:inset 0 0 0 1px rgba(248,113,113,.85); }
.ia-incident-more:focus-visible, .ia-incident-open:focus-visible, .ia-incident-heal:focus-visible, .ia-upt-heal:focus-visible, .ia-inc-item:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-btn-busy { animation:ia-busy-soft 1.1s ease-in-out infinite; }
@keyframes ia-strip-open { from { opacity:0; transform:translateY(-2px); } to { opacity:1; transform:none; } }
@keyframes ia-busy-soft { 0%,100% { opacity:1; } 50% { opacity:.55; } }
@media (prefers-reduced-motion: reduce) {
  .ia-incident-rows-open, .ia-btn-busy { animation:none; }
}
.ia-body { display:flex; flex:1 1 auto; min-height:0; }
.ia-canvas { flex:1 1 auto; min-width:0; position:relative; overflow:hidden; background:transparent; }
.ia-graph-wrap { position:absolute; inset:0; outline:none; }
.ia-graph-wrap:focus-visible { box-shadow:inset 0 0 0 1px rgba(125,211,252,.55); }
.ia-svg { width:100%; height:100%; cursor:grab; }
.ia-svg:active { cursor:grabbing; }
/* zoom cluster: one chamfered card, [+ / − / readout / FIT], flat hairline states */
.ia-zoom { position:absolute; right:12px; top:12px; z-index:2; display:flex; flex-direction:column; background:rgba(12,18,31,.92); box-shadow:inset 0 0 0 1px rgba(96,126,190,.3); clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); }
.ia-zoom button { width:34px; height:26px; border:none; background:transparent; color:#9fd8ff; cursor:pointer; font-size:13px; line-height:1; font-family:inherit; padding:0; }
.ia-zoom button:hover { background:rgba(44,58,92,.72); color:#eaf4ff; }
.ia-zoom button:active { background:rgba(58,80,124,.85); }
.ia-zoom button:disabled { opacity:.32; cursor:default; background:transparent; }
.ia-zoom button:focus-visible { outline:none; box-shadow:inset 0 0 0 1px rgba(125,211,252,.85); }
.ia-zoom-read { height:20px; display:flex; align-items:center; justify-content:center; font-size:9.5px; letter-spacing:.06em; color:#7fa7d9; font-variant-numeric:tabular-nums; border-top:1px solid rgba(96,126,190,.18); border-bottom:1px solid rgba(96,126,190,.18); }
.ia-zoom .ia-zoom-fit { font-size:8px; letter-spacing:.14em; font-weight:600; }
/* relation tag: flat cursor tag naming the hovered trace (A —rel→ B) */
.ia-edge-tag { position:absolute; left:0; top:0; z-index:3; pointer-events:none; max-width:220px; overflow:hidden; }
.ia-edge-tag[hidden] { display:none; }
.ia-edge-tag-in { display:flex; align-items:center; gap:6px; padding:3px 8px; background:rgba(10,14,24,.94); box-shadow:inset 0 0 0 1px rgba(96,126,190,.4); clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px); font-size:10px; color:#cddcf2; white-space:nowrap; }
.ia-edge-tag-dot { width:7px; height:7px; flex:0 0 7px; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); }
.ia-rail { display:flex; align-items:center; gap:6px; padding:6px 14px; border-bottom:1px solid rgba(96,126,190,.14); background:rgba(15,23,40,.35); flex-wrap:wrap; }
.ia-rail-label { font-size:8.5px; text-transform:uppercase; letter-spacing:.16em; color:#5f6f8f; margin-right:5px; }
.ia-rail-spacer { flex:1; }
.ia-rail-info { font-size:9.5px; color:#7fa7d9; letter-spacing:.05em; font-variant-numeric:tabular-nums; }
.ia-fleet-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:6px; }
.ia-fleet-cell { clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px); background:rgba(17,23,38,.7); box-shadow:inset 0 0 0 1px rgba(96,126,190,.22); padding:8px 8px; border:none; cursor:pointer; text-align:left; color:inherit; transition:box-shadow .15s ease; }
.ia-fleet-cell:hover { box-shadow:inset 0 0 0 1px rgba(125,211,252,.6); }
.ia-fleet-zero { opacity:.45; }
.ia-fleet-num { font-size:19px; font-weight:700; color:#eaf4ff; display:flex; align-items:center; gap:7px; font-variant-numeric:tabular-nums; }
.ia-fleet-diamond { width:8px; height:8px; flex:0 0 8px; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); }
.ia-fleet-label { font-size:8px; text-transform:uppercase; letter-spacing:.1em; color:#5f6f8f; margin-top:3px; }
.ia-inc-item { background:none; border:none; color:inherit; text-align:left; padding:3px 0; cursor:pointer; display:flex; flex-direction:column; gap:1px; width:100%; font:inherit; }
.ia-inc-item:hover { color:#eaf4ff; }
.ia-inc-head { display:flex; gap:7px; align-items:baseline; font-size:11px; }
.ia-inc-detail { font-size:10px; color:#8b93a5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-legend-wrap { position:absolute; right:12px; bottom:12px; z-index:2; display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.ia-legend-toggle { min-width:88px; text-align:center; }
.ia-legend-toggle:focus-visible { outline:none; box-shadow:inset 0 0 0 1px rgba(125,211,252,.85); color:#eaf4ff; }
.ia-legend { width:242px; padding:10px 12px; background:rgba(12,18,31,.93); box-shadow:inset 0 0 0 1px rgba(96,126,190,.3); clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px); }
.ia-legend-title { font-size:8.5px; text-transform:uppercase; letter-spacing:.14em; color:#7fa7d9; margin:8px 0 5px; }
.ia-legend-title:first-child { margin-top:0; }
.ia-legend-grid { display:grid; grid-template-columns:1fr 1fr; gap:3px 12px; }
.ia-legend-row { display:flex; align-items:center; gap:7px; font-size:9.5px; color:#9fb0cc; white-space:nowrap; transition:color .15s ease; }
.ia-legend-row:hover { color:#eaf4ff; }
.ia-legend-row:hover svg { filter:brightness(1.3); }
.ia-legend-row svg { flex:0 0 auto; }

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
.ia-plat-grid { fill:none; stroke:rgba(190,205,235,.13); stroke-width:1; }
.ia-plat-edge { fill:none; stroke:rgba(220,235,255,.16); stroke-width:1.1; }
/* the terrace the selected node stands on: etch brightens, seams stay visible */
.ia-plat-sel .ia-plat-grid { stroke:rgba(190,205,235,.34); }
.ia-plat-sel .ia-plat-edge { stroke:rgba(220,235,255,.42); }
.ia-plat-label { font-size:10px; font-weight:600; letter-spacing:.24em; fill:rgba(238,243,252,.62); paint-order:stroke; stroke:rgba(8,10,16,.55); stroke-width:2px; stroke-linejoin:round; }

.ia-edge-line { fill:none; stroke:var(--edge-c, #96a0b5); stroke-width:var(--ew, 1.4); stroke-opacity:.78; stroke-linecap:round; animation:ia-flow var(--flow-dur, 24s) linear infinite; }
.ia-edge:hover .ia-edge-line { stroke-opacity:1; stroke-width:calc(var(--ew, 1.4) + .9); }
.ia-edge-hot .ia-edge-line { stroke-opacity:1; stroke-width:calc(var(--ew, 1.4) + 1.1); }
.ia-edge-hot .ia-edge-head { fill-opacity:1; }
.ia-edge-hot .ia-packet-halo { opacity:.85; }
.ia-edge-nb .ia-edge-line { stroke-opacity:1; stroke-width:calc(var(--ew, 1.4) + .5); }
.ia-edge-dim { opacity:.13; transition:opacity .3s ease; }
.ia-edge { transition:opacity .3s ease; }
.ia-edge-head { fill:var(--edge-c, #96a0b5); fill-opacity:.85; }
.ia-edge-hit { fill:none; stroke:transparent; stroke-width:11; pointer-events:stroke; cursor:pointer; }
.ia-packet-core { fill:var(--edge-c, #96a0b5); }
.ia-packet-halo { fill:none; stroke:var(--edge-c, #96a0b5); stroke-width:1; opacity:.45; }
/* arrival tick: hairline diamond pulsing where the packet lands; phase-locked
   to the packet via inline animation-delay/duration set per edge */
.ia-arrive { fill:none; stroke:var(--edge-c, #96a0b5); stroke-width:1.1; opacity:0; transform-box:fill-box; transform-origin:center; animation:ia-arrive-tick 1s ease-out infinite; }
.ia-burst circle { fill:var(--ui-danger, #ef4444); opacity:0; animation:ia-burst-fade 1.7s ease-out 3; }
/* hover passes: hovered shape and its direct neighbours lift in brightness
   (flat colour transform — no blur, no glow) */
.ia-hn { filter:brightness(1.3); }
.ia-nb { filter:brightness(1.22); }

.ia-node { cursor:pointer; outline:none; }
.ia-node:focus-visible .ia-sel-ring { display:block; stroke:#f8fbff; stroke-width:2.2; stroke-dasharray:4 3; }
.ia-lift { transition:transform .18s ease, filter .18s ease; will-change: transform, filter; }
.ia-node:hover .ia-lift { transform:translateY(-2.5px); }
.ia-node-active .ia-lift { transform:translateY(-5px); }
.ia-node { will-change: transform; }
.ia-edge-line { will-change: stroke-opacity, stroke-width; }
.ia-packet { will-change: transform; }
.ia-beacon { will-change: fill, opacity; }
.ia-led, .ia-led-b, .ia-led-f { will-change: opacity, fill; }
.ia-scan { will-change: transform, opacity; }
.ia-liquid { will-change: transform; }
.ia-meniscus { will-change: transform, opacity; }
.ia-hum { will-change: transform; }
.ia-bob, .ia-bob-slow { will-change: transform; }
.ia-ping { will-change: transform, opacity; }
.ia-beacon-up, .ia-beacon-degraded, .ia-beacon-down { will-change: opacity; }
.ia-alert { will-change: transform, opacity; }
.ia-ripple { will-change: transform, opacity; }
.ia-chipf { will-change: transform; }
.ia-dglow { will-change: opacity; }
.ia-f-top { fill:color-mix(in srgb, var(--mat, #424a5e) 84%, #ffffff); stroke:rgba(255,255,255,.09); stroke-width:.6; }
.ia-f-left { fill:color-mix(in srgb, var(--mat, #424a5e) 74%, #000000); stroke:rgba(255,255,255,.05); stroke-width:.6; }
.ia-f-right { fill:color-mix(in srgb, var(--mat, #424a5e) 50%, #000000); stroke:rgba(255,255,255,.04); stroke-width:.6; }
.ia-f-back { fill:color-mix(in srgb, var(--mat, #424a5e) 34%, #000000); stroke:none; }
.ia-detail { stroke:rgba(255,255,255,.14); stroke-width:1; fill:none; }
.ia-groove { stroke:rgba(0,0,0,.34); stroke-width:1; fill:none; }
.ia-shadow { fill:rgba(3,6,14,.42); }
.ia-dglow { opacity:.26; animation:ia-glowp 3s ease-in-out infinite; }
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
.ia-orb { opacity:.95; }
.ia-orb-shine { fill:rgba(255,255,255,.55); }
.ia-orbit-ring { fill:none; stroke:var(--acc, #e879f9); stroke-width:.8; stroke-opacity:.4; }
.ia-clock-face { fill:#141d2c; stroke:rgba(255,255,255,.38); stroke-width:1.3; }
.ia-clock-tick { fill:rgba(255,255,255,.55); }
.ia-clock-hand { stroke-width:1.9; stroke-linecap:round; }
.ia-ping { fill:none; stroke-width:1.2; transform-box:fill-box; transform-origin:center; animation:ia-ping 3s ease-out infinite; opacity:0; }

/* health beacons */
.ia-beacon { stroke:rgba(8,10,16,.8); stroke-width:.8; }
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
@keyframes ia-arrive-tick { 0% { opacity:.85; transform:scale(.45); } 28% { opacity:0; transform:scale(1.5); } 100% { opacity:0; transform:scale(1.5); } }
@keyframes ia-shake { 0%,100% { transform:translateX(0); } 25% { transform:translateX(-3.5px); } 75% { transform:translateX(3.5px); } }
@keyframes ia-flash-allowed { 0% { opacity:.45; } 100% { opacity:1; } }
@keyframes ia-flash-read { 0% { opacity:.45; } 100% { opacity:1; } }

@media (prefers-reduced-motion: reduce) {
  .ia-plat, .ia-edge-line, .ia-packet, .ia-burst, .ia-led, .ia-led-b, .ia-led-f, .ia-scan, .ia-meniscus,
  .ia-hum, .ia-bob, .ia-blink, .ia-ping, .ia-beacon-up, .ia-beacon-degraded, .ia-beacon-down, .ia-alert,
  .ia-chipf, .ia-dglow, .ia-sel-ring, .ia-enter .ia-lift, .ia-enter .ia-shadow, .ia-arrive,
  .ia-pulse-touch_blocked .ia-lift, .ia-pulse-touch_allowed .ia-lift, .ia-pulse-read_doc .ia-lift,
  .ia-incident-icon, .ia-live-dot { animation:none; }
  .ia-packet, .ia-burst, .ia-arrive { display:none; }
}

.ia-empty { display:flex; align-items:center; justify-content:center; height:100%; padding:24px; text-align:center; color:#5f6f8f; }
.ia-inspector { flex:0 0 354px; width:354px; display:flex; flex-direction:column; min-height:0; min-width:0; border-left:1px solid rgba(96,126,190,.2); }
.ia-inspector .ia-hud-in { flex:1 1 auto; display:flex; flex-direction:column; min-height:0; min-width:0; overflow-y:auto; }
.ia-inspector-empty { padding:0; }
.ia-inspector-empty .ia-hud-in { padding:14px; gap:10px; }
.ia-inspector-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:13px 14px 8px; border-bottom:1px solid #263652; background:#0e1525; }
.ia-inspector-title { font-size:13px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
.ia-inspector-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px; }
.ia-close { width:25px; height:25px; padding:0; background:#111c30; border:1px solid #34496d; color:#8fa3c1; cursor:pointer; font-size:18px; line-height:1; }
.ia-close:hover { background:#263451; border-color:#7dd3fc; color:#f3f8ff; }
.ia-close:active { transform:translateY(1px); }
.ia-close:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid #263652; overflow-x:auto; }
.ia-tab { background:transparent; border:0; border-bottom:2px solid transparent; color:#7184a4; padding:8px 9px 7px; font-size:9px; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; white-space:nowrap; }
.ia-tab:hover { color:#d9e4f5; background:#131f34; }
.ia-tab:focus-visible { outline:1px solid #7dd3fc; outline-offset:-2px; }
.ia-tab-active { color:#9fd8ff; border-bottom-color:#38bdf8; background:#131f34; }
.ia-tab-body { flex:1 1 auto; overflow:auto; padding:11px 13px; display:flex; flex-direction:column; gap:11px; }
.ia-inspector-foot { display:flex; gap:6px; padding:9px 13px; border-top:1px solid #263652; background:#0e1525; }
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
.ia-stat-value { font-size:15px; font-weight:700; color:#eaf4ff; font-variant-numeric:tabular-nums; line-height:1.15; }
.ia-stat-label { font-size:8px; text-transform:uppercase; letter-spacing:.12em; color:#5f6f8f; margin-top:2px; }
/* probe sparkline: 1px gaps, solid severity colors, hairline baseline */
.ia-spark-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.ia-spark-legend { display:flex; gap:10px; }
.ia-spark-key { display:flex; align-items:center; gap:4px; font-size:8px; letter-spacing:.12em; text-transform:uppercase; color:#5f6f8f; }
.ia-spark-swatch { width:7px; height:7px; display:inline-block; flex:0 0 7px; background:#38bdf8; }
.ia-spark { display:flex; align-items:flex-end; gap:1px; height:44px; padding:0 2px; border-bottom:1px solid rgba(96,126,190,.25); }
.ia-spark-bar { flex:1 1 0; min-width:2px; background:#38bdf8; min-height:4px; }
.ia-spark-bar:hover { opacity:.72; }
.ia-spark-degraded { background:var(--ui-warning, #f59e0b); }
.ia-spark-down { background:var(--ui-danger, #ef4444); }
/* per-node incident history (uptime tab) */
.ia-inc-log { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; font-size:11px; }
.ia-inc-log-row { display:flex; gap:8px; align-items:flex-start; padding:6px 0 5px; border-top:1px solid rgba(96,126,190,.14); }
.ia-inc-log-row:first-child { border-top:none; padding-top:0; }
.ia-inc-log-row .ia-incident-state { margin-top:1px; }
.ia-inc-log-main { display:flex; flex-direction:column; gap:1px; flex:1 1 auto; min-width:0; }
.ia-inc-log-what { color:#bcd2ee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-inc-log-id { color:#7fa7d9; margin-right:5px; font-variant-numeric:tabular-nums; }
.ia-inc-log-when { font-size:9.5px; color:#5f6f8f; letter-spacing:.03em; font-variant-numeric:tabular-nums; }
.ia-inc-log-did { font-size:10px; color:#9fb0cc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-runbook { margin:0; font-size:11px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; background:rgba(10,14,24,.7); box-shadow:inset 0 0 0 1px rgba(96,126,190,.2); padding:9px; max-height:none; color:#bcd2ee; }
.ia-stream { flex:0 0 auto; max-height:150px; overflow:auto; padding:9px 16px 10px 24px; background:rgba(15,23,40,.55); border-top:1px solid rgba(96,126,190,.4); position:relative; }
.ia-stream::before { content:''; position:absolute; top:6px; left:9px; width:8px; height:8px; border-top:2px solid rgba(125,211,252,.5); border-left:2px solid rgba(125,211,252,.5); pointer-events:none; }
.ia-stream::after { content:''; position:absolute; bottom:6px; right:9px; width:8px; height:8px; border-bottom:2px solid rgba(125,211,252,.5); border-right:2px solid rgba(125,211,252,.5); pointer-events:none; }
.ia-stream-title { font-size:9px; text-transform:uppercase; letter-spacing:.18em; color:#9fc2e8; margin-bottom:6px; display:flex; align-items:center; gap:7px; }
.ia-stream-count { margin-left:auto; color:#7184a4; font-size:8px; letter-spacing:.08em; font-variant-numeric:tabular-nums; }
.ia-live-dot { width:6px; height:6px; flex:0 0 6px; background:#38bdf8; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); animation:ia-beacon-soft 1.8s ease-in-out infinite; }
.ia-stream-rows { display:flex; flex-direction:column; gap:1px; }
.ia-stream-row { display:grid; grid-template-columns:16px 92px minmax(0,1fr) 52px; align-items:center; gap:7px; min-height:23px; padding:2px 5px 2px 7px; border-left:2px solid #34496d; background:#111a2b; }
.ia-stream-row:hover { background:#1a2a45; }
.ia-stream-row.ia-kind-touch_blocked { border-left-color:#ef4444; }
.ia-stream-row.ia-kind-touch_allowed { border-left-color:#10b981; }
.ia-stream-row.ia-kind-read_doc { border-left-color:#22d3ee; }
.ia-stream-glyph { width:15px; height:15px; display:grid; place-items:center; color:#8fa3c1; border:1px solid #34496d; font-size:10px; line-height:1; }
.ia-stream-time { color:#7184a4; text-align:right; font-size:9px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.ia-stream-kind { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-transform:uppercase; font-size:8px; letter-spacing:.08em; color:#9fb0cc; }
.ia-stream-text { color:#c0d1e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ia-kind-touch_blocked .ia-stream-kind, .ia-kind-touch_blocked .ia-stream-text, .ia-kind-touch_blocked .ia-stream-glyph { color:#f87171; }
.ia-kind-touch_allowed .ia-stream-kind, .ia-kind-touch_allowed .ia-stream-glyph { color:#34d399; }
.ia-kind-read_doc .ia-stream-kind, .ia-kind-read_doc .ia-stream-glyph { color:#22d3ee; }
.ia-stream-foot { margin-top:6px; padding-top:5px; border-top:1px solid #263652; font-size:9px; color:#f87171; }
.ia-chip { display:inline-flex; align-items:center; gap:6px; min-height:23px; font-size:10px; padding:2px 9px; color:#9fb0cc; background:#111c30; border:1px solid #34496d; clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px); cursor:pointer; }
.ia-chip:hover { color:#eaf4ff; border-color:#7dd3fc; }
.ia-chip:focus-visible { outline:1px solid #7dd3fc; outline-offset:2px; }
.ia-chip:active { transform:translateY(1px); }
.ia-status-chip-mark { width:7px; height:7px; flex:0 0 7px; background:#7184a4; transform:rotate(45deg); }
.ia-status-chip-label { font-size:8px; letter-spacing:.13em; color:#8fa3c1; }
.ia-chip-count { color:#eef6ff; font-weight:700; font-variant-numeric:tabular-nums; }
.ia-chip-note { color:#7184a4; font-size:9px; }
.ia-chip-healthy .ia-status-chip-mark { background:#34d399; }
.ia-chip-attention .ia-status-chip-mark { background:#fbbf24; }
.ia-chip-incident .ia-status-chip-mark, .ia-chip-blocked .ia-status-chip-mark { background:#ef4444; }
.ia-chip-incident { color:#fca5a5; border-color:#ef4444; }
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
