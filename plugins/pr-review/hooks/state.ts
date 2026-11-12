// hooks/state.ts
// What the module remembers for the session, shared by the files that hook it.
// Module memory, not $.state: nothing here outlives the session, and a hot
// reload during development starting from a clean slate is the safe direction
// (no walkthrough active means no guard refuses anything).
import type { Skill } from './policy.ts'
import type { Finding } from './report.ts'

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
  // The Critical and Important findings of the last pass, or undefined when the
  // review did not say.
  lastBlocking?: number
  fixes: Fix[]
  // Why the loop ended: clean, max_passes, or released by the user.
  exit?: string
  // Whether this loop's review record was attempted: one per loop.
  isRecorded: boolean
  // Whether a review runs: from begin_pass to the findings the loop accepts.
  isReviewing: boolean
  // A reviewer's loop: one pass, no fix, its findings are the verdict.
  isReviewOnly: boolean
  // What each review agent of the pass returned, null for one without a readable block.
  reports: (Finding[] | null)[]
  // The review agents the host runs in the background: their id, and the place in `reports`
  // their hand-back fills.
  awaiting: Map<string, number>
  // How many waits `findings` answered « still running » in this pass: one per hand-back event.
  waits: number
  // The hand-back events of the session so far, and their count at the last wait counted.
  handbacks: number
  waitedAt: number
}

export const MAX_PASSES = 5

export const loop: Loop = { isActive: false, pass: 0, testCommand: '', seen: [], lastFindings: 0, fixes: [], isRecorded: false, isReviewing: false, isReviewOnly: false, reports: [], awaiting: new Map(), waits: 0, handbacks: 0, waitedAt: -1 }

export function resetLoop(testCommand: string, isReviewOnly = false): void {
  loop.isActive = true
  loop.pass = 0
  loop.testCommand = testCommand
  loop.seen = []
  loop.lastFindings = 0
  loop.lastBlocking = undefined
  loop.fixes = []
  loop.exit = undefined
  loop.isRecorded = false
  loop.isReviewing = false
  loop.isReviewOnly = isReviewOnly
  loop.reports = []
  loop.awaiting = new Map()
  loop.waits = 0
  loop.waitedAt = -1
}

// The successful preflight, once per session: a skill started again skips it.
export const preflight = { hasPassed: false }
