# Catalog PR — infra-atlas

Copy `catalog/infra-atlas.yaml` to `plugin-catalog/infra-atlas.yaml` in a branch of
`NousResearch/hermes-agent`, open the PR, and paste the description below.

Pinned commit: `fccdc20272cfad0d23b3c01cdaa20a783b563fc0` (repo `main`).
Re-run the pre-submit gate against that exact checkout first:

```bash
git clone https://github.com/hnasheralneam/hermes-infra-atlas /tmp/ia && cd /tmp/ia
git checkout fccdc20272cfad0d23b3c01cdaa20a783b563fc0
hermes plugins validate . --install-deps   # passes locally today
```

---

## What it does

Infra Atlas turns the operator's own Markdown infrastructure registry into a live graph
and keeps the two honest with each other.

- **Registry as the source of intent.** It parses `servers/`, `services/`, `projects/`
  entries (YAML frontmatter, falling back to a heuristic parse of legacy prose) into typed
  nodes and edges, and it writes back: `infra_upsert` merges an entry atomically, refreshes
  `INDEX.md`, and prepends a `change-log.md` line — so keeping docs current is part of doing
  the work, not a separate chore.
- **Live discovery.** Local host (systemd, `/proc/net/tcp`, docker/podman, `tailscale`),
  Hermes runtime (configured model endpoints, MCP servers, cron jobs and their output
  freshness), plus opt-in Proxmox and Headscale API collectors and bounded TCP/HTTP probes.
- **Drift, five states per node.** `matched`, `changed` (field-level evidence: IP/port/host
  moved), `unregistered` (alive, nobody documented it), `stale` (documented, probes fail),
  `doc_only`. "What changed since Friday?" becomes one query.
- **Read-before-touch guardrail.** A `pre_tool_call` hook vetoes `terminal`, `write_file` and
  `patch` calls that touch a documented node whose entry was not read in this session, and the
  refusal quotes that node's own `pitfalls`. `infra_query` (or reading the entry file)
  unlocks it. This is changeable at runtime (`guardrail_mode: block | warn | off`).
- **Uptime monitoring with a bounded response.** Probe streaks open incidents; the first
  response is an allow-listed local restart playbook (`systemctl` / `docker compose` / `qm`
  on this host, cooldown and attempt budget), and only if that fails does the agent get woken
  with the node's registry runbook. Dependency-aware: a child inside a stopped container is
  reported as a symptom, not restarted. A generated watchdog script is silent
  (`{"wakeAgent": false}`, zero tokens) while the fleet is healthy.

## Surfaces used

- **Tools:** `infra_query`, `infra_sweep`, `infra_diff`, `infra_upsert`, `infra_bootstrap`,
  `infra_incidents` (this last one also schedules the watchdog through the `cronjob` tool).
- **Hooks:** `pre_tool_call` (the guardrail), `post_tool_call` (activity ledger for the
  overlay), `on_session_start` (kick off a background sweep).
- **Desktop:** full page at `/infra-atlas` (SVG topology, inspector with Diff / Uptime /
  Runbook tabs, incident strip), a statusbar health chip, the `::infra{}` and `::drift{}`
  transcript directives, `⌘K` commands, and events under `plugin.infra-atlas.*`.
- **Web dashboard backend:** `dashboard/plugin_api.py` serves
  `/api/plugins/infra-atlas/{graph,node,sweep,reconcile,heal,incidents,watchdog,settings,activity}`.
- **Bundled skill** (`infra-atlas`) plus an **automation blueprint** (`uptime-watchdog`) and a
  `/atlas` gateway command.

## Disclosure (rule 13)

- **Shell commands.** Two places. (1) The optional local remediation playbook executes a
  fixed set of allow-listed unit/container verbs (`systemctl --user start|restart …`,
  `docker compose up -d …`, `qm start …`) against services it already discovered on the local
  host. (2) The agent-side remediation brief asks the model to act — normal Hermes approval
  rules apply. There is no arbitrary command string from user input.
- **Network calls.** Only to targets the user configures or documents: the Proxmox API and
  Headscale API when those collectors are enabled (credentials via
  `agent.secret_scope.get_secret`), and TCP/HTTP probes to registered hosts, which are off by
  default for inferred ports.
- **Reads outside the plugin's own data.** The registry directory the user points it at, and
  read-only host state: `systemctl` listings, `/proc/net/tcp`, `docker ps`, `tailscale status`,
  and Hermes's own configuration for the runtime collector (model endpoints, MCP servers, cron
  jobs). No credential store is read; secrets go through Hermes.
- **Long-running process.** The uptime watchdog runs as a scheduled Hermes cron job (opt-in
  via `infra_incidents(action="setup_watchdog")`), one sweep per tick.
- **Behaviour that can block work.** With the default `guardrail_mode: block`, the plugin can
  refuse a `terminal`/`write_file`/`patch` call. It says exactly what to read first and fails
  open on any internal error.
- **Data storage.** SQLite under `$HERMES_HOME/plugin-data/infra-atlas/atlas.db`: nodes, edges,
  probe samples, incidents, session read-unlocks and tool-activity rows. Nothing leaves the
  machine.

## Why it belongs in the catalog

It is the pattern most agents eventually need and least often get: the agent is only as safe
as its knowledge of what it is touching, and documentation rots the moment someone provisions
by hand. This plugin makes that gap visible (drift), closes it (validated writes + change log),
and enforces it (guardrail), using only public Hermes surfaces — hooks, tools, the Desktop SDK,
and a dashboard router.

## Verification in this repo

- `pytest`: 68 passed (registry parse/write, fusion drift, guardrail, uptime, collectors, API,
  tools). One test skips where `ruamel.yaml` is absent.
- `hermes plugins doctor`: 6 tools, 3 hooks, no drift.
- `hermes plugins validate`: all checks pass, including `no core override` and `desktop surface`.
