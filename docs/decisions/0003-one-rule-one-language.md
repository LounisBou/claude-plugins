# 0003 — TypeScript for logic, one language per rule

**Context.** The same rules were written in TypeScript, bash and Python and held equal by
tests: the session-name regex four times, the push detector four times, the cost rule twice,
the negative-phrase list twice, the read/write classification twice. The copies diverged.

**Decision.** Hooks, modules and tooling are strict TypeScript. Existing Python engines (github,
cloudflare, bugs-bot) stay Python; the orchestrator keeps a thin Python adapter for the iTerm2
API, the one API that exists only there. A rule is implemented in exactly one language; when
the other side needs it, it reads it as data or calls the side that owns it. Bash carries no
logic beyond an entry point.

**Cost.** Porting each bash script of the orchestrator to TypeScript, one per pull request.
