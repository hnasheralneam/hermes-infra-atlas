"""Uptime evaluation, incidents, and the two-stage downtime response.

Stage 1 is deterministic: a declared (or inferred) restart command, run only on
the local host, verified by a fresh probe. Stage 2 hands the agent a
self-contained brief built from the node's own registry entry — the wiki the
operator already wrote is the runbook the responder follows.
"""

from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from . import config as plugin_config

logger = logging.getLogger(__name__)

INCIDENT_KINDS = {"service", "container", "model_endpoint", "vm", "lxc"}

# The restart playbook is deliberately narrow: exact verbs on exact object
# shapes, nothing that can stop, destroy, exec into or create anything.
#
#   systemctl [--user] restart|start <unit>
#   service <unit> restart|start
#   docker compose [-f <file>] restart|start|up [-d]   (in a registry-declared dir)
#   docker-compose [-f <file>] restart|start|up [-d]
#   pct start <vmid>            qm start <vmid>
#
# Anything else — ``stop``, ``disable``, ``destroy``, ``pct exec``, ``podman run``,
# shell metacharacters, a path outside the registry-declared project dir — is
# refused before approval is even requested.
_UNIT = r"[A-Za-z0-9@:_.\\-]{1,128}"
_VMID = r"\d{1,6}"

_HEAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(rf"^systemctl (?:--user )?(?:restart|start) {_UNIT}$"),
    re.compile(rf"^service {_UNIT} (?:restart|start)$"),
    re.compile(r"^docker(?:-| )compose (?:-f \S+ )?(?:restart|start|up)(?: -d)?$"),
    re.compile(rf"^(?:pct|qm) start {_VMID}$"),
)

# Verbs that must never appear anywhere in a playbook command, even in a shape
# a pattern above would otherwise accept.
_FORBIDDEN_TOKENS = (
    "stop", "destroy", "exec", "run", "kill", "rm", "reboot", "shutdown",
    "disable", "mask", "down", "prune", "pull", "build", "create", "pause",
)

_VERIFY_WAIT = 2.0


def allowlisted_command(cmd: str) -> bool:
    """Whether *cmd* is exactly one allow-listed restart shape."""
    text = " ".join(str(cmd or "").split())
    if not text or len(text) > 200:
        return False
    if any(marker in text for marker in (";", "&", "|", "`", "$(", ">", "<", "\n", "\r", "\\")):
        return False
    if not any(pattern.match(text) for pattern in _HEAL_PATTERNS):
        return False
    return not any(
        re.search(rf"(?:^|\s){token}(?:\s|$)", text) for token in _FORBIDDEN_TOKENS
    )


# -- eligibility ------------------------------------------------------------
def incident_eligible(node: dict[str, Any]) -> bool:
    """Whether a failing node may page someone.

    Only what the registry documents pages: a discovered system unit with no entry
    has no runbook, no owner and nothing to act on, and a failed oneshot (a refresh
    timer with no network) is not an outage. Model endpoints are the one exception —
    they are declared in config, not in the knowledge base.
    """
    documented = bool(str(node.get("registry_path") or "").strip())
    if not documented and str(node.get("kind") or "") != "model_endpoint":
        return False
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
            f"- Documented recovery command: {node.get('recovery_cmd') or 'none'}"
            " (run it through the terminal tool, so Hermes' command approval applies)",
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
def _project_dir_allowed(node: dict[str, Any], cmd: str) -> bool:
    """A compose command may only run in a registry-declared project directory.

    The registry's ``project_path`` is the operator's own declaration; without
    one there is no directory the plugin is allowed to run compose in.
    """
    if not cmd.startswith(("docker compose", "docker-compose")):
        return True
    declared = str(node.get("project_path") or "").strip()
    return bool(declared) and Path(declared).is_absolute()


def run_approved(store, node: dict[str, Any], cmd: str, session_id: str = "") -> dict[str, Any]:
    """Run one allow-listed restart through Hermes' approval gate.

    The command is never executed here. It is handed to the host ``terminal``
    tool, so the same dangerous-command prompt, deny rules and approval modes
    that guard any other shell command apply — a human sees it, or the
    configured unattended/cron policy decides. When no approver is bound (the
    dashboard process, the cron watchdog, a bare import) nothing runs and the
    caller is told the heal needs an agent.
    """
    approver = plugin_config.approver()
    if approver is None:
        return {
            "ok": False,
            "needs_approval": True,
            "command": cmd,
            "reason": (
                "no approval channel in this process: restarts run only from an agent session, "
                "where Hermes' command approval applies"
            ),
        }
    try:
        result = approver(cmd, node=node, session_id=session_id or "infra-atlas-heal")
    except Exception as exc:  # noqa: BLE001 - an approver failure is never a silent run
        return {"ok": False, "needs_approval": True, "command": cmd, "reason": f"approval failed: {exc}"}
    return dict(result or {})


def playbook_heal(
    store,
    node: dict[str, Any],
    incident: Optional[dict[str, Any]] = None,
    session_id: str = "",
) -> dict[str, Any]:
    """Restart the declared service through approval, then verify with a probe."""
    cmd = " ".join(str(node.get("recovery_cmd") or "").split())
    node_id = node["id"]
    if not cmd:
        return {"node_id": node_id, "ok": False, "reason": "no recovery_cmd declared or inferred"}
    if not allowlisted_command(cmd):
        return {
            "node_id": node_id,
            "ok": False,
            "reason": f"refusing non-allowlisted recovery command: {cmd}",
        }
    if not _project_dir_allowed(node, cmd):
        return {
            "node_id": node_id,
            "ok": False,
            "reason": "refusing docker compose outside a registry-declared project_path",
        }
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
    approval = run_approved(store, node, cmd, session_id=session_id)
    if approval.get("needs_approval") or approval.get("approved") is False:
        reason = str(approval.get("reason") or "the restart was not approved")
        store.log_activity(
            session_id or "infra-atlas-heal",
            "infra_incidents",
            node_id,
            "auto_heal_blocked",
            blocked=True,
            summary=f"restart `{cmd}` not run: {reason}",
        )
        return {
            "node_id": node_id,
            "ok": False,
            "needs_approval": True,
            "command": cmd,
            "reason": reason,
            "status": "not_run",
        }
    rc = int(approval.get("returncode", approval.get("exit_code", 0)) or 0)
    output = str(approval.get("output") or "")[:400]
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
                summary = active.get("resolution_summary") or "Recovered on its own (probe is up again)."
                store.update_incident(
                    active["id"],
                    status="resolved",
                    resolved_at=now,
                    resolution_summary=summary,
                )
                try:
                    from . import registry_kb
                    from .hooks import _broadcast

                    registry_kb.prepend_change_log(
                        plugin_config.registry_root(),
                        f"{registry_kb._now_est()} — [infra-atlas] incident #{active['id']} auto-resolved: {node_id}",
                        [
                            f"**Node:** `{node_id}` ({node.get('registry_path') or 'no entry'})",
                            f"**Trigger:** {active.get('trigger_error')}",
                            f"**Outcome:** {summary}",
                        ],
                    )
                    _broadcast("incident.resolved", {"incident_id": active["id"], "node_id": node_id, "status": "resolved"})
                except Exception:  # noqa: BLE001
                    pass
                healed.append({"node_id": node_id, "incident_id": active["id"]})
            continue

        if health != "down":
            continue
        if not incident_eligible(node):
            # Not something that can page (no registry entry, no runbook). If an
            # incident was opened before this rule applied, close it now.
            if active:
                store.update_incident(
                    active["id"],
                    status="resolved",
                    resolved_at=now,
                    resolution_summary="Not an incident: the node has no registry entry to act on.",
                )
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
            outcome = playbook_heal(store, node, incident, session_id=session_id)
            if outcome.get("ok"):
                healed.append({"node_id": node_id, "incident_id": incident["id"], "via": "playbook"})
            elif outcome.get("needs_approval"):
                # No approval channel (cron watchdog, dashboard): the incident
                # stays open and its brief wakes the agent, which is the only
                # context where a restart can be approved.
                store.log_activity(
                    session_id or "sweep",
                    "infra_sweep",
                    node_id,
                    "auto_heal_blocked",
                    blocked=True,
                    summary=f"restart awaiting approval: {outcome.get('reason')}",
                )

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
    # A watchdog that cannot read its own state must stay quiet: waking the agent
    # about a locked database every tick is noise, not an outage report.
    try:
        return _run()
    except Exception as exc:  # noqa: BLE001
        # Silent by design: the job delivers stdout verbatim, and a watchdog that
        # cannot read its own state must not page anyone about itself.
        print(f"infra-atlas watchdog skipped: {exc}", file=sys.stderr)
        return 0


def _run() -> int:
    _load_package()
    config = importlib.import_module(PACKAGE + ".config")
    fusion = importlib.import_module(PACKAGE + ".fusion")
    uptime = importlib.import_module(PACKAGE + ".uptime")
    store_module = importlib.import_module(PACKAGE + ".store")

    config.configure(None)
    # The watchdog runs in a cron process with no approval channel, so it never
    # attempts a restart: it opens incidents and prints the briefs that wake the
    # agent, which is where a heal can be approved. ``trigger_auto_heal=False``
    # is what enforces that, not the configured mode.
    summary = fusion.run_sweep(trigger_auto_heal=False, session_id="cron-watchdog")
    store = store_module.get_store()
    pending = store.list_incidents(statuses=["open", "healing", "escalated"])
    if not pending:
        return 0  # nothing to say: empty stdout sends nothing
    briefs = []
    for incident in pending:
        node = store.get_node(incident["node_id"])
        if node:
            store.record_session_read("cron-watchdog", node["id"], "watchdog")
            briefs.append(uptime.remediation_brief(store, node, incident))
        else:
            # The node left the graph (renamed or pruned) but the incident is still
            briefs.append(
                "## " + str(incident["node_id"]) + " — open incident, node no longer in the graph | "
                + "#" + str(incident["id"]) + " (" + str(incident["status"]) + "): "
                + str(incident.get("trigger_error") or "unknown error")
                + " | no graph node matches this id; confirm with infra_sweep, then close the incident."
            )
    if not briefs:
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
