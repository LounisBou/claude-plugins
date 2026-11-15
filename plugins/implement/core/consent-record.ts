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
 * among the question's choices is nothing to quote (''). Any other answer is quoted whole, unless
 * `leading` (the question's subject): an answer that opens with a choice (leadingChoice) is then
 * that choice's text, and one that opens with it and adds a limit is nothing to quote ('').
 */
export function consentAnswer(answer: string, choices: readonly { letter: string; text: string }[], leading?: { subject: ConsentSubject; question?: string }): string {
  const chosen = answersChoice(answer, choices) ?? (leading ? leadingChoice(answer, choices, leading.subject, leading.question) : undefined)
  if (chosen) return chosen.text.trim()
  // An answer that opens with a choice and adds a limit is not quoted whole: it records nothing, and the asker asks again.
  if (leading && opensChoice(answer, choices)) return ''
  const given = givenAnswer(answer, choices)
  return given.letter === null && LETTERED.test(given.text) ? '' : given.text
}

/**
 * The choice that words the operator typed in the asking session's own tab answer, case and
 * spacing aside: that choice's letter alone (« A »); its letter, a separator (`:`, `—`, `)`, `-`,
 * `.`) and nothing else or exactly that choice's text (« a) waive it, docs only »); exactly that
 * choice's text then its letter in parentheses (« Accorder (A) », as a relayed answer words it);
 * or exactly one choice's text and nothing else. Anything else answers nothing (undefined): a
 * prompt typed there can be any instruction, and a consent record lets an E2E waiver through, so
 * only an unambiguous answer counts. The record's answer is then the chosen choice's text.
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
  const pressed = /^(.*\S)\s*\(\s*([a-z])\s*\)$/.exec(said)
  if (pressed) {
    const chosen = choices.find(choice => choice.letter.toLowerCase() === pressed[2])
    if (chosen && textOf(chosen) !== '' && textOf(chosen) === pressed[1]) return chosen
  }
  const exact = choices.filter(choice => textOf(choice) !== '' && textOf(choice) === said)
  return exact.length === 1 ? exact[0] : undefined
}

/** The words a plain confirmation may add after its choice: anything else is a limit, a condition or a question. */
const CONFIRMATION = new Set(['merci', 'thanks', 'thank', 'you', 'ok', 'okay', 'go', 'oui', 'yes', 'svp', 'please', 'et', 'and', 'then', 'puis', 'fusionne', 'fusionner', 'fusionnez', 'merge', 'vas', 'y', 'allez', 'bon', 'bien', 'parfait', 'super', 'pour', 'for', 'la', 'le', 'les', 'de', 'dispense', 'waiver', 'pr', 'prs'])

// The subject's own names in an answer, which it may repeat: `owner/name#7`, `owner/name`, `name`, `#7`.
function withoutOwnSubject(said: string, subject: ConsentSubject): string {
  const repo = subject.repo.toLowerCase()
  let rest = said
  if ('pr' in subject) rest = rest.split(`${repo}#${subject.pr}`).join(' ')
  rest = rest.split(repo).join(' ')
  const name = repo.split('/')[1] ?? repo
  rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}._/-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}._/-])`, 'gu'), ' ')
  return 'pr' in subject ? rest.replace(new RegExp(`#${subject.pr}(?!\\d)`, 'g'), ' ') : rest
}

// The instant a Paris wall time is, or NaN when that time does not exist.
function parisInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offsetAt = (instant: number): number => {
    const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(instant).map(p => [p.type, Number(p.value)]))
    return (Date.UTC(part['year']!, part['month']! - 1, part['day']!, part['hour']!, part['minute']!) - Math.floor(instant / 60000) * 60000) / 60000
  }
  return [60, 120].map(offset => wall - offset * 60000).find(instant => offsetAt(instant) === (wall - instant) / 60000) ?? NaN
}

// A limit worded in an answer (« jusqu'au 16/11/2026 12h00 heure de Paris », « until 2026-11-16t11:00:00z »): the instant it names.
const LIMIT_PHRASE = /(?:valable\s+)?(?:jusqu['’]?\s*(?:au|à|a)|until)\s+(?:(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2}):\d{2}z|(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(?:à\s+)?(\d{1,2})\s*[h:]\s*(\d{2})?\s*(heure de paris|paris|utc|z)\b)/gu

// The answer without the limits it words that are the question's own, the same instant read in Paris time or UTC.
function withoutStatedLimit(said: string, question: string | undefined): string {
  const stated = new Set((question ?? '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g)?.map(Date.parse) ?? [])
  return said.replace(LIMIT_PHRASE, (phrase, y, mo, d, h, mi, day, month, year, hour, minute, zone) => {
    const instant = y !== undefined
      ? Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
      : zone === 'heure de paris' || zone === 'paris'
        ? parisInstant(Number(year), Number(month), Number(day), Number(hour), Number(minute ?? 0))
        : Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute ?? 0))
    return stated.has(instant) ? ' ' : phrase
  })
}

/** Whether the words name a repository (`owner/name`) or a pull request (`#7`) other than the subject's own. */
export function namesOtherSubject(typed: string, subject: ConsentSubject): boolean {
  const said = withoutOwnSubject(spaced(typed).toLowerCase(), subject)
  // A date (`16/11`) is no repository: each side of its slash holds a letter.
  const repositories = (said.match(/[\p{L}\p{N}._-]+\/[\p{L}\p{N}._-]+/gu) ?? []).filter(name => name.split('/').every(part => /\p{L}/u.test(part)))
  return repositories.length > 0 || /#\d+/.test(said)
}

// The choices an answer opens with (their text first, then the end of the answer or a character that is no letter, digit or combining mark), the longest first.
function opened<C extends { letter: string; text: string }>(said: string, choices: readonly C[]): C[] {
  const textOf = (choice: C) => spaced(choice.text).toLowerCase()
  return choices.filter(choice => textOf(choice) !== '' && said.startsWith(textOf(choice)) && !/^[\p{L}\p{N}\p{M}]/u.test(said.slice(textOf(choice).length)))
    .sort((a, b) => textOf(b).length - textOf(a).length)
}

/** Whether an answer opens with one of the choices, whatever follows. */
export function opensChoice(typed: string, choices: readonly { letter: string; text: string }[]): boolean {
  return opened(spaced(typed).toLowerCase(), choices).length > 0
}

/**
 * The choice an answer opens with, when it is a plain answer of that choice: its text first, then
 * the end of the answer or a character that is no letter, digit or combining mark, case and
 * spacing aside. A choice that does not grant (« Refuser ») takes any words after it, a refusal
 * never widens a consent. A choice that grants (« Accorder ») takes only a plain confirmation
 * after it, read fail-closed: what follows is, once the subject's own names are removed, nothing
 * but punctuation (`, . ! — - :` and parentheses) and the words of CONFIRMATION (« Accorder, merci »,
 * « Accorder et fusionner »). Any other word, a number, another pull request or repository, a
 * question mark or a semicolon is a limit, a condition or a question the record cannot hold, but
 * a limit that is the question's own (an instant it states, worded in Paris time or UTC) is no
 * limit the record lacks, so
 * the answer answers nothing and the asker asks again with the limit in the question. Undefined
 * also when two choices open it alike. It words an answer the operator himself gave, in the
 * coordinator's tab or its pane, where no exact form is asked: the record then holds that
 * choice's text, which is what grants. The words typed in any other session's tab stay
 * answersChoice's, which refuses all but the exact forms.
 */
export function leadingChoice<C extends { letter: string; text: string }>(typed: string, choices: readonly C[], subject: ConsentSubject, question?: string): C | undefined {
  const said = spaced(typed).toLowerCase()
  const candidates = opened(said, choices)
  const first = candidates[0]
  if (first === undefined) return undefined
  const text = spaced(first.text).toLowerCase()
  if (candidates[1] !== undefined && spaced(candidates[1].text).toLowerCase() === text) return undefined
  if (!grants(first.text)) return first
  const rest = withoutOwnSubject(withoutStatedLimit(said.slice(text.length), question), subject)
  if (/[?;]/.test(rest)) return undefined
  const words = rest.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
  return words.every(word => CONFIRMATION.has(word)) ? first : undefined
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
  // The coordinator's and the pane's words are the operator's own orders, which need no exact form;
  // a tab's are the asking session's, and keep to answersChoice's exact forms.
  const leadingSubject = fields.by !== 'tab' ? parseConsentSubject(fields.subject) : undefined
  const answer = consentAnswer(fields.answer, fields.choices, leadingSubject === undefined ? undefined : { subject: leadingSubject, question: fields.question })
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
