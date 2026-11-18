// hooks/todo-format.ts
// The to-do list of a session, owned by the orchestrator: what the operator asked of it that does
// not end within the turn, or that is for another session. One file per holder, `<state>/todo/<name>.jsonl`,
// one line per item, in the grammar of the dispatch record's rows (`id`, `opened`, `label`, `state`,
// `deferred`, `verdict`) plus `words`, `said_at`, `from`, `images`, `rows`, `agent`, `waits` and `surfaced`: the item
// keeps his words, who takes it (the dispatch rows it turned into, or an agent) or what it waits on, never the rows'
// state, which is their own. Written by the orchestrator's hooks module
// alone, under the store's lock; read by its stop gate, its declared wait, its status command and the
// coordinator's end (docs/contracts.md).
import { ROLES } from '../core/names.ts'

/** The version a line carries, and where the lists live under the state directory. */
export const TODO_CONTRACT = { version: 1, dir: 'todo', suffix: '.jsonl' } as const

export const TODO_VERSION = TODO_CONTRACT.version

/** A label is the first words of the item, at most this long. */
export const TODO_LABEL_MAX = 80

export interface TodoItem {
  readonly v: number
  readonly id: number
  readonly opened: string
  readonly label: string
  readonly state: 'open' | 'closed'
  /** The operator's ruling that put the item off; absent while it is pending. */
  readonly deferred?: string
  /** What closed it: its proof, or the words that dropped it; empty while open. */
  readonly verdict: string
  /** His request, as he said it. */
  readonly words: string
  /** When he said it. */
  readonly said_at: string
  /** The session that recorded it for the holder. */
  readonly from: string
  /** The absolute paths of the images he gave with his words. */
  readonly images?: readonly string[]
  readonly closed?: string
  /** The dispatch rows the item turned into; their state is read in the record, never copied here. */
  readonly rows?: readonly number[]
  /** The agent that takes it, by its session name. */
  readonly agent?: string
  /** What it waits on, why, until when, and its deadline: the module surfaces it when each date passes. */
  readonly waits?: TodoWait
  /** The dates of `waits` the module already surfaced it for. */
  readonly surfaced?: readonly TodoDate[]
}

/** What an item waits on: the fact, why, the instant the wait ends, and the instant it is owed by (ISO, UTC). */
export interface TodoWait {
  readonly on: string
  readonly why: string
  readonly until: string
  readonly deadline: string
}

/** The two dates of a wait the module surfaces an item at. */
export type TodoDate = 'until' | 'deadline'
const DATES: readonly TodoDate[] = ['until', 'deadline']

/** Who takes an item, or what it waits on: one of them at least, never neither. */
export interface TodoOwner {
  readonly rows?: readonly number[]
  readonly agent?: string
  readonly waits?: TodoWait
}

/** What a caller records: his words, when he said them, who carries them, and a label if it has one. */
export interface TodoAdd {
  readonly words: string
  readonly said_at: string
  readonly from: string
  readonly label?: string
  readonly images?: readonly string[]
  /** Who takes it or what it waits on; the tool refuses an add without (parseOwner). */
  readonly owner?: TodoOwner
}

/** The images one item keeps at most. */
export const TODO_IMAGES_MAX = 10

/** Whether a value is a list of images an item keeps: absolute paths, at most TODO_IMAGES_MAX. */
export function isImageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= TODO_IMAGES_MAX && value.every(path => typeof path === 'string' && path.startsWith('/') && !path.includes('\n'))
}

/** The line that prints an item's images, `images: <path>, <path>`, or null when it has none. */
export function todoImagesLine(item: Pick<TodoItem, 'images'>): string | null {
  return item.images !== undefined && item.images.length > 0 ? `images: ${item.images.join(', ')}` : null
}

const REFERENCE = / \[[^\]\s]+\]$/
const ROLE_COLON = new RegExp(`^(${Object.keys(ROLES).join('|')}) ?: *`, 'u')

/** The name a list belongs to: the session's name without its reference, in the current shape. */
export function holderOf(name: string): string {
  return name.trim().replace(REFERENCE, '').trim().replace(ROLE_COLON, '$1: ')
}

/** The file name of a holder's list, in the directory of the lists. */
export function todoFile(name: string): string {
  return `${holderOf(name).replace(/[^\p{L}\p{N} :._-]/gu, '_')}${TODO_CONTRACT.suffix}`
}

/** The list of a holder under the state directory. */
export function todoPath(stateDir: string, name: string): string {
  return `${stateDir}/${TODO_CONTRACT.dir}/${todoFile(name)}`
}

/** An item's label when the caller gives none: its words flattened, cut. */
export function todoLabel(words: string): string {
  return words.replace(/\s+/g, ' ').trim().slice(0, TODO_LABEL_MAX)
}

const isRowId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const isWait = (value: unknown): value is TodoWait => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return filled(o['on']) && filled(o['why']) && filled(o['until']) && filled(o['deadline'])
}

const WAIT_FIELDS = ['waits_on', 'why', 'until', 'deadline'] as const

/** The flat fields of a call that name who takes an item or what it waits on (parseOwner). */
export const TODO_OWNER_FIELDS = ['row', 'agent', ...WAIT_FIELDS] as const

/**
 * What an item waits on, read from a call's flat fields `waits_on`, `why`, `until` and `deadline`, the
 * two dates ISO instants, the deadline not before the end of the wait: none when no field is given.
 */
export function parseWait(e: Record<string, unknown>): { waits?: TodoWait } | { error: string } {
  if (WAIT_FIELDS.every(field => e[field] === undefined)) return {}
  const missing = WAIT_FIELDS.filter(field => !filled(e[field]))
  if (missing.length > 0) return { error: `a wait names all of waits_on, why, until and deadline: ${missing.join(', ')} missing.` }
  const until = Date.parse(String(e['until']))
  const deadline = Date.parse(String(e['deadline']))
  if (!Number.isFinite(until) || !Number.isFinite(deadline)) return { error: 'until and deadline are ISO instants, 2026-11-20T09:00:00Z.' }
  if (deadline < until) return { error: 'the deadline falls before the wait ends: deadline is the later date.' }
  return { waits: { on: String(e['waits_on']).trim(), why: String(e['why']).trim(), until: stampOf(until), deadline: stampOf(deadline) } }
}

/**
 * Who takes an item, or what it waits on, read from a call's flat fields: `row` (a dispatch row),
 * `agent` (an agent's session name, never the list's holder), or the wait (parseWait).
 */
export function parseOwner(e: Record<string, unknown>, holder: string): { owner: TodoOwner } | { error: string } {
  const row = e['row']
  if (row !== undefined && !isRowId(row)) return { error: 'row is the dispatch row that takes it, a positive integer.' }
  const agent = e['agent']
  if (agent !== undefined && !filled(agent)) return { error: 'agent names the agent that takes it, by its session name.' }
  if (filled(agent) && holderOf(agent) === holderOf(holder)) return { error: 'agent names another session than the one whose list keeps it: a to-do its holder takes itself is left aside.' }
  const wait = parseWait(e)
  if ('error' in wait) return wait
  if (row === undefined && !filled(agent) && wait.waits === undefined) {
    return { error: 'a to-do names who takes it, `row` (a dispatch row) or `agent` (an agent\'s session name), or what it waits on: waits_on, why, until and deadline.' }
  }
  return { owner: { ...(isRowId(row) ? { rows: [row] } : {}), ...(filled(agent) ? { agent: agent.trim() } : {}), ...(wait.waits ? { waits: wait.waits } : {}) } }
}

/** An item as a line holds it, each field of its type, or undefined. */
export function parseTodoItem(raw: unknown): TodoItem | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o['v'] !== TODO_VERSION || typeof o['id'] !== 'number' || !Number.isInteger(o['id']) || o['id'] < 1) return undefined
  if (o['state'] !== 'open' && o['state'] !== 'closed') return undefined
  if (!filled(o['words']) || !filled(o['said_at']) || !filled(o['from']) || !filled(o['opened'])) return undefined
  if (typeof o['label'] !== 'string' || typeof o['verdict'] !== 'string') return undefined
  if (o['deferred'] !== undefined && typeof o['deferred'] !== 'string') return undefined
  if (o['closed'] !== undefined && typeof o['closed'] !== 'string') return undefined
  if (o['rows'] !== undefined && !(Array.isArray(o['rows']) && o['rows'].every(isRowId))) return undefined
  if (o['images'] !== undefined && !isImageList(o['images'])) return undefined
  if (o['agent'] !== undefined && !filled(o['agent'])) return undefined
  if (o['waits'] !== undefined && !isWait(o['waits'])) return undefined
  if (o['surfaced'] !== undefined && !(Array.isArray(o['surfaced']) && o['surfaced'].every(date => DATES.includes(date)))) return undefined
  return raw as TodoItem
}

/** The items of a list's text; a line that is no item (torn by a write in flight) is skipped. */
export function todoItems(text: string): TodoItem[] {
  return text.split('\n').flatMap(line => {
    if (line.trim() === '') return []
    try {
      const item = parseTodoItem(JSON.parse(line))
      return item === undefined ? [] : [item]
    } catch {
      return []
    }
  })
}

const textOf = (items: readonly TodoItem[]): string => items.map(item => `${JSON.stringify(item)}\n`).join('')

const stamp = (now: Date): string => `${now.toISOString().slice(0, 19)}Z`

const stampOf = (ms: number): string => stamp(new Date(ms))

/** The list with the item added, numbered after the highest id; the item too. */
export function addTodo(text: string, set: TodoAdd, now: Date): { text: string; item: TodoItem } {
  const items = todoItems(text)
  const item: TodoItem = {
    v: TODO_VERSION,
    id: items.reduce((highest, kept) => Math.max(highest, kept.id), 0) + 1,
    opened: stamp(now),
    label: set.label !== undefined && set.label.trim() !== '' ? set.label.trim() : todoLabel(set.words),
    state: 'open',
    verdict: '',
    words: set.words,
    said_at: set.said_at,
    from: set.from,
    ...(set.images !== undefined && set.images.length > 0 ? { images: [...set.images] } : {}),
    ...(set.owner ?? {}),
  }
  return { text: textOf([...items, item]), item }
}

function change(text: string, id: number, apply: (item: TodoItem) => TodoItem | { error: string }): { text: string; item: TodoItem } | { error: string } {
  const items = todoItems(text)
  const found = items.find(item => item.id === id)
  if (found === undefined) return { error: `no to-do ${id} in this list` }
  const next = apply(found)
  if ('error' in next) return next
  return { text: textOf(items.map(item => (item === found ? next : item))), item: next }
}

/** The list with the item closed by its outcome, or why it cannot be. */
export function closeTodo(text: string, id: number, verdict: string, now: Date): { text: string; item: TodoItem } | { error: string } {
  return change(text, id, item => (item.state === 'closed' ? { error: `to-do ${id} is already closed` } : { ...item, state: 'closed', verdict, closed: stamp(now) }))
}

/** The list with the item put off by his ruling, still open, or why it cannot be. */
export function deferTodo(text: string, id: number, ruling: string): { text: string; item: TodoItem } | { error: string } {
  return change(text, id, item => (item.state === 'closed' ? { error: `to-do ${id} is already closed` } : { ...item, deferred: ruling }))
}

/** The list with a row the item turned into added to the ones it names, or why it cannot be. */
export function rowTodo(text: string, id: number, row: number): { text: string; item: TodoItem } | { error: string } {
  if (!isRowId(row)) return { error: 'a dispatch row id is a positive integer' }
  return change(text, id, item => (item.state === 'closed' ? { error: `to-do ${id} is already closed` }
    : { ...item, rows: [...new Set([...(item.rows ?? []), row])].sort((a, b) => a - b) }))
}

/** The list with the item's wait set anew, its surfacing started over, or why it cannot be. */
export function waitTodo(text: string, id: number, waits: TodoWait): { text: string; item: TodoItem } | { error: string } {
  return change(text, id, item => {
    if (item.state === 'closed') return { error: `to-do ${id} is already closed` }
    const { surfaced: _surfaced, ...rest } = item
    return { ...rest, waits }
  })
}

/** An open item whose wait date has passed and was not surfaced yet, with the date. */
export type DueTodo = { readonly item: TodoItem; readonly date: TodoDate }

/** The open items a wait date of which passed at `now` that the module has not surfaced them for: the later date only, when both did. */
export function dueTodos(items: readonly TodoItem[], now: number): DueTodo[] {
  return openTodos(items).flatMap(item => {
    if (item.waits === undefined) return []
    const passed = DATES.filter(date => Date.parse(item.waits![date]) <= now)
    const date = passed.at(-1)
    return date === undefined || item.surfaced?.includes(date) ? [] : [{ item, date }]
  })
}

/** The list with each item marked surfaced for its date and every earlier one. */
export function surfaceTodos(text: string, due: readonly DueTodo[]): string {
  const marks = new Map(due.map(entry => [entry.item.id, DATES.slice(0, DATES.indexOf(entry.date) + 1)]))
  return textOf(todoItems(text).map(item => {
    const dates = marks.get(item.id)
    return dates === undefined || item.state === 'closed' ? item : { ...item, surfaced: [...new Set([...(item.surfaced ?? []), ...dates])] }
  }))
}

const isDeferred = (item: TodoItem): boolean => typeof item.deferred === 'string' && item.deferred.trim() !== ''

/** The items still open, put off or not. */
export const openTodos = (items: readonly TodoItem[]): TodoItem[] => items.filter(item => item.state === 'open')

/** The open items he did not put off. */
export const pendingTodos = (items: readonly TodoItem[]): TodoItem[] => openTodos(items).filter(item => !isDeferred(item))

/** The open items he put off. */
export const deferredTodos = (items: readonly TodoItem[]): TodoItem[] => openTodos(items).filter(isDeferred)

/** `<id> (<label>)`, the way a refusal lists an item. */
export const todoName = (item: TodoItem): string => `${item.id} (${item.label === '' ? 'no label' : item.label})`
