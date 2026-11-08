# Contracts between plugins

Every format, file, command or name that one plugin produces and another reads. Each has one
owner, who alone writes it and versions it. A contract typed in `core` lives in one module;
another language reads it as the JSON `npm run core` writes from that module. The column
« Target » says what program goal 4 turns each one into. A coupling absent from this table is a
defect.

| Contract | Owner | Read by | Today | Target |
|---|---|---|---|---|
| Measure file (`measure/<session>.json`): fill, window, model | orchestrator | statusbar, bugs-bot, the launcher | untyped JSON; statusbar re-derives the gate in bash | typed in `core`; statusbar shows the owner's `past_gate` instead of recomputing it |
| `deck.json` | orchestrator | Stream Deck (outside) | versioned JSON, written on every measure | the same format, a view of the state store, one writer, rate-limited |
| Session name shapes (`Orch :`, `Agent :`, `Audit :`, `Coord :`) | orchestrator | statusbar, bugs-bot, norms | one regex per language, already diverging | one definition in `core` |
| Round files (`round/*.json`): questions, answers | orchestrator | github (waivers, auto-merge consent) | github reads the private directory | a declared consent contract; github never reads `round/` |
| PR records (review, norms, e2e) | github | orchestrator, norms, pr-review | **typed in core** (`pr-record.ts`, version 1); github's Python writer loads the generated `pr-record.json`; tested across both (`scripts/contracts.test.ts`) | still self-attested, behind a substring guard: the one ready gate (program goal 8) |
| `mcp__github__gh` commands (`pr-create`, `pr-readiness`, `record`) | github | orchestrator, norms, pr-review | undeclared by orchestrator | declared dependency with a version range |
| Launcher CLI (`iterm-agent.sh spawn`) | orchestrator | bugs-bot | hard-coded path | a declared command with a versioned argument set |
| `ListAgents` text | host | bugs-bot | parsed by regex | the host's structured data, or a `core` parser owned once |
| Environment: `ORCHESTRATOR_SPAWNED`, `ORCHESTRATOR_CONTEXT_GATE*`, `CLAUDE_GITHUB_ROOT` | orchestrator / github | norms, statusbar | **named in core** (`env.ts`); `npm run deps` refuses another plugin's variable core does not declare; norms reads `ORCHESTRATOR_SPAWNED` through `isSpawned` | statusbar reads the gate from the measure file instead of the variables |

## Installer permission rules

The rules an installer writes (conventions, « Permissions and security »). Each names its own
script, which validates every argument.

| Rule | Plugin | Validation the script performs |
|---|---|---|
| `Bash(<install>/skills/iterm-agents/scripts/iterm-agent.sh spawn --open *)` | orchestrator | permission mode in an allowlist (program, orchestrator defect D2), directory checks |
