"""Collector fan-out: every source returns the same normalized observation shape.

An observation is a partial node: whatever that source could actually see. The
fusion layer merges observations onto parsed registry entries and reports the
remainder as ``unregistered``. No collector raises into a sweep — failures are
collected as ``errors`` so a dead host degrades one section, not the run.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

SOURCES = ("kb", "local", "hermes", "proxmox", "headscale", "probes")


@dataclass
class CollectorResult:
    source: str
    nodes: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    duration_ms: int = 0

    def extend(self, other: "CollectorResult") -> None:
        self.nodes.extend(other.nodes)
        self.edges.extend(other.edges)
        self.errors.extend(other.errors)


def run_source(source: str, **kwargs: Any) -> CollectorResult:
    """Run one collector by name, converting any explosion into an error entry."""
    started = time.monotonic()
    try:
        if source == "local":
            from . import local_host

            result = local_host.collect()
        elif source == "hermes":
            from . import hermes_runtime

            result = hermes_runtime.collect()
        elif source == "proxmox":
            from . import proxmox

            result = proxmox.collect()
        elif source == "headscale":
            from . import headscale

            result = headscale.collect()
        elif source == "probes":
            from . import probes

            result = probes.collect(kwargs.get("targets") or [], timeout=kwargs.get("timeout"))
        else:
            result = CollectorResult(source=source, errors=[f"unknown source {source!r}"])
    except Exception as exc:  # a collector must never abort the sweep
        logger.debug("infra-atlas: collector %s failed", source, exc_info=True)
        result = CollectorResult(source=source, errors=[f"{type(exc).__name__}: {exc}"])
    result.duration_ms = int((time.monotonic() - started) * 1000)
    return result


def run_sources(
    sources: Iterable[str],
    enabled: Optional[Callable[[str], bool]] = None,
    **kwargs: Any,
) -> list[CollectorResult]:
    results = []
    for source in sources:
        if source == "kb":
            continue  # the KB is parsed by registry_kb, not a collector
        if enabled is not None and not enabled(source):
            continue
        results.append(run_source(source, **kwargs))
    return results


def merge(results: Iterable[CollectorResult]) -> CollectorResult:
    combined = CollectorResult(source="live")
    for result in results:
        combined.extend(result)
    return combined
