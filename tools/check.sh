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
  for candidate_mod in ./node_modules "$HOME"/work/*/web/node_modules; do
    if [[ -d "$candidate_mod/react" && -d "$candidate_mod/react-dom" && -d "$candidate_mod/jsdom" ]]; then
      MODULES="$candidate_mod"
      break
    fi
  done
fi
# `python3` on PATH may be a Hermes venv without the test deps; find one with pytest (preferring ruamel.yaml too).
PYTHON="${ATLAS_PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in python3 /usr/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import pytest, ruamel.yaml" >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  for candidate in python3 /usr/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import pytest" >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  echo "check: no python3 with pytest — set ATLAS_PYTHON=/path/to/python3" >&2
  exit 2
fi
if [[ ! -d "$MODULES/react" ]]; then
  echo "check: $MODULES has no react — set ATLAS_NODE_MODULES to a tree with react/react-dom" >&2
  exit 2
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "python: compile every module"
"$PYTHON" -m compileall -q __init__.py atlas_cli.py atlas_tools.py config.py credentials.py fusion.py hooks.py matcher.py registry_kb.py \
  schemas.py store.py uptime.py collectors dashboard
echo ok

step "desktop: syntax"
node --check desktop/plugin.js
echo ok

step "desktop: register + render all 8 surfaces"
node tools/render_smoke.mjs --modules "$MODULES"

step "desktop: pan, zoom, layout"
node tools/viewport_test.mjs --modules "$MODULES"

step "manifest: hermes plugins doctor + validate + catalog parity"
hermes plugins doctor . --ci >/dev/null
hermes plugins validate . >/dev/null
"$PYTHON" - <<'PY'
import re, sys
manifest = open("plugin.yaml").read()
catalog = open("catalog/infra-atlas.yaml").read()
p_tools = re.findall(r"^\s+-\s+(\w+)$", manifest.split("provides_tools:")[1].split("provides_hooks:")[0], re.M)
c_tools = re.findall(r"^\s+-\s+(\w+)$", catalog.split("provides_tools:")[1].split("provides_hooks:")[0], re.M)
p_hooks = re.findall(r"^\s+-\s+(\w+)$", manifest.split("provides_hooks:")[1].split("config_schema:")[0], re.M)
c_hooks = re.findall(r"^\s+-\s+(\w+)$", catalog.split("provides_hooks:")[1].split("provides_middleware:")[0], re.M)
assert p_tools == c_tools, f"catalog provides_tools {c_tools} != plugin.yaml {p_tools}"
assert p_hooks == c_hooks, f"catalog provides_hooks {c_hooks} != plugin.yaml {p_hooks}"
assert re.search(r'^sha:\s*"[0-9a-f]{40}"', catalog, re.M), "catalog sha must be a 40-char hex SHA"
PY
echo ok

step "python: pytest"
PYTHONPATH="$HERMES_AGENT" "$PYTHON" -m pytest -q

step "python: coverage (floor 75%)"
PYTHONPATH="$HERMES_AGENT" "$PYTHON" -m coverage run --source=. --omit='tests/*,tools/*,desktop/*' -m pytest -q >/dev/null
"$PYTHON" -m coverage report --fail-under=75 | tail -1

printf '\n\033[1;32mall gates passed\033[0m\n'
