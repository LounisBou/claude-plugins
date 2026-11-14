// A day's manifest, written beside the day file in the logs repository: what the day holds, so a
// reader can query it without reading every line. Built from the day's events alone, plus the
// local path of each session's transcript; the transcripts themselves stay on the machine.
import { simpleCommands } from '../../../../core/shell.ts'
import type { FieldSpec } from '../../../../hooks/schema.ts'

export interface SessionEntry {
  readonly session: string
  readonly role: string | null
  readonly title: string | null
  readonly project: string | null
  readonly models: readonly string[]
  readonly effort: string | null
  readonly spawned: boolean
  readonly first: string
  readonly last: string
  readonly events: number
  readonly turns: number | null
  readonly cost_usd: number | null
  readonly ended: boolean
  readonly transcript: string | null
}

export interface PullRequestRef {
  readonly repo: string | null
  readonly number: number
}

export interface DispatchEntry {
  readonly record: string
  readonly rows: readonly string[]
  readonly subs: Readonly<Record<string, number>>
}

export interface Manifest {
  readonly v: 1
  readonly day: string
  readonly machine: string
  readonly file: string
  readonly lines: number
  readonly events: Readonly<Record<string, number>>
  readonly sessions: readonly SessionEntry[]
  readonly pull_requests: readonly PullRequestRef[]
  readonly branches: readonly string[]
  readonly dispatch: readonly DispatchEntry[]
  readonly github_commands: Readonly<Record<string, number>>
}

/** The manifest's fields, declared once: the page of the schema is generated from this list. */
export const MANIFEST_FIELDS: readonly FieldSpec[] = [
  { name: 'v', type: 'number', description: 'The manifest format version, 1.' },
  { name: 'day', type: 'string', unit: 'YYYY-MM-DD UTC', description: 'The day the file holds.' },
  { name: 'machine', type: 'string', description: 'The machine that recorded it.' },
  { name: 'file', type: 'string', description: 'The day file\'s path in this repository.' },
  { name: 'lines', type: 'number', unit: 'count', description: 'Lines in the day file.' },
  { name: 'events', type: 'object', unit: 'count', description: 'Events by kind.' },
  {
    name: 'sessions',
    type: 'object[]',
    description: 'One entry per session with an event that day: `session`, `role` (null when neither the end nor the spawn says it), `title`, `project`, `models`, `effort`, `spawned`, `first` and `last` (ISO 8601 UTC), `events`, `turns`, `cost_usd` (the latest cumulative figure), `ended`, and `transcript`: the path of the session\'s transcript under the recording machine\'s Claude configuration directory (`${CLAUDE_CONFIG_DIR:-~/.claude}`), null when it is gone. The transcript is not in this repository.',
  },
  { name: 'pull_requests', type: 'object[]', description: '`{repo, number}` read from `gh pr <sub> <number>` command lines (`repo` from `-R` or `--repo`, else null) and pull request URLs. Calls of the github tool do not name theirs.' },
  { name: 'branches', type: 'string[]', description: 'Branches created, switched to or pushed by Bash command lines (`git checkout -b`, `git switch -c`, `git push`), `main` and `master` excluded.' },
  { name: 'dispatch', type: 'object[]', description: 'The dispatch record\'s writes by record file: `rows` touched and `subs`, the writes by subcommand.' },
  { name: 'github_commands', type: 'object', unit: 'count', description: 'The github tool\'s `command` arguments (`pr-gate`, `pr-merge`, …) by count.' },
]

type Fields = Record<string, unknown>

const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1
}

const PR_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g
const BRANCH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/
const TRUNKS = new Set(['main', 'master'])

/** The pull requests and branches one Bash command line names. */
function gitFacts(line: string): { prs: PullRequestRef[]; branches: string[] } {
  const prs: PullRequestRef[] = []
  const branches: string[] = []
  for (const match of line.matchAll(PR_URL)) prs.push({ repo: match[1] ?? null, number: Number(match[2]) })
  let commands: string[][]
  try {
    commands = simpleCommands(line)
  } catch {
    return { prs, branches }
  }
  for (const argv of commands) {
    const [program, sub, verb] = argv
    const rest = argv.slice(3)
    if (program === 'gh' && sub === 'pr') {
      const number = rest.find(word => /^\d+$/.test(word))
      const flag = rest.findIndex(word => word === '-R' || word === '--repo')
      const repo = flag >= 0 ? rest[flag + 1] : rest.find(word => word.startsWith('--repo='))?.slice(7)
      if (number !== undefined && verb !== undefined) prs.push({ repo: repo ?? null, number: Number(number) })
    } else if (program === 'git' && ((sub === 'checkout' && (verb === '-b' || verb === '-B')) || (sub === 'switch' && (verb === '-c' || verb === '-C')))) {
      if (rest[0] !== undefined) branches.push(rest[0])
    } else if (program === 'git' && sub === 'push') {
      const origin = argv.indexOf('origin')
      const target = origin >= 0 ? argv[origin + 1] : undefined
      if (target !== undefined) branches.push(target)
    }
  }
  return { prs, branches: branches.filter(name => !TRUNKS.has(name) && BRANCH.test(name)) }
}

interface Draft {
  role: string | null
  title: string | null
  project: string | null
  models: Set<string>
  effort: string | null
  spawned: boolean
  first: string
  last: string
  events: number
  turns: number | null
  cost: number | null
  ended: boolean
}

const alphabetical = <T>(items: Iterable<T>, key: (item: T) => string): T[] => [...items].sort((a, b) => key(a).localeCompare(key(b), 'en'))

/** The manifest of a day file's `text`; `transcript` finds a session's transcript on this machine. */
export function buildManifest(input: { day: string; machine: string; text: string; transcript: (session: string) => string | undefined }): Manifest {
  const sessions = new Map<string, Draft>()
  const events: Record<string, number> = {}
  const github: Record<string, number> = {}
  const prs = new Map<string, PullRequestRef>()
  const branches = new Set<string>()
  const dispatch = new Map<string, { rows: Set<string>; subs: Record<string, number> }>()
  let lines = 0
  for (const line of input.text.split('\n')) {
    if (line.trim() === '') continue
    lines++
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const e = record(parsed)
    const kind = text(e['event'])
    const session = text(e['session'])
    const ts = text(e['ts'])
    if (kind === undefined || session === undefined || ts === undefined) continue
    bump(events, kind)
    const at = ts.replace(/\.\d+Z$/, 'Z')
    const s = sessions.get(session) ?? { role: null, title: null, project: null, models: new Set<string>(), effort: null, spawned: false, first: at, last: at, events: 0, turns: null, cost: null, ended: false }
    sessions.set(session, s)
    s.events++
    if (at < s.first) s.first = at
    if (at >= s.last) s.last = at
    for (const model of [text(e['model']), ...(Array.isArray(e['models']) ? e['models'].map(text) : [])]) if (model !== undefined && !model.startsWith('<')) s.models.add(model)
    s.title = text(e['title']) ?? s.title
    s.project = text(e['project']) ?? s.project
    s.effort = text(e['effort']) ?? s.effort
    if (e['spawned'] === true) s.spawned = true
    const cost = num(e['cost_usd'])
    if (cost !== undefined) s.cost = cost
    if (kind === 'session_end' || kind === 'session_summary') {
      s.role = text(e['role']) ?? s.role
      s.turns = num(e['turns']) ?? s.turns
      if (kind === 'session_end') s.ended = true
    }
    if (kind === 'tool_call') {
      const server = text(e['mcp_server'])
      const command = text(e['command'])
      if (server === 'github' && command !== undefined) bump(github, command)
      const facts = gitFacts(text(record(e['bash'])['line']) ?? '')
      for (const pr of facts.prs) prs.set(`${pr.repo ?? ''}#${pr.number}`, pr)
      for (const branch of facts.branches) branches.add(branch)
    }
    if (kind === 'dispatch') {
      const file = text(e['record'])
      if (file !== undefined) {
        const entry = dispatch.get(file) ?? { rows: new Set<string>(), subs: {} }
        dispatch.set(file, entry)
        const row = text(e['row'])
        if (row !== undefined) entry.rows.add(row)
        bump(entry.subs, text(e['sub']) ?? 'unknown')
      }
    }
  }
  return {
    v: 1,
    day: input.day,
    machine: input.machine,
    file: `machines/${input.machine}/${input.day}.jsonl`,
    lines,
    events: Object.fromEntries(alphabetical(Object.entries(events), ([name]) => name)),
    sessions: [...sessions].sort(([ida, a], [idb, b]) => a.first.localeCompare(b.first) || ida.localeCompare(idb)).map(([session, s]): SessionEntry => ({
      session,
      role: s.role ?? (s.spawned ? 'agent' : null),
      title: s.title,
      project: s.project,
      models: [...s.models].sort(),
      effort: s.effort,
      spawned: s.spawned,
      first: s.first,
      last: s.last,
      events: s.events,
      turns: s.turns,
      cost_usd: s.cost,
      ended: s.ended,
      transcript: input.transcript(session) ?? null,
    })),
    pull_requests: alphabetical(prs.values(), pr => `${pr.repo ?? ''}#${String(pr.number).padStart(9, '0')}`),
    branches: [...branches].sort(),
    dispatch: alphabetical(dispatch, ([file]) => file).map(([record, d]): DispatchEntry => ({
      record,
      rows: [...d.rows].sort(),
      subs: Object.fromEntries(alphabetical(Object.entries(d.subs), ([name]) => name)),
    })),
    github_commands: Object.fromEntries(alphabetical(Object.entries(github), ([name]) => name)),
  }
}
