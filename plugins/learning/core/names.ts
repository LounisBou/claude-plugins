// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The shapes of the session names the plugins read: a role and its colon, then a subject of at most
// 25 characters that neither starts nor ends with a blank. Every plugin asks here, never its own regex;
// another language reads the same shape from NAMES_CONTRACT (`names.json` in each plugin's copy).
// A name is written `Orch: billing`; the former `Orch : billing`, a blank before the colon, still
// reads as the same name: sessions started before the change carry it until they restart.

/** The role each prefix names, in the order a listing shows them. */
export const ROLES = { Orch: 'orchestrator', Coord: 'coordinator', Audit: 'auditor', Agent: 'agent' } as const

export type Prefix = keyof typeof ROLES
export type Role = (typeof ROLES)[Prefix]

export interface SessionName {
  readonly role: Role
  readonly subject: string
}

/** A subject: 1 to 25 characters, no blank at either end, as a pattern both languages compile. */
const SUBJECT = '\\S(?:.{0,23}\\S)?'

/** The shape as data, for a reader in another language. */
export const NAMES_CONTRACT = { version: 1, roles: ROLES, subject: SUBJECT } as const

const PREFIXES = Object.keys(ROLES).join('|')
const SHAPE = new RegExp(`^(${PREFIXES}) ?: (${SUBJECT})$`, 'u')
const PREFIX = new RegExp(`^(${PREFIXES}) ?:`, 'u')
const FORMER = new RegExp(`^(${PREFIXES}) : `, 'u')

function isPrefix(value: string): value is Prefix {
  return Object.hasOwn(ROLES, value)
}

/** The role and subject a name carries, or null for a name of no role. */
export function parseSessionName(name: string): SessionName | null {
  const match = SHAPE.exec(name)
  const prefix = match?.[1]
  const subject = match?.[2]
  if (prefix === undefined || subject === undefined || !isPrefix(prefix)) return null
  return { role: ROLES[prefix], subject }
}

/**
 * The role a name's prefix names, whatever follows the colon: a session the operator renamed by
 * hand, its subject past the shape, is of its role all the same. Null for a name of no role.
 */
export function roleOf(name: string | null): Role | null {
  const prefix = name ? PREFIX.exec(name)?.[1] : undefined
  return prefix !== undefined && isPrefix(prefix) ? ROLES[prefix] : null
}

/** The name of a session of `prefix`'s role about `subject`; throws when the subject does not fit. */
export function sessionName(prefix: Prefix, subject: string): string {
  const name = `${prefix}: ${subject}`
  if (parseSessionName(name) === null) throw new Error(`not a session subject: ${JSON.stringify(subject)} (1 to 25 characters, no blank at either end)`)
  return name
}

/** A name of the former shape, `Orch : x`, written the current way, `Orch: x`; any other name as given. */
export function currentSessionName(name: string): string {
  return name.replace(FORMER, '$1: ')
}
