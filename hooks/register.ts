// hooks/register.ts
// Entry point of the pr-review hooks module. Each file owns one concern:
//   session.ts      the lifecycle: tools registered, a skill's start, the user's words
//   walkthrough.ts  the Iron Rules of start-review and process-comments, and the band
//   triage.ts       the open_comments tool process-comments starts with
//   loop.ts         auto-fix-loop's state tool and its Stop gate
//   commands.ts     doctor and install with no model turn, the preflight once
// The module loads only where plugin modules do; the skills keep a Bash route
// for every call, so a session without it (claude -p, an older host) works as
// before.
import { register as registerSession } from './session.ts'
import { register as registerWalkthrough } from './walkthrough.ts'
import { register as registerTriage } from './triage.ts'
import { register as registerLoop } from './loop.ts'
import { register as registerCommands } from './commands.ts'

export function register(on: any): void {
  registerSession(on)
  registerWalkthrough(on)
  registerTriage(on)
  registerLoop(on)
  registerCommands(on)
}
