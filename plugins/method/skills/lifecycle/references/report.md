# The report

One report per unit of work (a phase, a check, a close), written when it ends, in these named
sections and this order:

```
branch:    <type>/<name>, base <sha>
commits:   <short sha> <subject>
files:     <path>
gate:      <command> exit <code>   (one line per run, every run)
checks:    <step> PASS | FAIL: <rows>
deviations: what departs from the plan, and the line that justified it
open questions: what the plan does not settle, one line each
status:    done|blocked|question — <one line>
```

- `done`: delivered. `blocked`: it cannot go on without what the line
  names. `question`: a decision only the operator can take. `waiting`, never a report's
  end: background work runs.
- An exit code is the one read from the run. A section with nothing to say says `none`.
- A role may add lines it owns (a pull request, an `E2E:` line) after `files:`, never drop one.
- The last line is parsed by code (`reportStatus` in core): nothing follows it.
