// hooks/commands.ts
// The commands the plugin's markdown files declare — status, progress, agents,
// and sleeping's list — answered here without a model turn: the markdown body fills a prompt
// and spends a turn gathering what it asks for, while these handlers read the
// store the supervision domain keeps and the dispatch records the launcher's
// own tool registers, and answer { text } on the spot.
//
// Why the commands are hooked rather than registered: the engine registers a
// module's commands under a bare name — letters, digits, `_` and `-`, no colon
// — and refuses a built-in's name. The bare spellings of two of these three are
// built-ins ("/status", "/agents"), so half of what this plugin wants to serve
// cannot be registered at all, while the markdown commands already hold the
// invocation spellings, the typeahead rows and the descriptions the person
// knows. A command.run hook whose matcher names a command answers for the whole
// run — its text is the output and the command beneath never runs — so the
// markdown entries stay the commands' public face and this file is their
// answer. The markdown bodies become the fallback: a handler that fails is
// skipped and its net passes the run on, so the person keeps a working command
// that spends a turn, the behaviour this file replaces rather than removes.
//
// The engine fences $ to the file that received it — never passed across an
// import — so this file spells its own env resolution, its own store read and
// its own record read, while the row parser, the staleness rule and the pane's
// row shaper cross as plain imports from the supervision domain.
import { parseSessionRow, withWait, paneRows, type PaneRow, isStale, livePidsArgv, livePids, sessionKey, type SessionRow } from './supervision.ts'
import { parseRemoteRow, withRemote, ROW_MARKER, REMOTE_STALE_AFTER_MS, type RemoteRow } from './remote-row.ts'
import { hostRecordOf, roleOf } from './session-name.ts'
import { withDeadline, isDegradedPass } from './stop-gate.ts'
import { logArgv, moduleDirOf, LOG_TIMEOUT_MS } from './module-log.ts'
import { commandForms, commandsDirOf, isBare, isOwnCopy } from './short-names.ts'

// The config dir, this file's own resolution: $ never crosses an import, so
// each domain that needs it spells the same two env reads itself.
async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
}

// The records registry's root, the shell pipeline's own contract (dispatch-record.sh:59,
// the writer that survives it): the state override first, else the config dir's
// claude-orchestrator. The writer resolves the same rule, so the reader resolves what it
// wrote or the override silences /orchestrator-progress forever. Spelled at the call site
// beside the config read it extends — $ never crosses an import — while this file's own
// artifacts, the store and the log, stay under the module's own directory (module-log.ts,
// moduleDirOf): no surviving script shares them.
async function stateDir($: any): Promise<string> {
  return (await $.env.get('ORCHESTRATOR_STATE_DIR')) ?? `${await configDir($)}/claude-orchestrator`
}

// The bound on this file's reads — the same convention the supervision domain
// inherited from the guards: well inside the time a command's answer owns, so
// a read that cannot answer in time is quietly no reading, never a held
// command. The operator's env knob turns it, milliseconds like its name says.
async function readBoundMs($: any): Promise<number> {
  const raw = await $.env.get('ORCHESTRATOR_SIDE_READ_MS')
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 2000
}

// The store's live rows, this file's own read of the same files the
// supervision domain writes: every file under the sessions directory, minus
// the dead (isStale, the store's own rule: the row's host pid is gone) and the
// unreadable (a line caught mid-write parses to no row). An absent store is no
// failure — nothing was ever written — and answers as no sessions.
async function readRows($: any): Promise<Record<string, SessionRow>> {
  const dir = `${moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store/sessions`
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return {}
  }
  const read: [string, SessionRow][] = []
  for (const entry of entries) {
    if (!entry || entry.kind !== 'file') continue
    const row = parseSessionRow(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => '')))
    // The wait an orchestrator's turn end left, read from its own file beside the row.
    if (row) read.push([entry.name, withWait(row, String(await $.fs.read(`${dir.replace(/\/sessions$/, '/waits')}/${entry.name}`).catch(() => '')))])
  }
  const argv = livePidsArgv(read.map(([, row]) => String(row.pid ?? '')))
  const ps = argv ? await withDeadline($.process.run(argv, { timeoutMs: await readBoundMs($) }), await readBoundMs($)).catch(() => null) : null
  // A liveness read that failed (null) keeps every row: it knows of no death.
  const alive = argv ? livePids(ps) : new Set<string>()
  const rows: Record<string, SessionRow> = {}
  const now = Date.now()
  for (const [name, row] of read) {
    if (!isStale(row, now, alive)) rows[`sessions/${name}`] = row
  }
  return rows
}

// The rows an orchestrator on another machine sent this coordinator (remote-row.ts), this
// file's own read of the store's remote directory, each checked again; the supervision
// domain's reader removes the stale ones, this one only skips them.
async function readRemote($: any): Promise<RemoteRow[]> {
  const dir = `${moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store/remote`
  const entries: { name: string; kind: string }[] = await $.fs.list(dir).catch(() => [])
  const rows: RemoteRow[] = []
  for (const entry of entries.slice(0, 64)) {
    if (!entry || entry.kind !== 'file' || entry.name.includes('.tmp-')) continue
    const row = parseRemoteRow(`${ROW_MARKER}${String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))}`)
    if (row) rows.push(row)
  }
  return rows
}

// One line of the sessions table: the four columns, and what follows them unaligned
// (the gate words, the wait a row carries).
type SessionLine = { name: string; role: string; context: string; measured: string; note: string }

// The sessions as a table under a header line, the columns padded to their widest cell and the
// context right-aligned, so the fills compare at a glance. Two spaces indent every line.
function sessionTable(lines: readonly SessionLine[]): string[] {
  const head: SessionLine = { name: 'name', role: 'role', context: 'context', measured: 'last measured', note: '' }
  const all = [head, ...lines]
  const width = (pick: (line: SessionLine) => string) => Math.max(...all.map(line => pick(line).length))
  const [nameW, roleW, contextW, measuredW] = [width(l => l.name), width(l => l.role), width(l => l.context), width(l => l.measured)]
  return all.map(line => `  ${[
    line.name.padEnd(nameW), line.role.padEnd(roleW), line.context.padStart(contextW), line.measured.padEnd(measuredW),
  ].join('  ')}${line.note === '' ? '' : `  ${line.note}`}`.trimEnd())
}

// A pane row as a table line: the gate words and the wait follow the aligned columns.
function lineOfRow(row: PaneRow): SessionLine {
  return {
    name: row.name, role: row.head, context: row.percent, measured: row.age ?? '',
    note: [row.past ? 'past the gate' : null, row.wait].filter(part => part !== null).join(' · '),
  }
}

// What /orchestrator-status says: the pane's own rows as a table, the urgent
// first — the sessions past the rotation gate lead, each side by fill — under a
// header line naming the columns, the same rows the supervision pane draws
// beside this store.
export function statusText(rows: Record<string, SessionRow>): string {
  const lines = paneRows(rows).map(lineOfRow)
  if (lines.length === 0) return 'Live sessions: none measured yet.'
  return [`Live sessions (${lines.length}), most urgent first:`, ...sessionTable(lines)].join('\n')
}

// What /orchestrator-agents says: the same rows cut to the implementer agents
// alone — the role the dispatching domains spawn — shaped and sorted the same
// way, so a coordinator's or an auditor's own fill never crowds the agents out.
//
// An agent is measured at the end of its turns, so one still in its first turn
// has no row: the host's own records of the live sessions name it, and it is
// listed last as not measured yet — « none running » beside a working agent
// was the answer an orchestrator read while its agent worked.
export type UnmeasuredAgent = { name: string; status: 'idle' | 'busy' | null }

export function agentsText(rows: Record<string, SessionRow>, unmeasured: readonly UnmeasuredAgent[] = []): string {
  const agents: Record<string, SessionRow> = {}
  for (const [key, row] of Object.entries(rows)) {
    if (row.role === 'agent') agents[key] = row
  }
  const lines = [
    ...paneRows(agents).map(lineOfRow),
    ...unmeasured.map(agent => ({ name: agent.name, role: 'agent', context: agent.status ?? 'status unknown', measured: 'not measured yet', note: '' })),
  ]
  if (lines.length === 0) return 'Implementer agents: none running.'
  return [`Implementer agents (${lines.length}), most urgent first:`, ...sessionTable(lines)].join('\n')
}

// The live agents the store has no row for: the host's records of its sessions
// (<config>/sessions/<pid>.json), each pid checked alive by one ps, kept when
// the name reads as an agent and no live row carries its session.
async function unmeasuredAgents($: any, rows: Record<string, SessionRow>): Promise<UnmeasuredAgent[]> {
  const dir = `${await configDir($)}/sessions`
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const records: [string, ReturnType<typeof hostRecordOf>][] = []
  for (const entry of entries) {
    const pid = entry && entry.kind === 'file' ? (entry.name.match(/^(\d+)\.json$/) ?? [])[1] : undefined
    if (!pid) continue
    records.push([pid, hostRecordOf(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => '')))])
  }
  const argv = livePidsArgv(records.map(([pid]) => pid))
  const ps = argv ? await withDeadline($.process.run(argv, { timeoutMs: await readBoundMs($) }), await readBoundMs($)).catch(() => null) : null
  // A liveness read that failed (null) keeps every record: an agent in its
  // first turn listed beside a stale record beats one hidden by a failed ps.
  const alive = argv ? livePids(ps) : new Set<string>()
  const agents: UnmeasuredAgent[] = []
  for (const [pid, record] of records) {
    if (!record || !record.sessionId || (alive !== null && !alive.has(pid)) || roleOf(record.name) !== 'agent') continue
    if (sessionKey(record.sessionId) in rows) continue
    agents.push({ name: record.name as string, status: record.status })
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name))
}

// One row of a dispatch record, the launcher's own schema cut to what the text
// needs: the identity, the label, the state and the rounds it cost. A line
// that is no row (torn by a write in flight, or holding no numeric id) is no
// row — the measure-file doctrine the whole store already reads by.
export type DispatchRow = { id: number; label: string; state: string; rounds: number }

export function parseDispatchRow(line: string): DispatchRow | null {
  try {
    const row = JSON.parse(line) as Partial<DispatchRow>
    if (!row || typeof row !== 'object' || typeof row.id !== 'number') return null
    return {
      id: row.id,
      label: typeof row.label === 'string' ? row.label : '',
      state: typeof row.state === 'string' ? row.state : '',
      rounds: typeof row.rounds === 'number' ? row.rounds : 0,
    }
  } catch {
    return null
  }
}

// What /orchestrator-progress says, one record file per group: the rows still
// open first — in flight, deferred, decisions pending; a successor reads them
// as work, never as history — then the tally the record's own summary shapes
// (dispatches, closed, rounds to the one decimal). An empty label keeps its
// row and is named for what it is; no group at all is said as that.
//
// The goals lines lead: one `goals met=m/n … open=…` per record that has a goals.md, the
// distance to the spec one command away at any moment.
export function progressLines(groups: readonly DispatchRow[][], goals: readonly string[] = []): string[] {
  const rows = groups.flat()
  if (rows.length === 0) return goals.length > 0 ? [...goals, 'no dispatch yet'] : ['no dispatch record registered']
  const lines = [...goals, ...rows
    .filter(row => row.state === 'open')
    .map(row => `open=${row.id} label=${row.label === '' ? 'no label' : row.label}`)]
  const closed = rows.filter(row => row.state === 'closed').length
  const avg = Math.round((rows.reduce((sum, row) => sum + row.rounds, 0) / rows.length) * 10) / 10
  lines.push(`dispatches=${rows.length} closed=${closed} rounds_avg=${avg}`)
  return lines
}

// The records this session registered — the launcher's dispatch tool writes
// one absolute path a line under the records directory, keyed by the session
// id sanitised the way every key in the store is, under the root that tool
// itself resolves (the override or the config dir). Each record is read under
// the bound; a record that cannot answer in time, or is missing, or torn
// contributes no rows (the stop gate reads them the same way), and a registry
// that itself loses the race is said as unreadable rather than as absent.
async function progressText($: any): Promise<string> {
  const id = await $.session.id()
  const registry = `${await stateDir($)}/records/${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
  const bound = await readBoundMs($)
  const listed = await withDeadline($.fs.read(registry).catch(() => ''), bound)
  if (isDegradedPass(listed)) {
    await logLine($, 'the dispatch record registry did not answer in time')
    return 'the dispatch record did not answer in time'
  }
  const groups: DispatchRow[][] = []
  const goals: string[] = []
  const seen = new Set<string>()
  for (const path of String(listed).split('\n')) {
    if (path === '') continue
    const goalsFile = `${path.split('/').slice(0, -1).join('/')}/goals.md`
    if (!seen.has(goalsFile)) {
      seen.add(goalsFile)
      const line = await goalsLine($, goalsFile, bound)
      if (line) goals.push(line)
    }
    const read = await withDeadline($.fs.read(path).catch(() => ''), bound)
    if (isDegradedPass(read)) continue
    groups.push(String(read).split('\n').map(parseDispatchRow).filter((row): row is DispatchRow => row !== null))
  }
  return progressLines(groups, goals).join('\n')
}

// One sleeping orchestrator, as coordinator.sh's sleep writes it into <state>/sleeping.json.
export type SleepingRecord = { name: string; slept: string; dir: string; prs: string[]; brief: string }

// The record parsed, or null when it is no array: an unreadable record is said, never read
// as « none sleeping », since an orchestrator read as absent is one the operator loses.
export function parseSleeping(text: string): SleepingRecord[] | null {
  if (text.trim() === '') return []
  try {
    const all = JSON.parse(text)
    if (!Array.isArray(all)) return null
    return all.filter(r => r && typeof r === 'object' && typeof r.name === 'string').map(r => ({
      name: r.name,
      slept: typeof r.slept === 'string' ? r.slept : '',
      dir: typeof r.dir === 'string' ? r.dir : '',
      prs: Array.isArray(r.prs) ? r.prs.map(String) : [],
      brief: typeof r.brief === 'string' ? r.brief : '',
    }))
  } catch {
    return null
  }
}

// What /orchestrator-sleeping says with no argument: each sleeping orchestrator in the order
// they went to sleep, one field per line — name, slept since, directory, open pull requests,
// brief — indented, the labels bold and aligned, a blank line between two records.
export function sleepingText(records: SleepingRecord[] | null, path: string): string {
  if (records === null) return `The sleeping record ${path} cannot be read: repair or remove it.`
  if (records.length === 0) return 'Sleeping orchestrators: none.'
  const labels = ['name', 'slept since', 'directory', 'open pull requests', 'brief']
  const width = Math.max(...labels.map(label => label.length))
  const block = (r: SleepingRecord) => [r.name, r.slept, r.dir, r.prs.length > 0 ? r.prs.join(', ') : 'none', r.brief]
    .map((value, i) => `  **${labels[i]}**${' '.repeat(width - labels[i].length)}  ${value}`)
  return [`Sleeping orchestrators (${records.length}):`, ...records.flatMap((r, i) => [...(i > 0 ? [''] : []), ...block(r)])].join('\n')
}

async function readSleeping($: any): Promise<string> {
  const path = `${await stateDir($)}/sleeping.json`
  const exists = await withDeadline(Promise.resolve($.fs.exists(path)).catch(() => false), await readBoundMs($))
  if (exists !== true) return sleepingText([], path)
  const read = await withDeadline($.fs.read(path), await readBoundMs($))
  if (isDegradedPass(read)) throw new Error(`the sleeping record ${path} did not answer in time`)
  return sleepingText(parseSleeping(String(read)), path)
}

// The goals line of one goals.md, goals.py's own (`goals met=m/n ruled_out=k open=… unplanned=…`),
// or null when there is no file, or its reading failed or ran out of time.
async function goalsLine($: any, goalsFile: string, bound: number): Promise<string | null> {
  const exists = await withDeadline(Promise.resolve($.fs.exists(goalsFile)).catch(() => false), bound)
  if (exists !== true) return null
  const done = await withDeadline(
    $.process.run(['python3', `${$.plugin.root}/skills/orchestrator/scripts/goals.py`, 'line', goalsFile], { timeoutMs: bound }),
    bound,
  ).catch(() => null)
  if (!done || isDegradedPass(done) || done.exitCode !== 0) {
    await logLine($, `the goals of ${goalsFile} could not be read`)
    return null
  }
  const line = String(done.stdout ?? '').trim()
  return line.startsWith('goals ') ? line : null
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // Each matcher names one form the host hands the hook (short-names.ts, measured live): the
  // plugin's command as `orchestrator:<file>`, the 0.80.0 `orchestrator:<short>`, and the bare
  // `<short>` of the user command the installer writes, answered only when that copy is this
  // plugin's — the operator's own command of the same name runs as he wrote it. The envelope's
  // own command field is the key a matcher narrows on, so each hook answers its command's run
  // alone, never another plugin's and never the host's own commands. The engine validates
  // neither key nor field; the wiring tests pin the exact objects.
  for (const command of commandForms('status', 'orchestrator-status')) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      if (!(await ownRun($, e))) return next(e)
      return { text: statusText(withRemote(await readRows($), await readRemote($), Date.now(), REMOTE_STALE_AFTER_MS)) }
    }).catch(fallBack)
  }

  for (const command of commandForms('progress', 'orchestrator-progress')) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      if (!(await ownRun($, e))) return next(e)
      return { text: await progressText($) }
    }).catch(fallBack)
  }

  // The list alone is answered here; `drop <name>` asks the operator to confirm, which
  // takes a model turn, so any argument passes the run on to the markdown command.
  for (const command of commandForms('sleeping', 'orchestrator-sleeping')) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      if (String(e?.args ?? '').trim() !== '' || !(await ownRun($, e))) return next(e)
      return { text: await readSleeping($) }
    }).catch(fallBack)
  }

  for (const command of commandForms('agents', 'orchestrator-agents')) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      if (!(await ownRun($, e))) return next(e)
      const rows = await readRows($)
      return { text: agentsText(rows, await unmeasuredAgents($, rows)) }
    }).catch(fallBack)
  }
}

// A command whose reader failed is skipped; the net lets the markdown command run as it
// always did, and the failure is said.
async function fallBack($: any, e: any, next: any) {
  await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
  return next(e)
}

// A prefixed run is the plugin's own command; a bare one is answered only when its user
// command is this plugin's copy, read through this file's own $.fs.
async function ownRun($: any, e: any): Promise<boolean> {
  const command = String(e?.command ?? '')
  if (!isBare(command)) return true
  const dir = commandsDirOf(await $.env.get('ORCHESTRATOR_COMMANDS_DIR'), await configDir($))
  return isOwnCopy(String(await $.fs.read(`${dir}/${command}.md`).catch(() => '')))
}

// One line appended to the module's log (module-log.ts): the stamp names the
// half that failed. Never throws, never blocks the command it serves.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = await configDir($)
    await $.process.run(logArgv($.plugin.root, config, 'commands', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the command that failed */ }
}
