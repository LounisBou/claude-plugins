"""``install``: set this machine up once — the fixed launcher, then the single Pull process under PM2.

It asks nothing: the platform, the bot token and the group belong to each project's ``init``. A session may not
change its own permissions, so the allow rule is printed for the operator to add, never written.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path

from bugs_bot.doctor import (
    PERMISSIONS_LINE,
    PULL_APP,
    _allow_rule,
    _claude_dir,
    _launcher_dir,
    _pm2_recorded,
    install_launcher,
    pull_processes,
)
from bugs_bot.errors import BugsError

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
PM2_CONFIG = PLUGIN_ROOT / "pm2.config.js"
PM2_TIMEOUT = 60
# The PM2 program; tests point it at a fake, so no test ever reaches the machine's own PM2.
PM2_COMMAND = "pm2"

# Runs ``pm2 <args>`` and returns ``(exit code, stdout, stderr)``; raises ``FileNotFoundError`` without PM2.
Pm2 = Callable[[list[str]], tuple[int, str, str]]


def pm2_runner(env: Mapping[str, str], home: Path) -> Pm2:
    """Return the runner of the PM2 found on ``env``'s ``PATH``, run from the home directory."""

    def run(args: list[str]) -> tuple[int, str, str]:
        done = subprocess.run(
            [PM2_COMMAND, *args], cwd=home, env=dict(env), capture_output=True, text=True, timeout=PM2_TIMEOUT, check=False
        )
        return done.returncode, done.stdout, done.stderr

    return run


def _home(env: Mapping[str, str]) -> Path:
    return Path(env.get("HOME") or Path.home())


def _tail(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1].strip() if lines else ""


def start_pull(pm2: Pm2, launcher: Path, home: Path, ps_output: str) -> str:
    """Leave exactly one ``bugs-bot-pull`` under PM2, running ``launcher`` from ``home``; return what was done.

    Already registered with that script and that working directory: restarted, so it runs the new launcher.
    Registered with another (a versioned path, a throwaway directory): deleted, then started from the config.
    Not registered: started, unless a Pull already runs outside PM2 (a second one would steal its messages).

    Raises:
        BugsError: PM2 is missing or fails, or a Pull runs outside PM2.
    """
    try:
        code, out, err = pm2(["jlist"])
    except FileNotFoundError:
        raise BugsError("PM2 is not installed: `npm install -g pm2`, then /bugs-bot:install again") from None
    if code != 0:
        raise BugsError(f"pm2 jlist failed: {_tail(err) or f'exit {code}'}")
    script, cwd = _pm2_recorded(out)
    registered = script is not None

    def step(args: list[str]) -> None:
        code, _, err = pm2(args)
        if code != 0:
            raise BugsError(f"pm2 {' '.join(args)} failed: {_tail(err) or f'exit {code}'}")

    if registered and Path(script) == launcher and cwd is not None and Path(cwd) == home:
        step(["restart", PULL_APP])
        done = f"restarted {PULL_APP} under PM2, on {launcher}"
    elif registered:
        step(["delete", PULL_APP])
        step(["start", str(PM2_CONFIG)])
        done = f"replaced {PULL_APP} (it ran {script} from {cwd}) by one on {launcher}, from {home}"
    else:
        others = pull_processes(ps_output)
        if others:
            raise BugsError(
                f"a Pull already runs outside PM2 (pid {', '.join(map(str, others))}): stop it, then /bugs-bot:install "
                "again; two pollers steal each other's messages"
            )
        step(["start", str(PM2_CONFIG)])
        done = f"started {PULL_APP} under PM2, on {launcher}"
    step(["save"])
    return done + "; saved PM2's process list"


def cmd_install(env: Mapping[str, str], ps_output: str | BugsError, pm2: Pm2 | None = None) -> int:
    """Install the launcher, start Pull once under PM2, and print the allow rule if it is missing.

    Args:
        env: Environment (the ``BUGS_BOT_*`` overrides place the launcher and the settings read).
        ps_output: ``ps -eo pid=,command=`` output, to refuse a second Pull; the error when unreadable.
        pm2: The PM2 runner; ``None`` runs the PM2 on ``env``'s ``PATH``.

    Returns:
        0 when the launcher and Pull are in place, else 1.
    """
    home = _home(env)
    launcher = install_launcher(_launcher_dir(env))
    print(f"ok    launcher: installed {launcher}")
    code = 0
    try:
        if isinstance(ps_output, BugsError):
            raise ps_output
        print(f"ok    pull: {start_pull(pm2 or pm2_runner(env, home), launcher, home, ps_output)}")
    except BugsError as exc:
        print(f"FAIL  pull: {exc}")
        code = 1
    rule = _allow_rule(_claude_dir(env))
    print(f"ok    allow rule: {rule.detail}" if rule.ok else f"todo  allow rule: add it yourself, {PERMISSIONS_LINE}")
    print("next: /bugs-bot:init in each project's repository (the platform, its token the first time, the group)")
    return code
