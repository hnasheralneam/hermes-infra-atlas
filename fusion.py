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
# Hermes runtime nodes live in Stratum 4 and must never be swallowed into Stratum 3/1 doc nodes.
HERMES_RUNTIME_KINDS = {"agent", "cron", "model_endpoint"}
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
        if field == "managed_by" and {str(doc_value).strip().lower(), str(live_value).strip().lower()} <= {"host", "proxmox"}:
            continue
        if str(doc_value).strip().lower() != str(live_value).strip().lower():
            diffs.append({"field": field, "doc": doc_value, "live": live_value})
    return diffs


def _correlate(doc_nodes: list[dict[str, Any]], live_nodes: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Return ``(merged_by_id, matched_doc_ids)``."""
    by_id = {node["id"]: dict(node) for node in doc_nodes}
    index_unit: dict[str, str] = {}
    index_vmid: dict[int, str] = {}
    index_host: dict[str, list[str]] = {}
    index_alias: dict[str, str] = {}
    documented_vmids: dict[int, str] = {}
    for node in doc_nodes:
        if node.get("systemd_unit"):
            index_unit.setdefault(str(node["systemd_unit"]), node["id"])
        if node.get("vmid"):
            documented_vmids.setdefault(int(node["vmid"]), str(node.get("registry_path") or ""))
            if str(node.get("kind")) in {"server", "vm", "lxc"}:
                index_vmid.setdefault(int(node["vmid"]), node["id"])
        for gvmid in node.get("guest_vmids") or []:
            documented_vmids.setdefault(int(gvmid), str(node.get("registry_path") or ""))
        if node.get("host_ip"):
            index_host.setdefault(str(node["host_ip"]), []).append(node["id"])
        for alias in node.get("aliases") or []:
            slug = _slug(alias)
            if slug:
                index_alias.setdefault(slug, node["id"])
                index_alias.setdefault(f"srv-{slug}", node["id"])

    matched: set[str] = set()
    id_remap: dict[str, str] = {}
    for live in live_nodes:
        live_id = str(live.get("id") or "")
        if not live_id:
            continue
        live_kind = str(live.get("kind") or "")
        if live_kind in HERMES_RUNTIME_KINDS:
            by_id[live_id] = dict(live)
            by_id[live_id]["_runtime"] = True
            continue

        target_id: Optional[str] = None
        if live_id in by_id:
            doc_cand = by_id[live_id]
            # Do not let a tailnet peer or local host overwrite a documented server whose LAN IP differs.
            if (
                live_kind in {"server", "vm", "lxc", "peer"}
                and doc_cand.get("host_ip")
                and live.get("host_ip")
                and str(doc_cand["host_ip"]) != str(live["host_ip"])
            ):
                target_id = None
            else:
                target_id = live_id
        elif live_id in index_alias:
            target_id = index_alias[live_id]
        elif live.get("label") and _slug(str(live["label"])) in index_alias:
            target_id = index_alias[_slug(str(live["label"]))]
        elif live.get("systemd_unit") and str(live["systemd_unit"]) in index_unit:
            target_id = index_unit[str(live["systemd_unit"])]
        elif live.get("vmid") and live_kind in {"server", "vm", "lxc"} and int(live["vmid"]) in index_vmid:
            target_id = index_vmid[int(live["vmid"])]
        elif live.get("host_ip"):
            live_family = "host" if live_kind in {"server", "vm", "lxc"} else "workload"
            host_candidates = [
                cand
                for cand in index_host.get(str(live["host_ip"]), [])
                if ("host" if str(by_id[cand].get("kind") or "") in {"server", "vm", "lxc"} else "workload") == live_family
            ]
            if live.get("ports"):
                for candidate in host_candidates:
                    doc = by_id[candidate]
                    if set(_ports(doc.get("ports"))) & set(_ports(live.get("ports"))):
                        target_id = candidate
                        break
            if target_id is None and live_family == "host" and len(host_candidates) == 1:
                target_id = host_candidates[0]
        if target_id is None and live.get("tailnet_ip") and live_kind in {"server", "vm", "lxc", "peer"}:
            for candidate, doc in by_id.items():
                if str(doc.get("kind")) not in {"server", "vm", "lxc"}:
                    continue
                if doc.get("host_ip") and live.get("host_ip") and str(doc["host_ip"]) != str(live["host_ip"]):
                    continue
                if str(doc.get("tailnet_ip") or "") == str(live["tailnet_ip"]):
                    target_id = candidate
                    break
        if target_id is None:
            # Runtime nodes, guests backing a documented service/hypervisor VMID, and genuinely new hosts are added under their own id.
            by_id[live_id] = dict(live)
            if live_kind in RUNTIME_KINDS:
                by_id[live_id]["_runtime"] = True
            elif live_kind in {"vm", "lxc"} and live.get("vmid") and int(live["vmid"]) in documented_vmids:
                by_id[live_id]["_runtime"] = True
                doc_path = documented_vmids.get(int(live["vmid"]))
                if doc_path and not by_id[live_id].get("registry_path"):
                    by_id[live_id]["registry_path"] = doc_path
            else:
                by_id[live_id]["_unregistered"] = True
            continue

        if live_id != target_id:
            id_remap[live_id] = target_id
        merged = by_id[target_id]
        # A tailnet peer observation enriches tailnet_ip/online status without clobbering server kind/ports.
        if live_kind == "peer" and str(merged.get("kind")) in {"server", "vm", "lxc"}:
            if not merged.get("tailnet_ip") and live.get("tailnet_ip"):
                merged["tailnet_ip"] = live["tailnet_ip"]
            merged.setdefault("live_state", {})
            merged["live_state"] = {**(merged.get("live_state") or {}), **(live.get("live_state") or {})}
            if merged.get("health_status") in (None, "unknown") and live.get("health_status") == "up":
                merged["health_status"] = "up"
            matched.add(target_id)
            continue

        merged["_live"] = {**merged.get("_live", {}), **live}
        for key in ("parent_id", "host_ip", "tailnet_ip", "vmid", "systemd_unit", "managed_by", "label"):
            if not merged.get(key) and live.get(key):
                merged[key] = live[key]
        if live.get("ports") and not merged.get("ports"):
            merged["ports"] = _ports(live["ports"])
        merged.setdefault("live_state", {})
        merged["live_state"] = {**(merged.get("live_state") or {}), **(live.get("live_state") or {})}
        matched.add(target_id)

    # Remap parent_id when a live host (e.g. srv-bossagent-home) correlated onto a documented server id.
    if id_remap:
        for node in by_id.values():
            pid = node.get("parent_id")
            if pid and pid in id_remap:
                node["parent_id"] = id_remap[pid]

    # Link services with a vmid to the corresponding Proxmox guest when present, else inherit host by IP.
    guest_by_vmid = {
        int(node["vmid"]): node["id"]
        for node in by_id.values()
        if node.get("vmid") and str(node.get("kind")) in {"vm", "lxc"}
    }
    host_by_ip = {
        str(node.get("host_ip")): node["id"]
        for node in by_id.values()
        if node.get("host_ip") and int(node.get("stratum") or 9) <= 2 and str(node.get("kind")) != "peer"
    }
    for node in by_id.values():
        if node.get("vmid") and str(node.get("kind")) in {"service", "project"}:
            guest_id = guest_by_vmid.get(int(node["vmid"]))
            if guest_id and guest_id != node["id"]:
                node["parent_id"] = guest_id
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
            if str(node.get("auto_heal_policy") or "") == "off" and str((live.get("live_state") or {}).get("status") or "") == "stopped":
                return ("changed", reasons, diff) if diff else ("matched", [], [])
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
    if health == "unknown":
        # The probe could not reach the node from this host (no route, timeout):
        # that says nothing about the node, so it is not drift.
        return "doc_only", [], []
    return "stale", ["registry says active, nothing answered the probe"], []


# Which ``managed_by`` values each collector owns. A sweep prunes only inside
# the families of the collectors that ran, so partial sweeps stay additive.
_OWNER_FAMILIES: dict[str, set[str]] = {
    "local": {"host", "systemd-user", "systemd-system", "docker", "tailscale"},
    "headscale": {"headscale", "tailscale"},
    "proxmox": {"proxmox"},
    "hermes": {"hermes", "hermes-config", "hermes-cron", "mcp"},
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
        if str(node.get("doc_status") or "active") == "removed":
            continue
        if node.get("probe") or (not node.get("registry_path") and node.get("host_ip") and node.get("ports")):
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

    # Connect model_endpoint nodes to the infrastructure service/server that serves them.
    infra_by_addr_port: dict[tuple[str, str], str] = {}
    infra_by_addr: dict[str, str] = {}
    for node in nodes.values():
        if str(node.get("kind") or "") in HERMES_RUNTIME_KINDS or str(node.get("kind") or "") == "peer":
            continue
        ip = str(node.get("host_ip") or "").strip()
        if not ip:
            continue
        if str(node.get("kind")) in {"server", "vm", "lxc"}:
            infra_by_addr.setdefault(ip, node["id"])
        for p in _ports(node.get("ports")):
            if str(node.get("kind")) == "service":
                infra_by_addr_port[(ip, p)] = node["id"]
            else:
                infra_by_addr_port.setdefault((ip, p), node["id"])

    for node in nodes.values():
        if str(node.get("kind")) == "model_endpoint":
            ip = str(node.get("host_ip") or "").strip()
            if not ip:
                continue
            ports = _ports(node.get("ports"))
            provider_id = None
            for p in ports:
                if (ip, p) in infra_by_addr_port:
                    provider_id = infra_by_addr_port[(ip, p)]
                    break
            if not provider_id:
                provider_id = infra_by_addr.get(ip)
            if provider_id and provider_id != node["id"]:
                seen.setdefault((node["id"], provider_id, "depends_on"), {
                    "source_id": node["id"], "target_id": provider_id, "relation": "depends_on", "origin": "live",
                })
        elif str(node.get("kind")) == "cron":
            live_state = node.get("live_state") or {}
            haystack = " ".join(
                str(x or "") for x in (node.get("label"), live_state.get("script"), live_state.get("prompt"))
            ).lower()
            if not haystack.strip():
                continue
            monitored = 0
            for cand in nodes.values():
                if cand["id"] == node["id"] or str(cand.get("kind")) in HERMES_RUNTIME_KINDS or str(cand.get("kind")) == "peer":
                    continue
                if not cand.get("registry_path"):
                    continue
                stem = str(cand["registry_path"]).rsplit("/", 1)[-1].removesuffix(".md").lower()
                if len(stem) >= 4 and (stem in haystack or cand["id"].lower() in haystack):
                    seen.setdefault((node["id"], cand["id"], "monitors"), {
                        "source_id": node["id"], "target_id": cand["id"], "relation": "monitors", "origin": "live",
                    })
                    monitored += 1
                    if monitored >= 3:
                        break
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


def run_sweep(
    sources: Optional[list[str]] = None,
    probe_timeout: Optional[float] = None,
    trigger_auto_heal: bool = True,
    session_id: str = "",
) -> dict[str, Any]:
    """Parse + collect + correlate + classify + persist. Returns a summary."""
    started = time.monotonic()
    store = get_store()
    store.purge_fixture_artifacts()

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
        node.setdefault("health_status", "unknown")
        if node.get("_live") and node["health_status"] == "unknown":
            live_health = (node["_live"].get("health_status") or "").strip()
            if live_health == "down" and str(node.get("auto_heal_policy") or "") == "off" and str((node["_live"].get("live_state") or {}).get("status") or "") == "stopped":
                live_health = "unknown"
            if live_health:
                node["health_status"] = live_health
        status, reasons, diffs = _classify(node)
        node["drift_status"] = status
        node["drift_reasons"] = reasons
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
            # A node that vanished takes its open incidents with it.
            store.close_incidents_for_missing_nodes()
        store.replace_edges(_edges_for(nodes, doc_edges, live.edges))
        probed_ids = []
        for observation in probe_result.nodes:
            obs_id = str(observation.get("id") or "")
            if not obs_id:
                continue
            probed_ids.append(obs_id)
            store.insert_probe_sample(
                obs_id,
                str(observation.get("health_status") or "unknown"),
                observation.get("latency_ms"),
                str((observation.get("live_state") or {}).get("probe_detail") or ""),
            )
        if probed_ids:
            store.recompute_uptime_24h(probed_ids)
            store.prune_probe_samples(keep_per_node=200, days=7)
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
        next_up = {
            edge["source_id"]
            for edge in edges
            if edge["target_id"] in frontier and edge["relation"] in {"hosts", "routes_via"}
        } | {
            edge["target_id"]
            for edge in edges
            if edge["source_id"] in frontier and edge["relation"] in {"depends_on", "uses_model"}
        }
        frontier = next_up - {node_id} - upstream
        upstream |= frontier
    frontier = {node_id}
    for _ in range(max(1, depth)):
        next_down = {
            edge["target_id"]
            for edge in edges
            if edge["source_id"] in frontier and edge["relation"] in {"hosts", "proxies_to", "monitors"}
        } | {
            edge["source_id"]
            for edge in edges
            if edge["target_id"] in frontier and edge["relation"] in {"depends_on", "uses_model", "routes_via"}
        }
        frontier = next_down - {node_id} - downstream
        downstream |= frontier
    return {
        "upstream": [{"id": nid, "label": (nodes.get(nid) or {}).get("label"), "kind": (nodes.get(nid) or {}).get("kind")} for nid in sorted(upstream)],
        "downstream": [{"id": nid, "label": (nodes.get(nid) or {}).get("label"), "kind": (nodes.get(nid) or {}).get("kind")} for nid in sorted(downstream)],
    }
