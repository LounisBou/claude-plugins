#!/usr/bin/env python3
"""Locate the installed `github` plugin.

`${CLAUDE_PLUGIN_ROOT}` names this plugin's own directory and nothing else, so a
plugin cannot reach a sibling through it. The platform records every install in
installed_plugins.json with an authoritative `installPath`; that is what we read.

A cache path is never constructed. Installed versions are sometimes git SHAs
rather than semver, so any hand-built path is wrong by construction.
"""
import json
import os
import sys

# Both keys are accepted: the plugin resolves under its own marketplace and
# under the aggregate one, and which key appears depends on where the user
# installed it from.
KEYS = ("github@lounisbou", "github@claude-github")

DEFAULT_STATE = "~/.claude/plugins/installed_plugins.json"


class NotFound(Exception):
    """No usable installPath. Carries the remedy, not just the complaint."""

    def __init__(self, problem, fix):
        super().__init__(problem)
        self.problem = problem
        self.fix = fix


def resolve(env=None, state_path=None):
    """Return the github plugin's root directory, or raise NotFound."""
    env = os.environ if env is None else env

    # An empty override is no override at all: fall through to the state file.
    # A non-empty one that names nothing on disk is a misconfiguration, and it
    # gets the same treatment as a recorded installPath that is gone — handing
    # the path back would satisfy the caller's `|| exit 1` and move the failure
    # to some later block, far from its cause.
    override = env.get("CLAUDE_GITHUB_ROOT")
    if override:
        if not os.path.isdir(override):
            raise NotFound(
                "CLAUDE_GITHUB_ROOT is not a directory: %s" % override,
                "unset CLAUDE_GITHUB_ROOT, or point it at a checkout of the github plugin",
            )
        return override

    path = state_path or env.get("CLAUDE_PLUGIN_STATE") or os.path.expanduser(DEFAULT_STATE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        raise NotFound(
            "cannot read the plugin state file: %s" % path,
            "install the dependency: /plugin install github@lounisbou",
        )
    except ValueError:
        raise NotFound(
            "the plugin state file is not valid JSON: %s" % path,
            "reinstall the dependency: /plugin install github@lounisbou",
        )

    # Anything but the expected shape means the same thing: no evidence the
    # dependency is installed. Never fall through to a guess.
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, dict):
        raise NotFound(
            "the plugin state file has no plugins map: %s" % path,
            "reinstall the dependency: /plugin install github@lounisbou",
        )

    for key in KEYS:
        entries = plugins.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            root = entry.get("installPath")
            # A recorded path that is gone from disk is not a resolution.
            if isinstance(root, str) and root and os.path.isdir(root):
                return root

    raise NotFound(
        "the github plugin is not installed (looked for %s)" % " and ".join(KEYS),
        "/plugin install github@lounisbou",
    )


def main():
    try:
        sys.stdout.write(resolve() + "\n")
    except NotFound as exc:
        sys.stderr.write("error: %s\n" % exc.problem)
        sys.stderr.write("fix:   %s\n" % exc.fix)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
