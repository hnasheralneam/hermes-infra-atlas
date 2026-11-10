#!/usr/bin/env bash
# Every gate this plugin has, in the order a reviewer would run them.
#
#   tools/check.sh
#
# Needs: node + python3, a Hermes Agent checkout (default ~/.hermes/hermes-agent)
# for the test suite's imports and for the React copy the desktop harnesses use.
# Override with ATLAS_HERMES_AGENT=/path/to/hermes-agent or ATLAS_NODE_MODULES=/path/to/node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

# $HERMES_AGENT is set to a stray value (=true) in some environments, so prefer
# the explicit override and fall back to the default install when it is not a tree.
HERMES_AGENT="${ATLAS_HERMES_AGENT:-${HERMES_AGENT:-}}"
if [[ ! -d "$HERMES_AGENT/agent" ]]; then
  HERMES_AGENT="$HOME/.hermes/hermes-agent"
fi
if [[ ! -d "$HERMES_AGENT/agent" ]]; then
  echo "check: no Hermes Agent checkout — set ATLAS_HERMES_AGENT=/path/to/hermes-agent" >&2
  exit 2
fi
MODULES="${ATLAS_NODE_MODULES:-$HERMES_AGENT/node_modules}"
if [[ ! -d "$MODULES/react" ]]; then
  echo "check: $MODULES has no react — set ATLAS_NODE_MODULES to a tree with react/react-dom" >&2
  exit 2
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "python: compile every module"
python3 -m compileall -q atlas_tools.py config.py fusion.py hooks.py matcher.py registry_kb.py \
  schemas.py store.py uptime.py collectors dashboard
echo ok

step "desktop: syntax"
node --check desktop/plugin.js
echo ok

step "desktop: register + render all 8 surfaces"
node tools/render_smoke.mjs --modules "$MODULES"

step "desktop: pan, zoom, layout"
node tools/viewport_test.mjs --modules "$MODULES"

step "manifest: hermes plugins validate"
hermes plugins validate . >/dev/null && echo ok

step "python: pytest"
PYTHONPATH="$HERMES_AGENT" python3 -m pytest -q

step "python: coverage (floor 75%)"
PYTHONPATH="$HERMES_AGENT" python3 -m coverage run --source=. --omit='tests/*,tools/*,desktop/*' -m pytest -q >/dev/null
python3 -m coverage report --fail-under=75 | tail -1

printf '\n\033[1;32mall gates passed\033[0m\n'
