// The merge of a stack of pull requests: the plan the engine reads from the repository (engine/ghlib/stack.py),
// the order the members are merged in, and what the walk says. Pure functions only: register.ts runs the
// merges, each under the ready gate, the permission rules and the question of a merge alone.

export type StackMember = { pr: number; depth: number }

// bottom-up: the bottom one merges on the base, each next is retargeted to it and merges on the checks green at its head.
// top-down: each member merges into the branch below it, the bottom one last, on its own CI.
export type StackPlan = { order: 'bottom-up' | 'top-down'; why: string; base: string; members: StackMember[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether the output is an answer about a stack (a plan, valid or not): nothing was merged. */
export function holdsStack(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text)
    return isRecord(raw) && 'stack' in raw
  } catch {
    return false
  }
}

/** The plan `pr-merge --stack` answered for a pull request in a stack of several, or undefined: the output is no plan. */
export function parseStackPlan(text: string): StackPlan | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const stack = isRecord(raw) ? raw['stack'] : undefined
  if (!isRecord(stack) || !Array.isArray(stack['members'])) return undefined
  const order = stack['order']
  if ((order !== 'bottom-up' && order !== 'top-down') || typeof stack['base'] !== 'string') return undefined
  const members: StackMember[] = []
  for (const member of stack['members']) {
    const pr = isRecord(member) ? member['pr'] : undefined
    const depth = isRecord(member) ? member['depth'] : undefined
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || typeof depth !== 'number') return undefined
    members.push({ pr, depth })
  }
  if (members.length < 2) return undefined
  return { order, why: typeof stack['why'] === 'string' ? stack['why'] : '', base: stack['base'], members }
}

/** The pull requests in the order they are merged: the bottom first, or the top ones first and the bottom last. */
export function mergeOrder(plan: StackPlan): number[] {
  const sign = plan.order === 'bottom-up' ? 1 : -1
  return [...plan.members].sort((a, b) => sign * (a.depth - b.depth) || a.pr - b.pr).map((m) => m.pr)
}

const named = (repo: string, prs: number[]): string => prs.map((pr) => repo + '#' + pr).join(', ')

/** What the walk answers when every member is merged. */
export function stackMergedLine(repo: string, plan: StackPlan, merged: string[]): string {
  return 'github: the stack of ' + repo + ' merged ' + plan.order + ' (' + plan.why + '):\n' + merged.join('\n')
}

/** What the walk answers when a member stopped it: the ones merged so far, the member and why. */
export function stackStoppedLine(repo: string, done: number[], at: number, why: string): string {
  return 'github: the stack stopped at ' + repo + '#' + at + ': ' + why.trim()
    + '\nmerged so far: ' + (done.length > 0 ? named(repo, done) : 'none')
}
