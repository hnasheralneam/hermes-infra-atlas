# Registry access audit — tool-traffic vs direct-path traffic

Questions like "is everyone actually going through the atlas tools, or still
hitting the registry files directly?" are answered from two SQLite stores, not
from memory:

## 1. Which unlock path sessions use (`atlas.db`)

```sql
sqlite3 ~/.hermes/plugin-data/infra-atlas/atlas.db \
 "select date(read_at,'unixepoch') d,
    sum(read_via='read_file') rf, sum(read_via='infra_query') iq
  from session_reads group by 1 order by 1 desc;"
```

`session_reads.read_via` is the ground truth for unlocks: `infra_query`,
`read_file` (file read ≡ unlock), `desktop`, `watchdog`, `infra_upsert`. A high
`rf` share is NOT a violation — the guardrail accepts both — but it shows where
the traffic lives.

## 2. Direct file traffic per day (`state.db` messages)

```sql
sqlite3 ~/.hermes/state.db \
 "select date(timestamp,'unixepoch') d,
    sum(tool_calls like '%infra_query%' or tool_calls like '%infra_sweep%' or tool_calls like '%infra_upsert%' or tool_calls like '%infra_diff%' or tool_calls like '%infra_incidents%' or tool_calls like '%infra_credentials%') atlas_calls,
    sum(tool_calls like '%infra-registry%') registry_path_calls
  from messages where role='assistant' and tool_calls is not null group by 1 order by 1 desc limit 25;"
```

Parse `tool_calls` JSON in Python for the exact split (terminal grep/cat vs
read_file vs patch/write registry writes vs `tool_call`-wrapped atlas tools).
Join session `source` from the `sessions` table to find WHERE the direct
traffic concentrates: cron and subagent sessions have the tools restricted, so
direct-path traffic from them is expected, not drift.

## 3. Guardrail effectiveness (`activity_ledger`)

```sql
select date(ts,'unixepoch') d, action_kind, sum(blocked) blocked, count(*) n
  from activity_ledger group by 1,2 order by 1 desc;
```

`touch_blocked` rows prove the gate is enforcing (sessions getting vetoed until
they read); `touch_allowed` is the accepted-touch stream. Ledger retention is
`history_retention_days` (pruned at sweep end); incidents are never pruned.

## Interpretation

- Coverage = registry access RECORDED in the ledger (any via), not "calls that
  used the tool names." The markdown is the API; the tool is one route to it.
- Before calling traffic "old-style," confirm the sessions doing it don't have
  the atlas tools in their toolset (cron profiles, delegation children).
