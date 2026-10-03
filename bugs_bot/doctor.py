"""``doctor``: check the machine's setup, and install the fixed launcher.

It reads the Claude settings and never writes them: a session may not change its own permissions,
so a missing allow rule is printed for the operator to add.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from bugs_bot.channel import Transport
from bugs_bot.channels import channel_for, mask, token_problem
from bugs_bot.errors import BugsError
from bugs_bot.project import DEFAULT_CHANNEL
from bugs_bot.store import Machine, bugs_home

MIN_PYTHON = (3, 10)
ALLOW_RULE = "Bash(bugs-bot:*)"
PERMISSIONS_LINE = f"/permissions → Allow → {ALLOW_RULE}"
SETTINGS_FILES = ("settings.json", "settings.local.json")
# Interpreter options that take the next word as their argument (``-X dev``), and those that replace the script.
OPTIONS_WITH_ARGUMENT = {"-X", "-W"}
PROGRAM_OPTIONS = {"-c", "-m"}
PULL_APP = "bugs-bot-pull"
# Where the host unpacks each version of this plugin (the launcher's own glob): a path in it is gone once an
# update prunes that version.
VERSIONED_DIR = "/plugins/cache/lounisbou/bugs-bot/"

# What every session runs as ``bugs-bot``: the newest installed version of the plugin's CLI. The newest
# directory is chosen first and only then checked for its CLI, so a half-removed version is refused
# instead of letting an older one run silently. ``sort -V`` orders 0.10.0 after 0.2.0 (BSD sort on macOS has it).
# ``BUGS_BOT_PYTHON`` picks the interpreter (a pyenv binary, not its shim), as PM2 passes it through its ``env``.
LAUNCHER_MARKER = "# bugs-bot launcher: installed by `bugs-bot doctor --install-launcher`"
LAUNCHER_TEXT = "#!/bin/sh\n" + LAUNCHER_MARKER + """
d=$(ls -d "${BUGS_BOT_CLAUDE_DIR:-$HOME/.claude}"/plugins/cache/lounisbou/bugs-bot/*/ 2>/dev/null | sort -V | tail -1)
[ -n "$d" ] && [ -f "${d}bin/bugs-bot" ] || { echo "bugs-bot: no installed version found — run /bugs-bot:doctor" >&2; exit 127; }
exec "${BUGS_BOT_PYTHON:-python3}" "${d}bin/bugs-bot" "$@"
"""


@dataclass(frozen=True)
class Check:
    """One verdict of ``doctor``; ``detail`` never holds the token."""

    name: str
    ok: bool
    detail: str


def pull_processes(ps_output: str) -> list[int]:
    """Return the pids running ``bugs-bot pull --watch``, from ``ps -eo pid=,command=`` output.

    The program must be what the process runs (directly, or as the script of a python interpreter):
    a ``tail`` or ``grep`` merely naming it is not Pull.
    """
    pids = []
    for line in ps_output.splitlines():
        pid, _, command = line.strip().partition(" ")
        words = command.split()
        if not pid.isdigit() or not words:
            continue
        if Path(words[0]).name.lower().startswith("python"):  # Homebrew's is .../Python.app/Contents/MacOS/Python
            words = words[1:]
            while words and words[0].startswith("-") and words[0] not in PROGRAM_OPTIONS:  # interpreter options such as -u
                words = words[2:] if words[0] in OPTIONS_WITH_ARGUMENT else words[1:]
        if words and Path(words[0]).name == "bugs-bot" and words[1:2] == ["pull"] and "--watch" in words[2:]:
            pids.append(int(pid))
    return pids


def install_launcher(target_dir: Path) -> Path:
    """Write ``target_dir/bugs-bot`` (mode 0755), replacing an older launcher; return its path.

    The new text goes to a temporary file in the same directory, then ``os.replace`` swaps it in: a
    symlink at the target is replaced, never written through, and no reader sees a half-written file.

    Raises:
        BugsError: If the target exists and is not a bugs-bot launcher (it is left untouched).
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "bugs-bot"
    if path.is_symlink() or path.exists():
        try:
            current = path.read_text()
        except (OSError, ValueError):
            current = ""
        if LAUNCHER_MARKER not in current:
            raise BugsError(f"{path} exists and is not a bugs-bot launcher: move it away, then install again")
    fd, tmp = tempfile.mkstemp(dir=target_dir, prefix=".bugs-bot.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(LAUNCHER_TEXT)
        os.chmod(tmp, 0o755)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def _claude_dir(env: Mapping[str, str]) -> Path:
    return Path(env.get("BUGS_BOT_CLAUDE_DIR") or Path.home() / ".claude")


def _launcher_dir(env: Mapping[str, str]) -> Path:
    return Path(env.get("BUGS_BOT_LAUNCHER_DIR") or Path.home() / ".local" / "bin")


def _python() -> Check:
    version = ".".join(str(part) for part in sys.version_info[:3])
    return Check("python", tuple(sys.version_info[:2]) >= MIN_PYTHON, f"{version} (needs {'.'.join(map(str, MIN_PYTHON))}+)")


def _entries(env: Mapping[str, str]) -> dict:
    try:
        return Machine(bugs_home(env)).registry.entries()
    except BugsError:
        return {}  # the registry check says why


def _kinds(env: Mapping[str, str]) -> list[str]:
    """Return the channel kinds whose token is needed: those of the registered projects, else Telegram's."""
    return sorted({kind for kind, _ in _entries(env)}) or [DEFAULT_CHANNEL]


def _token(env: Mapping[str, str], kind: str) -> Check:
    # Telegram's check keeps the name it always had.
    name = "token" if kind == DEFAULT_CHANNEL else f"{kind} token"
    problem = token_problem(kind, env)
    if problem is not None:
        return Check(name, False, problem)
    return Check(name, True, "present")


def _bot(env: Mapping[str, str], kind: str, transport: Transport) -> Check:
    """Ask the platform who the bot is: the token is not only present but accepted."""
    secret = None
    try:
        channel = channel_for(kind, env, transport)
        secret = channel.secret
        return Check(f"{kind} bot", True, f"answering as {channel.whoami()}")
    except Exception as exc:  # noqa: BLE001 - a check fails, doctor goes on; the token never shows
        return Check(f"{kind} bot", False, mask(str(exc), secret))


def _registry(env: Mapping[str, str]) -> Check:
    try:
        entries = Machine(bugs_home(env)).registry.entries()
    except BugsError as exc:
        return Check("registry", False, str(exc))
    return Check("registry", True, f"{len(entries)} project(s) registered")


def _pm2_script(jlist: str | None) -> str | None:
    """Return the script PM2 recorded for ``bugs-bot-pull`` in ``pm2 jlist`` output; ``None`` when unknown.

    With no daemon up, PM2 prints ``[PM2] Spawning PM2 daemon …`` lines before the JSON array: it starts at
    the first line that begins with ``[`` (the preamble's own lines begin with ``[PM2]``, then a space).
    """
    lines = (jlist or "").splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith("[") and not line.startswith("[PM2]")), None)
    if start is None:
        return None
    try:
        for app in json.loads("\n".join(lines[start:])):
            if app.get("name") == PULL_APP:
                return app["pm2_env"]["pm_exec_path"]
    except (ValueError, TypeError, KeyError, AttributeError):
        pass
    return None


def _pull(ps_output: str | BugsError, pm2_jlist: str | None = None) -> Check:
    if isinstance(ps_output, BugsError):
        return Check("pull", False, str(ps_output))
    pids = pull_processes(ps_output)
    if len(pids) <= 1:
        # A pruned version leaves no Pull running at all: PM2's restart found no script. Read what PM2 recorded
        # either way, so « start it with PM2 » is not the remedy given for that.
        script = _pm2_script(pm2_jlist)
        if isinstance(script, str) and VERSIONED_DIR in Path(script).as_posix():
            return Check(
                "pull",
                False,
                f"PM2 recorded a versioned path for {PULL_APP}: {script}; run `bugs-bot doctor --install-launcher`, "
                f"`pm2 delete {PULL_APP}`, then "
                "`BUGS_BOT_PYTHON=<python 3.10+> pm2 start <plugin>/pm2.config.js && pm2 save`",
            )
    if len(pids) == 1:
        return Check("pull", True, f"running (pid {pids[0]})")
    if not pids:
        return Check("pull", False, "not running: start it with PM2 (bugs-bot-pull)")
    return Check("pull", False, f"{len(pids)} processes (pids {', '.join(map(str, pids))}): two pollers steal each other's messages")


def _orchestrator(claude: Path) -> Check:
    found = sorted((claude / "plugins" / "cache" / "lounisbou" / "orchestrator").glob("*/")) if claude.is_dir() else []
    if found:
        return Check("orchestrator", True, f"installed ({found[-1].name})")
    return Check("orchestrator", False, "the orchestrator plugin is not installed: /bugs-bot:start needs it")


def _launcher(directory: Path) -> Check:
    path = directory / "bugs-bot"
    if not path.is_file():
        return Check("launcher", False, f"{path} missing: run `doctor --install-launcher`")
    if path.read_text() != LAUNCHER_TEXT:
        return Check("launcher", False, f"{path} differs from the current launcher: run `doctor --install-launcher`")
    if not os.access(path, os.X_OK):
        return Check("launcher", False, f"{path} is not executable: run `doctor --install-launcher`")
    return Check("launcher", True, str(path))


def _allow_rule(claude: Path) -> Check:
    unreadable = []
    for name in SETTINGS_FILES:
        path = claude / name
        if not path.is_file():
            continue
        try:
            allowed = json.loads(path.read_text()).get("permissions", {}).get("allow", [])
        except (OSError, ValueError, AttributeError):
            unreadable.append(name)
            continue
        if ALLOW_RULE in allowed:
            return Check("allow rule", True, f"{ALLOW_RULE} in {name}")
    note = f" ({', '.join(unreadable)} unreadable)" if unreadable else ""
    return Check("allow rule", False, f"{ALLOW_RULE} not allowed{note}: the operator adds it, {PERMISSIONS_LINE}")


def run_checks(
    env: Mapping[str, str], ps_output: str | BugsError, transport: Transport | None = None, pm2_jlist: str | None = None
) -> list[Check]:
    """Run every check; nothing is written.

    Args:
        env: Environment (the ``BUGS_BOT_*`` overrides place every file the checks read).
        ps_output: ``ps -eo pid=,command=`` output, so that tests never read the process table; the
            error when it could not be read, which fails the ``pull`` check and nothing else.
        transport: To ask each platform with a registered project who the bot is; ``None`` asks none.
        pm2_jlist: ``pm2 jlist`` output, to fail a Pull that PM2 runs from a versioned path; ``None`` when
            PM2 is absent or unreadable, which leaves the ``pull`` verdict as the process table gives it.
    """
    claude = _claude_dir(env)
    registered = {kind for kind, _ in _entries(env)}
    tokens = []
    for kind in _kinds(env):
        tokens.append(_token(env, kind))
        if transport is not None and kind in registered and tokens[-1].ok:
            tokens.append(_bot(env, kind, transport))
    return [
        _python(),
        *tokens,
        _registry(env),
        _pull(ps_output, pm2_jlist),
        _orchestrator(claude),
        _launcher(_launcher_dir(env)),
        _allow_rule(claude),
    ]


def cmd_doctor(
    env: Mapping[str, str],
    ps_output: str | BugsError,
    install: bool,
    transport: Transport | None = None,
    pm2_jlist: str | None = None,
) -> int:
    """Print one line per check; return 0 only when all pass.

    Args:
        env: Environment.
        ps_output: The process table, as ``run_checks`` takes it.
        install: Install the launcher first (the first run, when it does not exist yet).
        transport: To ask each platform with a registered project who the bot is.
        pm2_jlist: PM2's process list, as ``run_checks`` takes it.
    """
    if install:
        print(f"installed {install_launcher(_launcher_dir(env))}")
    checks = run_checks(env, ps_output, transport, pm2_jlist)
    for check in checks:
        print(f"{'ok  ' if check.ok else 'FAIL'}  {check.name}: {check.detail}")
    return 0 if all(check.ok for check in checks) else 1
