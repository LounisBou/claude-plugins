// hooks/tests/ledger.test.ts
// The pull request ledger line written at creation (core's pr-ledger.ts): a pull request opened through
// the github tool or `gh pr create`, in any repository, takes its line in the dispatch record of the
// orchestration the creating session belongs to — an agent's, its orchestrator's — once; a session of
// no orchestration writes nothing, and a write that fails changes nothing of the tool's answer.
import { expect, test } from 'claude-code/testing'
import { ciFailingLine, createdPr, prWake, register } from '../ledger.ts'
import { logLineOf, lockRun, prQueryRun } from './fakes.ts'
import { prWantedPath } from '../pr-file-format.ts'
import { OWED_MS, oweRound, owedOf, settleOwed } from '../review-close.ts'
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

type Answer = { result?: string; isError?: boolean }
type Over = {
  session?: string
  reportsTo?: string | null
  chain?: boolean
  rows?: Record<string, string>
  // Paths that are another spelling of a file (a symlinked directory): reads, writes and `stat` go to the file, whose real path `stat` resolves.
  links?: Record<string, string>
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
  // The github reconciler's reading of each pull request of acme/app (null: none).
  gate?: Record<number, string | null>
  // `draft-guard.sh`, run on a draft's failed checks: the names it prints for a pull request (the ones that are no guard); null: it fails.
  guards?: Record<number, string | null>
  // What github's `auto-merge-list` answers (no tool when absent), and the calls it was asked.
  // A list of answers is given in turn, the last one again.
  autoMerge?: Answer | Answer[] | undefined
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
  for (const [n, text] of Object.entries(over.gate ?? {})) if (text !== null) files.set(`${HOME}/.claude/pr-reconcile/acme/app/${n}.json`, text)
  // The orchestrator's chain (its owner `own`): the agents the launcher lists on ttys000 and ttys001 (\`running\`) are its own;
  // with `chain`, the agent s-agent on ttys005 too.
  const chained = ['/dev/ttys000', '/dev/ttys001', ...(over.chain ? ['/dev/ttys005'] : [])]
  files.set(`${STATE}/chains/ttys001.jsonl`, chained.map((tty, n) => `${JSON.stringify({ tab_id: `tab-${n}`, tty, owner: 'own' })}\n`).join(''))
  for (const [path, text] of Object.entries(over.rows ?? {})) files.set(path, text)
  const logged: string[] = []
  const runs: string[][] = []
  const gateRuns: string[][] = []
  const guardRuns: { argv: string[]; stdin: string }[] = []
  const asked: unknown[] = []
  const answers = [over.autoMerge].flat()
  const reportsTo = over.reportsTo === undefined ? `${ORCH} [a1b2c3]` : over.reportsTo
  let listed = over.launcher
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : name === 'ORCHESTRATOR_REPORTS_TO' ? reportsTo ?? undefined : name === 'ITERM_SESSION_ID' ? (over.owner === undefined ? 'w0t0p0:own' : over.owner === null ? undefined : `w0t0p0:${over.owner}`) : undefined) },
    session: { id: async () => over.session ?? 's-agent' },
    clock: { sleep: async () => undefined },
    tool: over.autoMerge === undefined ? {} : { call: async (input: unknown) => { asked.push(input); return answers[Math.min(asked.length - 1, answers.length - 1)] } },
    fs: {
      read: async (path: string) => {
        const p = over.links?.[path] ?? path
        if (over.chainFails && p.includes('/chains/')) throw new Error(`EACCES: ${p}`)
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        const text = files.get(p)!
        if (over.race !== undefined && p === RECORD && !text.includes(over.race)) files.set(p, `${text}${over.race}\n`)
        return text
      },
      write: async (path: string, text: string) => { const p = over.links?.[path] ?? path; if (over.readOnly && p.includes('dispatch-record')) throw new Error('disk full'); files.set(p, text) },
      exists: async (path: string) => files.has(over.links?.[path] ?? path),
      stat: async (path: string) => {
        const p = over.links?.[path] ?? path
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file' as const, size: files.get(p)!.length, mtimeMs: 1, realPath: p }
      },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, isLink: false, mtimeMs: 0 })),
    },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
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
        if (argv[0] === 'bash' && argv[1] === '/plugins/orch/skills/orchestrator/scripts/draft-guard.sh') {
          guardRuns.push({ argv: [...argv], stdin: init?.stdin ?? '' })
          const said = over.guards?.[Number(argv[3])]
          return said === undefined || said === null ? { exitCode: 5, stdout: '', stderr: 'draft-guard: gh failed' } : { exitCode: 0, stdout: said, stderr: '' }
        }
        if (argv[0] === 'python3') gateRuns.push([...argv])
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
  return { dollar, files, logged, runs, gateRuns, guardRuns, asked }
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
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17'])
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

// An agent whose last turn ended on `asks` (« waiting for the verdict »), the pull request delivered: its wait file says `asks`.
const P17_ASKS = { ...P17_DONE, [`${STATE}/store/waits/s-p17`]: JSON.stringify({ waiting: 'asks', blocks: 'acme/app#17', waiting_since: AT, name: 'Agent: p17', pid: '417' }) }

// A pull request that ended, its agent idle in a clean checkout, its last turn on asks or with no status: closed all the same.
for (const [label, agent] of [['asks', P17_ASKS], ['no status', P17_WORKING]] as const) {
  for (const [ending, over, what] of [['merged', {}, 'merged'], ['closed unmerged', { closed: { 'acme/app': { 17: 'CLOSED' } } }, 'closed unmerged']] as const) {
    test(`a pull request ${ending} closes its idle agent whose last turn ended on ${label}, then archives the line`, async () => {
      const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, ...agent }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17'), ...over })
      const woke = await prWake(world.dollar, new Set())
      expect(woke.lines).toEqual([closedLine('acme/app#17', what)])
      await woke.settle()
      expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17'])
      expect(world.files.get(RECORD)).not.toContain('"pr":17')
    })
  }
}

test('a merge whose agent is busy closes nothing, its line kept; the first tick after it goes idle closes it', async () => {
  const told = new Set<string>()
  const rows = { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, ...P17_ASKS }
  const busyHost = { ...rows, [`${HOME}/.claude/sessions/417.json`]: JSON.stringify({ pid: 417, sessionId: 's-p17', cwd: '/work/s-p17', status: 'busy' }) }
  const busy = fake({ session: 's-orch', reportsTo: null, rows: busyHost, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const first = await prWake(busy.dollar, told)
  expect([first.lines, first.watching]).toEqual([['[module] acme/app#17 merged: its agent Agent: p17 left open until it is done and idle (its host is busy).'], true])
  await first.settle()
  expect([closes(busy.runs), busy.files.get(RECORD)]).toEqual([[], `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`])
  const idle = fake({ session: 's-orch', reportsTo: null, rows: { ...rows, [RECORD]: busy.files.get(RECORD)! }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  const then = await prWake(idle.dollar, told)
  expect(then.lines).toEqual([closedLine('acme/app#17', 'merged')])
  await then.settle()
  expect(closes(idle.runs)).toHaveLength(1)
  expect(idle.files.get(RECORD)).not.toContain('"pr":17')
})

test('a merge whose idle agent has a dirty or unpushed checkout, its last turn on asks, is left open and told once, its line archived', async () => {
  for (const [state, fact] of [[{ dirty: ' M a.ts\n' }, '1 paths changed, 0 commits unpushed'], [{ unpushed: 2 }, '0 paths changed, 2 commits unpushed']] as const) {
    const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${ledgerLine(17, 'working', { agent: 'Agent: p17' })}\n`, ...P17_ASKS }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17'), ...state })
    const told = new Set<string>()
    const woke = await prWake(world.dollar, told)
    expect(woke.lines).toEqual([`[module] acme/app#17 merged: its agent Agent: p17 left open: tree not clean in /work/s-p17 (${fact}).`])
    await woke.settle()
    expect(closes(world.runs)).toEqual([])
    expect(world.files.get(RECORD)).not.toContain('"pr":17')
    expect((await prWake(world.dollar, told)).lines).toEqual([])
  }
})

// A pull request of the orchestration that carries Ready, its agent running in the session s-p17.
const READY_PR = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }] }])
const P17_LINE = ledgerLine(17, 'working', { agent: 'Agent: p17' })
const P17_SESSION = { [`${STATE}/store/sessions/s-p17`]: row('agent', 'Agent: p17 [a1b2c3]', '/dev/ttys006') }

const MERGE_NOW = ' acme/app#17 is in an auto-merge repository: merge it now yourself (pr-ready if it is a draft, then pr-merge), without asking the operator.'

test('a Ready pull request of a repository github\'s auto-merge list names says the merge is the orchestrator\'s own, a draft carrying Ready too; any other list leaves its line as it was', async () => {
  const wake = async (autoMerge: Over['autoMerge'], forge = READY_PR) => {
    const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': forge }, launcher: running('Agent: p17'), autoMerge })
    return { lines: (await prWake(world.dollar, new Set())).lines, asked: world.asked }
  }
  const listed = await wake({ result: 'other/lib\nAcme/App' })
  expect(listed.lines).toEqual([closedLine('acme/app#17', 'is Ready') + MERGE_NOW])
  expect(listed.asked).toEqual([{ tool: 'mcp__github__gh', command: 'auto-merge-list' }])
  const draft = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', isDraft: true, labels: [{ name: 'Ready' }] }])
  expect((await wake({ result: 'acme/app' }, draft)).lines).toEqual([closedLine('acme/app#17', 'is Ready') + MERGE_NOW])
  // Unlisted, an empty list, an unreadable list, no tool: today's line.
  for (const autoMerge of [{ result: 'other/lib' }, { result: 'no repository in auto-merge' }, { result: '/data/auto-merge.json: malformed', isError: true }, undefined]) {
    expect((await wake(autoMerge)).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  }
})

test('a Ready pull request the operator holds (On Hold) is not told to merge, its repository listed', async () => {
  const forge = JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', labels: [{ name: 'Ready' }, { name: 'On Hold' }] }])
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': forge }, launcher: running('Agent: p17'), autoMerge: { result: 'acme/app' } })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready')])
})

test('a Ready pull request told with the list empty at the reading asks it once more, then says the merge when it answers', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17'),
    autoMerge: [{ result: 'unreadable', isError: true }, { result: 'acme/app' }] })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'is Ready') + MERGE_NOW])
  expect(world.asked).toHaveLength(2)
})

test('the auto-merge list is asked only when a Ready pull request is told', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z' }]) }, launcher: running('Agent: p17'), autoMerge: { result: 'acme/app' } })
  await prWake(world.dollar, new Set())
  expect(world.asked).toEqual([])
})

test('a pull request that becomes Ready closes its agent done with it, its checkout kept, and tells the act with its session id, once', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await woke.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17'])
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

test('a Ready pull request whose agent last turn ended on asks is not closed: only a merged or closed one drops the done condition', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_ASKS }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  await woke.settle()
  expect([woke.lines, closes(world.runs)]).toEqual([[], []])
  // Its last turn ends on done: the Ready head closes it, as it always did.
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
  const idleHost = world.files.get(`${HOME}/.claude/sessions/417.json`)!
  world.files.set(`${HOME}/.claude/sessions/417.json`, JSON.stringify({ pid: 417, sessionId: 's-p17', cwd: '/work/s-p17', status: 'busy' }))
  await woke.settle()
  expect([closes(world.runs), world.files.get(RECORD)]).toEqual([[], `${mergedLine}\n`])
  world.files.set(`${HOME}/.claude/sessions/417.json`, idleHost)
  const next = await prWake(world.dollar, told)
  // Idle again by the next tick: what kept it open, then the close.
  expect(next.lines).toEqual(['[module] Agent: p17 (acme/app#17): left open: its host is busy.', closedLine('acme/app#17', 'merged')])
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
  expect(closes(both.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17'])
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
  expect([then.lines, closes(idle.runs)]).toEqual([[closedLine('acme/app#17', 'is Ready')], ['--tty /dev/ttys000 --expect-title Agent: p17']])
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

// A pull request worked by two agents still running: the line names the last one put on it and the one before.
const twoAgentsLine = JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 17, status: 'working', agent: 'Agent: p17', earlier: ['Agent: p18'], since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:30:00Z' })
const P18_DONE = doneAgent('s-p18', 'Agent: p18', 418, '/dev/ttys001')
const P18_CLOSED = closedLine('acme/app#17', 'merged', 'Agent: p18', 's-p18')

test('a merge closes every live agent of its line, each told once, not the first alone', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'merged'), P18_CLOSED])
  await woke.settle()
  expect(closes(world.runs).sort()).toEqual(['--tty /dev/ttys000 --expect-title Agent: p17', '--tty /dev/ttys001 --expect-title Agent: p18'])
  expect(world.files.get(RECORD)).not.toContain('"pr":17')
})

test('a pull request closed unmerged closes every live agent of its line', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': '[]' }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: running('Agent: p17', 'Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'closed unmerged'), closedLine('acme/app#17', 'closed unmerged', 'Agent: p18', 's-p18')])
  await woke.settle()
  expect(closes(world.runs)).toHaveLength(2)
})

test('a merge judges each agent of its line alone: the one that holds another row is told, the other is closed', async () => {
  const held = `${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${rowOf(9, 'open', { agent: 'Agent: p17' })}`
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${held}\n${twoAgentsLine}\n`, ...launched('/briefs/app', 'Agent: p17', 8), ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 9 (app); tell it.', P18_CLOSED])
  await woke.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys001 --expect-title Agent: p18'])
})

test('a merge closes the agent of its line that is idle and waits for the one that is busy: its line is kept, the busy one closed at the first tick it is idle', async () => {
  const busyHost = { [`${HOME}/.claude/sessions/417.json`]: JSON.stringify({ pid: 417, sessionId: 's-p17', cwd: '/work/s-p17', status: 'busy' }) }
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE, ...busyHost }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18') })
  const told = new Set<string>()
  const first = await prWake(world.dollar, told)
  expect(first.lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 left open until it is done and idle (its host is busy).', P18_CLOSED])
  expect(first.watching).toBe(true)
  await first.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys001 --expect-title Agent: p18'])
  expect(world.files.get(RECORD)).toContain('"pr":17')
  world.files.set(`${HOME}/.claude/sessions/417.json`, JSON.stringify({ pid: 417, sessionId: 's-p17', cwd: '/work/s-p17', status: 'idle' }))
  const then = await prWake(world.dollar, told)
  expect(then.lines).toEqual([closedLine('acme/app#17', 'merged')])
  await then.settle()
  expect(closes(world.runs)).toHaveLength(2)
  expect(world.files.get(RECORD)).not.toContain('"pr":17')
})

test('a Ready pull request closes every live agent of its line, each told once', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17', 'Agent: p18') })
  const told = new Set<string>()
  const woke = await prWake(world.dollar, told)
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready'), closedLine('acme/app#17', 'is Ready', 'Agent: p18', 's-p18')])
  await woke.settle()
  expect(closes(world.runs)).toHaveLength(2)
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a Ready pull request whose second agent is not done yet tells the first, and the second at the tick it is done, not before', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17', 'Agent: p18') })
  // The second agent took a message: its last turn is no longer a done.
  world.files.delete(`${STATE}/store/waits/s-p18`)
  const told = new Set<string>()
  const first = await prWake(world.dollar, told)
  expect(first.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await first.settle()
  world.files.set(`${STATE}/store/waits/s-p18`, P18_DONE[`${STATE}/store/waits/s-p18`]!)
  const second = await prWake(world.dollar, told)
  expect(second.lines).toEqual([closedLine('acme/app#17', 'is Ready', 'Agent: p18', 's-p18')])
  await second.settle()
  expect(closes(world.runs)).toHaveLength(2)
})

// The record of the orchestration registered under two spellings of one path (a symlinked directory): one record.
const LINK = '/links/app/dispatch-record.jsonl'
const spelled = (order: readonly string[]): Record<string, string> => ({ [`${STATE}/records/s-orch`]: `${order.join('\n')}\n`, [`${LINK}.owner`]: `${ORCH}\n` })

test('a merge whose two agents the launcher refuses tells each refusal once, and the next tick says nothing more', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17', 'Agent: p18'), dirty: ' M a.txt' })
  const told = new Set<string>()
  // No settle between the ticks: the ended line stays in its record, read again.
  const first = await prWake(world.dollar, told)
  const open = (agent: string) => `[module] acme/app#17 merged: its agent ${agent} left open: tree not clean in /work/${agent === 'Agent: p17' ? 's-p17' : 's-p18'} (1 paths changed, 0 commits unpushed).`
  expect(first.lines).toEqual([open('Agent: p17'), open('Agent: p18')])
  expect((await prWake(world.dollar, told)).lines).toEqual([])
})

test('a Ready head of two agents in an auto-merge repository says to merge once, with the first agent\'s line', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${twoAgentsLine}\n`, ...P17_DONE, ...P18_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17', 'Agent: p18'), autoMerge: { result: 'acme/app' } })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready') + MERGE_NOW, closedLine('acme/app#17', 'is Ready', 'Agent: p18', 's-p18')])
})

// A record of another session of the machine that names the orchestration as its owner, and the registry of the orchestrator's own.
const registered = (own: string, other: string): Record<string, string> => ({
  [`${STATE}/records/s-orch`]: `${own}\n`, [`${STATE}/records/s-other`]: `${other}\n`, [`${LINK}.owner`]: `${ORCH}\n`,
})

test('the one record the orchestrator\'s own registry and another session\'s registry name by its two spellings is read once, in either order', async () => {
  for (const [own, other] of [[RECORD, LINK], [LINK, RECORD]] as const) {
    const rows = `${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${mergedLine}\n`
    const world = fake({ session: 's-orch', reportsTo: null, links: { [LINK]: RECORD }, rows: { [RECORD]: rows, ...registered(own, other), ...launched('/briefs/app', 'Agent: p17', 8), ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
    expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'merged')])
  }
})

test('the one record registered under two spellings of its path is read once: a merge is told once and the row of the agent\'s own brief holds nothing', async () => {
  for (const order of [[RECORD, LINK], [LINK, RECORD]]) {
    const rows = `${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${mergedLine}\n`
    const world = fake({ session: 's-orch', reportsTo: null, links: { [LINK]: RECORD }, rows: { [RECORD]: rows, ...spelled(order), ...launched('/briefs/app', 'Agent: p17', 8), ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
    const woke = await prWake(world.dollar, new Set())
    expect(woke.lines).toEqual([closedLine('acme/app#17', 'merged')])
    await woke.settle()
    expect(closes(world.runs)).toHaveLength(1)
  }
})

test('the one record registered under two spellings of its path is read once at Ready too: the agent\'s own row keeps it open no more, one line is told', async () => {
  const rows = `${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${P17_LINE}\n`
  const world = fake({ session: 's-orch', reportsTo: null, links: { [LINK]: RECORD }, rows: { [RECORD]: rows, ...spelled([RECORD, LINK]), ...launched('/briefs/app', 'Agent: p17', 8), ...P17_DONE }, forge: { 'acme/app': READY_PR }, launcher: running('Agent: p17') })
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([closedLine('acme/app#17', 'is Ready')])
  await woke.settle()
  expect(closes(world.runs)).toHaveLength(1)
})

test('another row of the record that names the agent still holds it, whatever the spellings the record is registered under', async () => {
  const rows = `${rowOf(8, 'open', { agent: 'Agent: p17' })}\n${rowOf(9, 'open', { agent: 'Agent: p17' })}\n${mergedLine}\n`
  const world = fake({ session: 's-orch', reportsTo: null, links: { [LINK]: RECORD }, rows: { [RECORD]: rows, ...spelled([RECORD, LINK]), ...launched('/briefs/app', 'Agent: p17', 8), ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 merged: its agent Agent: p17 still holds row 9 (app); tell it.'])
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

// A pull request whose CI the gate read (the github reconciler's reading, or the one ci-watch kept): the forge's head `sha`, the readings by pull request.
const AT_A = 'a'.repeat(40)
const AT_B = 'b'.repeat(40)
const gateJson = (result: string, head: string, failed: string[] = [], pr = 17) => JSON.stringify({
  v: 1, repo: 'acme/app', pr, head, base: 'main', draft: false, labels: ['Not Ready'], ci: { result, running: result === 'PENDING' ? 1 : 0, failed, unverified: [], checks: [] },
  missing: result === 'SUCCESS' ? [] : [`ci: ${result}`], at: '2026-11-19T10:00:00Z', fingerprint: 'f',
})
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
  const woke = await prWake(world.dollar, told, T0)
  expect(woke.lines).toEqual([FAILING_LINE])
  // The reconciler's reading is kept where ci-watch keeps its own, with no gate run of the tick's own.
  expect(world.files.get(KEPT_17)).toEqual(gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']))
  expect((await prWake(world.dollar, told, T0 + 10 * 60_000)).lines).toEqual([])
  expect(world.gateRuns).toEqual([])
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

test('a failing head with no agent on its pull request says so', async () => {
  const alone = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)']) }, AT_A, { launcher: '' })
  expect((await prWake(alone.dollar, new Set(), T0)).lines[0]).toEqual("[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; personne n'y travaille, mets-y un agent.")
})

test('a failing head whose line waits on a recorded wait with no agent names that wait, not an agent', async () => {
  const waiting = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)']) }, AT_A, { launcher: '', rows: { [RECORD]: `${ledgerLine(17, 'waiting', { on: 'GeoSecureBeltFirmware#25 merged into main' })}\n` } })
  const lines = (await prWake(waiting.dollar, new Set(), T0)).lines
  // The anomaly line the same unattended waiting line raises is the existing one, told beside the red.
  expect(lines[0]).toEqual('[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; attend GeoSecureBeltFirmware#25 merged into main.')
  expect(lines.some(line => line.includes('mets-y un agent'))).toBe(false)
})

test('a failing head with no line to name a wait, or a wait no agent holds, still says to put an agent on it', () => {
  const failed = { repo: 'acme/app', pr: 17, head: AT_A, failed: ['tests (8.4)'] }
  expect(ciFailingLine(failed)).toEqual("[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; personne n'y travaille, mets-y un agent.")
  expect(ciFailingLine({ ...failed, waits: 'a\nb' })).toEqual('[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; attend a b.')
  expect(ciFailingLine({ ...failed, waits: ' \n' })).toEqual("[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; personne n'y travaille, mets-y un agent.")
})

test('a draft is read and told like any pull request, its failed checks without its draft guards, classified once per head', async () => {
  const gate = gateJson('FAILURE', AT_A, ['tests (8.4)', 'draft guard'])
  const draft = checked({ 17: gate }, AT_A, { guards: { 17: 'tests (8.4)\n' } }, true)
  const told = new Set<string>()
  expect((await prWake(draft.dollar, told, T0)).lines).toEqual(['[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4) ; dis-le à son agent Agent: p17 (session s-p17).'])
  expect(draft.guardRuns).toEqual([{ argv: ['bash', '/plugins/orch/skills/orchestrator/scripts/draft-guard.sh', 'acme/app', '17'], stdin: gate }])
  expect((await prWake(draft.dollar, told, T0 + 60_000)).lines).toEqual([])
  expect(draft.guardRuns).toHaveLength(1)
})

test('a draft whose only failed check is a draft guard is told nothing, and not classified again at that head', async () => {
  const draft = checked({ 17: gateJson('FAILURE', AT_A, ['draft guard']) }, AT_A, { guards: { 17: '' } }, true)
  const told = new Set<string>()
  expect((await prWake(draft.dollar, told, T0)).lines).toEqual([])
  expect((await prWake(draft.dollar, told, T0 + 60_000)).lines).toEqual([])
  expect(draft.guardRuns).toHaveLength(1)
  // The same failure on a pull request out of draft is no guard's: it is told.
  const ready = checked({ 17: gateJson('FAILURE', AT_A, ['draft guard']) }, AT_A, { guards: { 17: '' } })
  expect((await prWake(ready.dollar, new Set(), T0)).lines).toHaveLength(1)
  expect(ready.guardRuns).toEqual([])
})

test('a draft whose guards cannot be classified keeps every failed check: a red is reported, never lost', async () => {
  const draft = checked({ 17: gateJson('FAILURE', AT_A, ['tests (8.4)', 'draft guard']) }, AT_A, { guards: { 17: null } }, true)
  expect((await prWake(draft.dollar, new Set(), T0)).lines).toEqual(['[module] acme/app#17 CI en échec à aaaaaaa : tests (8.4), draft guard ; dis-le à son agent Agent: p17 (session s-p17).'])
  expect(draft.logged.some(l => l.includes('draft guards of acme/app#17 not classified: draft-guard: gh failed'))).toBe(true)
})

test('a reading already kept as a verdict at the head is told as kept; one of another head is replaced by the reconciler\'s at the head', async () => {
  const kept = checked({ 17: gateJson('SUCCESS', AT_A) }, AT_A, { rows: { [KEPT_17]: gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']) } })
  expect((await prWake(kept.dollar, new Set(), T0)).lines).toEqual([FAILING_LINE])
  expect(kept.files.get(KEPT_17)).toEqual(gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']))
  const stale = checked({ 17: gateJson('FAILURE', AT_B, ['lint']) }, AT_B, { rows: { [KEPT_17]: gateJson('SUCCESS', AT_A) } })
  expect((await prWake(stale.dollar, new Set(), T0)).lines).toHaveLength(1)
  expect(stale.files.get(KEPT_17)).toEqual(gateJson('FAILURE', AT_B, ['lint']))
})

test('a reading not yet a verdict is taken again from the reconciler at each tick, and the failure it then finds is told', async () => {
  const gate: Record<number, string | null> = { 17: gateJson('PENDING', AT_A) }
  const world = checked(gate)
  const told = new Set<string>()
  expect((await prWake(world.dollar, told, T0)).lines).toEqual([])
  expect(world.files.get(KEPT_17)).toEqual(gateJson('PENDING', AT_A))
  world.files.set(`${HOME}/.claude/pr-reconcile/acme/app/17.json`, gateJson('FAILURE', AT_A, ['tests (8.4)', 'lint']))
  expect((await prWake(world.dollar, told, T0 + 60_000)).lines).toEqual([FAILING_LINE])
  expect(world.gateRuns).toEqual([])
})

test('a pull request the reconciler holds no reading of at its head tells nothing and keeps nothing', async () => {
  const none = checked({})
  expect((await prWake(none.dollar, new Set(), T0)).lines).toEqual([])
  const other = checked({ 17: gateJson('FAILURE', AT_B, ['lint']) })
  expect((await prWake(other.dollar, new Set(), T0)).lines).toEqual([])
  expect([none.files.has(KEPT_17), other.files.has(KEPT_17), none.gateRuns, other.gateRuns]).toEqual([false, false, [], []])
})

// A reconciler reading of pull request 17 at its head taken against `base` (none: a reading that names no base); the forge lists the pull request on `listed`.
const gateOn = (result: string, head: string, base: string | null): string => {
  const { base: _, ...rest } = JSON.parse(gateJson(result, head)) as Record<string, unknown>
  return JSON.stringify(base === null ? rest : { ...rest, base })
}
const onBase = (listed: string, kept: string, reading: string) => checked({ 17: reading }, AT_A, {
  rows: { [KEPT_17]: kept },
  forge: { 'acme/app': JSON.stringify([{ number: 17, createdAt: '2026-11-15T06:00:00Z', mergeable: 'MERGEABLE', sha: AT_A, base: listed }]) },
})

// How many times the tick wrote the kept reading of pull request 17 (each write lands by a rename onto its path).
const keptWrites = (world: { runs: string[][] }): number => world.runs.filter(argv => argv[0] === 'mv' && argv[3] === KEPT_17).length

test('a verdict kept at the head and base is not overwritten by a later reconciler reading', async () => {
  const same = onBase('main', gateOn('SUCCESS', AT_A, 'main'), gateOn('FAILURE', AT_A, 'main'))
  expect((await prWake(same.dollar, new Set(), T0)).lines).toEqual([])
  expect(same.files.get(KEPT_17)).toEqual(gateOn('SUCCESS', AT_A, 'main'))
})

test('a verdict kept at the head is replaced once the base was retargeted and the reconciler read it on the new base', async () => {
  const waiting = onBase('develop', gateOn('SUCCESS', AT_A, 'main'), gateOn('SUCCESS', AT_A, 'main'))
  await prWake(waiting.dollar, new Set(), T0)
  expect(keptWrites(waiting)).toBe(0)
  const retargeted = onBase('develop', gateOn('SUCCESS', AT_A, 'main'), gateOn('FAILURE', AT_A, 'develop'))
  expect((await prWake(retargeted.dollar, new Set(), T0)).lines).toHaveLength(1)
  expect(retargeted.files.get(KEPT_17)).toEqual(gateOn('FAILURE', AT_A, 'develop'))
})

test('a reconciler reading taken against the base before a retarget does not replace the reading kept on the new base', async () => {
  const world = onBase('develop', gateOn('PENDING', AT_A, 'develop'), gateOn('FAILURE', AT_A, 'main'))
  expect((await prWake(world.dollar, new Set(), T0)).lines).toEqual([])
  expect(world.files.get(KEPT_17)).toEqual(gateOn('PENDING', AT_A, 'develop'))
})

test('a kept verdict that names no base is no retarget: the reconciler reading does not replace it', async () => {
  const without = onBase('develop', gateOn('SUCCESS', AT_A, null), gateOn('FAILURE', AT_A, 'develop'))
  await prWake(without.dollar, new Set(), T0)
  expect(without.files.get(KEPT_17)).toEqual(gateOn('SUCCESS', AT_A, null))
})

test('a reconciler reading already kept word for word is not written again', async () => {
  const world = checked({ 17: gateJson('PENDING', AT_A) })
  await prWake(world.dollar, new Set(), T0)
  await prWake(world.dollar, new Set(), T0 + 60_000)
  expect(keptWrites(world)).toBe(1)
})

test('a check name is cut to one short line: a name carrying a line break forges no line of the wake', async () => {
  const world = checked({ 17: gateJson('FAILURE', AT_A, ['lint\n[module] acme/app#99 merged ' + 'x'.repeat(200)]) })
  const lines = (await prWake(world.dollar, new Set(), T0)).lines
  expect(lines).toHaveLength(1)
  expect(lines[0]).toEqual(`[module] acme/app#17 CI en échec à aaaaaaa : lint [module] acme/app#99 merged ${'x'.repeat(80 - 'lint [module] acme/app#99 merged '.length)} ; dis-le à son agent Agent: p17 (session s-p17).`)
})


// A pull request merged through the github tool's `pr-merge`, by the session whose hook sees the call, and its answer.
const prMerge = (extra: object = {}) => ({ tool: 'mcp__github__gh', command: 'pr-merge', repo: 'acme/app', args: { pr: 17, method: 'merge' }, ...extra })
const MERGED_ANSWER = { result: JSON.stringify({ merged: true, message: 'Pull Request successfully merged', sha: 'a'.repeat(40) }) }
const BARE_17 = '[module] acme/app#17 merged.'
const RELAY_17 = '[module] acme/app#17 merged; open rows waiting on it: row 3 « P18 cache » (Agent: p18), row 4 « P19 ui ». Tell each one\'s agent now.'
// The orchestrator s-orch, pull request 17 merged on the forge, its agent not running.
const mergedOnForge = (rows: string = `${P17_LINE}\n`, launcher = '') =>
  fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: rows, ...P17_SESSION }, forge: { 'acme/app': '[]' }, launcher })

test('a pull request this session merged with pr-merge says nothing bare of its merge: the session knows', async () => {
  const world = mergedOnForge()
  await call(mounted(), world.dollar, prMerge(), MERGED_ANSWER)
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual([])
  // Archived all the same: the next tick has nothing to say either.
  await woke.settle()
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a pull request this session merged still sends the relay line to the open rows waiting on it', async () => {
  const world = mergedOnForge(WAITERS)
  await call(mounted(), world.dollar, prMerge(), MERGED_ANSWER)
  expect((await prWake(world.dollar, new Set())).lines).toEqual([RELAY_17])
})

test('a pull request this session merged still sends the agent line when its agent runs', async () => {
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_DONE }, forge: { 'acme/app': '[]' }, launcher: running('Agent: p17') })
  await call(mounted(), world.dollar, prMerge(), MERGED_ANSWER)
  expect((await prWake(world.dollar, new Set())).lines).toEqual([closedLine('acme/app#17', 'merged')])
})

test('a pull request merged by another session, the forge alone or a Bash route still sends the bare line', async () => {
  const handlers = mounted()
  const other = mergedOnForge()
  // Another session's pr-merge: its hook runs in its own session, not the orchestrator's.
  await call(handlers, fake({ session: 's-other' }).dollar, prMerge(), MERGED_ANSWER)
  expect((await prWake(other.dollar, new Set())).lines).toEqual([BARE_17])
  // The forge alone (auto-merge, the operator): no call of this session.
  expect((await prWake(mergedOnForge().dollar, new Set())).lines).toEqual([BARE_17])
  // A Bash `gh pr merge`, and another pull request's pr-merge.
  const bash = mergedOnForge()
  await call(handlers, bash.dollar, { tool: 'Bash', command: 'gh pr merge 17 -R acme/app --merge' }, { result: '✓ Merged pull request acme/app#17' })
  await call(handlers, bash.dollar, prMerge({ args: { pr: 18 } }), MERGED_ANSWER)
  await call(handlers, bash.dollar, prMerge({ repo: 'acme/lib' }), MERGED_ANSWER)
  expect((await prWake(bash.dollar, new Set())).lines).toEqual([BARE_17])
})

test('a pr-merge that failed or merged nothing, then a merge elsewhere, still sends the bare line', async () => {
  const handlers = mounted()
  const world = mergedOnForge()
  await call(handlers, world.dollar, prMerge(), { result: 'github: pr-merge refused on acme/app#17: not ready.', isError: true })
  await call(handlers, world.dollar, prMerge(), { deny: 'refused by a guard' })
  await call(handlers, world.dollar, prMerge(), { result: JSON.stringify({ merged: false, message: 'Head branch was modified' }) })
  await call(handlers, world.dollar, prMerge(), { result: 'not json' })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([BARE_17])
})

test('a pr-merge answered by its JSON then an error line still says its merge: the session knows', async () => {
  const world = mergedOnForge()
  // The real answer of a merge on a private repository: the merge, then the forge's notice of a stacked base it could not read.
  const notice = 'error: cannot read whether fix/settings-lease-push is a stacked base: Upgrade to GitHub Pro'
  await call(mounted(), world.dollar, prMerge(), { result: `${MERGED_ANSWER.result}\n${notice}` })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a pr-merge answered by merged: false then an error line says no merge: the bare line is sent', async () => {
  const world = mergedOnForge()
  const notice = 'error: cannot read whether fix/settings-lease-push is a stacked base: Upgrade to GitHub Pro'
  await call(mounted(), world.dollar, prMerge(), { result: `${JSON.stringify({ merged: false, message: 'Head branch was modified' })}\n${notice}` })
  expect((await prWake(world.dollar, new Set())).lines).toEqual([BARE_17])
})

test('a pull request closed unmerged is told as before, whatever this session merged', async () => {
  const handlers = mounted()
  const world = fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${P17_LINE}\n`, ...P17_SESSION }, forge: { 'acme/app': '[]' }, closed: { 'acme/app': { 17: 'CLOSED' } }, launcher: '' })
  await call(handlers, world.dollar, prMerge(), MERGED_ANSWER)
  expect((await prWake(world.dollar, new Set())).lines).toEqual(['[module] acme/app#17 closed unmerged.'])
})

test('the own merge is told apart once: the same pull request merged again elsewhere later sends the bare line', async () => {
  const handlers = mounted()
  const world = mergedOnForge()
  await call(handlers, world.dollar, prMerge(), MERGED_ANSWER)
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
  const again = mergedOnForge()
  expect((await prWake(again.dollar, new Set())).lines).toEqual([BARE_17])
})

test('the own merge is matched whatever the case of the repository the call names', async () => {
  const world = mergedOnForge()
  await call(mounted(), world.dollar, prMerge({ repo: 'Acme/App', args: { pr: '#17' } }), MERGED_ANSWER)
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a failure of the bookkeeping leaves the tool answer as it came', async () => {
  const world = mergedOnForge()
  const broken = { ...world.dollar, session: { id: async () => { throw new Error('no session') } } } as unknown as World
  expect(await call(mounted(), broken, prMerge(), MERGED_ANSWER)).toEqual(MERGED_ANSWER)
})

// The review session of acme/app#17 at 0123456, its round's verdict recorded: its launch names the review brief, its host idle in its pin.
const reviewSession = (status: 'idle' | 'busy' = 'idle', tty = '/dev/ttys000'): Record<string, string> => ({
  [`${STATE}/store/sessions/s-rev`]: row('agent', 'Agent: review 17 r1 [a1b2c3]', tty),
  [`${HOME}/.claude/sessions/450.json`]: JSON.stringify({ pid: 450, sessionId: 's-rev', cwd: '/work/review-17-r1', status }),
  [`${STATE}/prompts/launch-Agent--review-17-r1-1700000000000.sh`]: "export ORCHESTRATOR_BRIEF='/briefs/app/review-17-brief.md'\n",
  '/briefs/app/review-17-brief.md': [
    '# app — review: the delivery', '', 'You are the REVIEW agent for this round. You read; you never implement.', '',
    "4. The delivery: pull request 17 (the implementer's report, `/b/report.md`), branch `fix/x`, head `0123456789`, base `origin/main`",
  ].join('\n'),
})
const HEAD17 = '0123456789abcdef0123456789abcdef01234567'
const REVIEW_TAB = running('Agent: review 17 r1')
// The verdict recorded: the module owes the close (review-close.ts), its cost on row 4 of the record.
const owe = (world: ReturnType<typeof fake>, session = 's-orch') => oweRound(world.dollar, { session, pr: 17, round: async () => ({ repo: 'acme/app', head: HEAD17 }), cost: { record: RECORD, row: 4 } })
const reviewWorld = (over: Over = {}, status: 'idle' | 'busy' = 'idle') => fake({ session: 's-orch', reportsTo: null, rows: { [RECORD]: `${rowOf(4, 'open', { label: 'P17 acme/app#17' })}\n`, ...reviewSession(status) }, forge: { 'acme/app': '[]' }, launcher: REVIEW_TAB, ...over })
const drainOwed = (): void => ['s-orch', 's-other'].forEach(session => owedOf(session).forEach(settleOwed))

test('a review session whose round\'s verdict is recorded is closed by the module once idle, its pin with it, its cost on the row of the verdict; the tick says nothing', async () => {
  drainOwed()
  const world = reviewWorld()
  expect(await owe(world)).toBe('review session of acme/app#17 0123456: Agent: review 17 r1 is closed by the module once its turn ends.')
  const woke = await prWake(world.dollar, new Set())
  expect([woke.lines, woke.watching]).toEqual([[], true])
  expect(closes(world.runs)).toEqual([])
  await woke.settle()
  expect(closes(world.runs)).toEqual(['--tty /dev/ttys000 --expect-title Agent: review 17 r1'])
  expect(world.runs.filter(argv => argv[2] === 'cost')).toEqual([['bash', '/plugins/orch/skills/orchestrator/scripts/dispatch-record.sh', 'cost', RECORD, '4', '--session', 's-rev']])
  expect(owedOf('s-orch')).toEqual([])
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a review session still busy when the verdict lands is closed at the end of its turn, never mid-turn: the owed close waits, silent, for the tick that finds it idle', async () => {
  drainOwed()
  const busy = reviewWorld({}, 'busy')
  await owe(busy)
  const first = await prWake(busy.dollar, new Set())
  await first.settle()
  expect([first.lines, first.watching, closes(busy.runs), owedOf('s-orch').length]).toEqual([[], true, [], 1])
  const idle = reviewWorld()
  const then = await prWake(idle.dollar, new Set())
  await then.settle()
  expect([then.lines, closes(idle.runs), owedOf('s-orch')]).toEqual([[], ['--tty /dev/ttys000 --expect-title Agent: review 17 r1'], []])
})

test('a review session whose pin has changes or unpushed commits is left open and told once, its close no longer owed', async () => {
  drainOwed()
  const world = reviewWorld({ dirty: ' M a.ts\n' })
  await owe(world)
  const woke = await prWake(world.dollar, new Set())
  expect(woke.lines).toEqual(['[module] Agent: review 17 r1 (acme/app#17 0123456): left open: tree not clean in /work/review-17-r1 (1 paths changed, 0 commits unpushed).'])
  await woke.settle()
  expect([closes(world.runs), owedOf('s-orch')]).toEqual([[], []])
  expect((await prWake(world.dollar, new Set())).lines).toEqual([])
})

test('a review session of another orchestration is never closed: its tab is on no chain of this one, and what another session owes is that session\'s', async () => {
  drainOwed()
  const foreign = reviewWorld({ launcher: 'w2/t7 | /dev/ttys007 | ✳ Agent: review 17 r1 | Agent: review 17 r1' })
  await owe(foreign)
  const woke = await prWake(foreign.dollar, new Set())
  await woke.settle()
  expect(closes(foreign.runs)).toEqual([])
  drainOwed()
  const other = reviewWorld()
  await owe(other, 's-other')
  const idle = await prWake(other.dollar, new Set())
  await idle.settle()
  expect([closes(other.runs), owedOf('s-other').length]).toEqual([[], 1])
  drainOwed()
})

test('a close owed for longer than an hour is given up, logged: a session gone or busy for good keeps nothing watched', async () => {
  drainOwed()
  const world = reviewWorld()
  await owe(world)
  const woke = await prWake(world.dollar, new Set(), Date.now() + OWED_MS + 1000)
  await woke.settle()
  expect([woke.lines, closes(world.runs), owedOf('s-orch')]).toEqual([[], [], []])
  expect(world.logged.some(line => line.includes('given up'))).toBe(true)
})

test('a review session that took a message between the tick and the close is not closed mid-turn: nothing is said, the close stays owed and is made once it is idle again', async () => {
  drainOwed()
  const world = reviewWorld()
  await owe(world)
  const next = new Set<string>()
  const woke = await prWake(world.dollar, next)
  const host = `${HOME}/.claude/sessions/450.json`
  world.files.set(host, world.files.get(host)!.replace('"idle"', '"busy"'))
  await woke.settle()
  expect([closes(world.runs), owedOf('s-orch').length]).toEqual([[], 1])
  expect((await prWake(world.dollar, next)).lines).toEqual([])
  world.files.set(host, world.files.get(host)!.replace('"busy"', '"idle"'))
  const then = await prWake(world.dollar, next)
  await then.settle()
  expect([then.lines, closes(world.runs), owedOf('s-orch')]).toEqual([[], ['--tty /dev/ttys000 --expect-title Agent: review 17 r1'], []])
})
