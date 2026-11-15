// hooks/consent-words.ts
// A consent the operator gave in words, with no question before it: what `settle` records when it
// is called with no `id` but a consent subject. Decided without the host (the host's `$` cannot be
// handed through this strict file): the call validated, the words judged against the subject the
// caller names, the turn he typed them in picked out of the transcript's lines, and the record
// they leave. The transcript read and the write are question.ts's (settleWords).
//
// The record is written only for words he typed himself in this session's tab: a real user turn
// of the transcript (`origin.kind` « human »), never a cross-session message, a tool result or text
// an agent wrote. The words name the subject (its repository, its pull request or environment) and
// grant it; a limit they state is the exemption's `until`, and no other; anything else — another
// repository or pull request, a question, a condition, a limit that is not the one passed — writes
// nothing, and the refusal says why.
import { CONSENT_GRANT, CONSENT_VERSION, DEPLOY_ENVS, parseConsentRecord, parseConsentSubject, type Answerer, type ConsentRecord, type ConsentSubject, type DeployEnv } from '../core/consent-record.ts'

export type Fields = Record<string, unknown>

/** The call's own fields: any of them with no `id` asks for a consent in words. */
export const WORDS_FIELDS = ['consent_kind', 'consent_repo', 'consent_pr', 'consent_env', 'until', 'said_at'] as const

/** A message of his longer than this is no sentence of consent. */
export const WORDS_MAX = 2000

/** A consent is read in the turn he gave it, not in an older one an agent could replay (a retraction he typed since would not show): older than this, the call is refused. */
export const WORDS_WINDOW_MS = 2 * 3_600_000

/** An exemption's record holds his sentence as its answer, and github's `detail` that quotes it is at most this long (core's DETAIL_MAX). */
export const EXEMPTION_WORDS_MAX = 500

/** One call, validated: the subject, the limit the kind takes, his message whole, and when he typed it if the caller says. */
export type Words = { subject: ConsentSubject; until: string | null; said: string; saidAt: string | null }

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** Whether a settle call asks for a consent in words: no entry named, one of the consent fields given. */
export const asksWords = (e: Fields): boolean => e['id'] === undefined && WORDS_FIELDS.some(field => e[field] !== undefined)

/** The call's fields as a consent in words, or why they are none. */
export function parseWords(e: Fields): { words: Words } | { error: string } {
  const given = Object.fromEntries([['kind', e['consent_kind']], ['repo', e['consent_repo']], ['pr', e['consent_pr']], ['env', e['consent_env']]].filter(([, value]) => value !== undefined))
  const subject = parseConsentSubject(given)
  if (subject === undefined) {
    return { error: `consent is consent_kind with consent_repo (owner/name): "e2e-waiver" or "norms-waiver" with consent_pr, "e2e-exemption" or "auto-merge" alone, "auto-deploy" with consent_env (${DEPLOY_ENVS.join(', ')}).` }
  }
  if (e['outcome'] !== undefined && e['outcome'] !== 'answered-here') return { error: 'a consent he gave in words is answered-here: his message is in this tab.' }
  if (['work', 'reason', 'author'].some(field => e[field] !== undefined)) return { error: 'a consent in words takes no work, reason or author: only his message as answer.' }
  const said = text(e['answer'])
  if (said === null) return { error: 'answer is his message, as he typed it in this tab, whole.' }
  if (said.length > WORDS_MAX) return { error: `answer is his message whole, and a sentence of consent is at most ${WORDS_MAX} characters.` }
  const until = e['until'] === undefined ? null : text(e['until'])
  if (e['until'] !== undefined && (until === null || !INSTANT.test(until) || Number.isNaN(Date.parse(until)))) return { error: 'until is the instant the exemption ends, in UTC to the second: 2026-11-16T11:00:00Z.' }
  if (until !== null && subject.kind !== 'e2e-exemption') return { error: `a ${subject.kind} takes no limit: until is an E2E exemption's alone.` }
  const saidAt = e['said_at'] === undefined ? null : text(e['said_at'])
  if (e['said_at'] !== undefined && (saidAt === null || Number.isNaN(Date.parse(saidAt)))) return { error: 'said_at is the instant he typed it, in UTC: 2026-11-15T07:11:00Z.' }
  return { words: { subject, until, said, saidAt } }
}

// ---- his words, judged -------------------------------------------------------------------------

/** A text with its runs of whitespace made one space and the typographic apostrophe the plain one. */
const folded = (value: string): string => value.replace(/\s+/g, ' ').trim()
const lowered = (value: string): string => folded(value).toLowerCase().replace(/[’‘]/g, "'")

// A word, not the middle of a longer one: letters and digits join, accents included.
const apart = (pattern: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'u')

// How his words open when they grant: « Accorder … », or a plain yes with the subject then named.
const GRANTING = new RegExp(`^["«“]?\\s*(?:j'accorde|accord(?:er|ez|e|é|ée)?|d'accord|oui|ok|okay|go|yes|vas-y|allez-y|valide[rz]?)(?![\\p{L}\\p{N}])`, 'u')

// What makes words no plain grant: a question, a condition, an exception, a restriction, a refusal.
// Fail-closed: the asker asks again, with the limit or the condition in the question.
const HEDGED = apart("pas|non|jamais|sauf|mais|attend\\p{L}*|wait|not|don't|dont|no|never|refus\\p{L}*|annul\\p{L}*|cancel|stop|si|if|unless|only|seulement|uniquement|plut[oô]t|rather|avant|before|apr[eè]s|after|sinon|otherwise|r[eé]voqu\\p{L}*|retir\\p{L}*|revok\\p{L}*|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday")

/** What each kind's words must also say, so that a plain « oui » naming a repository grants the kind the caller names and not another. */
const WAIVING = "dispens\\p{L}*|exempt\\p{L}*|exon[eèé]r\\p{L}*|waiv\\p{L}*|d[eé]rogation"
const TOPIC: Record<ConsentSubject['kind'], readonly RegExp[]> = {
  'e2e-exemption': [apart(WAIVING)],
  'e2e-waiver': [apart('e2e|end[- ]to[- ]end|bout[- ]en[- ]bout'), apart(WAIVING)],
  'norms-waiver': [apart('norms?|normes?'), apart(WAIVING)],
  'auto-merge': [apart("auto[- ]?merge|merge automatique|fusion automatique|fusionner automatiquement|merger automatiquement")],
  'auto-deploy': [apart("auto[- ]?d[eé]ploi\\p{L}*|auto[- ]?deploy\\p{L}*|d[eé]ploiement (?:automatique|continu)|d[eé]ployer automatiquement|continuous deploy\\p{L}*")],
}

const ENV_WORDS: Record<string, DeployEnv> = { dev: 'dev', staging: 'staging', stage: 'staging', prod: 'prod', production: 'prod' }
// An environment is no part of a compound (« pre-prod », « prod-like »): hyphens and underscores join it too.
const ENV_NAME = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${Object.keys(ENV_WORDS).join('|')})(?![\\p{L}\\p{N}_-])`, 'gu')

// The instant a Paris wall time is, or NaN when that time does not exist (the hour skipped in spring); the earlier of the two when it is the hour the autumn repeats.
function parisInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offsetAt = (instant: number): number => {
    const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(instant).map(p => [p.type, Number(p.value)]))
    return (Date.UTC(part['year']!, part['month']! - 1, part['day']!, part['hour']!, part['minute']!) - Math.floor(instant / 60000) * 60000) / 60000
  }
  return [120, 60].map(offset => wall - offset * 60000).find(instant => offsetAt(instant) === (wall - instant) / 60000) ?? NaN
}

const LEAD = "(?:valable\\s+)?(?:(?:jusqu'?\\s*(?:au|à|a)|until|le)\\s+)?"
// « jusqu'au 16/11/2026 12h00 heure de Paris »: a day, an hour and the zone it is in (Paris when he names none, as every hour he says is).
const FRENCH_INSTANT = new RegExp(`${LEAD}(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s*(?:à|a|at|,)?\\s*(\\d{1,2})\\s*(?:h|:)\\s*(\\d{2})?(?:\\s*(heure de paris|heure paris|paris|utc|gmt|z))?(?![\\p{L}\\p{N}])`, 'gu')
// « until 2026-11-16T11:00:00Z »: the instant itself, in UTC.
const ISO_INSTANT = new RegExp(`${LEAD}(\\d{4})-(\\d{2})-(\\d{2})t(\\d{2}):(\\d{2})(?::(\\d{2}))?\\s*(?:z|utc)(?![\\p{L}\\p{N}])`, 'gu')
// A limit left in his words once the instants read are removed: one the call cannot hold, so it refuses.
const LIMIT_LEFT = new RegExp(
  "jusqu|until|ce soir|tonight|expir|valable|demain|tomorrow|aujourd'hui|today|\\d{1,2}/\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|(?<![\\p{L}\\p{N}])\\d{1,2}\\s?h(?:\\d{2})?(?![\\p{L}\\p{N}])"
  // A duration, a period, a moment, a zone: any other way of limiting is a limit this call cannot read.
  + "|(?<![\\p{L}\\p{N}])(?:pendant|durant|during|for|semaines?|weeks?|week-?end|jours?|journ[eé]es?|days?|heures?|hours?|minutes?|mois|months?|ans|ann[eé]es?|years?|temporair\\p{L}*|provisoire\\p{L}*|temporar\\p{L}*|moment|fois|once|am|pm|pst|cst|cet|cest|bst|gmt|utc|locale|local)(?![\\p{L}\\p{N}])"
  + "|(?<![\\p{L}\\p{N}])[+-]\\s?\\d",
  'u',
)

/** The limits his words state, as instants, and what is left of them once those are read; null instants when one cannot be read. */
function limitsOf(said: string): { instants: number[]; left: string } | null {
  const instants: number[] = []
  const left = said
    .replace(ISO_INSTANT, (_match, y, mo, d, h, mi, s) => { instants.push(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))); return ' ' })
    .replace(FRENCH_INSTANT, (_match, d, mo, y, h, mi, zone) => {
      const [day, month, year, hour, minute] = [d, mo, y, h, mi ?? '0'].map(Number) as [number, number, number, number, number]
      const calendar = new Date(Date.UTC(year, month - 1, day))
      if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) { instants.push(NaN); return ' ' }
      instants.push(zone === 'utc' || zone === 'gmt' || zone === 'z' ? Date.UTC(year, month - 1, day, hour, minute) : parisInstant(year, month, day, hour, minute))
      return ' '
    })
  return instants.some(Number.isNaN) ? null : { instants, left }
}

// Every `owner/name` his words hold other than the subject's: a date has digits on both sides of its slash and is none.
function otherRepositories(said: string, repo: string): string[] {
  const named = said.match(/[\p{L}\p{N}._-]+\/[\p{L}\p{N}._-]+/gu) ?? []
  return named.map(name => name.replace(/[._-]+$/, '')).filter(name => name.split('/').every(part => /\p{L}/u.test(part)) && name !== repo.toLowerCase())
}

// Whether his words name the repository: `owner/name`, or its name alone.
function namesRepository(said: string, repo: string): boolean {
  const name = (repo.split('/')[1] ?? repo).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const full = repo.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}._/-])(?:${full}|${name})(?![\\p{L}\\p{N}_-])`, 'u').test(said)
}

// The only words a plain grant holds besides the subject's names and the limit it states: the grant,
// the small words around it, what the kind is about. Any other word — an instruction, a condition, a
// scope (« sauf les PRs docs »), a deferral, a second subject — makes the message more than a grant,
// and nothing is recorded: the allowed vocabulary is what fails closed, no list of what to refuse.
const PLAIN_WORDS = new Set([
  "accorder", "accorde", "accordé", "accordée", "accordez", "d'accord", "oui", "ok", "okay", "go", "yes", "vas-y", "allez-y", "valide", "valider", "validez",
  "je", "tu", "vous", "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "au", "aux", "en", "à", "sur", "pour", "et", "and", "the", "of", "ce", "cette", "ces", "cet",
  "tout", "tous", "toute", "toutes", "merci", "thanks", "thank", "you", "please", "svp", "s'il", "plait", "plaît", "te", "bon", "bien", "parfait", "super",
  "fusionner", "fusionne", "fusionnez", "merge", "pr", "prs", "pull", "request", "requests", "pull-request", "pull-requests", "repo", "repository", "dépôt", "depot",
])
const KIND_WORDS: Record<ConsentSubject['kind'], RegExp> = {
  'e2e-exemption': /^(?:dispens\p{L}*|exempt\p{L}*|exon[eèé]r\p{L}*|waiv\p{L}*|d[eé]rogation|e2e|end-to-end|end|bout|bout-en-bout)$/u,
  'e2e-waiver': /^(?:dispens\p{L}*|exempt\p{L}*|exon[eèé]r\p{L}*|waiv\p{L}*|d[eé]rogation|e2e|end-to-end|end|bout|bout-en-bout)$/u,
  'norms-waiver': /^(?:dispens\p{L}*|exempt\p{L}*|exon[eèé]r\p{L}*|waiv\p{L}*|d[eé]rogation|norms?|normes?)$/u,
  'auto-merge': /^(?:auto-?merge|automerge|automatique(?:ment)?|fusion|merger|automatically)$/u,
  'auto-deploy': /^(?:auto-?d[eé]ploi\p{L}*|auto-?deploy\p{L}*|d[eé]ploiement|d[eé]ployer|d[eé]ploy\p{L}*|deploy\p{L}*|automatique(?:ment)?|continu|continuous|automatically|dev|staging|stage|prod|production)$/u,
}

/** The words of his message that are no part of a plain grant of the subject, once the subject's names and the limit it states are taken out. */
function wordsBeyondGrant(left: string, subject: ConsentSubject): string[] {
  const repo = subject.repo.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = (subject.repo.split('/')[1] ?? subject.repo).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bare = left
    .replace(new RegExp(`(?<![\\p{L}\\p{N}._/-])(?:${repo}|${name})(?![\\p{L}\\p{N}_-])`, 'gu'), ' ')
    .replace(PULL_REQUEST, ' ')
  return (bare.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? []).filter(word => {
    const plain = word.replace(/^(?:[ldjscntm]|qu)'/, '')
    return !(PLAIN_WORDS.has(plain) || PLAIN_WORDS.has(word) || KIND_WORDS[subject.kind].test(plain))
  })
}

// A pull request as his words name it: `#7`, `PR 7`, `pull request n° 7`, `/pull/7`.
const PULL_REQUEST = /#(\d+)(?!\d)|(?<![\p{L}\p{N}])(?:prs?|pull requests?|pull)\s*(?:n°|no\.?|#)?\s*(\d+)(?!\d)|\/pulls?\/(\d+)(?!\d)/gu

/** The pull request numbers his words name, as `#7`, `owner/name#7` or `PR 7`. */
function pullRequestsNamed(said: string): number[] {
  return [...said.matchAll(PULL_REQUEST)].map(match => Number(match[1] ?? match[2] ?? match[3]))
}

/** What the call records, or why it records nothing. */
export type Judged = { ok: { answer: string; question: string } } | { refuse: string }

const labelOf = (subject: ConsentSubject, until: string | null): string =>
  `${subject.kind} of ${subject.repo}${'pr' in subject ? `#${subject.pr}` : ''}${'env' in subject ? ` for ${subject.env}` : ''}${until !== null ? ` until ${until}` : ''}`

/**
 * His words judged against the subject, the limit and the instant of the call. They grant (open with
 * « Accorder » or a plain yes), name the repository, the pull request or environment the kind needs
 * and what the kind is about, name no other repository or pull request, hold no question or
 * condition, and state a limit only as the `until` passed, which an exemption alone takes and which
 * then must be stated; an exemption's sentence is at most EXEMPTION_WORDS_MAX characters. The record's answer is what the readers of that kind take: an exemption's is
 * his sentence whole (github reads the repository and the exemption in it), any other kind's is
 * « Accorder »; his sentence is held whole in the question either way.
 */
export function judgeWords(words: Words, now: number): Judged {
  const { subject, until, said } = words
  const said_ = lowered(said)
  const no = (refuse: string): Judged => ({ refuse: `nothing recorded: ${refuse}` })
  if (subject.kind === 'e2e-exemption' && folded(said).length > EXEMPTION_WORDS_MAX) return no(`an exemption quotes his sentence whole, and github takes at most ${EXEMPTION_WORDS_MAX} characters of it: his message is longer.`)
  if (!GRANTING.test(said_)) return no('his message does not grant: it opens neither with « Accorder » nor with a plain yes (oui, ok, go). A question, a refusal or an instruction is no consent.')
  if (/[?;]/.test(said_) || HEDGED.test(said_)) return no('his message holds a question, a condition, an exception or a refusal (pas, non, sauf, si, seulement, ?…): it is no plain grant, ask him again.')
  if (!namesRepository(said_, subject.repo)) return no(`his message does not name ${subject.repo}.`)
  const others = otherRepositories(said_, subject.repo)
  if (others.length > 0) return no(`his message names another repository (${others.join(', ')}) than ${subject.repo}.`)
  const numbers = pullRequestsNamed(said_)
  if ('pr' in subject) {
    const other = numbers.filter(number => number !== subject.pr)
    if (other.length > 0) return no(`his message names another pull request (#${other.join(', #')}) than ${subject.repo}#${subject.pr}.`)
    if (!numbers.includes(subject.pr)) return no(`his message does not name ${subject.repo}#${subject.pr}: a waiver is of one pull request, and he names it.`)
  } else if (numbers.length > 0) return no(`his message names a pull request (#${numbers.join(', #')}), and a ${subject.kind} of ${subject.repo} is the repository's.`)
  if ('env' in subject) {
    const named = new Set([...said_.matchAll(ENV_NAME)].map(match => ENV_WORDS[match[0]]))
    if (!named.has(subject.env)) return no(`his message does not name the environment ${subject.env}.`)
    if (named.size > 1) return no(`his message names another environment than ${subject.env}: a deploy is granted per environment.`)
  }
  if (!TOPIC[subject.kind].every(topic => topic.test(said_))) return no(`his message does not say what it grants: it does not name ${subject.kind === 'auto-merge' ? 'auto-merge' : subject.kind === 'auto-deploy' ? 'auto-deploy' : subject.kind === 'norms-waiver' ? 'the norms check and its waiver' : subject.kind === 'e2e-waiver' ? 'the E2E check and its waiver' : 'the exemption (dispense, exemption)'}.`)
  const limits = limitsOf(said_)
  if (limits === null) return no('the limit in his message is a date or an hour that does not exist or cannot be read: ask him again, in a form like « jusqu\'au 16/11/2026 12h00 heure de Paris ».')
  const stated = limits.instants.length > 0 || LIMIT_LEFT.test(limits.left)
  if (stated && subject.kind !== 'e2e-exemption') return no(`his message states a limit, and a ${subject.kind} takes none.`)
  if (stated && until === null) return no(`his message states a limit${limits.instants.length > 0 ? ` (${limits.instants.map(instant => new Date(instant).toISOString().replace('.000Z', 'Z')).join(', ')})` : ' this call cannot read'}: pass it as until, or ask him again with the limit in a form like « jusqu'au 16/11/2026 12h00 heure de Paris ».`)
  if (until !== null) {
    if (limits.instants.length === 0) return no(`until ${until} is not his: his message states no limit this call can read.`)
    const wrong = limits.instants.filter(instant => instant !== Date.parse(until))
    if (wrong.length > 0) return no(`until ${until} is not the limit he stated (${wrong.map(instant => new Date(instant).toISOString().replace('.000Z', 'Z')).join(', ')}).`)
    if (LIMIT_LEFT.test(limits.left)) return no('his message states a limit besides the one read: ask him again with one.')
    if (!(Date.parse(until) > now)) return no(`until ${until} is already past: an exemption that ends before it begins exempts nothing.`)
  }
  const beyond = wordsBeyondGrant(limits.left, subject)
  if (beyond.length > 0) return no(`his message holds more than a plain grant: « ${[...new Set(beyond)].slice(0, 6).join(' ')} » is an instruction, a condition, a scope or another subject. Ask him again; the grant alone is « Accorder … » naming the subject.`)
  return {
    ok: {
      answer: subject.kind === 'e2e-exemption' ? folded(said) : CONSENT_GRANT,
      question: `Consent given in words, with no question before it: « ${folded(said)} » — ${labelOf(subject, until)}`,
    },
  }
}

// ---- the turn he typed them in ------------------------------------------------------------------

/** A transcript line that is a message the operator typed himself, its text and its time; null for any other line. */
export function humanTurn(line: string): { text: string; at: string } | null {
  let entry: Fields
  try {
    entry = JSON.parse(line) as Fields
  } catch {
    return null
  }
  if (entry['type'] !== 'user' || entry['isMeta'] === true || entry['isSidechain'] === true || entry['isCompactSummary'] === true) return null
  if (entry['toolUseResult'] !== undefined || entry['sourceToolAssistantUUID'] !== undefined || entry['sourceToolUseID'] !== undefined) return null
  const origin = entry['origin']
  if (typeof origin !== 'object' || origin === null || (origin as Fields)['kind'] !== 'human') return null
  if (entry['turnOrigin'] !== undefined && entry['turnOrigin'] !== 'human') return null
  const at = entry['timestamp']
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null
  const content = (entry['message'] as Fields | undefined)?.['content']
  const blocks = Array.isArray(content) ? content as Fields[] : null
  const said = typeof content === 'string' ? content
    : blocks !== null && blocks.length > 0 && blocks.every(block => block['type'] === 'text' && typeof block['text'] === 'string') ? blocks.map(block => String(block['text'])).join('\n') : null
  return said === null ? null : { text: said, at: new Date(Date.parse(at)).toISOString().replace(/\.\d+Z$/, 'Z') }
}

/** Whether a transcript line is the turn the call quotes: his message, whole and spacing aside, and at the instant said_at gives when it does. */
export function isHisTurn(line: string, words: Words): boolean {
  const turn = humanTurn(line)
  return turn !== null && folded(turn.text) === folded(words.said) && (words.saidAt === null || turn.at === new Date(Date.parse(words.saidAt)).toISOString().replace(/\.\d+Z$/, 'Z'))
}

// ---- the record ---------------------------------------------------------------------------------

/** The record of a consent in words: the answer the kind's readers take, the sentence in its question, the turn's own time. */
export function wordsRecord(words: Words, ok: { answer: string; question: string }, by: Answerer, at: string): ConsentRecord | undefined {
  const { subject } = words
  const entry = ['words', subject.kind, ...('pr' in subject ? [String(subject.pr)] : []), ...('env' in subject ? [subject.env] : []), String(Date.parse(at))].join('-')
  return parseConsentRecord({ v: CONSENT_VERSION, subject, entry, question: ok.question, answer: ok.answer, by, at })
}
