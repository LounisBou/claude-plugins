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
| `<config dir>/consents/<owner>/<name>/<entry>.json`, outside the state root: the consent record contract the github plugin reads (the repository's contracts document) | the hooks of the session whose pane takes the operator's answer to a question that asked his consent, or `coordinator.sh round-close` relaying it | one file per question, one rename |

A writer in another language reads the convention as data, `core/store.json` (the launcher,
`iterm_agent.py`, `path_lock`).

## What a move carries

An orchestrator moved to another machine (`hooks/moving.ts`) continues there from what travels
over the peer messages, checked chunk by chunk and file by file, and rebuilds the rest. Nothing
of it goes through git but its code.

| Fact | On the target |
|---|---|
| its brief's directory: the brief, the standing succession brief (whose Live state holds its open rows, pull requests and the operator's open questions verbatim), the rulings, every regular file beside them | carried, landed in `briefs/<subject>/`, the origin's paths rewritten |
| its dispatch record, the record's owner and goals, wherever the brief's « Dispatch record » line puts them | carried beside the brief when they lie in its directory; carried by their path when they lie elsewhere, landed at that path rewritten; by git when they lie in a checkout git tracks, and the move refused when git does not |
| its name, model, effort, pull requests, working directory, checkouts, remote and branch, the operator's order | carried in the manifest, read by the arrival notice |
| its code | by git: every checkout clean and pushed before anything is sent |
| its round entries and its wait (`round/<id>.json`, `store/waits/<id>`) | rebuilt: they are keyed by the id of a session that ends on the source. Its open questions travel in the succession brief and are asked again at its first turn there, which enters them in that machine's round |
| its deck row and store rows (`store/sessions/<id>`, `store/rows/<id>`) | rebuilt at its first measure there: they hold a pid and a tty of the source |
| its chain (`chains/<tty>.jsonl`) | not carried: it names ttys of the source; its agents are stood down before a move, and the arrival opens in no chain |
| its records' paths (`records/<session>`) | rebuilt at its first read of its record, as its owner |
| its CI watches, measure files and usage | rebuilt by the woken session |
| credentials (the forge's login, keys, the host's own configuration) | never carried: each machine keeps its own |

A file is never landed outside the target's home, under a hidden name there, or inside a
checkout git rebuilds; a file already standing with other content is refused and left alone.
The source's copy is removed only once the target acknowledged every file, and a file changed
since it was sent is kept and named.

