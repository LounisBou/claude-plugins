# The machine

Read before a heavy run, a parallel dispatch, a brief on a shared machine, or relaying a round: the shared machine is the one resource every session draws on at once.

## The machine is an instrument

When agents, reviewers and you share one machine, the machine is a resource you manage, not a given. Load is arithmetic, not taste: know the memory one worker or one browser costs, the baseline the host already holds, and set the caps from that.

- **A heavy run (browsers, builds, parallel test suites) runs under a machine-wide lock** that waits for the previous holder and for free memory, and stops its own child under a hard floor. It kills only what it started.
- **Fan-out has a NAME.** « Use two workers » is an instruction nobody can follow unless the variable is named and set on the command line, every time; a tool left at its default takes every core. The lock holds the door, it does not hold the room.
- **Never a build beside a parallel test run; readers one at a time while a writer's gates are running.**
- **Kill what you start, delete what you build, verify with `ps` and `ls`.** A report saying « servers stopped » is a claim: five survived that sentence once. Build trees, `node_modules`, `dist` and screenshots of closed rounds are deleted as soon as the round is relayed; reports and probe scripts are what is kept.
- **A gate that cannot measure lets the run through and says so; only a gate that measures may hold one.** A wrapper that waits for a number it can never obtain (a reader that exists on one operating system, a lock parent purged at boot) is a hang that accuses a session that does not exist.
- **Arm a stall watch that speaks only on trouble**: the lock held by one holder too long, memory under the floor, load over the ceiling, no writer progress for a fixed time. Silence means the work is moving; a lock nobody watches turns a safeguard into a stall.
