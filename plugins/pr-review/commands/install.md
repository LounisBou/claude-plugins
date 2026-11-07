---
description: Sign in to GitHub through gh, then check that this plugin's dependencies are installed, enabled and authenticated
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Before running it, tell the user in one line: if no GitHub login is found, a browser
page opens on GitHub; the one-time code is on the clipboard, to paste there and approve.

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` with a timeout of 600000 ms (the login waits on
the user), and report its output to the user verbatim.

When `GH_TOKEN` is not set, the script gives the machine a GitHub login through `gh`:
it installs `gh` when it is missing (Homebrew on macOS, the official release binary
into `~/.local/bin` on Linux), then runs `gh auth login --web` when `gh` holds no
token. The token stays in `gh`'s credential store; the script never prints it. Each
step is skipped when already satisfied.

It then verifies that the two plugins this one builds on are installed **and
enabled**, and that python3, curl and a GitHub token are available. It does not need a
git repository: it runs from any directory, and each skill checks for a GitHub clone
when it starts. On failure it prints the exact command that fixes the first problem
it found.

Installed and enabled are different things: a plugin can sit on disk and be inert,
which is why the check reads the `enabledPlugins` map rather than looking for files.

$ARGUMENTS
