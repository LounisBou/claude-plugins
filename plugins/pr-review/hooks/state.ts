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
  // The passes the loop may run: MAX_PASSES alone, ORCHESTRATED_PASSES in a session the orchestrator spawned.
  maxPasses: number
  testCommand: string
  // The checkout the loop started in, as its top directory: the record is written for it, wherever the session's directory moves.
  dir?: string
  // Why no checkout was read at the start, when there is none: the record then says so.
  dirWhy?: string
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
  // Whether the review record is still owed: GitHub kept failing transiently when it was written.
  isRecordPending: boolean
  // The head the checkout was at when the loop ended: the record is written at it, and no other.
  reviewedHead?: string
  // Whether a review runs: from begin_pass to the findings the loop accepts.
  isReviewing: boolean
  // A reviewer's loop: one pass, no fix, its findings are the verdict.
  isReviewOnly: boolean
  // What each review agent of the pass returned, null for one without a readable block.
  reports: (Finding[] | null)[]
  // The name each review agent of the pass was launched under, at its place in `reports`.
  readers: string[]
  // The review agents the host runs in the background: their id, and the place in `reports`
  // their hand-back fills.
  awaiting: Map<string, number>
  // The awaited agents whose hand-back carried no findings block, not yet asked again for it,
  // and those asked again: a second hand-back without the block settles as silent.
  blockless: Set<string>
  reasked: Set<string>
  // The awaited agents whose turn ended once: a later end of an agent asked again is its second run's.
  ended: Set<string>
  // How many waits `findings` answered « still running » in this pass: one per hand-back event.
  waits: number
  // The hand-back events of the session so far, and their count at the last wait counted.
  handbacks: number
  waitedAt: number
}

export const MAX_PASSES = 5

// The orchestrator runs one review and one correction round itself: its agent's loop reviews once.
export const ORCHESTRATED_PASSES = 1

export const loop: Loop = { isActive: false, pass: 0, maxPasses: MAX_PASSES, testCommand: '', seen: [], lastFindings: 0, fixes: [], isRecorded: false, isRecordPending: false, isReviewing: false, isReviewOnly: false, reports: [], readers: [], awaiting: new Map(), blockless: new Set(), reasked: new Set(), ended: new Set(), waits: 0, handbacks: 0, waitedAt: -1 }

export function resetLoop(testCommand: string, isReviewOnly = false, dir?: string, dirWhy?: string, maxPasses = MAX_PASSES): void {
  loop.isActive = true
  loop.maxPasses = maxPasses
  loop.dir = dir
  loop.dirWhy = dirWhy
  loop.pass = 0
  loop.testCommand = testCommand
  loop.seen = []
  loop.lastFindings = 0
  loop.lastBlocking = undefined
  loop.fixes = []
  loop.exit = undefined
  loop.isRecorded = false
  loop.isRecordPending = false
  loop.reviewedHead = undefined
  loop.isReviewing = false
  loop.isReviewOnly = isReviewOnly
  loop.reports = []
  loop.readers = []
  loop.awaiting = new Map()
  loop.blockless = new Set()
  loop.reasked = new Set()
  loop.ended = new Set()
  loop.waits = 0
  loop.waitedAt = -1
}

// The successful preflight, once per session: a skill started again skips it.
export const preflight = { hasPassed: false }
