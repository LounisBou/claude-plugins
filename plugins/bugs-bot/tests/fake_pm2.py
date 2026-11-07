"""A fake ``pm2`` for ``install``: its process list lives in a JSON file beside it; every call is logged.

Run as ``fake_pm2.py <state.json> <args…>`` through a wrapper script. ``start`` registers an app named after the
config's one app, running the launcher of ``BUGS_BOT_LAUNCHER_DIR`` (else ``~/.local/bin``) from the current
directory — even when one is already registered, as a second ``pm2 start`` of another config would.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PULL_APP = "bugs-bot-pull"


def main() -> int:
    state_path = Path(sys.argv[1])
    args = sys.argv[2:]
    state = json.loads(state_path.read_text()) if state_path.exists() else {"apps": [], "saved": None, "calls": []}
    state["calls"].append({"argv": args, "cwd": os.getcwd()})
    verb = args[0] if args else ""
    code = 0
    if verb == "jlist":
        print(json.dumps([{"name": a["name"], "pid": 900 + i, "pm2_env": {"pm_exec_path": a["script"], "pm_cwd": a["cwd"], "restart_time": a["restarts"]}} for i, a in enumerate(state["apps"])]))
    elif verb == "start":
        launcher_dir = os.environ.get("BUGS_BOT_LAUNCHER_DIR") or str(Path(os.environ["HOME"]) / ".local" / "bin")
        state["apps"].append({"name": PULL_APP, "script": str(Path(launcher_dir) / "bugs-bot"), "cwd": os.getcwd(), "restarts": 0})
    elif verb == "restart":
        found = [a for a in state["apps"] if a["name"] == args[1]]
        for app in found:
            app["restarts"] += 1
        code = 0 if found else 1
    elif verb == "delete":
        before = len(state["apps"])
        state["apps"] = [a for a in state["apps"] if a["name"] != args[1]]
        code = 0 if len(state["apps"]) < before else 1
    elif verb == "save":
        state["saved"] = [a["name"] for a in state["apps"]]
    else:
        code = 2
    state_path.write_text(json.dumps(state))
    return code


if __name__ == "__main__":
    sys.exit(main())
