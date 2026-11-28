// hooks/register.ts
// Entry point of the hooks module: mounts the domains. Each domain lands in
// its own task; the gauge arrived first, the guards second, the store third,
// the commands fourth, the naming fifth, the short commands' sync sixth, the declared wait seventh, the to-do tool, then the ask and settle tools;
// the round's wake, the pane's tool and the window's state at the start ride with the supervision.
// The gauge stays before the supervision: a chain answers in registration order, and the store's row
// reads the figure through the gauge's own module memory — mounted after it,
// the row would carry one measure behind.
import { register as registerAudit } from './audit.ts'
import { register as registerCloseGate } from './close-gate.ts'
import { register as registerGauge } from './gauge.ts'
import { register as registerGuards } from './guards.ts'
import { endIfBackground, register as registerBackground } from './background.ts'
import { register as registerWait } from './wait.ts'
import { register as registerUnattended } from './unattended.ts'
import { register as registerLedger } from './ledger.ts'
import { register as registerGateRecheck } from './gate-recheck.ts'
import { register as registerSupervision, registerWake, registerRetries, registerPaneTool, registerStartState } from './supervision.ts'
import { register as registerPermissionWait } from './permission-wait.ts'
import { register as registerTodo, registerSurface as registerTodoSurface } from './todo.ts'
import { register as registerQuestion, registerSettle } from './question.ts'
import { register as registerReview } from './review.ts'
import { register as registerLensIds } from './lens-ids.ts'
import { register as registerCommands, registerEnd as registerCommandsEnd } from './commands.ts'
import { register as registerNaming } from './naming.ts'
import { register as registerShortCommands } from './short-commands.ts'
import { logLine } from './module-io.ts'
import type { Host, On } from './host.ts'

// Every noun of the host a domain below calls.
type Mod = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'ui' | 'tool' | 'command' | 'prompt' | 'clock' | 'settings'>

export function register(on: On<Mod>): void {
  // The scaffold's own passthrough, now under the every-handler law the four
  // domains below already carry: the net names what the bare handler cannot
  // catch itself, the start is let through, and the state dir says why. A
  // background session ends here, before anything else starts (background.ts).
  on('session.start', async ($, e, next) => { await endIfBackground($); return next(e) })
    .catch(async ($, e, next) => {
      await logLine($, 'register', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
      return next(e)
    })
  // First: the audit trail reads what every later handler answered, after it decided.
  registerAudit(on)
  // Ahead of every hook that answers a call without its tool (the guards, the module's own tools): a dialog's call ends here whatever answers it.
  registerPermissionWait(on)
  registerGauge(on)
  // Before the guards and the supervision: the turn's end reads the declared wait it hands on.
  registerWait(on)
  registerGuards(on)
  registerBackground(on)
  // Ahead of the supervision: its turn end sends the row and writes the deck, which carry the pull requests this turn end publishes.
  registerUnattended(on)
  registerSupervision(on)
  registerWake(on)
  registerRetries(on)
  registerPaneTool(on)
  registerStartState(on)
  registerTodo(on)
  registerTodoSurface(on)
  registerQuestion(on)
  registerSettle(on)
  registerReview(on)
  registerLensIds(on)
  registerCommands(on)
  registerCommandsEnd(on)
  registerNaming(on)
  registerShortCommands(on)
  registerLedger(on)
  registerGateRecheck(on)
  registerCloseGate(on)
}
