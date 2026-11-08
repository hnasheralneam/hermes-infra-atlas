"""Tool schemas (what the model reads)."""

from __future__ import annotations

_NODE_ID = {
    "type": "string",
    "description": "Node id (e.g. 'svc-litellm', 'lxc-201', 'srv-athena-ai') or a keyword: an IP, "
    "port, hostname, systemd unit or file stem.",
}

INFRA_QUERY = {
    "name": "infra_query",
    "description": (
        "Read the infrastructure knowledge base BEFORE touching anything. Returns the registry runbook "
        "for a node plus its live health, drift state, 24h uptime, open incidents and blast radius "
        "(what hosts it, what depends on it). Calling this unlocks the node for write/terminal "
        "operations in this session — the read-before-you-touch guardrail blocks blind changes."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "node_id": _NODE_ID,
            "kind": {
                "type": "string",
                "description": "Filter: all, server, vm, lxc, container, service, project, cron, agent, model_endpoint.",
                "default": "all",
            },
            "drift_status": {
                "type": "string",
                "description": "Filter: all, matched, changed, unregistered, stale, doc_only.",
                "default": "all",
            },
            "health_status": {"type": "string", "description": "Filter: all, up, degraded, down, unknown.", "default": "all"},
            "include_blast_radius": {"type": "boolean", "default": True},
            "include_markdown": {
                "type": "boolean",
                "default": True,
                "description": "Include the full registry Markdown (only for a single match or up to three).",
            },
        },
    },
}

INFRA_SWEEP = {
    "name": "infra_sweep",
    "description": (
        "Run a live discovery + health sweep: parse the registry, collect local/systemd/Docker/Tailscale, "
        "Hermes runtime, Proxmox and Headscale (whichever are enabled), probe endpoints, recompute drift, "
        "and evaluate uptime incidents. Also runs the safe local restart playbook for a downed service "
        "when the node declares one. Use it to verify a fix or to answer 'what is actually running'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sources": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Subset of: kb, local, hermes, proxmox, headscale, probes, fixture. Default: all enabled.",
            },
            "probe_timeout_sec": {"type": "number", "description": "Per-probe timeout. Default from settings (1.5)."},
            "trigger_auto_heal": {
                "type": "boolean",
                "default": True,
                "description": "Allow the deterministic local playbook to restart a downed service.",
            },
        },
    },
}

INFRA_DIFF = {
    "name": "infra_diff",
    "description": (
        "Answer 'what changed?'. Returns drift transitions (registry vs live), uptime incidents, the "
        "recent change-log entries the graph wrote, and who touched what, over a time window."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "since": {"type": "string", "default": "24h", "description": "'1h', '24h', '7d' or an ISO date."},
            "node_id": {"type": "string", "description": "Limit to one node."},
        },
    },
}

INFRA_UPSERT = {
    "name": "infra_upsert",
    "description": (
        "Write the knowledge base: create or update a node's Markdown registry entry (frontmatter is merged, "
        "the runbook prose is preserved), refresh INDEX.md and prepend a change-log entry. Use action "
        "'adopt_live' to register a node that was discovered running with no entry (drift status "
        "'unregistered'), or 'mark_removed' when a service is gone for good. Call this in the same turn "
        "as any deployment so the docs never drift."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "Node id to create, update or adopt."},
            "action": {"type": "string", "enum": ["upsert", "adopt_live", "mark_removed"], "default": "upsert"},
            "reason": {"type": "string", "description": "Why — written to change-log.md. Required."},
            "kind": {"type": "string", "enum": ["server", "service", "project"]},
            "label": {"type": "string"},
            "host_ip": {"type": "string"},
            "tailnet_ip": {"type": "string"},
            "vmid": {"type": "integer"},
            "ports": {"type": "array", "items": {"type": ["integer", "string"]}},
            "managed_by": {"type": "string"},
            "systemd_unit": {"type": "string"},
            "parent_id": {"type": "string"},
            "depends_on": {"type": "array", "items": {"type": "string"}},
            "probe": {"type": "string", "description": "http(s):// URL or tcp://host:port used for uptime."},
            "recovery_cmd": {"type": "string", "description": "Safe restart command for the local playbook."},
            "auto_heal_policy": {
                "type": "string",
                "enum": ["inherit", "auto", "playbook_only", "notify_only", "off"],
            },
            "pitfalls": {"type": "string", "description": "Known traps, surfaced by the guardrail and the responder."},
            "markdown_body": {"type": "string", "description": "Runbook text to append (or the body for a new entry)."},
            "status": {"type": "string", "enum": ["active", "removed"]},
        },
        "required": ["node_id", "reason"],
    },
}

INFRA_BOOTSTRAP = {
    "name": "infra_bootstrap",
    "description": (
        "Onboard a knowledge base in one call. 'annotate_existing_kb' adds clean YAML frontmatter to legacy "
        "Markdown entries without touching their prose; 'scaffold_from_live' creates entries from what is "
        "actually running; 'load_demo_fixture' fills the graph with the bundled sanitized fleet."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["annotate_existing_kb", "scaffold_from_live", "load_demo_fixture"],
                "default": "annotate_existing_kb",
            },
            "dry_run": {"type": "boolean", "default": False},
        },
    },
}

INFRA_INCIDENTS = {
    "name": "infra_incidents",
    "description": (
        "Uptime incidents and autonomous downtime response. 'list' shows open/healing/escalated and recent "
        "resolved incidents with fleet uptime; 'get' returns the full remediation brief for one incident "
        "(and unlocks its registry entry); 'heal' runs the deterministic local restart playbook and verifies "
        "with a probe; 'resolve'/'escalate' close an incident with a summary; 'setup_watchdog' installs the "
        "zero-token background watchdog (a Hermes cron pre-check that only wakes the agent when something is "
        "actually down)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "get", "heal", "resolve", "escalate", "setup_watchdog"],
                "default": "list",
            },
            "incident_id": {"type": "integer"},
            "node_id": {"type": "string"},
            "summary": {"type": "string", "description": "Cause and fix, appended to change-log.md on resolve/escalate."},
            "interval_min": {"type": "integer", "default": 2, "description": "Watchdog schedule (minutes)."},
            "enabled": {"type": "boolean", "default": True, "description": "setup_watchdog: enable or pause the job."},
        },
    },
}

ALL = {
    "infra_query": INFRA_QUERY,
    "infra_sweep": INFRA_SWEEP,
    "infra_diff": INFRA_DIFF,
    "infra_upsert": INFRA_UPSERT,
    "infra_bootstrap": INFRA_BOOTSTRAP,
    "infra_incidents": INFRA_INCIDENTS,
}
