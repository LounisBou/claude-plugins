// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The forge's copy of what the ready gate reads on a machine: each pull request record, the check plan and the
// E2E exemption, one commit status each at the pull request's head, so the operator's two machines judge on the same
// truth. `npm run core` writes the contract as forge-status.json beside github's copy, which its Python poster loads. A status's description is `v<version> <at> <body>`: the
// instant of what it copies, then a record's `<result> <producer>`, a plan's needs or an exemption's rules. Only a
// status the operator's own account created is read. Pure, with no import but the contract: a hooks module imports it.

import { KINDS, PR_RECORD_CONTRACT, type Kind, type PrRecord, type Result } from './pr-record.ts'

export const FORGE_CONTRACT = {
  version: 1,
  // A status's context is the prefix and what it copies: a record's kind, `plan` or `exemption`.
  prefix: 'readiness/',
  plan: 'plan',
  exemption: 'exemption',
  // The state each record result posts; a plan and an exemption post `success`.
  states: { pass: 'success', fail: 'failure', waived: 'success', 'not-applicable': 'success', accepted: 'success' },
  // What GitHub keeps of a status's description.
  description_max: 140,
} as const

export const FORGE = FORGE_CONTRACT
export const FORGE_VERSION = FORGE.version

/** What a status copies: a record's kind, the check plan or the repository's exemption. */
export type ForgeName = Kind | typeof FORGE.plan | typeof FORGE.exemption

/** A commit status at a head as the reconciler's listing reads it, with the login of the account that created it. */
export interface ForgeStatus {
  readonly context: string
  readonly state: string
  readonly description: string
  readonly creator: string
}

/** A status's description once read: its version, the instant of what it copies, its body. */
export interface ForgeDescription {
  readonly v: typeof FORGE_VERSION
  readonly at: string
  readonly body: string
}

/** The record a status copies. */
export interface ForgeRecord {
  readonly kind: Kind
  readonly result: Result
  readonly producer: string
  readonly at: string
}

/** A status to post at a head. */
export interface ForgePost {
  readonly name: ForgeName
  readonly state: string
  readonly description: string
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const PRODUCER = new RegExp(PR_RECORD_CONTRACT.patterns.producer)
const NAMES: readonly ForgeName[] = [...KINDS, FORGE.plan, FORGE.exemption]

/** Whether a text is an instant as the records write it: UTC, to the second. */
export const isForgeInstant = (text: string): boolean => INSTANT.test(text) && Number.isFinite(Date.parse(text))

/** The context of what a status copies. */
export function forgeContext(name: ForgeName): string {
  return FORGE.prefix + name
}

/** What a context copies, or undefined for a status that is none of the gate's. */
export function forgeName(context: string): ForgeName | undefined {
  if (!context.startsWith(FORGE.prefix)) return undefined
  const name = context.slice(FORGE.prefix.length)
  return NAMES.find((known) => known === name)
}

/** The description of a copy made at `at`, or undefined when it does not fit in what GitHub keeps. */
export function forgeDescription(at: string, body: string): string | undefined {
  const text = 'v' + FORGE_VERSION + ' ' + at + ' ' + body
  return text.length <= FORGE.description_max ? text : undefined
}

/** A description read, or undefined when it is not one of this version. */
export function parseForgeDescription(text: string): ForgeDescription | undefined {
  const [v, at, ...rest] = text.split(' ')
  if (v !== 'v' + FORGE_VERSION || at === undefined || !isForgeInstant(at) || rest.length === 0) return undefined
  return { v: FORGE_VERSION, at, body: rest.join(' ') }
}

/** The status that copies a record. */
export function recordPost(record: PrRecord): ForgePost | undefined {
  const description = forgeDescription(record.at, record.result + ' ' + record.producer)
  return description === undefined ? undefined : { name: record.kind, state: FORGE.states[record.result], description }
}

/** The record a status copies, or undefined when it copies none or its state says another result than its description. */
export function parseRecordStatus(status: ForgeStatus): ForgeRecord | undefined {
  const name = forgeName(status.context)
  const read = parseForgeDescription(status.description)
  if (name === undefined || name === FORGE.plan || name === FORGE.exemption || !read) return undefined
  const [result, producer, ...rest] = read.body.split(' ')
  const known = Object.entries(FORGE.states).find(([named]) => named === result)
  if (!known || rest.length > 0 || producer === undefined || !PRODUCER.test(producer) || known[1] !== status.state) return undefined
  return { kind: name, result: known[0] as Result, producer, at: read.at }
}

/**
 * The statuses of a head the gate may read, by what they copy: those under the prefix that `operator`'s account
 * created. Any other is ignored, so a status posted by another account or app copies nothing.
 */
export function trustedStatuses(statuses: readonly ForgeStatus[], operator: string): Map<ForgeName, ForgeStatus> {
  const kept = new Map<ForgeName, ForgeStatus>()
  if (operator === '') return kept
  for (const status of statuses) {
    const name = forgeName(status.context)
    if (name !== undefined && status.creator.toLowerCase() === operator.toLowerCase()) kept.set(name, status)
  }
  return kept
}
