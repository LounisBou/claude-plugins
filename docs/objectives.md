# claude-plugins — objectives

claude-plugins serves the other projects, not itself. The operator's principles, which hold for
every project, are `principles.md`; these objectives are what is specific to this repository.

1. **Never hinder a project.** No session of a project is blocked by a hook, a barrier or a guard
   of a plugin. An observed block is fixed first, preferably by removing the guard rather than
   adding a rule. Figure: refusals by a plugin's guard, per day (28 to 81, week of 2026-11-15).
2. **No freeze.** Fixes continue, each one a pull request of its own; for each one we ask whether
   the method it touches is the right one. Figure: none measurable today.
3. **main always green, deployed on its own.** CI green, automatic deployment (already granted).
   Figure: median time from a merge to its installation, per day (3 to 6 minutes, longest 39,
   week of 2026-11-15, read from the install times of the deploy directories).

The method does not bind its own development: the repository's `CLAUDE.md` says who writes and
merges a correction here.

Working mode: one pull request per change, written by any session (the repository's `CLAUDE.md`
says who), reviewed by read-only `orchestrator:lens` readers, merged when CI is green.
