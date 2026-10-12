// hooks/register.ts
// The norms hooks module. Each domain registers its own hooks, and each hook
// carries a .catch that passes the event on unchanged, so a failure leaves the
// markdown commands, the skill and the agents doing today's work. Hosts that
// load no module (older builds) run that markdown path alone.
import { register as registerCheck } from './check.ts'
import { register as registerLearn } from './learn.ts'
import { register as registerGuards } from './guards.ts'
import { register as registerValidate } from './validate.ts'

export function register(on: any): void {
  registerCheck(on)
  registerLearn(on)
  registerGuards(on)
  registerValidate(on)
}
