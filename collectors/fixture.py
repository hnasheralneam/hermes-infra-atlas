"""Demo fleet loader.

The fixture is a complete, sanitized snapshot: nodes already carry both sides
(doc/live), the drift state the sweep would have computed, probe history and
incidents. Demo mode writes it straight through so the UI, the tools and the
incident engine are fully exercisable with no credentials and no real hosts.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional

from . import CollectorResult

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "sample_fleet.json"


def load() -> dict[str, Any]:
    try:
        payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"nodes": [], "edges": [], "incidents": [], "probe_history": []}
    # Keep relative freshness: the fixture stores absolute timestamps from
    # generation time, so rebase them onto "now".
    generated = float(payload.get("generated_at") or time.time())
    shift = time.time() - generated
    for node in payload.get("nodes") or []:
        if node.get("last_seen_live_at"):
            node["last_seen_live_at"] = float(node["last_seen_live_at"]) + shift
    for incident in payload.get("incidents") or []:
        for key in ("started_at", "resolved_at"):
            if incident.get(key):
                incident[key] = float(incident[key]) + shift
    for sample in payload.get("probe_history") or []:
        if sample.get("ts"):
            sample["ts"] = float(sample["ts"]) + shift
    return payload


def collect() -> CollectorResult:
    payload = load()
    return CollectorResult(source="fixture", nodes=payload.get("nodes") or [])


def node_by_id(node_id: str) -> Optional[dict[str, Any]]:
    for node in load().get("nodes") or []:
        if node.get("id") == node_id:
            return node
    return None
