// The outcome evals' inputs, read as data and validated: the replayed pull requests
// (`evals/outcome/cases.json`) and the spend caps (`evals/outcome/caps.json`). Everything the
// harness derives from a case (its suite, its reference tests) is computed from these fields,
// never written beside them.

export const CASES_FILE = 'evals/outcome/cases.json'
export const CAPS_FILE = 'evals/outcome/caps.json'

/** The two ways a task is worked: one session alone, or an orchestration of sessions. */
export const ARMS = ['single', 'orchestration'] as const
export type Arm = (typeof ARMS)[number]

export const MODES = ['pilot', 'measure'] as const
export type Mode = (typeof MODES)[number]

export interface Case {
  /** Kebab-case, names the change the pull request made. */
  readonly id: string
  /** The pull request's number in `repository`. */
  readonly pr: number
  /** The pull request's base: the commit the arms start from. */
  readonly base: string
  /** The merged result: the reference the arms are graded against. */
  readonly merge: string
  /** The plugin the change lives in; its suite is `plugins/<plugin>/tests/run-tests.sh`. */
  readonly plugin: string
  /** The task as its issue states it: the problem, never the merged solution. */
  readonly task: string
}

export interface Cases {
  readonly version: 1
  readonly repository: string
  readonly cases: readonly Case[]
}

/** What one kind of run may spend, in US dollars. */
export interface Caps {
  /** The whole run stops here. */
  readonly runUsd: number
  /** One arm on one case, its grading included, stops here. */
  readonly caseArmUsd: number
  /** One judgment (intent or review) stops here; reserved out of the case-and-arm cap. */
  readonly judgeUsd: number
  /** How many cases the run replays, taken in the order of the cases file. */
  readonly cases: number
}

export interface CapsFile {
  readonly version: 1
  readonly runs: Readonly<Record<Mode, Caps>>
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLUGIN = /^[a-z][a-z0-9-]*$/
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field<T>(raw: Record<string, unknown>, key: string, origin: string, test: (value: unknown) => value is T, what: string): T {
  const value = raw[key]
  if (!test(value)) throw new Error(`${origin}: "${key}" must be ${what}`)
  return value
}

const isString = (value: unknown): value is string => typeof value === 'string'
const matching = (pattern: RegExp) => (value: unknown): value is string => typeof value === 'string' && pattern.test(value)
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

export function parseCase(raw: unknown, origin: string): Case {
  if (!isRecord(raw)) throw new Error(`${origin}: a case must be an object`)
  const id = field(raw, 'id', origin, matching(ID), 'a kebab-case id')
  const where = `${origin} ${id}`
  const task = field(raw, 'task', where, isString, 'a string').trim()
  if (task === '') throw new Error(`${where}: "task" is empty`)
  const base = field(raw, 'base', where, matching(SHA), 'a full commit hash')
  const merge = field(raw, 'merge', where, matching(SHA), 'a full commit hash')
  if (base === merge) throw new Error(`${where}: "base" and "merge" are the same commit`)
  return {
    id,
    pr: field(raw, 'pr', where, isCount, 'a pull request number'),
    base,
    merge,
    plugin: field(raw, 'plugin', where, matching(PLUGIN), 'a plugin directory name'),
    task,
  }
}

export function parseCases(raw: unknown, origin: string = CASES_FILE): Cases {
  if (!isRecord(raw)) throw new Error(`${origin}: not an object`)
  if (raw['version'] !== 1) throw new Error(`${origin}: "version" must be 1`)
  const repository = field(raw, 'repository', origin, matching(REPOSITORY), 'an owner/name repository')
  const list = raw['cases']
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${origin}: "cases" must be a non-empty list`)
  const cases = list.map((entry: unknown, index) => parseCase(entry, `${origin} cases[${index}]`))
  const seen = new Set<string>()
  for (const { id } of cases) {
    if (seen.has(id)) throw new Error(`${origin}: the id "${id}" is used twice`)
    seen.add(id)
  }
  return { version: 1, repository, cases }
}

function parseCaps(raw: unknown, origin: string): Caps {
  if (!isRecord(raw)) throw new Error(`${origin}: must be an object`)
  const caps = {
    runUsd: field(raw, 'runUsd', origin, isPositive, 'a positive amount'),
    caseArmUsd: field(raw, 'caseArmUsd', origin, isPositive, 'a positive amount'),
    judgeUsd: field(raw, 'judgeUsd', origin, isPositive, 'a positive amount'),
    cases: field(raw, 'cases', origin, isCount, 'a positive count'),
  }
  if (caps.caseArmUsd > caps.runUsd) throw new Error(`${origin}: "caseArmUsd" is above "runUsd"`)
  if (2 * caps.judgeUsd >= caps.caseArmUsd) throw new Error(`${origin}: two judgments leave nothing of "caseArmUsd" to the arm`)
  return caps
}

export function parseCapsFile(raw: unknown, origin: string = CAPS_FILE): CapsFile {
  if (!isRecord(raw)) throw new Error(`${origin}: not an object`)
  if (raw['version'] !== 1) throw new Error(`${origin}: "version" must be 1`)
  const runs = raw['runs']
  if (!isRecord(runs)) throw new Error(`${origin}: "runs" must be an object`)
  return { version: 1, runs: { pilot: parseCaps(runs['pilot'], `${origin} pilot`), measure: parseCaps(runs['measure'], `${origin} measure`) } }
}

/** The cases a run replays: the one named, or the first `caps.cases` of the file. */
export function selectCases(cases: Cases, caps: Caps, only: string | undefined): Case[] {
  if (only !== undefined) {
    const found = cases.cases.find(entry => entry.id === only)
    if (found === undefined) throw new Error(`no case named "${only}"; the cases are ${cases.cases.map(entry => entry.id).join(', ')}`)
    return [found]
  }
  if (cases.cases.length < caps.cases) throw new Error(`the run replays ${caps.cases} cases and the file has ${cases.cases.length}`)
  return cases.cases.slice(0, caps.cases)
}
