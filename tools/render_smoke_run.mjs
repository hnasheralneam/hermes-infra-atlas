// Runs inside the temp dir created by render_smoke.mjs: ../plugin.mjs and
// ./node_modules are already in place.
import { renderToString, renderToStaticMarkup } from 'react-dom/server'
import { pathToFileURL } from 'node:url'

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

console.log(`\n${results.length - failed.length}/${results.length} surfaces rendered`)
process.exit(failed.length ? 1 : 0)
