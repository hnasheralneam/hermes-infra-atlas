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
// the theme probe paints a swatch and reads it back; jsdom provides the API on window
globalThis.getComputedStyle = (...args) => window.getComputedStyle(...args)
// jsdom has no layout: every measurement the canvas takes is stubbed to 1000x600.
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { ...RECT, toJSON: () => RECT }
}

// React warnings are failures here: a missing key or a bad prop is invisible in a
// screenshot and only shows up later, in front of an operator.
const reactWarnings = []
for (const level of ['error', 'warn']) {
  const original = console[level]
  console[level] = (...args) => {
    const text = String(args[0] ?? '')
    if (/Warning:|Each child in a list|React does not recognize|cannot appear as a child|validateDOMNesting/i.test(text)) {
      reactWarnings.push(text.split('\n')[0])
    }
    original(...args)
  }
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { HOST_CALLS } = await import('@hermes/plugin-sdk')
const module = await import('./plugin.mjs')
const plugin = module.default
const { planScene } = module

const surfaces = []
plugin.register({
  // The page reads /brief (Ask Hermes), /heal, /reconcile and /graph; the brief
  // is the only one whose text the harness asserts on.
  rest: async (path) =>
    String(path).includes('/brief')
      ? { ok: true, node_id: 'lxc-202-cache', brief: 'BRIEF lxc-202-cache: drift changed, 1 reason' }
      : {},
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
await fire(svg, new window.MouseEvent('pointerdown', { clientX: 400, clientY: 300, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
await fire(svg, new window.MouseEvent('pointermove', { clientX: 500, clientY: 300, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
const panned = box()
const expectedShift = 100 * level.scale
check(
  'dragging right moves the content right',
  Math.abs(level.x - panned.x - expectedShift) < 1.5,
  `minX ${level.x.toFixed(1)} → ${panned.x.toFixed(1)}, expected ${(level.x - expectedShift).toFixed(1)}`
)
check('horizontal drag leaves vertical pan alone', Math.abs(panned.y - level.y) < 0.5, `${level.y} → ${panned.y}`)

await fire(svg, new window.MouseEvent('pointermove', { clientX: 400, clientY: 360, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
const pannedDown = box()
check(
  'dragging down moves the content down',
  Math.abs(level.y - pannedDown.y - 60 * level.scale) < 1.5,
  `minY ${level.y.toFixed(1)} → ${pannedDown.y.toFixed(1)}`
)
await fire(svg, new window.MouseEvent('pointerup', { clientX: 400, clientY: 360, bubbles: true, cancelable: true, button: 0, buttons: 0 }))

// ── camera survives re-renders ─────────────────────────────────────────────
await fire(svg, new window.MouseEvent('pointerdown', { clientX: 400, clientY: 300, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
await fire(svg, new window.MouseEvent('pointermove', { clientX: 460, clientY: 300, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
const midDrag = box().x
const allSegment = Array.from(window.document.querySelectorAll('.ia-seg-btn')).find(button => /^All/i.test(button.textContent || ''))
if (allSegment) {
  await React.act(async () => {
    allSegment.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
  })
}
check(
  'a re-render mid-drag does not move the camera',
  Math.abs(box().x - midDrag) < 0.5,
  `minX ${midDrag.toFixed(1)} → ${box().x.toFixed(1)}`
)
await fire(svg, new window.MouseEvent('pointerup', { clientX: 460, clientY: 300, bubbles: true, cancelable: true, button: 0, buttons: 0 }))

// ── light theme ────────────────────────────────────────────────────────────
const lightHost = window.document.createElement('div')
window.document.body.appendChild(lightHost)
const realGetComputedStyle = globalThis.getComputedStyle
// dark text on a light surface = the app is in light mode
globalThis.getComputedStyle = () => ({ color: 'rgb(24, 28, 38)' })
const lightRoot = createRoot(lightHost)
await React.act(async () => {
  lightRoot.render(page.render({}))
  await new Promise(resolve => setTimeout(resolve, 80))
})
const lightEl = lightHost.querySelector('.ia-root')
check('light theme switches the diorama palette', Boolean(lightEl && lightEl.classList.contains('ia-light')), lightEl ? lightEl.className : 'no root')
await React.act(async () => {
  lightRoot.unmount()
})
lightHost.remove()
globalThis.getComputedStyle = realGetComputedStyle

// ── double-click zoom ──────────────────────────────────────────────────────
const preDouble = box()
await fire(svg, new window.MouseEvent('dblclick', { clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const postDouble = box()
check('double-click zooms in', postDouble.w < preDouble.w - 1, `${preDouble.w.toFixed(1)} → ${postDouble.w.toFixed(1)}`)

// ── two-finger scroll pans, wheel zooms ────────────────────────────────────
const resetView = Array.from(window.document.querySelectorAll('.ia-map-btn')).find(button => /%$/.test(button.textContent || ''))
await React.act(async () => {
  resetView.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 120))
})
const beforeTrackpad = box()
await fire(svg, new window.WheelEvent('wheel', { deltaY: 18, deltaX: 12, deltaMode: 0, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const afterTrackpad = box()
check('a trackpad scroll pans instead of zooming',
  Math.abs(afterTrackpad.w - beforeTrackpad.w) < 0.5 && Math.abs(afterTrackpad.x - beforeTrackpad.x) > 1,
  `w ${beforeTrackpad.w.toFixed(1)}→${afterTrackpad.w.toFixed(1)}, minX ${beforeTrackpad.x.toFixed(1)}→${afterTrackpad.x.toFixed(1)}`)

const beforeNotch = box()
await fire(svg, new window.WheelEvent('wheel', { deltaY: -120, deltaMode: 1, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))
const afterNotch = box()
check('a mouse-wheel notch still zooms', afterNotch.w < beforeNotch.w - 1, `w ${beforeNotch.w.toFixed(1)}→${afterNotch.w.toFixed(1)}`)

// ── drawer ─────────────────────────────────────────────────────────────────
const nodeEl = window.document.querySelector('[data-node-id="lxc-202-cache"]')
check('a node is clickable on the canvas', Boolean(nodeEl), 'lxc-202-cache missing')
if (nodeEl) {
  await React.act(async () => {
    nodeEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 60))
  })
  const drawer = window.document.querySelector('.ia-drawer')
  check('selecting a node opens the drawer', Boolean(drawer), 'no .ia-drawer')
  const text = drawer ? drawer.textContent : ''
  check('the drawer names the node', text.includes('cache-tank'), text.slice(0, 80))
  check('the drawer shows the drift diff', text.includes('10.20.0.30') && text.includes('10.20.0.22'))
  check('the drawer surfaces the documented pitfall', text.includes('Dial 10.20.0.22:6379'))
  check('the drawer renders masked vault credentials', text.includes('Vault Credentials') && text.includes('cache-tank-auth'))
  const tabs = Array.from(window.document.querySelectorAll('.ia-drawer-tabs button'))
  check('the drawer has overview / uptime / runbook tabs', tabs.length === 3, tabs.map(tab => tab.textContent).join('|'))
  const uptimeTab = tabs.find(tab => /uptime/i.test(tab.textContent || ''))
  if (uptimeTab) {
    await React.act(async () => {
      uptimeTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    check('the uptime tab renders probe history', window.document.querySelector('.ia-drawer').textContent.includes('99.4'))
  }
  const runbookTab = tabs.find(tab => /runbook/i.test(tab.textContent || ''))
  if (runbookTab) {
    await React.act(async () => {
      runbookTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    check('the runbook tab renders the markdown body', window.document.querySelector('.ia-drawer').textContent.includes('Dial 10.20.0.22:6379'))
  }

  // ── Ask Hermes opens a chat with the brief ───────────────────────────────
  // The button used to paste into whatever chat happened to be focused, which
  // from the atlas page usually meant no chat at all: nothing visible happened.
  const askButton = Array.from(window.document.querySelectorAll('.ia-drawer button')).find(button =>
    /Ask Hermes/.test(button.textContent || '')
  )
  check('the drawer offers an Ask Hermes action', Boolean(askButton), 'no Ask Hermes button')
  if (askButton) {
    await React.act(async () => {
      askButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 260))
    })
    check('Ask Hermes starts a new chat', HOST_CALLS.newChat === 1, `newChat calls: ${HOST_CALLS.newChat}`)
    const sent = HOST_CALLS.submitted[0]
    check('Ask Hermes submits the brief into the fresh draft', Boolean(sent) && sent.sessionId === 'new', JSON.stringify(sent || {}).slice(0, 120))
    check('the brief names the node it opened for', Boolean(sent) && String(sent.text).includes('lxc-202-cache'), String(sent && sent.text).slice(0, 80))
    const toast = HOST_CALLS.notified[HOST_CALLS.notified.length - 1]
    check('the operator is told what happened', Boolean(toast) && /chat/i.test(String(toast.message)), JSON.stringify(toast || {}))
  }
}

// ── legend & filter badge exactness ────────────────────────────────────────
const legendBtn = window.document.querySelector('.ia-map-legend')
if (legendBtn) {
  await React.act(async () => {
    legendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
  })
  const infRow = Array.from(window.document.querySelectorAll('.ia-legend-row')).find(r =>
    (r.textContent || '').includes('Inference server')
  )
  check('legend draws the dual-fan GPU glyph for inference servers', Boolean(infRow && infRow.querySelectorAll('circle').length === 2))
  // The drift tags are jargon ("matched") until the legend says what they mean.
  const legendText = window.document.querySelector('.ia-legend-card').textContent
  check('legend explains the drift tags', /Drift Tags/.test(legendText) && /reality agree/i.test(legendText), legendText.slice(0, 120))
  const expectedTags = ['Matched', 'Drift', 'Unregistered', 'Stale', 'Peer', 'Doc only']
  check('legend explains every tag the map can draw', expectedTags.every(tag => legendText.includes(tag)), expectedTags.join('|'))
}
const alertsSeg = Array.from(window.document.querySelectorAll('.ia-seg-btn')).find(b => /^Alerts/i.test(b.textContent || ''))
if (alertsSeg) {
  const expectedAlerts = Number(alertsSeg.querySelector('.ia-seg-count')?.textContent || '-1')
  await React.act(async () => {
    alertsSeg.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
  })
  const drawnAlerts = window.document.querySelectorAll('[data-node-id]').length
  check('Alerts segment badge equals the exact count of nodes drawn', drawnAlerts === expectedAlerts, `badge=${expectedAlerts}, drawn=${drawnAlerts}`)
}

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

// A guest must sit next to its hypervisor, not wherever the alphabet lands.
const layoutNodes = [
  { id: 'srv-a', kind: 'server', stratum: 1, label: 'alpha-host' },
  { id: 'srv-b', kind: 'server', stratum: 1, label: 'beta-host' },
  { id: 'vm-a1', kind: 'vm', stratum: 2, label: 'zzz-vm-a1', parent_id: 'srv-a' },
  { id: 'vm-a2', kind: 'vm', stratum: 2, label: 'zzz-vm-a2', parent_id: 'srv-a' },
  { id: 'vm-b1', kind: 'vm', stratum: 2, label: 'aaa-vm-b1', parent_id: 'srv-b' },
  { id: 'vm-b2', kind: 'vm', stratum: 2, label: 'aaa-vm-b2', parent_id: 'srv-b' },
  { id: 'svc-loose', kind: 'service', stratum: 2, label: 'mmm-service' }
]
const grouped = planScene(layoutNodes)
const compute = grouped.platforms.find(platform => platform.stratum === 2)
// grid order = row-major, so this is the slot index a node occupies on the terrace
const order = Array.from(grouped.placed.entries())
  .filter(([, info]) => info.t === compute.t)
  .sort((a, b) => a[1].gy - b[1].gy || a[1].gx - b[1].gx)
  .map(([id]) => id)
const idx = id => order.indexOf(id)
check('guests follow their hypervisor, not the alphabet', idx('vm-a1') < idx('vm-b1'), order.join(' < '))
check('siblings stay adjacent', Math.abs(idx('vm-a1') - idx('vm-a2')) === 1 && Math.abs(idx('vm-b1') - idx('vm-b2')) === 1, order.join(' < '))
check('ungrouped nodes fill in after the family groups', idx('svc-loose') > idx('vm-b2'), order.join(' < '))

// Degenerate fleets must not throw: an empty registry is the first thing a new
// user sees, and a one-node fleet is the second.
const empty = planScene([])
check('an empty fleet plans an empty scene', empty.platforms.length === 0 && empty.placed.size === 0, JSON.stringify(empty.platforms))
const single = planScene([{ id: 'only', kind: 'service', stratum: 3, label: 'only node' }])
check('a single-node fleet still places it', single.placed.size === 1 && single.platforms.length === 1, `${single.placed.size} placed`)

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

const uniqueWarnings = [...new Set(reactWarnings)]
check('no React warnings while rendering and driving the UI', uniqueWarnings.length === 0, uniqueWarnings.join(' | '))

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nviewport interactions behave')
process.exit(failures.length ? 1 : 0)
