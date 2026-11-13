"""Text and CLI surfaces for the atlas: ``/atlas …`` and ``hermes atlas …``.

The desktop page is one way into the graph; a chat (Hermes Desktop's text mode,
the CLI, Discord) is the other. Every subcommand answers from the same store the
page reads, so "what does the atlas think" has one answer in both places.

Design notes:

* Pure text out, no rich tables: these lines are printed by a terminal, a chat
  transcript and a Discord embed, and box-drawing characters wrap badly in two
  of the three.
* Reads never open a sweep, and ``sweep`` is explicit — a listing must not turn
  into 30 seconds of Proxmox calls because someone asked for node ids.
* The registry is the second source: ``entries`` lists what is *documented*,
  ``nodes`` lists what the last sweep *fused*. They differ on purpose.
"""

from __future__ import annotations

import argparse
import shlex
import time
from typing import Any, Optional

DRIFT_ORDER = ["changed", "unregistered", "stale", "matched", "observed", "doc_only"]
KIND_ORDER = [
    "server", "vm", "lxc", "container", "service", "inference", "project",
    "agent", "model_endpoint", "cron", "peer",
]


# -- helpers ----------------------------------------------------------------
def _store():
    from .store import get_store

    return get_store()


def _config():
    from . import config

    return config


def _clip(value: Any, width: int) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def _resolve(store, text: str) -> tuple[Optional[dict[str, Any]], list[dict[str, Any]]]:
    """Exact id / unique slug first, then a substring list so a near-miss still helps.

    ``store.find_node`` refuses an ambiguous substring on purpose (acting on the
    wrong node is worse than asking); in a text surface the useful answer is the
    shortlist, not "no match".
    """
    node = store.get_node(text) or store.find_node(text)
    if node:
        return node, []
    needle = str(text or "").strip().lower()
    if not needle:
        return None, []
    matches = [
        n
        for n in store.list_nodes()
        if needle in " ".join(
            str(n.get(k) or "") for k in ("id", "label", "host_ip", "tailnet_ip", "registry_path")
        ).lower()
    ]
    return None, sorted(matches, key=lambda n: str(n.get("id")))


def _no_match(name: str, candidates: list[dict[str, Any]]) -> str:
    if not candidates:
        return f"No node matches {name!r}. Try `atlas nodes {name}`."
    lines = [f"{name!r} matches {len(candidates)} node(s) — pick one:"]
    for node in candidates[:12]:
        lines.append(f"  {node.get('id'):<28} {node.get('kind'):<12} {_clip(node.get('label'), 40)}")
    if len(candidates) > 12:
        lines.append(f"  … {len(candidates) - 12} more")
    return "\n".join(lines)


def _address(node: dict[str, Any]) -> str:
    ip = node.get("host_ip") or node.get("tailnet_ip") or ""
    ports = [str(p) for p in node.get("ports") or []]
    if ip and ports:
        return f"{ip}:{ports[0]}"
    return ip or (f":{ports[0]}" if ports else "")


def _ago(ts: Any) -> str:
    try:
        delta = max(0.0, time.time() - float(ts))
    except (TypeError, ValueError):
        return "never"
    if delta < 90:
        return f"{round(delta)}s ago"
    if delta < 5400:
        return f"{round(delta / 60)}m ago"
    if delta < 172800:
        return f"{round(delta / 3600)}h ago"
    return f"{round(delta / 86400)}d ago"


def _table(rows: list[list[Any]], headers: list[str], widths: list[int]) -> list[str]:
    lines = []
    header = "  ".join(_clip(cell, w).ljust(w) for cell, w in zip(headers, widths)).rstrip()
    lines.append(header)
    lines.append("  ".join("-" * w for w in widths).rstrip())
    for row in rows:
        cells = [_clip(cell, w).ljust(w) for cell, w in zip(row, widths)]
        lines.append("  ".join(cells).rstrip())
    return lines


def _counts_line(counts: dict[str, int]) -> str:
    parts = []
    for status in DRIFT_ORDER:
        if counts.get(status):
            parts.append(f"{counts[status]} {status.replace('_', ' ')}")
    return ", ".join(parts) or "no nodes yet"


def _counts_summary(counts: dict[str, int]) -> list[str]:
    """Headline always names the two numbers an operator acts on."""
    total = int(counts.get("total") or 0)
    matched = int(counts.get("matched") or 0)
    attention = sum(int(counts.get(k) or 0) for k in ("changed", "unregistered", "stale"))
    other = max(0, total - matched - attention)
    lines = [f"Infra Atlas — {total} nodes: {matched} matched, {attention} need attention, {other} informational"]
    breakdown = _counts_line(counts)
    if breakdown != "no nodes yet":
        lines.append(f"  {breakdown}")
    return lines


# -- subcommands ------------------------------------------------------------
def cmd_status(_args: argparse.Namespace) -> str:
    store, config = _store(), _config()
    counts = store.counts()
    fleet = store.fleet_uptime()
    incidents = store.list_incidents(statuses=["open", "healing", "escalated"], limit=20)
    sweep = store.latest_sweep()
    lines = _counts_summary(counts)
    lines.append(
        f"Registry: {config.registry_root()} · guardrail: {config.guardrail_mode()}"
        f" · downtime response: {config.auto_heal_mode()}"
    )
    if sweep:
        lines.append(
            f"Last sweep: #{sweep.get('id')} {_ago(sweep.get('ts'))}"
            f" ({sweep.get('duration_ms')} ms, {sweep.get('summary') or 'no change summary'})"
        )
    else:
        lines.append("Last sweep: none yet — run `atlas sweep`")
    lines.append(
        f"Fleet: {fleet.get('monitored_nodes', 0)} monitored, {fleet.get('down_nodes', 0)} down,"
        f" {fleet.get('avg_uptime_24h_pct', 100.0)}% average 24h uptime"
    )
    if incidents:
        lines.append(f"Open incidents ({len(incidents)}):")
        for incident in incidents:
            lines.append(
                f"  #{incident.get('id')} {_clip(incident.get('node_label'), 28)}"
                f" [{incident.get('status')}] {_clip(incident.get('trigger_error'), 48)}"
                f" (opened {_ago(incident.get('started_at'))})"
            )
    else:
        lines.append("Open incidents: none")
    lines.append("More: nodes · drift · incidents · uptime · entries · show <id>  (in chat: /atlas …; in a shell: hermes atlas …)")
    return "\n".join(lines)


def cmd_nodes(args: argparse.Namespace) -> str:
    store = _store()
    nodes = store.list_nodes(kind=args.kind, drift_status=args.drift, health_status=args.health)
    if args.search:
        needle = args.search.lower()
        nodes = [
            n
            for n in nodes
            if needle in " ".join(str(n.get(k) or "") for k in ("id", "label", "host_ip", "tailnet_ip", "registry_path")).lower()
        ]
    if not nodes:
        return "No nodes match. Run `atlas sweep` first, or widen the filter."
    nodes.sort(key=lambda n: (
        int(n.get("stratum") or 9),
        KIND_ORDER.index(str(n.get("kind"))) if str(n.get("kind")) in KIND_ORDER else len(KIND_ORDER),
        str(n.get("id")),
    ))
    limit = args.limit or len(nodes)
    rows = [
        [
            n.get("id"),
            n.get("kind"),
            n.get("drift_status"),
            n.get("health_status"),
            _address(n),
            n.get("label"),
        ]
        for n in nodes[:limit]
    ]
    lines = _table(rows, ["ID", "KIND", "DRIFT", "HEALTH", "ADDRESS", "LABEL"], [26, 14, 13, 7, 22, 34])
    lines.append(f"{len(nodes)} node(s)" + (f", showing {limit}" if len(nodes) > limit else ""))
    return "\n".join(lines)


def cmd_drift(args: argparse.Namespace) -> str:
    store = _store()
    statuses = ["changed", "unregistered", "stale"] if not args.all else DRIFT_ORDER
    nodes = [n for n in store.list_nodes() if str(n.get("drift_status")) in statuses]
    if not nodes:
        return "No drift: every documented node matches what the sweep observed."
    nodes.sort(key=lambda n: (DRIFT_ORDER.index(str(n.get("drift_status"))), str(n.get("id"))))
    lines = []
    for node in nodes:
        lines.append(
            f"{node.get('drift_status', '?'):<13} {node.get('id')}  [{node.get('kind')}]"
            f" {_clip(node.get('label'), 38)}"
        )
        for reason in (node.get("drift_reasons") or [])[:3]:
            lines.append(f"    · {reason}")
        if not node.get("drift_reasons") and node.get("drift_status") == "stale":
            lines.append(f"    · documented active, probe {node.get('probe') or 'n/a'} answered nothing")
    lines.append(f"{len(nodes)} node(s) listed")
    return "\n".join(lines)


def cmd_incidents(args: argparse.Namespace) -> str:
    store = _store()
    statuses = None if args.all else ["open", "healing", "escalated"]
    incidents = store.list_incidents(statuses=statuses, limit=args.limit or 25)
    fleet = store.fleet_uptime()
    lines = [
        f"Fleet: {fleet.get('monitored_nodes', 0)} monitored, {fleet.get('down_nodes', 0)} down,"
        f" {fleet.get('avg_uptime_24h_pct', 100.0)}% average 24h uptime",
    ]
    if not incidents:
        lines.append("No incidents recorded." if args.all else "No open incidents.")
        return "\n".join(lines)
    rows = [
        [
            f"#{i.get('id')}",
            i.get("status"),
            i.get("node_id"),
            _clip(i.get("trigger_error"), 46),
            _ago(i.get("started_at")),
        ]
        for i in incidents
    ]
    lines += _table(rows, ["ID", "STATUS", "NODE", "TRIGGER", "OPENED"], [5, 9, 26, 46, 12])
    return "\n".join(lines)


def cmd_uptime(args: argparse.Namespace) -> str:
    store = _store()
    fleet = store.fleet_uptime()
    nodes = [n for n in store.list_nodes() if n.get("uptime_24h_pct") is not None and n.get("kind") != "peer"]
    nodes.sort(key=lambda n: float(n.get("uptime_24h_pct") or 100.0))
    limit = args.limit or 15
    rows = [
        [
            n.get("id"),
            f"{float(n.get('uptime_24h_pct') or 0):.1f}%",
            n.get("health_status"),
            f"{round(float(n.get('latency_ms') or 0))} ms" if n.get("latency_ms") else "",
            n.get("probe") or "",
        ]
        for n in nodes[:limit]
    ]
    lines = [
        f"24h fleet uptime {fleet.get('avg_uptime_24h_pct')}% across {fleet.get('monitored_nodes')} monitored"
        f" node(s); {fleet.get('down_nodes')} down right now.",
        "",
    ]
    if rows:
        lines += _table(rows, ["NODE", "24H", "HEALTH", "LATENCY", "PROBE"], [26, 7, 7, 9, 40])
        lines.append(f"lowest {len(rows)} of {len(nodes)} probed node(s)")
    else:
        lines.append("No probe samples yet — run `atlas sweep`.")
    return "\n".join(lines)


def cmd_entries(args: argparse.Namespace) -> str:
    """The registry side: what is documented, which is not what the sweep fused."""
    from . import registry_kb

    root = _config().registry_root()
    entries, _edges = registry_kb.parse_registry(root)
    needle = (args.search or "").lower()
    if needle:
        entries = [
            e
            for e in entries
            if needle in " ".join(str(e.get(k) or "") for k in ("id", "label", "registry_path")).lower()
        ]
    entries.sort(key=lambda e: str(e.get("registry_path")))
    if not entries:
        return f"No registry entries under {root}."
    rows = [
        [
            e.get("id"),
            e.get("kind"),
            e.get("status") or e.get("doc_status") or "active",
            _address(e),
            e.get("registry_path"),
        ]
        for e in entries
    ]
    lines = _table(rows, ["ID", "KIND", "STATUS", "ADDRESS", "FILE"], [26, 12, 9, 22, 34])
    lines.append(f"{len(entries)} entr{'y' if len(entries) == 1 else 'ies'} in {root}")
    return "\n".join(lines)


def cmd_show(args: argparse.Namespace) -> str:
    store = _store()
    node, candidates = _resolve(store, args.node)
    if not node:
        return _no_match(args.node, candidates)
    lines = [
        f"{node.get('label')} — {node['id']}",
        f"  kind:     {node.get('kind')} (stratum {node.get('stratum')})",
        f"  drift:    {node.get('drift_status')}",
        f"  health:   {node.get('health_status')}"
        + (f", {round(float(node.get('latency_ms') or 0))} ms" if node.get("latency_ms") else ""),
    ]
    address = _address(node)
    if address:
        lines.append(f"  address:  {address}")
    if node.get("tailnet_ip"):
        lines.append(f"  tailnet:  {node['tailnet_ip']}")
    if node.get("parent_id"):
        lines.append(f"  parent:   {node['parent_id']}")
    lines.append(f"  managed:  {node.get('managed_by') or 'unknown'}"
                 + (f" ({node.get('systemd_unit')})" if node.get("systemd_unit") else ""))
    lines.append(f"  entry:    {node.get('registry_path') or 'UNREGISTERED'}")
    if node.get("probe"):
        lines.append(f"  probe:    {node['probe']}")
    if node.get("uptime_24h_pct") is not None:
        lines.append(f"  uptime:   {float(node['uptime_24h_pct']):.2f}% / 24h")
    if node.get("last_seen_live_at"):
        lines.append(f"  last seen: {_ago(node['last_seen_live_at'])}")
    if node.get("pitfalls_summary"):
        lines.append(f"  pitfalls: {_clip(node['pitfalls_summary'], 200)}")
    reasons = node.get("drift_reasons") or []
    if reasons:
        lines.append("  drift reasons:")
        lines.extend(f"    · {r}" for r in reasons)
    incidents = store.list_incidents(node_id=node["id"], limit=5)
    if incidents:
        lines.append("  incidents:")
        for incident in incidents:
            lines.append(
                f"    #{incident.get('id')} {incident.get('status')} — {_clip(incident.get('trigger_error'), 60)}"
                f" ({_ago(incident.get('started_at'))})"
            )
    lines.append(f"  runbook:  /atlas cat {node['id']}")
    return "\n".join(lines)


def cmd_cat(args: argparse.Namespace) -> str:
    store = _store()
    node, candidates = _resolve(store, args.node)
    if not node:
        return _no_match(args.node, candidates)
    if not node.get("registry_path"):
        return f"{node['id']} has no registry entry (undocumented drift)."
    from . import registry_kb

    return registry_kb.read_entry_text(_config().registry_root(), str(node["registry_path"]))


def cmd_activity(args: argparse.Namespace) -> str:
    store = _store()
    rows = store.recent_activity(limit=args.limit or 20)
    if not rows:
        return "No recorded agent activity against the graph."
    lines = []
    for row in rows:
        flag = "BLOCKED" if row.get("blocked") else row.get("action_kind") or "touch"
        lines.append(
            f"{_ago(row.get('ts')):>8}  {flag:<10} {row.get('node_id') or '—':<26}"
            f" {_clip(row.get('summary'), 70)}"
        )
    return "\n".join(lines)


def cmd_creds(_args: argparse.Namespace) -> str:
    """Names and coverage only — the vault never prints a value."""
    from . import credentials

    entries = credentials.list_entries()
    if not entries:
        return f"Credential vault is empty ({credentials.store_info().get('path', 'no path')})."
    declared = credentials.declared_refs(_config().registry_root())
    owners: dict[str, list[str]] = {}
    for node_id, names in declared.items():
        for name in names:
            owners.setdefault(str(name), []).append(str(node_id))
    lines = []
    for entry in entries:
        name = str(entry.get("name"))
        kind = entry.get("kind") or "secret"
        nodes = ", ".join(sorted(owners.get(name, []))) or "no entry references it"
        lines.append(f"{name:<34} {kind:<14} {nodes}")
    missing = credentials.missing()
    if missing:
        lines.append("")
        lines.append(f"Referenced but missing ({len(missing)}): {', '.join(missing)}")
    lines.append(f"{len(entries)} credential(s); values stay in the vault (infra_credentials tool).")
    return "\n".join(lines)


def cmd_sweep(args: argparse.Namespace) -> str:
    from . import fusion

    requested = [s.strip() for s in (args.sources or "").split(",") if s.strip()]
    summary = fusion.run_sweep(sources=requested or None)
    counts = summary.get("counts") or {}
    scope = ", ".join(requested) if requested else "registry + every enabled collector"
    ran = summary.get("sources") or []
    extra = f" (collectors that answered: {', '.join(ran)})" if ran else ""
    errors = summary.get("errors") or []
    lines = [
        f"Sweep #{summary.get('sweep_id')} finished in {summary.get('duration_ms')} ms"
        f" over {scope}{extra}: {_counts_line(counts)}"
    ]
    if errors:
        lines.append(f"  {len(errors)} collector error(s): {'; '.join(str(e) for e in errors[:3])}")
    return "\n".join(lines)


DISPATCH = {
    "status": cmd_status,
    "nodes": cmd_nodes,
    "drift": cmd_drift,
    "incidents": cmd_incidents,
    "uptime": cmd_uptime,
    "entries": cmd_entries,
    "show": cmd_show,
    "cat": cmd_cat,
    "activity": cmd_activity,
    "creds": cmd_creds,
    "sweep": cmd_sweep,
}


def run(raw_args: str) -> str:
    """Parse one command line (``nodes --kind service``) and render its text."""
    argv = shlex.split(raw_args or "")
    parser = build_parser(prog="/atlas")
    try:
        args = parser.parse_args(argv or ["status"])
    except SystemExit:
        # argparse already wrote its usage to stderr; a slash command needs text.
        return "usage: /atlas [status|nodes|drift|incidents|uptime|entries|show|cat|activity|creds|sweep]"
    handler = DISPATCH.get(args.atlas_command or "status") or cmd_status
    return handler(args)


def build_parser(prog: str = "hermes atlas") -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog,
        description="Inspect the infrastructure knowledge base and the last sweep (read-only except `sweep`).",
    )
    add_subcommands(parser)
    return parser


def add_subcommands(parser: argparse.ArgumentParser) -> None:
    """Attach the subcommand tree to *parser* — shared by the CLI and the slash command."""
    subs = parser.add_subparsers(dest="atlas_command", metavar="<command>")

    subs.add_parser("status", help="node counts, guardrail policy, fleet uptime, open incidents")

    p_nodes = subs.add_parser("nodes", help="list graph nodes (id, kind, drift, health, address)")
    p_nodes.add_argument("search", nargs="?", default=None, help="substring over id/label/address")
    p_nodes.add_argument("--kind", default=None, choices=KIND_ORDER)
    p_nodes.add_argument("--drift", default=None, choices=DRIFT_ORDER)
    p_nodes.add_argument("--health", default=None, choices=["up", "degraded", "down", "unknown"])
    p_nodes.add_argument("--limit", type=int, default=None)

    p_drift = subs.add_parser("drift", help="entries that disagree with reality, with reasons")
    p_drift.add_argument("--all", action="store_true", help="include matched / peer / doc-only nodes")

    p_inc = subs.add_parser("incidents", help="open downtime incidents and fleet uptime")
    p_inc.add_argument("--all", action="store_true", help="include resolved incidents")
    p_inc.add_argument("--limit", type=int, default=None)

    p_up = subs.add_parser("uptime", help="24h probe uptime, worst first")
    p_up.add_argument("--limit", type=int, default=None)

    p_entries = subs.add_parser("entries", help="registry entries on disk (documented side)")
    p_entries.add_argument("search", nargs="?", default=None, help="substring over id/label/path")

    for name, help_text in (("show", "one node: state, entry, incidents"), ("cat", "print a node's registry entry")):
        p_show = subs.add_parser(name, help=help_text)
        p_show.add_argument("node", help="node id (or a unique slug: litellm, flash-8)")

    p_act = subs.add_parser("activity", help="recent agent activity against the graph")
    p_act.add_argument("--limit", "-n", type=int, default=None)

    subs.add_parser("creds", help="credential vault names and coverage (never values)")

    p_sweep = subs.add_parser("sweep", help="run a live sweep, then print the new counts")
    p_sweep.add_argument("--sources", default=None, help="comma list: kb,local,hermes,proxmox,headscale,probes")


def register_cli(subparser: argparse.ArgumentParser) -> None:
    """``hermes atlas …`` — the same subcommand tree, dispatched to the renderers."""
    add_subcommands(subparser)
    subparser.set_defaults(func=atlas_command)


def atlas_command(args: argparse.Namespace) -> int:
    handler = DISPATCH.get(getattr(args, "atlas_command", None) or "status") or cmd_status
    try:
        print(handler(args))
        return 0
    except Exception as exc:  # noqa: BLE001 - a CLI failure must not traceback at the operator
        print(f"infra-atlas: {type(exc).__name__}: {exc}")
        return 1


def slash(raw_args: str) -> str:
    """``/atlas …`` handler: same parser, same renderers, one string back."""
    try:
        return run(raw_args)
    except Exception as exc:  # noqa: BLE001 - never surface a traceback into a chat
        return f"infra-atlas: {type(exc).__name__}: {exc}"
