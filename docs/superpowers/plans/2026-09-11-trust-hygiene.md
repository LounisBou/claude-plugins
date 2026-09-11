# Trust Hygiene Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.1: `spawn --trust` never rewrites a trust record that already says yes; a trust record the launcher cannot read is said, not silently launched past; and `trust prune` lists — and on `--apply` removes — the record's entries whose directory no longer exists.

**Architecture:** three touches to `iterm_agent.py`: the trust block of `cmd_spawn` becomes a four-way reading whose result the dry run prints as `trust=`; a new `cmd_trust` behind a `trust` command; nothing else changes. Eight checks in the suite's untrusted-directory section, on the fixture it already makes.

**Tech Stack:** Python 3 (the launcher), bash 3.2 (the suite).

**Spec:** `docs/design.md`, section 31. Section 20 (trust) binds it; section 30 (a checkout per phase) is why it matters now.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt (`~/.claude.json` is one).
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (210 on the base head; this task adds 8, expected `218 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.1`.
- **Never run anything against the live app from the suite.** The dry run and the fixture trust file are the suite's doors; `tests/e2e.sh` is not touched.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: Trust hygiene (0.23.1)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — the trust block of `cmd_spawn` (the lines from `trusted = directory_is_trusted(args.dir)` to the `die(...)` that names `--trust`), one line added to the dry-run block, a new `cmd_trust` placed immediately above `COMMANDS`, one entry in `COMMANDS`, the usage line of `main()`.
- Modify: `tests/run-tests.sh` — eight checks appended at the end of the untrusted-directory section, immediately after the check `the record keeps owner-only permissions`.
- Modify: `skills/iterm-agents/SKILL.md` — one line in the quick reference, one sentence in the trust caveat.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.1`.
- Already committed on this branch by the orchestrator: `docs/design.md` §31 and this plan.

**Interfaces:**
- Consumes: `directory_is_trusted(path) -> True|False|None` (None: the record cannot be read), `grant_directory_trust(path)`, `TRUST_FILE`, `DRY_RUN`, `die`.
- Produces: in `cmd_spawn`, a local `trust_state` in `{"already", "recorded", "unread"}` and the dry-run line `trust=<state>` printed after `anchor=`; `cmd_trust(argv)` behind `iterm-agent.sh trust prune [--apply]` — stdout: one absent path per line; stderr: `trust: N of M entries name a directory that no longer exists; pass --apply to remove them` without `--apply`, `trust: removed N entries, M kept` with it; the record rewritten with the same temporary-file-then-replace and mode 600 as `grant_directory_trust`; any other action or option: exit 1, `trust: usage: trust prune [--apply]`.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately after the check `the record keeps owner-only permissions` (the `stat` line and its closing quote), insert:

```bash
# A record that already says yes is not rewritten: the host writes this file too, and a
# rewrite for nothing is a window in which one of the two loses. The fixture is written
# compact on purpose — the launcher's own writer indents, so any rewrite changes the bytes.
compact="{\"projects\":{\"$(cd "$UNTRUSTED" && pwd -P)\":{\"hasTrustDialogAccepted\":true}}}"
printf '%s' "$compact" > "$TRUSTF"
out=$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --tier deep --trust 2>&1)
check "--trust on a recorded directory does not rewrite the record" "$compact" "$(cat "$TRUSTF")"
check "and the dry run says the record already held it" "1" "$(printf '%s' "$out" | grep -c '^trust=already$')"
check "--trust on an unrecorded directory says it recorded it" "1" \
  "$(printf '{"projects":{}}' > "$TRUSTF"; env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     bash "$AGENT" spawn --dir "$UNTRUSTED" --tier deep --trust 2>&1 | grep -c '^trust=recorded$')"
# A record the launcher cannot read is a gate that cannot measure: it lets the launch
# through AND says so, instead of launching past a question nobody will see.
printf '{not json' > "$WORK/trust-garbage.json"
out=$(env ORCHESTRATOR_TRUST_FILE="$WORK/trust-garbage.json" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --tier deep 2>&1); code=$?
check "an unreadable record lets the launch through" "0" "$code"
check "and says so, naming the flag" "1|1" \
  "$(printf '%s' "$out" | grep -c 'cannot be read')|$(printf '%s' "$out" | grep -c '^trust=unread$')"
# Entries outlive their directories — a checkout per phase adds one per dispatch — and
# nothing removed them. prune lists; only --apply writes; the kept entry keeps its shape.
GONE="$WORK/gone-checkout"
"$py" -c "import json,sys; json.dump({'projects':{sys.argv[1]:{'hasTrustDialogAccepted':True,'allowedTools':['x']},sys.argv[2]:{'hasTrustDialogAccepted':True}}}, open(sys.argv[3],'w'))" \
  "$(cd "$UNTRUSTED" && pwd -P)" "$GONE" "$TRUSTF"
before=$(cat "$TRUSTF")
check "trust prune lists the gone entry, only it, and writes nothing" "$GONE|unchanged" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune 2>/dev/null)|$([ "$(cat "$TRUSTF")" = "$before" ] && echo unchanged || echo rewritten)"
check "trust prune --apply removes it and keeps the rest, owner-only" "1|0|600" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune --apply >/dev/null 2>&1; \
     "$py" -c "import json,sys; d=json.load(open(sys.argv[1]))['projects']; print('%d|%d' % (sys.argv[2] in d and d[sys.argv[2]].get('allowedTools')==['x'], sys.argv[3] in d))" "$TRUSTF" "$(cd "$UNTRUSTED" && pwd -P)" "$GONE")|$(stat -f '%OLp' "$TRUSTF" 2>/dev/null || stat -c '%a' "$TRUSTF")"
check "trust accepts prune and refuses another action" "0|1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune >/dev/null 2>&1; echo $?)|$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust wipe >/dev/null 2>&1; echo $?)"
```

- [ ] **Step 2: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `211 passed, 7 failed`. The one that passes already is « an unreadable record lets the launch through » — today's launcher launches past an unreadable record in silence, exit 0; the check beside it (« and says so ») is what reads the behaviour. The record-rewrite check fails because today's `--trust` rewrites indented; the `trust=` checks fail because the line does not exist; the prune checks fail because the command does not exist (usage error, exit 1, empty stdout). Report the count and the first failing check's actual value verbatim before editing.

- [ ] **Step 3: The trust block of `cmd_spawn`**

In `skills/iterm-agents/scripts/iterm_agent.py`, `cmd_spawn`, replace the block

```python
    trusted = directory_is_trusted(args.dir)
    if args.trust:
        grant_directory_trust(args.dir)
    elif trusted is False:
        die("spawn: the host has not been told to trust %s, so the session would stop on "
            "its workspace question and never read its brief. Pass --trust for a checkout "
            "you prepared, or open the directory once yourself." % os.path.realpath(args.dir))
```

with

```python
    trusted = directory_is_trusted(args.dir)
    if trusted is True:
        # Never rewrite a record that already says yes: the host writes this file too, and
        # a rewrite for nothing is a window in which one of the two loses an entry.
        trust_state = "already"
    elif args.trust:
        grant_directory_trust(args.dir)
        trust_state = "recorded"
    elif trusted is None:
        # A gate that cannot measure lets the launch through AND says so (§31).
        trust_state = "unread"
        print("spawn: the trust record %s cannot be read, so whether the host trusts %s is "
              "unknown; launching anyway. Pass --trust for a checkout you prepared, or open "
              "the directory once yourself." % (TRUST_FILE, os.path.realpath(args.dir)),
              file=sys.stderr)
    else:
        die("spawn: the host has not been told to trust %s, so the session would stop on "
            "its workspace question and never read its brief. Pass --trust for a checkout "
            "you prepared, or open the directory once yourself." % os.path.realpath(args.dir))
```

In the dry-run block of `cmd_spawn`, immediately after the line `print("anchor=%s" % ("self" if anchor == own else anchor))`, add:

```python
        print("trust=%s" % trust_state)
```

- [ ] **Step 4: `cmd_trust`**

Immediately above the line `COMMANDS = {`, insert:

```python
def cmd_trust(argv):
    """`trust prune [--apply]`: the record's entries whose directory no longer exists.

    A trust entry outlives its directory, and a checkout per phase adds one per dispatch,
    so the record only grows. An entry for a directory that is gone holds nothing the host
    can use. Listing is the default; only --apply writes, with the same temporary file,
    replace and owner-only mode as the writer that made the entries."""
    p = argparse.ArgumentParser(prog="trust", add_help=False)
    p.add_argument("action", nargs="?", default="")
    p.add_argument("--apply", action="store_true", default=False)
    args, unknown = p.parse_known_args(argv)
    if unknown or args.action != "prune":
        die("trust: usage: trust prune [--apply]")
    try:
        with open(TRUST_FILE) as fh:
            data = json.load(fh)
    except Exception as exc:
        die("trust: cannot read %s: %s" % (TRUST_FILE, exc))
    projects = data.get("projects") or {}
    gone = sorted(path for path in projects if not os.path.isdir(path))
    for path in gone:
        print(path)
    if not args.apply:
        print("trust: %d of %d entries name a directory that no longer exists; pass --apply "
              "to remove them" % (len(gone), len(projects)), file=sys.stderr)
        return
    for path in gone:
        del projects[path]
    tmp = TRUST_FILE + ".orchestrator-tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, TRUST_FILE)
    print("trust: removed %d entries, %d kept" % (len(gone), len(projects)), file=sys.stderr)


```

In `COMMANDS`, add `"trust": cmd_trust,` after `"screen": cmd_screen,`. In `main()`, the usage string becomes `iterm-agent.sh {list|spawn|verify|screen|resolve-tier|close|move|rotate|trust} [options] (see header)`. Add to the file's header comment, beside the other usage lines, `iterm-agent.sh trust prune [--apply]` with the words « list, then remove with --apply, the trust entries whose directory is gone ».

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `218 passed, 0 failed`. Do not weaken a check to pass; report the actual value and stop if the launcher and a check disagree on the contract.

- [ ] **Step 6: The skill text**

In `skills/iterm-agents/SKILL.md`, in the quick reference (the block of `$SCRIPT …` lines), add after the `screen` line: `$SCRIPT trust prune [--apply]      # entries of the trust record whose directory is gone; --apply removes them`. In the caveat that says `--trust` records the answer for ONE directory, append: « It never rewrites an entry that already says yes, and a record it cannot read is said on stderr rather than launched past in silence; entries outlive their directories — `trust prune` lists them, `--apply` removes them. »

Then `grep -n 'screen --tty\|--trust' tests/run-tests.sh` for a guard pinning the lines you touched and re-pin any that does; say in your report what you found. Then `./tests/run-tests.sh 2>&1 | tail -1`: still `218 passed, 0 failed`.

- [ ] **Step 7: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.1`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `218 passed, 0 failed`.

- [ ] **Step 8: Commit and deliver**

One commit, with this exact subject: `fix(iterm-agents): keep the trust record quiet when it already says yes, say when it cannot be read, prune what is gone` — the launcher, `tests/run-tests.sh`, the skill text, the two version files. Body: why (the record is the host's file too and a checkout per phase adds an entry per dispatch; a gate that cannot measure says so; entries outlive their directories). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin trust-hygiene`, open the draft PR as the brief says.
