"""Proxmox VE as a live source (opt-in).

Read-only API calls; the token secret is read through Hermes' secret scope, and
TLS verification follows the ``proxmox_verify_tls`` setting (homelab clusters
almost always use the self-signed certificate PVE generates).
"""

from __future__ import annotations

import json
import logging
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from . import CollectorResult

logger = logging.getLogger(__name__)

SEVERITY = {"stopped": "down", "paused": "degraded", "suspended": "degraded", "running": "up"}


def _base_url() -> str:
    from .. import config as plugin_config

    url = str(plugin_config.setting("proxmox_url") or "").strip().rstrip("/")
    if url and not url.startswith(("http://", "https://")):
        url = "https://" + url
    if url and ":" not in url.split("://", 1)[-1]:
        url += ":8006"
    return url


def _request(base: str, path: str, token_id: str, secret: str, verify: bool, timeout: float = 5.0) -> Any:
    url = f"{base}/api2/json{path}"
    request = urllib.request.Request(url, headers={"Authorization": f"PVEAPIToken={token_id}={secret}"})
    context = ssl.create_default_context()
    if not verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        payload = json.loads(response.read().decode("utf-8", "replace"))
    return payload.get("data")


def collect() -> CollectorResult:
    from .. import config as plugin_config

    result = CollectorResult(source="proxmox")
    base = _base_url()
    token_id = str(plugin_config.setting("proxmox_token_id") or "").strip()
    secret = plugin_config.secret("INFRA_ATLAS_PROXMOX_TOKEN_SECRET")
    if not base or not token_id or not secret:
        return result  # opt-in: silently idle until configured
    verify = bool(plugin_config.setting("proxmox_verify_tls"))

    try:
        nodes = _request(base, "/nodes", token_id, secret, verify) or []
    except (urllib.error.URLError, OSError, ValueError) as exc:
        result.errors.append(f"proxmox /nodes: {exc}")
        return result

    for node in nodes:
        name = str(node.get("node") or "").strip()
        if not name:
            continue
        node_id = f"srv-{name}"
        status = str(node.get("status") or "unknown")
        result.nodes.append(
            {
                "id": node_id,
                "kind": "server",
                "stratum": 1,
                "label": name,
                "managed_by": "proxmox",
                "health_status": "up" if status == "online" else "down",
                "live_state": {
                    "source": "proxmox",
                    "pve_status": status,
                    "cpu": node.get("cpu"),
                    "maxmem": node.get("maxmem"),
                    "mem": node.get("mem"),
                    "uptime": node.get("uptime"),
                },
                "last_seen_live_at": time.time() if status == "online" else None,
            }
        )
        for endpoint, kind, prefix in (("/qemu", "vm", "vm"), ("/lxc", "lxc", "lxc")):
            try:
                guests = _request(base, f"/nodes/{name}{endpoint}", token_id, secret, verify) or []
            except (urllib.error.URLError, OSError, ValueError) as exc:
                result.errors.append(f"proxmox {endpoint} on {name}: {exc}")
                continue
            for guest in guests:
                vmid = guest.get("vmid")
                if vmid in (None, ""):
                    continue
                guest_status = str(guest.get("status") or "unknown")
                label = str(guest.get("name") or f"{kind}-{vmid}")
                result.nodes.append(
                    {
                        "id": f"{prefix}-{vmid}",
                        "kind": kind,
                        "stratum": 2,
                        "label": label,
                        "parent_id": node_id,
                        "vmid": int(vmid),
                        "managed_by": "proxmox",
                        "health_status": SEVERITY.get(guest_status, "unknown"),
                        "live_state": {
                            "source": "proxmox",
                            "pve_status": guest_status,
                            "tags": guest.get("tags"),
                            "cpus": guest.get("cpus"),
                            "maxmem": guest.get("maxmem"),
                            "uptime": guest.get("uptime"),
                            "type": kind,
                        },
                        "last_seen_live_at": time.time() if guest_status == "running" else None,
                    }
                )
                result.edges.append(
                    {"source_id": node_id, "target_id": f"{prefix}-{vmid}", "relation": "hosts", "origin": "live"}
                )
    return result
