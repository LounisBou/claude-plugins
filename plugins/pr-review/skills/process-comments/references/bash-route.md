## Bash route (no `mcp__github__gh` in the tool list)

Only for a session where plugin modules do not load, such as `claude -p`. Send
the request `SKILL.md` writes for the tool to the same engine from Bash, the
request object on standard input, no file in between:

```bash
GH_ROOT=$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/resolve_github.py") || exit 1
python3 "$GH_ROOT/engine/gh.py" --stdin-json <<'PR_REVIEW_REQUEST'
<the request object, as JSON>
PR_REVIEW_REQUEST
```

`${CLAUDE_PLUGIN_ROOT}` names this plugin and reaches no sibling, so the resolver
reads the platform's install record rather than assembling a path into the plugin
cache. When the dependency is missing it prints an `error:` line and a `fix:`
line: stop there. Never take this route while the tool is listed.

## Triage

When `mcp__pr-review__open_comments` is not in your tool list, run the same
triage from Bash. It fetches everything itself through the github plugin's engine
and prints the same document:

```bash
GH_ROOT=$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/resolve_github.py") || exit 1
python3 "${CLAUDE_PLUGIN_ROOT}/skills/process-comments/scripts/triage.py" --gh "$GH_ROOT/engine/gh.py"
```

Add `--pr <number>` when the user named a PR. A non-zero exit prints one `error:`
line: show it and stop.
