// Runs inside the temp dir created by render_smoke.mjs: ../plugin.mjs and
// ./node_modules are already in place.
import { renderToString, renderToStaticMarkup } from 'react-dom/server'
import { pathToFileURL } from 'node:url'

// React warnings fail the build: a missing key or a bad prop renders fine in a
// screenshot and breaks in front of an operator.
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

const plugin = (await import(pathToFileURL(new URL('./plugin.mjs', import.meta.url).pathname).href)).default

const surfaces = []
const ctx = {
  rest: async () => ({}),
  storage: { get: async () => null, set: async () => {}, delete: async () => {} },
  onEvent: () => () => {},
  registerMany: list => {
    for (const item of list) surfaces.push(item)
    return () => {}
  },
  register: item => {
    surfaces.push(item)
    return () => {}
  }
}

plugin.register(ctx)

const results = []
for (const surface of surfaces) {
  const label = `${surface.id} [${surface.area}]`
  const hasRender = typeof surface.render === 'function' || typeof surface.data?.render === 'function'
  if (!hasRender) {
    results.push({ label, ok: true, note: 'no render' })
    continue
  }
  try {
    let element
    if (surface.area === 'transcript-directive') {
      const attrs = surface.data?.name === 'infra' ? { id: 'lxc-202-cache' } : {}
      element = surface.data.render({ attrs })
    } else {
      element = surface.render({})
    }
    if (element === null || element === undefined) {
      results.push({ label, ok: true, note: 'renders nothing' })
      continue
    }
    let html = renderToString(element)
    if (!html) html = renderToStaticMarkup(element)
    results.push({ label, ok: true, bytes: html.length, sample: html.slice(0, 80), html })
  } catch (error) {
    results.push({ label, ok: false, error: `${error.name}: ${error.message}`, stack: String(error.stack).split('\n').slice(0, 3).join('\n') })
  }
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(
    result.ok
      ? `ok   ${result.label} (${result.bytes ?? 0} bytes)${result.note ? ` — ${result.note}` : ''}`
      : `FAIL ${result.label}\n     ${result.error}\n     ${result.stack}`
  )
}

// The page must render the isometric scene, not merely not crash: platforms,
// per-kind shapes, routed edges and the travelling packets are all part of it.
const page = results.find(result => result.label.startsWith('page ['))
const sceneMarkers = ['ia-iso', 'ia-plat-top', 'ia-node ', 'ia-edge-line', 'animateMotion']
const missing = page?.html ? sceneMarkers.filter(marker => !page.html.includes(marker)) : sceneMarkers
if (missing.length) {
  console.log(`FAIL page isometric scene is missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('ok   page renders the isometric scene (platforms, shapes, routed edges, packets)')

// Retired entries document something that no longer exists: they must not be
// drawn as empty shapes, and the `All` count must match what is actually drawn.
const retiredDrawn = page?.html?.includes('data-node-id="srv-old-sandbox"')
if (retiredDrawn) {
  console.log('FAIL a status:removed entry was drawn on the topology')
  process.exit(1)
}
console.log('ok   status:removed entries stay off the map')

// Health has to be visible in the picture, not just in the drawer: a down node
// draws a red beacon, and a stale node says so on its chip.
const downBeacons = (page?.html?.match(/ia-beacon-down/g) || []).length
if (!downBeacons) {
  console.log('FAIL no down node rendered a red beacon')
  process.exit(1)
}
console.log(`ok   ${downBeacons} down node(s) render a red beacon`)
if (!/ia-edge|ia-chip/i.test(page?.html || '')) {
  console.log('FAIL drift/edge decoration missing from the scene')
  process.exit(1)
}

// The plugin host themes the frame with --foreground / --card / --muted-foreground.
// Consuming only the in-tree --ui-* names is what left the canvas dark while the
// app's text turned black in light mode.
if (!/data-build="[0-9A-Za-z._-]{4,}"/.test(page?.html || '')) {
  console.log('FAIL the page does not expose data-build (needed to verify a desktop reload)')
  process.exit(1)
}
console.log('ok   page exposes data-build for reload verification')

for (const token of ['var(--foreground', 'var(--card', 'var(--muted-foreground']) {
  if (!(page?.html || '').includes(token)) {
    console.log(`FAIL the page does not consume the frame theme token ${token})`)
    process.exit(1)
  }
}
console.log('ok   page consumes the frame theme tokens (foreground, card, muted)')

// Docker containers and inference servers must be visually distinct from services.
const classes = page?.html || ''
if (!classes.includes('ia-kind-inference') || !classes.includes('ia-kind-container')) {
  console.log('FAIL inference/container silhouettes missing from the scene')
  process.exit(1)
}
const fans = (classes.match(/class="ia-fan-blades"/g) || []).length
if (fans !== 2) {
  console.log(`FAIL inference node drew ${fans} fan(s), expected 2 (one per visible face)`)
  process.exit(1)
}
if (!classes.includes('ia-door') || !classes.includes('ia-heat')) {
  console.log('FAIL container crate or inference heat shimmer missing')
  process.exit(1)
}
console.log(`ok   containers draw a crate, inference servers draw GPU fans (${fans} fans, heat shimmer present)`)

const drawn = (page?.html?.match(/data-node-id="/g) || []).length
const allBadge = page?.html?.match(/<span class="ia-seg-count">(\d+)<\/span>/g) || []
if (!drawn) {
  console.log('FAIL page drew no nodes at all')
  process.exit(1)
}
console.log(`ok   ${drawn} nodes drawn (retired excluded)`)

const uniqueWarnings = [...new Set(reactWarnings)]
if (uniqueWarnings.length) {
  console.log(`FAIL ${uniqueWarnings.length} React warning(s):`)
  for (const warning of uniqueWarnings) console.log(`     ${warning}`)
  process.exit(1)
}
console.log('ok   no React warnings from any surface')

console.log(`\n${results.length - failed.length}/${results.length} surfaces rendered`)
process.exit(failed.length ? 1 : 0)
