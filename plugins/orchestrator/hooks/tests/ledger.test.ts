// hooks/tests/ledger.test.ts
// The pull request ledger line written at creation (core's pr-ledger.ts): a pull request opened through
// the github tool or `gh pr create`, in any repository, takes its line in the dispatch record of the
// orchestration the creating session belongs to — an agent's, its orchestrator's — once; a session of
// no orchestration writes nothing, and a write that fails changes nothing of the tool's answer.
import { expect, test } from 'claude-code/testing'
import { createdPr, register } from '../ledger.ts'
import { logLineOf, lockRun } from './fakes.ts'

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
  const dollar: any = {
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
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
      stat: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return { kind: 'file', size: files.get(p)!.length, mtimeMs: 1 } },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, isLink: false, mtimeMs: 0 })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logged.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        runs.push([...argv])
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2])!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: argv[0] === 'ps' ? 1 : 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, logged, runs }
}

function mounted() {
  const handlers: Record<string, Function> = {}
  register(((...args: unknown[]) => {
    handlers[String((args[1] as { tool?: string })?.tool)] = args[args.length - 1] as Function
    return { catch: () => undefined }
  }) as never, () => new Date('2026-11-14T10:15:00.400Z'))
  return handlers
}

const github = (extra: object = {}) => ({ tool: 'mcp__github__gh', command: 'pr-create', args: { title: 't', draft: true }, ...extra })
const created = (url: string) => ({ result: JSON.stringify({ number: Number(url.split('/').pop()), html_url: url }) })
const ledgerOf = (files: Map<string, string>, path = RECORD) =>
  (files.get(path) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.ledger === 'pr')
const call = async (handlers: Record<string, Function>, dollar: unknown, e: Record<string, unknown>, answer: unknown) =>
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
