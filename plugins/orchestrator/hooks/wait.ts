// hooks/wait.ts
// The declared wait: `declare_wait({kind, blocks})`, the structured act by which a turn says
// what will wake it, read at the turn's end in place of the wording of its last line
// (docs/conventions.md, « Guards and consent »). A declaration belongs to the turn that made
// it: the next turn's start makes it stale, and a stale one is never read. One wait outlives its turn,
// through a turn opened by a wake the module said brings nothing new (`keepsThrough`), while nothing
// else reaches the session: the turn end's refusal (guards.ts) takes it for that turn's own (`keep`).
//
// An operator wait is refused while a row of the record is ready with nobody on it (unattended.ts, `readyRefusal`).
// The refusals of a done or deferred wait live in stop-gate.ts; the turn's end reads the declaration
// itself (supervision.ts). The model's own line decides nothing.
import {
  checkWakeDone, deferredRows, goalsPaths, isDegradedPass, isOwnRecord, openRows, orchestrationOf, ownerOf, parseGoalsCheck,
  recordsWithOpenRows, waitLine, withDeadline, type DeclaredWait, type GoalsReading,
} from './stop-gate.ts'
import { recordsRegistryPath, WAIT_KINDS, WAIT_TOOL, type WaitKind } from '../core/orchestration.ts'
import { fieldsOf, messageOf, type Host, type On } from './host.ts'
import { configDir, dataDir, logLine } from './module-io.ts'
import { recordedInstallPaths } from '../core/install-record.ts'
import { RETROSPECTIVE_CONTRACT, retrospectiveStartArgv } from '../core/learning.ts'
import { boundedReading, holdsDone, projectRecords, readyRefusal, waitingOnMerge } from './unattended.ts'
import { prKey, unattendedLine, type Unattended } from '../core/pr-ledger.ts'
import { holdsTodos, openFor, whoAmI } from './todo.ts'
import { todoName } from './todo-format.ts'
import { readAsked } from './question.ts'
import { PLUGIN } from './audit-events.ts'

// The nouns the declaration holds.
type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs' | 'clock' | 'settings'>

// Why an operator wait is refused with no question of the session's open.
export const ASK_FIRST = 'An operator wait waits on the questions this session asked with `ask`, and none is open: ask the question first with `ask`, then declare the wait. If you ask him nothing, declare another kind.'

// Whether blocks names a pull request, as `owner/name#n` or `name#n`, not followed by another digit.
const namesPr = (blocks: string, u: Unattended): boolean =>
  [prKey(u.repo, u.pr), `${u.repo.slice(u.repo.indexOf('/') + 1)}#${u.pr}`].some(ref => new RegExp(`(?<![\\w./-])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'i').test(blocks))

// What `blocks` may hold: one line, short enough to be a reason and not a report.
export const BLOCKS_MAX = 300

const KIND_NEEDS: Record<WaitKind, string> = {
  operator: 'what the questions asked with `ask` block',
  done: '',
  deferred: 'the deferred items: their count (« 3 items ») or their ids',
}

// The tool's input, validated: the declaration, or why it is none. `asked` holds the session's own
// open questions asked with `ask` (question.ts): an operator wait waits on them, its blocks theirs
// when it names none, and is refused with none open, unless pull requests of the record wait on his merge
// (`merging`): the wait then names them, in blocks or, when it names none, by itself.
export function parseDeclaration(input: unknown, asked: readonly { id: string; blocks: string }[] = [], merging: readonly Unattended[] = []): { wait: DeclaredWait } | { error: string } {
  const e = (input ?? {}) as { kind?: unknown; blocks?: unknown; urgent?: unknown }
  if (typeof e.kind !== 'string' || !(WAIT_KINDS as readonly string[]).includes(e.kind)) {
    return { error: `kind is one of ${WAIT_KINDS.join(', ')}` }
  }
  const kind = e.kind as WaitKind
  if (e.blocks !== undefined && typeof e.blocks !== 'string') return { error: 'blocks is a string' }
  if (e.urgent !== undefined && typeof e.urgent !== 'boolean') return { error: 'urgent is true or false' }
  if (e.urgent === true && kind !== 'operator') return { error: 'only an operator wait is urgent' }
  if (kind === 'operator' && asked.length === 0 && merging.length === 0) return { error: ASK_FIRST }
  const named = String(e.blocks ?? '').replace(/\s+/g, ' ').trim()
  // With no question of the session's open, an operator wait waits on the pull requests that wait on his merge: it names every one, or none and says them itself.
  const unnamed = named === '' ? [] : merging.filter(u => !namesPr(named, u))
  if (kind === 'operator' && asked.length === 0 && unnamed.length > 0) {
    return { error: `An operator wait with no question of yours open names in blocks every pull request waiting on his merge: ${unattendedLine(unnamed, []) ?? ''}` }
  }
  const standing = kind === 'operator' && asked.length === 0 && named === '' ? (unattendedLine(merging, []) ?? '').slice(0, BLOCKS_MAX) : ''
  const blocks = named === '' && kind === 'operator' ? standing || asked.map(question => question.blocks).join('; ').slice(0, BLOCKS_MAX) : named
  if (kind === 'done') return { wait: { kind, blocks: '' } }
  if (blocks === '') return { error: `a ${kind} wait names in blocks ${KIND_NEEDS[kind]}` }
  if (blocks.length > BLOCKS_MAX) return { error: `blocks holds at most ${BLOCKS_MAX} characters` }
  if (kind !== 'operator') return { wait: { kind, blocks } }
  return { wait: { kind, blocks, ...(e.urgent === true ? { urgent: true as const } : {}), asked: asked.map(question => question.id) } }
}

// The declarations of one session, by turn: a declaration is current only in the turn that
// made it. Pure over its own memory, so the gate's tests drive it turn by turn.
export class Declarations {
  private turn = 0
  private declared: { wait: DeclaredWait; turn: number } | null = null
  private handed: string | null = null
  private last: DeclaredWait | null = null
  // The text of a wake that brings nothing new, from its submit to the turn it opens.
  private wake: string | null = null
  // The words the declared wait was first reported with.
  private words: string | null = null
  // The turn that took the standing wait for its own.
  private keptTurn: number | null = null

  // `prompt`: the text the turn opens with, the host's frame around a module's own. Any turn but
  // that of the awaited wake brings something new, a prompt queued behind an earlier turn among them.
  turnStarted(prompt = ''): void {
    this.turn += 1
    if (this.wake !== null && prompt.includes(this.wake)) this.wake = null
    else this.last = null
  }

  declare(wait: DeclaredWait): void {
    this.declared = { wait, turn: this.turn }
    this.last = wait
    this.words = null
  }

  // A wake that brings the session nothing new is about to be submitted: the turn it opens keeps the last wait.
  keepsThrough(wake: string): void {
    this.wake = wake
  }

  // Something the module did not submit reached the session: the last wait stands no longer.
  heard(): void {
    this.last = null
  }

  // The last wait declared, while the turns since brought nothing new.
  standing(): DeclaredWait | null {
    return this.last
  }

  // The standing wait taken for the current turn's own: its end reports it again.
  keep(): void {
    if (this.last === null) return
    this.declared = { wait: this.last, turn: this.turn }
    this.keptTurn = this.turn
  }

  // The words a turn's end reports its wait with: a kept wait's are those it was first reported
  // with, so a closing proposal entered again is the same proposal. `answer`: the turn's own.
  reportedWith(answer: string): string {
    if (this.keptTurn === this.turn && this.words !== null) return this.words
    if (this.current() !== null) this.words = answer
    return answer
  }

  // The session that handed over (it spawned its successor): not a turn's
  // fact, it holds for the session's later turns.
  handOver(sessionId: string): void {
    this.handed = sessionId
  }

  handedOver(sessionId: string): boolean {
    return sessionId !== '' && this.handed === sessionId
  }

  // The current turn's declaration, or null: none made, or made in an earlier turn.
  current(): DeclaredWait | null {
    return this.declared !== null && this.declared.turn === this.turn ? this.declared.wait : null
  }
}

// The declarations of this session's main thread, which the turn's end reads too (question.ts).
export const DECLARATIONS = new Declarations()

// The session's own open questions asked with `ask`, in the order asked; none when they cannot be read.
async function openAsked($: Held): Promise<{ id: string; blocks: string }[]> {
  try {
    const session = await $.session.id()
    return (await readAsked($)).filter(entry => entry.status === 'open' && entry.sender.session === session)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map(entry => ({ id: entry.id, blocks: entry.blocks }))
  } catch (err) {
    await logLine($, 'wait', `the questions asked here not read: ${messageOf(err)}`)
    return []
  }
}

// The bound on the declaration's reads of the dispatch record and its goals: one tool call, never a held turn.
export const RECORD_READ_MS = 5000

// What a done or a deferred wait is declared with instead when the session waits on its own work.
export const DECLARE_NOTHING = ' If you are waiting on an agent, a command or a monitor you started, declare nothing: '
  + 'it wakes you by itself when it ends or answers.'

// What the orchestrator's dispatch record and the goals beside it still hold against a done or a
// deferred wait (checkWakeDone): an open row or goal refuses a done; a deferred wait takes only rows,
// goals and to-dos the operator put off (dispatch-record.sh defer, goals … defer, todo defer),
// counted as its blocks says, and is refused when he put off none. Read at the declaration, the one
// place they are read: a done declared while an agent ran once went through with its rows open. Only
// an orchestrator's records are read, its own (the owner file); a read that fails or runs out of time
// holds nothing, said in the log.
export async function holdsRecord($: Held, wait: DeclaredWait): Promise<string | null> {
  if (wait.kind !== 'done' && wait.kind !== 'deferred') return null
  const me = await whoAmI($)
  if (me === null || me.role !== 'orchestrator') return null
  const until = Date.now() + RECORD_READ_MS
  const read = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    const left = until - Date.now()
    if (left <= 0) return fallback
    try {
      const done = await withDeadline(work(), left)
      return isDegradedPass(done) ? fallback : done
    } catch {
      return fallback
    }
  }
  const state = await dataDir($)
  const own = orchestrationOf(me.name)
  // The orchestration's records, not the session's registry alone: a successor that never read or wrote its record
  // registered none, and declared done with 5 rows open in its predecessors' record (the operator's report of 2026-11-18).
  const sessionId = await $.session.id()
  // The session's own register first, on its own read: a scan of the others that runs out of time keeps it.
  const mine = String(await read(() => $.fs.read(recordsRegistryPath(state, sessionId)), '')).split('\n').map(line => line.trim()).filter(Boolean)
  const scanned = await read<string[] | null>(() => projectRecords($, state, sessionId, own), null)
  if (scanned === null) await logLine($, 'wait', 'the records of the orchestration unread at the declaration: its own register alone is read')
  const registered = scanned ?? mine
  const records: string[] = []
  for (const path of registered) {
    if (isOwnRecord(ownerOf(String(await read(() => $.fs.read(`${path}.owner`), ''))), own)) records.push(path)
  }
  const texts: string[] = []
  for (const path of records) texts.push(String(await read(() => $.fs.read(path), '')))
  const goals: GoalsReading[] = []
  for (const path of goalsPaths(records)) {
    if (await read(() => $.fs.exists(path), false) !== true) continue
    const done = await read(() => $.process.run(['bash', `${$.plugin.root}/skills/orchestrator/scripts/goals.sh`, 'check', path, '--json'], { timeoutMs: Math.max(1, until - Date.now()) }), null)
    const reading = done && (done.exitCode === 0 || done.exitCode === 1) ? parseGoalsCheck(path, String(done.stdout ?? '')) : null
    if (reading) goals.push(reading)
    else await logLine($, 'wait', `goals unread at the declaration: ${path}`)
  }
  const owed = await read(() => openFor($, me.name), { pending: [], deferred: [] })
  const held = checkWakeDone({
    deferred: openRows(texts),
    deferredRows: deferredRows(texts),
    goalsOpen: goals.flatMap(g => g.open),
    goalsDeferred: goals.flatMap(g => g.deferred),
    goalsFaults: goals.flatMap(g => g.faults),
    todosDeferred: owed.deferred.map(todoName),
    rowRecords: recordsWithOpenRows(records, texts),
    goalsRecords: goals.filter(g => g.open.length > 0).map(g => g.path),
    ending: wait.kind,
    ids: wait.kind === 'deferred' ? wait.blocks : undefined,
  })
  return held === null ? null : `${held.reason}${DECLARE_NOTHING}`
}

const LEARNING = 'learning@lounisbou'
export const RETROSPECTIVE_TIMEOUT_MS = 30_000

const lastLine = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? ''

// The orchestrator's last goal met (a `done` wait at its turn's end) is a boundary where the learning
// plugin's retrospective may start (docs/specs/learning-design.md, section 2): this runs the one
// command the learning plugin answers, which decides by itself whether enough candidates wait and
// starts another session. Nothing runs where the learning plugin is not enabled. An observation: it
// never throws, and says what it did in one line of the module's log.
export async function startRetrospective($: Held): Promise<void> {
  try {
    if (fieldsOf(fieldsOf(await $.settings.read())?.['enabledPlugins'])?.[LEARNING] !== true) return
    const config = await configDir($)
    const recorded = recordedInstallPaths(await $.fs.read(`${config}/plugins/installed_plugins.json`), 'learning', ['lounisbou'])
    for (const root of 'problem' in recorded ? [] : recorded.paths) {
      if (!(await $.fs.exists(`${root}/${RETROSPECTIVE_CONTRACT.script}`))) continue
      const run = await $.process.run(retrospectiveStartArgv(root, config), { timeoutMs: RETROSPECTIVE_TIMEOUT_MS })
      await logLine($, 'wait', lastLine(run.stdout) || lastLine(run.stderr) || `the learning retrospective's start exited ${run.exitCode}`)
      return
    }
  } catch (err) {
    await logLine($, 'wait', `the learning retrospective was not started: ${messageOf(err)}`)
  }
}

// Mounted before the supervision: a chain answers in registration order, so the turn's end reads
// the answer this module hands on.
export function register(on: On<Held>, declarations: Declarations = DECLARATIONS): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: WAIT_TOOL,
        isDeferred: false,
        description: 'Declares what will wake this session once its turn ends, before ending the turn: '
          + '`operator` (a question the operator must answer; blocks: what it blocks; urgent: true to have it presented at once), '
          + '`done` (every goal met or ruled out), `deferred` (only work the operator deferred is left; blocks: « <n> items »). '
          + 'A command, monitor, subagent or agent you started wakes you by itself: declare nothing for it. '
          + 'An `operator` wait waits on the questions this session asked with `ask`.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...WAIT_KINDS] },
            blocks: { type: 'string', maxLength: BLOCKS_MAX },
            urgent: { type: 'boolean' },
          },
          required: ['kind'],
        },
      })
    } catch (err) {
      // A start never fails on the tool: the last line still declares the wait.
      await logLine($, 'wait', `${WAIT_TOOL} not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId === undefined) declarations.turnStarted(String(fieldsOf(e)?.['text'] ?? ''))
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // What is new to the session ends its standing wait: a prompt the module did not submit (the
  // operator's, a peer's, a notification, another plugin's), or a delivery its model will read.
  on('prompt.submit', {}, async ($, e, next) => {
    if (e.agentId === undefined && !(e.origin?.kind === 'plugin' && fieldsOf(e.origin)?.['name'] === PLUGIN)) declarations.heard()
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('session.receive', {}, async ($, e, next) => {
    const out = await next(e)
    // A line the module consumes reaches no model.
    if (e.agentId === undefined && !fieldsOf(out)?.['consumed']) declarations.heard()
    return out
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }, async ($, e) => {
    // A subagent's turn is not the session's: its end wakes the session, not a wait of its own.
    if (e.agentId) return { result: `${WAIT_TOOL} is the main session's: a subagent ends its turn by answering.`, isError: true }
    const asked = await openAsked($)
    const handedOver = declarations.handedOver(await $.session.id())
    // An operator wait reads the record once: the pull requests that wait on his merge, which it may wait on with no question of
    // its own open, and the rows ready with nobody on them, which it never parks.
    const reading = e['kind'] === 'operator' ? await boundedReading($, await $.session.id()) : null
    const merging = asked.length === 0 ? waitingOnMerge(reading?.list ?? []) : []
    // The rows are the successor's once the session handed over, as the pull requests are. Said before the declaration's own
    // faults: the work to start is what the wait is refused for first.
    const ready = handedOver ? null : readyRefusal(reading)
    if (ready !== null) return { result: ready, isError: true }
    const parsed = parseDeclaration(e, asked, merging)
    if ('error' in parsed) return { result: parsed.error, isError: true }
    // A done or a deferred wait is held while a pull request is unattended (unattended.ts).
    // The pull requests are the successor's once the session handed over: it is not held on them.
    const held = handedOver ? null : await holdsDone($, parsed.wait)
    if (held !== null) return { result: held, isError: true }
    // So is one while a to-do of the session's own list is open (todo.ts).
    const owed = await holdsTodos($, parsed.wait)
    if (owed !== null) return { result: owed, isError: true }
    // And one the dispatch record contradicts: an open row or goal, or a deferral he never made.
    const left = handedOver ? null : await holdsRecord($, parsed.wait)
    if (left !== null) return { result: left, isError: true }
    declarations.declare(parsed.wait)
    return { result: `Wait declared: ${waitLine(parsed.wait)}. End the turn now.` }
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: `the wait could not be declared; the module's log says why`, isError: true }
  })

  on('turn.complete', {}, async ($, e, next) => {
    const wait = e.agentId === undefined ? declarations.current() : null
    const result = await next(e)
    if (wait?.kind === 'done') await startRetrospective($)
    return result
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
