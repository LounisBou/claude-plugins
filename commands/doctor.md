---
description: Re-run the dependency diagnostic for this plugin
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh --check` and report its output to the user
verbatim. It is the same diagnostic `/pr-review:install` ends with, available on
demand for when something stops working later; `--check` skips the GitHub login
step, so nothing is installed and no browser opens.

Read the exit code and tell the user which class of problem it names:

| Code | Meaning | Remedy |
|---|---|---|
| `0` | everything satisfied | — |
| `10` | an upstream plugin is missing **or installed but disabled** | install it, then enable it in `/plugin` |
| `11` | a system tool is missing | install the one named (python3 3.9+, curl, gh) |
| `12` | no GitHub token | `/pr-review:install`, which opens the GitHub login in the browser |
| `13` | not a GitHub repository clone | run from one, or check the `origin` remote |

The script writes nothing and changes nothing.

$ARGUMENTS
