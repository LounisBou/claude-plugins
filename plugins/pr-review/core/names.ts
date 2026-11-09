// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The shapes of the session names the plugins read: a role and its colon, then a subject of at most
// 25 characters that neither starts nor ends with a blank. Every plugin asks here, never its own regex.
// A name is written `Orch: billing`; the former `Orch : billing`, a blank before the colon, still
// reads as the same name: sessions started before the change carry it until they restart.

export const ROLES = { Orch: 'orchestrator', Coord: 'coordinator', Agent: 'agent', Audit: 'auditor' } as const

export type Prefix = keyof typeof ROLES
export type Role = (typeof ROLES)[Prefix]

export interface SessionName {
  readonly role: Role
  readonly subject: string
}

const SHAPE = /^(Orch|Coord|Agent|Audit) ?: (\S(?:.{0,23}\S)?)$/u

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

/** The name of a session of `prefix`'s role about `subject`; throws when the subject does not fit. */
export function sessionName(prefix: Prefix, subject: string): string {
  const name = `${prefix}: ${subject}`
  if (parseSessionName(name) === null) throw new Error(`not a session subject: ${JSON.stringify(subject)} (1 to 25 characters, no blank at either end)`)
  return name
}
