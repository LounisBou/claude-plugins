# The orchestrator's machine-wide state

Every file the orchestrator writes under its state root (`<config dir>/claude-orchestrator/`,
`ORCHESTRATOR_STATE_DIR` and `ORCHESTRATOR_MODULE_DIR` overriding it), who writes it, and how.
Goal 1 of the orchestrator's refoundation design (the repository's specs): every such fact is kept by core's
store (a lock `<path>.lock`, a unique temporary name, one rename). A hooks module has no
`node:fs`; it reaches the same convention through `core/store-io.ts` over its own `$`, a script
through `core/store.ts`. A temporary file older than core's `STALE_MS` was left by a writer
killed between its write and its rename: the module removes those at each session start and at
each read of the store and of the round.

Concurrent writers are separate processes: the hooks module of each session, the scripts, the
Python launcher.

| File | Writers | Discipline |
|---|---|---|
| `store/sessions/<id>` | the session's own hooks (measure, usage); any reader removes a dead row | one writer, one rename |
| `store/gates/<id>`, `store/rows/<id>`, `store/answered/<id>`, `store/successors/<id>` | the session's own hooks | one writer, one rename (gates: a plain write) |
| `store/remote/<name>` | the receiving session; any reader removes a stale row | one rename, no read-modify-write |
| `round/<id>.json` | the hooks of every session (sender, pane, delivery, successor move); `coordinator.sh round-close` and `round-archive` | read-modify-write under the entry's lock |
| `store/waits/<id>` | the session's own relay; the coordinator's hooks and `round-close`, forgetting a fingerprint | under the file's lock; a write merged with what another process changed since this one read it (`mergeWait`) |
| `chains/<tty>.jsonl` | every launcher process (spawn, close, move, takeover) | read-modify-write under the chain's lock (`chain_change`), a unique temporary name |
| `round-woken.json`, `round-told.json` | the coordinator's hooks (two at a succession) | ids added under the file's lock, the list read again first |
| `store/coordinator-learnt` | every orchestrator's hooks | replaced whole, one rename: the last coordinator learnt |
| `deck.json` | every session | a view of the store, written only when it differs from the file or the file's stamp is a minute old (`DECK_REFRESH_MS`); format fixed by `hooks/tests/golden-deck.ts` |
| `sleeping.json`, `coordinator.json` | the coordinator's scripts | under the coordinator's lock |
| dispatch records, `records/<session>` | `dispatch-record.ts` | under core's lock |
| `measure/<id>.json` | the session's own gauge | one writer, plain write, read as unmeasured when partial |
| `store/moves/<move>.json` | the session that sent the move (`hooks/moving.ts`) | read-modify-write under the file's lock: the receiver's address pinned, a round of « missing » counted, the outcome |
| `store/moves/<move>/` | the session that receives the move, its messages one at a time | one rename per file (the manifest, each chunk, each acknowledgment); a file's chunks removed once it landed |
| `briefs/<subject>/<file>` landed by a move, and a dispatch record kept elsewhere landed at its path | the receiving session | under the landed path's lock, one rename; a file already there with other content is refused and left alone |
| module log, `close.log`, `store/moves/probes.jsonl` | every process | appends |

A writer in another language reads the convention as data, `core/store.json` (the launcher,
`iterm_agent.py`, `path_lock`).
