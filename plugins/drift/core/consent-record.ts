// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The consent record contract, owned by the orchestrator: the operator's answer to a round
// question that asked their consent on a subject (an E2E or norms waiver of one pull request, a repository
// exempted from E2E or no longer, a repository in or out of auto-merge, a repository auto-deployed in one environment or no longer), written by the orchestrator's hooks when they answer it, one file per
// question under <config>/consents/<owner>/<name>/<entry>.json, and read by github in place of
// the orchestrator's private round. The subject is the one the asking session declared with its
// question (`declare_wait`'s `consent`), never read from the question's words.

export const CONSENT_RECORD_CONTRACT = {
  version: 1,
  kinds: ['e2e-waiver', 'norms-waiver', 'e2e-exemption', 'auto-merge', 'auto-deploy'],
  // The environments an auto-deploy names: a deploy is granted per repository and environment.
  envs: ['dev', 'staging', 'prod'],
  producer: 'orchestrator',
  // Who recorded the answer: the operator in the coordinator's pane, or in the asking session's
  // own tab (`tab`), or the coordinator relaying what they told it (`round-close`).
  answerers: ['pane', 'coordinator', 'tab'],
  dir: 'consents',
  // A consent never rests on a few characters: the answer a quote holds is at least this long.
  quote_min: 8,
  // The two choices every consent question offers, and the only answers that grant or refuse.
  grant: 'Accorder',
  refuse: 'Refuser',
  text_max: 20_000,
  patterns: {
    repo_part: '^[A-Za-z0-9_.-]+$',
    entry: '^[A-Za-z0-9._-]+$',
  },
} as const

const contract = CONSENT_RECORD_CONTRACT

export type ConsentKind = 'e2e-waiver' | 'norms-waiver' | 'e2e-exemption' | 'auto-merge' | 'auto-deploy'
export type WaiverKind = 'e2e-waiver' | 'norms-waiver'
export type DeployEnv = 'dev' | 'staging' | 'prod'
export type Answerer = 'pane' | 'coordinator' | 'tab'

/** What the operator is asked to consent to: a waiver names its pull request, an auto-deploy its environment, a repository's exemption and auto-merge neither. */
export type ConsentSubject =
  | { readonly kind: WaiverKind; readonly repo: string; readonly pr: number }
  | { readonly kind: 'e2e-exemption' | 'auto-merge'; readonly repo: string }
  | { readonly kind: 'auto-deploy'; readonly repo: string; readonly env: DeployEnv }

export interface ConsentRecord {
  readonly v: number
  readonly subject: ConsentSubject
  readonly entry: string
  readonly question: string
  readonly answer: string
  readonly by: Answerer
  readonly at: string
}

export const CONSENT_VERSION = contract.version
export const CONSENT_KINDS: readonly ConsentKind[] = contract.kinds
export const DEPLOY_ENVS: readonly DeployEnv[] = contract.envs
export const CONSENT_QUOTE_MIN = contract.quote_min
export const CONSENT_PRODUCER = contract.producer
export const CONSENT_GRANT = contract.grant
export const CONSENT_REFUSE = contract.refuse

const REPO_PART = new RegExp(contract.patterns.repo_part)
const ENTRY = new RegExp(contract.patterns.entry)

function isRepo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => REPO_PART.test(part) && part !== '.' && part !== '..')
}

function isDeployEnv(value: unknown): value is DeployEnv {
  return typeof value === 'string' && (contract.envs as readonly string[]).includes(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= contract.text_max
}

/** The subject `raw` holds, or undefined when it breaks the contract's shape. */
export function parseConsentSubject(raw: unknown): ConsentSubject | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { kind, repo, pr, env } = raw as Record<string, unknown>
  if (!isRepo(repo)) return undefined
  if (kind === 'auto-deploy') return pr === undefined && isDeployEnv(env) ? { kind, repo, env } : undefined
  if (env !== undefined) return undefined
  if (kind === 'auto-merge' || kind === 'e2e-exemption') return pr === undefined ? { kind, repo } : undefined
  if ((kind !== 'e2e-waiver' && kind !== 'norms-waiver') || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return undefined
  return { kind, repo, pr }
}

/** The record `raw` holds, or undefined when a field breaks the contract's shape. */
export function parseConsentRecord(raw: unknown): ConsentRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { v, subject: rawSubject, entry, question, answer, by, at } = raw as Record<string, unknown>
  const subject = parseConsentSubject(rawSubject)
  if (v !== CONSENT_VERSION || subject === undefined || typeof entry !== 'string' || !ENTRY.test(entry)) return undefined
  if (!isText(question) || !isText(answer) || (by !== 'pane' && by !== 'coordinator' && by !== 'tab') || typeof at !== 'string') return undefined
  return { v, subject, entry, question, answer, by, at }
}

/** The directory of a repository's consent records under the host's configuration directory. */
export function consentDir(configDir: string, repo: string): string {
  const [owner, name] = repo.toLowerCase().split('/')
  return `${configDir}/${contract.dir}/${owner}/${name}`
}

/** Where a record lives: its repository's directory, one file per round entry. */
export function consentPath(configDir: string, record: ConsentRecord): string {
  return `${consentDir(configDir, record.subject.repo)}/${record.entry}.json`
}

// A text with its runs of whitespace made one space: a quote keeps the words, not the line breaks.
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// A lone letter opening an answer, alone or set apart by a separator: the choice it names.
const LETTERED = /^([A-Za-z])\s*(?:[:—)\-.]|$)/

/**
 * An answer as the operator gave it: the choice its opening letter names (« A : yes », « A — … »,
 * « A »), its letter and its text; anything else, a letter among no choice included, his own words.
 */
export function givenAnswer(answer: string, choices: readonly { letter: string; text: string }[]): { letter: string | null; text: string } {
  const trimmed = answer.trim()
  const named = LETTERED.exec(trimmed)?.[1]?.toUpperCase()
  const chosen = named === undefined ? undefined : choices.find(choice => choice.letter.toUpperCase() === named)
  return chosen ? { letter: chosen.letter, text: chosen.text.trim() } : { letter: null, text: trimmed }
}

/**
 * What a quote must hold of an answer given in the pane: a choice is pressed as its letter then
 * its text (« A : yes »), and the text of that choice is the operator's word; a letter that is not
 * among the question's choices is nothing to quote (''). Any other answer is quoted whole.
 */
export function consentAnswer(answer: string, choices: readonly { letter: string; text: string }[]): string {
  const given = givenAnswer(answer, choices)
  return given.letter === null && LETTERED.test(given.text) ? '' : given.text
}

/**
 * The choice that words the operator typed in the asking session's own tab answer, case and
 * spacing aside: that choice's letter alone (« A »); its letter, a separator (`:`, `—`, `)`, `-`,
 * `.`) and nothing else or exactly that choice's text (« a) waive it, docs only »); or exactly one
 * choice's text and nothing else. Anything else answers nothing (undefined): a prompt typed there
 * can be any instruction, and a consent record lets an E2E waiver through, so only an unambiguous
 * answer counts. The record's answer is then the chosen choice's text.
 */
export function answersChoice<C extends { letter: string; text: string }>(typed: string, choices: readonly C[]): C | undefined {
  const said = spaced(typed).toLowerCase()
  const textOf = (choice: C) => spaced(choice.text).toLowerCase()
  const lettered = /^([a-z])\s*(?:[:—)\-.]\s*(.*))?$/.exec(said)
  if (lettered) {
    const chosen = choices.find(choice => choice.letter.toLowerCase() === lettered[1])
    const rest = lettered[2] ?? ''
    if (chosen && (rest === '' || rest === textOf(chosen))) return chosen
  }
  const exact = choices.filter(choice => textOf(choice) !== '' && textOf(choice) === said)
  return exact.length === 1 ? exact[0] : undefined
}

/**
 * The record of an answer to a round question that asked consent on `subject`: the answer as a
 * quote must hold it (consentAnswer), or undefined when there is nothing to quote, the subject
 * breaks the contract or the entry's id is no file name.
 */
export function consentRecordOf(fields: {
  subject: unknown; entry: string; question: string; answer: string
  choices: readonly { letter: string; text: string }[]; by: Answerer; at: string
}): ConsentRecord | undefined {
  const answer = consentAnswer(fields.answer, fields.choices)
  if (answer === '') return undefined
  return parseConsentRecord({ v: CONSENT_VERSION, subject: fields.subject, entry: fields.entry, question: fields.question, answer, by: fields.by, at: fields.at })
}

/** Whether a recorded answer grants the consent: the choice « Accorder » and nothing else, case and spacing aside; « Refuser » and any other answer grant none. */
export function grants(answer: string): boolean {
  return spaced(answer).toLowerCase() === contract.grant.toLowerCase()
}

/** Whether two subjects are the same: the same kind, repository (as GitHub compares it), pull request and environment. */
export function sameSubject(a: ConsentSubject, b: ConsentSubject): boolean {
  if (a.kind !== b.kind || a.repo.toLowerCase() !== b.repo.toLowerCase()) return false
  if ('pr' in a) return 'pr' in b && a.pr === b.pr
  return !('env' in a) || ('env' in b && a.env === b.env)
}

/**
 * Whether `quote` rests on the record for `subject`: the record answers that subject, and its
 * answer, long enough to be the operator's word, is held whole in the quote, whitespace normalised.
 */
export function quotesConsent(record: ConsentRecord, subject: ConsentSubject, quote: string): boolean {
  const answer = spaced(record.answer)
  return sameSubject(record.subject, subject) && answer.length >= CONSENT_QUOTE_MIN && spaced(quote).includes(answer)
}
