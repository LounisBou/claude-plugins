// hooks/todo.ts
// The `todo` tool: what the operator asks of a session that will not be done within the turn, or that
// is for another session, recorded in the holder's own list (todo-format.ts, docs/contracts.md). No item
// is left aside: each names who takes it (a dispatch row, an agent) or what it waits on, why, until when
// and its deadline, and the module surfaces it to its holder when either date passes (registerSurface).
// The model judges that a request is one and records it; code keeps the list, under the store's lock, and
// holds the session's « done » while an item is open (the declared wait, the stop gate, the
// coordinator's end). A request for another session is written into that session's list first, then
// sent, in one call: no relay goes out unrecorded. A session on another machine is only sent the
// message, and told so.
import { updateOver } from '../core/store-io.ts'
import {
  addTodo, closeTodo, deferTodo, deferredTodos, dueTodos, holderOf, openTodos, parseOwner, parseWait, pendingTodos, rowTodo, surfaceTodos, todoFile, todoImagesLine, todoItems, todoName, todoPath,
  isImageList, waitTodo, TODO_CONTRACT, TODO_IMAGES_MAX, type DueTodo, type TodoItem,
} from './todo-format.ts'
import { todoOpen, type DeclaredWait } from './stop-gate.ts'
import { coordinatorAddress, parseSessionRow, sessionKey, sessionRole, storeOf, walkedName } from './supervision.ts'
import { roleOf } from './session-name.ts'
import { parseRemoteRow, ROW_MARKER } from './remote-row.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { messageOf, type Host, type On, type Timer } from './host.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs' | 'clock'>
type Surfacing = Held & Host<'prompt'>

export const TODO_TOOL = 'todo'

// The sessions that keep a list: the ones that take the operator's word and hold no code of their own.
const KEEPERS: readonly string[] = ['orchestrator', 'coordinator', 'auditor']

const ACTIONS = ['add', 'row', 'wait', 'done', 'drop', 'defer', 'list'] as const
type Answer = { result: string; isError?: true }

const refuse = (result: string): Answer => ({ result, isError: true })

// The sessions whose own walk found no keeper's name, by session id and the instant of the walk: a
// session that is none (an operator's, an agent's with no row yet) is not walked again at every call.
const UNNAMED_FOR_MS = 60_000
const unnamed = new Map<string, number>()

// The session itself: its name and role, from the row the module keeps for it, else from its own
// walk. The row is written when a turn ends (session.measure), so a session in its first turn has
// none, a woken orchestrator's first turn included, and a row written while the walk did not finish
// carries no name: the name the host already holds for the session (its record, its launch title)
// answers then. A row that names a role other than a keeper's is an agent's: no walk. Null when the
// name is not known or the session keeps no list.
export async function whoAmI($: Held): Promise<{ name: string; role: string } | null> {
  const sessionId = await $.session.id()
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(sessionId)}`).catch(() => '')))
  if (row?.name && row.role) return KEEPERS.includes(row.role) ? { name: row.name, role: row.role } : null
  const seen = unnamed.get(sessionId)
  if (seen !== undefined && Date.now() - seen < UNNAMED_FOR_MS) return null
  let walked: { known: boolean; name: string | null }
  try {
    walked = await walkedName($, sessionId)
  } catch (err) {
    await logLine($, 'todo', `own name not walked: ${messageOf(err)}`)
    return null
  }
  if (!walked.known) {
    await logLine($, 'todo', 'own name not walked: the walk did not finish, so the name stays unknown')
    return null
  }
  const role = roleOf(walked.name)
  if (walked.name && role && KEEPERS.includes(role)) return { name: walked.name, role }
  unnamed.set(sessionId, Date.now())
  return null
}

/** The items a holder's list keeps, open or closed; none when there is no list. */
export async function readTodos($: Held, name: string): Promise<TodoItem[]> {
  return todoItems(String(await $.fs.read(todoPath(await stateDir($), name)).catch(() => '')))
}

// One change of a holder's list, under the store's lock: the item it made, or why it made none. An
// absent list (ENOENT) starts empty; a list that cannot be read for any other reason is changed in
// nothing, since the write that follows would replace what the operator's requests were recorded in.
// The store's own read answers undefined for both, so the read is made here, beside it.
async function writeTodos($: Held, name: string, change: (text: string) => { text: string; item: TodoItem } | { error: string }): Promise<{ item: TodoItem } | { error: string }> {
  let made: { item: TodoItem } | { error: string } = { error: 'nothing was written' }
  let unreadable: string | null = null
  const io = {
    ...storeIo($),
    read: (path: string) => $.fs.read(path).then(text => String(text), err => {
      if (!/ENOENT|no such/i.test(messageOf(err))) unreadable = messageOf(err)
      return undefined
    }),
  }
  const path = todoPath(await stateDir($), name)
  await updateOver(io, path, current => {
    if (unreadable !== null) {
      made = { error: `the list of ${holderOf(name)} could not be read (${unreadable}); nothing was written, so no request of his is lost.` }
      return undefined
    }
    const next = change(current ?? '')
    made = 'error' in next ? next : { item: next.item }
    return 'error' in next ? undefined : next.text
  })
  if (unreadable !== null) await logLine($, 'todo', `list of ${holderOf(name)} not read, left as it is: ${unreadable}`)
  return made
}

const waitLine = (item: TodoItem): string => item.waits === undefined ? ''
  : `, waits on ${item.waits.on} (${item.waits.why}) until ${item.waits.until}, deadline ${item.waits.deadline}`

const shown = (item: TodoItem): string => {
  const images = todoImagesLine(item)
  return `${todoName(item)}: « ${item.words} » (said ${item.said_at}, by ${item.from})${item.rows ? `, rows ${item.rows.join(', ')}` : ''}${item.agent ? `, taken by ${item.agent}` : ''}`
    + `${waitLine(item)}${item.deferred ? `, put off: ${item.deferred}` : ''}${images ? `, ${images}` : ''}`
}

// Whether a session is on another machine: an orchestrator's row sent here, or the coordinator whose
// address a peer taught this machine. A session with a row on this machine is local whatever else is said.
async function onAnotherMachine($: Held, to: string): Promise<boolean> {
  const holder = holderOf(to)
  const store = await storeOf($)
  for (const dir of ['sessions', 'remote']) {
    const entries = await $.fs.list(`${store}/${dir}`).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
      const text = String(await $.fs.read(`${store}/${dir}/${entry.name}`).catch(() => ''))
      const name = dir === 'sessions' ? parseSessionRow(text)?.name : parseRemoteRow(`${ROW_MARKER}${text}`)?.name
      if (name && holderOf(name) === holder) return dir === 'remote'
    }
  }
  const coordinator = await coordinatorAddress($)
  return coordinator !== null && !coordinator.local && holderOf(coordinator.name) === holder
}

// The message a recorded request travels as: his words, when he said them, who carried them, the item's number.
function messageOfRequest(item: TodoItem | null, set: { words: string; said_at: string; from: string; images?: readonly string[] }, now: Date): string {
  const head = item === null ? 'A request of the operator, for you' : `To-do ${item.id}, recorded in your list`
  const images = todoImagesLine(set)
  return `${head}, carried by ${set.from} at ${now.toISOString().slice(0, 19)}Z: « ${set.words} » (he said it at ${set.said_at}).${images ? ` His ${images}.` : ''}`
    + (item === null ? '' : ` Read your list with todo list; close it with todo done ${item.id} and its outcome.`)
}

async function add($: Held, me: { name: string }, e: Record<string, unknown>, now: Date): Promise<Answer> {
  const words = typeof e['words'] === 'string' ? e['words'].trim() : ''
  if (words === '') return refuse('add records his words: pass them as given in `words`.')
  if (e['said_at'] !== undefined && (typeof e['said_at'] !== 'string' || e['said_at'].trim() === '')) return refuse('said_at is when he said it, as a date.')
  if (e['label'] !== undefined && typeof e['label'] !== 'string') return refuse('label is a string.')
  if (e['to'] !== undefined && (typeof e['to'] !== 'string' || e['to'].trim() === '')) return refuse('to names the session the request is for.')
  const images = e['images']
  if (images !== undefined && !isImageList(images)) return refuse(`images lists the absolute paths of the images he gave, at most ${TODO_IMAGES_MAX}.`)
  const from = holderOf(me.name)
  const to = typeof e['to'] === 'string' ? e['to'].trim() : null
  const owned = parseOwner(e, to ?? me.name)
  if ('error' in owned) return refuse(owned.error)
  const set = {
    words, said_at: typeof e['said_at'] === 'string' ? e['said_at'].trim() : `${now.toISOString().slice(0, 19)}Z`, from,
    ...(typeof e['label'] === 'string' ? { label: e['label'] } : {}), ...(images !== undefined && images.length > 0 ? { images } : {}),
    owner: owned.owner,
  }
  if (to === null || holderOf(to) === from) {
    const made = await writeTodos($, me.name, text => addTodo(text, set, now))
    return 'error' in made ? refuse(made.error) : { result: `Recorded as to-do ${made.item.id} in your list.` }
  }
  if (await onAnotherMachine($, to)) {
    const sent = await $.session.send({ to, text: messageOfRequest(null, set, now) })
    return sent.isDelivered ? { result: `Sent to ${to}; not recorded there: it runs on another machine, so no list of its own was written.` }
      : refuse(`Not sent to ${to} (${sent.reason}); not recorded there: it runs on another machine.`)
  }
  // The list first, the message after: a send that fails leaves the item written.
  const made = await writeTodos($, to, text => addTodo(text, set, now))
  if ('error' in made) return refuse(made.error)
  // A send that throws is a send that failed: the item is written, and the model must be told so, or it retries and duplicates it.
  let sent: Awaited<ReturnType<Held['session']['send']>>
  try {
    sent = await $.session.send({ to, text: messageOfRequest(made.item, set, now) })
  } catch (err) {
    await logLine($, 'todo', `to-do ${made.item.id} recorded for ${holderOf(to)}, the send threw: ${messageOf(err)}`)
    return refuse(`Recorded as to-do ${made.item.id} in the list of ${holderOf(to)}; the send failed: ${messageOf(err)}`)
  }
  if (sent.isDelivered) return { result: `Recorded as to-do ${made.item.id} in the list of ${holderOf(to)}, and sent.` }
  return refuse(`Recorded as to-do ${made.item.id} in the list of ${holderOf(to)}, but not sent: ${sent.reason}. The next session of that name reads the list; send it the words again if it must know now.`)
}

async function closing($: Held, me: { name: string }, action: 'row' | 'wait' | 'done' | 'drop' | 'defer', e: Record<string, unknown>, now: Date): Promise<Answer> {
  const id = e['id']
  if (typeof id !== 'number' || !Number.isInteger(id)) return refuse(`${action} names the to-do by its \`id\`, a number.`)
  if (action === 'wait') {
    const wait = parseWait(e)
    if ('error' in wait) return refuse(wait.error)
    if (wait.waits === undefined) return refuse('wait names what it waits on anew: waits_on, why, until and deadline.')
    const waits = wait.waits
    const made = await writeTodos($, me.name, text => waitTodo(text, id, waits))
    return 'error' in made ? refuse(made.error) : { result: `To-do ${id} waits on ${waits.on} until ${waits.until}, deadline ${waits.deadline}.` }
  }
  if (action === 'row') {
    const row = e['row']
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 1) return refuse('row names in `row` the dispatch row the to-do turned into, a positive integer.')
    const made = await writeTodos($, me.name, text => rowTodo(text, id, row))
    return 'error' in made ? refuse(made.error) : { result: `To-do ${id} names rows ${made.item.rows?.join(', ')}; their state is the record's.` }
  }
  const said = (field: 'outcome' | 'words'): string => (typeof e[field] === 'string' ? e[field].trim() : '')
  if (action === 'done' && said('outcome') === '') return refuse('done names in `outcome` the proof: a pull request, a file, or « row 170 ».')
  if (action === 'drop' && said('words') === '') return refuse('drop passes in `words` his own words that drop it, dated: it is closed without being done.')
  if (action === 'defer' && said('words') === '') return refuse('defer passes in `words` his ruling that puts it off, dated.')
  const made = await writeTodos($, me.name, text => {
    if (action === 'done') return closeTodo(text, id, said('outcome'), now)
    if (action === 'drop') return closeTodo(text, id, `dropped: ${said('words')}`, now)
    return deferTodo(text, id, said('words'))
  })
  if ('error' in made) return refuse(made.error)
  return { result: action === 'defer' ? `To-do ${id} put off; it stays open.` : `To-do ${id} closed.` }
}

/** What the tool answers to one call; `now` is the instant it records. */
export async function callTodo($: Held, e: Record<string, unknown>, now: Date = new Date()): Promise<Answer> {
  if (e['agentId']) return refuse("only the session's main thread keeps a to-do list.")
  const action = ACTIONS.find(known => known === e['action'])
  if (action === undefined) return refuse(`action is one of ${ACTIONS.join(', ')}.`)
  const me = await whoAmI($)
  if (me === null) return refuse("Only an orchestrator, a coordinator or an auditor keeps a to-do list, once the host names it.")
  if (action === 'add') return add($, me, e, now)
  if (action === 'list') {
    const open = openTodos(await readTodos($, me.name))
    return { result: open.length === 0 ? 'no open to-do.' : [`${open.length} open to-do:`, ...open.map(shown)].join('\n') }
  }
  return closing($, me, action, e, now)
}

/** The count of open items in each list, by the list's file name (todo-format.ts's todoFile of the holder). */
export async function todoCounts($: Held): Promise<Map<string, number>> {
  const dir = `${await stateDir($)}/${TODO_CONTRACT.dir}`
  const counts = new Map<string, number>()
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith(TODO_CONTRACT.suffix) || entry.name.includes('.tmp-')) continue
    const open = openTodos(todoItems(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))))
    if (open.length > 0) counts.set(entry.name, open.length)
  }
  return counts
}

/** The open items of a holder, split: the ones he did not put off, and the ones he did. */
export async function openFor($: Held, name: string): Promise<{ pending: TodoItem[]; deferred: TodoItem[] }> {
  const items = await readTodos($, name)
  return { pending: pendingTodos(items), deferred: deferredTodos(items) }
}

// What the declared wait asks before it takes a done or a deferred: the refusal while an item is open
// that the kind cannot take (a done takes none; a deferred takes only those he put off), else null.
export async function holdsTodos($: Held, wait: DeclaredWait): Promise<string | null> {
  if (wait.kind !== 'done' && wait.kind !== 'deferred') return null
  const me = await whoAmI($)
  if (me === null) return null
  const { pending, deferred } = await openFor($, me.name)
  const left = wait.kind === 'done' ? [...pending, ...deferred] : pending
  return left.length === 0 ? null : todoRefusal(left, wait.kind)
}

/** The refusal that names the open items and what to do with each. */
export const todoRefusal = (left: readonly TodoItem[], kind: 'done' | 'deferred'): string => todoOpen(left.map(todoName), kind)

// The role of the session at its start, null when it cannot be told: the tool is then kept, never dropped on a guess.
async function roleAtStart($: Held): Promise<string | null> {
  try {
    return await sessionRole($, await $.session.id())
  } catch (err) {
    await logLine($, 'todo', `role at start not read: ${messageOf(err)}`)
    return null
  }
}

/** How often the module reads its holder's list for a wait date passed. */
export const SURFACE_TICK_MS = 5 * 60_000

const toldKey = ({ item, date }: DueTodo): string => `${item.id} ${date} ${item.waits?.until} ${item.waits?.deadline}`

/** The line the holder is told for the items a wait date of which passed. */
export function surfaceText(due: readonly DueTodo[]): string {
  return [`[module] ${due.length === 1 ? 'A to-do of your list is' : `${due.length} to-dos of your list are`} due:`,
    ...due.map(({ item, date }) => `- to-do ${todoName(item)} waited on ${item.waits?.on} (${item.waits?.why}); ${date === 'until' ? `its wait ended at ${item.waits?.until}` : `its deadline ${item.waits?.deadline} passed`}.`),
    'Do it and close it (todo done), hand it to a row or an agent (todo row, todo add … agent), or wait again with a new date (todo wait).'].join('\n')
}

/**
 * One reading of the holder's list: the items a wait date of which passed and that were not surfaced
 * for it, told in one line, then marked under the store's lock. A mark that fails tells them again at
 * the next reading: a to-do told twice, never one left untold. Answers the items told.
 */
export async function surfaceDue($: Surfacing, name: string, now: number = Date.now()): Promise<DueTodo[]> {
  const due = dueTodos(await readTodos($, name), now)
  if (due.length === 0) return []
  const taken: unknown = await $.prompt.submit({ text: surfaceText(due) })
  if (typeof taken === 'object' && taken !== null && 'drop' in taken && taken.drop) throw new Error(`the host dropped the wake: ${String(taken.drop)}`)
  // Marked only as told: the same item, date and wait. One whose wait was set anew meanwhile is left due.
  const told = new Set(due.map(entry => toldKey(entry)))
  await updateOver(storeIo($), todoPath(await stateDir($), name), current => current === undefined ? undefined
    : surfaceTodos(current, dueTodos(todoItems(current), now).filter(entry => told.has(toldKey(entry)))))
  return due
}

// The reading armed at a keeper's turn end, once per session id (a /clear's new session arms its own),
// read at once and every SURFACE_TICK_MS after.
export function registerSurface(on: On<Surfacing>): void {
  let armed: { sessionId: string; timer: Timer } | null = null
  let running = false
  on('turn.complete', {}, async ($, e, next) => {
    if (e.agentId) return next(e)
    try {
      const sessionId = await $.session.id()
      if (armed?.sessionId === sessionId) return next(e)
      const me = await whoAmI($)
      if (me === null) return next(e)
      armed?.timer.cancel()
      const tick = async (): Promise<void> => {
        if (running) return
        running = true
        try {
          await surfaceDue($, me.name)
        } catch (err) {
          await logLine($, 'todo', `surface: ${messageOf(err)}`)
        } finally {
          running = false
        }
      }
      armed = { sessionId, timer: $.clock.every(SURFACE_TICK_MS, () => void tick()) }
      await tick()
    } catch (err) {
      await logLine($, 'todo', `surface: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'todo', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      // An agent carries no list, and the tool's text is about a thousand characters of its context:
      // it is not registered for it. The role is the row's, else the launch name's; a role not known
      // yet (an operator's session, named after its first turn) keeps the tool.
      if (await roleAtStart($) === 'agent') return next(e)
      await $.tool.register({
        name: TODO_TOOL,
        isDeferred: false,
        description: "Records, as the operator said it, a request of his that will not be done within this turn or that is for another session, and closes it later; it holds this session's `done` while one is open. "
          + 'action: `add` (words: his words as given; said_at: when he said them; to: another session, whose list is written first and which is then sent the message; label: a short name; images: the absolute paths of the images he gave with it; '
          + 'and who takes it, row: a dispatch row or agent: an agent\'s session name, or what it waits on, waits_on, why, until and deadline: ISO instants; the module surfaces it when either passes), '
          + '`row` (id, row: a dispatch row it turned into), `wait` (id, waits_on, why, until, deadline: a new wait), `done` (id, outcome: the proof, a pull request, a file or a row), `drop` (id, words: his words that drop it), `defer` (id, words: his ruling that puts it off), `list`. '
          + 'Only for an orchestrator, a coordinator or an auditor.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            words: { type: 'string' },
            said_at: { type: 'string' },
            to: { type: 'string' },
            label: { type: 'string' },
            images: { type: 'array', items: { type: 'string' } },
            id: { type: 'integer' },
            outcome: { type: 'string' },
            row: { type: 'integer' },
            agent: { type: 'string' },
            waits_on: { type: 'string' },
            why: { type: 'string' },
            until: { type: 'string' },
            deadline: { type: 'string' },
          },
          required: ['action'],
        },
      })
    } catch (err) {
      await logLine($, 'todo', `${TODO_TOOL} not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'todo', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${TODO_TOOL}` }, async ($, e) => callTodo($, e)).catch(async ($, e, next) => {
    await logLine($, 'todo', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the to-do could not be recorded; the module\'s log says why', isError: true }
  })
}
