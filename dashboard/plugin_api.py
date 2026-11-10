"""FastAPI backend for the Infra Atlas desktop page.

Mounted by the dashboard at ``/api/plugins/infra-atlas/``. This file is imported
as a standalone module (not as part of the plugin package), so the engine modules
are resolved through :func:`_plugin_module`, which reuses the package Hermes
already loaded when the agent half is enabled and otherwise loads the package by
path.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import sys
import time
import types
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter()

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_PKG = "hermes_plugins.infra_atlas"


def _loaded_package() -> Optional[str]:
    """The already-imported plugin package name, if the agent half is loaded.

    Only a real package counts (dotted name + ``__path__``): a bare ``__init__``
    module imported by a tree walker is not the package the submodules live in.
    """
    for name, module in list(sys.modules.items()):
        path = getattr(module, "__file__", None)
        if not path or "." not in name or not getattr(module, "__path__", None):
            continue
        if Path(path).resolve() == (PLUGIN_ROOT / "__init__.py"):
            return name
    return None


def _ensure_package() -> str:
    name = _loaded_package()
    if name:
        return name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules.setdefault("hermes_plugins", namespace)
    if _PKG not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            _PKG, PLUGIN_ROOT / "__init__.py", submodule_search_locations=[str(PLUGIN_ROOT)]
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules.setdefault(_PKG, module)
        spec.loader.exec_module(module)
    return _PKG


def _plugin_module(name: str):
    package = _ensure_package()
    return importlib.import_module(f"{package}.{name}")


def _broadcast(event: str, payload: dict[str, Any]) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("infra-atlas", event, payload)
    except Exception:  # noqa: BLE001
        logger.debug("infra-atlas: event %s not delivered", event, exc_info=True)


def _store():
    return _plugin_module("store").get_store()


def _json(payload: Any) -> Any:
    return json.loads(json.dumps(payload, default=str))


def _config():
    return _plugin_module("config")


# -- reads ------------------------------------------------------------------
@router.get("/health")
async def health() -> dict[str, Any]:
    config = _config()
    return {
        "ok": True,
        "plugin": "infra-atlas",
        "registry": str(config.registry_root()),
        "guardrail_mode": config.guardrail_mode(),
        "auto_heal_mode": config.auto_heal_mode(),
    }


@router.get("/credentials")
async def credentials() -> dict[str, Any]:
    """Names, owners and stored/missing status — never a value."""
    vault = _plugin_module("credentials")
    config = _config()
    root = config.registry_root()
    entries = vault.list_entries()
    declared = vault.declared_refs(root)
    owners: dict[str, list[str]] = {}
    for node_id, names in declared.items():
        for name in names:
            owners.setdefault(name, []).append(node_id)
    for entry in entries:
        entry["declared_by"] = sorted(set(owners.get(entry["name"], [])))
    scan = vault.scan_report(root)
    return _json(
        {
            "vault": vault.store_info(),
            "credentials": entries,
            "count": len(entries),
            "missing": vault.missing(),
            "unreferenced": vault.unreferenced(),
            "literal_findings": {"count": scan["count"], "files": scan["files"]},
            "writes": "agent-side only: infra_credentials(action='set'|'remove')",
        }
    )


@router.get("/graph")
async def graph() -> dict[str, Any]:
    store = _store()
    config = _config()
    nodes = store.list_nodes()
    if not nodes:
        # First open: give the page something immediately (fast sources only).
        try:
            fusion = _plugin_module("fusion")
            fusion.run_sweep(sources=["kb", "local", "hermes"], trigger_auto_heal=False)
            nodes = store.list_nodes()
        except Exception:  # noqa: BLE001
            logger.warning("infra-atlas: initial sweep failed", exc_info=True)
    counts = store.counts()
    incidents = store.list_incidents(statuses=["open", "healing", "escalated"], limit=25)
    sweep = store.latest_sweep()
    return _json(
        {
            "nodes": nodes,
            "edges": store.list_edges(),
            "counts": counts,
            "fleet": store.fleet_uptime(),
            "incidents": incidents,
            "last_sweep": sweep,
            "config": {
                "guardrail_mode": config.guardrail_mode(),
                "auto_heal_mode": config.auto_heal_mode(),
                "registry_path": str(config.registry_root()),
                "failure_threshold": int(config.setting("failure_threshold") or 2),
                "heal_cooldown_sec": int(config.setting("heal_cooldown_sec") or 300),
            },
            "session_reads": store.session_reads(),
            "activity": store.recent_activity(limit=25),
            "now": time.time(),
        }
    )


@router.get("/node/{node_id}")
async def node_detail(node_id: str) -> dict[str, Any]:
    store = _store()
    node = store.get_node(node_id) or store.find_node(node_id)
    if not node:
        return {"error": f"unknown node {node_id!r}"}
    config = _config()
    fusion = _plugin_module("fusion")
    registry_kb = _plugin_module("registry_kb")
    markdown = None
    if node.get("registry_path"):
        try:
            markdown = registry_kb.read_entry_text(config.registry_root(), str(node["registry_path"]))
        except Exception as exc:  # noqa: BLE001
            markdown = f"_(could not read {node['registry_path']}: {exc})_"
    incidents = store.list_incidents(limit=20, node_id=node["id"])
    return _json(
        {
            "node": node,
            "blast_radius": fusion.blast_radius(store, node["id"]),
            "probe_history": store.probe_history(node["id"], limit=40),
            "incidents": incidents,
            "activity": store.recent_activity(limit=30, node_id=node["id"]),
            "registry_markdown": markdown,
            "diff": _field_diff(node),
        }
    )


def _field_diff(node: dict[str, Any]) -> list[dict[str, Any]]:
    doc = node.get("doc_state") or {}
    live = node.get("live_state") or {}
    diffs = []
    for field in ("host_ip", "tailnet_ip", "vmid", "ports", "systemd_unit", "managed_by", "parent_id"):
        if field not in doc and field not in live:
            continue
        left, right = doc.get(field), live.get(field)
        if left in (None, "", []) and right in (None, "", []):
            continue
        if right in (None, "", []):
            # The live side simply has nothing to say about this field.
            continue
        if field == "managed_by" and {str(left).strip().lower(), str(right).strip().lower()} <= {"host", "proxmox"}:
            continue
        if json.dumps(left, sort_keys=True, default=str) != json.dumps(right, sort_keys=True, default=str):
            diffs.append({"field": field, "doc": left, "live": right})
    return diffs


# -- actions ----------------------------------------------------------------
@router.post("/sweep")
async def sweep(body: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    body = body or {}
    fusion = _plugin_module("fusion")
    summary = fusion.run_sweep(
        sources=body.get("sources") or None,
        trigger_auto_heal=bool(body.get("trigger_auto_heal", True)),
        session_id="desktop",
    )
    _broadcast("sweep.completed", {"counts": summary.get("counts"), "sweep_id": summary.get("sweep_id")})
    return _json(summary)


@router.post("/reconcile")
async def reconcile(body: dict[str, Any]) -> dict[str, Any]:
    """Adopt live state into the Markdown KB (or mark an entry removed)."""
    store = _store()
    config = _config()
    registry_kb = _plugin_module("registry_kb")
    node_id = str(body.get("node_id") or "")
    action = str(body.get("action") or "adopt_live")
    node = store.get_node(node_id) or store.find_node(node_id)
    if not node:
        return {"ok": False, "error": f"unknown node {node_id!r}"}
    reason = str(body.get("reason") or "").strip() or {
        "adopt_live": "adopted live state from the desktop graph",
        "sync_ip_ports": "synced address from the desktop graph",
        "mark_removed": "marked removed from the desktop graph",
    }.get(action, "reconciled from the desktop graph")

    payload = {
        "id": node["id"],
        "kind": node.get("kind") or "service",
        "label": node.get("label"),
        "host_ip": node.get("host_ip"),
        "tailnet_ip": node.get("tailnet_ip"),
        "vmid": node.get("vmid"),
        "ports": node.get("ports") or [],
        "managed_by": node.get("managed_by"),
        "systemd_unit": node.get("systemd_unit"),
        "parent_id": node.get("parent_id"),
        "recovery_cmd": node.get("recovery_cmd"),
        "auto_heal_policy": node.get("auto_heal_policy") or "inherit",
        "pitfalls": node.get("pitfalls_summary"),
        "probe": (node.get("live_state") or {}).get("probe") or (node.get("doc_state") or {}).get("probe"),
        "status": "removed" if action == "mark_removed" else "active",
    }
    live = node.get("live_state") or {}
    if action != "mark_removed":
        for key in ("host_ip", "tailnet_ip", "vmid", "ports", "parent_id", "systemd_unit", "managed_by"):
            if live.get(key) not in (None, "", []):
                payload[key] = live[key]
    try:
        result = registry_kb.upsert_entry(config.registry_root(), payload, reason, session_id="desktop")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}

    store.upsert_node(
        {
            **node,
            "registry_path": result.get("registry_path"),
            "pitfalls_summary": result.get("pitfalls_summary"),
            "recovery_cmd": result.get("recovery_cmd"),
            "auto_heal_policy": result.get("auto_heal_policy"),
            "doc_state": result.get("doc_state") or node.get("doc_state") or {},
            "drift_status": "doc_only" if action == "mark_removed" else "matched",
            "drift_reasons": [] if action != "mark_removed" else ["marked removed from the graph"],
        }
    )
    _plugin_module("matcher").refresh()
    _broadcast("node.updated", {"node_id": node["id"], "action": action})
    return {"ok": True, "node_id": node["id"], "registry_path": result.get("registry_path"), "action": action}


@router.post("/heal")
async def heal(body: dict[str, Any]) -> dict[str, Any]:
    store = _store()
    uptime = _plugin_module("uptime")
    node = store.get_node(str(body.get("node_id") or "")) or store.find_node(str(body.get("node_id") or ""))
    if not node:
        return {"ok": False, "error": "unknown node"}
    incident = store.active_incident_for(node["id"])
    if str(body.get("mode") or "playbook") == "agent_brief":
        store.record_session_read("desktop", node["id"], "desktop")
        brief = uptime.remediation_brief(store, node, incident or {
            "id": 0,
            "trigger_error": (node.get("live_state") or {}).get("probe_detail") or "manual dispatch",
            "failure_count": node.get("failure_streak") or 1,
        })
        return {"ok": True, "mode": "agent_brief", "remediation_brief": brief}
    outcome = uptime.playbook_heal(store, node, incident)
    _broadcast("incident.healed" if outcome.get("ok") else "incident.heal_failed", {"node_id": node["id"], **outcome})
    return _json(outcome)


@router.post("/incidents/{incident_id}/resolve")
async def resolve_incident(incident_id: int, body: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    body = body or {}
    store = _store()
    config = _config()
    registry_kb = _plugin_module("registry_kb")
    incident = store.get_incident(incident_id)
    if not incident:
        return {"ok": False, "error": "unknown incident"}
    status = "escalated" if body.get("escalate") else "resolved"
    summary = str(body.get("summary") or "").strip() or (
        "resolved from the desktop graph" if status == "resolved" else "escalated from the desktop graph"
    )
    store.update_incident(
        incident_id,
        status=status,
        resolved_at=time.time() if status == "resolved" else None,
        resolution_summary=summary,
    )
    node = store.get_node(incident["node_id"])
    if node:
        registry_kb.prepend_change_log(
            config.registry_root(),
            f"{registry_kb._now_est()} — [infra-atlas] incident #{incident_id} {status}: {node['id']}",
            [
                f"**Node:** `{node['id']}` ({node.get('registry_path') or 'no entry'})",
                f"**Trigger:** {incident.get('trigger_error')}",
                f"**Outcome:** {summary}",
                "**Source:** desktop graph",
            ],
        )
    _broadcast("incident.resolved", {"incident_id": incident_id, "node_id": incident["node_id"], "status": status})
    return {"ok": True, "incident_id": incident_id, "status": status}


@router.post("/watchdog")
async def watchdog(body: dict[str, Any]) -> dict[str, Any]:
    uptime = _plugin_module("uptime")
    path = uptime.install_watchdog_script(PLUGIN_ROOT)
    _broadcast("watchdog.installed", {"path": str(path)})
    return {"ok": True, "script": str(path), "hint": "Schedule it with infra_incidents(action='setup_watchdog') in a chat."}


@router.post("/session-unlock")
async def session_unlock(body: dict[str, Any]) -> dict[str, Any]:
    store = _store()
    session = str(body.get("session_id") or "desktop")
    node_id = str(body.get("node_id") or "")
    if not node_id:
        return {"ok": False, "error": "node_id required"}
    added = store.record_session_read(session, node_id, "desktop")
    _broadcast("activity", {"session_id": session, "node_id": node_id, "action_kind": "read_doc",
                            "tool_name": "desktop", "summary": "unlocked from the desktop graph"})
    return {"ok": True, "session_id": session, "node_id": node_id, "newly_unlocked": added}


@router.post("/settings")
async def update_settings(body: dict[str, Any]) -> dict[str, Any]:
    """Re-read settings after the UI wrote them through ``plugins.manage settings``.

    Persistence lives in Hermes (the public RPC). This route only validates the
    values are visible to the backend and reloads the right data source, so the
    page can refresh immediately after a toggle.
    """
    config = _config()
    changed = sorted(key for key in body if key in config.DEFAULTS)
    _broadcast("settings.changed", {"written": changed})
    return {
        "ok": True,
        "written": changed,
        "config": {
            "guardrail_mode": config.guardrail_mode(),
            "auto_heal_mode": config.auto_heal_mode(),
        },
    }


@router.get("/activity")
async def activity(limit: int = 50, session_id: Optional[str] = None) -> dict[str, Any]:
    store = _store()
    return _json(
        {
            "activity": store.recent_activity(limit=limit, session_id=session_id),
            "incidents": store.list_incidents(limit=25),
            "counts": store.counts(),
        }
    )
