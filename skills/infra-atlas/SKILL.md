---
name: infra-atlas
description: "Infrastructure protocol: read the registry before touching a host, keep it current, audit drift, and respond to outages."
version: 1.0.0
metadata:
  hermes:
    tags: [infrastructure, registry, topology, uptime, drift]
---

# Infra Atlas — infrastructure protocol

You are operating against documented infrastructure. `infra-atlas` enforces the
club doctrine in code: **read before you touch, write what you changed, never
guess, and heal what you can prove is down.**

## 1. Read before you touch (mandatory)

`pre_tool_call` **blocks** any `terminal`, `write_file` or `patch` call that
touches a registered host, VM, container, IP, systemd unit or project path when
the session has not read that node's registry entry.

To unlock a node:

- `infra_query(node_id="svc-litellm")` — returns the runbook, live health, drift
  state, uptime, incidents and blast radius, **and unlocks the node**; or
- `read_file` on `services/litellm.md` (or `servers/…`, `projects/…`).

Reading `INDEX.md` alone does **not** unlock individual entries. The gate also
matches **local file paths under a registered node** — an ssh command that
references `~/.hermes/secrets/…` is blocked because that path sits on
`srv-bossagent-home`, so read the node the *path* belongs to, not only the
remote host you are dialing. If a call is blocked, do exactly what the message
says, then retry the same command. Unlocks are **family-wide** (since 5e1d6b7):
one read of a node also unlocks its parent host, its children and address-mates —
no need to query a whole rack to touch one box.

## 2. Never trust stale docs alone

- `infra_sweep` — discover reality (local systemd/Docker/Tailscale, Hermes
  runtime, Proxmox, Headscale), probe health, recompute drift.
- `infra_diff(since="24h")` — what changed, which incidents opened, who touched
  what.
- To audit who is going through the tools vs the file paths (and whether the
  guardrail is actually biting), run the queries in
  `references/access-audit.md` against `atlas.db` + `state.db`.

**Retiring a file the tools write (e.g. removing change-log.md): kill every
writer before deleting the file.** `infra_upsert`/incident-resolve paths
re-create anything their code names — deleting the file alone means the next
upsert resurrects it. The retirement pass is: patch the plugin writer to
no-op-when-absent, drop the file from the gate's owned list, remove it, THEN
sweep references from skills/registry/docs. Config edits to gate modes take
effect for NEW sessions only (the running gateway keeps its in-memory module),
and `guardrail_mode` and `registry_write_gate` are separate knobs — a
read-unlock failure is the first, a write veto is the second. To bulk-remove
references from files, distinguish procedural mentions ("append a change-log
entry" — must be rewritten) from historical citations ("see change-log
2026-xx-xx" — repoint to `infra_diff`/session history); never rewrite history
narrative into a lie, and rescue any LIVE-only content (matrices, decisions)
from the doomed file first — grab it from the Nextcloud mirror inside the
30-min sync window before it gets pruned.

Drift states: `matched` (docs == reality), `changed` (alive but different — IP,
port, unit, parent), `unregistered` (alive, no entry), `stale` (documented
active, nothing answers), `doc_only` (nothing to probe).

## 3. Keep the registry current in the same turn

After deploying, moving or reconfiguring anything, call `infra_upsert` in that
same turn (`reason` is required and lands in the activity ledger). Use
`action="adopt_live"` for a node the sweep reported as `unregistered`, and
`action="mark_removed"` when something is gone for good. Frontmatter is merged;
the runbook prose is preserved.

**The registry is open — but only through this tool.** A `write_file`, `patch`
or shell write (`sed -i`, `tee`, `cat >`, `mv`, `rm`) aimed at an entry under
`servers/`, `services/`, `projects/`, or at `INDEX.md` is vetoed by the registry
write gate (`registry_write_gate: block|warn|off`; mechanics:
`references/registry-write-gate.md`). A hand-edit skips frontmatter
merging, the INDEX refresh, the ledger record and the `verified_at` bump, so the
node table and the files drift apart. The gate covers only the files this tool
owns: `conventions.md`, `LIVE-STATE.md`, tracker files and log directories stay
hand-editable, because there is no tool path for them.

There is **no journal file**: `change-log.md` and `plans/` are retired. Change
history lives in the activity ledger (`infra_diff` / desktop overlay), standing
decisions live in the relevant node entry, and older narrative is recovered from
session history. Never create or append to a registry journal.

Useful fields: `probe` (http URL or `tcp://host:port` for uptime),
`auto_heal_policy` (`auto` | `playbook_only` | `notify_only` | `off`), and
`pitfalls` (surfaced to the guardrail and to the outage responder).

`recovery_cmd` is **not** writable through `infra_upsert` — it names a command the
plugin can run, so it is an operator field in the registry entry. If a node needs a
restart playbook, tell the operator what command to add rather than writing it
yourself.

**Rewriting a runbook.** Appending can only grow an entry, so a structural
rewrite — shortening, reordering, replacing a stale runbook wholesale — needs
`replace_body=true` with the complete new text in `markdown_body`. The previous
body is archived under `.rewrites/` and the write recorded in the ledger, so a bad
rewrite is recoverable without git. There is no reason to hand-edit an entry:
`replace_body` covers every case the append-only rule refuses.

**Get the node id from the registry, never construct it.** `infra_upsert` derives
the file path from the `kind` you pass, so a guessed id silently creates a
*second* entry instead of updating the real one — and the write gate then refuses
the `rm` that would clean it up. Resolve the id first: `infra_query` on a slug,
`hermes atlas nodes <search>`, or read the `id:` line of the entry's frontmatter.
A `proj-`/`svc-`/`srv-` prefix you invented is not the id. If you do create a
stray, `infra_upsert(action="mark_removed")` tombstones it (`status: removed`)
— that is the sanctioned cleanup, not an `rm`.

**Never write through `~/hermes-kb/`.** `~/hermes-kb/01-Infrastructure/infra-registry`
is a symlink to the registry root, kept so the backup mirror can see it. It is a
legitimate *read* address and never a write address — the gate recognises it as
the registry and blocks writes through it just as it blocks the real path.

## 4. Credentials live in the vault, never in the registry

The registry is documentation: agents read it, it is mirrored to Nextcloud every
30 minutes and it is in git. A credential in a runbook is a leak waiting for a
backup.

- An entry **references** a credential by name in frontmatter:
  `credentials: [cyberfield-pve-token, cyberfield-root-ssh]`.
- The value lives in the private vault (`<profile data dir>/credentials.json`,
  0600, Fernet-encrypted with a 0600 key beside it) through
  `infra_credentials`:

```
infra_credentials(action="list")                 # names, owners, stored/missing — no values
infra_credentials(action="get", name="…")        # the one value; read the entry first
infra_credentials(action="set", name="…", value=…, node_id="…", kind="ssh-password", reason="…")
infra_credentials(action="remove", name="…", reason="…")
infra_credentials(action="scan")                 # literals still sitting in the KB
```

Rules:

- Never paste a value into a registry entry, a skill, a commit or a chat log.
  When you find one (`action="scan"`), store it, add the `credentials:` reference,
  then delete the literal from the prose.
- `action="get"` obeys the same read-before-touch gate: read the entry first.
- `set` requires `reason` (recorded in the activity ledger)
  and never echoes the value back.
- Rotation is a vault write plus `rotate=true`; nothing else in the KB changes.

## 5. Outages

- `infra_incidents(action="list")` — open incidents + 24h fleet uptime.
- `infra_incidents(action="get", incident_id=N)` — the remediation brief.
- `infra_incidents(action="heal", node_id=…)` — run the deterministic local
  restart and verify with a probe.
- `infra_incidents(action="resolve", incident_id=N, summary="cause + fix")` —
  close it; the summary is recorded in the ledger.
- `infra_incidents(action="setup_watchdog")` — install the zero-token background
  watchdog (Hermes cron pre-check that only wakes the agent when something is
  down).

**Watchdog reporting is throttled** (4h re-alert window, resolutions once; the
`uptime.changelog_gate` coalesces repeat open→resolve flaps per node into one
ledger line). The watchdog script itself is generated by
`infra_incidents(action="setup_watchdog")` — regenerate, never hand-edit; it is
safe to overwrite.

When the watchdog wakes you, its brief already names the node, the failed probe,
the parent host's state, the managed-by rule and the pitfalls. Follow it:
`infra_query` → diagnose → remediate → `infra_sweep` to verify → `resolve`.

## 5a. Wiring and internals that affect how you work the plugin

- **Guardrail/plugin config is bound at session wiring.** Flipping
  `plugins.entries.infra-atlas.settings.*` in config.yaml (e.g. a temporary
  `guardrail_mode: warn` window for an authorized bulk edit) has NO effect in
  the current session — the hooks module and config snapshot are per-process.
  A fresh session or a spawned subagent picks up both the new config and
  re-imported plugin code; that is the sanctioned way to act under changed
  settings. The in-process gate cannot be talked around with relative paths —
  normalization catches them.
- **A compound shell command is classified as a whole**: one write verb (`rm`,
  `sed -i`) anywhere in a command that also mentions node files turns the
  read-only parts into a vetoed touch. Keep deletion/cleanup commands free of
  path mentions they do not act on.
- **`session_reads.read_via` is the audit column** for "path vs tool" access;
  cross-check against `state.db` `messages.tool_calls` JSON for direct
  terminal/read_file traffic the ledger may log under a different shape.
- **History tables have no time retention yet** — `probe_samples` dominates
  growth (thousands of rows/day at multi-node scale; watch `atlas.db` size and
  WAL). If asked about bloat, propose a `history_retention_days` prune at the
  end of the watchdog sweep rather than manual DELETEs.
- Registry markdown IS the API: `infra_query` returns the entry text freshly
  read from disk, and `read_file` on a node file unlocks identically to
  `infra_query`. Do not campaign agents to route traffic through the tools —
  enforce attribution via the ledger instead.

## 6. Chat directives (Hermes Desktop)

Emit these alone on their own line to render live cards in the transcript:

```
::infra{id="svc-litellm"}
::drift{}
```

## 7. Changing the gate or the protocol itself

The gate is plugin code, not prose. A rule that lives only in a skill is a
suggestion; a rule in `hooks.py`/`matcher.py` holds regardless of model, skill or
session. When asked to make agents behave differently around the registry, change
the code and prove it with a test — don't just edit skill text.

- **Plan before you build.** A question like "what's the best way to achieve
  this?" is a request for the plan, not the implementation. Present the plan,
  name the open decisions, and wait for the go-ahead — especially for
  infra-changing work on the club's own tooling.
- **Place the gate before any early return.** The registry write veto runs
  *before* the `guardrail_mode == "off"` check, because the two answer different
  questions: the read-before-touch gate protects *hosts*, the write gate protects
  the KB's single writer. Put it after that return and it silently disables
  itself whenever the host guardrail is off — which is exactly when someone is
  doing bulk work.
- **A gate with no sanctioned exit is an obstacle.** Cover only the files
  `infra_upsert` owns (`servers/`, `services/`, `projects/` entries, `INDEX.md`,
  `change-log.md`). `plans/`, `conventions.md`, `LIVE-STATE.md`, tracker files and
  log dirs have no tool path — leave them hand-editable, or agents route around
  the gate and the rule stops meaning anything.
- **You cannot verify your own hook edit from the session that made it.** The
  plugin is imported once per process, so the running session keeps executing the
  code it loaded at start. A probe run from that same session tests stale code
  and will "pass" or "fail" misleadingly. Prove a change in a *fresh* process,
  then reload the gateway for it to take effect.
- **Resolve paths before comparing them.** The shell-write matcher compares string
  prefixes, so a symlinked alias of the registry escapes it: `write_file`/`patch`
  through the alias are caught (realpath'd), `sed -i`/`tee` through it are not.
  Every alias path (`~/hermes-kb/01-Infrastructure/infra-registry` and friends)
  must be realpath-resolved into the accepted-prefix set.

## 7. Internals that matter when auditing compliance

- **The markdown registry is the source of truth.** `infra_query` returns the entry
  text read fresh from disk; the sqlite graph is an index re-parsed from the wiki on
  every sweep. Direct `read_file`/`patch` on registry files is therefore the same
  data — never treat path access as a bypass or "leakage" of the tool API.
- **Hooks fire in every process** (discord, cron, subagent, oneshot) even where the
  plugin's *tools* are not exposed to the model. A session that never calls
  `infra_query` can still be fully guardrailed — check the ledger before concluding
  a surface bypasses atlas.
- **Ground truth for access audits:** `~/.hermes/plugin-data/infra-atlas/atlas.db`
  — `activity_ledger` (every read_doc / touch_allowed / touch_blocked event, per
  session; aggregate per day with `date(ts,'unixepoch')`) and `session_reads`
  (`read_via` splits unlocks into `read_file` vs `infra_query`). Cross-reference
  session ids against `sessions.source` in `~/.hermes/state.db` to attribute usage
  gaps by surface. sqlite timestamps need the `'unixepoch'` modifier; parse
  `messages.tool_calls` with python sqlite3+json, not piped CLI line output.

## 7. Changing the gate or the protocol itself

The gate is plugin code, not prose. A rule that lives only in a skill is a
suggestion; a rule in `hooks.py`/`matcher.py` holds regardless of model, skill or
session. When asked to make agents behave differently around the registry, change
the code and prove it with a test — don't just edit skill text.

- **Plan before you build.** A question like "what's the best way to achieve
  this?" is a request for the plan, not the implementation. Present the plan,
  name the open decisions, and wait for the go-ahead — especially for
  infra-changing work on the club's own tooling.
- **Place the gate before any early return.** The registry write veto runs
  *before* the `guardrail_mode == "off"` check, because the two answer different
  questions: the read-before-touch gate protects *hosts*, the write gate protects
  the KB's single writer. Put it after that return and it silently disables
  itself whenever the host guardrail is off — which is exactly when someone is
  doing bulk work.
- **A gate with no sanctioned exit is an obstacle.** Cover only the files
  `infra_upsert` owns (`servers/`, `services/`, `projects/` entries, `INDEX.md`).
  `conventions.md`, `LIVE-STATE.md`, tracker files and
  log dirs have no tool path — leave them hand-editable, or agents route around
  the gate and the rule stops meaning anything.
- **You cannot verify your own hook edit from the session that made it.** The
  plugin is imported once per process, so the running session keeps executing the
  code it loaded at start. A probe run from that same session tests stale code
  and will "pass" or "fail" misleadingly. Prove a change in a *fresh* process,
  then reload the gateway for it to take effect.
- **Resolve paths before comparing them.** The shell-write matcher compares string
  prefixes, so a symlinked alias of the registry escapes it: `write_file`/`patch`
  through the alias are caught (realpath'd), `sed -i`/`tee` through it are not.
  Every alias path (`~/hermes-kb/01-Infrastructure/infra-registry` and friends)
  must be realpath-resolved into the accepted-prefix set.

## 7. Internals that matter when auditing compliance

- **The markdown registry is the source of truth.** `infra_query` returns the entry
  text read fresh from disk; the sqlite graph is an index re-parsed from the wiki on
  every sweep. Direct `read_file`/`patch` on registry files is therefore the same
  data — never treat path access as a bypass or "leakage" of the tool API.
- **Hooks fire in every process** (discord, cron, subagent, oneshot) even where the
  plugin's *tools* are not exposed to the model. A session that never calls
  `infra_query` can still be fully guardrailed — check the ledger before concluding
  a surface bypasses atlas.
- **Ground truth for access audits:** `~/.hermes/plugin-data/infra-atlas/atlas.db`
  — `activity_ledger` (every read_doc / touch_allowed / touch_blocked event, per
  session; aggregate per day with `date(ts,'unixepoch')`) and `session_reads`
  (`read_via` splits unlocks into `read_file` vs `infra_query`). Cross-reference
  session ids against `sessions.source` in `~/.hermes/state.db` to attribute usage
  gaps by surface. sqlite timestamps need the `'unixepoch'` modifier; parse
  `messages.tool_calls` with python sqlite3+json, not piped CLI line output.
