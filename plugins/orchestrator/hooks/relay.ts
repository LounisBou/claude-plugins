// hooks/relay.ts
// The end of an orchestrator's turn, read by the module: the wait it declared (declare_wait)
// says whether the turn waits on the operator or reports its work done. An agent's turn ends the same way on its status line, reported to its
// orchestrator instead, and its gate crossing too (supervision.ts). The wait lands in the session's store row (supervision.ts), where the
// pane, /orchestrator:status and the coordinator's facts read it, and once in the
// coordinator's hands: an entry of its round when it runs on this machine (round.ts), one
// report sent when it runs on another — the question as the answer carried it, or
// the closing proposal. Without this, an orchestrator that asked the operator in its
// own tab looked stopped from outside, and the coordinator spent two full turns
// asking it why. When the operator types in the orchestrator's own tab and the turn he
// started ends on another line, its entry is marked withdrawn, or the coordinator elsewhere is
// sent one withdrawal, and the fingerprint is forgotten, so the same question asked again is
// relayed again. Pure on
// purpose: the handler holds the $ (the engine fences it to the file that received it) and
// passes its reads in here.
import { blocksNothing, waitLine, type DeclaredWait } from './stop-gate.ts'
import { chainTtyOf, parseChain } from '../core/chain-entries.ts'
import { machineLine, reportStatus } from '../core/method.ts'
import type { SessionRow } from './supervision.ts'
import { cutAt, shorten, VERDICT_LIMIT, verdictOf } from '../core/verdict.ts'

// The question a report carries is cut past this many characters, and the cut is said:
// a coordinator's round needs the question, not a whole turn's narrative.
export const RELAY_CAP = 4000

// An orchestrator waits on the operator or is done; an agent of one (parseStatus) has
// delivered, is blocked, asks or waits on its own background work, `blocks` then its status
// line's own words.
// A wait on the operator its sender marked `(urgent)` carries `urgent: true`; the plain
// form carries no such field. In the fingerprint, so a wait marked urgent or unmarked is
// entered again, but never in the round entry's id (round.ts roundEntryId): the same entry.
export type Wait =
  | { kind: 'operator'; blocks: string; question: string; urgent?: true }
  | { kind: 'done'; question: string }
  | { kind: 'delivered' | 'blocked' | 'question' | 'waiting'; blocks: string; question: string }
export type WaitKind = Wait['kind']

// The wait an orchestrator's turn declared (declare_wait, wait.ts), as the relay carries it: a wait
// on the operator with what it blocks, or done, the question being the turn's answer. Neither is
// the ending on work the operator deferred (his ruling recorded), nor a wait on the operator that
// blocks nothing: he is asked nothing, so nothing is entered, sent or kept. No declaration: no
// wait, whatever the answer's last line says.
export function declaredWait(declared: DeclaredWait | null, answer: string): Wait | null {
  if (declared === null || declared.kind === 'deferred') return null
  const question = answer.trim()
  if (declared.kind === 'done') return { kind: 'done', question }
  if (blocksNothing(waitLine(declared))) return null
  const wait: Wait = { kind: 'operator', blocks: declared.blocks, question }
  return declared.urgent ? { ...wait, urgent: true } : wait
}

// A successor's word to its predecessor, « takeover confirmed » (the succession brief), read on
// the text's first line, its markup dropped. The phrase opens the line and
// anything may follow it: a successor reports on the same line (« takeover confirmed — <its name>
// holds the orchestration; … », 2026-11-04), and a whole-line match read that as no takeover, so
// the hand-over withdrew the open questions it should have moved.
export function confirmsTakeover(text: string): boolean {
  return /^takeover confirmed\b/i.test(machineLine(text.split('\n').find(line => line.trim() !== '') ?? ''))
}

// An agent's last line, its brief's own: `status: done|blocked|question — <one line>`, or
// `status: waiting — <what is watched>` while its own background work runs, read
// by core's reportStatus. The text above it is its report or question.
const STATUS_KIND = { done: 'delivered', blocked: 'blocked', question: 'question', waiting: 'waiting' } as const

export function parseStatus(answer: string): Wait | null {
  const status = reportStatus(answer)
  if (!status) return null
  const lines = answer.replace(/\s+$/, '').split('\n')
  return { kind: STATUS_KIND[status.status], blocks: status.reason, question: lines.slice(0, -1).join('\n').trim() }
}

// An agent's turn text held to the verdict limit before it is relayed: whole under it, else its
// status line kept whole and the text above it cut, the cut naming the report the text names, or
// saying it names none.
export function heldReport(answer: string): string {
  const text = answer.trim()
  const short = shorten(text)
  if (short.kind === 'whole') return answer
  const lines = text.split('\n')
  const status = lines.length > 1 && parseStatus(text) ? lines[lines.length - 1] : ''
  const body = status ? lines.slice(0, -1).join('\n') : text
  const cut = cutAt(body, status ? Math.max(0, VERDICT_LIMIT - status.length - 1) : VERDICT_LIMIT, short.kind === 'cut' ? short.path : null)
  return status ? `${cut}\n${status}` : cut
}

// ── The facts of a delivery, read on the repository ──────────────────────────
// An agent that ends on `status: done` claims a delivery: its tree clean, its commits pushed, its
// pull request's head its own, CI on its way. The module reads those facts itself, from git in the
// agent's checkout (the directory the module runs in, the clone its orchestrator made) and one gh
// read, and adds them to the report as one line, so the orchestrator neither takes them on the
// agent's word nor checks them by hand. A read that fails is said unread, never guessed.

// A process run as the handler hands it in, within `timeoutMs` (its own default when none): its
// answer, or null when it could not run in time.
export type FactsRun = (argv: readonly string[], timeoutMs?: number) => Promise<{ exitCode: number; stdout?: unknown; stderr?: unknown } | null>

// What the github gate reads of CI at a head (its `ci.result`), in one word, or `unread` with why.
export type CiState = 'green' | 'failing' | 'pending' | 'none' | 'unread'

export type DeliveryFacts = {
  /** Paths `git status --porcelain` lists; null unread. */
  dirty: number | null
  /** Commits of HEAD on no remote branch; null unread. */
  unpushed: number | null
  head: string | null
  /** The pull request gh reads, the one the verdict line names or else the branch's; null unread. `ciWhy` says why `ci` is unread. */
  pr: { number: number; head: string; ci: CiState; ciWhy?: string } | null
  /** Why CI is unread when `pr` is: gh did not read the pull request. */
  ciWhy?: string
  /** The pull request and head the agent's verdict line names, if it names one. */
  claimed: { pr: number; head: string } | null
}

// The gate's `ci.result` as a word of the facts line. The gate (github's `pr-gate`) is the one
// reading of CI: it keeps the latest run of each check, which a rollup of every run does not.
export const GATE_CI: ReadonlyMap<string, CiState> = new Map([['SUCCESS', 'green'], ['FAILURE', 'failing'], ['PENDING', 'pending'], ['NONE', 'none']])

// The gate's last answer ci-watch kept for a pull request (core's ciGatePath), as text, or null when
// it kept none. The relay reads CI there and runs no process for it: the gate makes five or so
// GitHub reads, about 3.3 s, which a turn's end cannot wait for (2026-11-17, cut at 4.3 s).
export type KeptGate = (repo: string, pr: number) => Promise<string | null>

const oneLine = (text: unknown): string => String(text ?? '').trim().split('\n')[0]!.slice(0, 120)

// The kept gate answer for `head`, in one word of CI or why it is unread. Never a guess: no reading,
// a reading of another head, or one with no known result is unread.
export function keptCi(text: string | null, head: string): { ci: CiState; why?: string } {
  if (text === null) return { ci: 'unread', why: `no gate reading at ${head.slice(0, 7)} yet` }
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return { ci: 'unread', why: 'the gate reading kept is no JSON' }
  }
  const answer = typeof read === 'object' && read !== null ? read as { head?: unknown; ci?: unknown } : {}
  if (typeof answer.head !== 'string') return { ci: 'unread', why: 'the gate reading kept names no head' }
  if (answer.head.toLowerCase() !== head.toLowerCase()) return { ci: 'unread', why: `the last gate reading is of head ${answer.head.slice(0, 7)}, not ${head.slice(0, 7)}` }
  const result = typeof answer.ci === 'object' && answer.ci !== null ? (answer.ci as { result?: unknown }).result : undefined
  const ci = typeof result === 'string' ? GATE_CI.get(result) : undefined
  return ci ? { ci } : { ci: 'unread', why: 'the gate reading kept has no CI result' }
}

const lineOf = (done: Awaited<ReturnType<FactsRun>>): string | null => (done && done.exitCode === 0 ? String(done.stdout ?? '').trim() : null)

const countOf = (text: string | null): number | null => (text !== null && /^\d+$/.test(text) ? Number(text) : null)

// The repository a pull request's URL names, `owner/name`, or null.
const repoOfUrl = (url: unknown): string | null => {
  const m = typeof url === 'string' ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url) : null
  return m?.[1] ?? null
}

// The facts of the delivery `report` claims, every read at once: git's three in the checkout,
// gh's one on the pull request the verdict line names (verdictOf), else on the branch's, and CI as
// the gate's last reading ci-watch kept for that pull request (`kept`) says it at its head.
export async function readDeliveryFacts(run: FactsRun, report: string, kept: KeptGate): Promise<DeliveryFacts> {
  const named = verdictOf(report)
  const quiet = (argv: readonly string[], timeoutMs?: number) => run(argv, timeoutMs).catch(() => null)
  const [status, head, unpushed, view] = await Promise.all([
    quiet(['git', 'status', '--porcelain']),
    quiet(['git', 'rev-parse', 'HEAD']),
    quiet(['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes']),
    // One --json argument, the fields comma-joined: gh reads a second word as a positional.
    quiet(['gh', 'pr', 'view', ...(named ? [String(named.pr)] : []), '--json', 'number,headRefOid,url']),
  ])
  const porcelain = status && status.exitCode === 0 ? String(status.stdout ?? '') : null
  return {
    dirty: porcelain === null ? null : porcelain.split('\n').filter(line => line.trim() !== '').length,
    unpushed: countOf(lineOf(unpushed)),
    head: lineOf(head) || null,
    ...await pullRequestOf(lineOf(view), kept),
    claimed: named ? { pr: named.pr, head: named.head } : null,
  }
}

// The pull request gh read; its CI is the kept gate reading at its head. A pull request gh did not
// read has no head to compare the reading with: its CI is unread too, said beside it. A reading that
// cannot be read is unread, never a missing CI word.
async function pullRequestOf(json: string | null, kept: KeptGate): Promise<Pick<DeliveryFacts, 'pr' | 'ciWhy'>> {
  let read: { number?: unknown; headRefOid?: unknown; url?: unknown } = {}
  try {
    read = json ? JSON.parse(json) as typeof read : {}
  } catch {
    read = {}
  }
  if (typeof read.number !== 'number' || typeof read.headRefOid !== 'string') return { pr: null, ciWhy: 'the pull request was not read' }
  const repo = repoOfUrl(read.url)
  let ci: { ci: CiState; why?: string }
  try {
    ci = repo === null ? { ci: 'unread', why: 'the pull request\'s repository was not read' } : keptCi(await kept(repo, read.number), read.headRefOid)
  } catch (error) {
    ci = { ci: 'unread', why: `the gate reading could not be read: ${oneLine(error instanceof Error ? error.message : error)}` }
  }
  return { pr: { number: read.number, head: read.headRefOid, ...(ci.why === undefined ? { ci: ci.ci } : { ci: ci.ci, ciWhy: ci.why }) } }
}

// What the facts contradict in a claimed delivery: a dirty tree, unpushed commits, a local head
// that is not the pull request's, a head or a pull request other than the verdict line names.
export function falseClaims(f: DeliveryFacts): string[] {
  const wrong: string[] = []
  if (f.dirty !== null && f.dirty > 0) wrong.push('tree dirty')
  if (f.unpushed !== null && f.unpushed > 0) wrong.push('commits unpushed')
  if (f.head && f.pr && f.head !== f.pr.head) wrong.push('local head is not the pull request\'s')
  if (f.claimed && f.head && !f.head.startsWith(f.claimed.head)) wrong.push(`named head ${f.claimed.head} is not the local head`)
  if (f.claimed && f.pr && f.pr.number !== f.claimed.pr) wrong.push(`#${f.claimed.pr} named, #${f.pr.number} read`)
  return wrong
}

// The facts as the orchestrator receives them, one line: each fact or « unread », and, when they
// contradict the claimed delivery, what is false said first.
export function factsLine(f: DeliveryFacts): string {
  const h7 = (sha: string) => sha.slice(0, 7)
  const tree = f.dirty === null ? 'tree unread' : f.dirty === 0 ? 'tree clean' : `tree dirty (${f.dirty} paths)`
  const pushed = f.unpushed === null ? 'unpushed unread' : `${f.unpushed} unpushed`
  const head = !f.head ? 'head unread'
    : !f.pr ? `head ${h7(f.head)}, pull request unread${f.ciWhy ? `, CI unread (${f.ciWhy})` : ''}`
    : f.head === f.pr.head ? `head ${h7(f.head)} = #${f.pr.number}'s head` : `head ${h7(f.head)} ≠ #${f.pr.number}'s head ${h7(f.pr.head)}`
  const ci = f.pr ? `, CI ${f.pr.ci}${f.pr.ciWhy ? ` (${f.pr.ciWhy})` : ''} at ${h7(f.pr.head)}` : ''
  const wrong = falseClaims(f)
  const said = wrong.length > 0 ? `FALSE CLAIM of delivery (${wrong.join('; ')}) — ` : ''
  return `facts (read by the module): ${said}${tree}, ${pushed}, ${head}${ci}`
}

// What an agent's message over the limit that names no report file should have done: the line
// the guards log when they let it through.
export function unnamedReport(length: number): string {
  return `Your message to the orchestrator is ${length} characters, over its ${VERDICT_LIMIT}: write the full report to a file first, then send its verdict line naming it (report: <absolute path>).`
}

// The wait as its file last held it: the current wait, or the one a turn's start
// cleared (`last_waiting`, its blocks and start kept beside it).
export type PriorWait = { waiting?: WaitKind | null; last_waiting?: WaitKind | null; blocks?: string | null; waiting_since?: string | null }

// The wait fields for this turn's wait: `waiting_since` is kept while the same wait
// lasts (same kind, same blocks) — across the turns between, which clear it only for
// display — and starts now on a new one.
export function waitPatch(prior: PriorWait | null, wait: Wait, now: string): Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since'> {
  const blocks = 'blocks' in wait ? wait.blocks : null
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const same = kind === wait.kind && (prior?.blocks ?? null) === blocks && typeof prior?.waiting_since === 'string'
  return { waiting: wait.kind, blocks, waiting_since: same ? prior!.waiting_since! : now }
}

// A wait cleared — the session works again, or its turn ended without one: nothing is
// waited on, and the wait it was is kept so that the same wait asked again keeps its start.
export function clearedWait<T extends PriorWait>(prior: T): T & { waiting: null; last_waiting: WaitKind | null } {
  return { ...prior, waiting: null, last_waiting: prior.waiting ?? prior.last_waiting ?? null }
}

// The deduplication key: a wait is its kind and its line, reported once however the turns
// it spans read above that line; a new line is a new wait. A delivery, or a line saying
// nothing, keeps the turn's text in the key: a second delivery is news. A wait marked urgent
// keys apart from the plain one. FNV-1a over the text, enough to tell two waits apart.
export function fingerprint(wait: Wait): string {
  const blocks = 'blocks' in wait ? wait.blocks : ''
  const said = wait.kind === 'delivered' || !blocks ? wait.question : ''
  const urgent = wait.kind === 'operator' && wait.urgent ? '\nurgent' : ''
  const text = `${wait.kind}\n${blocks}\n${said}${urgent}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}-${hash.toString(16)}`
}

// The report sent up: to the coordinator for an orchestrator, to its orchestrator for an
// agent. A header naming the session and its state, the address the answer goes back to,
// then the text the turn carried, cut past the cap and said; a wait on background work that
// names what it watches carries its status line alone. A report, never an order: it carries no approval, no merge, no undraft
// and no stand-down. A delivery carries its facts line (factsLine) under its header when read.
export function relayText(name: string, wait: Wait, since: string, context: string | null = null, facts: string | null = null): string {
  const reply = `reply with SendMessage to: ${name}`
  if (wait.kind === 'done') return `[module] ${name} reports its work done and proposes to be closed\n${reply}`
  const header = wait.kind === 'operator' ? `[module] ${name} waits for the operator since ${since} — blocks: ${wait.blocks}`
    : wait.kind === 'delivered' ? `[module] ${name} reports its delivery; verify on the artifact${context ? ` — context ${context}` : ''}`
    : wait.kind === 'waiting' ? `[module] ${name} waits on its background work`
    : `[module] ${name} ${wait.kind === 'blocked' ? 'is blocked' : 'asks'}`
  const said = ('blocks' in wait && wait.kind !== 'operator' && wait.blocks ? ` — ${wait.blocks}` : '')
    + (wait.kind === 'delivered' && facts ? `\n${facts}` : '')
  if (!wait.question || (wait.kind === 'waiting' && wait.blocks)) return `${header}${said}\n${reply}`
  return `${header}${said}\n${reply}\n\n${cutQuestion(wait.question)}`
}

// The question as a report carries it, the coordinator's round entry included: cut past
// the cap, and the cut said.
export function cutQuestion(question: string): string {
  return question.length > RELAY_CAP ? `${question.slice(0, RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${question.length} characters]` : question
}

// The wait file as the withdrawal reads it: the wait, and the fingerprint last delivered.
export type RelayedWait = PriorWait & { relayed?: string | null; pending_key?: string | null }

// The question the coordinator holds, if any: an operator wait (the current one, or the
// one a turn's start cleared) whose own fingerprint, plain or urgent, was delivered. Its blocks
// and start are what the coordinator's round file carries in the question's header.
export function heldQuestion(prior: RelayedWait | null): { blocks: string; since: string | null } | null {
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const blocks = prior?.blocks
  if (kind !== 'operator' || typeof blocks !== 'string' || blocks === '') return null
  const plain: Wait = { kind: 'operator', blocks, question: '' }
  if (prior!.relayed !== fingerprint(plain) && prior!.relayed !== fingerprint({ ...plain, urgent: true })) return null
  return { blocks, since: prior!.waiting_since ?? null }
}

// An operator question a sender holds open: the start and the blocks that name its wait.
export type HeldQuestion = { since: string; blocks: string }

// The operator questions a sender's wait file vouches for, the one source of what its row says it
// holds open whatever the session is doing: the held question, delivered or sent and not yet
// acknowledged. A file whose wait is on something else than the operator (a closing proposal, none
// ever) says nothing of the questions beside it: null, unknown, never « none open »; so does an
// operator wait whose blocks is empty, which no entry's header can match.
export function openQuestions(prior: RelayedWait | null): HeldQuestion[] | null {
  if ((prior?.waiting ?? prior?.last_waiting ?? null) !== 'operator') return null
  if (typeof prior?.blocks !== 'string' || prior.blocks === '') return null
  const held = heldQuestion(prior) ?? heldQuestion({ ...prior, relayed: prior?.pending_key ?? null })
  return held && held.since !== null ? [{ since: held.since, blocks: held.blocks }] : []
}

// The report that the operator answered in the orchestrator's own tab: a report, never an
// order, and nothing is to be sent back.
export function withdrawalText(name: string, blocks: string, since: string | null, said?: string): string {
  const words = said ? ` (he typed: "${said.replace(/\s*\n\s*/g, ' ')}")` : ''
  return `[module] ${name} withdraws its question for the operator since ${since ?? '?'} — blocks: ${blocks}\n`
    + `the operator answered it in ${name}'s own tab${words}: nothing to send back`
}

// A withdrawal as withdrawalText wrote it, read back by the coordinator's module: who withdraws,
// the wait's start (null for « ? »), what it blocks and the words the operator typed, when kept.
const WITHDRAWAL = /^\[module\] (.+?) withdraws its question for the operator since (\S+) — blocks: (.*)\nthe operator answered it in .*'s own tab(?: \(he typed: "(.*)"\))?: nothing to send back$/
export function parseWithdrawal(body: string): { name: string; since: string | null; blocks: string; said: string | null } | null {
  const matched = WITHDRAWAL.exec(body.trim())
  if (!matched) return null
  return { name: matched[1] ?? '', since: matched[2] === '?' ? null : matched[2] ?? null, blocks: matched[3] ?? '', said: matched[4] ?? null }
}

// An agent's measure crossing the gate its session runs under, the one line sent to its
// orchestrator once per crossing: the figures, never an instruction.
export function gateText(name: string, tokens: number, percent: number): string {
  return `[module] ${name} context ${tokens.toLocaleString('en-US')} (${percent}%) — at the gate`
}

// The same crossing said to the agent itself, in its own session, once per crossing: it cannot
// read its own figure, so the stand-down starts from this line, not from its brief alone.
export function gateSelfText(tokens: number, percent: number): string {
  return `[module] Your context is ${tokens.toLocaleString('en-US')} (${percent}%): you are at your context gate. `
    + 'Finish the unit in hand, then stop and give your orchestrator two lines: what is in flight, the decisions taken.'
}

// The deduplication key of an agent's turn that ended without its status line, kept in the
// wait file's `relayed` like a status line's fingerprint. It names the turn, never the kind:
// one turn handled twice is one key, and the turn after it is another, so a report written
// without its status line is never taken for the silent turn before it. The host's turn id
// is the identity; an event that carries none gets a key of its own time and text length, so
// it is sent rather than dropped.
export const NO_STATUS_KEY = 'no-status'

export function noStatusKey(turnId: unknown, text: string, now: number = Date.now()): string {
  return typeof turnId === 'string' && turnId !== '' ? `${NO_STATUS_KEY}:${turnId}` : `${NO_STATUS_KEY}:${now}-${text.length}`
}

// The one line sent to the orchestrator when an agent ends a turn without its status line:
// the figure when it is known, then the address the answer goes back to and the turn's last
// text, cut past the cap and said like a question is. Never an instruction.
export function noStatusText(name: string, context: string | null, text: string = ''): string {
  const header = `[module] ${name} ended a turn without its status line${context ? ` — context ${context}` : ''}`
  const said = text.trim()
  return said === '' ? header : `${header}\nreply with SendMessage to: ${name}\n\n${cutQuestion(said)}`
}

// ── A turn the host ended in its own words ───────────────────────────────────
// A usage limit, a spend limit or an API error ends the turn on a text the host writes itself
// (an assistant message whose model is `<synthetic>`, `isApiErrorMessage` on its transcript line):
// « You've hit your weekly limit · resets Nov 20 at 8pm (Europe/Paris) », « API Error: … ». The
// agent then sits idle until someone resumes it, background work or not, so its orchestrator is
// told once per stop, never left waiting on a reply that cannot come.
export type HostStop = { kind: 'limit' | 'error'; text: string }

// The host's limit and spend texts: « You've hit your session|weekly|<model>|monthly spend… limit »,
// « …team's shared budget », a credit balance too low.
const LIMIT_TEXT = /^(?:You['’]ve hit your\b|Credit balance is too low\b)/i
// The host's error texts: « API Error: … », and a session logged out of the API.
const ERROR_TEXT = /^(?:API Error\b|Please run \/login\b|Not logged in\b)/i

// The stop a turn's text is, read on its first line; null for any text the model wrote.
export function hostStopOf(text: string): HostStop | null {
  const first = (text.trim().split('\n')[0] ?? '').trim()
  if (LIMIT_TEXT.test(first)) return { kind: 'limit', text: first }
  if (ERROR_TEXT.test(first)) return { kind: 'error', text: first }
  return null
}

// The stop a transcript's tail ends on: its last message line (the user's or the assistant's, the
// host's system lines skipped) when the host wrote it — the model `<synthetic>` or an API error
// line — read by its text, an unknown error text said as an API error. Null when the turn ended on
// the model's own words, or a prompt came after.
export function stopInTail(tail: string): HostStop | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let line: unknown
    try {
      line = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    const fields = typeof line === 'object' && line !== null ? line as { type?: unknown; isApiErrorMessage?: unknown; message?: { model?: unknown; content?: unknown } } : {}
    if (fields.type === 'user') return null
    if (fields.type !== 'assistant') continue
    const content = fields.message?.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('') : ''
    const stop = hostStopOf(text)
    if (stop) return stop
    return fields.isApiErrorMessage === true && text.trim() !== '' ? { kind: 'error', text: text.trim().split('\n')[0] ?? '' } : null
  }
  return null
}

// The deduplication key of a stop, kept in the wait file's `relayed` like noStatusKey: the turn
// names it, so one stop handled twice is sent once and the next stop is sent again.
export function stopKey(turnId: unknown, stop: HostStop, now: number = Date.now()): string {
  return typeof turnId === 'string' && turnId !== '' ? `stop:${turnId}` : `stop:${now}-${stop.text.length}`
}

// The one line its orchestrator is sent: what stopped the agent, its reset when the host gave one,
// and the host's own words. Never an instruction: the rotation is the orchestrator's
// (references/rotation.md).
export function stopText(name: string, stop: HostStop): string {
  const words = shortLine(stop.text)
  const reset = /\bresets\s+(.+)$/i.exec(stop.text)?.[1]?.trim()
  const what = stop.kind === 'limit'
    ? `usage limit${reset ? ` (resets ${reset})` : ''}`
    : `API error — ${words.replace(/^API Error:?\s*/i, '')}`
  return `[module] ${name} stopped: ${what}${stop.kind === 'limit' ? ` — « ${words} »` : ''}`
}

const shortLine = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text)

// The orchestrator's tty an agent's tty belongs to: the launcher's chains, one file per
// orchestrator tty, each entry an agent's tty. A chain outlives its tab and a tty is
// recycled, so a chain counts only while its owner (the tty that names the file) is one
// `ownerLives` says carries a live orchestrator; of those naming this tty the one written
// last wins — the spawn that put this agent there appended to it. Without `ownerLives`
// every chain counts. Null when no chain counts.
export function chainOwnerTty(chains: readonly { name: string; mtimeMs: number; text: string }[], tty: string,
  ownerLives?: (ownerTty: string) => boolean): string | null {
  const named = chains.flatMap(c => {
    const owner = chainTtyOf(c.name)
    return owner !== undefined && parseChain(c.text).some(e => e.tty === tty) && (ownerLives === undefined || ownerLives(owner)) ? [{ owner, mtimeMs: c.mtimeMs }] : []
  })
  if (named.length === 0) return null
  return named.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).owner
}

// The coordinator's name out of its record (coordinator.sh's <state>/coordinator.json),
// the address SendMessage spells; null when there is no record or it names nobody.
export function coordinatorOf(recordText: string): string | null {
  try {
    const name = (JSON.parse(recordText) as { name?: unknown })?.name
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

// An instant as every surface shows it to the operator: the hour and minute of the machine's own
// time; `?` for none.
export function localMinute(iso: string | null): string {
  const at = new Date(String(iso ?? ''))
  if (!Number.isFinite(at.getTime())) return '?'
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

// The wait in its two parts, the one definition every surface reads: the status words, with
// their start in the machine's local time, and for a wait on the operator what it blocks
// (« unsaid » when the row carries none; null for a proposal to close). Null when the row
// waits on nothing.
export function waitParts(row: SessionRow): { status: string; blocks: string | null } | null {
  if (row.waiting !== 'operator' && row.waiting !== 'done') return null
  const minute = localMinute(row.waiting_since ?? null)
  const since = minute === '?' ? '' : ` since ${minute}`
  return row.waiting === 'done'
    ? { status: `done${since}, proposes to be closed`, blocks: null }
    : { status: `waiting for the operator${since}`, blocks: row.blocks ?? 'unsaid' }
}

// The wait as the pane and /orchestrator:status show it on one line; null when the row waits
// on nothing.
export function waitLabel(row: SessionRow): string | null {
  const parts = waitParts(row)
  if (parts === null) return null
  return parts.blocks === null ? parts.status : `${parts.status} — blocks: ${parts.blocks}`
}
