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
                "description": "Subset of: kb, local, hermes, proxmox, headscale, probes. Default: all enabled.",
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
        "registry writes the graph recorded, and who touched what, over a time window."
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
        "the runbook prose is preserved), refresh INDEX.md and record the write in the activity ledger. Use action "
        "'adopt_live' to register a node that was discovered running with no entry (drift status "
        "'unregistered'), or 'mark_removed' when a service is gone for good. Call this in the same turn "
        "as any deployment so the docs never drift."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "Node id to create, update or adopt."},
            "action": {"type": "string", "enum": ["upsert", "adopt_live", "mark_removed"], "default": "upsert"},
            "reason": {"type": "string", "description": "Why — recorded in the activity ledger. Required."},
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
            # ``recovery_cmd`` is deliberately absent: it is the one field that
            # names a command the plugin will run, so it is written by the
            # operator in the registry, never by the model through this tool.
            "auto_heal_policy": {
                "type": "string",
                "enum": ["inherit", "auto", "playbook_only", "notify_only", "off"],
            },
            "pitfalls": {"type": "string", "description": "Known traps, surfaced by the guardrail and the responder."},
            "markdown_body": {"type": "string", "description": "Runbook text to append (or the body for a new entry). With replace_body=true this is the full replacement body."},
            "replace_body": {
                "type": "boolean",
                "default": False,
                "description": "Rewrite the runbook body wholesale instead of appending. The only way to shorten or restructure an entry (appends alone are refused when they would shrink it). The previous body is archived under .rewrites/ and recorded in the activity ledger.",
            },
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
        "actually running."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["annotate_existing_kb", "scaffold_from_live"],
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
        "(and unlocks its registry entry); 'heal' restarts the node's documented service through Hermes' "
        "command approval and verifies with a probe (refused where no approval channel exists); "
        "'resolve'/'escalate' close an incident with a summary; 'setup_watchdog' installs the "
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
            "summary": {"type": "string", "description": "Cause and fix, recorded in the activity ledger on resolve/escalate."},
            "interval_min": {"type": "integer", "default": 2, "description": "Watchdog schedule (minutes)."},
            "enabled": {"type": "boolean", "default": True, "description": "setup_watchdog: enable or pause the job."},
        },
    },
}

INFRA_CREDENTIALS = {
    "name": "infra_credentials",
    "description": (
        "Private credential vault for the infrastructure knowledge base. Registry entries reference "
        "credentials by name (`credentials: [name]`) and the value lives in a 0600 vault outside the "
        "registry, encrypted at rest when cryptography is present — never in the Markdown, which is "
        "mirrored and committed. Actions: 'list' (names, owning node, stored/missing — no values), "
        "'get' (the one value, requires the node's entry to be read first when node_id is given), "
        "'set' (store or rotate a value; optionally link it into the entry's frontmatter), "
        "'remove' (delete a value), 'scan' (find credential literals still sitting in the KB)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "get", "set", "remove", "scan"],
                "default": "list",
                "description": "list | get a value | set/rotate a value | remove a value | scan the KB for literals.",
            },
            "name": {
                "type": "string",
                "description": "Credential name, e.g. 'cyberfield-root-ssh'. Lowercase letters, digits, dot, dash, underscore.",
            },
            "value": {
                "type": "string",
                "description": "set only: the secret itself. It is written to the vault and never echoed back.",
            },
            "node_id": {
                "type": "string",
                "description": "Node that owns the credential. On 'get' this enforces the read-before-touch gate; on 'set' it records ownership.",
            },
            "kind": {
                "type": "string",
                "description": "Free-form class: password, ssh-password, api-token, pve-api-token, ldap-password, oidc-client-secret, generic.",
            },
            "notes": {"type": "string", "description": "Where it is valid, how to rotate it. Never put the value here."},
            "reason": {"type": "string", "description": "set/remove: why (written to the activity log)."},
            "rotate": {
                "type": "boolean",
                "default": False,
                "description": "set only: replace an existing credential's value instead of refusing.",
            },
            "link_node": {
                "type": "boolean",
                "default": True,
                "description": "set with node_id: add the name to that entry's `credentials:` frontmatter so the KB knows it exists.",
            },
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
    "infra_credentials": INFRA_CREDENTIALS,
}
