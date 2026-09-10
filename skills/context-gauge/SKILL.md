---
name: context-gauge
description: Use when a session must know its own context fill as a measured figure — before dispatching a phase, when reporting to an orchestrator, or when deciding on rotation or succession — instead of estimating it.
---

# Context gauge

## Overview

`${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh` prints a session's context fill as `key=value` lines. It reads two tiers and always says which one answered:

- `source=tap` — the exact figure the host gave the status line on its last render, recorded by the tap that `/orchestrator:install` wires in front of the status line. Used when younger than 120 s (`--max-age`).
- `source=transcript` — computed from the session's own transcript: the last `usage` block's input plus cache tokens is the context sent on the last turn. Within half a point of the tap in observed runs. Needs the window size: the stale tap file's `context_total`, else `--window`, else 200000 — `context_window_source=` names which one was used.

## Reading your own gauge

```bash
${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh
```

Output:

```
context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=3          # or `unavailable`
seven_day_percent=1          # or `unavailable`
source=tap
```

The session id defaults to `CLAUDE_CODE_SESSION_ID`, which the host sets in every session's environment. Pass another session's id to read a peer — only from a machine that holds its tap file or its transcript.

## Rules

- **Report the measurement, never an estimate.** Paste the `context_percent=` line and its `source=` line in every report an orchestrator asks for.
- An idle session stops rendering its status line, so its tap file ages and the gauge falls back to the transcript. That is expected: `source=transcript` is not an error.
- `context_window_source=default` means the window was assumed. Pass `--window` when the model's window differs from 200000, or wire the tap so the file carries the real total.
- Without the tap wired, only the transcript tier answers, and it needs `python3`.
- The tap is a wrapper, never a patch: it records the payload and hands it untouched to whatever status line the user already runs.
