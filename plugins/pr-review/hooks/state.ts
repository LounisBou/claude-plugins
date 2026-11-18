// hooks/state.ts
// What the module remembers for the session, shared by the files that hook it.
// Module memory, not $.state: nothing here outlives the session, and a hot
// reload during development starting from a clean slate is the safe direction
// (no walkthrough active means no band is drawn).
import type { Finding } from './report.ts'
import { REVIEW_ROUNDS } from '../core/readiness.ts'

export type Skill = 'start-review' | 'process-comments' | 'auto-fix-loop'

// The skills this plugin ships, by the key skill.prompt carries.
export const SKILL_KEYS: Record<string, Skill> = {
  'pr-review:start-review': 'start-review',
  'pr-review:process-comments': 'process-comments',
  'pr-review:auto-fix-loop': 'auto-fix-loop',
}

// The github plugin's tool, which the loop and the triage read the pull request through.
export const GH_TOOL = 'mcp__github__gh'

export type Walkthrough = {
  // The skill the band follows, or null when none runs.
  skill: Skill | null
  // The PR scratch directory the walkthrough wrote to, once seen.
  scratchDir?: string | undefined
}

export const walkthrough: Walkthrough = { skill: null }

export function startWalkthrough(skill: Skill): void {
  walkthrough.skill = skill
  walkthrough.scratchDir = undefined
}

export function endWalkthrough(): void {
  walkthrough.skill = null
  walkthrough.scratchDir = undefined
}

// The closing lines the two skills print at their end: the walkthrough is over.
export function endsWalkthrough(skill: Skill, answer: string): boolean {
  if (skill === 'start-review') return /^## Walkthrough complete\s*$/m.test(answer)
  if (skill === 'process-comments') return /All PR comments have been addressed\./.test(answer)
  return false
}

export type Fix = { key: string; sha: string; description: string; reverted: boolean }

export type Loop = {
  isActive: boolean
  pass: number
  // The passes the loop may run: MAX_PASSES alone, the pull request's check plan's rounds in a session the orchestrator spawned.
  maxPasses: number
  testCommand: string
  // The checkout the loop started in, as its top directory: the record is written for it, wherever the session's directory moves.
  dir?: string | undefined
  // Why no checkout was read at the start, when there is none: the record then says so.
  dirWhy?: string | undefined
  seen: string[]
  lastFindings: number
  // The Critical and Important findings of the last pass, or undefined when the
  // review did not say.
  lastBlocking?: number | undefined
  fixes: Fix[]
  // Why the loop ended: clean, max_passes, or released by the user.
  exit?: string | undefined
  // Whether this loop's review record was attempted: one per loop.
  isRecorded: boolean
  // Whether the review record is still owed: GitHub kept failing transiently when it was written.
  isRecordPending: boolean
  // The head the checkout was at when the loop ended: the record is written at it, and no other.
  reviewedHead?: string | undefined
  // Whether a review runs: from begin_pass to the findings the loop accepts.
  isReviewing: boolean
  // A reviewer's loop: one pass, no fix, its findings are the verdict.
  isReviewOnly: boolean
  // What each review agent of the pass returned, null for one without a readable block.
  reports: (Finding[] | null)[]
  // The name each review agent of the pass was launched under, at its place in `reports`.
  readers: string[]
  // The background readers of the pass not yet handed back, by agentId, with their place in `reports`.
  awaiting: Map<string, number>
  // The reports handed back before their launch was registered, by agentId.
  early: Map<string, Finding[] | null>
}

// The rounds a review runs at most: core's cap on a check plan's review rounds.
export const MAX_PASSES: number = REVIEW_ROUNDS.cap

export const loop: Loop = { isActive: false, pass: 0, maxPasses: MAX_PASSES, testCommand: '', seen: [], lastFindings: 0, fixes: [], isRecorded: false, isRecordPending: false, isReviewing: false, isReviewOnly: false, reports: [], readers: [], awaiting: new Map(), early: new Map() }

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
  loop.early = new Map()
}

// The successful preflight, once per session: a skill started again skips it.
export const preflight = { hasPassed: false }
