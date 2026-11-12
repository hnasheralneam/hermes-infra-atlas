"""Rolling retention on the audit trail (activity ledger, drift, sweeps).

The ledger replaced the retired change-log.md, so it must not grow without
bound: prune_history() runs at the end of every sweep and keeps incidents.
"""

from __future__ import annotations

import time

import _harness as H


def _store(plugin_home, registry, monkeypatch):
    H.load_plugin()
    H.configure({"registry_path": str(registry), "enable_probes": False})
    return H.submodule("store").get_store()


def _age_rows(store, table, keep_last=1):
    """Stamp all but the newest ``keep_last`` rows of ``table`` 200 days old."""
    cutoff = time.time() - 200 * 86400
    rows = store.conn.execute(
        f"SELECT rowid AS rid FROM {table} ORDER BY rowid DESC LIMIT -1 OFFSET ?", (keep_last,)
    ).fetchall()
    for row in rows:
        rid = row["rid"] if hasattr(row, "keys") else row[0]
        store._run(f"UPDATE {table} SET ts = ? WHERE rowid = ?", (cutoff, rid))
    store._commit_with_retry()


def test_old_rows_go_and_new_ones_stay(plugin_home, registry, monkeypatch):
    store = _store(plugin_home, registry, monkeypatch)
    for _ in (0, 1):
        store.log_activity("s-x", "terminal", None, "touch_allowed", summary="act")
        store.record_drift_event(1, "svc-alpha", "Alpha", "matched", "changed", [], "drift")
        store.record_sweep(1, ["kb"], {"matched": 1, "changed": 0, "unregistered": 0, "stale": 0}, "s")
    for table in ("activity_ledger", "drift_events", "sweeps"):
        _age_rows(store, table)
    deleted = store.prune_history(90)
    assert deleted == {"activity_ledger": 1, "drift_events": 1, "sweeps": 1}
    assert len(store.recent_activity(limit=50)) == 1
    assert store.latest_sweep() is not None


def test_incidents_survive_the_prune(plugin_home, registry, monkeypatch):
    store = _store(plugin_home, registry, monkeypatch)
    incident = store.open_incident("svc-old", "Old", "probe failed long ago", failure_count=2)
    store.update_incident(incident["id"], started_at=time.time() - 500 * 86400)
    store.prune_history(90)
    assert store.get_incident(incident["id"]) is not None


def test_prune_floor_never_clears_everything(plugin_home, registry, monkeypatch):
    store = _store(plugin_home, registry, monkeypatch)
    store.log_activity("s-x", "terminal", None, "touch_allowed", summary="fresh")
    deleted = store.prune_history(0)  # nonsense value clamps to >= 1 day
    assert deleted["activity_ledger"] == 0
    assert len(store.recent_activity(limit=50)) == 1
