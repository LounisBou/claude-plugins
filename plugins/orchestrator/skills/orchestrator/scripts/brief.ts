// brief — the briefs printed from the state, never typed.
//
//   brief.sh phase --record <dispatch record> --row <id> --plan <phase file> --worktree <dir> --branch <b>
//     --orchestrator "<name [ref]>" --out <path> [--base <ref>] [--spec <path>] [--mode build|investigate]
//     [--report <path>] [--scope "<text>"] [--repo <owner/name>]
//   brief.sh audit --subject <s> --repository <dir> --briefs <dir> --kind <kind> --words "<his words>"
//     --question "<text>" [--established "<text>"] [--since <date>] [--reading "<text>"] [--records "<text>"]
//   brief.sh auditor-takeover --name "<Audit: x>" --tty <tty> --report <path> --repository <dir>
//   brief.sh coordinator-takeover --name "<Coord: x>" --tty <tty>
//
// Each fills a template of the plugin (`templates/`) from what the state already holds: `phase` from
// the dispatch record's row, the plan's phase file, the spec `goals.md` names and the base's head;
// `audit` from the briefs directory (the previous report, its date) and the repository; the two
// takeovers from the to-do list of the session handing over and, for the coordinator, its notes. The
// session that dispatches passes paths and, at most, a few words of its own judgment; a brief typed by
// hand cost its orchestrator thousands of tokens of context each. `phase` and `audit` write the brief
// to a file and say its path; a takeover prints its text, as `succession.sh takeover` does. A field the
// template holds that this command does not fill is refused, so no brief leaves with a `{{FIELD}}`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText } from '../../../core/store.ts'
import type { Env } from '../../../core/paths.ts'
import { openTodos, todoItems, todoPath, type TodoItem } from '../../../hooks/todo-format.ts'
import { parseRecord, stateRoot, type Row } from './dispatch-record.ts'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { goalsFileOf } from './lib/record-paths.ts'
import { placeholdersOf } from './review-brief.ts'
import { fill, projectOf } from './succession.ts'

export const USAGE = 'usage: brief.sh {phase|audit|auditor-takeover|coordinator-takeover} --<field> <value>... (see header)'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const template = (name: string): string => join(root, 'templates', name)
export const TEMPLATES = {
  phase: template('agent-phase-brief.md'),
  audit: template('agent-audit-brief.md'),
  'auditor-takeover': template('auditor-succession-brief.md'),
  'coordinator-takeover': template('coordinator-succession-brief.md'),
} as const
type Command = keyof typeof TEMPLATES

const SCRIPT = join(here, 'brief.sh')
const LAUNCHER = join(root, 'skills', 'iterm-agents', 'scripts', 'iterm-agent.sh')
const COORDINATOR = join(root, 'skills', 'coordinator', 'scripts', 'coordinator.sh')
const RHYTHM = join(here, 'rhythm.sh')
const CHECKLIST = join(root, 'skills', 'orchestrator', 'references', 'screenshot-checklist.md')
/** The coordinator's notes are printed this far, at most. */
export const NOTES_CAP = 4000

/** The flags each command takes: required, then optional. */
const FLAGS: Record<Command, { readonly required: readonly string[]; readonly optional: readonly string[]; readonly paths: readonly string[] }> = {
  phase: {
    required: ['record', 'row', 'plan', 'worktree', 'branch', 'orchestrator', 'out'],
    optional: ['base', 'spec', 'mode', 'report', 'scope', 'repo'],
    paths: ['record', 'plan', 'worktree', 'out', 'report'],
  },
  audit: {
    required: ['subject', 'repository', 'briefs', 'kind', 'words', 'question'],
    optional: ['established', 'since', 'reading', 'records'],
    paths: ['repository', 'briefs'],
  },
  'auditor-takeover': { required: ['name', 'tty', 'report', 'repository'], optional: [], paths: ['report', 'repository'] },
  'coordinator-takeover': { required: ['name', 'tty'], optional: [], paths: [] },
}

export type Fields = Readonly<Record<string, string>>

/** The command and its fields from the command line, or the line that says what is wrong. */
export function parseArgs(argv: readonly string[]): { readonly command: Command; readonly fields: Fields } | { readonly error: string } {
  const [command = '', ...rest] = argv
  if (!(command in FLAGS)) return { error: USAGE }
  const spec = FLAGS[command as Command]
  const fields: Record<string, string> = {}
  for (let k = 0; k < rest.length; k += 2) {
    const flag = rest[k] ?? ''
    const name = flag.slice(2)
    if (!flag.startsWith('--') || ![...spec.required, ...spec.optional].includes(name)) return { error: `${command}: unknown argument: ${flag} (${USAGE})` }
    const value = rest[k + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${command}: ${flag} needs a value` }
    fields[name] = value
  }
  for (const name of spec.required) if ((fields[name] ?? '').trim() === '') return { error: `${command}: --${name} is required (${USAGE})` }
  for (const name of spec.paths) if (fields[name] !== undefined && !isAbsolute(fields[name] ?? '')) return { error: `${command}: --${name} is an absolute path, got: ${fields[name]}` }
  if (fields['mode'] !== undefined && !['build', 'investigate'].includes(fields['mode'])) return { error: `${command}: --mode is build or investigate, got: ${fields['mode']}` }
  if (fields['row'] !== undefined && !/^[1-9][0-9]*$/.test(fields['row'])) return { error: `${command}: --row is the row's id, got: ${fields['row']}` }
  return { command: command as Command, fields }
}

export interface Deps {
  readonly env: Env
  readonly now: () => Date
  /** `git -C <dir> <args>`'s stdout trimmed, undefined when it fails. */
  readonly git: (dir: string, args: readonly string[]) => string | undefined
}

/** The command's values, or the reason it cannot fill them. */
type Values = Record<string, string> | { readonly error: string }

const goalsValue = (goals: string | undefined, key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(goals ?? '')?.[1]?.trim() ?? ''

/** The row's tier as the agent reads it: the tier, else the model and effort the dispatch chose. */
export function tierOf(row: Row): string {
  const words = (key: string): string => (typeof row[key] === 'string' ? (row[key] as string) : '')
  const model = words('model') === '' ? '' : `model ${words('model')}${words('effort') === '' ? '' : `, effort ${words('effort')}`}`
  return [words('tier'), model].filter(part => part !== '').join(', ') || 'the host default'
}

function phaseValues(f: Fields, deps: Deps): Values {
  const recordText = readText(f['record'] ?? '')
  if (recordText === undefined) return { error: `no dispatch record at ${f['record']}` }
  const row = parseRecord(recordText).find(r => String(r['id']) === f['row'])
  if (row === undefined) return { error: `row ${f['row']} is not in ${f['record']}` }
  if (row['state'] !== 'open') return { error: `row ${f['row']} is not open` }
  const plan = readText(f['plan'] ?? '')
  if (plan === undefined) return { error: `no plan file at ${f['plan']}` }
  const spec = f['spec'] ?? goalsValue(readText(goalsFileOf(f['record'] ?? '')), 'spec')
  if (spec === '') return { error: `--spec is required: no goals.md beside ${f['record']} names one` }
  const worktree = f['worktree'] ?? ''
  if (!existsSync(worktree)) return { error: `no checkout at ${worktree}` }
  const base = f['base'] ?? 'origin/main'
  const label = typeof row['label'] === 'string' ? row['label'] : ''
  const note = typeof row['note'] === 'string' && row['note'] !== '' ? ` — note: ${row['note']}` : ''
  const out = f['out'] ?? ''
  const report = f['report'] ?? join(dirname(out), `report-${basename(out)}`)
  const title = /^# +(.+)$/m.exec(plan)?.[1]?.trim() ?? (label || basename(f['plan'] ?? ''))
  return {
    PROJECT: (f['repo'] ?? projectOf(worktree, f['record'] ?? '')).split('/').at(-1) ?? '',
    TITLE: title,
    ROW_ID: f['row'] ?? '',
    MODE: f['mode'] ?? 'build',
    ROW: `${f['row']} ${label}${note}`,
    SPEC: spec,
    PLAN: f['plan'] ?? '',
    SCOPE: f['scope'] === undefined ? '' : `Scope from the orchestrator: ${f['scope']}\n`,
    WORKTREE: worktree,
    BRANCH: f['branch'] ?? '',
    BASE: base,
    BASE_HEAD: deps.git(worktree, ['rev-parse', '--short=12', base]) ?? 'a head this command could not read',
    TIER: tierOf(row),
    ORCHESTRATOR: f['orchestrator'] ?? '',
    REPORT_PATH: report,
    SCREENSHOT_CHECKLIST: CHECKLIST,
  }
}

/** A subject as a file name takes it. */
export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'audit'

/** The local calendar date, as `date +%F` prints it. */
const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** The newest report under `<briefs>/audits/`, by the date its name starts with; undefined when there is none. */
export function previousReport(briefs: string): string | undefined {
  const dir = join(briefs, 'audits')
  if (!existsSync(dir)) return undefined
  const found = readdirSync(dir).filter(name => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$/.test(name)).sort().at(-1)
  return found === undefined ? undefined : join(dir, found)
}

function auditValues(f: Fields, deps: Deps): Values {
  const repository = f['repository'] ?? ''
  if (!existsSync(repository)) return { error: `no repository at ${repository}` }
  const briefs = f['briefs'] ?? ''
  const previous = previousReport(briefs)
  const firstCommit = (): string => {
    const roots = deps.git(repository, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n')[0]
    return (roots === undefined ? undefined : deps.git(repository, ['log', '-1', '--format=%cs', roots])) ?? 'its first commit'
  }
  const since = f['since'] ?? (previous === undefined ? firstCommit() : basename(previous).slice(0, 10))
  return {
    PROJECT: projectOf(repository, join(repository, 'x')).split('/').at(-1) ?? '',
    SUBJECT: f['subject'] ?? '',
    KIND: f['kind'] ?? '',
    WORDS: f['words'] ?? '',
    QUESTION: f['question'] ?? '',
    ESTABLISHED: f['established'] ?? 'nothing yet',
    REPOSITORY: repository,
    SINCE: since,
    READING: f['reading'] ?? 'none known',
    RECORDS: f['records'] ?? 'none',
    PREVIOUS_REPORT: previous === undefined ? 'none' : `\`${previous}\``,
    RHYTHM: RHYTHM,
    REPORT_PATH: join(briefs, 'audits', `${localDate(deps.now())}-${slug(f['subject'] ?? '')}.md`),
    SUCCESSION_TEMPLATE: TEMPLATES['auditor-takeover'],
    ITERM_AGENT_SH: LAUNCHER,
    BRIEF_SH: SCRIPT,
  }
}

/** A holder's open to-do items, one line each with his words and when he said them. */
export function todoLines(text: string | undefined): string {
  const open = openTodos(todoItems(text ?? ''))
  if (open.length === 0) return 'none'
  const line = (item: TodoItem): string => `[${item.id}] ${item.label}: « ${item.words} » (${item.said_at})${item.deferred ? ` deferred: ${item.deferred}` : ''}`
  return open.map(item => `\n  - ${line(item)}`).join('')
}

/** The subject of a session's name, its role and reference left off. */
const subjectOf = (name: string): string => name.trim().replace(/ \[[^\]\s]+\]$/, '').replace(/^[A-Za-z]+ ?: */, '').trim()

function auditorValues(f: Fields, deps: Deps): Values {
  const repository = f['repository'] ?? ''
  const name = f['name'] ?? ''
  return {
    PROJECT: projectOf(repository, join(repository, 'x')).split('/').at(-1) ?? '',
    SUBJECT: subjectOf(name),
    PREDECESSOR: name,
    PREDECESSOR_TTY: f['tty'] ?? '',
    REPORT_PATH: f['report'] ?? '',
    OPERATOR_WORK: todoLines(readText(todoPath(stateRoot(deps.env), name))),
    ITERM_AGENT_SH: LAUNCHER,
    BRIEF_SH: SCRIPT,
    REPOSITORY: repository,
  }
}

function coordinatorValues(f: Fields, deps: Deps): Values {
  const state = stateRoot(deps.env)
  const name = f['name'] ?? ''
  const notesFile = join(state, 'coordinator', 'notes.md')
  const notes = readText(notesFile)
  return {
    SUBJECT: subjectOf(name),
    PREDECESSOR: name,
    PREDECESSOR_TTY: f['tty'] ?? '',
    NOTES_CAP: String(NOTES_CAP),
    NOTES_FILE: notesFile,
    NOTES: notes === undefined || notes.trim() === '' ? 'none' : [...notes].slice(0, NOTES_CAP).join('').replace(/\n+$/, ''),
    TODO: todoLines(readText(todoPath(state, name))),
    ITERM_AGENT_SH: LAUNCHER,
    COORDINATOR_SH: COORDINATOR,
    BRIEF_SH: SCRIPT,
    STATE_DIR: state,
  }
}

const VALUES: Record<Command, (f: Fields, deps: Deps) => Values> = {
  phase: phaseValues,
  audit: auditValues,
  'auditor-takeover': auditorValues,
  'coordinator-takeover': coordinatorValues,
}

/** `git -C <dir>`, its stdout trimmed; undefined when it fails. */
export function git(dir: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * Fills the command's template and writes it (`phase`, `audit`) or prints it (the takeovers); returns
 * the exit status. `templates` stands in for the plugin's files in a test.
 */
export function main(argv: readonly string[], io: Io, deps: Deps, templates: Readonly<Record<Command, string>> = TEMPLATES): number {
  const parsed = parseArgs(argv)
  const fail = (message: string): number => {
    io.err(`brief: ${message}\n`)
    return 2
  }
  if ('error' in parsed) return fail(parsed.error)
  const text = readText(templates[parsed.command])
  if (text === undefined) return fail(`the plugin's template ${templates[parsed.command]} cannot be read`)
  const values = VALUES[parsed.command](parsed.fields, deps)
  if ('error' in values) return fail(`${parsed.command}: ${values.error}`)
  const unknown = placeholdersOf(text).filter(name => !(name in values))
  if (unknown.length > 0) return fail(`the template has fields this command does not fill: ${unknown.map(name => `{{${name}}}`).join(', ')}`)
  const filled = fill(text, values)
  if (parsed.command === 'phase' || parsed.command === 'audit') {
    const out = parsed.command === 'phase' ? parsed.fields['out'] ?? '' : join(parsed.fields['briefs'] ?? '', `audit-${slug(parsed.fields['subject'] ?? '')}-brief.md`)
    try {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, filled)
    } catch (error) {
      return fail(`${out} cannot be written: ${(error as Error).message}`)
    }
    io.out(`${parsed.command} brief: ${out}\nreport: ${values['REPORT_PATH']}\n`)
    return 0
  }
  io.out(filled.endsWith('\n') ? filled : `${filled}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo, { env: process.env, now: () => new Date(), git })
