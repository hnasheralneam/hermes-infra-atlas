// Driven by tools/viewport_test.mjs — mounts the real Infra Atlas page in a
// JSDOM document and asserts what the operator sees when they drag and scroll.

import { JSDOM } from 'jsdom'

const RECT = { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// Node 21+ defines a getter-only global navigator; defineProperty replaces it.
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no layout: every measurement the canvas takes is stubbed to 1000x600.
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { ...RECT, toJSON: () => RECT }
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const module = await import('./plugin.mjs')
const plugin = module.default
const { planScene } = module

const surfaces = []
plugin.register({
  rest: async () => ({}),
  storage: { get: async () => null, set: async () => {}, delete: async () => {} },
  onEvent: () => () => {},
  register: item => {
    surfaces.push(item)
    return () => {}
  },
  registerMany: list => {
    surfaces.push(...list)
    return () => {}
  }
})

const page = surfaces.find(surface => surface.id === 'page')
if (!page) {
  console.log('FAIL page surface not registered')
  process.exit(1)
}

const root = createRoot(window.document.getElementById('root'))
await React.act(async () => {
  root.render(page.render({}))
})
await React.act(async () => {
  await new Promise(resolve => setTimeout(resolve, 40))
})

const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log(`ok   ${name}`)
  else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const svg = window.document.querySelector('svg.ia-svg')
if (!svg) {
  console.log('FAIL no topology svg rendered')
  process.exit(1)
}

// Commit lands 240ms after the last gesture, so every dispatch waits past it
// inside act() — otherwise React's state updates escape the test scope.
const settle = () =>
  React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 320))
  })
const fire = async (target, event) => {
  await React.act(async () => {
    target.dispatchEvent(event)
    await new Promise(resolve => setTimeout(resolve, 320))
  })
}

const box = () => {
  const [x, y, w, h] = svg
    .getAttribute('viewBox')
    .split(/\s+/)
    .map(Number)
  const scale = Math.min(RECT.width / w, RECT.height / h)
  const ox = (RECT.width - w * scale) / 2
  const oy = (RECT.height - h * scale) / 2
  return { x, y, w, h, scale, ox, oy }
}
const worldAt = (screenX, screenY) => {
  const b = box()
  return { wx: b.x + (screenX - b.ox) / b.scale, wy: b.y + (screenY - b.oy) / b.scale }
}

const start = box()
check('viewBox starts at the whole scene', start.w > RECT.width && start.h > 0, JSON.stringify(start))

// ── wheel zoom ─────────────────────────────────────────────────────────────
const before = worldAt(500, 300)
await fire(svg, new window.WheelEvent('wheel', { deltaY: -240, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const zoomed = box()
check('scrolling up zooms in', zoomed.w < start.w - 1, `${start.w} → ${zoomed.w}`)

const after = worldAt(500, 300)
check(
  'zoom stays anchored under the cursor',
  Math.abs(after.wx - before.wx) < 0.5 && Math.abs(after.wy - before.wy) < 0.5,
  `world ${before.wx.toFixed(2)},${before.wy.toFixed(2)} → ${after.wx.toFixed(2)},${after.wy.toFixed(2)}`
)

await fire(svg, new window.WheelEvent('wheel', { deltaY: 4000, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const floor = box()
check('zoom out is clamped', floor.w <= start.w * 2.6 + 1, `width ${floor.w.toFixed(1)}`)

// Back to 100% for a predictable pan.
const resetButton = Array.from(window.document.querySelectorAll('.ia-map-btn')).find(button =>
  /%$/.test(button.textContent || '')
)
await React.act(async () => {
  resetButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 120))
})
const level = box()

// ── drag to pan ────────────────────────────────────────────────────────────
await fire(svg, new window.MouseEvent('pointerdown', { clientX: 400, clientY: 300, bubbles: true, cancelable: true, button: 0 }))
await fire(svg, new window.MouseEvent('pointermove', { clientX: 500, clientY: 300, bubbles: true, cancelable: true, button: 0 }))
const panned = box()
const expectedShift = 100 * level.scale
check(
  'dragging right moves the content right',
  Math.abs(level.x - panned.x - expectedShift) < 1.5,
  `minX ${level.x.toFixed(1)} → ${panned.x.toFixed(1)}, expected ${(level.x - expectedShift).toFixed(1)}`
)
check('horizontal drag leaves vertical pan alone', Math.abs(panned.y - level.y) < 0.5, `${level.y} → ${panned.y}`)

await fire(svg, new window.MouseEvent('pointermove', { clientX: 400, clientY: 360, bubbles: true, cancelable: true, button: 0 }))
const pannedDown = box()
check(
  'dragging down moves the content down',
  Math.abs(level.y - pannedDown.y - 60 * level.scale) < 1.5,
  `minY ${level.y.toFixed(1)} → ${pannedDown.y.toFixed(1)}`
)
await fire(svg, new window.MouseEvent('pointerup', { clientX: 400, clientY: 360, bubbles: true, cancelable: true, button: 0 }))

// ── double-click zoom ──────────────────────────────────────────────────────
const preDouble = box()
await fire(svg, new window.MouseEvent('dblclick', { clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const postDouble = box()
check('double-click zooms in', postDouble.w < preDouble.w - 1, `${preDouble.w.toFixed(1)} → ${postDouble.w.toFixed(1)}`)

// ── terrace packing ────────────────────────────────────────────────────────
const makeNodes = (count, stratum) =>
  Array.from({ length: count }, (_, index) => ({
    id: `svc-node-${String(index).padStart(2, '0')}`,
    kind: 'service',
    stratum,
    label: `node ${index}`,
    drift_status: 'matched',
    health_status: 'up'
  }))

const big = planScene(makeNodes(40, 3))
const bigPlat = big.platforms[0]
check('a large tier stacks three rows deep', bigPlat.rows === 3, `rows ${bigPlat.rows}, cols ${bigPlat.cols}`)
check('a large tier fits every node in its grid', bigPlat.cols * bigPlat.rows >= 40, `${bigPlat.cols}x${bigPlat.rows}`)
check('every node is placed exactly once', big.placed.size === 40, `${big.placed.size} placed`)

const cells = new Set()
big.placed.forEach(info => cells.add(`${info.gx},${info.gy}`))
check('no two nodes share a tile', cells.size === 40, `${cells.size} distinct tiles`)

const small = planScene(makeNodes(5, 3))
check('a small tier stays shallow', small.platforms[0].rows <= 2, `rows ${small.platforms[0].rows}`)

const rowsOf = plan => plan.platforms.map(platform => platform.rows).join('/')
check(
  'stacking is capped at three',
  planScene(makeNodes(60, 3)).platforms.every(platform => platform.rows <= 3),
  rowsOf(planScene(makeNodes(60, 3)))
)

// ── lean mode ──────────────────────────────────────────────────────────────
const animated = window.document.querySelectorAll('animateMotion').length
const nodes = window.document.querySelectorAll('[data-node-id]').length
check('bounded SMIL: no more packets than edges on a small fleet', animated <= nodes * 2, `${animated} anim / ${nodes} nodes`)

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nviewport interactions behave')
process.exit(failures.length ? 1 : 0)
