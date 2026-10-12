// hooks/register.ts
// Entry point of the bugs-bot hooks module. The guard is mounted first: a chain
// answers in registration order, so a call to the `bugs` tool meets the guard
// before the hook that serves it.
//
// Nothing here is needed for bugs-bot to work: where modules do not load (a -p
// run, an older host) the markdown commands, the shell form and the measure file
// do what they did before.
import { register as registerGuard } from './guard.ts'
import { register as registerTool } from './tool.ts'
import { register as registerStart } from './start.ts'

export function register(on: any): void {
  registerGuard(on)
  registerTool(on)
  registerStart(on)
}
