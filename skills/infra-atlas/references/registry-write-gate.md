# The registry write gate (single-writer enforcement)

**Config:** `registry_write_gate` — `block` (default) / `warn` / `off`.
Checked in `pre_tool_call` **before** the `guardrail_mode` return: the two
answer different questions — the read-before-touch gate protects *hosts*, the
write gate protects the KB's single writer. Put after that return and it
silently disables whenever the host guardrail is off — exactly when someone is
doing bulk work. (Regression order matters: `hooks.on_pre_tool_call` evaluates
the gate first, on purpose.)

## What it owns
Exactly what `infra_upsert` owns: entry files under `servers/`, `services/`,
`projects/` (matched via each node's `registry_path`), plus `INDEX.md`
(`REGISTRY_OWNED_FILES`). A raw `write_file` / `patch` / `terminal` write
(`sed -i`, `tee`, `cat >`, `mv`, `rm`, inline `open(…,'w')`) against one of
those is vetoed with a message naming `infra_upsert`.

Everything else stays hand-editable — `conventions.md`, `LIVE-STATE.md`,
tracker files and log dirs have no sanctioned tool path, and a gate with no
exit is just an obstacle agents route around.

`change-log.md` was **retired 2026-11-12** and is no longer in the owned set.
While it existed it was a genuine one-way door: an agent-side `rm` of a
tool-owned file is vetoed, so retiring it required patching the owned-file
tuple AND the writers together.

## Why the route matters
A hand-edit skips frontmatter merging, the `INDEX.md` refresh, the ledger
record and the `verified_at` bump, so the node table drifts from the files it
claims to describe. `infra_upsert` does all four atomically and accepts
`replace_body=true` as the sanctioned shortening path (previous body archived
under `.rewrites/`, recorded in the activity ledger; append-only ops that
would shrink an entry are refused).

## Operating it
- Blocked mid-flow? Do the write via `infra_upsert` (preferred), or read the
  named entry and — if the edit genuinely has no tool path — ask the operator
  to toggle `registry_write_gate: warn` for the one-off, then unset it.
  Warn mode still records every raw write (`registry_write_warned`), so the
  audit trail survives the exception.
- Credential values never ride through either route — `infra_credentials`.
- `verified_at`/status semantics: see SKILL.md §infra_upsert.
