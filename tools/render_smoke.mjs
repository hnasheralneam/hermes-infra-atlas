// Render smoke test for desktop/plugin.js — catches crashes the loader cannot.
//
// The Desktop loads this file uncompiled and renders it inside its own React
// tree. A typo in a component name, an object rendered as a child, or a missing
// hook import only shows up at render time, in the app, in front of an operator.
// This harness renders every registered surface with react-dom/server against a
// stubbed plugin SDK, so those failures happen in CI instead.
//
//   node tools/render_smoke.mjs --modules /path/to/node_modules
//
// `--modules` must contain `react` and `react-dom` (any tree that already ships
// them works; the Hermes desktop build tree has both).

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const modulesDir = resolve(arg('modules', process.env.ATLAS_NODE_MODULES || '.'))
if (!existsSync(join(modulesDir, 'react')) || !existsSync(join(modulesDir, 'react-dom'))) {
  console.error(`render_smoke: ${modulesDir} has no react/react-dom — pass --modules <dir> (or ATLAS_NODE_MODULES)`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'atlas-render-'))
try {
  const nodeModules = join(work, 'node_modules')
  mkdirSync(join(nodeModules, '@hermes', 'plugin-sdk'), { recursive: true })
  for (const pkg of ['react', 'react-dom', 'scheduler']) {
    const source = join(modulesDir, pkg)
    if (existsSync(source)) cpSync(source, join(nodeModules, pkg), { recursive: true, dereference: true })
  }
  writeFileSync(
    join(nodeModules, '@hermes', 'plugin-sdk', 'package.json'),
    JSON.stringify({ name: '@hermes/plugin-sdk', version: '0.0.0-stub', type: 'module', exports: { '.': './index.mjs' } })
  )
  writeFileSync(join(nodeModules, '@hermes', 'plugin-sdk', 'index.mjs'), readFileSync(join(here, 'render_smoke_sdk.mjs'), 'utf8'))
  writeFileSync(join(work, 'plugin.mjs'), readFileSync(join(pluginDir, 'desktop', 'plugin.js'), 'utf8'))
  writeFileSync(join(work, 'run.mjs'), readFileSync(join(here, 'render_smoke_run.mjs'), 'utf8'))

  execFileSync(process.execPath, [join(work, 'run.mjs')], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
