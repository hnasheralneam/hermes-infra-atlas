"""Hermes itself as first-class infrastructure.

Maps the agent's model endpoints, MCP servers and cron jobs onto the graph so
"why is the agent failing" and "why is the fleet quiet" are the same question.
Read-only: config through ``load_config_readonly``, jobs from the cron store.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from . import CollectorResult

logger = logging.getLogger(__name__)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-") or "node"


_CONFIG_ERROR: Optional[str] = None


def _config() -> dict[str, Any]:
    """Read the Hermes config, remembering *why* it failed.

    Returning {} silently made a broken config loader look like "this profile
    models nothing", which then pruned the model endpoints from the graph.
    """
    global _CONFIG_ERROR
    try:
        from hermes_cli.config import load_config_readonly

        _CONFIG_ERROR = None
        return load_config_readonly() or {}
    except Exception as exc:  # noqa: BLE001 - reported through the collector result
        _CONFIG_ERROR = f"{type(exc).__name__}: {exc}"
        logger.warning("infra-atlas: Hermes config unavailable: %s", _CONFIG_ERROR)
        return {}


def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _profile_name() -> str:
    """Active profile, derived from the home path (no private CLI import)."""
    home = hermes_home()
    parts = home.resolve().parts
    if "profiles" in parts:
        index = parts.index("profiles")
        if index + 1 < len(parts):
            return parts[index + 1]
    return os.environ.get("HERMES_PROFILE") or "default"


def _endpoint_node(name: str, base_url: str) -> Optional[dict[str, Any]]:
    if not base_url:
        return None
    parsed = urlparse(base_url if "//" in base_url else f"//{base_url}")
    host = parsed.hostname
    if not host:
        return None
    try:
        port = str(parsed.port) if parsed.port else ("443" if parsed.scheme == "https" else "80")
    except ValueError:
        port = "80"
    probe = base_url.rstrip("/") + "/models" if base_url.startswith("http") else None
    return {
        "id": f"model-{_slug(name)}",
        "kind": "model_endpoint",
        "stratum": 4,
        "label": name,
        "host_ip": host if host.replace(".", "").isdigit() else None,
        "ports": [port],
        "probe": probe,
        "managed_by": "hermes-config",
        "health_status": "unknown",
        "live_state": {"source": "hermes", "base_url": base_url, "provider": name},
    }


def _parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _period_seconds(schedule: dict[str, Any]) -> Optional[int]:
    """Best-effort repetition period for staleness checks."""
    if not isinstance(schedule, dict):
        return None
    kind = str(schedule.get("kind") or "").lower()
    if kind == "interval":
        for key, scale in (("seconds", 1), ("minutes", 60), ("hours", 3600), ("days", 86400)):
            if schedule.get(key):
                try:
                    return int(float(schedule[key]) * scale)
                except (TypeError, ValueError):
                    return None
        return None
    expr = str(schedule.get("expr") or schedule.get("display") or "").strip()
    fields = expr.split()
    if len(fields) != 5:
        return None
    minute, hour, _dom, _month, dow = fields
    if dow != "*" and dow != "?":
        return 7 * 86400 if minute.isdigit() else None
    if hour == "*":
        step = re.match(r"\*/(\d+)", minute)
        if step:
            return int(step.group(1)) * 60
        return 3600
    if hour.startswith("*/"):
        try:
            return int(hour.split("/", 1)[1]) * 3600
        except (IndexError, ValueError):
            return None
    return 86400


def _cron_jobs() -> list[dict[str, Any]]:
    path = hermes_home() / "cron" / "jobs.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return jobs if isinstance(jobs, list) else []


def collect() -> CollectorResult:
    result = CollectorResult(source="hermes")
    config = _config()
    if _CONFIG_ERROR:
        result.errors.append(f"hermes config: {_CONFIG_ERROR}")
    profile = _profile_name()
    agent_id = f"agent-hermes-{_slug(profile)}"
    now = time.time()

    result.nodes.append(
        {
            "id": agent_id,
            "kind": "agent",
            "stratum": 4,
            "label": f"Hermes ({profile})",
            "managed_by": "hermes",
            "health_status": "up",
            "live_state": {
                "source": "hermes",
                "profile": profile,
                "model": (config.get("model") or {}).get("default"),
                "provider": (config.get("model") or {}).get("provider"),
                "home": str(hermes_home()),
            },
            "last_seen_live_at": now,
        }
    )

    # Model endpoints ---------------------------------------------------
    endpoints: dict[str, str] = {}
    model_cfg = config.get("model") or {}
    if isinstance(model_cfg, dict):
        base = model_cfg.get("base_url")
        provider = model_cfg.get("provider") or model_cfg.get("default")
        if base:
            endpoints[str(provider or "primary")] = str(base)
    for entry in config.get("custom_providers") or []:
        if isinstance(entry, dict) and entry.get("base_url"):
            endpoints[str(entry.get("name") or "custom")] = str(entry["base_url"])
    for key, entry in (config.get("providers") or {}).items():
        if isinstance(entry, dict) and entry.get("base_url"):
            endpoints[str(entry.get("name") or key)] = str(entry["base_url"])

    for name, base_url in endpoints.items():
        node = _endpoint_node(name, base_url)
        if not node:
            continue
        result.nodes.append(node)
        result.edges.append(
            {"source_id": agent_id, "target_id": node["id"], "relation": "uses_model", "origin": "live"}
        )

    # MCP servers -------------------------------------------------------
    for name, entry in sorted((config.get("mcp_servers") or {}).items()):
        if not isinstance(entry, dict):
            continue
        result.nodes.append(
            {
                "id": f"svc-mcp-{_slug(name)}",
                "kind": "service",
                "stratum": 4,
                "label": f"MCP: {name}",
                "managed_by": "mcp",
                "health_status": "unknown",
                "live_state": {
                    "source": "hermes",
                    "transport": entry.get("url") and "http" or "stdio",
                    "url": entry.get("url"),
                    "command": entry.get("command"),
                },
            }
        )

    # Cron jobs ---------------------------------------------------------
    for job in _cron_jobs():
        job_id = str(job.get("id") or "")
        name = str(job.get("name") or job_id)
        if not job_id:
            continue
        schedule = job.get("schedule") or {}
        period = _period_seconds(schedule)
        last_run = _parse_dt(job.get("last_run_at"))
        age = now - last_run.timestamp() if last_run else None
        enabled = bool(job.get("enabled", True)) and str(job.get("state")) not in {"paused", "completed"}
        status = str(job.get("last_status") or "")
        health = "up"
        reasons = []
        if not enabled:
            health = "unknown"
            reasons.append("cron job is paused/disabled")
        else:
            if status in {"error", "blocked_config", "delivery_failed"}:
                health = "degraded"
                reasons.append(f"last run status: {status}")
            if age is not None and period and age > 2.5 * period:
                health = "degraded"
                reasons.append(f"stale: last ran {int(age // 60)}m ago (every {period // 60}m)")
            if age is None:
                reasons.append("never ran")
        result.nodes.append(
            {
                "id": f"cron-{_slug(name)}-{job_id[:6]}",
                "kind": "cron",
                "stratum": 4,
                "label": f"cron: {name}",
                "parent_id": agent_id,
                "managed_by": "hermes-cron",
                "health_status": health,
                "live_state": {
                    "source": "hermes",
                    "job_id": job_id,
                    "schedule": schedule.get("display") or schedule.get("expr"),
                    "last_run_at": job.get("last_run_at"),
                    "last_status": status,
                    "enabled": enabled,
                    "no_agent": bool(job.get("no_agent")),
                    "script": job.get("script"),
                    "reasons": reasons,
                    "prompt": str(job.get("prompt") or "")[:500],
                },
                "last_seen_live_at": last_run.timestamp() if last_run else None,
            }
        )
    return result
