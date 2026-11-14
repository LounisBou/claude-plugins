# CI watch

### Checks, in one background watch

**Checks, in one background watch.** When a pull request you own is opened or its head moves, start `ci-watch.sh <n>` (`skills/orchestrator/scripts/ci-watch.sh`, by the absolute path of the plugin's installed copy) with `run_in_background` and a timeout of 7 200 000 ms: one per pull request, never two. Its exit wakes you with one line; « What the caller does », in the script's header, says what each asks. Never a foreground watch, never a loop on `gh pr view` or `gh pr checks`, never a wait for MERGED of your own; an agent never watches CI, and no session is spawned or rotated to watch it.
