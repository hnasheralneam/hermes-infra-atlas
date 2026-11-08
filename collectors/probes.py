"""Bounded concurrent health probes.

One probe per node, HTTP where the registry declares a URL and TCP otherwise.
Results carry latency so the UI can draw a sparkline; the uptime engine owns the
failure-streak decision, so this module only reports what it saw.
"""

from __future__ import annotations

import concurrent.futures
import logging
import socket
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Optional
from urllib.parse import urlparse

from . import CollectorResult

logger = logging.getLogger(__name__)

MAX_WORKERS = 12
DEFAULT_TIMEOUT = 1.5
_INCIDENT_KINDS = {"service", "container", "model_endpoint", "vm", "lxc"}


def _target_of(node: dict[str, Any]) -> Optional[tuple[str, str, Optional[str]]]:
    """Return ``(kind, address, probe_url)`` where kind is ``http`` or ``tcp``."""
    probe = str(node.get("probe") or "").strip()
    if probe:
        if probe.startswith(("http://", "https://")):
            return "http", probe, probe
        if probe.startswith("tcp://"):
            return "tcp", probe[len("tcp://"):], probe
        if ":" in probe and " " not in probe:
            return "tcp", probe, f"tcp://{probe}"
    host = node.get("host_ip") or node.get("tailnet_ip")
    ports = node.get("ports") or []
    if host and ports:
        return "tcp", f"{host}:{ports[0]}", f"tcp://{host}:{ports[0]}"
    return None


def _http_probe(url: str, timeout: float) -> tuple[str, Optional[float], str]:
    started = time.monotonic()
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "infra-atlas/0.1"})
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            response.read(2048)
            code = getattr(response, "status", 200)
            latency = (time.monotonic() - started) * 1000
            return ("up" if code < 500 else "degraded"), latency, f"HTTP {code}"
    except urllib.error.HTTPError as exc:
        latency = (time.monotonic() - started) * 1000
        # Anything that answers is a live service; 5xx means it is unhealthy.
        return ("degraded" if exc.code >= 500 else "up"), latency, f"HTTP {exc.code}"
    except (urllib.error.URLError, socket.timeout, OSError, ssl.SSLError) as exc:
        reason = getattr(exc, "reason", exc)
        return "down", None, f"HTTP probe failed: {reason}"[:200]


def _tcp_probe(address: str, timeout: float) -> tuple[str, Optional[float], str]:
    host, _, port_text = address.rpartition(":")
    if not host or not port_text.isdigit():
        return "down", None, f"unparsable target {address!r}"
    started = time.monotonic()
    try:
        with socket.create_connection((host, int(port_text)), timeout=timeout):
            latency = (time.monotonic() - started) * 1000
            return "up", latency, f"TCP {port_text} connected"
    except (socket.timeout, OSError) as exc:
        return "down", None, f"TCP {port_text} failed: {exc}"[:200]


def probe_node(node: dict[str, Any], timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    """Probe one node and return the observation dict (never raises)."""
    node_id = str(node.get("id") or "")
    target = _target_of(node)
    declared = bool(str(node.get("probe") or "").strip()) and not bool(node.get("probe_inferred"))
    if not target:
        return {
            "id": node_id,
            "health_status": "unknown",
            "latency_ms": None,
            "live_state": {"source": "probes", "probe": None},
        }
    kind, address, probe_url = target
    if kind == "http":
        status, latency, detail = _http_probe(address, timeout)
    else:
        status, latency, detail = _tcp_probe(address, timeout)
    incident_eligible = declared or str(node.get("kind") or "") == "model_endpoint"
    return {
        "id": node_id,
        "health_status": status,
        "latency_ms": round(latency, 1) if latency is not None else None,
        "live_state": {
            "source": "probes",
            "probe": probe_url,
            "probe_detail": detail,
            "probe_declared": declared,
            "incident_eligible": incident_eligible,
            "probed_at": time.time(),
        },
        "last_seen_live_at": time.time() if status == "up" else None,
    }


def collect(targets: list[dict[str, Any]], timeout: Optional[float] = None) -> CollectorResult:
    result = CollectorResult(source="probes")
    if not targets:
        return result
    budget = float(timeout or DEFAULT_TIMEOUT)
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(probe_node, node, budget): node for node in targets}
        for future in concurrent.futures.as_completed(futures, timeout=budget * 4 + 5):
            node = futures[future]
            try:
                result.nodes.append(future.result())
            except Exception as exc:  # pragma: no cover - defensive
                result.errors.append(f"{node.get('id')}: {exc}")
    return result


def probe_url(url: str, timeout: float = DEFAULT_TIMEOUT) -> tuple[str, Optional[float], str]:
    """Probe a raw URL/tcp target (used by the heal verifier)."""
    node = {"probe": url}
    observation = probe_node(node, timeout)
    state = observation["live_state"]
    return observation["health_status"], observation["latency_ms"], str(state.get("probe_detail") or "")
