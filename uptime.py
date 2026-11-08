"""Uptime evaluation, incidents, and the two-stage downtime response.

Stage 1 is deterministic: a declared (or inferred) restart command, run only on
the local host, verified by a fresh probe. Stage 2 hands the agent a
self-contained brief built from the node's own registry entry — the wiki the
operator already wrote is the runbook the responder follows.
"""

from __future__ import annotations

import logging
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from . import config as plugin_config

logger = logging.getLogger(__name__)

INCIDENT_KINDS = {"service", "container", "model_endpoint", "vm", "lxc"}
SAFE_PREFIXES = ("systemctl ", "service ", "docker compose ", "docker-compose ", "podman ", "pct ", "qm ")
_HEAL_TIMEOUT = 20
_VERIFY_WAIT = 2.0


# -- eligibility ------------------------------------------------------------
def incident_eligible(node: dict[str, Any]) -> bool:
    live = node.get("live_state") or {}
    if live.get("incident_eligible") is not None:
        return bool(live["incident_eligible"])
    if str(node.get("probe") or "").strip():
        return True
    return str(node.get("kind") or "") in INCIDENT_KINDS


def _parent_down(store, node: dict[str, Any]) -> Optional[dict[str, Any]]:
    parent_id = node.get("parent_id")
    if not parent_id:
        return None
    parent = store.get_node(parent_id)
    if parent and parent.get("health_status") == "down":
        return parent
    return None


def _is_local(node: dict[str, Any], store) -> bool:
    host_ip = str(node.get("host_ip") or "").strip()
    if host_ip in {"", "127.0.0.1", "localhost", "::1"}:
        return True
    try:
        from .collectors import local_host

        return host_ip == (local_host.local_ip() or "")
    except Exception:
        return False


def _policy_for(node: dict[str, Any]) -> str:
    """Node policy wins, then the plugin-wide mode."""
    policy = str(node.get("auto_heal_policy") or "inherit").lower()
    if policy != "inherit":
        return policy
    return plugin_config.auto_heal_mode()


# -- briefs -----------------------------------------------------------------
def remediation_brief(store, node: dict[str, Any], incident: dict[str, Any]) -> str:
    parent = store.get_node(node["parent_id"]) if node.get("parent_id") else None
    parent_line = (
        f"{parent.get('label')} is {parent.get('health_status')}" if parent else "no parent recorded"
    )
    pitfalls = str(node.get("pitfalls_summary") or "").strip() or "none recorded"
    return "\n".join(
        [
            "[INFRA-ATLAS AUTONOMOUS DOWNTIME RESPONDER]",
            f"Incident #{incident.get('id')}: node `{node['id']}` ({node.get('label')}) is DOWN.",
            f"- Probe failure: {incident.get('trigger_error')}",
            f"- Upstream host status: {parent_line}",
            f"- Registry file: {node.get('registry_path') or 'none'}",
            f"- Managed by: {node.get('managed_by') or 'unknown'}"
            f" (unit: {node.get('systemd_unit') or 'n/a'}, host: {node.get('host_ip') or 'n/a'},"
            f" ports: {', '.join(str(p) for p in node.get('ports') or []) or 'n/a'})",
            f"- Documented recovery command: {node.get('recovery_cmd') or 'none'}",
            f"- CRITICAL PITFALLS: {pitfalls}",
            "",
            "Your mission:",
            f"1. Call `infra_query(node_id=\"{node['id']}\")` and read the registry entry before touching anything",
            "   (the read-before-touch guardrail blocks blind operations on registered infrastructure).",
            f"2. Diagnose why `{node['id']}` is down (service status, logs, container/VM state).",
            "3. Remediate following the registry's 'Managed by' and CRITICAL PITFALLS rules.",
            '4. Call `infra_sweep(sources=["probes"])` to verify the node is back UP.',
            f"5. Call `infra_incidents(action=\"resolve\", incident_id={incident.get('id')}, summary=\"<cause and fix>\")`"
            " once verified, or action=\"escalate\" if a human is required.",
        ]
    )


# -- stage 1 ----------------------------------------------------------------
def playbook_heal(store, node: dict[str, Any], incident: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Run the declared restart locally, then verify with a probe."""
    cmd = str(node.get("recovery_cmd") or "").strip()
    node_id = node["id"]
    if not cmd:
        return {"node_id": node_id, "ok": False, "reason": "no recovery_cmd declared or inferred"}
    if not cmd.startswith(SAFE_PREFIXES):
        return {"node_id": node_id, "ok": False, "reason": f"refusing non-allowlisted recovery command: {cmd}"}
    if not _is_local(node, store):
        return {"node_id": node_id, "ok": False, "reason": f"{node.get('host_ip')} is not this host; needs the agent"}
    if incident and int(incident.get("heal_attempts") or 0) >= 2:
        return {"node_id": node_id, "ok": False, "reason": "heal attempt budget exhausted"}

    if incident:
        store.update_incident(
            incident["id"],
            status="healing",
            heal_attempts=int(incident.get("heal_attempts") or 0) + 1,
            last_heal_action=cmd,
        )
    store.set_fields(node_id, last_heal_attempt_at=time.time())
    started = time.monotonic()
    try:
        proc = subprocess.run(
            shlex.split(cmd), capture_output=True, text=True, timeout=_HEAL_TIMEOUT
        )
        rc, output = proc.returncode, (proc.stderr or proc.stdout or "").strip()[:400]
    except (OSError, subprocess.SubprocessError) as exc:
        rc, output = 1, f"{type(exc).__name__}: {exc}"
    time.sleep(_VERIFY_WAIT)

    probe_target = node.get("probe") or (
        f"tcp://{node['host_ip']}:{node['ports'][0]}" if node.get("host_ip") and node.get("ports") else None
    )
    status, latency, detail = "unknown", None, "no probe target"
    if probe_target:
        try:
            from .collectors.probes import probe_url

            status, latency, detail = probe_url(probe_target, timeout=2.0)
        except Exception as exc:  # pragma: no cover
            detail = f"probe raised {exc}"
    elapsed = int((time.monotonic() - started) * 1000)
    store.log_activity(
        "infra-atlas-heal",
        "infra_incidents",
        node_id,
        "auto_heal",
        blocked=False,
        summary=f"playbook `{cmd}` rc={rc} -> {status} ({elapsed}ms)",
    )
    ok = status == "up"
    if ok:
        store.record_probe(node_id, "up", latency, detail)
        if incident:
            store.update_incident(
                incident["id"],
                status="resolved",
                resolved_at=time.time(),
                resolution_summary=f"Auto-healed via local playbook: {cmd} (verified UP in {elapsed}ms)",
            )
        store.reset_failure_streak(node_id)
    return {
        "node_id": node_id,
        "ok": ok,
        "command": cmd,
        "returncode": rc,
        "status": status,
        "latency_ms": latency,
        "detail": detail,
        "output": output,
        "elapsed_ms": elapsed,
    }


# -- sweep evaluation -------------------------------------------------------
def evaluate(
    store,
    nodes: list[dict[str, Any]],
    sweep_id: int,
    trigger_auto_heal: bool = True,
    session_id: str = "",
) -> dict[str, Any]:
    """Open/resolve incidents for one sweep and drive the response ladder."""
    threshold = max(1, int(plugin_config.setting("failure_threshold") or 2))
    cooldown = max(30, int(plugin_config.setting("heal_cooldown_sec") or 300))
    mode = plugin_config.auto_heal_mode()
    opened: list[dict[str, Any]] = []
    healed: list[dict[str, Any]] = []
    now = time.time()

    for node in sorted(nodes, key=lambda item: (int(item.get("stratum") or 3), item["id"])):
        node_id = node["id"]
        health = str(node.get("health_status") or "unknown")
        active = store.active_incident_for(node_id)

        if health == "up":
            store.reset_failure_streak(node_id)
            if active:
                store.update_incident(
                    active["id"],
                    status="resolved",
                    resolved_at=now,
                    resolution_summary=active.get("resolution_summary") or "Recovered on its own (probe is up again).",
                )
                healed.append({"node_id": node_id, "incident_id": active["id"]})
            continue

        if health != "down":
            continue
        if not incident_eligible(node):
            continue

        streak = store.bump_failure_streak(node_id)
        if streak < threshold:
            continue

        parent = _parent_down(store, node)
        hint = (
            f"Upstream host {parent.get('label')} ({parent['id']}) is {parent.get('health_status')}"
            if parent
            else None
        )
        incident = store.open_incident(
            node_id,
            str(node.get("label") or node_id),
            str((node.get("live_state") or {}).get("probe_detail") or "probe failed"),
            streak,
            root_cause_hint=hint,
        )
        if not active:
            opened.append({"node_id": node_id, "incident_id": incident["id"], "reason": incident.get("trigger_error")})
            store.log_activity(
                session_id or "sweep",
                "infra_sweep",
                node_id,
                "incident_opened",
                summary=f"Incident #{incident['id']} opened: {incident.get('trigger_error')}",
            )

        if not trigger_auto_heal or mode == "off" or mode == "notify_only":
            continue
        if parent:
            # Heal the container/host first; restarting a child inside a stopped
            # guest only produces noise.
            continue
        last_attempt = node.get("last_heal_attempt_at") or 0
        if now - float(last_attempt) < cooldown:
            continue

        policy = _policy_for(node)
        if policy in {"off", "notify_only"}:
            continue
        if policy in {"auto", "playbook_only"} and node.get("recovery_cmd"):
            outcome = playbook_heal(store, node, incident)
            if outcome.get("ok"):
                healed.append({"node_id": node_id, "incident_id": incident["id"], "via": "playbook"})

    return {
        "opened": opened,
        "healed": healed,
        "open": len(store.list_incidents(statuses=["open", "healing", "escalated"])),
        "mode": mode,
    }


# -- watchdog ---------------------------------------------------------------
WATCHDOG_SCRIPT = '''#!/usr/bin/env python3
"""infra-atlas uptime watchdog (generated by the plugin; safe to regenerate).

Runs one sweep with the local playbook fast-path, then either stays silent
(`{"wakeAgent": false}`, zero LLM tokens) or prints the incident briefs that
wake the agent. Schedule it with the `infra_incidents` tool
(action="setup_watchdog") or the Infra Atlas desktop page.
"""

import importlib
import importlib.util
import json
import sys
import types

PLUGIN_ROOT = __PLUGIN_ROOT__
PACKAGE = "hermes_plugins.infra_atlas"


def _load_package():
    if PACKAGE in sys.modules:
        return
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []
        sys.modules.setdefault("hermes_plugins", namespace)
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PLUGIN_ROOT + "/__init__.py", submodule_search_locations=[PLUGIN_ROOT]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(PACKAGE, module)
    spec.loader.exec_module(module)


def main() -> int:
    _load_package()
    config = importlib.import_module(PACKAGE + ".config")
    fusion = importlib.import_module(PACKAGE + ".fusion")
    uptime = importlib.import_module(PACKAGE + ".uptime")
    store_module = importlib.import_module(PACKAGE + ".store")

    config.configure(None)
    summary = fusion.run_sweep(trigger_auto_heal=True, session_id="cron-watchdog")
    store = store_module.get_store()
    silent = {"wakeAgent": False}
    pending = store.list_incidents(statuses=["open", "healing"])
    if not pending:
        print(json.dumps(summary.get("counts", {})))
        print(json.dumps(silent))
        return 0
    briefs = []
    for incident in pending:
        node = store.get_node(incident["node_id"])
        if node:
            briefs.append(uptime.remediation_brief(store, node, incident))
    if not briefs:
        print(json.dumps(silent))
        return 0
    print("\\n\\n".join(briefs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def install_watchdog_script(plugin_root: Optional[Path] = None) -> Path:
    """Write the pre-check script under ``$HERMES_HOME/scripts`` and return its path."""
    root = Path(plugin_root or Path(__file__).resolve().parent).resolve()
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    target = home / "scripts" / "infra_atlas_watchdog.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(WATCHDOG_SCRIPT.replace("__PLUGIN_ROOT__", repr(str(root))), encoding="utf-8")
    target.chmod(0o755)
    return target
