// The sleeping orchestrators: <state>/sleeping.json, an array of {"name","brief","dir","model",
// "effort","slept","prs","checkouts"[,"session"]}, written in one rename under the coordinator's
// lock and kept apart from its own record, so it outlives a succession. A sleeping orchestrator
// is the operator's to wake or drop: nothing here acts on its own.
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { currentSessionName, parseSessionName } from '../../../core/names.ts'
import { die, stateOf, utc, type Context } from './context.ts'
import { withCoordinatorLock } from './lock.ts'
import { writeWhole } from './record.ts'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One record's fields as read; the array itself is rewritten as it was read, so nothing is lost. */
export type Sleeper = Readonly<Record<string, unknown>>

/** The fields of one item of the array: an item that is no object has none. */
export function fieldsOf(item: unknown): Sleeper {
  return typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Sleeper : {}
}

export function sleepingPath(state: string): string {
  return join(state, 'sleeping.json')
}

/** The records of the sleeping file's text; anything but a JSON array is refused, never read as none. */
export function parseSleeping(text: string, path: string): unknown[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!Array.isArray(value)) return die(`the sleeping record ${path} cannot be read: remove or repair it`)
  return value
}

/** The sleeping records, none when the file is absent. */
export function readSleeping(state: string): unknown[] {
  const path = sleepingPath(state)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    return die(`the sleeping record ${path} cannot be read: remove or repair it`)
  }
  return parseSleeping(text, path)
}

/** A value as the listing prints it: text as it is, null for none, anything else as JSON. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? 'null' : JSON.stringify(value)
}

/** Absent, null, false or empty: a field the listing says nothing of. */
function isNone(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === ''
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(shown) : []
}

/** The listing's line for one record. */
export function sleepingLine(one: Sleeper): string {
  const prs = list(one['prs'])
  const checkouts = list(one['checkouts'])
  const effort = isNone(one['effort']) ? 'none' : shown(one['effort'])
  const session = isNone(one['session']) ? '' : ` | session ${shown(one['session'])}`
  return `sleeping ${shown(one['name'])} | since ${shown(one['slept'])} | ${shown(one['dir'])}`
    + ` | prs ${prs.length > 0 ? prs.join(', ') : 'none'} | checkouts ${checkouts.length > 0 ? checkouts.join(', ') : 'none'}`
    + ` | brief ${shown(one['brief'])} | model ${shown(one['model'])} | effort ${effort}${session}`
}

/** Whether `name` is the launcher's shape for an orchestrator's title, without its reference. */
export function isSleeperName(name: string): boolean {
  return parseSessionName(name)?.role === 'orchestrator' && !/ \[[0-9A-Za-z]+\]$/.test(name)
}

/** Whether a record's name is `name`: a record written before the change carries the former `Orch : x`. */
function named(record: unknown, name: string): boolean {
  const recorded = fieldsOf(record)['name']
  return typeof recorded === 'string' && currentSessionName(recorded) === currentSessionName(name)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return isFile(path)
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const SLEEP_USAGE = 'sleep: usage: sleep --name "Orch: <subject>" --brief <path> --dir <path> --model <id> --effort <level> [--session <id>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...'

export function sleep(ctx: Context, args: readonly string[]): number {
  const single = new Map<string, string>()
  const prs: string[] = []
  const checkouts: string[] = []
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i] ?? ''
    const value = args[i + 1]
    if (option === '--pr' || option === '--checkout') {
      if (value === undefined || value === '') die(`sleep: ${option} needs a value`)
      ;(option === '--pr' ? prs : checkouts).push(value)
    } else if (['--name', '--brief', '--dir', '--model', '--effort', '--session'].includes(option)) {
      if (value === undefined) die(`sleep: ${option} needs a value`)
      single.set(option, value)
    } else {
      die(`sleep: unknown option ${option}`)
    }
  }
  const get = (option: string): string => single.get(option) ?? ''
  const name = get('--name')
  const brief = get('--brief')
  const dir = get('--dir')
  const model = get('--model')
  const effort = get('--effort')
  const session = get('--session')
  if (name === '' || brief === '' || dir === '' || model === '') die(SLEEP_USAGE)
  if (!isSleeperName(name)) die(`sleep: refused: the name reads "Orch: <subject>", without its reference, the subject at most 25 characters, got '${name}'`)
  if (!brief.startsWith('/')) die(`sleep: refused: the brief's path must be absolute, got ${brief}`)
  if (!isReadableFile(brief)) die(`sleep: refused: the brief ${brief} cannot be read: a wake starts on it`)
  if (!dir.startsWith('/')) die(`sleep: refused: the directory must be absolute, got ${dir}`)
  if (!isDirectory(dir)) die(`sleep: refused: the directory ${dir} does not exist: a wake starts in it`)
  // The effort travels with the model: a pause recorded without it would wake its orchestrator
  // at an effort nobody chose.
  if (effort === '') die('sleep: refused: no effort: a pause records the model with its effort, --effort <level> (the paused orchestrator reads both with iterm-agent.sh pair)')
  if (!(EFFORTS as readonly string[]).includes(effort)) die(`sleep: refused: unknown effort ${effort} (low, medium, high, xhigh or max)`)
  if (session !== '' && !/^[0-9A-Za-z-]+$/.test(session)) die(`sleep: refused: a session id reads letters, digits and hyphens, got '${session}'`)
  const state = stateOf(ctx.env)
  withCoordinatorLock(ctx, 'sleep', () => {
    const all = readSleeping(state)
    if (all.some(one => named(one, name))) die(`sleep: refused: ${name} is already sleeping`)
    const record = { name, brief, dir, model, effort, slept: utc(ctx.now()), prs, checkouts, ...(session === '' ? {} : { session }) }
    writeWhole(sleepingPath(state), JSON.stringify([...all, record]))
  })
  ctx.out(`sleeping ${name}`)
  return 0
}

export function sleeping(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`sleeping: unexpected argument ${args[0]}`)
  for (const one of readSleeping(stateOf(ctx.env))) ctx.out(sleepingLine(fieldsOf(one)))
  return 0
}

/** The one `--name` that wake-done and drop take. */
function nameOption(sub: string, args: readonly string[]): string {
  let name = ''
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--name') die(`${sub}: unknown option ${args[i]}`)
    const value = args[i + 1]
    if (value === undefined) die(`${sub}: --name needs a value`)
    name = value
  }
  if (name === '') die(`${sub}: usage: ${sub} --name "Orch: <subject>"`)
  return name
}

/** The records without `name`, refused when it does not sleep. */
function without(all: readonly unknown[], name: string, sub: string): unknown[] {
  if (!all.some(one => named(one, name))) die(`${sub}: refused: ${name} is not sleeping (coordinator.sh sleeping lists who is)`)
  return all.filter(one => !named(one, name))
}

export function wakeDone(ctx: Context, args: readonly string[]): number {
  const name = nameOption('wake-done', args)
  const state = stateOf(ctx.env)
  withCoordinatorLock(ctx, 'wake', () => {
    writeWhole(sleepingPath(state), JSON.stringify(without(readSleeping(state), name, 'wake-done')))
  })
  ctx.out(`woken ${name}`)
  return 0
}

/** The stamp an abandoned brief's name starts with. */
function stamp(date: Date): string {
  return utc(date).replace(/[-:]/g, '')
}

export function drop(ctx: Context, args: readonly string[]): number {
  const name = nameOption('drop', args)
  const state = stateOf(ctx.env)
  const { one, moved } = withCoordinatorLock(ctx, 'drop', () => {
    const all = readSleeping(state)
    const rest = without(all, name, 'drop')
    const one = fieldsOf(all.find(each => named(each, name)))
    const brief = shown(one['brief'])
    // The brief is moved, never deleted: a drop typed by a slip loses nothing.
    let moved: string | undefined
    if (isFile(brief)) {
      moved = join(dirname(brief), 'abandoned', `${stamp(ctx.now())}-${basename(brief)}`)
      try {
        mkdirSync(dirname(moved), { recursive: true })
        renameSync(brief, moved)
      } catch {
        die(`drop: cannot move the brief ${brief} into ${dirname(moved)}: nothing was dropped`)
      }
    }
    writeWhole(sleepingPath(state), JSON.stringify(rest))
    return { one, moved }
  })
  ctx.out(`dropped ${name}`)
  ctx.out(moved === undefined ? `brief ${shown(one['brief'])} was already gone` : `brief moved to ${moved}`)
  const left = [...list(one['prs']), ...list(one['checkouts'])]
  ctx.out(`left untouched: ${left.length > 0 ? left.join(', ') : 'none'}`)
  return 0
}
