# The orchestrator's machine-wide state

Every file the orchestrator writes under its state, who writes it, and how. The state has three
roots (core's `orchestration.ts` and `roots.ts`):

- **protected**: `<config dir>/claude-orchestrator/`, or `ORCHESTRATOR_STATE_DIR`. What runs or is
  trusted: `venv/`, the launch files under `prompts/`, `mcp.json`, `models.json`, `routing/`,
  `config.json`, the status line tap's files, `sleeping.json`, `coordinator.json` and its lock, and
  `data-root.json`;
- **data**: the directory the protected root's `data-root.json` names (`{"version": 1, "dir":
  "<absolute path>"}`), else the protected root. What any session writes. Nothing read there decides
  what runs;
- **module**: the hooks module's own files, `ORCHESTRATOR_MODULE_DIR`, else the data root of
  `<config dir>/claude-orchestrator/`.

Goal 1 of the orchestrator's refoundation design (the repository's specs): every such fact is kept by core's
store (a lock `<path>.lock`, a unique temporary name, one rename). A hooks module has no
`node:fs`; it reaches the same convention through `core/store-io.ts` over its own `$`, a script
through `core/store.ts`. A temporary file older than core's `STALE_MS` was left by a writer
killed between its write and its rename: the module removes those at each session start and at
each read of the store and of the round.

Concurrent writers are separate processes: the hooks module of each session, the scripts, the
Python launcher.

| File | Root | Writers | Discipline |
|---|---|---|---|
| `store/sessions/<id>` | module | the session's own hooks (measure, usage); any reader removes a dead row | one writer, one rename |
| `store/gates/<id>`, `store/rows/<id>`, `store/answered/<id>`, `store/successors/<id>` | module | the session's own hooks | one writer, one rename (gates: a plain write) |
| `store/remote/<name>` | module | the receiving session; any reader removes a stale row | one rename under `<name>.lock`; a reader removes a row met stale only after reading it again, still stale, under that lock |
| `round/<id>.json` | data | the hooks of every session (sender, pane, delivery, successor move); the coordinator's `settle` (hooks too), `round-archive` and `succession.sh takeover` | read-modify-write under the entry's lock |
| `store/waits/<id>` | module | the session's own relay; the coordinator's hooks and its `settle`, forgetting a fingerprint | under the file's lock; a write merged with what another process changed since this one read it (`mergeWait`) |
| `chains/<tty>.jsonl` | data | every launcher process (spawn, close, move, takeover) | read-modify-write under the chain's lock (`chain_change`), a unique temporary name |
| `round-woken.json` | data | the coordinator's hooks (two at a succession) | ids added under the file's lock, the list read again first |
| `store/coordinator-learnt` | module | every orchestrator's hooks | replaced whole, one rename: the last coordinator learnt |
| `pane-open-<name>` | data | the session's own hooks, on his word (the command, the tool, his ✕): present while the role's supervision pane is open, `<name>` the session name without its reference; read by the successor's first turn start | one rename; removed by his close |
| `deck.json` | data | every session | a view of the store, written only when it differs from the file or the file's stamp is a minute old (`DECK_REFRESH_MS`); format fixed by `hooks/tests/golden-deck.ts` |
| `sleeping.json`, `coordinator.json` | protected | the coordinator's scripts | under the coordinator's lock |
| dispatch records, `records/<session>` | data | `dispatch-record.ts` | under core's lock |
| `measure/<id>.json` | module | the session's own gauge | one writer, replaced whole in one rename, removed (never emptied) at compaction, kept at session end and pruned by `install.sh` past 90 days; read as unmeasured when empty or partial |
| module log | module | every process | appends |
| `close.log`, `home-release.log` | data | the launcher | appends |

A writer in another language reads the convention as data, `core/store.json` (the launcher,
`iterm_agent.py`, `path_lock`).
