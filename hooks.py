"""Lifecycle hooks: the read-before-you-touch gate and the activity overlay.

``pre_tool_call`` is a policy hook: Hermes fails *closed* if it raises, so the
whole body is wrapped and every internal failure returns ``None`` (allow). The
gate only ever speaks about nodes that have a registry entry — unregistered
infrastructure has no documentation to read yet, and blocking there would punish
the very case the plugin is meant to surface.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any, Optional

from . import config as plugin_config
from . import matcher
from .store import get_store

logger = logging.getLogger(__name__)

# Activity telemetry is an observer: a locked database must cost a dropped row,
# never a delayed tool result. A daemon thread drains the queue off the hot path.
_activity_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=1000)
_activity_worker: Optional[threading.Thread] = None
_ACTIVITY_IDLE_EXIT_SECONDS = 5.0
_activity_lock = threading.Lock()


def _start_activity_worker() -> None:
    global _activity_worker
    with _activity_lock:
        if _activity_worker and _activity_worker.is_alive():
            return
        worker = threading.Thread(target=_drain_activity, name="infra-atlas-activity", daemon=True)
        _activity_worker = worker
        worker.start()


def _drain_activity() -> None:
    from .store import get_store  # local import: the worker outlives the first call

    while True:
        try:
            entry = _activity_queue.get(timeout=_ACTIVITY_IDLE_EXIT_SECONDS)
        except queue.Empty:
            return  # idle: exit, so a reloaded plugin never keeps a stale worker (and connection) alive
        if entry is None:
            return
        args, kwargs = entry
        try:
            get_store().log_activity(*args, **kwargs)
        except Exception:  # noqa: BLE001 - telemetry never breaks the agent
            logger.debug("infra-atlas: activity write dropped", exc_info=True)
        finally:
            _activity_queue.task_done()


def _enqueue_activity(*args: Any, **kwargs: Any) -> None:
    _start_activity_worker()
    try:
        _activity_queue.put_nowait((args, kwargs))
    except queue.Full:
        logger.debug("infra-atlas: activity queue full, dropping entry")


def drain_activity(timeout: float = 2.0) -> None:
    """Test/CLI helper: wait for queued telemetry to reach the database."""
    _start_activity_worker()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _activity_queue.unfinished_tasks == 0:
            return
        time.sleep(0.01)


def _has_read(store, session: str, node_id: str) -> bool:
    """Whether this session read the entry.

    Hot-path reads go through a read-only connection with a 200 ms budget; if it
    cannot answer, the call is allowed (fail open) — a knowledge-base read must
    never be the reason an agent cannot work.
    """
    ro = getattr(store, "has_session_read_ro", None)
    if ro is not None:
        answer = ro(session, node_id)
        return True if answer is None else bool(answer)
    return bool(store.has_session_read(session, node_id))


_BLOCK_PREFIX = "[Infra Atlas Guardrail — Read Before You Touch]"

# A blocked call still fires post_tool_call. Remember the decision so the
# observer does not log a vetoed call as an allowed touch a moment later.
_recent_decisions: dict[tuple[str, str, str], tuple[str, float]] = {}


def _remember(session: str, tool_name: str, node_id: str, kind: str) -> None:
    now = time.time()
    for key, (_kind, ts) in list(_recent_decisions.items()):
        if now - ts > 30:  # keep the map bounded in a long-lived gateway
            _recent_decisions.pop(key, None)
    _recent_decisions[(session, tool_name, node_id)] = (kind, now)


def _take_decision(session: str, tool_name: str, node_id: str) -> Optional[str]:
    entry = _recent_decisions.pop((session, tool_name, node_id), None)
    if not entry:
        return None
    kind, ts = entry
    return kind if time.time() - ts <= 30 else None


def _broadcast(event: str, payload: dict[str, Any]) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("infra-atlas", event, payload)
    except Exception:  # noqa: BLE001 - events are best-effort
        logger.debug("infra-atlas: event %s not delivered", event, exc_info=True)


def _session(session_id: str, task_id: str) -> str:
    return session_id or task_id or "unattributed"


def _unlock(store, session_id: str, nodes: list[dict[str, Any]], via: str) -> list[dict[str, Any]]:
    unlocked = []
    for node in nodes:
        if store.record_session_read(session_id, node["id"], via):
            unlocked.append(node)
    return unlocked


def on_pre_tool_call(
    tool_name: str = "",
    args: Optional[dict[str, Any]] = None,
    task_id: str = "",
    session_id: str = "",
    **kwargs: Any,
) -> Optional[dict[str, Any]]:
    """Veto a blind operation on documented infrastructure; record what was read."""
    try:
        mode = plugin_config.guardrail_mode()
        if mode == "off":
            return None
        store = get_store()
        session = _session(session_id, task_id)
        classified = matcher.classify(store, tool_name, args or {})
        role = classified["role"]
        nodes = classified["nodes"]
        if role in {"none", "plugin"} or not nodes:
            return None

        if role == "read":
            unlocked = _unlock(store, session, nodes, "read_file")
            for node in unlocked:
                _broadcast(
                    "activity",
                    {
                        "session_id": session,
                        "node_id": node["id"],
                        "label": node.get("label"),
                        "action_kind": "read_doc",
                        "tool_name": tool_name,
                        "summary": f"read {node.get('registry_path') or node['id']}",
                    },
                )
            return None

        documented = [node for node in nodes if node.get("registry_path")]
        if not documented:
            return None
        unread = [node for node in documented if not _has_read(store, session, node["id"])]
        if not unread:
            return None

        primary = unread[0]
        preview = matcher.preview(args or {})
        if mode == "warn":
            for node in unread:
                _remember(session, tool_name, node["id"], "touch_warned")
                _enqueue_activity(
                    session,
                    tool_name,
                    node["id"],
                    "touch_warned",
                    blocked=False,
                    summary=f"blind touch without reading {node.get('registry_path')}",
                    args_preview=preview,
                )
                _broadcast(
                    "activity",
                    {
                        "session_id": session,
                        "node_id": node["id"],
                        "label": node.get("label"),
                        "action_kind": "touch_warned",
                        "tool_name": tool_name,
                        "summary": f"warned: {tool_name} touched {node['id']} without reading its registry entry",
                    },
                )
            return None

        listed = ", ".join(
            f"`{node['id']}` ({node.get('registry_path')})" for node in unread[:4]
        )
        pitfall = primary.get("pitfalls_summary")
        message = (
            f"{_BLOCK_PREFIX} Blocked `{tool_name}` touching registered infrastructure: {listed}. "
            f"Read the registry entry first — call `infra_query(node_id=\"{primary['id']}\")` "
            f"(it returns the runbook, the current health and the pitfalls) or `read_file` on "
            f"`{primary.get('registry_path')}` — then retry the exact command. "
            "Reading INDEX.md alone does not unlock individual entries."
        )
        if pitfall:
            message += f" ⚠ Known pitfall for {primary['id']}: {str(pitfall)[:400]}"
        if primary.get("managed_by"):
            message += f" (managed by {primary['managed_by']})"

        for node in unread:
            _remember(session, tool_name, node["id"], "touch_blocked")
            _enqueue_activity(
                session,
                tool_name,
                node["id"],
                "touch_blocked",
                blocked=True,
                summary=f"blocked blind touch on {node['id']}",
                args_preview=preview,
            )
            _broadcast(
                "activity",
                {
                    "session_id": session,
                    "node_id": node["id"],
                    "label": node.get("label"),
                    "action_kind": "touch_blocked",
                    "tool_name": tool_name,
                    "summary": f"blocked: {tool_name} → {node['id']} (registry entry not read)",
                },
            )
        return {"action": "block", "message": message}
    except Exception:  # noqa: BLE001 - never fail a tool call on our own bug
        logger.warning("infra-atlas: pre_tool_call error (allowing the call)", exc_info=True)
        return None


def on_post_tool_call(
    tool_name: str = "",
    args: Optional[dict[str, Any]] = None,
    result: Any = None,
    task_id: str = "",
    session_id: str = "",
    duration_ms: int = 0,
    **kwargs: Any,
) -> None:
    """Record an allowed touch (pre_tool_call already decided) for the overlay."""
    try:
        if plugin_config.guardrail_mode() == "off":
            return
        if tool_name not in {"terminal", "write_file", "patch"}:
            return
        store = get_store()
        session = _session(session_id, task_id)
        classified = matcher.classify(store, tool_name, args or {})
        if classified["role"] != "touch":
            return
        for node in classified["nodes"]:
            if not node.get("registry_path"):
                continue
            decision = _take_decision(session, tool_name, node["id"])
            if decision in {"touch_blocked", "touch_warned"}:
                # pre_tool_call already recorded (and broadcast) this decision;
                # post_tool_call fires even for a vetoed call.
                continue
            _enqueue_activity(
                session,
                tool_name,
                node["id"],
                "touch_allowed",
                blocked=False,
                summary=f"{tool_name} on {node['id']} ({duration_ms}ms)",
                args_preview=matcher.preview(args or {}),
            )
            _broadcast(
                "activity",
                {
                    "session_id": session,
                    "node_id": node["id"],
                    "label": node.get("label"),
                    "action_kind": "touch_allowed",
                    "tool_name": tool_name,
                    "summary": f"{tool_name} → {node['id']}",
                },
            )
    except Exception:  # noqa: BLE001
        logger.debug("infra-atlas: post_tool_call error", exc_info=True)


def on_session_start(session_id: str = "", **kwargs: Any) -> None:
    """A fresh session starts with nothing unlocked (rows are per session id)."""
    try:
        if not session_id:
            return
        # Cheap hygiene: a session id is unique, but a resumed session keeps its
        # id and should keep its unlocks, so nothing is cleared here.
        logger.debug("infra-atlas: session %s started", session_id)
    except Exception:  # noqa: BLE001
        pass
