"""replace_body: the sanctioned path for a structural rewrite.

Appending can only grow a runbook, so without this flag a genuine rewrite has no
sanctioned route — and a blocked agent finds a workaround, which defeats the gate.
"""

from __future__ import annotations

import _harness as H


def _kb(registry):
    H.load_plugin()
    H.configure({"registry_path": str(registry)})
    return H.submodule("registry_kb")


def _seed(kb, registry, lines=40):
    body = "\n".join(f"line {i}" for i in range(lines))
    result = kb.upsert_entry(
        registry, {"id": "svc-x", "kind": "service", "label": "X"}, "create", body_append=body
    )
    return registry / result["registry_path"]


def test_append_only_grows_and_never_shrinks(plugin_home, registry):
    kb = _kb(registry)
    entry = _seed(kb, registry)
    before = len(entry.read_text().splitlines())
    kb.upsert_entry(registry, {"id": "svc-x", "kind": "service"}, "append", body_append="short")
    assert len(entry.read_text().splitlines()) > before


def test_replace_body_rewrites_a_shorter_runbook(plugin_home, registry):
    kb = _kb(registry)
    entry = _seed(kb, registry)
    before = len(entry.read_text().splitlines())
    result = kb.upsert_entry(
        registry,
        {"id": "svc-x", "kind": "service"},
        "structural rewrite",
        body_append="# X\n\nRewritten.\n",
        replace_body=True,
    )
    after = entry.read_text()
    assert len(after.splitlines()) < before
    assert "Rewritten." in after
    assert result.get("archived_body")


def test_a_rewrite_archives_the_previous_body(plugin_home, registry):
    kb = _kb(registry)
    entry = _seed(kb, registry)
    result = kb.upsert_entry(
        registry, {"id": "svc-x", "kind": "service"}, "rewrite",
        body_append="# X\n\nNew.\n", replace_body=True,
    )
    archive = registry / result["archived_body"]
    assert archive.exists()
    assert "line 39" in archive.read_text(), "the old runbook must survive the rewrite"


def test_a_rewrite_is_named_in_the_change_log(plugin_home, registry):
    kb = _kb(registry)
    _seed(kb, registry)
    result = kb.upsert_entry(
        registry, {"id": "svc-x", "kind": "service"}, "rewrite",
        body_append="# X\n\nNew.\n", replace_body=True,
    )
    log = (registry / "change-log.md").read_text()
    assert "Rewrote entry" in log
    assert result["archived_body"] in log


def test_replace_body_without_a_body_is_refused(plugin_home, registry):
    kb = _kb(registry)
    _seed(kb, registry)
    try:
        kb.upsert_entry(registry, {"id": "svc-x", "kind": "service"}, "empty", replace_body=True)
    except RuntimeError as exc:
        assert "no new body" in str(exc)
        return
    raise AssertionError("replace_body with no body must be refused, not silently blank the runbook")


def test_append_still_works_after_a_rewrite(plugin_home, registry):
    kb = _kb(registry)
    entry = _seed(kb, registry)
    kb.upsert_entry(
        registry, {"id": "svc-x", "kind": "service"}, "rewrite",
        body_append="# X\n\nNew.\n", replace_body=True,
    )
    kb.upsert_entry(registry, {"id": "svc-x", "kind": "service"}, "append", body_append="appended")
    assert "appended" in entry.read_text()
