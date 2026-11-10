"""Zero-config discovery of the machine Hermes runs on.

Sources: systemd (user and system), listening TCP ports from ``/proc/net/tcp``,
Docker/Podman (when the CLI answers within 2 s) and the Tailscale CLI (no API
key needed). Everything here is read-only and bounded by a short timeout.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from . import CollectorResult

MAX_OUTPUT = 2_000_000

# Per-session desktop plumbing: every login starts these, nobody documents them,
# and left alone they read as "undocumented services" on every sweep.
_SESSION_NOISE_UNITS = {
    "dbus",
    "dbus-broker",
    "dconf-service",
    "gpg-agent",
    "ssh-agent",
    "at-spi-dbus-bus",
    "pipewire",
    "pipewire-pulse",
    "wireplumber",
    "pulseaudio",
    "gnome-keyring-daemon",
    "tracker-miner-fs-3",
    "xdg-desktop-portal",
    "xdg-desktop-portal-gnome",
    "xdg-desktop-portal-gtk",
    "xdg-document-portal",
    "xdg-permission-store",
    "gvfs-daemon",
    "gvfs-udisks2-volume-monitor",
    "launchpadlib-cache-clean",
}


def _run(argv: list[str], timeout: float = 2.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "SYSTEMD_PAGER": "cat", "LC_ALL": "C.UTF-8"},
        )
        return proc.returncode, (proc.stdout or "")[:MAX_OUTPUT]
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "node"


def local_ip() -> Optional[str]:
    """Best-effort primary LAN address (no packets are sent)."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if not address.startswith("127."):
                return address
    except OSError:
        pass
    return None


def tailscale_ip() -> Optional[str]:
    rc, out = _run(["tailscale", "ip", "-4"], timeout=1.5)
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("100."):
                return line
    return None


def listening_ports() -> list[str]:
    """LISTEN sockets for this host, from /proc (no subprocess)."""
    ports: set[str] = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(path).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "0A":  # 0A == TCP_LISTEN
                continue
            try:
                port = int(fields[1].split(":")[1], 16)
            except (IndexError, ValueError):
                continue
            if port:
                ports.add(str(port))
    return sorted(ports, key=int)


def _systemd_timers(scope: str) -> set[str]:
    """Active timer unit stems (without ``.timer``) for ``--user`` or system scope."""
    argv = ["systemctl"]
    if scope == "user":
        argv.append("--user")
    argv += ["list-units", "--type=timer", "--state=active", "--output=json", "--no-pager"]
    rc, out = _run(argv, timeout=2.5)
    stems: set[str] = set()
    if rc == 0 and out.strip().startswith("["):
        try:
            for item in json.loads(out):
                unit = str(item.get("unit") or item.get("name") or "").strip()
                if unit.endswith(".timer"):
                    stems.add(unit.removesuffix(".timer"))
            return stems
        except (ValueError, AttributeError):
            pass
    argv = argv[:-2] + ["--plain", "--no-legend"]
    rc, out = _run(argv, timeout=2.5)
    if rc == 0:
        for line in out.splitlines():
            parts = line.replace("●", " ").split()
            if parts and parts[0].endswith(".timer"):
                stems.add(parts[0].removesuffix(".timer"))
    return stems


def _systemd_units(scope: str) -> list[dict[str, Any]]:
    """Services for ``--user`` or system scope, normalized."""
    argv = ["systemctl"]
    if scope == "user":
        argv.append("--user")
    argv += ["list-units", "--type=service", "--all", "--output=json", "--no-pager"]
    rc, out = _run(argv, timeout=3.0)
    units: list[dict[str, Any]] = []
    if rc == 0 and out.strip().startswith("["):
        try:
            for item in json.loads(out):
                unit = str(item.get("unit") or item.get("name") or "").strip()
                if not unit.endswith(".service"):
                    continue
                active = str(item.get("active") or item.get("active_state") or "").lower()
                sub = str(item.get("sub") or item.get("sub_state") or "").lower()
                units.append({"unit": unit, "active": active, "sub": sub})
            return units
        except (ValueError, AttributeError):
            pass
    # Older systemd: plain listing, "● name.service loaded active running ..."
    argv = argv[:-1] + ["--plain", "--no-legend"]
    rc, out = _run(argv, timeout=3.0)
    if rc != 0:
        return units
    for line in out.splitlines():
        parts = line.replace("●", " ").split()
        if len(parts) < 4 or not parts[0].endswith(".service"):
            continue
        units.append({"unit": parts[0], "active": parts[2], "sub": parts[3]})
    return units


def _docker_containers() -> list[dict[str, Any]]:
    binary = shutil.which("docker") or shutil.which("podman")
    if not binary:
        return []
    rc, out = _run([binary, "ps", "-a", "--format", "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"], timeout=2.5)
    if rc != 0:
        return []
    containers = []
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) < 3:
            continue
        name, image, status = parts[0].strip(), parts[1].strip(), parts[2].strip()
        ports = re.findall(r":(\d{2,5})->", parts[3] if len(parts) > 3 else "")
        containers.append(
            {
                "name": name,
                "image": image,
                "status": status,
                "ports": sorted(set(ports), key=int),
                "running": status.lower().startswith("up"),
            }
        )
    return containers


def _tailscale_peers() -> list[dict[str, Any]]:
    rc, out = _run(["tailscale", "status", "--json"], timeout=2.0)
    if rc != 0 or not out.strip():
        return []
    try:
        data = json.loads(out)
    except ValueError:
        return []
    peers = []
    raw_peers = data.get("Peer") or {}
    # `tailscale status --json` gives a hostname-keyed object; tolerate a list from
    # a future/alternate CLI rather than crashing the whole sweep.
    for peer in (raw_peers.values() if isinstance(raw_peers, dict) else raw_peers):
        ips = [ip for ip in (peer.get("TailscaleIPs") or []) if str(ip).startswith("100.")]
        if not ips:
            continue
        peers.append(
            {
                "hostname": str(peer.get("HostName") or peer.get("DNSName") or "").split(".")[0],
                "tailnet_ip": ips[0],
                "online": bool(peer.get("Online")),
                "os": peer.get("OS"),
            }
        )
    self_node = data.get("Self") or {}
    self_ips = [ip for ip in (self_node.get("TailscaleIPs") or []) if str(ip).startswith("100.")]
    if self_ips:
        peers.append(
            {
                "hostname": str(self_node.get("HostName") or ""),
                "tailnet_ip": self_ips[0],
                "online": True,
                "os": self_node.get("OS"),
                "self": True,
            }
        )
    return peers


def collect() -> CollectorResult:
    result = CollectorResult(source="local")
    hostname = socket.gethostname().split(".")[0] or "localhost"
    host_id = f"srv-{_slug(hostname)}"
    port_list = listening_ports()
    tail_ip = tailscale_ip()

    result.nodes.append(
        {
            "id": host_id,
            "kind": "server",
            "stratum": 1,
            "label": hostname,
            "host_ip": local_ip(),
            "tailnet_ip": tail_ip,
            "ports": port_list,
            "managed_by": "host",
            "health_status": "up",
            "live_state": {"source": "local", "hostname": hostname, "listening_ports": port_list},
            "last_seen_live_at": time.time(),
        }
    )

    for scope in ("user", "system"):
        active_timers = _systemd_timers(scope) if scope == "user" else set()
        for unit in _systemd_units(scope):
            name = unit["unit"]
            stem = name.removesuffix(".service")
            active = unit["active"]
            # Per-session desktop plumbing: every login starts these, nobody
            # documents them, and they would otherwise read as "undocumented
            # services" on every sweep.
            if stem in _SESSION_NOISE_UNITS:
                continue
            timer_backed = stem in active_timers
            # `inactive`/`dead` is the normal state of oneshot units and of
            # services nobody started: not an outage, and not worth a graph node
            # unless an active user timer schedules this oneshot unit.
            if active in {"inactive", "dead"} and not timer_backed:
                continue
            healthy = "up" if (active in {"active", "activating", "reloading"} or (timer_backed and active != "failed")) else "down"
            if scope == "system" and healthy == "up":
                continue
            result.nodes.append(
                {
                    "id": f"svc-{_slug(stem)}",
                    "kind": "service",
                    "stratum": 3,
                    "label": stem,
                    "parent_id": host_id,
                    "systemd_unit": name,
                    "managed_by": f"systemd-{scope}",
                    "health_status": healthy,
                    "live_state": {
                        "source": "local",
                        "active": "active (timer)" if (timer_backed and active in {"inactive", "dead"}) else active,
                        "sub": unit.get("sub"),
                        "scope": scope,
                        # Only a failed unit is an actionable outage; a stopped
                        # oneshot is not.
                        "incident_eligible": active == "failed",
                    },
                    "last_seen_live_at": time.time() if healthy == "up" else None,
                }
            )

    for container in _docker_containers():
        result.nodes.append(
            {
                "id": f"ct-{_slug(container['name'])}",
                "kind": "container",
                "stratum": 2,
                "label": container["name"],
                "parent_id": host_id,
                "ports": container["ports"],
                "managed_by": "docker",
                "health_status": "up" if container["running"] else "down",
                "live_state": {**container, "source": "local"},
                "last_seen_live_at": time.time() if container["running"] else None,
            }
        )

    for peer in _tailscale_peers():
        if peer.get("self"):
            result.nodes[0]["tailnet_ip"] = peer["tailnet_ip"]
            result.nodes[0]["live_state"]["tailscale_os"] = peer.get("os")
            continue
        result.nodes.append(
            {
                "id": f"srv-{_slug(peer['hostname'])}",
                "kind": "peer",
                "stratum": 1,
                "label": peer["hostname"],
                "tailnet_ip": peer["tailnet_ip"],
                "managed_by": "tailscale",
                # Offline peer != our outage: a laptop with the lid shut is unknown,
                # not red. Peers never page, so this only affects the picture.
                "health_status": "up" if peer["online"] else "unknown",
                "live_state": {"source": "local", "tailscale": peer},
                "last_seen_live_at": time.time() if peer["online"] else None,
            }
        )
    return result
