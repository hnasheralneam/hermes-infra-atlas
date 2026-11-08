# Infra Atlas

A Hermes Agent plugin that turns a Markdown infrastructure registry into a **live,
self-healing infrastructure graph** — and enforces the rule that an agent reads the
documentation *before* it touches the box.

- **Knowledge layer** — `servers/`, `services/`, `projects/` entries with optional YAML
  frontmatter; legacy prose-only entries are parsed heuristically so nothing has to be
  rewritten by hand.
- **Live layer** — zero-config discovery of this host (systemd user/system units, listening
  ports, Docker/Podman, the Tailscale CLI) and of the Hermes runtime (model endpoints, MCP
  servers, cron jobs and their freshness); opt-in Proxmox VE and Headscale APIs; bounded
  TCP/HTTP probes.
- **Fusion layer** — every node is classified as `matched`, `changed`, `unregistered`,
  `stale` or `doc_only`, with field-level evidence, and one call adopts reality back into
  the Markdown.
- **Read-before-you-touch guardrail** — a `pre_tool_call` policy hook **blocks** a
  `terminal` / `write_file` / `patch` call that touches a documented host, VM, container,
  IP, systemd unit or project path when the session has not read that entry yet, and tells
  the agent exactly which entry to read (including the pitfalls you documented).
- **Uptime + autonomous downtime response** — rolling probe history, flap suppression,
  incidents, and a two-stage heal: a deterministic local restart playbook first, then the
  agent itself, woken with the node's own runbook as the brief. Healthy ticks cost zero
  LLM tokens (`{"wakeAgent": false}`).

## Install

```bash
hermes plugins install <owner>/infra-atlas      # or link a checkout:
ln -s ~/src/infra-atlas ~/.hermes/plugins/infra-atlas
hermes plugins enable infra-atlas
```

Then open **Infra Atlas** in the desktop sidebar (or ⌘K → “Infra Atlas: open the
infrastructure graph”). The desktop half is opt-in: flip it on in Capabilities → Plugins.

## First five minutes

```text
/atlas                     # counts, guardrail mode, open incidents
infra_bootstrap            # add frontmatter to an existing Markdown registry
infra_sweep                # discover + probe + diff
infra_query node_id=…      # read one entry (and unlock it for this session)
```

No registry yet? Turn on **Demo fleet** (page control, or `infra_bootstrap mode=load_demo_fixture`)
to explore a sanitized 22-node topology with drift, an open incident and uptime history.

## The registry entry

```markdown
---
id: svc-litellm
kind: service
label: LiteLLM Gateway
parent_id: lxc-201
host_ip: 10.0.0.212
ports: [4000]
managed_by: systemd-system
systemd_unit: litellm.service
probe: http://10.0.0.212:4000/health/liveliness
recovery_cmd: "systemctl restart litellm.service"
auto_heal_policy: auto
depends_on: [svc-litellm-postgres]
pitfalls: "Dial 10.0.0.212:4000 directly; the old front was removed."
---

# LiteLLM Gateway
…your runbook, untouched…
```

`infra_upsert` merges frontmatter and never truncates the prose below it; it also updates
`INDEX.md` and prepends a `change-log.md` entry. `pitfalls` is surfaced in the guardrail
block message and in the outage brief, so the operator's hard-won rules reach the agent at
the moment they matter.

## Tools

| Tool | What it does |
|---|---|
| `infra_query` | Read a node (runbook + live diff + uptime + blast radius). Unlocks it for write/terminal use in this session. |
| `infra_sweep` | Run collectors + probes, recompute drift, evaluate incidents, attempt the safe local heal. |
| `infra_diff` | What changed, which incidents opened, who touched what — over a window. |
| `infra_upsert` | Create/update/adopt/remove a registry entry, with change-log. |
| `infra_bootstrap` | Annotate an existing KB, scaffold from live discovery, or load the demo fleet. |
| `infra_incidents` | List/get/heal/resolve/escalate incidents; install the zero-token watchdog. |

Bundled skill: `infra-atlas:infra-atlas` (loaded automatically when the plugin is enabled).

## Settings

`registry_path`, `guardrail_mode` (`block`/`warn`/`off`), `auto_heal_mode`
(`auto`/`playbook_only`/`notify_only`/`off`), `failure_threshold`, `heal_cooldown_sec`,
`demo_mode`, the three zero-config collectors, and the opt-in Proxmox/Headscale
credentials (secrets go to `.env` through Hermes and are read with `agent.secret_scope`).

## What it touches

- **Reads** the registry directory, `$HERMES_HOME/cron/jobs.json`, the Hermes config
  (read-only), `/proc/net/tcp`, and — only when configured — the Proxmox and Headscale
  APIs.
- **Writes** only inside the registry directory (entry files, `INDEX.md`, `change-log.md`)
  and its own SQLite database under `$HERMES_HOME/plugin-data/infra-atlas/`.
- **Runs commands** only for `recovery_cmd`, only on this host, only for an allow-listed
  prefix (`systemctl …`, `service …`, `docker compose …`, `podman …`, `pct …`, `qm …`),
  with a cooldown and an attempt budget.
- **Blocks** tool calls while the guardrail is in `block` mode; set it to `warn` or `off`
  to disable.

No telemetry, no network calls to anything not configured above.

## Layout

```
plugin.yaml          manifest (tools, hooks, settings)
__init__.py          register(ctx)
registry_kb.py       Markdown ↔ node model, atomic writer, change-log
collectors/          local host, Hermes runtime, Proxmox, Headscale, probes, fixture
fusion.py            correlation + drift classification + sweep
uptime.py            probes → incidents → playbook/agent response, watchdog script
matcher.py           tool call → nodes (IPs, units, VMIDs, paths)
hooks.py             pre_tool_call guardrail, post_tool_call activity
atlas_tools.py       the six tools
dashboard/           FastAPI routes under /api/plugins/infra-atlas
desktop/plugin.js    full-page graph, inspector, statusbar chip, ::infra / ::drift cards
skills/infra-atlas/  the bundled protocol skill
tests/               pytest suite (registry, fusion, gate, uptime, collectors, API)
```

## Tests

```bash
PYTHONPATH=<hermes-agent checkout> python -m pytest
hermes plugins doctor .
hermes plugins validate .
```

The desktop half has its own check — it is loaded uncompiled by the app, so a bad
component only fails at render time:

```bash
node tools/render_smoke.mjs --modules /path/to/a/node_modules   # needs react + react-dom
```

It renders every registered surface (page, chip, both transcript cards) with
`react-dom/server` against a stubbed `@hermes/plugin-sdk` and fails on any crash.
Eight of eight surfaces render on this tree.

The topology is drawn as SVG rather than a canvas: it scales with `viewBox`
instead of a `ResizeObserver` + `devicePixelRatio` dance, keeps the nodes
selectable and keyboard-reachable, and stays crisp at any zoom.

MIT.
