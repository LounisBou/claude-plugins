# The report

One report per unit of work (a phase, a check, a close), written when it ends, in these named
sections and this order:

```
branch:    <type>/<name>, base <sha>
commits:   <short sha> <subject>   (one line per commit)
files:     <path>   (one line per file touched)
gate:      <command> exit <code>   (one line per run, every run)
checks:    <step> PASS | FAIL: <rows>   (one line per check run)
deviations: what departs from the plan, and the line that justified it
open questions: what the plan does not settle, one line each
status:    done|blocked|question — <one line>
```

- An exit code is the one read from the run, never inferred. A section with nothing to say
  says `none`.
- A role may add the lines it owns (a pull request, an `E2E:` line) after `files:`; it never
  drops one.
- The last line is parsed by code (`reportStatus` in core): nothing follows it.
