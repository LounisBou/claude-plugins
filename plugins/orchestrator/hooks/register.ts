// hooks/register.ts
// Entry point of the hooks module: mounts the domains. Each domain lands in
// its own task; the gauge arrived first, the guards second, the store third,
// the commands fourth, the naming fifth, the moving sixth, the short commands' sync seventh, the declared wait eighth, the to-do tool, then the ask and settle tools;
// the round's wake and the pane's tool ride with the supervision.
// The gauge stays before the supervision: a chain answers in registration order, and the store's row
// reads the figure through the gauge's own module memory — mounted after it,
// the row would carry one measure behind. The moving comes after the supervision, whose receive
// handler passes a marked move message on and leaves the moving to consume it.
import { register as registerAudit } from './audit.ts'
import { register as registerGauge } from './gauge.ts'
import { register as registerGuards } from './guards.ts'
import { register as registerWait } from './wait.ts'
import { register as registerUnattended } from './unattended.ts'
import { register as registerLedger } from './ledger.ts'
import { register as registerSupervision, registerWake, registerPaneTool } from './supervision.ts'
import { register as registerTodo } from './todo.ts'
import { register as registerQuestion, registerSettle } from './question.ts'
import { register as registerReview } from './review.ts'
import { register as registerCommands, registerEnd as registerCommandsEnd } from './commands.ts'
import { register as registerNaming } from './naming.ts'
import { register as registerMoving } from './moving.ts'
import { register as registerShortCommands } from './short-commands.ts'
import { logLine } from './module-io.ts'

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // The scaffold's own passthrough, now under the every-handler law the four
  // domains below already carry: the net names what the bare handler cannot
  // catch itself, the start is let through, and the state dir says why.
  on('session.start', async ($: unknown, e: unknown, next: (e: unknown) => unknown) => next(e))
    .catch(async ($: any, e: any, next: any) => {
      await logLine($, 'register', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
      return next(e)
    })
  // First: the audit trail reads what every later handler answered, after it decided.
  registerAudit(on)
  registerGauge(on)
  // Before the guards and the supervision: the stop gate and the turn's end read the declared wait it hands on.
  registerWait(on)
  registerGuards(on)
  registerSupervision(on)
  registerWake(on)
  registerPaneTool(on)
  registerTodo(on)
  registerQuestion(on)
  registerSettle(on)
  registerReview(on)
  registerCommands(on)
  registerCommandsEnd(on)
  registerNaming(on)
  registerMoving(on)
  registerShortCommands(on)
  registerUnattended(on)
  registerLedger(on)
}
