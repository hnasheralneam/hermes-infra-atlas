# Infra Atlas

A Hermes Agent plugin that turns a Markdown infrastructure registry into a **live,
self-healing infrastructure graph** — and enforces the rule that an agent reads the
documentation *before* it touches the box.

![Infra Atlas: isometric fleet topology with a sliding inspector drawer](docs/screenshot.png)

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
/atlas nodes               # every node: kind, drift tag, health, address
/atlas drift               # what disagrees with the registry, and the reason
/atlas incidents           # open downtime + 24h fleet uptime
infra_bootstrap            # add frontmatter to an existing Markdown registry
infra_sweep                # discover + probe + diff
infra_query node_id=…      # read one entry (and unlock it for this session)
```

The same commands work from a shell, for an operator (or a cron job) that is not
inside a chat: `hermes atlas nodes`, `hermes atlas drift`, `hermes atlas show svc-litellm`.

No registry yet? `infra_bootstrap mode=scaffold_from_live` writes a starter directory from
what the collectors can actually see (this host, the Hermes runtime, and Proxmox or Headscale
when those are configured). To see the whole thing working without touching a real machine,
point `registry_path` at the fictional fleet in [`examples/registry`](examples/registry) and
run `infra_sweep` — six entries, documentation addresses only, one retiring and two failing
on purpose.

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
`INDEX.md` and prepends a `change-log.md` entry.

`kind` decides which terrace a node lands on, so an entry that sits in `servers/` but is
really a guest is corrected at parse time: **anything with a `vmid` — or a Proxmox guest with
a `parent_id` — is drawn as a VM on COMPUTE, not as metal on HARDWARE.** A hypervisor has no
vmid, so the test is safe both ways, and you never have to file entries in a different folder
to get the picture right.

`pitfalls` is surfaced in the guardrail
block message and in the outage brief, so the operator's hard-won rules reach the agent at
the moment they matter.

## Tools

| Tool | What it does |
|---|---|
| `infra_query` | Read a node (runbook + live diff + uptime + blast radius). Unlocks it for write/terminal use in this session. |
| `infra_sweep` | Run collectors + probes, recompute drift, evaluate incidents, attempt the safe local heal. |
| `infra_diff` | What changed, which incidents opened, who touched what — over a window. |
| `infra_upsert` | Create/update/adopt/remove a registry entry, with change-log. |
| `infra_bootstrap` | Annotate an existing KB, or scaffold one from live discovery. |
| `infra_incidents` | List/get/heal/resolve/escalate incidents; install the zero-token watchdog. `heal` runs the documented restart **through Hermes' command approval**. |
| `infra_credentials` | Private credential vault: list, get (gated), set/rotate, remove, and scan the KB for literals. |

Bundled skill: `infra-atlas:infra-atlas` (loaded automatically when the plugin is enabled).

## Text and CLI surface

The desktop page is one door; a chat is the other. `/atlas …` works in any
session (Desktop, CLI, Discord) and `hermes atlas …` works in a shell — same
commands, same store, same renderers (`atlas_cli.py`).

| Command | Answers |
|---|---|
| `status` | Node counts, guardrail/downtime policy, last sweep, fleet uptime, open incidents. Default. |
| `nodes [search] [--kind K] [--drift D] [--health H] [--limit N]` | The graph the last sweep fused: id, kind, drift tag, health, address, label. |
| `drift [--all]` | Only what disagrees with the registry, with the field-level reason. |
| `incidents [--all] [--limit N]` | Open downtime incidents (and, with `--all`, closed ones) plus fleet uptime. |
| `uptime [--limit N]` | 24h probe uptime, worst first, with the probe target. |
| `entries [search]` | The *documented* side: registry files on disk, their kind and status. |
| `show <node>` | One node: state, address, managed-by, probe, uptime, pitfalls, drift reasons, incidents. An ambiguous name returns the shortlist instead of "no match". |
| `cat <node>` | The registry entry itself, verbatim — the runbook the guardrail makes the agent read. |
| `activity [-n N]` | Recent agent activity against the graph (reads, allowed touches, blocked touches). |
| `creds` | Vault names, kinds and which entries reference them — never a value. |
| `sweep [--sources …]` | Run a live sweep, then print the new counts. The only command that touches the network. |

`nodes` and `entries` are deliberately two commands: `entries` is what the
registry *claims*, `nodes` is what the sweep *observed*. The difference between
them is the whole point of the tool.

A **partial** sweep reclassifies only what it saw: `sweep --sources kb` parses the
registry and probes nothing, so live-only nodes (agents, cron jobs, model
endpoints) fall back to `doc_only` until a full `sweep` runs again. Use the
narrow scope for registry edits, the full one before you trust the counts.

## Drift tags

Every node carries the sweep's verdict about its registry entry — not a health
reading. The page shows the tag on the node, in the inspector and in the legend;
`/atlas nodes` prints it as a column.

| Tag | Meaning |
|---|---|
| `matched` | The registry entry and reality agree: address, ports, unit, parent all match, and the probe answered. Nothing to do. |
| `changed` | Alive but different — an address, port, unit or parent the entry does not claim. Reconcile the entry or fix the node. |
| `unregistered` | Alive with no registry entry at all: undocumented infrastructure, invisible to the runbook and the guardrail. Adopt it. |
| `stale` | Documented as active, but nothing answers its probe. This is the "should be up and isn't" case that opens incidents. |
| `observed` | Seen on the tailnet only — no entry, nothing probed. Presence, not health. |
| `doc_only` | Nothing to probe: a project/story entry, or one retired from service. |

A health column sits beside it (`up` / `degraded` / `down` / `unknown`): a
`matched` node can still be `down` for a moment before the sweep reclassifies
it, and a `stale` node is `down` by construction.

## Settings

`registry_path`, `credentials_path` / `credentials_key_path` (see below),
`guardrail_mode` (`block`/`warn`/`off`), `auto_heal_mode`
(`notify_only` (default) / `auto` / `playbook_only` / `off`), `failure_threshold`, `heal_cooldown_sec`,
the three zero-config collectors, and the opt-in Proxmox/Headscale
credentials (secrets go to `.env` through Hermes and are read with `agent.secret_scope`).

`registry_path`, `credentials_path` and `credentials_key_path` all default to **empty**, which
means "under the active profile's data dir" (`ctx.state.data_dir`). Two profiles therefore never
share a vault or a registry. An existing `~/.hermes/infra-registry` keeps being used when it is
present, so upgrading changes nothing on disk.

## Credentials never live in the registry

The registry is documentation — it is read by agents, mirrored to Nextcloud and
committed to git, so a password in a runbook is a leak in triplicate. Entries
reference credentials by name:

```markdown
---
id: srv-cyberfield
kind: server
credentials: [cyberfield-pve-token, cyberfield-root-ssh]
---
```

The value lives in a private vault under `$HERMES_HOME/plugin-data/infra-atlas/`
(settings `credentials_path` / `credentials_key_path`), written through
`infra_credentials`:

- the file is `0600` in a `0700` directory and **Fernet-encrypted** with a `0600`
  key when `cryptography` is installed; without it the vault records
  `encrypted: false` rather than pretending,
- `action="list"` returns names, owners and stored/missing status — never values,
- `action="get"` returns one value, records the read in the activity ledger, and
  refuses unless the node's registry entry was read first,
- `action="set"` / `"remove"` require a `reason`, write `change-log.md`, and never
  echo the value back,
- `action="scan"` finds credential literals still sitting in the Markdown (masked
  previews only) so they can be migrated into the vault.

The dashboard exposes `GET /api/plugins/infra-atlas/credentials` (masked list).
Writes are agent-side only — the vault is never writable over HTTP.

## What it touches

- **Reads** the registry directory, `$HERMES_HOME/cron/jobs.json`, the Hermes config
  (read-only), `/proc/net/tcp`, and — only when configured — the Proxmox and Headscale
  APIs.
- **Writes** only inside the registry directory (entry files, `INDEX.md`, `change-log.md`)
  and its own SQLite database under the active profile's `plugin-data/infra-atlas/`.
  Every write path is validated: the node id must match `^[a-z0-9][a-z0-9._-]{0,63}$` and
  the resolved file must stay inside the registry root.
- **Runs commands** only for `recovery_cmd`, only on this host, and only when the command is
  exactly one allow-listed restart shape — `systemctl [--user] restart|start <unit>`,
  `service <unit> restart|start`, `docker compose restart|start|up [-d]` inside a
  registry-declared `project_path`, or `pct|qm start <vmid>`. Power-state verbs (`stop`,
  `disable`), `destroy`, `exec`, `podman run`, `docker compose down`, and anything carrying a
  shell metacharacter are refused.
- **Never executes a restart itself.** The command is dispatched through the host `terminal`
  tool, so Hermes' dangerous-command approval applies exactly as if the agent had typed it.
  A process with no approval channel — the cron watchdog, the dashboard backend — does not
  run restarts at all; it opens the incident and hands the agent the brief.
  `recovery_cmd` is therefore **not writable through `infra_upsert`**: it is an operator
  field in the registry entry.
- **`auto_heal_mode` defaults to `notify_only`** — record the incident and wake the agent.
  `auto` additionally lets the agent-side sweep attempt the allow-listed restart (still
  through approval); `playbook_only` never wakes the agent; `off` disables the response.
- **Blocks** mutating tool calls while the guardrail is in `block` mode; set it to `warn` or
  `off` to disable. Inspection is never blocked and never unlocks: `systemctl status|cat|show`,
  `journalctl`, `docker ps|logs|inspect`, `qm list`, `pvesh get`, `ip addr`, a plain `curl`/`wget`
  GET. A `-X POST`/`-d`/`--data` request, or any `systemctl start|stop|restart|reload|enable`,
  still requires the entry to have been read.
- **Passes a minimal environment** to every child process: `PATH`, `LANG`/`LC_ALL`,
  `SYSTEMD_PAGER`, plus `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` for `systemctl --user`.
  The agent's API keys and tokens are never inherited.

## Registry write gate

The knowledge base is deliberately **open** — it is the club's living runbook, not a
frozen document. What is enforced is the *route*: the files `infra_upsert` owns must be
written by `infra_upsert`, because a hand-edit skips frontmatter merging, the `INDEX.md`
refresh, the change-log entry and the `verified_at` bump, and the node table then drifts
from the files it claims to describe.

| Setting | Effect |
|---|---|
| `registry_write_gate: block` (default) | Veto `write_file` / `patch` / shell writes (`sed -i`, `tee`, `cat >`, `mv`, `rm`, inline `open(…,'w')`) targeting `servers/`, `services/`, `projects/` entries, `INDEX.md` or `change-log.md`. The refusal names `infra_upsert` and `infra_credentials`. |
| `registry_write_gate: warn` | Record the raw write in the activity ledger and allow it. |
| `registry_write_gate: off` | No gate. |

Scope is exactly what the tool owns. `plans/`, `conventions.md`, `LIVE-STATE.md`, the
CCDC channel tracker and its log directory, and anything outside the registry stay
hand-editable — a gate with no sanctioned exit is just an obstacle. Reads (`cat`, `grep`,
`ls`, `head`, `read_file`) are never affected, and the gate is independent of
`guardrail_mode`: disabling the read-before-touch guardrail does not disable it.

Writes through `~/hermes-kb/01-Infrastructure/infra-registry` are blocked too. That path
is a symlink to the registry root, kept so the backup mirror can see the tree — it is a
read address, never a write address. The gate resolves symlinks before matching, so the
alias is caught exactly like the real path.

### Rewriting a runbook

Appending can only grow an entry, so `replace_body=true` (with the full new text in
`markdown_body`) is the sanctioned path for a structural rewrite. The previous body is
written to `.rewrites/<entry>.bak-<timestamp>` first and named in the change-log entry,
so a bad rewrite is recoverable without git. `replace_body` without a body is refused
rather than blanking the runbook.

No telemetry, no network calls to anything not configured above.

## Layout

```
plugin.yaml          manifest (tools, hooks, settings)
__init__.py          register(ctx)
registry_kb.py       Markdown ↔ node model, atomic writer, change-log
credentials.py       private 0600 credential vault + registry literal scanner
collectors/          local host, Hermes runtime, Proxmox, Headscale, probes
fusion.py            correlation + drift classification + sweep
uptime.py            probes → incidents → playbook/agent response, watchdog script
matcher.py           tool call → nodes (IPs, units, VMIDs, paths)
hooks.py             pre_tool_call guardrail, post_tool_call activity
atlas_tools.py       the seven tools
dashboard/           FastAPI routes under /api/plugins/infra-atlas
desktop/plugin.js    full-page graph, inspector, statusbar chip, ::infra / ::drift cards
skills/infra-atlas/  the bundled protocol skill
tests/               pytest suite (registry, fusion, gate, uptime, collectors, API, registration)
```

## Tests

After a reload, the page tells you which bundle it is running:
`document.querySelector('.ia-root').dataset.build` in the desktop devtools. It is bumped on
every shipped change.

```bash
tools/check.sh                       # every gate: compile, syntax, 8 surfaces, gestures,
                                     # layout, manifest + catalog parity, pytest, coverage floor
PYTHONPATH=<hermes-agent checkout> python -m pytest
PYTHONPATH=<hermes-agent checkout> python -m coverage run --source=. --omit='tests/*,tools/*,desktop/*' -m pytest
python -m coverage report            # tools/check.sh fails under 75%
hermes plugins doctor .
hermes plugins validate .
```

The desktop half has its own check — it is loaded uncompiled by the app, so a bad
component only fails at render time:

```bash
node tools/render_smoke.mjs --modules /path/to/a/node_modules   # needs react + react-dom
```

It renders every registered surface (page, chip, both transcript cards) with
`react-dom/server` against a stubbed `@hermes/plugin-sdk`, fails on any crash,
and asserts that the page actually renders the isometric scene (platforms,
per-kind shapes, routed edges, packets). Eight of eight surfaces render on this
tree.

### The isometric topology

The page draws the fleet as a **terraced isometric diorama** (SVG, `viewBox`
pan/zoom — still selectable, keyboard-reachable and crisp at any zoom):

- One terrace per stratum (hardware → compute → services → agents), cascading
  downhill toward the viewer so dependency edges literally flow down the hill.
  Terrace fronts drop to the base plane and slope risers fuse them into one
  landmass.
- Every node kind is its own 3-D silhouette: server = LED-blinking rack,
  VM = tower with a scanning screen, LXC = tank whose liquid level tracks
  uptime, **container = corrugated cargo crate with doors**, service = pad,
  **inference server = low GPU chassis with two spinning fan discs and a heat
  shimmer**, project = plate, agent = hovering bot, model endpoint = orbiting
  orb, cron = clock with a rotating hand, peer = pyramid with ping rings.
  Health is a colored beacon; drift is a floating chip and an underglow.
- Container and inference silhouettes are **inferred**, not hand-filed: an entry
  managed by docker/podman/compose draws as a crate, and one that names a model
  server (llama-server, llama.cpp, vLLM, Ollama, SGLang, TensorRT-LLM, TGI,
  llama.cpp forks…) draws as a GPU rig — while its control plane (dashboard,
  control, proxy, metrics shim, router) stays a plain service. A probe that
  speaks the model API (`…/v1/models`, `…/v1/chat/completions`) is enough on its
  own, which is what puts a llama.cpp host labelled by its owner — "flash-8
  (Dipa's fedora box)" — on the inference tier instead of in the service rows.
- Edges are routed on the tile grid (A\* with footprint obstacles + congestion
  cost): parallel connections fan into side-by-side lanes, terrace steps are
  crossed squarely, and each relation has its own color, dash rhythm and a
  travelling packet dot.
- Micro-animations (entrance drop-in, LEDs, slosh, scanline, bob, orbit, flow),
  phase-shifted per node, suppressed on large fleets (see *Decoration is data*)
  and disabled under `prefers-reduced-motion`. Guardrail pulses keep their
  semantics: blocked
  calls shake the node with red ripples and scatter red packets along its
  edges; reads and allowed touches flash cyan/green.
- **Guests follow their hypervisor.** Within a terrace a node whose parent sits in a lower
  terrace sorts by the parent's position, so the VMs of a host land together in the same part
  of the grid as that host, ahead of unrelated nodes that happen to sort earlier.
- Tailnet peers report `up` when online and `unknown` when not: a laptop with the lid shut is
  not an outage, and eighteen red beacons would drown the fleet's real signal.
- Terraces pack **up to three rows deep** and the depth is chosen per tier: every row
  combination (at most 3⁴) is measured and the one closest to a 1.4:1 footprint wins, with
  the most compact packing breaking ties. A forty-service tier becomes 14×3 instead of a
  40-tile ribbon, so a big fleet reads as a block rather than a letterbox.

The page around it stays deliberately sparse:

- **One floating command bar** — brand + live 24h fleet uptime + sweep age, the view switcher
  (`Live` / `Alerts` / `Synced` / `All`), inline search, a single policy popover (guardrail
  mode, downtime response, background watchdog), and one primary `Sweep` action.
- **A slide-over inspector drawer** that only exists while a node is selected: one contextual
  primary action (`Adopt Live Drift` when it has drifted, `Run Playbook` when it is down), a
  symmetric secondary row (`Unlock Chat`, `Ask Hermes`), and three tabs — `Overview`
  (pitfalls callout, field-by-field diff, properties, clickable blast radius), `Uptime`
  (24h %, latency sparkline, probe target, incident history with inline resolve), `Runbook`.
  **`Ask Hermes` opens a new chat** and starts it with that node's brief — the state, the
  registry entry, the pitfalls and a mission matched to the node (inspect when it is healthy,
  reconcile when it has drifted, recover when it is down). It never pastes into whatever
  conversation happened to be focused, which from this page usually means no conversation at all.
- **Direct manipulation**: drag to pan (content follows the cursor), a mouse-wheel notch or
  trackpad pinch zooms around the pointer, two-finger trackpad scrolling pans, double-click
  zooms in (shift double-click out), and the `− 100% +` cluster resets or steps. The camera is
  owned imperatively — a drag survives the pointer crossing the toolbar, the drawer or the
  window edge, the `viewBox` is written inside a `requestAnimationFrame` while React state only
  syncs once the gesture settles, and labels freeze during motion so a hundred-node fleet pans
  at frame rate.
- **Both themes, by construction.** The diorama derives its whole palette from the two values
  the plugin host provides — `--card` (surface) and `--foreground` (ink): the ground is the
  card colour, node bodies are a card/ink mix tinted 14% with the kind's accent, terraces are
  the same mix with a tier tint, labels use the ink with a card-coloured halo. Nothing is
  hard-coded to one theme, so a light app gets light terraces and dark labels and a dark app
  gets the inverse, with contrast around 7:1 (dark) and 9:1 (light). A lightweight probe only
  tunes shadows and the glow.
- **Decoration is data.** Past ~44 nodes the canvas goes lean: perpetual LED/scan/packet
  animation is kept only for the selected node, nodes with incidents and their edges, and
  everything else holds still (and `prefers-reduced-motion` wins everywhere).
- **Two corner docks**: a collapsible live-activity feed (reads / touches / blocked calls) and
  a combined zoom + legend control. `Esc` or a click on empty canvas closes the drawer and
  gives the whole viewport back to the map.
- **Retired entries stay off the map.** An entry with `status: removed` is history, not
  infrastructure: it is not drawn as an empty shape, not probed, and not counted in the
  `All` badge (the legend says how many are hidden). Opening one anyway — a stale selection,
  a `::infra{}` link — explains that it is retired and offers **Restore to active**, instead
  of showing a panel full of empty fields.

To see it live without the desktop app:

```bash
node tools/iso_preview.mjs            # then open the printed URL
# ?fleet=stub | live | single | flat — the control bar can fire guardrail pulses so you
# can watch the shake/ripple animations.
```

MIT.
