"""The environment every child process this plugin spawns is given.

Collectors and the restart playbook run ``systemctl``, ``docker``, ``qm`` and
``ip`` — none of which need the agent's environment. Passing ``os.environ``
wholesale hands a subprocess every API key, token and proxy credential the
Hermes process holds, so a compromised or merely chatty CLI could read them.

Only what the tools actually need is forwarded: a PATH, a locale, a pager that
cannot block, and — for ``systemctl --user`` — the session bus coordinates.
"""

from __future__ import annotations

import os
from typing import Optional

_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_LOCALE = "C.UTF-8"

# Forwarded only when present, and only for user-scope systemd/dbus calls.
_SESSION_VARS = ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")


def child_env(user_scope: bool = False, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Return a minimal environment for a child process.

    ``user_scope`` adds the session-bus variables ``systemctl --user`` needs;
    without them a user unit call fails with "Failed to connect to bus".
    """
    env = {
        "PATH": os.environ.get("PATH") or _DEFAULT_PATH,
        "LANG": _LOCALE,
        "LC_ALL": _LOCALE,
        "SYSTEMD_PAGER": "cat",
        "TERM": "dumb",
        "HOME": os.environ.get("HOME") or str(os.path.expanduser("~")),
    }
    if user_scope:
        for name in _SESSION_VARS:
            value = os.environ.get(name)
            if value:
                env[name] = value
    if extra:
        env.update({key: str(value) for key, value in extra.items()})
    return env


def command_wants_user_scope(argv: list[str]) -> bool:
    """Whether *argv* addresses the caller's systemd user manager."""
    return bool(argv) and argv[0] == "systemctl" and "--user" in argv[1:2]


__all__ = ["child_env", "command_wants_user_scope"]
