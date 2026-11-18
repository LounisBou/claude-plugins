// hooks/tests/ledger.test.ts
// The pull request ledger line written at creation (core's pr-ledger.ts): a pull request opened through
// the github tool or `gh pr create`, in any repository, takes its line in the dispatch record of the
// orchestration the creating session belongs to — an agent's, its orchestrator's — once; a session of
// no orchestration writes nothing, and a write that fails changes nothing of the tool's answer.
import { expect, test } from 'claude-code/testing'
import { createdPr, prWake, register } from '../ledger.ts'
import { logLineOf, lockRun, prQueryRun } from './fakes.ts'
import { prWantedPath } from '../pr-file-format.ts'
import { capture, hooksOn, hostOf, type Captured } from '../../core/capture.ts'
import type { CatchHook, Events, Hook, Host, Noun } from '../../core/host.ts'

const HOME = '/tmp/ledger-home'
const STATE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/briefs/app/dispatch-record.jsonl'
const ORCH = 'Orch: app'
const AGENT = 'Agent: ledger'
const AT = '2026-11-14T10:15:00Z'
const ROW_AT = '2026-11-14T10:00:00.000Z'

const row = (role: string, name: string, tty: string | null = null) =>
  JSON.stringify({ role, name, tty, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: ROW_AT })
const ledgerLine = (pr: number, status: string, detail: Record<string, string>, repo = 'acme/app') =>
  JSON.stringify({ v: 1, ledger: 'pr', repo, pr, status, ...detail, since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:30:00Z' })
const ROWS = `${JSON.stringify({ id: 1, state: 'open', label: 'a row' })}\n${ledgerLine(7, 'working', { agent: 'Agent: seven' })}\n`

type Over = {
  session?: string
  reportsTo?: string | null
  chain?: boolean
  rows?: Record<string, string>
  readOnly?: boolean
  // A line another writer sets after the record was first read.
  race?: string
  // The forge's open pull requests by repository (prQueryRun), and those asked by number it reads closed.
  forge?: Record<string, string>
  closed?: Record<string, Record<number, 'MERGED' | 'CLOSED'>>
  // What the launcher's `list` prints: the agents running (empty when none is given); null when it cannot be read.
  launcher?: string | null
}

// The orchestrator s-orch (its record registered, owned), the agent s-agent on /dev/ttys005 launched for it.
function fake(over: Over = {}) {
  const files = new Map<string, string>([
    [`${STATE}/store/sessions/s-orch`, row('orchestrator', ORCH, '/dev/ttys001')],
    [`${STATE}/store/sessions/s-agent`, row('agent', AGENT, '/dev/ttys005')],
    [`${STATE}/records/s-orch`, `${RECORD}\n`],
    [`${RECORD}.owner`, `${ORCH}\n`],
    [RECORD, ROWS],
    [`${HOME}/.claude/sessions/400.json`, JSON.stringify({ pid: 400, sessionId: 's-orch', name: ORCH, startedAt: 1 })],
  ])
  if (over.chain) files.set(`${STATE}/chains/ttys001.jsonl`, `${JSON.stringify({ tab_id: 'tab-a', tty: '/dev/ttys005', owner: 'own' })}\n`)
  for (const [path, text] of Object.entries(over.rows ?? {})) files.set(path, text)
  const logged: string[] = []
  const runs: string[][] = []
  const reportsTo = over.reportsTo === undefined ? `${ORCH} [a1b2c3]` : over.reportsTo
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : name === 'ORCHESTRATOR_REPORTS_TO' ? reportsTo ?? undefined : undefined) },
    session: { id: async () => over.session ?? 's-agent' },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        const text = files.get(p)!
        if (over.race !== undefined && p === RECORD && !text.includes(over.race)) files.set(p, `${text}${over.race}\n`)
        return text
      },
      write: async (p: string, text: string) => { if (over.readOnly && p.includes('dispatch-record')) throw new Error('disk full'); files.set(p, text) },
      exists: async (p: string) => files.has(p),
      stat: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return { kind: 'file' as const, size: files.get(p)!.length, mtimeMs: 1 } },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, isLink: false, mtimeMs: 0 })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logged.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        runs.push([...argv])
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'bash' && argv[2] === 'list') return over.launcher === null ? { exitCode: 1, stdout: '', stderr: 'no terminal' } : { exitCode: 0, stdout: over.launcher ?? '', stderr: '' }
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        const asked = prQueryRun(argv, repo => over.forge?.[repo] ?? null, over.closed)
        if (asked !== null) return asked
        return { exitCode: argv[0] === 'ps' ? 1 : 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, files, logged, runs }
}

type World = Host<Noun>
type ToolCall = Events['tool.call']

// The tool-call hooks by the tool their matcher names, with their nets.
function byTool(hooks: ReadonlyArray<Captured<World>>) {
  const handlers: Record<string, Hook<World, ToolCall>> = {}
  const nets: Record<string, CatchHook<World, ToolCall>> = {}
  for (const hook of hooksOn(hooks, 'tool.call')) {
    const tool = String(hook.matcher?.['tool'])
    handlers[tool] = hook.handler
    if (hook.net !== undefined) nets[tool] = hook.net
  }
  return { handlers, nets }
}

function mounted() {
  return byTool(capture<World>(on => register(on, () => new Date('2026-11-14T10:15:00.400Z')))).handlers
}

const github = (extra: object = {}) => ({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 't', draft: true }, ...extra })
const created = (url: string) => ({ result: JSON.stringify({ number: Number(url.split('/').pop()), html_url: url }) })
const ledgerOf = (files: Map<string, string>, path = RECORD) =>
  (files.get(path) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.ledger === 'pr')
const call = async (handlers: Record<string, Hook<World, ToolCall>>, dollar: World, e: ToolCall, answer: unknown) =>
  handlers[String(e['tool'])]!(dollar, e, async () => answer)

test('a pull request opened through the github tool takes its line in its orchestrator\'s record, as its agent works it', async () => {
  const { dollar, files } = fake()
  const answer = created('https://github.com/acme/app/pull/12')
  expect(await call(mounted(), dollar, github(), answer)).toEqual(answer)
  expect(ledgerOf(files).filter(l => l.pr === 12)).toEqual([{ v: 1, ledger: 'pr', repo: 'acme/app', pr: 12, status: 'working', agent: AGENT, since: AT, updated: AT }])
  // The rows and the other lines stay as they were.
  expect(files.get(RECORD)!.startsWith(ROWS)).toBe(true)
})

test('a Bash `gh pr create` whose result names the pull request takes its line, in any repository', async () => {
  const { dollar, files } = fake()
  const handlers = mounted()
  const out = { result: 'Creating pull request for feat/x into main in other/lib\n\nhttps://github.com/other/lib/pull/3\n' }
  await call(handlers, dollar, { tool: 'Bash', command: 'git push -u origin feat/x ; gh pr create -R other/lib --draft --title t --body-file /tmp/b' }, out)
  expect(ledgerOf(files).filter(l => l.pr === 3)).toEqual([{ v: 1, ledger: 'pr', repo: 'other/lib', pr: 3, status: 'working', agent: AGENT, since: AT, updated: AT }])
})

test('what is no creation writes nothing: another command, another github command, a failed call, an answer naming no pull request', async () => {
  const { dollar, files } = fake()
  const handlers = mounted()
  const url = 'https://github.com/acme/app/pull/12'
  const before = files.get(RECORD)
  await call(handlers, dollar, { tool: 'Bash', command: 'gh pr view 12' }, { result: url })
  await call(handlers, dollar, { tool: 'Bash', command: 'echo "gh pr create"' }, { result: url })
  await call(handlers, dollar, { tool: 'Bash', command: 'gh pr create --title t' }, { result: 'HTTP 422', isError: true })
  await call(handlers, dollar, { tool: 'Bash', command: 'gh pr create --title t' }, { result: 'a pull request already exists' })
  await call(handlers, dollar, github(), { result: url, isError: true })
  await call(handlers, dollar, github({ command: 'pr-list' }), { result: url })
  await call(handlers, dollar, github({ command: 'pr-update' }), { result: url })
  await call(handlers, dollar, github(), { deny: 'refused by a guard' })
  expect(files.get(RECORD)).toBe(before)
})

test('the pull request an orchestrator opens itself takes its line in its own record', async () => {
  const { dollar, files } = fake({ session: 's-orch', reportsTo: null })
  await call(mounted(), dollar, github(), created('https://github.com/acme/app/pull/13'))
  expect(ledgerOf(files).filter(l => l.pr === 13).map(l => [l.status, l.agent])).toEqual([['working', ORCH]])
})

test('an agent launched with no recorded orchestrator is read through the launcher\'s chain', async () => {
  const { dollar, files } = fake({ reportsTo: null, chain: true })
  await call(mounted(), dollar, github(), created('https://github.com/acme/app/pull/14'))
  expect(ledgerOf(files).filter(l => l.pr === 14).map(l => l.agent)).toEqual([AGENT])
})

test('a session of no orchestration writes nothing and says nothing', async () => {
  const lone = fake({ reportsTo: null })
  const answer = created('https://github.com/acme/app/pull/15')
  expect(await call(mounted(), lone.dollar, github(), answer)).toEqual(answer)
  const unknown = fake({ session: 's-nobody' })
  await call(mounted(), unknown.dollar, github(), answer)
  const coordinator = fake({ session: 's-coord', rows: { [`${STATE}/store/sessions/s-coord`]: row('coordinator', 'Coord: all') } })
  await call(mounted(), coordinator.dollar, github(), answer)
  for (const world of [lone, unknown, coordinator]) {
    expect(world.files.get(RECORD)).toBe(ROWS)
    expect(world.logged).toEqual([])
  }
})

test('a pull request that has its line keeps it as it is, and a repeated creation adds none', async () => {
  const { dollar, files } = fake()
  const handlers = mounted()
  await call(handlers, dollar, github(), created('https://github.com/acme/app/pull/7'))
  expect(files.get(RECORD)).toBe(ROWS)
  await call(handlers, dollar, github(), created('https://github.com/acme/app/pull/16'))
  const once = files.get(RECORD)
  await call(handlers, dollar, github(), created('https://github.com/acme/app/pull/16'))
  expect(files.get(RECORD)).toBe(once)
  expect(ledgerOf(files).filter(l => l.pr === 16)).toHaveLength(1)
})

test('a line another record of the orchestration holds, or another writer sets meanwhile, is kept: none is written over it', async () => {
  const second = '/briefs/app/second-record.jsonl'
  const held = fake({ rows: { [`${STATE}/records/s-orch`]: `${RECORD}\n${second}\n`, [`${second}.owner`]: `${ORCH}\n`, [second]: `${ledgerLine(19, 'parked', { ruling: 'later, 2026-11-14' })}\n` } })
  await call(mounted(), held.dollar, github(), created('https://github.com/acme/app/pull/19'))
  expect(held.files.get(RECORD)).toBe(ROWS)
  const racing = fake({ race: ledgerLine(20, 'waiting', { on: 'la CI' }) })
  await call(mounted(), racing.dollar, github(), created('https://github.com/acme/app/pull/20'))
  expect(ledgerOf(racing.files).filter(l => l.pr === 20).map(l => [l.status, l.on])).toEqual([['waiting', 'la CI']])
})

test('the line goes to a record its orchestration owns, never to another\'s', async () => {
  const other = '/briefs/web/dispatch-record.jsonl'
  const { dollar, files } = fake({ rows: {
    [`${STATE}/records/s-orch`]: `${other}\n${RECORD}\n`,
    [`${other}.owner`]: 'Orch: web\n',
    [other]: '',
  } })
  await call(mounted(), dollar, github(), created('https://github.com/acme/app/pull/17'))
  expect(files.get(other)).toBe('')
  expect(ledgerOf(files).filter(l => l.pr === 17)).toHaveLength(1)
})

test('a write that fails leaves the tool\'s answer as it was, says so in the log, and never throws', async () => {
  const { dollar, files, logged } = fake({ readOnly: true })
  const answer = created('https://github.com/acme/app/pull/18')
  expect(await call(mounted(), dollar, github(), answer)).toEqual(answer)
  expect(ledgerOf(files).filter(l => l.pr === 18)).toEqual([])
  expect(logged.some(l => l.includes('ledger'))).toBe(true)
})

test('the pull request a creation names is read from the answer: the last address of a pull request', () => {
  expect(createdPr({ tool: 'mcp__github__gh', command: 'pr-create' }, { result: '{"html_url":"https://github.com/Acme/App/pull/9"}' })).toEqual({ repo: 'Acme/App', pr: 9 })
  const body = 'Ships after https://github.com/a/b/pull/5'
  expect(createdPr({ tool: 'mcp__github__gh', command: 'pr-create' }, { result: JSON.stringify({ html_url: 'https://github.com/a/b/pull/6', body }) })).toEqual({ repo: 'a/b', pr: 6 })
  expect(createdPr({ tool: 'Bash', command: 'FOO=1 gh pr create -R a/b' }, { result: 'warning: see https://github.com/a/b/pull/1\nhttps://github.com/a/b/pull/20\n' })).toEqual({ repo: 'a/b', pr: 20 })
  expect(createdPr({ tool: 'Bash', command: 'cd x && gh pr create' }, { result: 'https://github.com/a/b/pull/21' })).toEqual({ repo: 'a/b', pr: 21 })
  expect(createdPr({ tool: 'Bash', command: 'gh pr create-draft' }, { result: 'https://github.com/a/b/pull/21' })).toBe(null)
  expect(createdPr({ tool: 'Bash', command: 'gh pr create' }, undefined)).toBe(null)
})

// Every way the shell can be made to run `gh pr create`: the rewrite this machine gives each Bash `gh`
// (`rtk gh …`), gh's repository option before or after the noun, and the commands that wrap another.
const CREATIONS = [
  'rtk gh pr create --draft --title t',
  'gh --repo o/r pr create --title t',
  'gh -R o/r pr create --title t',
  'gh -Ro/r pr create --title t',
  'gh pr --repo=o/r create --title t',
  'gh pr -R o/r create --title t',
  'if true; then\n  gh pr create --title t\nfi',
  'time gh pr create --title t',
  'sudo gh pr create --title t',
  'env GH_TOKEN=x gh pr create --title t',
  '/usr/bin/env gh pr create --title t',
  'bash -c "gh pr create --title t"',
  'cd /repo && rtk gh pr create --title t',
]
for (const command of CREATIONS) {
  test(`the Bash command \`${command.replace(/\n/g, ' ')}\` is a creation`, () => {
    expect(createdPr({ tool: 'Bash', command }, { result: 'https://github.com/o/r/pull/30' })).toEqual({ repo: 'o/r', pr: 30 })
  })
}

test('a Bash command that only names or lists `gh pr create` is no creation', () => {
  for (const command of ['git commit -m "gh pr create"', 'rtk gh pr view 3', 'gh pr list --search "gh pr create"', 'gh issue create', 'rtk gh pr create-draft', 'gh pr', 'cat <<EOF\ngh pr create\nEOF']) {
    expect(createdPr({ tool: 'Bash', command }, { result: 'https://github.com/o/r/pull/30' })).toBe(null)
  }
})

test('a command line the shell reader cannot read is no creation, and throws nothing', () => {
  expect(createdPr({ tool: 'Bash', command: 'echo {1..5000}; gh pr create' }, { result: 'https://github.com/o/r/pull/30' })).toBe(null)
})

// The registrations with their safety nets, and the write's bound set short enough to wait for.
function mountedWithNets(bound: number) {
  return byTool(capture<World>(on => register(on, () => new Date('2026-11-14T10:15:00.400Z'), bound)))
}

test('a write that never settles is given up at the bound: the answer goes on, one line says so, nothing is written', async () => {
  const { dollar, files, logged } = fake()
  dollar.session.id = () => new Promise<string>(() => undefined)
  const answer = created('https://github.com/acme/app/pull/40')
  const before = files.get(RECORD)
  expect(await call(mountedWithNets(20).handlers, dollar, github(), answer)).toEqual(answer)
  expect(files.get(RECORD)).toBe(before)
  expect(logged.some(l => l.includes('ledger') && l.includes('acme/app#40') && l.includes('did not finish within 20 ms'))).toBe(true)
})

test('a tool call that throws is caught by the hook\'s net: one log line, the call handed on as it was', async () => {
  const { dollar, logged } = fake()
  const { handlers, nets } = mountedWithNets(20)
  const e = github()
  await expect(handlers['mcp__github__gh']!(dollar, e, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  const passed: unknown[] = []
  const next = Object.assign(async (x: unknown) => { passed.push(x); return { passed: x } }, { called: false, error: { kind: 'failure', message: 'boom' } })
  expect(await nets['mcp__github__gh']!(dollar, e, next)).toEqual({ passed: e })
  expect(passed).toEqual([e])
  expect(logged.some(l => l.includes('ledger') && l.includes('unhandled (failure): boom'))).toBe(true)
})

// An agent a coordinator launched: its launch record names the coordinator's session, which is no
// orchestrator and owns no orchestration.
const COORD = 'Coord: all'
const coordinated = (records: string, files: Record<string, string> = {}) => fake({
  reportsTo: `${COORD} [a1b2c3]`,
  rows: {
    [`${STATE}/store/sessions/s-coord`]: row('coordinator', COORD),
    [`${HOME}/.claude/sessions/401.json`]: JSON.stringify({ pid: 401, sessionId: 's-coord', name: COORD, startedAt: 2 }),
    [`${STATE}/records/s-coord`]: records,
    ...files,
  },
})

test('the pull request of an agent a coordinator launched takes no line, whatever record the coordinator registered', async () => {
  const unowned = '/briefs/all/dispatch-record.jsonl'
  const world = coordinated(`${unowned}\n`, { [unowned]: ROWS })
  await call(mounted(), world.dollar, github(), created('https://github.com/acme/app/pull/50'))
  expect(world.files.get(unowned)).toBe(ROWS)
  expect(world.files.get(RECORD)).toBe(ROWS)
})

test('a session that is no orchestrator\'s is no orchestration, even one that bears an orchestration\'s name and registered its record', async () => {
  const world = fake({
    reportsTo: `${ORCH} [a1b2c3]`,
    rows: { [`${STATE}/store/sessions/s-orch`]: row('coordinator', ORCH, '/dev/ttys001') },
  })
  await call(mounted(), world.dollar, github(), created('https://github.com/acme/app/pull/51'))
  expect(world.files.get(RECORD)).toBe(ROWS)
})

test('a record that has no owner is no orchestration\'s: the line is not written into it', async () => {
  const world = fake({ rows: { [`${STATE}/records/s-orch`]: '/briefs/app/loose-record.jsonl\n', '/briefs/app/loose-record.jsonl': ROWS } })
  await call(mounted(), world.dollar, github(), created('https://github.com/acme/app/pull/52'))
  expect(world.files.get('/briefs/app/loose-record.jsonl')).toBe(ROWS)
  const own = fake({ session: 's-orch', reportsTo: null, rows: { [`${STATE}/records/s-orch`]: '/briefs/app/loose-record.jsonl\n', '/briefs/app/loose-record.jsonl': ROWS } })
  await call(mounted(), own.dollar, github(), created('https://github.com/acme/app/pull/53'))
  expect(own.files.get('/briefs/app/loose-record.jsonl')).toBe(ROWS)
})

test('an orchestrator whose name names no orchestration owns no record, an unowned one included', async () => {
  const loose = '/briefs/app/loose-record.jsonl'
  const world = fake({ session: 's-orch', reportsTo: null, rows: {
    [`${STATE}/store/sessions/s-orch`]: row('orchestrator', 'nameless', '/dev/ttys001'),
    [`${STATE}/records/s-orch`]: `${loose}\n`,
    [loose]: ROWS,
  } })
  await call(mounted(), world.dollar, github(), created('https://github.com/acme/app/pull/54'))
  expect(world.files.get(loose)).toBe(ROWS)
})

// A pull request of the orchestration, merged or closed wherever it was, and the open rows of its record that wait on it.
const WAITERS = [
  JSON.stringify({ id: 2, state: 'closed', label: 'P17 scraper', note: 'Dispatched 2026-11-15: Agent: p17' }),
  JSON.stringify({ id: 3, state: 'open', label: 'P18 cache', blocker: 'PR acme/app#17 merged', note: 'Dispatched 2026-11-15: Agent: p18' }),
  JSON.stringify({ id: 4, state: 'open', label: 'P19 ui', blocker: 'none', note: 'stacked on app#17, merge main once it lands' }),
  JSON.stringify({ id: 5, state: 'closed', label: 'P16', blocker: 'PR acme/app#17 merged' }),
  JSON.stringify({ id: 6, state: 'open', label: 'later', blocker: 'PR acme/app#17 merged', deferred: 'later, 2026-11-15' }),
  JSON.stringify({ id: 7, state: 'open', label: 'other repo', blocker: 'PR acme/lib#17 merged' }),
  ledgerLine(17, 'working', { agent: 'Agent: p17' }),
].join('\n') + '\n'

// The launcher's listing with the agents named running, each in a tab whose title carries the host's glyph.
const running = (...agents: string[]) => agents.map((name, n) => `w1/t${n} | /dev/ttys00${n} | ✳ ${name} | ${name}`).join('\n')

test('a pull request merged outside the session wakes its orchestrator with its agent to close and the open rows waiting on it; its line archived once told', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([
    '[module] acme/app#17 merged: its agent Agent: p17 is done with it, close it.',
    '[module] acme/app#17 merged; open rows waiting on it: row 3 « P18 cache » (Agent: p18), row 4 « P19 ui ». Tell each one\'s agent now.',
  ])
  expect(woke.watching).toBe(false)
  expect(world.files.get(RECORD)).toContain('"pr":17')
  await woke.settle()
  expect(world.files.get(RECORD)).not.toContain('"pr":17')
  expect(world.files.get('/briefs/app/dispatch-record.archive.jsonl')).toContain('"pr":17')
  // Told and archived: the next tick has nothing to say.
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a merge says nothing of closing an agent the close command already closed: the launcher no longer lists it', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines[0]).toBe('[module] acme/app#17 merged.')
  expect(woke.lines.join('\n')).not.toContain('close it')
})

test('a merge says its agent still holds the open row that waits on it, or another pull request of its own, and never to close it', async () => {
  const other = ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')
  const holds = JSON.stringify({ id: 8, state: 'open', label: 'P17 follow-up', blocker: 'PR acme/app#17 merged', note: 'Dispatched 2026-11-15: Agent: p17' })
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${holds}\n${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n${other}\n` }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines[0]).toBe('[module] acme/app#17 merged: its agent Agent: p17 still holds row 8 (app), acme/lib#21; tell it, do not close it.')
  expect(woke.lines.join('\n')).not.toContain('is done with it, close it')
})

test('a merge says close it when the launcher cannot be read, as every agent a line names is then taken for running', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n` }, forge: { 'acme/app': '[]' }, launcher: null })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 is done with it, close it.'])
})

// A pull request of the orchestration that carries Ready, its agent running in the session s-p17.
const READY_PR = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] }])
const P17_LINE = ledgerLine(17, 'working', { agent: 'Agent: p17' })
const P17_SESSION = { [`${STATE}/store/sessions/s-p17`]: row('agent', 'Agent: p17 [a1b2c3]', '/dev/ttys006') }

test('a pull request that becomes Ready wakes its orchestrator with its agent to close and its session id to keep, once', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  expect((await prWake(world.dollar, told)).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 is done with it (session s-p17), close it.'])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a successor or a restarted module, its told empty, names the agent of a pull request already Ready once, as one that saw it become Ready; its next tick says nothing', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const first = new Set<string>()
  const line = '[module] acme/app#17 is Ready: its agent Agent: p17 is done with it (session s-p17), close it.'
  expect((await prWake(world.dollar, first)).lines).toEqual([line])
  // The module restarts: nothing is remembered, and the agent still runs, so it is told again, once.
  const restarted = new Set<string>()
  expect((await prWake(world.dollar, restarted)).lines).toEqual([line])
  expect((await prWake(world.dollar, restarted)).lines).toEqual([])
})

test('a pull request that is not Ready, or whose agent the launcher no longer lists, says nothing to close', async () => {
  const notReady = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Not Ready' }] }])
  const waiting = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': notReady }, launcher: running('Agent: p17') })
  expect((await prWake(waiting.dollar, new Set())).lines).toEqual([])
  const closed = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: other') })
  expect((await prWake(closed.dollar, new Set())).lines).toEqual([])
  const unlisted = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: null })
  expect((await prWake(unlisted.dollar, new Set())).lines).toEqual([])
})

test('a Ready pull request whose agent holds another open pull request says to tell it, not to close it', async () => {
  const other = ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n${other}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR, 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 still holds acme/lib#21; tell it, do not close it.'])
})

test('an agent resumed for a fix on a pull request still Ready is not told to close mid-fix; the next Ready head tells it again, and a merge then names nothing to close', async () => {
  const told = new Set<string>()
  const ready = (launcher: string | null, sha = 'a'.repeat(40)) => fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }], sha }]) }, launcher })
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toHaveLength(1)
  // Closed at Ready, then resumed for a fix while the label still stands: the same head says nothing.
  expect((await prWake(ready('').dollar, told)).lines).toEqual([])
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toEqual([])
  // A launcher listing that failed once does not make the agent told again either.
  expect((await prWake(ready(null).dollar, told)).lines).toEqual([])
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toEqual([])
  // The fix pushed, Ready again at the next head: told again.
  expect((await prWake(ready(running('Agent: p17'), 'b'.repeat(40)).dollar, told)).lines).toHaveLength(1)
  const merged = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': '[]' }, launcher: '' })
  expect((await prWake(merged.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged.'])
})

test('two Ready pull requests of one agent: the agent holds nothing the other one does not release, both say to close it', async () => {
  const second = ledgerLine(18, 'working', { agent: 'Agent: p17' })
  const both = JSON.stringify([17, 18].map(number => ({ number, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] })))
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n${second}\n`, ...P17_SESSION }, forge: { 'acme/app': both }, launcher: running('Agent: p17') })
  const lines = (await prWake(world.dollar, new Set())).lines
  expect(lines).toHaveLength(2)
  expect(lines.every(line => line.endsWith('close it.') && !line.includes('still holds'))).toBe(true)
})

// A pull request of the orchestration its agent still works on, the forge reading it against its base (`main` at `c…` unless given).
const conflicting = (mergeable: string, sha = 'a'.repeat(40), baseSha = 'c'.repeat(40), launcher: string | null = running('Agent: p17')) => fake({
  session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION },
  forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', mergeable, sha, baseSha }]) }, launcher,
})
const CONFLICT_LINE = '[module] acme/app#17 is conflicting with its base main: its agent Agent: p17 (session s-p17), rebase it (references/rebase.md).'

test('a pull request whose agent still works on it and that the forge reads conflicting wakes its orchestrator with its agent to rebase it', async () => {
  expect((await prWake(conflicting('CONFLICTING').dollar, new Set())).lines).toEqual([CONFLICT_LINE])
})

test('a conflict is told once per head and base head, again only when either moves and the conflict stays', async () => {
  const told = new Set<string>()
  expect((await prWake(conflicting('CONFLICTING').dollar, told)).lines).toEqual([CONFLICT_LINE])
  expect((await prWake(conflicting('CONFLICTING').dollar, told)).lines).toEqual([])
  // Still computing: nothing yet, and what was told of this head and base head is kept.
  expect((await prWake(conflicting('UNKNOWN').dollar, told)).lines).toEqual([])
  expect((await prWake(conflicting('CONFLICTING').dollar, told)).lines).toEqual([])
  // Its agent gone for a while, the anomaly says it; back at the same head and base head, nothing is told again.
  expect((await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'c'.repeat(40), '').dollar, told)).lines).toHaveLength(1)
  expect((await prWake(conflicting('CONFLICTING').dollar, told)).lines).toEqual([])
  // Its base moved and the conflict is still there: told again; its head moved: told again.
  expect((await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'd'.repeat(40)).dollar, told)).lines).toEqual([CONFLICT_LINE])
  expect((await prWake(conflicting('CONFLICTING', 'b'.repeat(40), 'd'.repeat(40)).dollar, told)).lines).toEqual([CONFLICT_LINE])
  // Rebased: mergeable again, nothing to tell.
  expect((await prWake(conflicting('MERGEABLE', 'e'.repeat(40), 'd'.repeat(40)).dollar, told)).lines).toEqual([])
})

test('a mergeability the forge still computes (UNKNOWN) is no conflict: nothing is told', async () => {
  expect((await prWake(conflicting('UNKNOWN').dollar, new Set())).lines).toEqual([])
  expect((await prWake(conflicting('MERGEABLE').dollar, new Set())).lines).toEqual([])
})

test('a file written before the base was read tells no conflict: it waits for the refresh that reads the base', async () => {
  const world = conflicting('CONFLICTING')
  expect((await prWake(world.dollar, new Set())).lines).toEqual([CONFLICT_LINE])
  // The same file as one written before: its base fields gone, it is still fresh and is not read again.
  const file = JSON.parse(world.files.get(`${STATE}/prs.json`)!) as { prs: Record<string, unknown>[] }
  for (const pr of file.prs) { delete pr['base']; delete pr['baseSha'] }
  world.files.set(`${STATE}/prs.json`, JSON.stringify(file))
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a conflicting pull request no running agent holds is told once, as the anomaly, never twice', async () => {
  const lines = (await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'c'.repeat(40), '').dollar, new Set())).lines
  expect(lines).toEqual(['[module] acme/app#17 en anomalie (en conflit) — reattach an agent, refresh its wait, or ask'])
})

test('a conflicting pull request a fresh wait holds names no agent: one is put on it to rebase it; one the operator parked says nothing', async () => {
  const forge = { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', mergeable: 'CONFLICTING' }]) }
  const fresh = new Date(Date.now() - 60_000).toISOString()
  const waiting = JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 17, status: 'waiting', on: 'the CI', since: fresh, updated: fresh })
  const held = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${waiting}\n` }, forge, launcher: '' })
  expect((await prWake(held.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is conflicting with its base main: no agent on it, put one to rebase it (references/rebase.md).'])
  const parked = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(17, 'parked', { on: 'his ruling, 2026-11-18' })}\n` }, forge, launcher: '' })
  expect((await prWake(parked.dollar, new Set())).lines).toEqual([])
})

test('a file refreshed without the base keeps the conflict told of its head: the next refresh that reads the base tells nothing again', async () => {
  const told = new Set<string>()
  const world = conflicting('CONFLICTING')
  expect((await prWake(world.dollar, told)).lines).toEqual([CONFLICT_LINE])
  // A session of the previous version refreshes the file with its old query, which reads no base.
  const withBase = world.files.get(`${STATE}/prs.json`)!
  const file = JSON.parse(withBase) as { prs: Record<string, unknown>[] }
  for (const pr of file.prs) { delete pr['base']; delete pr['baseSha'] }
  world.files.set(`${STATE}/prs.json`, JSON.stringify(file))
  expect((await prWake(world.dollar, told)).lines).toEqual([])
  world.files.set(`${STATE}/prs.json`, withBase)
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a Ready pull request the forge reads conflicting is told to rebase only, not to close: its agent gets one order', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }], mergeable: 'CONFLICTING' }]) }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  expect((await prWake(world.dollar, told)).lines).toEqual([CONFLICT_LINE])
  // The conflict gone at the same head, it is ready again: its agent is told to close it then.
  const file = JSON.parse(world.files.get(`${STATE}/prs.json`)!) as { prs: Record<string, unknown>[] }
  for (const pr of file.prs) pr['mergeable'] = 'MERGEABLE'
  world.files.set(`${STATE}/prs.json`, JSON.stringify(file))
  expect((await prWake(world.dollar, told)).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 is done with it (session s-p17), close it.'])
})

test('a pull request told in anomaly without an agent that then turns conflicting is told again, in conflict', async () => {
  const told = new Set<string>()
  expect((await prWake(conflicting('MERGEABLE', 'a'.repeat(40), 'c'.repeat(40), '').dollar, told)).lines).toEqual([expect.stringMatching(/^\[module\] acme\/app#17 en anomalie \(sans agent depuis /)])
  expect((await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'c'.repeat(40), '').dollar, told)).lines).toEqual(['[module] acme/app#17 en anomalie (en conflit) — reattach an agent, refresh its wait, or ask'])
  expect((await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'c'.repeat(40), '').dollar, told)).lines).toEqual([])
  // Its base moved: still computing, then conflicting again: neither is told again.
  expect((await prWake(conflicting('UNKNOWN', 'a'.repeat(40), 'd'.repeat(40), '').dollar, told)).lines).toEqual([])
  expect((await prWake(conflicting('CONFLICTING', 'a'.repeat(40), 'd'.repeat(40), '').dollar, told)).lines).toEqual([])
})

// An agent's launch, as the launcher writes it: the script naming its brief, the brief naming its row.
const launched = (dir: string, agent: string, row: number): Record<string, string> => ({
  [`${STATE}/prompts/launch-${agent.replace(/[^A-Za-z0-9._-]/g, '-')}-1700000000000.sh`]: `export ORCHESTRATOR_BRIEF='${dir}/${agent.slice(7)}-brief.md'\n`,
  [`${dir}/${agent.slice(7)}-brief.md`]: `# brief\n\nRow: ${row}\n`,
})
const OTHER = '/briefs/web/dispatch-record.jsonl'
const second = (text: string): Record<string, string> => ({ [`${STATE}/records/s-orch`]: `${RECORD}\n${OTHER}\n`, [`${OTHER}.owner`]: `${ORCH}\n`, [OTHER]: text })
const rowOf = (id: number, state: string, extra: object = {}) => JSON.stringify({ id, state, label: `row ${id}`, ...extra })
const mergedLine = ledgerLine(17, 'working', { agent: 'Agent: p17' })

test('a row the agent\'s brief names holds it, in the record beside that brief: the same id in another record is not its row', async () => {
  const files = { ...launched('/briefs/web', 'Agent: p17', 8), ...second(`${rowOf(8, 'closed')}\n${rowOf(9, 'open', { note: 'Dispatched: Agent: someone' })}\n`) }
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(8, 'open')}\n${mergedLine}\n`, ...files }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  // Row 8 of web is closed, row 9 of web is another agent's and row 8 of app, open, is no row of its brief: nothing holds p17.
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 is done with it, close it.'])
  const held = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(8, 'closed')}\n${mergedLine}\n`, ...launched('/briefs/web', 'Agent: p17', 8), ...second(`${rowOf(8, 'open', { note: 'no agent here' })}\n`) }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(held.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 8 (web); tell it, do not close it.'])
})

test('a row open in any record of the orchestration holds the agent, whether or not it waits on a merge, and a deferred or closed one holds nothing', async () => {
  const rows = [rowOf(3, 'open', { note: 'Dispatched: Agent: p17' }), rowOf(4, 'open', { note: 'Dispatched: Agent: p17', deferred: 'later, 2026-11-15' }), rowOf(5, 'closed', { note: 'Dispatched: Agent: p17' }), mergedLine].join('\n') + '\n'
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 3 (app); tell it, do not close it.'])
})

test('a note names an agent by its whole name: a row of Agent: p17 does not hold Agent: p1', async () => {
  const rows = [rowOf(3, 'open', { note: 'Dispatched: Agent: p17 on feat/next' }), ledgerLine(1, 'working', { agent: 'Agent: p1' }), mergedLine].join('\n') + '\n'
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p1', 'Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([
    '[module] acme/app#1 merged: its agent Agent: p1 is done with it, close it.',
    '[module] acme/app#17 merged: its agent Agent: p17 still holds row 3 (app); tell it, do not close it.',
  ])
})

test('another working line of the agent holds it; a parked one does not', async () => {
  const parked = ledgerLine(19, 'parked', { ruling: 'later, 2026-11-15' }, 'acme/lib').replace('"ruling"', '"agent":"Agent: p17","ruling"')
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${mergedLine}\n${parked}\n` }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 19, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 is done with it, close it.'])
})

test('a pull request closed unmerged whose agent works another line is told as holding it', async () => {
  const rows = `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n${ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')}\n`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 closed unmerged: its agent Agent: p17 still holds acme/lib#21; tell it, do not close it.'])
})

test('the tick keeps watching while a reader wants the file, its own lines all ended', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS }, forge: { 'acme/app': '[]' } })
  world.files.set(prWantedPath(STATE), `acme/web ${new Date().toISOString()}\n`)
  expect((await prWake(world.dollar, new Set())).watching).toBe(true)
})

test('a pull request closed unmerged wakes its orchestrator with its agent to close, no row relayed', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS }, forge: { 'acme/app': '[]' }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 closed unmerged: its agent Agent: p17 is done with it, close it.'])
})

test('a pull request entering the anomaly wakes its orchestrator once, again only after it leaves and re-enters; nothing changed wakes nothing', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, forge: { 'acme/app': JSON.stringify([{ number: 7, createdAt: '2026-11-14T08:00:00Z' }]) } })
  const told = new Set<string>()
  const first = await prWake(world.dollar, told)
  expect(first.lines).toEqual(['[module] acme/app#7 en anomalie (sans agent depuis 2026-11-14T09:30Z) — reattach an agent, refresh its wait, or ask'])
  expect(first.watching).toBe(true)
  expect((await prWake(world.dollar, told)).lines).toEqual([])
  // Parked by the operator: it leaves the anomaly; back in it, it is told again.
  world.files.set(RECORD, `${world.files.get(RECORD)}${ledgerLine(7, 'parked', { ruling: 'plus tard, 2026-11-14' })}\n`)
  expect((await prWake(world.dollar, told)).lines).toEqual([])
  expect(told.size).toBe(0)
  world.files.set(RECORD, ROWS)
  expect((await prWake(world.dollar, told)).lines.length).toBe(1)
})

test('a merge whose archive fails is told once, not at every tick; a row of another record of the orchestration waiting on it is named', async () => {
  const other = '/briefs/web/dispatch-record.jsonl'
  const world = fake({
    session: 's-orch', reportsTo: null, readOnly: true, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17'),
    rows: { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, [`${STATE}/records/s-orch`]: `${RECORD}\n${other}\n`, [`${other}.owner`]: `${ORCH}\n`, [other]: `${JSON.stringify({ id: 9, state: 'open', label: 'P20 web', blocker: 'PR acme/app#17 merged' })}\n` },
  })
  const told = new Set<string>()
  const first = await prWake(world.dollar, told)
  expect(first.lines).toEqual([
    '[module] acme/app#17 merged: its agent Agent: p17 is done with it, close it.',
    "[module] acme/app#17 merged; open rows waiting on it: row 9 « P20 web ». Tell each one's agent now.",
  ])
  await first.settle()
  expect(world.files.get(RECORD)).toContain('"pr":17')
  expect(world.logged.some(l => l.includes('archive of /briefs/app/dispatch-record.jsonl failed'))).toBe(true)
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a reading that fails tells nothing and keeps watching', async () => {
  const world = fake({ session: 's-orch', reportsTo: null })
  world.files.delete(`${STATE}/store/sessions/s-orch`)
  const woke = await prWake(world.dollar, new Set())
  expect([woke.lines, woke.watching]).toEqual([[], true])
})
