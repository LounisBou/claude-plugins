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
  // Its `close` drops the session on that tty from it, or fails when `closeFails`.
  launcher?: string | null
  closeFails?: boolean
  // Whether `dispatch-record.sh cost` fails.
  costFails?: boolean
  // What `git status --porcelain` prints in an agent's checkout, and how many commits `git rev-list` counts unpushed.
  dirty?: string
  unpushed?: number
  // The orchestrator's chain owner (`own` when not given; null, none), and whether its chain file fails to read.
  owner?: string | null
  chainFails?: boolean
  // The github plugin's `pr-gate` the module runs at its tick: what it prints for a pull request (null: it fails), and whether the plugin is installed.
  gate?: Record<number, string | null>
  githubMissing?: boolean
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
  if (!over.githubMissing) files.set(`${HOME}/.claude/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'github@lounisbou': [{ installPath: '/plugins/github' }] } }))
  // The orchestrator's chain (its owner `own`): the agents the launcher lists on ttys000 and ttys001 (\`running\`) are its own;
  // with `chain`, the agent s-agent on ttys005 too.
  const chained = ['/dev/ttys000', '/dev/ttys001', ...(over.chain ? ['/dev/ttys005'] : [])]
  files.set(`${STATE}/chains/ttys001.jsonl`, chained.map((tty, n) => `${JSON.stringify({ tab_id: `tab-${n}`, tty, owner: 'own' })}\n`).join(''))
  for (const [path, text] of Object.entries(over.rows ?? {})) files.set(path, text)
  const logged: string[] = []
  const runs: string[][] = []
  const gateRuns: string[][] = []
  const reportsTo = over.reportsTo === undefined ? `${ORCH} [a1b2c3]` : over.reportsTo
  let listed = over.launcher
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : name === 'ORCHESTRATOR_REPORTS_TO' ? reportsTo ?? undefined : name === 'ITERM_SESSION_ID' ? (over.owner === undefined ? 'w0t0p0:own' : over.owner === null ? undefined : `w0t0p0:${over.owner}`) : undefined) },
    session: { id: async () => over.session ?? 's-agent' },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => {
        if (over.chainFails && p.includes('/chains/')) throw new Error(`EACCES: ${p}`)
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
        if (argv[0] === 'bash' && argv[2] === 'list') return listed === null ? { exitCode: 1, stdout: '', stderr: 'no terminal' } : { exitCode: 0, stdout: listed ?? '', stderr: '' }
        if (argv[0] === 'bash' && argv[2] === 'close') {
          if (over.closeFails) return { exitCode: 1, stdout: '', stderr: `ERROR: close: refused: the window on ${argv[4]} is named 'Other'` }
          listed = (listed ?? '').split('\n').filter(line => !line.includes(` | ${argv[4]} | `)).join('\n')
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'python3' && argv[1] === '/plugins/github/engine/gh.py') {
          gateRuns.push([...argv])
          const said = over.gate?.[Number(argv[5])]
          return said === undefined || said === null ? { exitCode: 1, stdout: '', stderr: 'pr-gate: no answer' } : { exitCode: 0, stdout: said, stderr: '' }
        }
        if (argv[0] === 'git' && argv[1] === 'status') return { exitCode: 0, stdout: over.dirty ?? '', stderr: '' }
        if (argv[0] === 'git' && argv[1] === 'rev-list') return { exitCode: 0, stdout: `${over.unpushed ?? 0}\n`, stderr: '' }
        if (argv[0] === 'bash' && argv[2] === 'cost' && over.costFails) return { exitCode: 1, stdout: '', stderr: 'ERROR: cost: could not measure session s-p17' }
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        const asked = prQueryRun(argv, repo => over.forge?.[repo] ?? null, over.closed)
        if (asked !== null) return asked
        return { exitCode: argv[0] === 'ps' ? 1 : 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, files, logged, runs, gateRuns }
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
  JSON.stringify({ id: 2, state: 'closed', label: 'P17 scraper', agent: 'Agent: p17' }),
  JSON.stringify({ id: 3, state: 'open', label: 'P18 cache', blocker: 'PR acme/app#17 merged', agent: 'Agent: p18', note: 'Dispatched 2026-11-15: Agent: stale' }),
  JSON.stringify({ id: 4, state: 'open', label: 'P19 ui', blocker: 'none', note: 'stacked on app#17, merge main once it lands' }),
  JSON.stringify({ id: 5, state: 'closed', label: 'P16', blocker: 'PR acme/app#17 merged' }),
  JSON.stringify({ id: 6, state: 'open', label: 'later', blocker: 'PR acme/app#17 merged', deferred: 'later, 2026-11-15' }),
  JSON.stringify({ id: 7, state: 'open', label: 'other repo', blocker: 'PR acme/lib#17 merged' }),
  ledgerLine(17, 'working', { agent: 'Agent: p17' }),
].join('\n') + '\n'

// The launcher's listing with the agents named running, each in a tab whose title carries the host's glyph.
const running = (...agents: string[]) => agents.map((name, n) => `w1/t${n} | /dev/ttys00${n} | ✳ ${name} | ${name}`).join('\n')

// An agent whose last turn ended on `status: done`: its wait file `delivered`, its host idle in its checkout.
const doneAgent = (session: string, name: string, pid: number, tty = '/dev/ttys000'): Record<string, string> => ({
  [`${STATE}/store/sessions/${session}`]: row('agent', `${name} [a1b2c3]`, tty),
  [`${STATE}/store/waits/${session}`]: JSON.stringify({ waiting: 'delivered', blocks: 'acme/app#17', waiting_since: AT, name, pid: String(pid) }),
  [`${HOME}/.claude/sessions/${pid}.json`]: JSON.stringify({ pid, sessionId: session, cwd: `/work/${session}`, status: 'idle', name }),
})
const P17_DONE = doneAgent('s-p17', 'Agent: p17', 417)
// The same agent at work: no wait file says its last turn ended on done.
const P17_WORKING = Object.fromEntries(Object.entries(P17_DONE).filter(([path]) => !path.includes('/waits/')))
// The line of an agent the module closes once the wake is delivered (its `settle`).
const closedLine = (key: string, what: string, agent = 'Agent: p17', session = 's-p17') =>
  `[module] ${key} ${what}: its agent ${agent} is done: the module closes it now (session ${session}, resumable within the hour).`
// The launcher's closes the world ran.
const closes = (runs: readonly string[][]) => runs.filter(argv => argv[2] === 'close').map(argv => argv.slice(3).join(' '))

test('a pull request merged outside the session closes its agent done with it and wakes its orchestrator with the act and the open rows waiting on it; its line archived once told', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(closes(world.runs)).toEqual([])
  expect(woke.lines).toEqual([
    closedLine('acme/app#17', 'merged'),
    '[module] acme/app#17 merged; open rows waiting on it: row 3 « P18 cache » (Agent: p18), row 4 « P19 ui ». Tell each one\'s agent now.',
  ])
  // Watched until its close, made once the wake is delivered (settle).
  expect(woke.watching).toBe(true)
  expect(world.files.get(RECORD)).toContain('"pr":17')
  await woke.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17 --keep-checkout'])
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

test('a merge says its agent still holds the open row that waits on it, or another pull request of its own, and closes nothing', async () => {
  const other = ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')
  const holds = JSON.stringify({ id: 8, state: 'open', label: 'P17 follow-up', blocker: 'PR acme/app#17 merged', agent: 'Agent: p17' })
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${holds}\n${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n${other}\n` }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines[0]).toBe('[module] acme/app#17 merged: its agent Agent: p17 still holds row 8 (app), acme/lib#21; tell it.')
  expect(closes(world.runs)).toEqual([])
})

test('a merge closes nothing while the launcher cannot be read: told merged once, its line kept and watched for a later tick', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: null })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect([woke.lines, woke.watching, closes(world.runs)]).toEqual([['[module] acme/app#17 merged: its agent Agent: p17 left open until it is done and idle (the launcher does not list it idle).'], true, []])
  await woke.settle()
  expect(world.files.get(RECORD)).toContain('"pr":17')
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a merge whose agent is not done yet closes nothing until its last turn ends on done, then closes it and archives the line', async () => {
  const told = new Set<string>()
  const rows = { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, ...P17_WORKING }
  const working = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const first = await prWake(working.dollar, told)
  expect([first.lines, first.watching, closes(working.runs)]).toEqual([['[module] acme/app#17 merged: its agent Agent: p17 left open until it is done and idle (its last turn did not end on done: no status).'], true, []])
  await first.settle()
  expect(working.files.get(RECORD)).toContain('"pr":17')
  const done = fake({ session: 's-orch', reportsTo: null, rows: { ...rows, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const then = await prWake(done.dollar, told)
  expect(then.lines).toEqual([closedLine('acme/app#17', 'merged')])
  await then.settle()
  expect(done.files.get(RECORD)).not.toContain('"pr":17')
})

// A pull request of the orchestration that carries Ready, its agent running in the session s-p17.
const READY_PR = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] }])
const P17_LINE = ledgerLine(17, 'working', { agent: 'Agent: p17' })
const P17_SESSION = { [`${STATE}/store/sessions/s-p17`]: row('agent', 'Agent: p17 [a1b2c3]', '/dev/ttys006') }

test('a pull request that becomes Ready closes its agent done with it, its checkout kept, and tells the act with its session id, once', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await woke.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17 --keep-checkout'])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
  expect(closes(world.runs)).toHaveLength(1)
})

test('a Ready pull request whose agent is not done, or is busy, closes nothing and says nothing: tried again at the next tick', async () => {
  const told = new Set<string>()
  const notDone = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_WORKING }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect([(await prWake(notDone.dollar, told)).lines, closes(notDone.runs)]).toEqual([[], []])
  const busy = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: 'w1/t0 | /dev/ttys000 | ⠂ Agent: p17 | Agent: p17' })
  expect([(await prWake(busy.dollar, told)).lines, closes(busy.runs)]).toEqual([[], []])
  const done = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(done.dollar, told)).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('an agent done whose checkout has changes or unpushed commits is left open and told once with the fact', async () => {
  const dirty = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), dirty: ' M a.ts\n?? b.ts\n' })
  const told = new Set<string>()
  const woke = await prWake(dirty.dollar, told)
  expect(woke.lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 left open: tree not clean in /work/s-p17 (2 paths changed, 0 commits unpushed).'])
  await woke.settle()
  expect(closes(dirty.runs)).toEqual([])
  expect((await prWake(dirty.dollar, told)).lines).toEqual([])
  const ahead = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), unpushed: 2 })
  expect((await prWake(ahead.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 left open: tree not clean in /work/s-p17 (0 paths changed, 2 commits unpushed).'])
})

test('a close the launcher refuses after the wake is told at the next tick, once', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), closeFails: true })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect([woke.lines, woke.watching]).toEqual([[closedLine('acme/app#17', 'is Ready')], true])
  await woke.settle()
  expect((await prWake(world.dollar, told)).lines).toEqual(["[module] Agent: p17 (acme/app#17): the launcher's close failed: ERROR: close: refused: the window on /dev/ttys000 is named 'Other'."])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a close is made only once its wake is delivered: a wake the host drops leaves the agent running', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  await prWake(world.dollar, new Set())
  expect(closes(world.runs)).toEqual([])
})

test('an agent that took a message between its wake and the close is left open, told at the next tick, and closed once done again', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  // A message arrives before the wake is delivered: its turn starts, its host busy.
  const host = `${HOME}/.claude/sessions/417.json`
  world.files.set(host, world.files.get(host)!.replace('"idle"', '"busy"'))
  await woke.settle()
  expect(closes(world.runs)).toEqual([])
  const next = await prWake(world.dollar, told)
  expect(next.lines).toEqual(['[module] Agent: p17 (acme/app#17): left open: its host is busy.'])
  await next.settle()
  // Done again: the same Ready head closes it.
  world.files.set(host, world.files.get(host)!.replace('"busy"', '"idle"'))
  const then = await prWake(world.dollar, told)
  expect(then.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await then.settle()
  expect(closes(world.runs)).toHaveLength(1)
})

test('a merge whose agent turned busy before the close keeps its line until the agent is closed', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${mergedLine}\n`, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  world.files.delete(`${STATE}/store/waits/s-p17`)
  await woke.settle()
  expect([closes(world.runs), world.files.get(RECORD)]).toEqual([[], `${mergedLine}\n`])
  world.files.set(`${STATE}/store/waits/s-p17`, P17_DONE[`${STATE}/store/waits/s-p17`]!)
  const next = await prWake(world.dollar, told)
  // Done again by the next tick: what kept it open, then the close.
  expect(next.lines).toEqual(['[module] Agent: p17 (acme/app#17): left open: its last turn did not end on done: no status.', closedLine('acme/app#17', 'merged')])
  await next.settle()
  expect(closes(world.runs)).toHaveLength(1)
  expect(world.files.get(RECORD)).not.toContain('"pr":17')
})

test('an agent is closed on the tab of this orchestration\'s chain: another orchestration\'s tab of the same name is never closed', async () => {
  const foreign = 'w2/t7 | /dev/ttys007 | ✳ Agent: p17 | Agent: p17'
  const rows = { [RECORD]: `${P17_LINE}\n`, ...P17_DONE, [`${STATE}/store/sessions/s-x17`]: row('agent', 'Agent: p17 [a1b2c3]', '/dev/ttys007') }
  const both = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: `${running('Agent: p17')}\n${foreign}` })
  const woke = await prWake(both.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await woke.settle()
  expect(closes(both.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17 --keep-checkout'])
  // Only the other orchestration's tab idle: nothing closed, told once.
  const alone = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: foreign })
  const told = new Set<string>()
  const said = await prWake(alone.dollar, told)
  await said.settle()
  expect([said.lines, closes(alone.runs)]).toEqual([['[module] acme/app#17 is Ready: its agent Agent: p17 left open: its tab on /dev/ttys007 is on no chain of this orchestration.'], []])
  expect((await prWake(alone.dollar, told)).lines).toEqual([])
})

test('an agent whose own tab is busy waits, whatever tab of the same name another orchestration leaves idle', async () => {
  const foreign = 'w2/t7 | /dev/ttys007 | ✳ Agent: p17 | Agent: p17'
  const rows = { [RECORD]: `${P17_LINE}\n`, ...P17_DONE, [`${STATE}/store/sessions/s-x17`]: row('agent', 'Agent: p17 [a1b2c3]', '/dev/ttys007') }
  const world = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: `w1/t0 | /dev/ttys000 | ⠂ Agent: p17 | Agent: p17\n${foreign}` })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  await woke.settle()
  expect([woke.lines, closes(world.runs)]).toEqual([[], []])
  // Idle at last on its own tab: closed there.
  const idle = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: `${running('Agent: p17')}\n${foreign}` })
  const then = await prWake(idle.dollar, told)
  await then.settle()
  expect([then.lines, closes(idle.runs)]).toEqual([[closedLine('acme/app#17', 'is Ready')], ['--tty /dev/ttys000 --expect-title Agent: p17 --keep-checkout']])
})

test('a session with no chain owner closes nothing and says why once; a chain that cannot be read waits for a later tick, logged', async () => {
  const rows = { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }
  const ownerless = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), owner: null })
  const told = new Set<string>()
  const woke = await prWake(ownerless.dollar, told)
  await woke.settle()
  expect([woke.lines, closes(ownerless.runs)]).toEqual([['[module] acme/app#17 is Ready: its agent Agent: p17 left open: this session has no chain owner (ITERM_SESSION_ID, or TMUX and TMUX_PANE, unset).'], []])
  expect((await prWake(ownerless.dollar, told)).lines).toEqual([])
  const unread = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), chainFails: true })
  const later = await prWake(unread.dollar, new Set())
  await later.settle()
  expect([later.lines, closes(unread.runs)]).toEqual([[], []])
  expect(unread.logged.some(line => line.includes('the chain of /dev/ttys001 unread'))).toBe(true)
})

test('an agent whose tree turned dirty between its wake and the close is left open and told once; its merged line is archived', async () => {
  const over: Over = { session: 's-orch', reportsTo: null, rows: { [RECORD]: `${mergedLine}\n`, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') }
  const world = fake(over)
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'merged')])
  over.dirty = ' M a.ts\n'
  await woke.settle()
  expect(closes(world.runs)).toEqual([])
  expect(world.files.get(RECORD)).not.toContain('"pr":17')
  expect((await prWake(world.dollar, told)).lines).toEqual(['[module] Agent: p17 (acme/app#17): left open: tree not clean in /work/s-p17 (1 paths changed, 0 commits unpushed).'])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('an agent whose host is busy, whose host record is missing, or whose session row is on another tty is not closed: tried again later', async () => {
  const busyHost = { ...P17_DONE, [`${HOME}/.claude/sessions/417.json`]: JSON.stringify({ pid: 417, sessionId: 's-p17', cwd: '/work/s-p17', status: 'busy' }) }
  const noHost = Object.fromEntries(Object.entries(P17_DONE).filter(([path]) => !path.endsWith('/417.json')))
  for (const rows of [busyHost, noHost, doneAgent('s-p17', 'Agent: p17', 417, '/dev/ttys009')]) {
    const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...rows }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
    const woke = await prWake(world.dollar, new Set())
    await woke.settle()
    expect([woke.lines, closes(world.runs)]).toEqual([[], []])
  }
})

test('a closed agent\'s cost goes on the row its brief was printed for, in the record beside that brief; a cost that fails is told at the next tick', async () => {
  const rows = { [RECORD]: `${JSON.stringify({ id: 4, state: 'open', label: 'P17' })}\n${P17_LINE}\n`, ...P17_DONE, ...launched('/briefs/app', 'Agent: p17', 4) }
  const world = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  await (await prWake(world.dollar, told)).settle()
  expect(world.runs.filter(argv => argv[2] === 'cost')).toEqual([['bash', '/plugins/orch/skills/orchestrator/scripts/dispatch-record.sh', 'cost', RECORD, '4', '--session', 's-p17']])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
  const failing = fake({ session: 's-orch', reportsTo: null, rows, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'), costFails: true })
  const again = new Set<string>()
  await (await prWake(failing.dollar, again)).settle()
  expect((await prWake(failing.dollar, again)).lines).toEqual(['[module] Agent: p17 (acme/app#17): its cost not recorded: ERROR: cost: could not measure session s-p17.'])
})

test('a Ready pull request whose agent holds another open row of the record, besides the row of its brief, says to tell it and closes nothing', async () => {
  const rows = [JSON.stringify({ id: 333, state: 'open', label: 'M2', agent: 'Agent: p17' }), JSON.stringify({ id: 338, state: 'open', label: 'next', agent: 'Agent: p17' }), P17_LINE].join('\n') + '\n'
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...P17_DONE, ...launched('/briefs/app', 'Agent: p17', 333) }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 still holds row 338 (app); tell it.'])
  await woke.settle()
  expect(closes(world.runs)).toEqual([])
  // Its own row alone, the row of its brief, keeps nothing open.
  const own = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows.replace(/.*"id":338.*\n/, ''), ...P17_DONE, ...launched('/briefs/app', 'Agent: p17', 333) }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(own.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('a successor or a restarted module, its told empty, closes the agent of a pull request already Ready; one already closed is no longer listed and nothing is done again', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await woke.settle()
  // The module restarts: nothing is remembered, and the agent closed is not listed: nothing is closed or told again.
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
  expect(closes(world.runs)).toHaveLength(1)
})

test('a pull request that is not Ready, or whose agent the launcher no longer lists, closes nothing', async () => {
  const notReady = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Not Ready' }] }])
  const waiting = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': notReady }, launcher: running('Agent: p17') })
  expect((await prWake(waiting.dollar, new Set())).lines).toEqual([])
  const closed = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: other') })
  expect((await prWake(closed.dollar, new Set())).lines).toEqual([])
  const unlisted = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': READY_PR }, launcher: null })
  expect((await prWake(unlisted.dollar, new Set())).lines).toEqual([])
})

test('a Ready pull request whose agent holds another open pull request says to tell it, and closes nothing', async () => {
  const other = ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n${other}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR, 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 still holds acme/lib#21; tell it.'])
  expect(closes(world.runs)).toEqual([])
})

test('an agent resumed for a fix on a pull request still Ready is not closed mid-fix; the next Ready head closes it again, and a merge then names nothing to close', async () => {
  const told = new Set<string>()
  const ready = (launcher: string | null, sha = 'a'.repeat(40)) => fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }], sha }]) }, launcher })
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toHaveLength(1)
  // Closed at Ready, then resumed for a fix while the label still stands: the same head closes nothing.
  expect((await prWake(ready('').dollar, told)).lines).toEqual([])
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toEqual([])
  // A launcher listing that failed once does not make the agent closed again either.
  expect((await prWake(ready(null).dollar, told)).lines).toEqual([])
  expect((await prWake(ready(running('Agent: p17')).dollar, told)).lines).toEqual([])
  // The fix pushed, Ready again at the next head: closed again.
  expect((await prWake(ready(running('Agent: p17'), 'b'.repeat(40)).dollar, told)).lines).toHaveLength(1)
  const merged = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': '[]' }, launcher: '' })
  expect((await prWake(merged.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged.'])
})

test('two Ready pull requests of one agent: the agent holds nothing the other one does not release, it is closed once and both tell it', async () => {
  const second = ledgerLine(18, 'working', { agent: 'Agent: p17' })
  const both = JSON.stringify([17, 18].map(number => ({ number, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] })))
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n${second}\n`, ...P17_DONE }, forge: { 'acme/app': both }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready'), closedLine('acme/app#18', 'is Ready')])
  await woke.settle()
  expect(closes(world.runs)).toHaveLength(1)
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

test('a conflict names the agent put on the pull request before when the one named last no longer runs', async () => {
  const reviewed = JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 17, status: 'working', agent: 'Agent: review 17 r1', earlier: ['Agent: p17'], since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:30:00Z' })
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${reviewed}\n`, ...P17_SESSION },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', mergeable: 'CONFLICTING' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([CONFLICT_LINE])
})

// A line put on a reviewer after its implementer: the implementer kept in `earlier`.
const reviewedLine = (pr: number, repo = 'acme/app') => JSON.stringify({ v: 1, ledger: 'pr', repo, pr, status: 'working', agent: `Agent: review ${pr} r1`, earlier: ['Agent: p17'], since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:30:00Z' })

test('a merge closes the agent put on the pull request before when the one named last no longer runs', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${reviewedLine(17)}\n`, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'merged')])
})

test('a Ready pull request whose last agent is closed closes the one put on it before, still running', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${reviewedLine(17)}\n`, ...P17_DONE },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('a pull request an agent still attends through its earlier list holds it: a merge or a Ready of another one says to tell it, and closes nothing', async () => {
  const merged = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(18, 'working', { agent: 'Agent: p17' })}\n${reviewedLine(21, 'acme/lib')}\n` },
    forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(merged.dollar, new Set())).lines).toEqual(['[module] acme/app#18 merged: its agent Agent: p17 still holds acme/lib#21; tell it.'])
  const ready = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n${reviewedLine(21, 'acme/lib')}\n`, ...P17_SESSION },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] }]), 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(ready.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 still holds acme/lib#21; tell it.'])
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

test('a Ready pull request the forge reads conflicting is told to rebase only, its agent not closed: its agent gets one order', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE },
    forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }], mergeable: 'CONFLICTING' }]) }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  expect((await prWake(world.dollar, told)).lines).toEqual([CONFLICT_LINE])
  expect(closes(world.runs)).toEqual([])
  // The conflict gone at the same head, it is ready again: its agent is closed then.
  const file = JSON.parse(world.files.get(`${STATE}/prs.json`)!) as { prs: Record<string, unknown>[] }
  for (const pr of file.prs) pr['mergeable'] = 'MERGEABLE'
  world.files.set(`${STATE}/prs.json`, JSON.stringify(file))
  expect((await prWake(world.dollar, told)).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
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

test('the row an agent\'s brief names is its own, in the record beside that brief: the same id in another record is not its row', async () => {
  const files = { ...launched('/briefs/web', 'Agent: p17', 8), ...second(`${rowOf(8, 'closed')}\n${rowOf(9, 'open', { note: 'Dispatched: Agent: someone' })}\n`) }
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(8, 'open')}\n${mergedLine}\n`, ...files, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  // Row 8 of web is closed, row 9 of web is another agent's and row 8 of app, open, is no row of its brief: nothing holds p17.
  // Closed, its cost goes on row 8 of web, the row of its brief, closed or not.
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'merged')])
  await woke.settle()
  expect(world.runs.filter(argv => argv[2] === 'cost').map(argv => argv.slice(3, 5))).toEqual([[OTHER, '8']])
  // Its own row still open at the merge, the agent left open at Ready, holds nothing: closed at the merge.
  const brief = { ...launched('/briefs/web', 'Agent: p17', 8), ...P17_DONE }
  const own = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(8, 'closed')}\n${mergedLine}\n`, ...brief, ...second(`${rowOf(8, 'open', { agent: 'Agent: p17' })}\n`) }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const merged = await prWake(own.dollar, new Set())
  expect(merged.lines).toEqual([closedLine('acme/app#17', 'merged')])
  await merged.settle()
  expect(closes(own.runs)).toHaveLength(1)
  // Another row of web that names it holds it.
  const held = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(8, 'closed')}\n${mergedLine}\n`, ...brief, ...second(`${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${rowOf(9, 'open', { agent: 'Agent: p17' })}\n`) }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(held.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 9 (web); tell it.'])
})

test('an agent whose brief names no row owns the one row that names it: at Ready it is closed; of two rows, it is told', async () => {
  const one = `${rowOf(333, 'open', { agent: 'Agent: p17' })}\n${P17_LINE}\n`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: one, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  const two = `${rowOf(338, 'open', { agent: 'Agent: p17' })}\n${one}`
  const held = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: two, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(held.dollar, new Set())).lines).toEqual(['[module] acme/app#17 is Ready: its agent Agent: p17 still holds row 338 (app), row 333 (app); tell it.'])
})

test('a note that names an agent holds nothing: only the row\'s agent field does', async () => {
  const rows = `${rowOf(333, 'open', { note: 'Held by Agent: p17' })}\n${rowOf(338, 'open', { note: 'Dispatched: Agent: p17' })}\n${P17_LINE}\n`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('an agent whose brief sits beside no record owns that row in the records of the orchestration: at Ready it is closed', async () => {
  const rows = `${rowOf(333, 'open', { agent: 'Agent: p17' })}\n${P17_LINE}\n`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...P17_DONE, ...launched('/briefs/elsewhere', 'Agent: p17', 333) }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('a row open in any record of the orchestration holds the agent, whether or not it waits on a merge, and a deferred or closed one holds nothing', async () => {
  const rows = [rowOf(3, 'open', { agent: 'Agent: p17' }), rowOf(4, 'open', { agent: 'Agent: p17', deferred: 'later, 2026-11-15' }), rowOf(5, 'closed', { agent: 'Agent: p17' }), mergedLine].join('\n') + '\n'
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...launched('/briefs/app', 'Agent: p17', 2) }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 3 (app); tell it.'])
})

test('a row names an agent by its whole name: a row of Agent: p17 does not hold Agent: p1', async () => {
  const rows = [rowOf(3, 'open', { agent: 'Agent: p17' }), ledgerLine(1, 'working', { agent: 'Agent: p1' }), mergedLine].join('\n') + '\n'
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...doneAgent('s-p1', 'Agent: p1', 401), ...launched('/briefs/app', 'Agent: p17', 2) }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p1', 'Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([
    closedLine('acme/app#1', 'merged', 'Agent: p1', 's-p1'),
    '[module] acme/app#17 merged: its agent Agent: p17 still holds row 3 (app); tell it.',
  ])
})

test('another working line of the agent holds it; a parked one does not', async () => {
  const parked = ledgerLine(19, 'parked', { ruling: 'later, 2026-11-15' }, 'acme/lib').replace('"ruling"', '"agent":"Agent: p17","ruling"')
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${mergedLine}\n${parked}\n`, ...P17_DONE }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 19, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'merged')])
})

test('a pull request closed unmerged whose agent works another line is told as holding it', async () => {
  const rows = `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n${ledgerLine(21, 'working', { agent: 'Agent: p17' }, 'acme/lib')}\n`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows }, forge: { 'acme/app': '[]', 'acme/lib': JSON.stringify([{ number: 21, createdAt: '2026-11-15T06:00:00Z' }]) }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 closed unmerged: its agent Agent: p17 still holds acme/lib#21; tell it.'])
})

test('the tick keeps watching while a reader wants the file, its own lines all ended', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS }, forge: { 'acme/app': '[]' } })
  world.files.set(prWantedPath(STATE), `acme/web ${new Date().toISOString()}\n`)
  expect((await prWake(world.dollar, new Set())).watching).toBe(true)
})

test('a pull request closed unmerged closes its agent done with it and wakes its orchestrator with the act, no row relayed', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: WAITERS, ...P17_DONE }, forge: { 'acme/app': '[]' }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'closed unmerged')])
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
    rows: { ...P17_DONE, [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, [`${STATE}/records/s-orch`]: `${RECORD}\n${other}\n`, [`${other}.owner`]: `${ORCH}\n`, [other]: `${JSON.stringify({ id: 9, state: 'open', label: 'P20 web', blocker: 'PR acme/app#17 merged' })}\n` },
  })
  const told = new Set<string>()
  const first = await prWake(world.dollar, told)
  expect(first.lines).toEqual([
    closedLine('acme/app#17', 'merged'),
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

// A pull request whose CI the gate reads (the tick's own read, or the one ci-watch kept): the forge's head `sha`, the gate's answers by pull request.
const AT_A = 'a'.repeat(40)
const AT_B = 'b'.repeat(40)
const gateJson = (result: string, head: string, failed: string[] = []) => JSON.stringify({ repo: 'acme/app', pr: 17, head, ci: { result, running: result === 'PENDING' ? 1 : 0, failed, unverified: [], checks: [] } })
const KEPT_17 = `${STATE}/ci-gate/acme_app-pr17.json`
const checked = (gate: Record<number, string | null>, sha = AT_A, extra: Partial<Over> = {}, draft = false) => fake({
  session: 's-orch', reportsTo: null, gate,
  forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', mergeable: 'MERGEABLE', sha, draft }]) }, launcher: running('Agent: p17'),
  ...extra, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION, ...(extra.rows ?? {}) },
})
const FAILING_LINE = '[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4), lint ; dis-le à son agent Agent: p17 (session s-p17).'
const T0 = Date.parse('2026-11-19T10:00:00Z')

test('a check that fails at the head of a pull request wakes its orchestrator once, with the failed checks and its agent', async () => {
  const world = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told, T0, new Map())
  expect(woke.lines).toEqual([FAILING_LINE])
  // The reading the tick took is kept where ci-watch keeps its own, and a verdict at the head is read no more.
  expect(world.files.get(KEPT_17)).toEqual(gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']))
  expect((await prWake(world.dollar, told, T0 + 10 * 60_000, new Map())).lines).toEqual([])
  expect(world.gateRuns).toHaveLength(1)
  expect(world.gateRuns[0]).toEqual(['python3', '/plugins/github/engine/gh.py', '--repo', 'acme/app', 'pr-gate', '17', '--json'])
})

test('a head that fails again after a new push is told again, the same head never twice', async () => {
  const told = new Set<string>()
  expect((await prWake(checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) }).dollar, told, T0)).lines).toEqual([FAILING_LINE])
  expect((await prWake(checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) }).dollar, told, T0 + 60_000)).lines).toEqual([])
  expect((await prWake(checked({ 17: gateJson('FAILURE', AT_B, ['tests (8.4)']) }, AT_B).dollar, told, T0 + 120_000)).lines)
    .toEqual(['[module] acme/app#17 CI en échec à bbbbbbb : tests (8.4) ; dis-le à son agent Agent: p17 (session s-p17).'])
})

test('a pending or green check, or a head with no check, tells nothing', async () => {
  for (const result of ['PENDING', 'SUCCESS', 'NONE']) {
    expect((await prWake(checked({ 17: gateJson(result, AT_A) }).dollar, new Set(), T0)).lines).toEqual([])
  }
})

test('a failing head the gate has no agent to tell about says so; a draft is neither read nor told', async () => {
  const alone = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)']) }, AT_A, { launcher: '' })
  expect((await prWake(alone.dollar, new Set(), T0)).lines[0]).toEqual("[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; personne n'y travaille, mets-y un agent.")
  const draft = checked({ 17: gateJson('FAILURE', AT_A, ['guard']) }, AT_A, {}, true)
  expect((await prWake(draft.dollar, new Set(), T0)).lines).toEqual([])
  expect(draft.gateRuns).toEqual([])
})

test('a reading already kept as a verdict at the head is told without any new read; one of another head is read again', async () => {
  const kept = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) }, AT_A, { rows: { [KEPT_17]: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) } })
  expect((await prWake(kept.dollar, new Set(), T0)).lines).toEqual([FAILING_LINE])
  expect(kept.gateRuns).toEqual([])
  const green = checked({ 17: gateJson('SUCCESS', AT_A) }, AT_A, { rows: { [KEPT_17]: gateJson('SUCCESS', AT_A) } })
  expect([(await prWake(green.dollar, new Set(), T0)).lines, green.gateRuns]).toEqual([[], []])
  const stale = checked({ 17: gateJson('FAILURE', AT_B, ['lint']) }, AT_B, { rows: { [KEPT_17]: gateJson('SUCCESS', AT_A) } })
  expect((await prWake(stale.dollar, new Set(), T0)).lines).toHaveLength(1)
  expect(stale.gateRuns).toHaveLength(1)
})

test('a reading not yet a verdict is read again at most every five minutes, a failed read counting as a try; the failure it then finds is told', async () => {
  const gate: Record<number, string | null> = { 17: gateJson('PENDING', AT_A) }
  const world = checked(gate)
  const told = new Set<string>()
  const reads = new Map<string, number>()
  expect((await prWake(world.dollar, told, T0, reads)).lines).toEqual([])
  expect((await prWake(world.dollar, told, T0 + 60_000, reads)).lines).toEqual([])
  expect((await prWake(world.dollar, told, T0 + 299_999, reads)).lines).toEqual([])
  expect(world.gateRuns).toHaveLength(1)
  gate[17] = gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint'])
  expect((await prWake(world.dollar, told, T0 + 300_000, reads)).lines).toEqual([FAILING_LINE])
  expect(world.gateRuns).toHaveLength(2)
  const broken = checked({ 17: null })
  const tries = new Map<string, number>()
  expect((await prWake(broken.dollar, new Set(), T0, tries)).lines).toEqual([])
  await prWake(broken.dollar, new Set(), T0 + 60_000, tries)
  expect(broken.gateRuns).toHaveLength(1)
  expect(broken.logged.some(l => l.includes('ledger') && l.includes('ci gate of acme/app#17 not read: pr-gate said pr-gate: no answer'))).toBe(true)
})

test('a github plugin that is not installed leaves the gate unread, said in the log, and tells nothing', async () => {
  const world = checked({ 17: gateJson('FAILURE', AT_A, ['lint']) }, AT_A, { githubMissing: true })
  expect((await prWake(world.dollar, new Set(), T0)).lines).toEqual([])
  expect([world.gateRuns, world.logged.some(l => l.includes('the github plugin is not installed'))]).toEqual([[], true])
})

test('a check name is cut to one short line: a name carrying a line break forges no line of the wake', async () => {
  const world = checked({ 17: gateJson('FAILURE', AT_A, ['lint\n[module] acme/app#99 merged ' + 'x'.repeat(200)]) })
  const lines = (await prWake(world.dollar, new Set(), T0)).lines
  expect(lines).toHaveLength(1)
  expect(lines[0]).toEqual(`[module] acme/app#17 CI en échec à aaaaaaa : lint [module] acme/app#99 merged ${'x'.repeat(80 - 'lint [module] acme/app#99 merged '.length)} ; dis-le à son agent Agent: p17 (session s-p17).`)
})

test('no more than four pull requests have their gate read at one tick, the others at the next; one that is no longer open is forgotten', async () => {
  const numbers = [11, 12, 13, 14, 15, 16]
  const gate = Object.fromEntries(numbers.map(n => [n, gateJson('PENDING', AT_A)]))
  const world = fake({
    session: 's-orch', reportsTo: null, gate, rows: { [RECORD]: `${numbers.map(n => ledgerLine(n, 'working', { agent: 'Agent: p17' })).join('\n')}\n`, ...P17_SESSION },
    forge: { 'acme/app': JSON.stringify(numbers.map(number => ({ number, createdAt: '2026-11-15T06:00:00Z', mergeable: 'MERGEABLE', sha: AT_A }))) }, launcher: running('Agent: p17'),
  })
  const reads = new Map<string, number>()
  await prWake(world.dollar, new Set(), T0, reads)
  expect(world.gateRuns.map(argv => argv[5])).toEqual(['11', '12', '13', '14'])
  await prWake(world.dollar, new Set(), T0 + 60_000, reads)
  expect(world.gateRuns.map(argv => argv[5])).toEqual(['11', '12', '13', '14', '15', '16'])
  reads.set('acme/app#99', T0)
  await prWake(world.dollar, new Set(), T0 + 120_000, reads)
  expect([...reads.keys()].includes('acme/app#99')).toBe(false)
})
