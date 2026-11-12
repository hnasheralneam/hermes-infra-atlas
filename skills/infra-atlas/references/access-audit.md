# Access audit — who touched the registry, read or write

Everything the agents do against registered infrastructure lands in the
`activity_ledger` table of `atlas.db` (plugin data dir). The retired
`change-log.md` (pre 2026-11-12) was a hand-written journal; the ledger is its
automatic, complete replacement.

## Read it
- `infra_diff` — drift transitions + incidents + ledger entries over a window
  (the normal "what changed / who touched what" question).
- Raw sqlite (`mode=ro` to avoid writer contention):
  ```
  sqlite3 "file:~/.hermes/plugin-data/infra-atlas/atlas.db?mode=ro" \
    "select datetime(ts,'unixepoch','localtime') t, session_id, tool_name,
            node_id, action_kind, blocked, substr(summary,1,80)
     from activity_ledger order by ts desc limit 50;"
  ```
- `session_reads` — per-session unlock map (`read_via` = `infra_query`,
  `read_file`, `watchdog`, …): who was allowed to touch a node and how they
  earned it.

## Action kinds
`read_doc` (unlock, via file read or `infra_query`), `touch_allowed` /
`touch_blocked` / `touch_warned` (guarded ops), `registry_write_warned`
(raw write under a warn window), `credential_read`, `incident_opened`.

## Standard questions
- **Coverage of registry access:** join ledger sessions against
  `state.db` sessions; direct `read_file` unlocks are LEGAL (equivalence by
  design) — "going through the tool" is a style metric, not a compliance one.
- **Attribution of a file change:** `args_preview` + `session_id` on
  touch/write events; the curator ledger (`skills/.curator_ledger.jsonl`) is
  for SKILL.md, not the registry.
- **Guardrail health:** blocked-vs-allowed ratio per day; a day of blocks
  with zero follow-on `read_doc` for the same node = an agent gave up —
  surface it.
- **Staleness:** retention is `history_retention_days` (default 90, pruned at
  each sweep end; incidents never pruned). Older than the window → session
  history (`session_search`) still holds the narrative.

## Caveats
- A process running pre-patch plugin code (long-lived gateway before a
  disable/enable cycle) writes with the old event vocabulary.
- The watchdog session id is `cron-watchdog`; children show their own session
  ids — map via `state.db` `sessions.source`.
