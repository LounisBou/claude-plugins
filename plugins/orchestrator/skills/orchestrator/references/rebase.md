# Rebase

### The rebase

**The rebase.** A rebase or merge of the base is never yours: you hold the decisions and hand the execution to an agent, and the head you pushed is one you cannot record. One whose conflicts are mechanical (no behaviour decided) goes to a rebase agent, one that decides behaviour to a correction session. Its records follow the rule of « Thresholds a verdict never crosses ». **The squash-merge trap**: once a lower pull request of a stack is squash-merged, its commits exist on the main branch under no name you can rebase over; the next branch is rebased by replaying ONLY its own commits onto the main branch — `git rebase --onto <main> <old head of the lower branch> <branch>` — never the lower branch's original commits, which come back as conflicts or as duplicates. The rebase is pushed with `--force-with-lease=<branch>:<sha read>`, the lease on the head you read; it is the one force this rule allows.
