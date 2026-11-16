# claude-plugins — objectives (draft, to be validated)

claude-plugins serves the other projects, not itself.

1. **Never hinder a project.** No session of a project is blocked by a hook, a barrier or a guard
   of a plugin. An observed block is fixed first, preferably by removing the guard rather than
   adding a rule.
2. **Every change starts from an observed fact.** Every PR cites the project and the problem seen
   (a session, a PR, an error message). Without a fact, no PR.
3. **No freeze.** Fixes continue, in simple sessions; for each one we ask whether the method it
   touches is the right one.
4. **Remove before adding.** When a plugin has a defect, we first look at what can be removed.
5. **main always green, deployed on its own.** CI green, automatic deployment (already granted).

Working mode: one Claude session per change, without the orchestrator's hooks; tests, PR,
`/code-review`, merge when CI is green.

Review due 2026-11-22: merged PRs, defects met, tokens spent; decision on extending the simple
mode to the other projects.
