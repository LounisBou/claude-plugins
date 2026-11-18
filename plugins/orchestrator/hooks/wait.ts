// hooks/wait.ts
// The declared wait: `declare_wait({kind, blocks})`, the structured act by which a turn says
// what will wake it, read by the stop gate in place of the wording of the turn's last line
// (docs/conventions.md, « Guards and consent »). A declaration belongs to the turn that made
// it: the next turn's start makes it stale, and a stale one is never read.
//
// The gate's decisions live in stop-gate.ts and its handler in guards.ts, which reads the
// declaration itself, as the turn's end does (supervision.ts). The model's own line decides nothing.
import {
  checkWakeDone, deferredRows, goalsPaths, isDegradedPass, isOwnRecord, openRows, orchestrationOf, ownerOf, parseGoalsCheck,
  recordsWithOpenRows, waitLine, withDeadline, type DeclaredWait, type GoalsReading,
} from './stop-gate.ts'
import { RECORDS_DIR, WAIT_KINDS, WAIT_TOOL, type WaitKind } from '../core/orchestration.ts'
import { CONSENT_KINDS, DEPLOY_ENVS, parseConsentSubject } from '../core/consent-record.ts'
import { fieldsOf, messageOf, type Host, type On } from './host.ts'
import { configDir, logLine, stateDir } from './module-io.ts'
import { recordedInstallPaths } from '../core/install-record.ts'
import { RETROSPECTIVE_CONTRACT, retrospectiveStartArgv } from '../core/learning.ts'
import { holdsDone, mergeWaits } from './unattended.ts'
import { prKey, unattendedLine, type Unattended } from '../core/pr-ledger.ts'
import { holdsTodos, openFor, whoAmI } from './todo.ts'
import { todoName } from './todo-format.ts'
import { readAsked } from './question.ts'

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
  const e = (input ?? {}) as { kind?: unknown; blocks?: unknown; urgent?: unknown; consent_kind?: unknown; consent_repo?: unknown; consent_pr?: unknown; consent_env?: unknown }
  if (typeof e.kind !== 'string' || !(WAIT_KINDS as readonly string[]).includes(e.kind)) {
    return { error: `kind is one of ${WAIT_KINDS.join(', ')}` }
  }
  const kind = e.kind as WaitKind
  if (e.blocks !== undefined && typeof e.blocks !== 'string') return { error: 'blocks is a string' }
  if (e.urgent !== undefined && typeof e.urgent !== 'boolean') return { error: 'urgent is true or false' }
  if (e.urgent === true && kind !== 'operator') return { error: 'only an operator wait is urgent' }
  const given = Object.fromEntries([['kind', e.consent_kind], ['repo', e.consent_repo], ['pr', e.consent_pr], ['env', e.consent_env]].filter(([, value]) => value !== undefined))
  const asksConsent = Object.keys(given).length > 0
  const consent = asksConsent ? parseConsentSubject(given) : undefined
  if (asksConsent && kind !== 'operator') return { error: 'only an operator question asks consent' }
  if (asksConsent && consent === undefined) {
    return { error: `consent is consent_kind with consent_repo (owner/name): "e2e-waiver" or "norms-waiver" with consent_pr, "e2e-exemption" or "auto-merge" alone, "auto-deploy" with consent_env (${DEPLOY_ENVS.join(', ')})` }
  }
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
  return { wait: { kind, blocks, ...(e.urgent === true ? { urgent: true as const } : {}), ...(consent ? { consent } : {}), asked: asked.map(question => question.id) } }
}

// The declarations of one session, by turn: a declaration is current only in the turn that
// made it. Pure over its own memory, so the gate's tests drive it turn by turn.
export class Declarations {
  private turn = 0
  private declared: { wait: DeclaredWait; turn: number } | null = null
  private handed: string | null = null

  turnStarted(): void {
    this.turn += 1
  }

  declare(wait: DeclaredWait): void {
    this.declared = { wait, turn: this.turn }
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
// deferred wait, read as the stop gate reads them at the stop (checkWakeDone): an open row or goal
// refuses a done; a deferred wait takes only rows, goals and to-dos the operator put off
// (dispatch-record.sh defer, goals … defer, todo defer), counted as its blocks says, and is refused
// when he put off none. Read at the declaration too, because the gate reads them only when nothing
// else wakes the session: a done declared while an agent ran went through with its rows open. Only an
// orchestrator's records are read, its own (the owner file); a read that fails or runs out of time
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
  const state = await stateDir($)
  const safe = (await $.session.id()).replace(/[^A-Za-z0-9._-]/g, '_')
  const registered = String(await read(() => $.fs.read(`${state}/${RECORDS_DIR}/${safe}`), '')).split('\n').map(line => line.trim()).filter(Boolean)
  const own = orchestrationOf(me.name)
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
    agents: [], checkouts: [],
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
          + 'An operator question that asks his consent to waive E2E or norms on a pull request, to exempt a repository from E2E, to put it in or out of auto-merge, or of auto-deploy in one environment, '
          + 'names it in consent_kind and consent_repo: "e2e-waiver" or "norms-waiver" with consent_pr, "e2e-exemption" or "auto-merge" alone, "auto-deploy" with consent_env. '
          + 'An `operator` wait waits on the questions this session asked with `ask`. '
          + 'The stop gate reads the declaration in place of your last line.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...WAIT_KINDS] },
            blocks: { type: 'string', maxLength: BLOCKS_MAX },
            urgent: { type: 'boolean' },
            consent_kind: { type: 'string', enum: [...CONSENT_KINDS] },
            consent_repo: { type: 'string' },
            consent_pr: { type: 'integer' },
            consent_env: { type: 'string', enum: [...DEPLOY_ENVS] },
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
    if (e.agentId === undefined) declarations.turnStarted()
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'wait', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }, async ($, e) => {
    // A subagent's turn is not the session's: its end wakes the session, not a wait of its own.
    if (e.agentId) return { result: `${WAIT_TOOL} is the main session's: a subagent ends its turn by answering.`, isError: true }
    const asked = await openAsked($)
    // With no question of its own open, an operator wait may wait on the pull requests that wait on his merge.
    const merging = e['kind'] === 'operator' && asked.length === 0 ? await mergeWaits($) : []
    const parsed = parseDeclaration(e, asked, merging)
    if ('error' in parsed) return { result: parsed.error, isError: true }
    // A done or a deferred wait is held while a pull request is unattended (unattended.ts).
    // The pull requests are the successor's once the session handed over: it is not held on them.
    const held = declarations.handedOver(await $.session.id()) ? null : await holdsDone($, parsed.wait)
    if (held !== null) return { result: held, isError: true }
    // So is one while a to-do of the session's own list is open (todo.ts).
    const owed = await holdsTodos($, parsed.wait)
    if (owed !== null) return { result: owed, isError: true }
    // And one the dispatch record contradicts: an open row or goal, or a deferral he never made.
    const left = declarations.handedOver(await $.session.id()) ? null : await holdsRecord($, parsed.wait)
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
