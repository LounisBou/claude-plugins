// brief — the briefs printed from the state, never typed.
//
//   brief.sh phase --record <dispatch record> --row <id> --plan <phase file> --worktree <dir> --branch <b>
//     --orchestrator "<name [ref]>" --out <path> [--base <ref>] [--spec <path>] [--mode build|investigate]
//     [--report <path>] [--scope "<text>"] [--repo <owner/name>]
//   brief.sh audit --subject <s> --repository <dir> --briefs <dir> --kind <kind> --words "<his words>"
//     --question "<text>" [--established "<text>"] [--since <date>] [--reading "<text>"] [--records "<text>"]
//   brief.sh rotation --record <dispatch record> --row <id> --phase-brief <path> --worktree <dir> --orchestrator "<name [ref]>"
//     --tty <old agent's tty> --title "<Agent: x>" --out <path> [--base <ref>] [--plan <path> [--phase "<heading>"]]
//     [--report <the old agent's report>] [--new-report <path>] [--in-flight "<line>"] [--decisions "<line>"] [--repo <owner/name>]
//   brief.sh auditor-takeover --name "<Audit: x>" --tty <tty> --report <path> --repository <dir>
//   brief.sh coordinator-takeover --name "<Coord: x>" --tty <tty>
//
// Each fills a template of the plugin (`templates/`) from what the state already holds: `phase` from
// the dispatch record's row, the plan's phase (its file, or its section with --phase), the spec
// `goals.md` names and the sections of it that phase cites, and the base's head; `rotation` from the
// row, git (branch, head, the commits landed since the base, what is uncommitted), the plan's open
// items and the replaced agent's last report, the agent's two lines (in flight, decisions) when it
// gave them, and says the launcher's `rotate` line that starts the replacement on it;
// `audit` from the briefs directory (the previous report, its date) and the repository; the two
// takeovers from the to-do list of the session handing over and, for the coordinator, its notes. The
// session that dispatches passes paths and, at most, a few words of its own judgment; a brief typed by
// hand cost its orchestrator thousands of tokens of context each. `phase`, `rotation` and `audit`
// write the brief to a file and say its path; a takeover prints its text, as `succession.sh takeover` does. A field the
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

export const USAGE = 'usage: brief.sh {phase|rotation|audit|auditor-takeover|coordinator-takeover} --<field> <value>... (see header)'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const template = (name: string): string => join(root, 'templates', name)
export const TEMPLATES = {
  phase: template('agent-phase-brief.md'),
  rotation: template('agent-rotation-brief.md'),
  audit: template('agent-audit-brief.md'),
  'auditor-takeover': template('auditor-succession-brief.md'),
  'coordinator-takeover': template('coordinator-succession-brief.md'),
} as const
type Command = keyof typeof TEMPLATES

const SCRIPT = join(here, 'brief.sh')
const LAUNCHER = join(root, 'skills', 'iterm-agents', 'scripts', 'iterm-agent.sh')
const COORDINATOR = join(root, 'skills', 'coordinator', 'scripts', 'coordinator.sh')
const RHYTHM = join(here, 'rhythm.sh')
const LENS_MODEL = join(here, 'lens-model.sh')
const CHECKLIST = join(root, 'skills', 'orchestrator', 'references', 'screenshot-checklist.md')
/** The coordinator's notes are printed this far, at most. */
export const NOTES_CAP = 4000

/** The flags each command takes: required, then optional. */
const FLAGS: Record<Command, { readonly required: readonly string[]; readonly optional: readonly string[]; readonly paths: readonly string[] }> = {
  phase: {
    required: ['record', 'row', 'plan', 'worktree', 'branch', 'orchestrator', 'out'],
    optional: ['base', 'spec', 'mode', 'report', 'scope', 'repo', 'phase'],
    paths: ['record', 'plan', 'worktree', 'out', 'report'],
  },
  rotation: {
    required: ['record', 'row', 'phase-brief', 'worktree', 'orchestrator', 'tty', 'title', 'out'],
    optional: ['base', 'plan', 'phase', 'report', 'new-report', 'in-flight', 'decisions', 'repo'],
    paths: ['record', 'phase-brief', 'worktree', 'out', 'plan', 'report', 'new-report'],
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

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined)

const goalsValue = (goals: string | undefined, key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(goals ?? '')?.[1]?.trim() ?? ''

/** The row's tier as the agent reads it: the tier, else the model and effort the dispatch chose. */
export function tierOf(row: Row): string {
  const words = (key: string): string => (typeof row[key] === 'string' ? (row[key] as string) : '')
  const model = words('model') === '' ? '' : `model ${words('model')}${words('effort') === '' ? '' : `, effort ${words('effort')}`}`
  return [words('tier'), model].filter(part => part !== '').join(', ') || 'the host default'
}

/** A section of a markdown file: its heading line and its lines, 1-based and inclusive. */
export interface Section {
  readonly heading: string
  readonly from: number
  readonly to: number
  readonly text: string
}

const HEADING = /^(#{1,6})\s+(.*)$/

/** The first section whose heading holds `words`, up to the next heading of its level or above; undefined when none does. */
export function sectionOf(text: string, words: string): Section | undefined {
  const lines = text.split('\n')
  const at = lines.findIndex(line => HEADING.test(line) && line.includes(words))
  if (at < 0) return undefined
  const level = (HEADING.exec(lines[at] ?? '')?.[1] ?? '#').length
  let end = at + 1
  while (end < lines.length && !((HEADING.exec(lines[end] ?? '')?.[1]?.length ?? 99) <= level)) end++
  while (end > at + 1 && (lines[end - 1] ?? '').trim() === '') end--
  return { heading: (lines[at] ?? '').trim(), from: at + 1, to: end, text: lines.slice(at, end).join('\n') }
}

const where = (section: Section): string => `section « ${section.heading} », lines ${section.from}–${section.to}`

/** The spec's sections a text cites as `§<n>`, found by their heading's number; each once, in the order cited. */
export function citedSections(cites: string, spec: string): Section[] {
  const numbers = [...new Set([...cites.matchAll(/§\s?([0-9]+(?:\.[0-9]+)*)/g)].map(m => m[1] ?? ''))]
  return numbers.flatMap(n => {
    const line = spec.split('\n').find(l => new RegExp(`^#{1,6}\\s+(?:§\\s?)?${n.replace(/\./g, '\\.')}(?:[.)]?\\s|$)`).test(l))
    const found = line === undefined ? undefined : sectionOf(spec, line.replace(HEADING, '$2'))
    return found === undefined ? [] : [found]
  })
}

/** The row of the record, open, or the reason it cannot be read. */
function openRow(f: Fields): { readonly row: Row } | { readonly error: string } {
  const recordText = readText(f['record'] ?? '')
  if (recordText === undefined) return { error: `no dispatch record at ${f['record']}` }
  const row = parseRecord(recordText).find(r => String(r['id']) === f['row'])
  if (row === undefined) return { error: `row ${f['row']} is not in ${f['record']}` }
  if (row['state'] !== 'open') return { error: `row ${f['row']} is not open` }
  return { row }
}

/** The rules a build brief adds for the work's checks: the browser captures and the E2E. An investigate brief carries none. */
const buildRulesOf = (mode: string): string => mode === 'investigate' ? '' : [
  `- A frontend surface created or substantially changed is tested in a real browser with Playwright, on seeded or fixture data, its screenshots in the pull request's description, never committed. The report names the Playwright run. No secret, token, personal data, internal host or local path is visible in a capture. Audit each capture against \`${CHECKLIST}\`; the report carries \`<image>: clean\` or \`<image>: <defect>\` per image. A capture that shows a defect is not delivered: fix it, retake, audit again. A screen with no data for your account is seeded, never skipped; if you cannot, STOP. A minor change says so and why in the report.`,
  '- E2E as the pull request\'s check plan requires; the report carries `E2E: <test path(s)> — <command> — passed` or `E2E: none — <reason>`, never the description.',
].join('\n')

/** The delivery lines of a build brief: the push, the draft pull request and the turn's last line. An investigate brief carries none. */
const deliveryOf = (mode: string, branch: string, base: string, report: string): string => mode === 'investigate' ? '' : [
  `- Push with one bare command, \`git push -u origin ${branch}\`.`,
  `- Draft pull request on \`${base}\`, opened with the github tool's \`pr-create --draft\`, never \`Ready\`: that is the github ready gate's; its title and description follow the rules that tool shows; your self-review findings go in your report only. Figures once, on the final head. You never watch its checks.`,
  `- Your turn ends on \`<repo>#<pr> <head7> — <verdict> — blocking: <file:line, …|none> — report: ${report}\`, then the status line. You may be closed when your pull request is Ready: the orchestrator resumes you or starts a fresh agent for later work.`,
].join('\n')

function phaseValues(f: Fields, deps: Deps): Values {
  const found = openRow(f)
  if ('error' in found) return found
  const row = found.row
  const plan = readText(f['plan'] ?? '')
  if (plan === undefined) return { error: `no plan file at ${f['plan']}` }
  const section = f['phase'] === undefined ? undefined : sectionOf(plan, f['phase'])
  if (f['phase'] !== undefined && section === undefined) return { error: `no heading of ${f['plan']} holds « ${f['phase']} »` }
  const spec = f['spec'] ?? goalsValue(readText(goalsFileOf(f['record'] ?? '')), 'spec')
  if (spec === '') return { error: `--spec is required: no goals.md beside ${f['record']} names one` }
  const worktree = f['worktree'] ?? ''
  if (!existsSync(worktree)) return { error: `no checkout at ${worktree}` }
  const base = f['base'] ?? 'origin/main'
  const label = typeof row['label'] === 'string' ? row['label'] : ''
  const note = typeof row['note'] === 'string' && row['note'] !== '' ? ` — note: ${row['note']}` : ''
  const out = f['out'] ?? ''
  const report = f['report'] ?? join(dirname(out), `report-${basename(out)}`)
  const title = section?.heading.replace(HEADING, '$2') ?? /^# +(.+)$/m.exec(plan)?.[1]?.trim() ?? (label || basename(f['plan'] ?? ''))
  // The phase's section and the spec's sections it cites are named, so the agent reads those and not both files whole.
  const cited = section === undefined ? [] : citedSections(section.text, readText(spec) ?? '')
  return {
    PROJECT: (f['repo'] ?? projectOf(worktree, f['record'] ?? '')).split('/').at(-1) ?? '',
    TITLE: title,
    ROW_ID: f['row'] ?? '',
    MODE: f['mode'] ?? 'build',
    ROW: `${f['row']} ${label}${note}`,
    SPEC: `\`${spec}\`${cited.length === 0 ? '' : `, ${cited.map(where).join('; ')}`}`,
    PLAN: `\`${f['plan'] ?? ''}\`${section === undefined ? '' : `, ${where(section)}`}`,
    READ: section === undefined ? 'the spec, the plan' : cited.length === 0 ? 'the plan\'s section above, the spec by the sections it names' : 'the plan\'s section and the spec\'s sections above',
    SCOPE: f['scope'] === undefined ? '' : `Scope from the orchestrator: ${f['scope']}\n`,
    WORKTREE: worktree,
    BRANCH: f['branch'] ?? '',
    BASE: base,
    BASE_HEAD: deps.git(worktree, ['rev-parse', '--short=12', base]) ?? 'a head this command could not read',
    TIER: tierOf(row),
    ORCHESTRATOR: f['orchestrator'] ?? '',
    REPORT_PATH: report,
    LENS_MODEL,
    BUILD_RULES: buildRulesOf(f['mode'] ?? 'build'),
    DELIVERY: deliveryOf(f['mode'] ?? 'build', f['branch'] ?? '', base, report),
  }
}

/** At most `cap` lines, the rest counted. */
const capped = (lines: readonly string[], cap: number): string =>
  lines.length === 0 ? 'none' : [...lines.slice(0, cap), ...(lines.length > cap ? [`… and ${lines.length - cap} more`] : [])].map(line => `\n  - ${line}`).join('')

/** The last review verdict a row recorded, as one line. */
function lastGate(row: Row): string {
  const verdict = field(field(row['review'], 'verdict'), 'result')
  if (typeof verdict !== 'string') return 'none recorded'
  const head = field(field(row['review'], 'verdict'), 'head')
  const words = field(field(row['review'], 'verdict'), 'words')
  return `${verdict}${typeof head === 'string' ? ` at ${head.slice(0, 12)}` : ''}${typeof words === 'string' && words !== '' ? ` — ${words}` : ''}`
}

/** The rotation's values; the `rotate` line is the caller's to print. */
function rotationValues(f: Fields, deps: Deps): Values {
  const found = openRow(f)
  if ('error' in found) return found
  const row = found.row
  const worktree = f['worktree'] ?? ''
  if (!existsSync(worktree)) return { error: `no checkout at ${worktree}` }
  if (readText(f['phase-brief'] ?? '') === undefined) return { error: `no phase brief at ${f['phase-brief']}` }
  const base = f['base'] ?? 'origin/main'
  const branch = deps.git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'a branch this command could not read'
  const plan = f['plan'] === undefined ? undefined : readText(f['plan'])
  if (f['plan'] !== undefined && plan === undefined) return { error: `no plan file at ${f['plan']}` }
  const section = plan === undefined || f['phase'] === undefined ? undefined : sectionOf(plan, f['phase'])
  if (f['phase'] !== undefined && plan !== undefined && section === undefined) return { error: `no heading of ${f['plan']} holds « ${f['phase']} »` }
  const scope = section?.text ?? plan ?? ''
  const open = scope.split('\n').filter(line => /^\s*[-*] \[ \]/.test(line)).map(line => line.replace(/^\s*[-*] \[ \]\s*/, ''))
  const scopeAt = f['plan'] === undefined ? 'the phase brief\'s plan' : `\`${f['plan']}\`${section === undefined ? '' : `, ${where(section)}`}`
  const report = f['report'] ?? ''
  const out = f['out'] ?? ''
  const label = typeof row['label'] === 'string' ? row['label'] : ''
  return {
    PROJECT: (f['repo'] ?? projectOf(worktree, f['record'] ?? '')).split('/').at(-1) ?? '',
    TITLE: label || (f['title'] ?? ''),
    ROW_ID: f['row'] ?? '',
    PHASE_BRIEF: f['phase-brief'] ?? '',
    WORKTREE: worktree,
    BRANCH: branch,
    BASE: base,
    BASE_HEAD: deps.git(worktree, ['rev-parse', '--short=12', base]) ?? 'a head this command could not read',
    HEAD: deps.git(worktree, ['rev-parse', '--short=12', 'HEAD']) ?? 'unread',
    LANDED: capped((deps.git(worktree, ['log', '--oneline', '--no-decorate', `${base}..HEAD`]) ?? '').split('\n').filter(line => line !== ''), 30),
    UNCOMMITTED: capped((deps.git(worktree, ['status', '--porcelain']) ?? '').split('\n').filter(line => line.trim() !== ''), 20),
    IN_FLIGHT: f['in-flight'] ?? 'nothing said: the agent gave no line (gone, or nothing in flight); read the uncommitted files above',
    LAST_GATE: lastGate(row),
    LAST_REPORT: report !== '' && existsSync(report) ? `\`${report}\`` : 'none',
    REMAINING: open.length > 0 ? `The open items of ${scopeAt}:${capped(open, 30)}` : `${scopeAt}, less what Landed lists.`,
    DECISIONS: f['decisions'] ?? 'none beyond the phase brief',
    TIER: tierOf(row),
    ORCHESTRATOR: f['orchestrator'] ?? '',
    REPORT_PATH: f['new-report'] ?? join(dirname(out), `report-${basename(out)}`),
  }
}

/** The launcher's line that starts the replacement on the rotation brief and closes the old agent. */
export function rotateLine(f: Fields): string {
  const q = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
  return [LAUNCHER, 'rotate', '--old-tty', f['tty'] ?? '', '--dir', q(f['worktree'] ?? ''), '--title', q(f['title'] ?? ''),
    '--brief', q(f['out'] ?? ''), '--orchestrator', q(f['orchestrator'] ?? ''), '--right-of', 'self'].join(' ')
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
  rotation: rotationValues,
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
  if (parsed.command === 'phase' || parsed.command === 'rotation' || parsed.command === 'audit') {
    const out = parsed.command === 'audit' ? join(parsed.fields['briefs'] ?? '', `audit-${slug(parsed.fields['subject'] ?? '')}-brief.md`) : parsed.fields['out'] ?? ''
    try {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, filled)
    } catch (error) {
      return fail(`${out} cannot be written: ${(error as Error).message}`)
    }
    io.out(`${parsed.command} brief: ${out}\nreport: ${values['REPORT_PATH']}\n${parsed.command === 'rotation' ? `rotate: ${rotateLine(parsed.fields)}\n` : ''}`)
    return 0
  }
  io.out(filled.endsWith('\n') ? filled : `${filled}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo, { env: process.env, now: () => new Date(), git })
