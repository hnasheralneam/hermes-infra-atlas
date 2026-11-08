"""Reconcile the Markdown knowledge base with live discovery.

The sweep is the single place both sides meet: parse the KB, run the collectors,
correlate observations onto entries, classify drift, persist, then hand the
probe results to the uptime engine. Every other surface (tools, API, UI) reads
what a sweep wrote.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Iterable, Optional

from . import config as plugin_config
from . import registry_kb
from .collectors import CollectorResult, merge, run_source, run_sources
from .store import DRIFT_FIELDS, get_store

logger = logging.getLogger(__name__)

# Runtime-only node kinds: they exist because Hermes exists, so an entry is
# optional and their absence from the KB is not drift.
RUNTIME_KINDS = {"agent", "cron", "model_endpoint", "container"}
# Kinds worth probing even without an explicit probe declaration.
PROBE_KINDS = {"service", "container", "model_endpoint", "vm", "lxc", "server"}


def _slug(text: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-") or "node"


def _ports(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        return sorted({str(p) for p in value})
    if isinstance(value, str):
        import re

        return sorted(set(re.findall(r"\d{2,5}", value)))
    return []


def _field_diffs(doc: dict[str, Any], live: dict[str, Any]) -> list[dict[str, Any]]:
    diffs: list[dict[str, Any]] = []
    for field in DRIFT_FIELDS:
        if field == "health_status":
            continue
        doc_value = doc.get(field)
        live_value = live.get(field)
        if field == "ports":
            doc_ports, live_ports = _ports(doc_value), _ports(live_value)
            if doc_ports and live_ports and set(doc_ports) != set(live_ports):
                diffs.append({"field": "ports", "doc": doc_ports, "live": live_ports})
            continue
        if doc_value in (None, "", []) or live_value in (None, "", []):
            continue
        if str(doc_value).strip().lower() != str(live_value).strip().lower():
            diffs.append({"field": field, "doc": doc_value, "live": live_value})
    return diffs


def _correlate(doc_nodes: list[dict[str, Any]], live_nodes: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Return ``(merged_by_id, matched_doc_ids)``."""
    by_id = {node["id"]: dict(node) for node in doc_nodes}
    index_unit: dict[str, str] = {}
    index_vmid: dict[tuple[int, str], str] = {}
    index_host: dict[str, list[str]] = {}
    for node in doc_nodes:
        if node.get("systemd_unit"):
            index_unit.setdefault(str(node["systemd_unit"]), node["id"])
        if node.get("vmid"):
            index_vmid.setdefault((int(node["vmid"]), str(node.get("kind"))), node["id"])
        if node.get("host_ip"):
            index_host.setdefault(str(node["host_ip"]), []).append(node["id"])

    matched: set[str] = set()
    for live in live_nodes:
        live_id = str(live.get("id") or "")
        if not live_id:
            continue
        target_id: Optional[str] = None
        if live_id in by_id:
            target_id = live_id
        elif live.get("systemd_unit") and str(live["systemd_unit"]) in index_unit:
            target_id = index_unit[str(live["systemd_unit"])]
        elif live.get("vmid") and (int(live["vmid"]), str(live.get("kind"))) in index_vmid:
            target_id = index_vmid[(int(live["vmid"]), str(live.get("kind")))]
        elif live.get("host_ip") and live.get("ports"):
            live_kind = str(live.get("kind") or "")
            live_family = "host" if live_kind in {"server", "vm", "lxc"} else "workload"
            for candidate in index_host.get(str(live["host_ip"]), []):
                doc = by_id[candidate]
                doc_kind = str(doc.get("kind") or "")
                doc_family = "host" if doc_kind in {"server", "vm", "lxc"} else "workload"
                if doc_family != live_family:
                    continue
                if set(_ports(doc.get("ports"))) & set(_ports(live.get("ports"))):
                    target_id = candidate
                    break
        if target_id is None and live.get("tailnet_ip") and str(live.get("kind")) in {"server", "vm", "lxc"}:
            for candidate, doc in by_id.items():
                if str(doc.get("kind")) not in {"server", "vm", "lxc"}:
                    continue
                if str(doc.get("tailnet_ip") or "") == str(live["tailnet_ip"]):
                    target_id = candidate
                    break
        if target_id is None:
            # Runtime nodes and genuinely new hosts are added under their own id.
            by_id[live_id] = dict(live)
            if str(live.get("kind")) not in RUNTIME_KINDS:
                by_id[live_id]["_unregistered"] = True
            else:
                by_id[live_id]["_runtime"] = True
            continue

        merged = by_id[target_id]
        merged["_live"] = {**merged.get("_live", {}), **live}
        for key in ("parent_id", "host_ip", "tailnet_ip", "vmid", "systemd_unit", "managed_by", "label"):
            if not merged.get(key) and live.get(key):
                merged[key] = live[key]
        if live.get("ports") and not merged.get("ports"):
            merged["ports"] = _ports(live["ports"])
        merged.setdefault("live_state", {})
        merged["live_state"] = {**(merged.get("live_state") or {}), **(live.get("live_state") or {})}
        matched.add(target_id)

    # A service whose IP matches a known host inherits it as parent.
    host_by_ip = {
        str(node.get("host_ip")): node["id"]
        for node in by_id.values()
        if node.get("host_ip") and int(node.get("stratum") or 9) <= 2
    }
    for node in by_id.values():
        if not node.get("parent_id") and node.get("host_ip") in host_by_ip:
            parent_id = host_by_ip[str(node["host_ip"])]
            if parent_id != node["id"]:
                node["parent_id"] = parent_id
    return by_id, matched


def _classify(node: dict[str, Any]) -> tuple[str, list[str], list[dict[str, Any]]]:
    """Return ``(drift_status, reasons, field_diffs)``."""
    live = node.get("_live") or {}
    diff = _field_diffs(node.get("doc_state") or node, live) if live else []
    reasons = [f"{d['field']}: registry says {d['doc']}, live is {d['live']}" for d in diff]
    health = str(node.get("health_status") or "unknown")

    if node.get("_runtime"):
        return "matched", [], []
    if str(node.get("kind") or "") == "peer" and not node.get("registry_path"):
        # A device on the tailnet we do not operate as infrastructure: it belongs
        # on the graph, but calling a laptop "undocumented drift" makes the drift
        # number meaningless. Documented peers correlate earlier and never land here.
        return "observed", ["tailnet peer"], []
    if node.get("_unregistered"):
        return "unregistered", [str(node.get("drift_reason") or "alive, no registry entry")], []
    if str(node.get("doc_status") or "active") == "removed":
        return ("unregistered", ["registry marks this entry removed, but it is alive"], []) if live else ("doc_only", [], [])
    if not live and health in {"up", "degraded"}:
        # A probe answered: the node is alive even though no collector described it.
        if health == "degraded":
            return "changed", ["health: the endpoint answers with errors"], []
        return "matched", [], []
    if live:
        if health == "down":
            reasons.append("health: registry says active, but the live unit/probe is failing")
            return "changed", reasons, diff
        return ("changed", reasons, diff) if diff else ("matched", [], [])
    kind = str(node.get("kind") or "")
    if kind in RUNTIME_KINDS:
        return "matched", [], []
    # Without a probe there is no evidence of an outage — "no entry answers"
    # must never be invented.
    if kind == "project" or not node.get("_probed") or not (node.get("probe") or (node.get("host_ip") and node.get("ports"))):
        return "doc_only", [], []
    return "stale", ["registry says active, nothing answered the probe"], []


# Which ``managed_by`` values each collector owns. A sweep prunes only inside
# the families of the collectors that ran, so partial sweeps stay additive.
_OWNER_FAMILIES: dict[str, set[str]] = {
    "local": {"host", "systemd-user", "systemd-system", "docker", "tailscale"},
    "headscale": {"headscale", "tailscale"},
    "proxmox": {"proxmox"},
    "hermes": {"hermes", "hermes-config", "hermes-cron", "mcp"},
    "fixture": set(),  # the demo fleet is a view: it never prunes anything
}


def _owner_families(sources: list[str]) -> set[str]:
    owners: set[str] = set()
    for source in sources:
        owners |= _OWNER_FAMILIES.get(str(source), set())
    return owners


def _probe_targets(nodes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    targets = []
    for node in nodes.values():
        if str(node.get("kind") or "") not in PROBE_KINDS:
            continue
        if node.get("probe") or (node.get("host_ip") and node.get("ports")):
            targets.append(
                {
                    "id": node["id"],
                    "kind": node.get("kind"),
                    "probe": node.get("probe"),
                    "probe_inferred": bool(node.get("probe_inferred")),
                    "host_ip": node.get("host_ip"),
                    "tailnet_ip": node.get("tailnet_ip"),
                    "ports": node.get("ports") or [],
                }
            )
    return targets


def _edges_for(nodes: dict[str, dict[str, Any]], doc_edges: Iterable[dict[str, Any]], live_edges: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    for edge in list(doc_edges) + list(live_edges):
        source, target, relation = edge.get("source_id"), edge.get("target_id"), edge.get("relation")
        if source and target and source in nodes and target in nodes:
            seen.setdefault((source, target, relation), edge)
    for node in nodes.values():
        if node.get("parent_id") and node["parent_id"] in nodes:
            seen.setdefault((node["parent_id"], node["id"], "hosts"), {
                "source_id": node["parent_id"], "target_id": node["id"], "relation": "hosts", "origin": "both",
            })
        if node.get("kind") == "agent":
            continue
    return list(seen.values())


def _enabled(source: str) -> bool:
    if source == "local":
        return bool(plugin_config.setting("enable_local_collector"))
    if source == "hermes":
        return bool(plugin_config.setting("enable_hermes_collector"))
    if source == "probes":
        return bool(plugin_config.setting("enable_probes"))
    if source == "proxmox":
        return bool(str(plugin_config.setting("proxmox_url") or "").strip())
    if source == "headscale":
        return bool(str(plugin_config.setting("headscale_url") or "").strip())
    return False


def _apply_demo(store, session_id: str = "") -> dict[str, Any]:
    from .collectors import fixture as fixture_collector

    payload = fixture_collector.load()
    store.begin_bulk()
    try:
        for node in payload.get("nodes") or []:
            store.upsert_node({**node})
        store.replace_edges(payload.get("edges") or [])
        for incident in payload.get("incidents") or []:
            rows = store.list_incidents(limit=200, node_id=incident["node_id"])
            if any(row.get("trigger_error") == incident.get("trigger_error") for row in rows):
                # Already materialized (possibly resolved since): never reopen it
                # just because the fixture was reloaded.
                continue
            store.create_incident_row(incident)
        for sample in payload.get("probe_history") or []:
            store.insert_probe_sample(sample["node_id"], sample.get("status", "up"), sample.get("latency_ms"), sample.get("detail", ""), ts=sample.get("ts"))
    finally:
        store.end_bulk()
    counts = store.counts()
    sweep_id = store.record_sweep(0, ["fixture"], counts, "demo fleet loaded")
    return {
        "sweep_id": sweep_id,
        "demo": True,
        "duration_ms": 0,
        "sources": ["fixture"],
        "counts": counts,
        "drift": [
            {"id": n["id"], "label": n.get("label"), "drift_status": n.get("drift_status"), "reasons": n.get("drift_reasons") or []}
            for n in store.list_nodes()
            if n.get("drift_status") != "matched"
        ],
        "incidents": {"open": len(store.list_incidents(statuses=["open", "healing", "escalated"]))},
    }


def run_sweep(
    sources: Optional[list[str]] = None,
    probe_timeout: Optional[float] = None,
    trigger_auto_heal: bool = True,
    session_id: str = "",
) -> dict[str, Any]:
    """Parse + collect + correlate + classify + persist. Returns a summary."""
    started = time.monotonic()
    store = get_store()

    if plugin_config.setting("demo_mode") and (not sources or sources == ["fixture"]):
        summary = _apply_demo(store, session_id)
        summary["duration_ms"] = int((time.monotonic() - started) * 1000)
        return summary

    root = plugin_config.registry_root()
    requested = sources or ["kb", "local", "hermes", "proxmox", "headscale", "probes"]
    doc_nodes, doc_edges = registry_kb.parse_registry(root)

    live_results = run_sources(
        [s for s in requested if s not in {"kb", "probes"}],
        enabled=_enabled if not sources else None,
    )
    live = merge(live_results)
    nodes, matched = _correlate(doc_nodes, live.nodes)

    probe_result = CollectorResult(source="probes")
    if "probes" in requested and _enabled("probes"):
        targets = _probe_targets(nodes)
        timeout = probe_timeout if probe_timeout is not None else float(plugin_config.setting("probe_timeout_sec") or 1.5)
        probe_result = run_source("probes", targets=targets, timeout=timeout)
        for observation in probe_result.nodes:
            node = nodes.get(str(observation.get("id")))
            if not node:
                continue
            node["health_status"] = observation.get("health_status") or "unknown"
            node["latency_ms"] = observation.get("latency_ms")
            node["_probed"] = True
            node["live_state"] = {**(node.get("live_state") or {}), **(observation.get("live_state") or {})}
            if observation.get("health_status") == "up":
                node["last_seen_live_at"] = time.time()

    # Classify + normalize before persisting.
    previous = {row["id"]: row for row in store.list_nodes()}
    now = time.time()
    persisted: list[dict[str, Any]] = []
    transitions: list[tuple[dict[str, Any], Optional[str], list[dict[str, Any]]]] = []
    for node in nodes.values():
        status, reasons, diffs = _classify(node)
        node["drift_status"] = status
        node["drift_reasons"] = reasons
        node.setdefault("health_status", "unknown")
        if node.get("_live") and node["health_status"] == "unknown":
            live_health = (node["_live"].get("health_status") or "").strip()
            if live_health:
                node["health_status"] = live_health
        node["live_state"] = {**(node.get("live_state") or {}), **(node.get("_live", {}).get("live_state") or {})}
        node.pop("_live", None)
        node.pop("_unregistered", None)
        node.pop("_runtime", None)
        node.pop("_probed", None)
        node.setdefault("doc_state", {})
        node.setdefault("updated_at", now)
        if not node.get("label"):
            node["label"] = node["id"]
        persisted.append(node)
        prev = previous.get(node["id"])
        prev_status = prev.get("drift_status") if prev else None
        prev_diffs = (prev or {}).get("drift_reasons") or []
        if prev_status != status or (diffs and prev_diffs != reasons):
            transitions.append((node, prev_status, diffs))

    store.begin_bulk()
    try:
        store.upsert_nodes(persisted)
        # Drop only what the collectors that actually ran stopped reporting.
        # A sweep restricted to one source must not erase the others' nodes (a
        # demo swing would otherwise wipe the real inventory until the next
        # full sweep), and a documented node always survives as doc_only.
        owners = _owner_families(requested)
        if owners:
            store.prune_live_nodes(owners, [node["id"] for node in persisted])
        store.replace_edges(_edges_for(nodes, doc_edges, live.edges))
        for observation in probe_result.nodes:
            store.insert_probe_sample(
                str(observation.get("id")),
                str(observation.get("health_status") or "unknown"),
                observation.get("latency_ms"),
                str((observation.get("live_state") or {}).get("probe_detail") or ""),
            )
    finally:
        store.end_bulk()

    counts = store.counts()
    sweep_id = store.record_sweep(
        int((time.monotonic() - started) * 1000),
        [result.source for result in live_results] + (["probes"] if probe_result.nodes else []),
        counts,
        f"{counts['matched']} matched, {counts['changed']} changed, {counts['unregistered']} unregistered, {counts['stale']} stale",
    )
    for node, prev_status, diffs in transitions:
        store.record_drift_event(
            sweep_id,
            node["id"],
            node.get("label") or node["id"],
            prev_status,
            node["drift_status"],
            diffs,
            "; ".join(node.get("drift_reasons") or []) or "state changed",
        )

    incidents = {"opened": [], "healed": [], "open": 0}
    try:
        from . import uptime

        incidents = uptime.evaluate(store, persisted, sweep_id, trigger_auto_heal=trigger_auto_heal, session_id=session_id)
    except Exception:
        logger.warning("infra-atlas: uptime evaluation failed", exc_info=True)

    return {
        "sweep_id": sweep_id,
        "demo": False,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "sources": [result.source for result in live_results] + (["probes"] if probe_result.nodes else []),
        "errors": [error for result in live_results + [probe_result] for error in result.errors],
        "counts": counts,
        "drift": [
            {"id": node["id"], "label": node.get("label"), "drift_status": node["drift_status"], "reasons": node["drift_reasons"]}
            for node in persisted
            if node["drift_status"] != "matched"
        ],
        "incidents": incidents,
    }


def blast_radius(store, node_id: str, depth: int = 3) -> dict[str, Any]:
    """Upstream hosts/dependencies and downstream dependents for one node."""
    edges = store.list_edges()
    nodes = {node["id"]: node for node in store.list_nodes()}
    upstream, downstream = set(), set()
    frontier = {node_id}
    for _ in range(max(1, depth)):
        frontier = {
            edge["source_id"]
            for edge in edges
            if edge["target_id"] in frontier and edge["relation"] in {"hosts", "depends_on", "routes_via"}
        } - {node_id} - upstream
        upstream |= frontier
    frontier = {node_id}
    for _ in range(max(1, depth)):
        frontier = {
            edge["target_id"]
            for edge in edges
            if edge["source_id"] in frontier and edge["relation"] in {"depends_on", "proxies_to", "monitors", "uses_model"}
        } - {node_id} - downstream
        downstream |= frontier
    return {
        "upstream": [{"id": nid, "label": (nodes.get(nid) or {}).get("label"), "kind": (nodes.get(nid) or {}).get("kind")} for nid in sorted(upstream)],
        "downstream": [{"id": nid, "label": (nodes.get(nid) or {}).get("label"), "kind": (nodes.get(nid) or {}).get("kind")} for nid in sorted(downstream)],
    }
