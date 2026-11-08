"""infra-atlas — registry-backed infrastructure graph with a read-before-touch gate.

Registration only wires things up: no sockets, no subprocesses and no database
access here, so ``hermes plugins doctor`` can import and register the plugin in
a sandbox. The first tool call, API request or sweep opens the SQLite store.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

# Hermes imports this directory as the package ``hermes_plugins.infra_atlas``.
# A test collector or a stray ``import __init__`` imports it as a bare module
# instead, where these relative imports resolve against no parent package —
# so the import is guarded and registration refuses politely in that case.
_PACKAGE_MODE = bool(__package__)

if _PACKAGE_MODE:
    from . import config
    from . import hooks
    from . import schemas
    from . import atlas_tools as tools
else:  # pragma: no cover - never the Hermes load path
    config = hooks = schemas = tools = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

TOOLSET = "infra_atlas"
PLUGIN_DIR = Path(__file__).resolve().parent


def _bind_config(ctx) -> None:
    """Route every setting read through the live plugin settings."""

    def getter(key: str, default=None):
        return ctx.get_config(key, default)

    config.configure(getter)


def _register_tools(ctx) -> None:
    handlers = {
        "infra_query": tools.infra_query,
        "infra_sweep": tools.infra_sweep,
        "infra_diff": tools.infra_diff,
        "infra_upsert": tools.infra_upsert,
        "infra_bootstrap": tools.infra_bootstrap,
        "infra_incidents": tools.infra_incidents,
    }
    for name, handler in handlers.items():
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=schemas.ALL[name],
            handler=handler,
            description=schemas.ALL[name]["description"][:160],
            emoji="🗺️",
        )


def _register_hooks(ctx) -> None:
    ctx.register_hook("pre_tool_call", hooks.on_pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.on_post_tool_call)
    ctx.register_hook("on_session_start", hooks.on_session_start)


def _register_skill(ctx) -> None:
    skill_md = PLUGIN_DIR / "skills" / "infra-atlas" / "SKILL.md"
    if not skill_md.exists():
        logger.warning("infra-atlas: bundled skill missing at %s", skill_md)
        return
    ctx.register_skill(
        "infra-atlas",
        skill_md,
        description="Infrastructure protocol: read the registry before touching a host, keep it current, "
        "audit drift, and respond to outages.",
    )


def _register_blueprint(ctx) -> None:
    try:
        ctx.register_automation_blueprint(
            "uptime-watchdog",
            title="Infra Atlas uptime watchdog",
            description=(
                "Every few minutes, probe the registered fleet and resolve drift. The agent is only woken "
                "when something is actually down, and then it gets the node's own registry runbook."
            ),
            category="ops",
            schedule_template="{minute} */{every_hours} * * *",
            prompt_template=(
                "Run `infra_sweep` for {scope}. For each node that is down or stale, follow its registry "
                "entry (managed-by, pitfalls) to fix it, re-sweep to verify, then close the incident with "
                "`infra_incidents(action=\"resolve\")`. Reply [SILENT] when the fleet is healthy."
            ),
            slots=[
                {"name": "every_hours", "type": "text", "label": "Every how many hours?", "default": "1"},
                {"name": "minute", "type": "text", "label": "Minute of the hour", "default": "7"},
                {"name": "scope", "type": "text", "label": "Scope", "default": "the registered fleet"},
            ],
            tags=["ops", "uptime", "infra"],
        )
    except Exception:  # noqa: BLE001 - a blueprint must never block the plugin
        logger.warning("infra-atlas: automation blueprint registration failed", exc_info=True)


def _register_command(ctx) -> None:
    def handle(raw_args: str) -> str:
        try:
            from .store import get_store

            store = get_store()
            counts = store.counts()
            incidents = store.list_incidents(statuses=["open", "healing", "escalated"])
            lines = [
                f"Infra Atlas — {counts['total']} nodes: {counts['matched']} matched, "
                f"{counts['changed']} changed, {counts['unregistered']} unregistered, {counts['stale']} stale",
                f"Guardrail: {config.guardrail_mode()} · Downtime response: {config.auto_heal_mode()} · "
                f"Registry: {config.registry_root()}",
            ]
            if incidents:
                lines.append(f"Open incidents ({len(incidents)}):")
                for incident in incidents[:5]:
                    lines.append(f"  #{incident['id']} {incident['node_label']} — {incident['trigger_error']}")
            else:
                lines.append("No open incidents.")
            if not raw_args.strip():
                lines.append("Tip: /atlas sweep · /atlas drift · open the Infra Atlas page in the desktop app.")
            elif raw_args.strip().startswith("sweep"):
                from . import fusion

                summary = fusion.run_sweep()
                lines = [f"Sweep {summary['sweep_id']} in {summary['duration_ms']}ms: {summary['counts']}"]
            return "\n".join(lines)
        except Exception as exc:  # noqa: BLE001
            return f"infra-atlas: {type(exc).__name__}: {exc}"

    try:
        ctx.register_command("atlas", handle, description="Infra Atlas status, or `/atlas sweep`")
    except Exception:  # noqa: BLE001
        logger.warning("infra-atlas: slash command registration failed", exc_info=True)


def register(ctx) -> None:  # noqa: D401 - host entrypoint
    if not _PACKAGE_MODE:
        raise RuntimeError(
            "infra-atlas was imported as a bare module; Hermes loads it as a plugin package "
            "(hermes_plugins.infra_atlas). Install it under <hermes home>/plugins/infra-atlas."
        )
    _bind_config(ctx)
    tools.bind_context(ctx)
    _register_tools(ctx)
    _register_hooks(ctx)
    _register_skill(ctx)
    _register_blueprint(ctx)
    _register_command(ctx)
    logger.debug("infra-atlas registered: %s", json.dumps(sorted(schemas.ALL)))
