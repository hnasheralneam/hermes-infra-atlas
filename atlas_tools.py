"""Tool handlers. Every one returns a JSON string."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

from . import config as plugin_config
from . import credentials as credential_vault
from . import fusion
from . import matcher
from . import registry_kb
from . import uptime
from .store import get_store

logger = logging.getLogger(__name__)

_ctx: Any = None


def bind_context(ctx: Any) -> None:
    """Keep the plugin context so tools can dispatch host tools (cron) and log."""
    global _ctx
    _ctx = ctx


def _json(payload: Any) -> str:
    return json.dumps(payload, indent=2, default=str, ensure_ascii=False)


def _session(session_id: str, task_id: str) -> str:
    return session_id or task_id or "agent"


def _since_epoch(text: str) -> float:
    raw = str(text or "24h").strip().lower()
    units = {"m": 60, "h": 3600, "d": 86400, "w": 604800}
    if raw and raw[-1] in units and raw[:-1].replace(".", "", 1).isdigit():
        return time.time() - float(raw[:-1]) * units[raw[-1]]
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except ValueError:
            continue
    return time.time() - 86400


def _node_payload(
    store,
    node: dict[str, Any],
    include_blast: bool,
    include_markdown: bool,
    creds: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    credential_state = creds.get(node["id"]) if creds and node["id"] in creds else None
    if credential_state is None:
        credential_state = credential_vault.node_credentials(node["id"], node)
    payload = {
        "id": node["id"],
        "label": node.get("label"),
        "kind": node.get("kind"),
        "stratum": node.get("stratum"),
        "parent_id": node.get("parent_id"),
        "registry_path": node.get("registry_path"),
        "drift_status": node.get("drift_status"),
        "drift_reasons": node.get("drift_reasons") or [],
        "health_status": node.get("health_status"),
        "latency_ms": node.get("latency_ms"),
        "uptime_24h_pct": node.get("uptime_24h_pct"),
        "failure_streak": node.get("failure_streak"),
        "address": {
            "host_ip": node.get("host_ip"),
            "tailnet_ip": node.get("tailnet_ip"),
            "ports": node.get("ports") or [],
            "vmid": node.get("vmid"),
        },
        "management": {
            "managed_by": node.get("managed_by"),
            "systemd_unit": node.get("systemd_unit"),
            "recovery_cmd": node.get("recovery_cmd"),
            "auto_heal_policy": node.get("auto_heal_policy"),
            "probe": (node.get("doc_state") or {}).get("probe") or (node.get("live_state") or {}).get("probe"),
        },
        "pitfalls": node.get("pitfalls_summary"),
        "credentials": credential_state,
        "doc_state": node.get("doc_state") or {},
        "live_state": node.get("live_state") or {},
        "recent_probes": store.probe_history(node["id"], limit=10),
        "incident": store.active_incident_for(node["id"]),
    }
    if include_blast:
        payload["blast_radius"] = fusion.blast_radius(store, node["id"])
    if include_markdown and node.get("registry_path"):
        try:
            payload["registry_markdown"] = registry_kb.read_entry_text(
                plugin_config.registry_root(), str(node["registry_path"])
            )
        except Exception as exc:  # noqa: BLE001
            payload["registry_markdown_error"] = str(exc)
    return payload


def infra_query(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    store = get_store()
    query = str(args.get("node_id") or "").strip()
    include_blast = bool(args.get("include_blast_radius", True))
    include_markdown = bool(args.get("include_markdown", True))

    nodes: list[dict[str, Any]]
    if query:
        node = store.find_node(query)
        if node:
            nodes = [node]
        else:
            nodes = matcher.match_text(store, query)[:10]
        if not nodes:
            return _json(
                {
                    "found": 0,
                    "query": query,
                    "hint": "No node matched. Run infra_sweep to refresh discovery, or infra_bootstrap to import the KB.",
                }
            )
    else:
        nodes = store.list_nodes(
            kind=str(args.get("kind") or "all"),
            drift_status=str(args.get("drift_status") or "all"),
            health_status=str(args.get("health_status") or "all"),
        )
        nodes.sort(key=lambda n: (int(n.get("stratum") or 3), n.get("label") or n["id"]))

    session = _session(session_id, task_id)
    unlocked = []
    for node in nodes:
        if store.record_session_read(session, node["id"], "infra_query"):
            unlocked.append(node["id"])

    # Surface the read in the activity stream and on the desktop graph, exactly
    # like a read_file unlock does.
    if unlocked:
        try:
            from .hooks import _broadcast  # noqa: PLC0415

            for node in nodes:
                if node["id"] not in unlocked:
                    continue
                summary = f"read {node.get('registry_path') or node['id']}"
                store.log_activity(session, "infra_query", node["id"], "read_doc", summary=summary)
                _broadcast(
                    "activity",
                    {
                        "session_id": session,
                        "node_id": node["id"],
                        "label": node.get("label"),
                        "action_kind": "read_doc",
                        "tool_name": "infra_query",
                        "summary": summary,
                    },
                )
        except Exception:  # noqa: BLE001 - telemetry must never fail the read
            logger.debug("infra-atlas: read broadcast failed", exc_info=True)

    detailed = len(nodes) <= 3
    creds = credential_vault.status_map(plugin_config.registry_root())
    payload = {
        "found": len(nodes),
        "unlocked_for_this_session": unlocked,
        "nodes": [
            _node_payload(store, node, include_blast, include_markdown and detailed, creds) for node in nodes
        ],
    }
    payload["next_step"] = (
        f"Registry read for {', '.join(unlocked)} — terminal/write operations on them are now permitted in this session."
        if unlocked
        else "These entries were already read in this session."
    )
    return _json(payload)


def infra_sweep(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    summary = fusion.run_sweep(
        sources=args.get("sources") or None,
        probe_timeout=args.get("probe_timeout_sec"),
        trigger_auto_heal=bool(args.get("trigger_auto_heal", True)),
        session_id=_session(session_id, task_id),
    )
    try:
        from .hooks import _broadcast  # noqa: PLC0415 - same package, cheap import

        _broadcast("sweep.completed", {"counts": summary.get("counts"), "sweep_id": summary.get("sweep_id")})
    except Exception:  # noqa: BLE001
        pass
    return _json(summary)


def infra_diff(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    store = get_store()
    since = _since_epoch(str(args.get("since") or "24h"))
    node_id = args.get("node_id") or None
    events = store.recent_drift_events(since, node_id=node_id)
    incidents = [
        incident
        for incident in store.list_incidents(limit=100, node_id=node_id)
        if float(incident.get("started_at") or 0) >= since or incident.get("status") in {"open", "healing", "escalated"}
    ]
    activity = store.recent_activity(limit=50, node_id=node_id)
    activity = [entry for entry in activity if float(entry.get("ts") or 0) >= since]
    sweep = store.latest_sweep()
    return _json(
        {
            "since": datetime.fromtimestamp(since, tz=timezone.utc).isoformat(),
            "latest_sweep": sweep,
            "counts": store.counts(),
            "drift_transitions": events,
            "incidents": incidents,
            "activity": activity,
        }
    )


def infra_upsert(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    store = get_store()
    node_id = str(args.get("node_id") or "").strip()
    if not node_id:
        return _json({"error": "node_id is required"})
    reason = str(args.get("reason") or "").strip()
    if not reason:
        return _json({"error": "reason is required — it is written to change-log.md"})
    action = str(args.get("action") or "upsert")
    session = _session(session_id, task_id)

    existing = store.get_node(node_id) or store.find_node(node_id) or {}
    payload: dict[str, Any] = {
        "id": node_id,
        "kind": args.get("kind") or existing.get("kind") or "service",
        "label": args.get("label") or existing.get("label") or node_id,
        "status": args.get("status") or ("removed" if action == "mark_removed" else "active"),
    }
    if action == "adopt_live":
        live_state = existing.get("live_state") or {}
        for key in ("host_ip", "tailnet_ip", "vmid", "ports", "parent_id", "systemd_unit", "managed_by", "label"):
            payload[key] = args.get(key) or existing.get(key) or live_state.get(key)
    else:
        # ``recovery_cmd`` is not accepted from the model: it names a command the
        # plugin will execute, so it belongs to the operator's registry only.
        # A request that tries to set it is rejected rather than silently dropped.
        if str(args.get("recovery_cmd") or "").strip():
            return _json(
                {
                    "error": (
                        "recovery_cmd is not writable through infra_upsert: it names a command the "
                        "plugin runs, so it must be set by the operator in the registry entry"
                    )
                }
            )
        for key in ("host_ip", "tailnet_ip", "vmid", "ports", "parent_id", "depends_on",
                    "systemd_unit", "managed_by", "project_path", "probe",
                    "auto_heal_policy", "pitfalls", "label", "kind"):
            if args.get(key) not in (None, "", []):
                payload[key] = args[key]

    try:
        result = registry_kb.upsert_entry(
            plugin_config.registry_root(),
            payload,
            reason,
            session_id=session,
            body_append=str(args.get("markdown_body") or ""),
            replace_body=bool(args.get("replace_body")),
        )
    except Exception as exc:  # noqa: BLE001
        return _json({"error": f"registry write failed: {exc}"})

    store.upsert_node(
        {
            "id": node_id,
            "kind": result.get("kind") or payload["kind"],
            "label": result.get("label") or payload["label"],
            "host_ip": result.get("host_ip"),
            "tailnet_ip": result.get("tailnet_ip"),
            "vmid": result.get("vmid"),
            "ports": result.get("ports") or [],
            "managed_by": result.get("managed_by"),
            "systemd_unit": result.get("systemd_unit"),
            "parent_id": result.get("parent_id"),
            "registry_path": result.get("registry_path"),
            "pitfalls_summary": result.get("pitfalls_summary"),
            "recovery_cmd": result.get("recovery_cmd"),
            "auto_heal_policy": result.get("auto_heal_policy"),
            "doc_state": result.get("doc_state") or {},
            "drift_status": "matched" if action == "adopt_live" else (existing.get("drift_status") or "matched"),
            "drift_reasons": [] if action == "adopt_live" else (existing.get("drift_reasons") or []),
        }
    )
    store.record_session_read(session, node_id, "infra_upsert")
    matcher.refresh()
    return _json({"ok": True, "action": action, "node_id": node_id, "created": result.get("created"), "entry": result.get("registry_path")})


def infra_bootstrap(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    mode = str(args.get("mode") or "annotate_existing_kb")
    dry = bool(args.get("dry_run"))
    root = plugin_config.registry_root()
    if mode == "scaffold_from_live":
        summary = fusion.run_sweep(sources=["local", "hermes"], session_id=_session(session_id, task_id))
        store = get_store()
        created = []
        for node in store.list_nodes(drift_status="unregistered"):
            if dry:
                created.append(node["id"])
                continue
            result = registry_kb.upsert_entry(
                root,
                {
                    **node,
                    "kind": "service" if node.get("kind") in {"service", "container"} else "server",
                    "label": node.get("label") or node["id"],
                },
                "scaffolded from live discovery (infra_bootstrap)",
                session_id=_session(session_id, task_id),
                create_body="Scaffolded by infra-atlas from live discovery — expand the runbook.",
            )
            store.upsert_node({**node, "registry_path": result.get("registry_path"), "drift_status": "matched", "drift_reasons": []})
            created.append(node["id"])
        matcher.refresh()
        return _json({"mode": mode, "dry_run": dry, "created": created, "sweep_counts": summary.get("counts")})
    result = registry_kb.bootstrap_annotate(root, dry_run=dry)
    if not dry:
        fusion.run_sweep(sources=["kb", "local"], trigger_auto_heal=False)
    return _json({"mode": mode, "dry_run": dry, "registry": str(root), **result})


def infra_incidents(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    store = get_store()
    action = str(args.get("action") or "list")
    session = _session(session_id, task_id)

    if action == "list":
        active = store.list_incidents(statuses=["open", "healing", "escalated"])
        recent = [i for i in store.list_incidents(limit=25) if i.get("status") == "resolved"][:10]
        return _json(
            {
                "fleet": store.fleet_uptime(),
                "open_incidents": active,
                "recently_resolved": recent,
                "mode": plugin_config.auto_heal_mode(),
                "watchdog": _watchdog_status(),
            }
        )

    incident_id = args.get("incident_id")
    node_id = args.get("node_id")
    incident = store.get_incident(int(incident_id)) if incident_id else None
    if incident is None and node_id:
        incident = store.active_incident_for(str(node_id))
    node = store.get_node(incident["node_id"]) if incident else (store.get_node(str(node_id)) if node_id else None)

    if action == "get":
        if not incident or not node:
            return _json({"error": "incident not found"})
        store.record_session_read(session, node["id"], "infra_incidents")
        return _json(
            {
                "incident": incident,
                "node": _node_payload(store, node, include_blast=True, include_markdown=True),
                "remediation_brief": uptime.remediation_brief(store, node, incident),
            }
        )

    if action == "heal":
        if not node:
            return _json({"error": "node not found"})
        store.record_session_read(session, node["id"], "infra_incidents")
        outcome = uptime.playbook_heal(store, node, incident, session_id=session)
        if outcome.get("ok"):
            store.log_activity(session, "infra_incidents", node["id"], "auto_heal", summary=f"healed via {outcome.get('command')}")
        return _json(outcome)

    if action in {"resolve", "escalate"}:
        if not incident:
            return _json({"error": "incident not found"})
        summary = str(args.get("summary") or "").strip() or (
            "resolved manually" if action == "resolve" else "escalated to a human"
        )
        store.update_incident(
            incident["id"],
            status="resolved" if action == "resolve" else "escalated",
            resolved_at=time.time() if action == "resolve" else None,
            resolution_summary=summary,
        )
        if node:
            registry_kb.prepend_change_log(
                plugin_config.registry_root(),
                f"{registry_kb._now_est()} — [infra-atlas] incident #{incident['id']} {action}d: {node['id']}",
                [
                    f"**Node:** `{node['id']}` ({node.get('registry_path') or 'no entry'})",
                    f"**Trigger:** {incident.get('trigger_error')}",
                    f"**Outcome:** {summary}",
                    f"**Source:** session `{session}`",
                ],
            )
        return _json({"ok": True, "incident_id": incident["id"], "status": "resolved" if action == "resolve" else "escalated"})

    if action == "setup_watchdog":
        path = uptime.install_watchdog_script()
        interval = max(1, int(args.get("interval_min") or 2))
        enabled = bool(args.get("enabled", True))
        prompt = (
            "Infra Atlas uptime watchdog. The pre-check script output above contains one or more "
            "INCIDENT REMEDIATION BRIEFS for infrastructure that is down. For each brief: read the "
            "registry entry (infra_query), diagnose, remediate following its managed-by and pitfalls, "
            "verify with infra_sweep(sources=['probes']), then close it with infra_incidents(action="
            "'resolve', incident_id=..., summary=...). If the brief output is empty or says the fleet "
            "is healthy, reply with only [SILENT]."
        )
        dispatched = _dispatch_cron(path, interval, prompt, enabled)
        return _json({"script": str(path), "interval_min": interval, "cron": dispatched})

    return _json({"error": f"unknown action {action!r}"})


def _credential_node(store, node_id: str) -> Optional[dict[str, Any]]:
    if not node_id:
        return None
    return store.get_node(node_id) or store.find_node(node_id)


def _link_credential(store, node: dict[str, Any], name: str, reason: str, session: str) -> dict[str, Any]:
    """Add a credential name to an entry's ``credentials:`` frontmatter (never the value)."""
    path = str(node.get("registry_path") or "")
    folder = path.split("/", 1)[0]
    kind = {"servers": "server", "services": "service", "projects": "project"}.get(folder, "service")
    existing = [str(c) for c in (node.get("credentials") or [])]
    if name in existing:
        return {"linked": False, "reason": "entry already references this credential"}
    payload: dict[str, Any] = {
        "id": node["id"],
        "kind": kind,
        "label": node.get("label") or node["id"],
        "status": (node.get("doc_state") or {}).get("status") or "active",
        "credentials": existing + [name],
    }
    for key in ("parent_id", "host_ip", "tailnet_ip", "vmid", "ports", "managed_by",
                "systemd_unit", "project_path", "probe", "recovery_cmd", "auto_heal_policy", "depends_on"):
        if node.get(key) not in (None, "", []):
            payload[key] = node[key]
    result = registry_kb.upsert_entry(
        plugin_config.registry_root(), payload, reason, session_id=session
    )
    return {"linked": True, "entry": result.get("registry_path")}


def infra_credentials(args: dict[str, Any], session_id: str = "", task_id: str = "", **kwargs: Any) -> str:
    store = get_store()
    session = _session(session_id, task_id)
    action = str(args.get("action") or "list").strip().lower()
    name = str(args.get("name") or "").strip().lower()
    root = plugin_config.registry_root()

    if action == "list":
        entries = credential_vault.list_entries()
        declared = credential_vault.declared_refs(root)
        owners: dict[str, list[str]] = {}
        for node_id, names in declared.items():
            for cred in names:
                owners.setdefault(cred, []).append(node_id)
        for entry in entries:
            entry["declared_by"] = sorted(set(owners.get(entry["name"], [])))
            if entry.get("node_id") and entry["node_id"] not in entry["declared_by"]:
                entry["declared_by"].append(entry["node_id"])
        report = credential_vault.scan_report(root)
        return _json(
            {
                "vault": credential_vault.store_info(),
                "count": len(entries),
                "credentials": entries,
                "missing": credential_vault.missing(),
                "unreferenced": credential_vault.unreferenced(),
                "literal_findings": {"count": report["count"], "files": report["files"]},
                "next_step": (
                    "Values are never listed. Use infra_credentials(action='get', name=...) with node_id "
                    "after reading that entry, or action='scan' to migrate remaining literals out of the KB."
                ),
            }
        )

    if action == "get":
        if not name:
            return _json({"error": "name is required"})
        meta = next((e for e in credential_vault.list_entries() if e["name"] == name), None)
        if meta is None:
            return _json(
                {
                    "error": f"credential {name!r} is not stored",
                    "hint": "infra_credentials(action='list') shows declared-but-missing names; store it with action='set'.",
                }
            )
        node_id = str(args.get("node_id") or meta.get("node_id") or "").strip()
        node = _credential_node(store, node_id)
        if node and not store.has_session_read(session, node["id"]):
            store.log_activity(session, "infra_credentials", node["id"], "credential_read", blocked=True,
                               summary=f"refused credential read {name}: entry not read")
            return _json(
                {
                    "error": "read-before-touch: read this node's registry entry before fetching its credential",
                    "node_id": node["id"],
                    "hint": f"call infra_query(node_id='{node['id']}') or read_file on {node.get('registry_path')}, then retry",
                }
            )
        value = credential_vault.get_value(name)
        if value is None:
            return _json({"error": f"credential {name!r} is not stored"})
        store.record_session_read(session, node["id"], "infra_credentials") if node else None
        store.log_activity(session, "infra_credentials", node["id"] if node else None, "credential_read",
                           summary=f"read credential {name}")
        return _json(
            {
                "name": name,
                "value": value,
                "node_id": node["id"] if node else meta.get("node_id"),
                "kind": meta.get("kind"),
                "notes": meta.get("notes"),
                "warning": "Do not paste this value into the registry, a skill, a commit or a chat log.",
            }
        )

    if action == "set":
        value = args.get("value")
        reason = str(args.get("reason") or "").strip()
        if not name:
            return _json({"error": "name is required"})
        if value in (None, ""):
            return _json({"error": "value is required"})
        if not reason:
            return _json({"error": "reason is required — it is recorded in the activity log and change-log.md"})
        node_id = str(args.get("node_id") or "").strip() or None
        try:
            meta = credential_vault.set_value(
                name,
                str(value),
                node_id=node_id,
                kind=str(args.get("kind") or "") or None,
                notes=str(args.get("notes") or ""),
                session_id=session,
                rotate=bool(args.get("rotate")),
            )
        except credential_vault.CredentialError as exc:
            return _json({"error": str(exc)})
        linked: dict[str, Any] = {"linked": False}
        node = _credential_node(store, node_id or "")
        if node and bool(args.get("link_node", True)):
            try:
                linked = _link_credential(store, node, name, f"link credential {name} ({reason})", session)
            except Exception as exc:  # noqa: BLE001 - the value is already safe; report the link failure
                linked = {"linked": False, "error": f"{type(exc).__name__}: {exc}"}
        store.log_activity(session, "infra_credentials", node["id"] if node else None, "credential_set",
                           summary=f"stored credential {name} ({reason})")
        try:
            registry_kb.prepend_change_log(
                root,
                f"{registry_kb._now_est()} — [infra-atlas] credential stored: {name}",
                [
                    f"**Node:** `{node['id']}`" if node else "**Node:** (unowned)",
                    f"**Kind:** {meta.get('kind')} · **Length:** {meta.get('value_length')}",
                    f"**Reason:** {reason}",
                    f"**Source:** session `{session}` (infra-atlas vault)",
                ],
            )
        except Exception:  # noqa: BLE001 - never fail a write because the log is unreadable
            logger.debug("infra-atlas: change-log write failed for credential set", exc_info=True)
        return _json(
            {
                "ok": True,
                "stored": meta,
                "registry_link": linked,
                "value_echoed": False,
                "vault": credential_vault.store_info(),
            }
        )

    if action == "remove":
        reason = str(args.get("reason") or "").strip()
        if not name:
            return _json({"error": "name is required"})
        if not reason:
            return _json({"error": "reason is required"})
        meta = next((e for e in credential_vault.list_entries() if e["name"] == name), None)
        removed = credential_vault.delete_value(name)
        if not removed:
            return _json({"error": f"credential {name!r} is not stored"})
        store.log_activity(session, "infra_credentials", (meta or {}).get("node_id"), "credential_remove",
                           summary=f"removed credential {name} ({reason})")
        try:
            registry_kb.prepend_change_log(
                root,
                f"{registry_kb._now_est()} — [infra-atlas] credential removed: {name}",
                [f"**Reason:** {reason}", f"**Source:** session `{session}` (infra-atlas vault)"],
            )
        except Exception:  # noqa: BLE001
            pass
        return _json({"ok": True, "removed": name, "registry_refs_remain": True})

    if action == "scan":
        report = credential_vault.scan_report(root)
        report["vault"] = credential_vault.store_info()
        report["next_step"] = (
            "For each finding: store the value with infra_credentials(action='set', name=<suggested_name>, "
            "value=..., node_id=...), replace the literal in the Markdown with a `credentials: [name]` "
            "reference, then delete the literal from the entry body."
        )
        return _json(report)

    return _json({"error": f"unknown action {action!r}"})


def _cron_session() -> bool:
    """Whether this process is a cron run (Hermes binds ``HERMES_CRON_SESSION``)."""
    try:
        from gateway.session_context import get_session_env

        value = get_session_env("HERMES_CRON_SESSION")
    except Exception:  # pragma: no cover - trimmed installs
        value = os.environ.get("HERMES_CRON_SESSION", "")
    return bool(str(value or "").strip())


def _agent_scheduling_allowed() -> bool:
    """``cron.allow_agent_scheduling`` — off by default, so a cron run may not self-schedule."""
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
    except Exception:  # pragma: no cover - trimmed installs
        return False
    return bool(((config.get("cron") or {}).get("allow_agent_scheduling")))


def _dispatch_cron(script_path, interval: int, prompt: str, enabled: bool) -> dict[str, Any]:
    """Create/refresh the watchdog job through the host's cron tool."""
    if _ctx is None:
        return {"ok": False, "reason": "no plugin context — run this from an agent session"}
    if _cron_session() and not _agent_scheduling_allowed():
        # Loop prevention: a cron run creating cron jobs is exactly what the
        # host's cron.allow_agent_scheduling gate exists to stop.
        return {
            "ok": False,
            "reason": (
                "refusing to schedule a job from a cron session: set "
                "cron.allow_agent_scheduling: true in config.yaml to permit it"
            ),
        }
    payload = {
        "action": "create",
        "schedule": f"{interval}m",
        "name": "infra-atlas uptime watchdog",
        "prompt": prompt,
        "script": script_path.name,
        "deliver": "origin",
    }
    if not enabled:
        payload["paused"] = True
        payload["paused_reason"] = "paused from infra-atlas"
    try:
        result = _ctx.dispatch_tool("cronjob_manage", payload)
        return {"ok": True, "result": str(result)[:800]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}", "payload": payload}


def _watchdog_status() -> dict[str, Any]:
    try:
        from hermes_constants import get_hermes_home

        script = get_hermes_home() / "scripts" / "infra_atlas_watchdog.py"
    except Exception:  # noqa: BLE001
        return {"installed": False}
    return {"installed": script.exists(), "path": str(script)}


__all__ = [
    "bind_context",
    "infra_query",
    "infra_sweep",
    "infra_diff",
    "infra_upsert",
    "infra_bootstrap",
    "infra_incidents",
    "infra_credentials",
]
