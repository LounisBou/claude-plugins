# Closing Round Implementation Plan

> **For the orchestrator:** this plan is executed by an implementer SESSION the orchestrator spawns (`orchestrator:iterm-agents`), one brief for the task — never by a subagent of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one release, 0.26.1: the rulebook and the tab skill say a delivered implementer is stood down at the verification of its delivery; a title's subject neither starts nor ends on a space; the prompt file carries the `prompt-` prefix; the library's known stderr noise is dropped by a filter on the `asyncio` logger, measured live by the orchestrator. Everything else on the deferred list is closed in `docs/design.md` §45 with its reason and needs no change.

**Architecture:** `skills/iterm-agents/scripts/iterm_agent.py` (`TITLE_SHAPE` and its refusal, `write_prompt_file`, the logging filter installed at import), `skills/orchestrator/SKILL.md` (lifecycle step 4), `skills/iterm-agents/SKILL.md` (tab hygiene), the suite.

**Tech Stack:** Python 3 (standard library), bash 3.2.

**Spec:** `docs/design.md` section 45; sections 29, 36, 42 bind the readings.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits with a scope, as the history reads (`git log --format=%s -8`); no trailer, no attribution, no tool name, no session link. Subject in the imperative, body says why.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (374 on the base head `cc8221c`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release**: version in `plugin.json` and both fields of `marketplace.json`: `0.26.1`, the LAST commit of the branch.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call. The first suite run in a fresh copy takes minutes.
- **The checkout you work in is already on the task's branch**: do not create another branch.
- **`tests/e2e.sh` is edited, never run**: the orchestrator runs the live round. No live spawn from this checkout.
- **Mutations run on the committed tree only**, on a scratch copy of the file where a file is edited: a `git checkout -- <file>` over uncommitted work discards it (observed twice).

---

### Task 1: The closing round (0.26.1)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `TITLE_SHAPE`, the two refusal sentences that name the cap, `write_prompt_file`, a logging filter installed at module import.
- Modify: `skills/orchestrator/SKILL.md` — lifecycle step 4 (« The agents' lifecycle is yours », item 4); succession steps 3 and 4 (« Your own context »).
- Modify: `templates/orchestrator-succession-brief.md` step 4, `commands/succeed.md` step 3 — the handover message.
- Modify: `skills/iterm-agents/SKILL.md` — the « Tab hygiene » paragraph.
- Modify: `tests/run-tests.sh` — the checks below; every existing literal that read the old lifecycle sentence or the old prompt-file name moves, never deleted.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.26.1`.
- Already committed on this branch by the orchestrator: `docs/design.md` §45 (and the pointer under §36) and this plan.

**Interfaces (verbatim, the contract the checks read):**

- `TITLE_SHAPE = re.compile(r"^(Orch|Agent) : \S(.{0,23}\S)?\Z")`. The refusal of a typed title, exit 1: `spawn: refused: a title reads "Orch : <subject>" or "Agent : <subject>", the subject at most 25 characters and neither starting nor ending with a space, got '<title>' (pass --title-free for a tab named otherwise)`. The derived-name refusal keeps its sentence.
- `write_prompt_file`: the path is `<PROMPTS_DIR>/prompt-<safe>-<ms>.txt`, `safe` and `<ms>` as today; the dry run's `prompt_file=` line shows it.
- The filter: a class in the module, installed once at import on `logging.getLogger("asyncio")`; it returns `False` for a record whose `getMessage()` starts with `Task exception was never retrieved` and whose `exc_info` carries an exception class whose `__name__` starts with `ConnectionClosed`; it returns `True` for every other record. It imports nothing but `logging`. No handler is added, no level is changed.
- Rulebook, lifecycle step 4, the sentence that replaces « An implementer stays through the review round of ITS delivery and the N-bis that round produces — a one-line fix is minutes for the session that wrote the code and a cold start for any other — and is stood down at the verdict, approved or shelved. »: `An implementer is stood down at the verification of its delivery, never kept through the review round of it: a review finding goes to a fresh session with a resume brief, and the cold start is the accepted price (the operator's ruling, after an implementer left open through a round). It stays only when a NEXT phase is dispatched to it at that verification.` The rest of the item (the acknowledgment guard, the workspace delete, the standing-by paragraph) stays; « A fixup after the verdict goes to a fresh session with a resume brief » stays.
- Tab skill, « Tab hygiene », the sentence that replaces « An implementer stays through the review round of its own delivery and the N-bis that round produces, and is stood down at the verdict; there is no « standing by » tab after it: a later fixup goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable. »: `An implementer is stood down at the verification of its delivery, never kept through its review round; a review finding goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable.`
- The literal `stays through the review round` appears in neither document afterwards (it may stay in `docs/design.md`, which the suite does not read).
- Succession handover, three documents. `commands/succeed.md` step 3 becomes: `3. Answer nothing new. Wait for the successor's "takeover confirmed"; answer its questions about state only. On the confirmation, send it « handed over » as your LAST message — nothing of yours is left to write — and end the turn: that message is what it closes your tab on.` The rulebook, « Your own context », succession step 3: the words « message the predecessor "takeover confirmed"; then CLOSE the predecessor's tab » become « message the predecessor "takeover confirmed" and wait for its « handed over » — its last message, sent when nothing of its own is left to write — then CLOSE the predecessor's tab; five minutes without it, read the tab's screen (`screen --tty`) and close on a prompt with nothing in flight, never on the host's idle notice, which reaches a working session only when its own turn ends (measured: a quarter of an hour late) ». Step 4 gains: « on it, « handed over » is its last message, and the turn ends there ». `templates/orchestrator-succession-brief.md` step 4: « Message the predecessor "takeover confirmed". Then CLOSE ITS TAB … » becomes « Message the predecessor "takeover confirmed" and wait for its « handed over » (its last message; five minutes without it, read its screen with `screen --tty` and close on a prompt with nothing in flight). Then CLOSE ITS TAB … » with the rest of the step unchanged.

- [ ] **Step 1: The failing checks** — shape: `Agent :  ` (subject one space) and `Agent : x ` refused with `neither starting nor ending with a space` in the sentence, `Agent :  x` refused, `Agent : x y` accepted, a twenty-five-character subject accepted and a twenty-six-character one refused (the existing checks, kept); the dry run's `prompt_file=` value's basename starts with `prompt-`; the filter, through `"$py" -c` importing the module: a record built with `logging.LogRecord` carrying message `Task exception was never retrieved` and `exc_info` of a stand-in class named `ConnectionClosedError` is dropped (`filter()` returns `False`), the same record with another exception class is passed, a record with another message and that class is passed, and `logging.getLogger("asyncio").filters` holds exactly one instance of the class; one literal guard per document for the new lifecycle sentence (present once) and the old literal (absent): `skills/orchestrator/SKILL.md`, `skills/iterm-agents/SKILL.md`. The literal `handed over` present (at least once) in each of `skills/orchestrator/SKILL.md`, `templates/orchestrator-succession-brief.md`, `commands/succeed.md`, and `wait for its « handed over »` present in the rulebook and the template.
- [ ] **Step 2: Run, watch them fail, report** the count and the first failing value.
- [ ] **Step 3: The code**, in the module's style, then the two documents.
- [ ] **Step 4: Mutations on the committed tree**: the shape widened back to `.{1,25}` → the two space checks fall; the filter's message test dropped → the « another message passed » check falls; the `prompt-` prefix dropped → its check falls; the old sentence put back in the rulebook → its absent guard falls; `handed over` removed from `commands/succeed.md` → its guard falls. Restore each; `git diff --stat` empty before the suite.
- [ ] **Step 5: The gate**, then `0.26.1`, then the suite again.
- [ ] **Step 6: Commits** — `fix(iterm-agents): a subject neither starts nor ends on a space`; `refactor(iterm-agents): the prompt file carries its kind in its name`; `fix(iterm-agents): drop the library's known stderr noise at the logger`; `docs(orchestrator): a delivered implementer is stood down at the verification`; `docs(orchestrator): the predecessor says handed over, and the successor closes on it`; `chore(release): 0.26.1` last.
