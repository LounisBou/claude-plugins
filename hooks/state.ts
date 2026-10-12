// hooks/state.ts
// What the module remembers for the session, shared by the files that hook it.
// Module memory, not $.state: nothing here outlives the session, and a hot
// reload during development starting from a clean slate is the safe direction
// (no walkthrough active means no guard refuses anything).
import type { Skill } from './policy.ts'

export type Walkthrough = {
  // The skill whose rules hold, or null when none runs.
  skill: Skill | null
  // The user's own last prompt since the skill started: the only source of a grant.
  lastPrompt: string
  // The PR scratch directory the walkthrough wrote to, once seen.
  scratchDir?: string
}

export const walkthrough: Walkthrough = { skill: null, lastPrompt: '' }

export function startWalkthrough(skill: Skill): void {
  walkthrough.skill = skill
  walkthrough.lastPrompt = ''
  walkthrough.scratchDir = undefined
}

export function endWalkthrough(): void {
  walkthrough.skill = null
  walkthrough.lastPrompt = ''
  walkthrough.scratchDir = undefined
}

export type Fix = { key: string; sha: string; description: string; reverted: boolean }

export type Loop = {
  isActive: boolean
  pass: number
  testCommand: string
  seen: string[]
  lastFindings: number
  fixes: Fix[]
  // Why the loop ended: clean, max_passes, or released by the user.
  exit?: string
}

export const MAX_PASSES = 5

export const loop: Loop = { isActive: false, pass: 0, testCommand: '', seen: [], lastFindings: 0, fixes: [] }

export function resetLoop(testCommand: string): void {
  loop.isActive = true
  loop.pass = 0
  loop.testCommand = testCommand
  loop.seen = []
  loop.lastFindings = 0
  loop.fixes = []
  loop.exit = undefined
}

// The successful preflight, once per session: a skill started again skips it.
export const preflight = { hasPassed: false }
