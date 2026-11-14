// hooks/todo.ts
// The `todo` tool: what the operator asks of a session that will not be done within the turn, or that
// is for another session, recorded in the holder's own list (core's todo.ts, docs/contracts.md). The
// model judges that a request is one and records it; code keeps the list, under the store's lock, and
// holds the session's « done » while an item is open (the declared wait, the stop gate, the
// coordinator's end). A request for another session is written into that session's list first, then
// sent, in one call: no relay goes out unrecorded. A session on another machine is only sent the
// message, and told so.
import { updateOver } from '../core/store-io.ts'
import {
  addTodo, closeTodo, deferTodo, deferredTodos, holderOf, openTodos, pendingTodos, todoItems, todoName, todoPath, type TodoItem,
} from '../core/todo.ts'
import { type DeclaredWait } from './stop-gate.ts'
import { coordinatorAddress, parseSessionRow, sessionKey, storeOf } from './supervision.ts'
import { parseRemoteRow, ROW_MARKER } from './remote-row.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { messageOf, type Host, type On } from './host.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs' | 'clock'>

export const TODO_TOOL = 'todo'

// The sessions that keep a list: the ones that take the operator's word and hold no code of their own.
const KEEPERS: readonly string[] = ['orchestrator', 'coordinator', 'auditor']

const ACTIONS = ['add', 'done', 'drop', 'defer', 'list'] as const
type Answer = { result: string; isError?: true }

const refuse = (result: string): Answer => ({ result, isError: true })

// The session itself: its name and role, from the row the module keeps for it. Null when the name is
// not known yet or the session keeps no list.
async function whoAmI($: Held): Promise<{ name: string; role: string } | null> {
  const row = parseSessionRow(String(await $.fs.read(`${await storeOf($)}/${sessionKey(await $.session.id())}`).catch(() => '')))
  return row?.name && row.role && KEEPERS.includes(row.role) ? { name: row.name, role: row.role } : null
}

/** The items a holder's list keeps, open or closed; none when there is no list. */
export async function readTodos($: Held, name: string): Promise<TodoItem[]> {
  return todoItems(String(await $.fs.read(todoPath(await stateDir($), name)).catch(() => '')))
}

// One change of a holder's list, under the store's lock: the item it made, or why it made none.
async function writeTodos($: Held, name: string, change: (text: string) => { text: string; item: TodoItem } | { error: string }): Promise<{ item: TodoItem } | { error: string }> {
  let made: { item: TodoItem } | { error: string } = { error: 'nothing was written' }
  await updateOver(storeIo($), todoPath(await stateDir($), name), current => {
    const next = change(current ?? '')
    made = 'error' in next ? next : { item: next.item }
    return 'error' in next ? undefined : next.text
  })
  return made
}

const shown = (item: TodoItem): string =>
  `${todoName(item)}: « ${item.words} » (said ${item.said_at}, by ${item.from})${item.deferred ? `, put off: ${item.deferred}` : ''}`

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
function messageOfRequest(item: TodoItem | null, set: { words: string; said_at: string; from: string }, now: Date): string {
  const head = item === null ? 'A request of the operator, for you' : `To-do ${item.id}, recorded in your list`
  return `${head}, carried by ${set.from} at ${now.toISOString().slice(0, 19)}Z: « ${set.words} » (he said it at ${set.said_at}).`
    + (item === null ? '' : ` Read your list with todo list; close it with todo done ${item.id} and its outcome.`)
}

async function add($: Held, me: { name: string }, e: Record<string, unknown>, now: Date): Promise<Answer> {
  const words = typeof e['words'] === 'string' ? e['words'].trim() : ''
  if (words === '') return refuse('add records his words: pass them as given in `words`.')
  if (e['said_at'] !== undefined && (typeof e['said_at'] !== 'string' || e['said_at'].trim() === '')) return refuse('said_at is when he said it, as a date.')
  if (e['label'] !== undefined && typeof e['label'] !== 'string') return refuse('label is a string.')
  if (e['to'] !== undefined && (typeof e['to'] !== 'string' || e['to'].trim() === '')) return refuse('to names the session the request is for.')
  const from = holderOf(me.name)
  const set = { words, said_at: typeof e['said_at'] === 'string' ? e['said_at'].trim() : `${now.toISOString().slice(0, 19)}Z`, from, ...(typeof e['label'] === 'string' ? { label: e['label'] } : {}) }
  const to = typeof e['to'] === 'string' ? e['to'].trim() : null
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
  const sent = await $.session.send({ to, text: messageOfRequest(made.item, set, now) })
  if (sent.isDelivered) return { result: `Recorded as to-do ${made.item.id} in the list of ${holderOf(to)}, and sent.` }
  return refuse(`Recorded as to-do ${made.item.id} in the list of ${holderOf(to)}, but not sent: ${sent.reason}. The next session of that name reads the list; send it the words again if it must know now.`)
}

async function closing($: Held, me: { name: string }, action: 'done' | 'drop' | 'defer', e: Record<string, unknown>, now: Date): Promise<Answer> {
  const id = e['id']
  if (typeof id !== 'number' || !Number.isInteger(id)) return refuse(`${action} names the to-do by its \`id\`, a number.`)
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
  if (me === null) return refuse("Only an orchestrator, a coordinator or an auditor keeps a to-do list, once its name is known (after its first turn).")
  if (action === 'add') return add($, me, e, now)
  if (action === 'list') {
    const open = openTodos(await readTodos($, me.name))
    return { result: open.length === 0 ? 'no open to-do.' : [`${open.length} open to-do:`, ...open.map(shown)].join('\n') }
  }
  return closing($, me, action, e, now)
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
export function todoRefusal(left: readonly TodoItem[], kind: 'done' | 'deferred'): string {
  return `Not ${kind === 'done' ? 'done' : 'deferred'}: to-do ${left.map(todoName).join(', ')} ${left.length === 1 ? 'is' : 'are'} open. `
    + 'Do it and close it (todo done, with its outcome), hand it on (todo add … to <session>, then todo done naming it), '
    + `or, if the operator put it off, record his ruling (todo defer)${kind === 'done' ? ' and declare a deferred wait' : ''}.`
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: TODO_TOOL,
        isDeferred: false,
        description: "Records, as the operator said it, a request of his that will not be done within this turn or that is for another session, and closes it later; it holds this session's `done` while one is open. "
          + 'action: `add` (words: his words as given; said_at: when he said them; to: another session, whose list is written first and which is then sent the message; label: a short name), '
          + '`done` (id, outcome: the proof, a pull request, a file or a row), `drop` (id, words: his words that drop it), `defer` (id, words: his ruling that puts it off), `list`. '
          + 'Only for an orchestrator, a coordinator or an auditor.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            words: { type: 'string' },
            said_at: { type: 'string' },
            to: { type: 'string' },
            label: { type: 'string' },
            id: { type: 'integer' },
            outcome: { type: 'string' },
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
