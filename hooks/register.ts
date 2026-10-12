// hooks/register.ts
// Entry point of the hooks module: mounts the two domains. The status line
// itself stays a shell command the host runs from settings.json; this module
// only feeds it its settings and answers the plugin's commands without a turn.
import { register as registerConfigSync } from './config-sync.ts'
import { register as registerCommands } from './commands.ts'

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  registerConfigSync(on)
  registerCommands(on)
}
