"""SQLite-backed graph, drift history, uptime samples and incident store.

One connection per process (``plugin_db`` opens WAL with
``check_same_thread=False``) guarded by a re-entrant lock: tool handlers, hooks
and the FastAPI routes all reach this store from different threads.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = "infra-atlas"

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    stratum INTEGER NOT NULL DEFAULT 2,
    label TEXT NOT NULL,
    parent_id TEXT,
    host_ip TEXT,
    tailnet_ip TEXT,
    vmid INTEGER,
    ports_json TEXT NOT NULL DEFAULT '[]',
    managed_by TEXT,
    systemd_unit TEXT,
    project_path TEXT,
    registry_path TEXT,
    registry_mtime REAL,
    registry_hash TEXT,
    pitfalls_summary TEXT,
    recovery_cmd TEXT,
    probe TEXT,
    probe_inferred INTEGER NOT NULL DEFAULT 0,
    auto_heal_policy TEXT NOT NULL DEFAULT 'inherit',
    doc_state_json TEXT NOT NULL DEFAULT '{}',
    live_state_json TEXT NOT NULL DEFAULT '{}',
    drift_status TEXT NOT NULL DEFAULT 'matched',
    drift_reasons_json TEXT NOT NULL DEFAULT '[]',
    health_status TEXT NOT NULL DEFAULT 'unknown',
    latency_ms REAL,
    uptime_24h_pct REAL DEFAULT 100.0,
    failure_streak INTEGER NOT NULL DEFAULT 0,
    last_heal_attempt_at REAL,
    last_seen_live_at REAL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'doc',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at REAL NOT NULL,
    PRIMARY KEY (source_id, target_id, relation)
);

CREATE TABLE IF NOT EXISTS probe_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms REAL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_probe_samples_node_ts ON probe_samples(node_id, ts DESC);

CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    node_label TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at REAL NOT NULL,
    resolved_at REAL,
    failure_count INTEGER NOT NULL DEFAULT 1,
    trigger_error TEXT NOT NULL,
    root_cause_hint TEXT,
    heal_attempts INTEGER NOT NULL DEFAULT 0,
    last_heal_action TEXT,
    resolution_summary TEXT,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, started_at DESC);

CREATE TABLE IF NOT EXISTS session_reads (
    session_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    read_via TEXT NOT NULL,
    read_at REAL NOT NULL,
    PRIMARY KEY (session_id, node_id)
);

CREATE TABLE IF NOT EXISTS activity_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    node_id TEXT,
    action_kind TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL,
    args_preview TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sweeps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    duration_ms INTEGER NOT NULL,
    sources_json TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sweep_id INTEGER NOT NULL,
    ts REAL NOT NULL,
    node_id TEXT NOT NULL,
    node_label TEXT NOT NULL,
    prev_drift TEXT,
    new_drift TEXT NOT NULL,
    field_diffs_json TEXT NOT NULL,
    evidence TEXT NOT NULL
);
"""

# Fields a drift comparison looks at, in report order.
DRIFT_FIELDS = ("host_ip", "tailnet_ip", "ports", "parent_id", "systemd_unit", "managed_by", "health_status")

_JSON_FIELDS = ("ports_json", "doc_state_json", "live_state_json", "drift_reasons_json")


def _now() -> float:
    return time.time()


def _json(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _row_to_node(row: sqlite3.Row) -> dict[str, Any]:
    node = dict(row)
    node["ports"] = _json(node.get("ports_json"), [])
    node["doc_state"] = _json(node.get("doc_state_json"), {})
    node["live_state"] = _json(node.get("live_state_json"), {})
    node["drift_reasons"] = _json(node.get("drift_reasons_json"), [])
    node["probe_inferred"] = bool(node.get("probe_inferred"))
    for key in _JSON_FIELDS:
        node.pop(key, None)
    return node


class AtlasStore:
    """Thread-safe facade over the plugin database."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._bulk = False
        # Hooks read through their own read-only connection: in WAL a reader never
        # waits on a writer, so a running sweep cannot stall the guardrail.
        self._ro_conn: Optional[sqlite3.Connection] = None
        self._ro_lock = threading.RLock()  # list_nodes_ro re-enters _readonly_conn
        self._db_path: str = ""

    def _commit(self) -> None:
        if not self._bulk:
            self._commit_with_retry()

    def _commit_with_retry(self) -> None:
        """Commit, and never leave a half transaction holding the write lock.

        A commit can fail with SQLITE_BUSY while another process is writing. The
        transaction then stays open — and an open transaction in this process makes
        every other Hermes process wait the full busy timeout on every statement.
        Retry briefly, then roll back so the lock is released either way.
        """
        delay = 0.05
        for attempt in range(4):
            try:
                self.conn.commit()
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 3:
                    try:
                        self.conn.rollback()
                    except sqlite3.Error:
                        pass
                    raise
            time.sleep(delay)
            delay = min(delay * 2, 1.5)

    def _run(self, sql: str, params: Any = ()) -> sqlite3.Cursor:
        """Execute one statement, waiting out a peer's lock instead of failing.

        Several Hermes processes share this database. ``busy_timeout`` covers a
        peer that is mid-write; the retry (and the rollback that releases whatever
        half-transaction we were in) covers a peer that left a long write open.
        """
        delay = 0.05
        for attempt in range(4):
            with self._lock:
                try:
                    cursor = self.conn.execute(sql, params)
                    # Never leave an implicit transaction open: a half-open
                    # transaction in one Hermes process blocks every other one.
                    if not self._bulk and self.conn.in_transaction:
                        self._commit_with_retry()
                    return cursor
                except sqlite3.IntegrityError:
                    raise  # a duplicate is a caller concern: the transaction stays usable
                except sqlite3.OperationalError as exc:
                    locked = "locked" in str(exc).lower()
                    # A failed statement abandons the batch: release the lock and the
                    # bulk flag so the process cannot sit on an open transaction.
                    self._bulk = False
                    try:
                        self.conn.rollback()
                    except sqlite3.Error:
                        pass
                    if not locked or attempt == 3:
                        raise
            time.sleep(delay)
            delay = min(delay * 2, 1.5)
        raise RuntimeError("unreachable")

    def begin_bulk(self) -> None:
        """One transaction for a whole sweep (node writes + probe samples + edges).

        It starts with ``BEGIN IMMEDIATE`` so the sweep owns the write lock for
        its whole duration: a peer that writes concurrently (the gateway logging
        tool activity, another session's sweep) waits at its own BEGIN instead of
        stealing the lock between two statements here.
        """
        delay = 0.05
        for attempt in range(4):
            with self._lock:
                try:
                    if not self.conn.in_transaction:
                        # Raw execute: _run would auto-commit the BEGIN it just issued.
                        self.conn.execute("BEGIN IMMEDIATE")
                    self._bulk = True
                    return
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc).lower() or attempt == 3:
                        raise
            time.sleep(delay)
            delay = min(delay * 2, 1.5)

    def end_bulk(self) -> None:
        with self._lock:
            self._bulk = False
            # A failed commit here would strand the transaction (and the write
            # lock) for the life of the process, so it retries and rolls back.
            self._commit_with_retry()

    # -- connection -----------------------------------------------------
    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            with self._lock:
                if self._conn is None:
                    from plugins.plugin_storage import plugin_db

                    conn = plugin_db(PLUGIN_ID, filename="atlas.db")
                    conn.row_factory = sqlite3.Row
                    # Autocommit: a statement can never leave an implicit transaction
                    # open. Bulk sweeps begin one explicitly (BEGIN IMMEDIATE), and a
                    # forgotten commit used to lock the database for every Hermes
                    # process until it restarted.
                    conn.isolation_level = None
                    self._conn = conn
                    self._init_schema()
        return self._conn

    def _readonly_conn(self) -> sqlite3.Connection:
        with self._ro_lock:
            if self._ro_conn is None:
                # Touching self.conn opens the database and records its path; the
                # hot path may be the first thing that runs in this process, so it
                # must not depend on someone else having initialised the store.
                _ = self.conn
                path = self._db_path
                if not path:
                    raise sqlite3.OperationalError("no database file to open read-only")
                conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.2, check_same_thread=False)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA busy_timeout=200")
                self._ro_conn = conn
            return self._ro_conn

    def list_nodes_ro(self) -> list[dict[str, Any]]:
        """Nodes for hot paths (hooks): never blocks behind a writer, never raises."""
        try:
            with self._ro_lock:
                rows = self._readonly_conn().execute("SELECT * FROM nodes").fetchall()
            return [_row_to_node(row) for row in rows]
        except sqlite3.Error as exc:
            # Fail open: the hook calling this would rather have an empty graph
            # (nothing to block) than block the agent on a busy database.
            logging.getLogger(__name__).debug("infra-atlas: read-only node read failed: %s", exc)
            return []

    def has_session_read_ro(self, session_id: str, node_id: str) -> Optional[bool]:
        """``None`` when the read could not be answered (the caller fails open)."""
        if not session_id:
            return False
        try:
            with self._ro_lock:
                row = self._readonly_conn().execute(
                    "SELECT 1 FROM session_reads WHERE session_id = ? AND node_id = ? LIMIT 1",
                    (session_id, node_id),
                ).fetchone()
            return row is not None
        except sqlite3.Error:
            return None

    def _init_schema(self) -> None:
        assert self._conn is not None
        # Several Hermes processes (gateway, CLI sessions, cron) can share one
        # plugin DB. Without a busy timeout the first concurrent writer wins and
        # everyone else fails instantly with "database is locked" — which showed
        # up as infra_query silently failing to record a read, so the guardrail
        # kept blocking work the agent had already looked up.
        self._conn.execute("PRAGMA busy_timeout=1500")
        row = self._conn.execute("PRAGMA database_list").fetchone()
        self._db_path = str(row[2]) if row and row[2] else ""
        self._conn.executescript(SCHEMA)
        self._commit_with_retry()
        self._migrate()

    def _migrate(self) -> None:
        """Add columns introduced after a database was first created."""
        with self._lock:
            columns = {row[1] for row in self._conn.execute("PRAGMA table_info(nodes)").fetchall()}
            for name, ddl in (
                ("probe", "probe TEXT"),
                ("probe_inferred", "probe_inferred INTEGER NOT NULL DEFAULT 0"),
            ):
                if name not in columns:
                    self._conn.execute(f"ALTER TABLE nodes ADD COLUMN {ddl}")
            self._commit_with_retry()

    def _write(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        """One write. ``_run`` already retries and releases the lock on failure."""
        self._run(sql, params)
        self._commit()

    def close(self) -> None:
        with self._lock:
            if self._ro_conn is not None:
                try:
                    self._ro_conn.close()
                finally:
                    self._ro_conn = None
            if self._conn is not None:
                try:
                    self._conn.close()
                finally:
                    self._conn = None

    # -- nodes ----------------------------------------------------------
    def upsert_node(self, node: dict[str, Any]) -> None:
        """Insert or merge one node. Existing keys not present in ``node`` are preserved."""
        node_id = node.get("id")
        if not node_id:
            raise ValueError("node id is required")
        with self._lock:
            existing = self.get_node(node_id)
            merged: dict[str, Any] = dict(existing or {})
            merged.update({k: v for k, v in node.items() if v is not None})
            merged["id"] = node_id
            merged["updated_at"] = _now()
            merged.setdefault("kind", "service")
            merged.setdefault("stratum", 3)
            merged.setdefault("label", node_id)
            values = {
                "id": merged["id"],
                "kind": merged["kind"],
                "stratum": int(merged.get("stratum") or 3),
                "label": merged.get("label") or node_id,
                "parent_id": merged.get("parent_id"),
                "host_ip": merged.get("host_ip"),
                "tailnet_ip": merged.get("tailnet_ip"),
                "vmid": int(merged["vmid"]) if merged.get("vmid") not in (None, "") else None,
                "ports_json": json.dumps(sorted({str(p) for p in (merged.get("ports") or [])})) if merged.get("ports") else "[]",
                "managed_by": merged.get("managed_by"),
                "systemd_unit": merged.get("systemd_unit"),
                "project_path": merged.get("project_path"),
                "registry_path": merged.get("registry_path"),
                "registry_mtime": merged.get("registry_mtime"),
                "registry_hash": merged.get("registry_hash"),
                "pitfalls_summary": merged.get("pitfalls_summary"),
                "recovery_cmd": merged.get("recovery_cmd"),
                "probe": merged.get("probe"),
                "probe_inferred": 1 if merged.get("probe_inferred") else 0,
                "auto_heal_policy": merged.get("auto_heal_policy") or "inherit",
                "doc_state_json": json.dumps(merged.get("doc_state") or {}),
                "live_state_json": json.dumps(merged.get("live_state") or {}),
                "drift_status": merged.get("drift_status") or "matched",
                "drift_reasons_json": json.dumps(merged.get("drift_reasons") or []),
                "health_status": merged.get("health_status") or "unknown",
                "latency_ms": merged.get("latency_ms"),
                "uptime_24h_pct": merged.get("uptime_24h_pct"),
                "failure_streak": int(merged.get("failure_streak") or 0),
                "last_heal_attempt_at": merged.get("last_heal_attempt_at"),
                "last_seen_live_at": merged.get("last_seen_live_at"),
                "updated_at": merged["updated_at"],
            }
            # ports the caller explicitly cleared must win over the merge
            if "ports" in node and not node["ports"]:
                values["ports_json"] = "[]"
            columns = ", ".join(values)
            placeholders = ", ".join(f":{c}" for c in values)
            updates = ", ".join(f"{c}=excluded.{c}" for c in values if c != "id")
            self._run(
                f"INSERT INTO nodes ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                values,
            )
            self._commit()

    def set_fields(self, node_id: str, **fields: Any) -> None:
        if not fields:
            return
        payload = dict(fields)
        payload.setdefault("updated_at", _now())
        if "ports" in payload:
            payload["ports_json"] = json.dumps(sorted({str(p) for p in payload.pop("ports") or []}))
        if "drift_reasons" in payload:
            payload["drift_reasons_json"] = json.dumps(payload.pop("drift_reasons") or [])
        if "live_state" in payload:
            payload["live_state_json"] = json.dumps(payload.pop("live_state") or {})
        if "doc_state" in payload:
            payload["doc_state_json"] = json.dumps(payload.pop("doc_state") or {})
        assignments = ", ".join(f"{key}=:{key}" for key in payload)
        payload["id"] = node_id
        with self._lock:
            self._run(f"UPDATE nodes SET {assignments} WHERE id=:id", payload)
            self._commit()

    def get_node(self, node_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._run("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return _row_to_node(row) if row else None

    def find_node(self, text: str) -> Optional[dict[str, Any]]:
        """Resolve an exact id first, then a unique substring/slug match."""
        if not text:
            return None
        node = self.get_node(text)
        if node:
            return node
        needle = text.strip().lower()
        with self._lock:
            rows = self._run("SELECT * FROM nodes").fetchall()
        candidates = []
        for row in rows:
            node = _row_to_node(row)
            hay = " ".join(
                str(node.get(key) or "")
                for key in ("id", "label", "host_ip", "tailnet_ip", "systemd_unit", "registry_path", "project_path")
            ).lower()
            if needle in hay:
                candidates.append(node)
        if len(candidates) == 1:
            return candidates[0]
        exact = [n for n in candidates if n["id"].lower() == needle]
        return exact[0] if len(exact) == 1 else None

    def list_nodes(
        self,
        kind: Optional[str] = None,
        drift_status: Optional[str] = None,
        health_status: Optional[str] = None,
        parent_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        for column, value in (
            ("kind", kind),
            ("drift_status", drift_status),
            ("health_status", health_status),
            ("parent_id", parent_id),
        ):
            if value and value != "all":
                clauses.append(f"{column} = ?")
                params.append(value)
        sql = "SELECT * FROM nodes"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        with self._lock:
            rows = self._run(sql, params).fetchall()
        return [_row_to_node(row) for row in rows]

    def upsert_nodes(self, nodes: Iterable[dict[str, Any]]) -> None:
        """Write a whole sweep's node list in the caller's transaction."""
        for node in nodes:
            self.upsert_node(node)

    def delete_nodes_except(self, keep_ids: Iterable[str]) -> None:
        keep = list(keep_ids)
        with self._lock:
            if not keep:
                self._run("DELETE FROM nodes")
            else:
                marks = ",".join("?" for _ in keep)
                self._run(f"DELETE FROM nodes WHERE id NOT IN ({marks})", keep)
            self._commit_with_retry()

    def prune_live_nodes(self, owners: Iterable[str], keep_ids: Iterable[str]) -> int:
        """Delete live-only nodes a collector stopped reporting.

        Only rows owned by ``owners`` are candidates, and a node with a
        ``registry_path`` is never deleted: the registry keeps documenting it even
        while nothing answers, so it stays on the graph as ``doc_only``.
        """
        owner_set = {owner for owner in owners if owner}
        keep = set(keep_ids)
        if not owner_set:
            return 0
        with self._lock:
            rows = self._run("SELECT id, managed_by, registry_path FROM nodes").fetchall()
            doomed = [
                row["id"]
                for row in rows
                if (row["managed_by"] or "") in owner_set
                and not row["registry_path"]
                and row["id"] not in keep
            ]
            for node_id in doomed:
                self._run("DELETE FROM nodes WHERE id = ?", (node_id,))
                self._run("DELETE FROM edges WHERE source_id = ? OR target_id = ?", (node_id, node_id))
            if doomed:
                self._commit_with_retry()
            return len(doomed)

    def close_incidents_for_missing_nodes(self, note: str = "node is no longer observed in the graph") -> list[int]:
        """Resolve incidents whose node disappeared (pruned, renamed, or gone).

        A unit that stops being reported — a failed oneshot that went inactive, a
        container that was removed — otherwise leaves its incident open forever and
        every watchdog tick repeats it.
        """
        with self._lock:
            rows = self._run(
                "SELECT i.id FROM incidents i LEFT JOIN nodes n ON n.id = i.node_id "
                "WHERE i.status IN ('open', 'healing', 'escalated') AND n.id IS NULL"
            ).fetchall()
            ids = [int(row["id"]) for row in rows]
            for incident_id in ids:
                self._run(
                    "UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution_summary = ?, "
                    "updated_at = ? WHERE id = ?",
                    (_now(), note, _now(), incident_id),
                )
            return ids

    # -- edges ----------------------------------------------------------
    def replace_edges(self, edges: Iterable[dict[str, Any]]) -> None:
        now = _now()
        with self._lock:
            self._run("DELETE FROM edges")
            for edge in edges:
                if not edge.get("source_id") or not edge.get("target_id") or not edge.get("relation"):
                    continue
                self._run(
                    "INSERT OR REPLACE INTO edges (source_id, target_id, relation, origin, metadata_json, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        edge["source_id"],
                        edge["target_id"],
                        edge["relation"],
                        edge.get("origin", "doc"),
                        json.dumps(edge.get("metadata") or {}),
                        now,
                    ),
                )
            self._commit()

    def list_edges(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._run("SELECT * FROM edges").fetchall()
        out = []
        for row in rows:
            edge = dict(row)
            edge["metadata"] = _json(edge.pop("metadata_json", "{}"), {})
            out.append(edge)
        return out

    # -- session reads --------------------------------------------------
    def record_session_read(self, session_id: str, node_id: str, read_via: str) -> bool:
        """Return True when this call newly unlocked the node for the session."""
        if not session_id or not node_id:
            return False
        try:
            self._write(
                "INSERT INTO session_reads (session_id, node_id, read_via, read_at) VALUES (?, ?, ?, ?)",
                (session_id, node_id, read_via, _now()),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    def has_session_read(self, session_id: str, node_id: str) -> bool:
        if not session_id:
            return False
        with self._lock:
            row = self._run(
                "SELECT 1 FROM session_reads WHERE session_id = ? AND node_id = ?", (session_id, node_id)
            ).fetchone()
        return row is not None

    def session_reads(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._run("SELECT * FROM session_reads").fetchall()
        return [dict(row) for row in rows]

    def clear_session(self, session_id: str) -> None:
        with self._lock:
            self._run("DELETE FROM session_reads WHERE session_id = ?", (session_id,))
            self._commit_with_retry()

    # -- activity -------------------------------------------------------
    def log_activity(
        self,
        session_id: str,
        tool_name: str,
        node_id: Optional[str],
        action_kind: str,
        blocked: bool = False,
        summary: str = "",
        args_preview: str = "",
    ) -> None:
        self._write(
            "INSERT INTO activity_ledger (ts, session_id, tool_name, node_id, action_kind, blocked, summary, args_preview)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (_now(), session_id or "", tool_name, node_id, action_kind, 1 if blocked else 0, summary, args_preview[:500]),
        )

    def recent_activity(self, limit: int = 50, session_id: Optional[str] = None, node_id: Optional[str] = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM activity_ledger"
        clauses, params = [], []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(int(limit))
        with self._lock:
            rows = self._run(sql, params).fetchall()
        return [dict(row) for row in rows]

    # -- probes / uptime ------------------------------------------------
    def record_probe(self, node_id: str, status: str, latency_ms: Optional[float], detail: str = "") -> None:
        now = _now()
        with self._lock:
            self._run(
                "INSERT INTO probe_samples (ts, node_id, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)",
                (now, node_id, status, latency_ms, detail[:300]),
            )
            window_start = now - 86400
            row = self._run(
                "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up"
                " FROM probe_samples WHERE node_id = ? AND ts >= ?",
                (node_id, window_start),
            ).fetchone()
            total = int(row["total"] or 0)
            up = int(row["up"] or 0)
            uptime = round((up / total) * 100.0, 2) if total else 100.0
            self._run(
                "UPDATE nodes SET health_status = ?, latency_ms = ?, uptime_24h_pct = ?, last_seen_live_at = ?,"
                " updated_at = ? WHERE id = ?",
                (
                    status,
                    latency_ms,
                    uptime,
                    now if status == "up" else None,
                    now,
                    node_id,
                ),
            )
            self._commit_with_retry()

    def bump_failure_streak(self, node_id: str) -> int:
        with self._lock:
            self._run(
                "UPDATE nodes SET failure_streak = failure_streak + 1, updated_at = ? WHERE id = ?", (_now(), node_id)
            )
            row = self._run("SELECT failure_streak FROM nodes WHERE id = ?", (node_id,)).fetchone()
            self._commit_with_retry()
        return int(row["failure_streak"]) if row else 0

    def reset_failure_streak(self, node_id: str) -> None:
        with self._lock:
            self._run("UPDATE nodes SET failure_streak = 0, updated_at = ? WHERE id = ?", (_now(), node_id))
            self._commit_with_retry()

    def insert_probe_sample(
        self,
        node_id: str,
        status: str,
        latency_ms: Optional[float],
        detail: str = "",
        ts: Optional[float] = None,
    ) -> None:
        """Append one sample without recomputing node uptime (history/demo loads)."""
        with self._lock:
            self._run(
                "INSERT INTO probe_samples (ts, node_id, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)",
                (float(ts or _now()), node_id, status, latency_ms, str(detail or "")[:300]),
            )
            self._commit()

    def probe_history(self, node_id: str, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._run(
                "SELECT ts, status, latency_ms, detail FROM probe_samples WHERE node_id = ? ORDER BY id DESC LIMIT ?",
                (node_id, int(limit)),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def fleet_uptime(self) -> dict[str, Any]:
        with self._lock:
            row = self._run(
                "SELECT AVG(uptime_24h_pct) AS avg, COUNT(*) AS nodes FROM nodes "
                "WHERE uptime_24h_pct IS NOT NULL AND kind != 'peer'"
            ).fetchone()
            # Tailnet peers are devices, not fleet: an offline laptop must not
            # inflate the outage count. Documented nodes are what we own.
            down = self._run(
                "SELECT COUNT(*) AS n FROM nodes WHERE health_status = 'down' "
                "AND kind != 'peer' AND registry_path IS NOT NULL AND registry_path != ''"
            ).fetchone()
        return {
            "avg_uptime_24h_pct": round(float(row["avg"] or 100.0), 2) if row else 100.0,
            "monitored_nodes": int(row["nodes"] or 0) if row else 0,
            "down_nodes": int(down["n"] or 0) if down else 0,
        }

    def prune_probe_samples(self, keep_per_node: int = 200, days: int = 7) -> None:
        cutoff = _now() - days * 86400
        with self._lock:
            self._run("DELETE FROM probe_samples WHERE ts < ?", (cutoff,))
            self._run(
                "DELETE FROM probe_samples WHERE id NOT IN ("
                " SELECT id FROM (SELECT id, node_id, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY id DESC) AS rn"
                " FROM probe_samples) WHERE rn <= ?)",
                (int(keep_per_node),),
            )
            self._commit_with_retry()

    # -- incidents ------------------------------------------------------
    def open_incident(
        self,
        node_id: str,
        node_label: str,
        trigger_error: str,
        failure_count: int,
        root_cause_hint: Optional[str] = None,
    ) -> dict[str, Any]:
        now = _now()
        with self._lock:
            row = self._run(
                "SELECT * FROM incidents WHERE node_id = ? AND status IN ('open', 'healing', 'escalated')"
                " ORDER BY id DESC LIMIT 1",
                (node_id,),
            ).fetchone()
            if row:
                self._run(
                    "UPDATE incidents SET failure_count = ?, trigger_error = ?, root_cause_hint = ?, updated_at = ?"
                    " WHERE id = ?",
                    (failure_count, trigger_error[:500], root_cause_hint, now, row["id"]),
                )
                self._commit_with_retry()
                incident_id = row["id"]
            else:
                cur = self._run(
                    "INSERT INTO incidents (node_id, node_label, status, started_at, failure_count, trigger_error,"
                    " root_cause_hint, updated_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)",
                    (node_id, node_label, now, failure_count, trigger_error[:500], root_cause_hint, now),
                )
                self._commit_with_retry()
                incident_id = cur.lastrowid
            fresh = self._run("SELECT * FROM incidents WHERE id = ?", (incident_id,)).fetchone()
        return dict(fresh)

    def create_incident_row(self, incident: dict[str, Any]) -> Optional[int]:
        """Insert a fully-formed incident row (fixture/demo loads)."""
        with self._lock:
            existing = self._run(
                "SELECT id FROM incidents WHERE node_id = ? AND status = ? AND trigger_error = ?",
                (incident.get("node_id"), incident.get("status"), incident.get("trigger_error")),
            ).fetchone()
            if existing:
                return int(existing["id"])
            cur = self._run(
                "INSERT INTO incidents (node_id, node_label, status, started_at, resolved_at, failure_count,"
                " trigger_error, root_cause_hint, heal_attempts, last_heal_action, resolution_summary, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    incident.get("node_id"),
                    incident.get("node_label") or incident.get("node_id"),
                    incident.get("status") or "open",
                    float(incident.get("started_at") or _now()),
                    incident.get("resolved_at"),
                    int(incident.get("failure_count") or 1),
                    str(incident.get("trigger_error") or "")[:500],
                    incident.get("root_cause_hint"),
                    int(incident.get("heal_attempts") or 0),
                    incident.get("last_heal_action"),
                    incident.get("resolution_summary"),
                    _now(),
                ),
            )
            self._commit()
            return int(cur.lastrowid) if cur.lastrowid else None

    def get_incident(self, incident_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._run("SELECT * FROM incidents WHERE id = ?", (int(incident_id),)).fetchone()
        return dict(row) if row else None

    def active_incident_for(self, node_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._run(
                "SELECT * FROM incidents WHERE node_id = ? AND status IN ('open', 'healing', 'escalated')"
                " ORDER BY id DESC LIMIT 1",
                (node_id,),
            ).fetchone()
        return dict(row) if row else None

    def update_incident(self, incident_id: int, **fields: Any) -> None:
        if not fields:
            return
        payload = dict(fields)
        payload["updated_at"] = _now()
        assignments = ", ".join(f"{key}=:{key}" for key in payload)
        payload["id"] = int(incident_id)
        with self._lock:
            self._run(f"UPDATE incidents SET {assignments} WHERE id=:id", payload)
            self._commit_with_retry()

    def list_incidents(self, statuses: Optional[Iterable[str]] = None, limit: int = 50, node_id: Optional[str] = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM incidents"
        clauses, params = [], []
        if statuses:
            marks = ",".join("?" for _ in statuses)
            clauses.append(f"status IN ({marks})")
            params.extend(statuses)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(int(limit))
        with self._lock:
            rows = self._run(sql, params).fetchall()
        return [dict(row) for row in rows]

    # -- sweeps / drift -------------------------------------------------
    def record_sweep(self, duration_ms: int, sources: list[str], counts: dict[str, int], summary: str) -> int:
        with self._lock:
            cur = self._run(
                "INSERT INTO sweeps (ts, duration_ms, sources_json, counts_json, summary) VALUES (?, ?, ?, ?, ?)",
                (_now(), int(duration_ms), json.dumps(sources), json.dumps(counts), summary[:800]),
            )
            self._commit_with_retry()
            return int(cur.lastrowid)

    def latest_sweep(self) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._run("SELECT * FROM sweeps ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return None
        sweep = dict(row)
        sweep["sources"] = _json(sweep.pop("sources_json", "[]"), [])
        sweep["counts"] = _json(sweep.pop("counts_json", "{}"), {})
        return sweep

    def record_drift_event(
        self,
        sweep_id: int,
        node_id: str,
        node_label: str,
        prev_drift: Optional[str],
        new_drift: str,
        field_diffs: list[dict[str, Any]],
        evidence: str,
    ) -> None:
        with self._lock:
            self._run(
                "INSERT INTO drift_events (sweep_id, ts, node_id, node_label, prev_drift, new_drift, field_diffs_json, evidence)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sweep_id, _now(), node_id, node_label, prev_drift, new_drift, json.dumps(field_diffs), evidence[:800]),
            )
            self._commit_with_retry()

    def recent_drift_events(self, since: float, node_id: Optional[str] = None, limit: int = 200) -> list[dict[str, Any]]:
        sql = "SELECT * FROM drift_events WHERE ts >= ?"
        params: list[Any] = [since]
        if node_id:
            sql += " AND node_id = ?"
            params.append(node_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(int(limit))
        with self._lock:
            rows = self._run(sql, params).fetchall()
        out = []
        for row in rows:
            event = dict(row)
            event["field_diffs"] = _json(event.pop("field_diffs_json", "[]"), [])
            out.append(event)
        return out

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._run("SELECT drift_status, COUNT(*) AS n FROM nodes GROUP BY drift_status").fetchall()
        counts = {"matched": 0, "changed": 0, "unregistered": 0, "stale": 0, "doc_only": 0}
        for row in rows:
            counts[row["drift_status"]] = int(row["n"])
        counts["total"] = sum(counts.values())
        return counts


_store: Optional[AtlasStore] = None
_store_lock = threading.Lock()


def get_store() -> AtlasStore:
    """Process-wide store (lazy: opening the DB inside ``register()`` would trip doctor)."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = AtlasStore()
    return _store


def reset_store() -> None:
    """Drop the cached store (tests, profile switches)."""
    global _store
    with _store_lock:
        if _store is not None:
            _store.close()
        _store = None
