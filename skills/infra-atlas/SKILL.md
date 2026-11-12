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

Reading `INDEX.md` alone does **not** unlock individual entries. If a call is
blocked, do exactly what the message says, then retry the same command.

## 2. Never trust stale docs alone

- `infra_sweep` — discover reality (local systemd/Docker/Tailscale, Hermes
  runtime, Proxmox, Headscale), probe health, recompute drift.
- `infra_diff(since="24h")` — what changed, which incidents opened, who touched
  what.

Drift states: `matched` (docs == reality), `changed` (alive but different — IP,
port, unit, parent), `unregistered` (alive, no entry), `stale` (documented
active, nothing answers), `doc_only` (nothing to probe).

## 3. Keep the registry current in the same turn

After deploying, moving or reconfiguring anything, call `infra_upsert` in that
same turn (`reason` is required and becomes the change-log entry). Use
`action="adopt_live"` for a node the sweep reported as `unregistered`, and
`action="mark_removed"` when something is gone for good. Frontmatter is merged;
the runbook prose is preserved.

**The registry is open — but only through this tool.** A `write_file`, `patch`
or shell write (`sed -i`, `tee`, `cat >`, `mv`, `rm`) aimed at an entry under
`servers/`, `services/`, `projects/`, or at `INDEX.md` / `change-log.md` is
vetoed by the registry write gate (`registry_write_gate: block|warn|off`). A
hand-edit skips frontmatter merging, the INDEX refresh, the change-log entry and
the `verified_at` bump, so the node table and the files drift apart. The gate
covers only the files this tool owns: `plans/`, `conventions.md`,
`LIVE-STATE.md`, tracker files and log directories stay hand-editable, because
there is no tool path for them.

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
body is archived under `.rewrites/` and named in the change-log entry, so a bad
rewrite is recoverable without git. There is no reason to hand-edit an entry:
`replace_body` covers every case the append-only rule refuses.

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
- `set` requires `reason` (written to the activity ledger and `change-log.md`)
  and never echoes the value back.
- Rotation is a vault write plus `rotate=true`; nothing else in the KB changes.

## 5. Outages

- `infra_incidents(action="list")` — open incidents + 24h fleet uptime.
- `infra_incidents(action="get", incident_id=N)` — the remediation brief.
- `infra_incidents(action="heal", node_id=…)` — run the deterministic local
  restart and verify with a probe.
- `infra_incidents(action="resolve", incident_id=N, summary="cause + fix")` —
  close it and write the postmortem into `change-log.md`.
- `infra_incidents(action="setup_watchdog")` — install the zero-token background
  watchdog (Hermes cron pre-check that only wakes the agent when something is
  down).

When the watchdog wakes you, its brief already names the node, the failed probe,
the parent host's state, the managed-by rule and the pitfalls. Follow it:
`infra_query` → diagnose → remediate → `infra_sweep` to verify → `resolve`.

## 6. Chat directives (Hermes Desktop)

Emit these alone on their own line to render live cards in the transcript:

```
::infra{id="svc-litellm"}
::drift{}
```
