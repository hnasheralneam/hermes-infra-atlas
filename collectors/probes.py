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


def _http_probe(url: str, timeout: float, ip: Optional[str] = None, host: str = "") -> tuple[str, Optional[float], str]:
    started = time.monotonic()
    headers = {"User-Agent": "infra-atlas/0.1"}
    if ip:
        headers["Host"] = host  # connect by address, keep the virtual host
        parsed = urlparse(url)
        netloc = ip if not parsed.port else f"{ip}:{parsed.port}"
        url = parsed._replace(netloc=netloc).geturl()
    request = urllib.request.Request(url, method="GET", headers=headers)
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


def _tcp_probe(address: str, timeout: float, ip: Optional[str] = None) -> tuple[str, Optional[float], str]:
    host, _, port_text = address.rpartition(":")
    if not host or not port_text.isdigit():
        return "down", None, f"unparsable target {address!r}"
    started = time.monotonic()
    try:
        with socket.create_connection(((ip or host), int(port_text)), timeout=timeout):
            latency = (time.monotonic() - started) * 1000
            return "up", latency, f"TCP {port_text} connected"
    except (socket.timeout, OSError) as exc:
        return "down", None, f"TCP {port_text} failed: {exc}"[:200]


def _host_of(address: str) -> str:
    host, _, _port = address.rpartition(":")
    return host or address


def resolve_hosts(hosts: list[str], timeout: float = 1.0) -> dict[str, Optional[str]]:
    """Resolve hostnames with a hard wall clock.

    ``getaddrinfo`` ignores the socket timeout, so a flaky resolver used to hang a
    whole sweep for minutes. Anything unresolved by the deadline is reported as
    unresolved and the probe is skipped: a DNS outage is not a service outage.
    """
    resolved: dict[str, Optional[str]] = {}
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(32, max(4, len(hosts) or 1)))
    try:
        futures = {pool.submit(socket.getaddrinfo, host, None): host for host in hosts}
        done, pending = concurrent.futures.wait(futures, timeout=timeout)
        for future in done:
            host = futures[future]
            try:
                resolved[host] = future.result()[0][4][0]
            except Exception:  # noqa: BLE001 - unresolvable is a result, not a crash
                resolved[host] = None
        for future in pending:
            future.cancel()
            resolved[futures[future]] = None
    finally:
        pool.shutdown(wait=False)  # never join a resolver thread that is still stuck
    return resolved


def probe_node(node: dict[str, Any], timeout: float = DEFAULT_TIMEOUT, ip: Optional[str] = None) -> dict[str, Any]:
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
    if ip is None and str(node.get("probe_resolved") or "") == "missing":
        return {
            "id": node_id,
            "health_status": "unknown",
            "latency_ms": None,
            "live_state": {"source": "probes", "probe": probe_url, "probe_detail": "hostname did not resolve"},
        }
    if kind == "http":
        status, latency, detail = _http_probe(address, timeout, ip=ip, host=_host_of(address))
    else:
        status, latency, detail = _tcp_probe(address, timeout, ip=ip)
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
    # Resolve once, with a deadline, then probe by address. A stuck resolver used
    # to stall the whole sweep (getaddrinfo has no timeout of its own).
    hosts: list[str] = []
    for node in targets:
        target = _target_of(node)
        if not target:
            continue
        host = _host_of(target[1])
        if host and not host.replace(".", "").isdigit():
            hosts.append(host)
    resolved = resolve_hosts(sorted(set(hosts)), timeout=min(1.5, max(0.3, budget)))
    unresolved = {host for host, ip in resolved.items() if not ip}

    prepared: list[tuple[dict[str, Any], Optional[str]]] = []
    for node in targets:
        target = _target_of(node)
        ip: Optional[str] = None
        if target:
            host = _host_of(target[1])
            if host in unresolved:
                node = {**node, "probe_resolved": "missing"}
            else:
                ip = resolved.get(host) or None
        prepared.append((node, ip))

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS)
    try:
        futures = {pool.submit(probe_node, node, budget, ip): node for node, ip in prepared}
        for future in concurrent.futures.as_completed(futures, timeout=budget * 3 + 5):
            node = futures[future]
            try:
                result.nodes.append(future.result())
            except Exception as exc:  # pragma: no cover - defensive
                result.errors.append(f"{node.get('id')}: {exc}")
    except concurrent.futures.TimeoutError:
        result.errors.append("probe deadline exceeded; remaining targets skipped")
    finally:
        pool.shutdown(wait=False)  # an unresponsive target must not hold the sweep
    return result


def probe_url(url: str, timeout: float = DEFAULT_TIMEOUT) -> tuple[str, Optional[float], str]:
    """Probe a raw URL/tcp target (used by the heal verifier)."""
    node = {"probe": url}
    observation = probe_node(node, timeout)
    state = observation["live_state"]
    return observation["health_status"], observation["latency_ms"], str(state.get("probe_detail") or "")
