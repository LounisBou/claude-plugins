# Contracts between plugins

Every format, file, command or name that one plugin produces and another reads. Each has one
owner, who alone writes it and versions it. A contract typed in `core` lives in one module;
another language reads it as the JSON `npm run core` writes from that module. The column
« Target » says what program goal 4 turns each one into. A coupling absent from this table is a
defect.

| Contract | Owner | Read by | Today | Target |
|---|---|---|---|---|
| Measure file (`measure/<session>.json`): fill, window, model, the session's `start` (its first figure, the brief it started on and its size) | orchestrator | statusbar, bugs-bot, the launcher | untyped JSON; statusbar re-derives the gate in bash | typed in `core`; statusbar shows the owner's `past_gate` instead of recomputing it |
| Plan state file (`IMPLEMENTATION.md`): header, `\| phase \| title \| status \| milestone \|` rows | method | implement (orchestrator to come) | **typed in core** (`method.ts`: `parseState`, `markRow`, `nextRow`); format in `plugins/method/skills/lifecycle/references/plan.md` | the orchestrator's plans read through the same functions |
| Report status line (`status: done\|blocked\|question — …`) | method | implement (orchestrator's relay to come) | **typed in core** (`method.ts`: `reportStatus`); implement's skills end on it | the orchestrator's `parseStatus` replaced by `reportStatus` |
| `deck.json` | orchestrator | Stream Deck (outside) | versioned JSON, a view of the state store held byte for byte by a golden test; each session writes it only when it differs from the file, and the minute's refresh is the machine's (orchestrator 0.98.11) | the same format, a view of the state store, one writer, rate-limited |
| Session name shapes (`Orch :`, `Agent :`, `Audit :`, `Coord :`) | orchestrator | statusbar, bugs-bot, norms | one regex per language, already diverging | one definition in `core` |
| Round files (`round/*.json`): questions, answers | orchestrator | github (waivers, auto-merge consent) | github reads the private directory | a declared consent contract; github never reads `round/` |
| PR records (review, norms, e2e) | github | orchestrator, norms, pr-review | **typed in core** (`pr-record.ts`, version 1); github's Python writer loads the generated `pr-record.json`; tested across both (`scripts/contracts.test.ts`); the review verdict is computed from the review agents' findings blocks (pr-review 0.7.0); github refuses a review record written by the session that pushed the head (github 0.14.0), and implement launches its reviewer as another session (`/implement:review`, 0.5.0) | the pushed heads known across sessions and machines, not only by the session that pushed |
| `mcp__github__gh` commands (`pr-create`, `pr-readiness`, `record`) | github | orchestrator, norms, pr-review | undeclared by orchestrator | declared dependency with a version range |
| Launcher CLI (`iterm-agent.sh spawn`) | orchestrator | bugs-bot, implement | located through the host's install record (core `recordedInstallPaths`); script path hard-coded | a declared command with a versioned argument set |
| `ListAgents` text | host | bugs-bot | parsed by regex | the host's structured data, or a `core` parser owned once |
| Environment: `ORCHESTRATOR_SPAWNED`, `ORCHESTRATOR_CONTEXT_GATE*`, `CLAUDE_GITHUB_ROOT` | orchestrator / github | norms, statusbar | **named in core** (`env.ts`); `npm run deps` refuses another plugin's variable core does not declare; norms reads `ORCHESTRATOR_SPAWNED` through `isSpawned` | statusbar reads the gate from the measure file instead of the variables |

## Installer permission rules

The rules an installer writes (conventions, « Permissions and security »). Each names its own
script, which validates every argument.

| Rule | Plugin | Validation the script performs |
|---|---|---|
| `Bash(<install>/skills/iterm-agents/scripts/iterm-agent.sh spawn --open *)` | orchestrator | permission mode in an allowlist (program, orchestrator defect D2), directory checks |
| `Bash(bugs-bot:*)`, printed for the operator to add, never written (`bugs_bot/doctor.py` `ALLOW_RULE`) | bugs-bot | the CLI's own parser: one of its fixed subcommands, no shell (`deploy_check` no longer runs `shell=True`, phase 0) |
