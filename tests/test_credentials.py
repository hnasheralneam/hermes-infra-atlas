"""Credential vault: private storage, registry references, and the literal scanner.

The contract these tests pin down:

* a value lives only in the 0600 vault (encrypted when ``cryptography`` exists),
  never in the Markdown KB, never in a tool payload except an explicit ``get``;
* entries reference credentials by name, so rotating one is a vault write;
* ``get`` obeys the same read-before-touch gate as everything else;
* the scanner finds leftover literals without ever reproducing them.
"""

from __future__ import annotations

import json
import os
import stat

import _harness as H
import pytest


@pytest.fixture()
def vault(plugin_home, registry, tmp_path):
    path = tmp_path / "vault" / "credentials.json"
    key = tmp_path / "vault" / "credentials.key"
    H.configure({"credentials_path": str(path), "credentials_key_path": str(key)}, registry=registry)
    return {"path": path, "key": key, "registry": registry}


def _write_entry(registry, name, body, folder="services", frontmatter=""):
    path = registry / folder / f"{name}.md"
    text = f"---\n{frontmatter}---\n\n{body}"
    path.write_text(text, encoding="utf-8")
    return path


def _seed_node(store, node_id, registry_path, **extra):
    store.upsert_node(
        {
            "id": node_id,
            "kind": "server",
            "label": node_id,
            "registry_path": registry_path,
            "drift_status": "matched",
            **extra,
        }
    )
    return node_id


# ---------------------------------------------------------------- vault basics

def test_set_get_roundtrip_is_private(vault):
    creds = H.submodule("credentials")
    meta = creds.set_value("cyberfield-root-ssh", "hunter2-hunter2", node_id="srv-cyberfield", kind="ssh-password")

    assert meta["value_length"] == 15
    assert "hunter2" not in json.dumps(meta)

    raw = vault["path"].read_text(encoding="utf-8")
    assert "hunter2-hunter2" not in raw, "the plaintext must never be written to the vault file"
    assert stat.S_IMODE(os.stat(vault["path"]).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(vault["path"].parent).st_mode) == 0o700

    assert creds.get_value("cyberfield-root-ssh") == "hunter2-hunter2"
    assert creds.store_info()["encrypted"] is True


def test_plaintext_fallback_when_crypto_missing(vault, monkeypatch):
    creds = H.submodule("credentials")
    monkeypatch.setattr(creds, "_crypto_available", lambda: False)
    monkeypatch.setattr(creds, "_fernet", lambda create=False: None)
    meta = creds.set_value("legacy-token", "plain-value")
    assert meta["value_length"] == len("plain-value")
    assert creds.store_info()["encrypted"] is False
    assert creds.get_value("legacy-token") == "plain-value"


def test_set_refuses_silent_overwrite(vault):
    creds = H.submodule("credentials")
    creds.set_value("litellm-db", "one")
    with pytest.raises(creds.CredentialError):
        creds.set_value("litellm-db", "two")
    assert creds.get_value("litellm-db") == "one"
    creds.set_value("litellm-db", "two", rotate=True)
    assert creds.get_value("litellm-db") == "two"


def test_bad_names_and_empty_values_are_refused(vault):
    creds = H.submodule("credentials")
    for bad in ("Has Spaces", "-leading", "", "x"):
        with pytest.raises(creds.CredentialError):
            creds.set_value(bad, "value")
    with pytest.raises(creds.CredentialError):
        creds.set_value("ok-name", "")


def test_delete_value(vault):
    creds = H.submodule("credentials")
    creds.set_value("temp-cred", "value")
    assert creds.delete_value("temp-cred") is True
    assert creds.delete_value("temp-cred") is False
    assert creds.get_value("temp-cred") is None


# ------------------------------------------------------ registry integration

def test_frontmatter_credentials_parse(vault):
    registry = vault["registry"]
    _write_entry(registry, "cyberfield", "# Cyberfield\n", folder="servers",
                 frontmatter="id: srv-cyberfield\nkind: server\ncredentials: [pve-token, root-ssh]\n")
    kb = H.submodule("registry_kb")
    nodes, _edges = kb.parse_registry(registry)
    node = next(n for n in nodes if n["id"] == "srv-cyberfield")
    assert node["credentials"] == ["pve-token", "root-ssh"]
    assert node["doc_state"]["credentials"] == ["pve-token", "root-ssh"]


def test_upsert_preserves_and_renders_credentials(vault):
    registry = vault["registry"]
    _write_entry(registry, "ctfd", "# CTFd\n\nRunbook body.\n", frontmatter="id: svc-ctfd\nkind: service\n")
    kb = H.submodule("registry_kb")
    kb.upsert_entry(
        registry,
        {"id": "svc-ctfd", "kind": "service", "label": "CTFd", "credentials": ["ctfd-mysql-root"]},
        "add credential reference",
    )
    text = (registry / "services" / "ctfd.md").read_text(encoding="utf-8")
    assert "credentials:" in text and "ctfd-mysql-root" in text
    assert "Runbook body." in text, "the runbook must survive the frontmatter rewrite"


def test_missing_and_unreferenced(vault):
    registry = vault["registry"]
    _write_entry(registry, "ctfd", "# CTFd\n", frontmatter="id: svc-ctfd\nkind: service\ncredentials: [ctfd-mysql-root]\n")
    creds = H.submodule("credentials")
    assert creds.missing() == [{"node_id": "svc-ctfd", "name": "ctfd-mysql-root"}]

    creds.set_value("ctfd-mysql-root", "ctfd", node_id="svc-ctfd")
    assert creds.missing() == []
    assert creds.unreferenced() == []

    creds.set_value("orphan-cred", "value")
    assert creds.unreferenced() == ["orphan-cred"]


def test_status_map_marks_stored_and_missing(vault):
    registry = vault["registry"]
    _write_entry(registry, "ctfd", "# CTFd\n",
                 frontmatter="id: svc-ctfd\nkind: service\ncredentials: [a-cred, b-cred]\n")
    creds = H.submodule("credentials")
    creds.set_value("a-cred", "value")
    status = creds.status_map(registry)["svc-ctfd"]
    assert status["declared"] == ["a-cred", "b-cred"]
    assert [ref["stored"] for ref in status["refs"]] == [True, False]
    assert status["missing"] == ["b-cred"]


# ------------------------------------------------------------- tool behaviour

def test_tool_set_then_get_obeys_read_before_touch(vault):
    registry = vault["registry"]
    _write_entry(registry, "cyberfield", "# Cyberfield\n\nRunbook.\n", folder="servers",
                 frontmatter="id: srv-cyberfield\nkind: server\nhost_ip: 10.0.0.193\n")
    store = H.submodule("store").get_store()
    _seed_node(store, "srv-cyberfield", "servers/cyberfield.md", doc_state={"status": "active"})
    tools = H.submodule("atlas_tools")

    stored = json.loads(
        tools.infra_credentials(
            {
                "action": "set",
                "name": "cyberfield-root-ssh",
                "value": "ironclad-defense",
                "node_id": "srv-cyberfield",
                "kind": "ssh-password",
                "reason": "migrate out of the skill",
            },
            session_id="sess-1",
        )
    )
    assert stored["ok"] is True and stored["value_echoed"] is False
    assert "ironclad-defense" not in json.dumps(stored)
    assert stored["registry_link"]["linked"] is True
    assert "cyberfield-root-ssh" in (registry / "servers" / "cyberfield.md").read_text(encoding="utf-8")
    assert "ironclad-defense" not in (registry / "servers" / "cyberfield.md").read_text(encoding="utf-8")

    blocked = json.loads(tools.infra_credentials({"action": "get", "name": "cyberfield-root-ssh"}, session_id="sess-2"))
    assert "read-before-touch" in blocked["error"]

    store.record_session_read("sess-2", "srv-cyberfield", "infra_query")
    allowed = json.loads(tools.infra_credentials({"action": "get", "name": "cyberfield-root-ssh"}, session_id="sess-2"))
    assert allowed["value"] == "ironclad-defense"

    blocked_activity = [
        row for row in store.recent_activity(limit=50) if row["action_kind"] == "credential_read" and row["blocked"]
    ]
    assert blocked_activity, "a refused credential read must be recorded"


def test_tool_list_never_contains_a_value(vault):
    creds = H.submodule("credentials")
    creds.set_value("some-cred", "super-secret-value", node_id="svc-ctfd")
    tools = H.submodule("atlas_tools")
    payload = json.loads(tools.infra_credentials({"action": "list"}, session_id="sess"))
    assert payload["count"] == 1
    assert "super-secret-value" not in json.dumps(payload)
    assert payload["credentials"][0]["value_length"] == len("super-secret-value")
    assert payload["vault"]["encrypted"] is True


def test_tool_set_requires_reason_and_value(vault):
    tools = H.submodule("atlas_tools")
    assert "reason" in json.loads(tools.infra_credentials({"action": "set", "name": "x-cred", "value": "v"}))["error"]
    assert "value" in json.loads(tools.infra_credentials({"action": "set", "name": "x-cred", "reason": "r"}))["error"]


def test_tool_remove(vault):
    creds = H.submodule("credentials")
    creds.set_value("gone-cred", "value")
    tools = H.submodule("atlas_tools")
    assert json.loads(tools.infra_credentials({"action": "remove", "name": "gone-cred", "reason": "rotated"}))["ok"]
    assert creds.get_value("gone-cred") is None


# --------------------------------------------------------------- literal scan

def test_scan_flags_literals_but_not_pointers(vault):
    registry = vault["registry"]
    (registry / "services" / "ctfd.md").write_text(
        "# CTFd\n\n"
        "SSH with `sshpass -p 'asdf' ssh sysadmin@10.0.0.59`.\n"
        "- **Password:** `2yssF-FtFBH-fo6cW-28tn4-zN9nE`\n"
        "Dex bind: password: ${LDAP_PASS}\n"
        "Placeholder: password: <redacted>\n"
        "Env file: password: ~/.hermes/secrets/ctfd.env\n",
        encoding="utf-8",
    )
    creds = H.submodule("credentials")
    findings = creds.scan_literals(registry)
    kinds = sorted(f["kind"] for f in findings)
    assert kinds == ["password", "ssh-password"], kinds
    blob = json.dumps(findings)
    assert "2yssF-FtFBH-fo6cW-28tn4-zN9nE" not in blob
    assert "asdf" not in blob


def test_scan_ignores_prose_flags_and_identifiers(vault):
    registry = vault["registry"]
    (registry / "services" / "forgejo.md").write_text(
        "# Forgejo\n\n"
        "`forgejo admin user create --password <pw> --must-change-password=false`\n"
        "Verified behaviour of an empty local password: Forgejo refuses the form.\n"
        "- Token: `guac-provisioner` (via Proximo MCP)\n"
        "- `api_key: local-nokey-llamacpp` for the local endpoint\n",
        encoding="utf-8",
    )
    creds = H.submodule("credentials")
    assert creds.scan_literals(registry) == []


def test_tool_scan_suggests_names_and_reports_count(vault):
    (vault["registry"] / "servers" / "cyberfield.md").write_text(
        "---\nid: srv-cyberfield\nkind: server\n---\n\nRoot SSH password: ironclad-defense\n", encoding="utf-8"
    )
    tools = H.submodule("atlas_tools")
    payload = json.loads(tools.infra_credentials({"action": "scan"}, session_id="sess"))
    assert payload["count"] == 1
    assert payload["findings"][0]["suggested_name"] == "cyberfield-password"
    assert "ironclad-defense" not in json.dumps(payload)
