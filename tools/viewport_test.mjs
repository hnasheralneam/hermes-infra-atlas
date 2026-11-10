// Interaction test for the desktop viewport — pan direction, wheel zoom and
// cursor anchoring, driven through the real component in a JSDOM document.
//
// The render smoke test proves the page renders; this proves it *moves* the way
// an operator expects, which is where the isometric canvas kept regressing.
//
//   node tools/viewport_test.mjs --modules /path/to/node_modules

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const modulesDir = resolve(arg('modules', process.env.ATLAS_NODE_MODULES || '.'))
if (!existsSync(join(modulesDir, 'react-dom')) || !existsSync(join(modulesDir, 'jsdom'))) {
  console.error(`viewport_test: ${modulesDir} needs react-dom and jsdom — pass --modules <dir>`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'atlas-viewport-'))
try {
  const nodeModules = join(work, 'node_modules')
  mkdirSync(join(nodeModules, '@hermes', 'plugin-sdk'), { recursive: true })
  for (const pkg of ['react', 'react-dom', 'scheduler']) {
    const source = join(modulesDir, pkg)
    if (existsSync(source)) cpSync(source, join(nodeModules, pkg), { recursive: true, dereference: true })
  }
  // Link jsdom rather than copy it: it resolves its own dependencies from the
  // tree it lives in, so a bare copy would break on parse5/whatwg-url.
  symlinkSync(join(modulesDir, 'jsdom'), join(nodeModules, 'jsdom'), 'dir')
  writeFileSync(
    join(nodeModules, '@hermes', 'plugin-sdk', 'package.json'),
    JSON.stringify({ name: '@hermes/plugin-sdk', version: '0.0.0-stub', type: 'module', exports: { '.': './index.mjs' } })
  )
  writeFileSync(join(nodeModules, '@hermes', 'plugin-sdk', 'index.mjs'), readFileSync(join(here, 'render_smoke_sdk.mjs'), 'utf8'))
  writeFileSync(join(work, 'plugin.mjs'), readFileSync(join(pluginDir, 'desktop', 'plugin.js'), 'utf8'))
  writeFileSync(join(work, 'run.mjs'), readFileSync(join(here, 'viewport_test_run.mjs'), 'utf8'))

  execFileSync(process.execPath, [join(work, 'run.mjs')], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
