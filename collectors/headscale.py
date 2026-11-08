"""Headscale (or any Tailscale-coordination API) as a live source (opt-in)."""

from __future__ import annotations

import json
import logging
import ssl
import time
import urllib.error
import urllib.request
from typing import Any

from . import CollectorResult

logger = logging.getLogger(__name__)


def _slug(text: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-") or "node"


def _base_url() -> str:
    from .. import config as plugin_config

    url = str(plugin_config.setting("headscale_url") or "").strip().rstrip("/")
    if url and not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _fetch(base: str, path: str, key: str, timeout: float = 5.0) -> Any:
    request = urllib.request.Request(f"{base}{path}", headers={"Authorization": f"Bearer {key}"})
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def collect() -> CollectorResult:
    from .. import config as plugin_config

    result = CollectorResult(source="headscale")
    base = _base_url()
    key = plugin_config.secret("INFRA_ATLAS_HEADSCALE_API_KEY")
    if not base or not key:
        return result

    nodes = None
    for path in ("/api/v1/node", "/api/v1/machine"):
        try:
            payload = _fetch(base, path, key)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            result.errors.append(f"headscale {path}: {exc}")
            continue
        nodes = payload.get("nodes") or payload.get("machines") if isinstance(payload, dict) else payload
        if nodes:
            break
    if not nodes:
        return result

    for node in nodes:
        if not isinstance(node, dict):
            continue
        given = str(node.get("givenName") or node.get("name") or "").strip()
        hostname = given or str(node.get("hostname") or "").strip()
        ips = [ip for ip in (node.get("ipAddresses") or []) if str(ip).startswith("100.")]
        if not hostname and not ips:
            continue
        online = bool(node.get("online", node.get("connected")))
        result.nodes.append(
            {
                "id": f"srv-{_slug(hostname or ips[0])}",
                "kind": "server",
                "stratum": 1,
                "label": hostname or (ips[0] if ips else "tailnet node"),
                "tailnet_ip": ips[0] if ips else None,
                "managed_by": "headscale",
                "health_status": "up" if online else "down",
                "live_state": {
                    "source": "headscale",
                    "online": online,
                    "last_seen": node.get("lastSeen"),
                    "tags": node.get("forcedTags") or node.get("validTags") or [],
                    "hostname": hostname,
                },
                "last_seen_live_at": time.time() if online else None,
            }
        )
    return result
