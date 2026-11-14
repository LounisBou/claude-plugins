// hooks/tests/unattended.test.ts
// The pull requests nobody attends, over a faked $: the forge's open list against the session's
// ledger, the agents the launcher lists running, the other orchestrators' claims; the lines of the
// pull requests no longer open moved to the archive; the line the turn end leaves for the next
// prompt's context and the session's row; and the one refusal of a done or a deferred wait.
import { expect, test } from 'claude-code/testing'
import { forgeArgv, parseOpenPrs, readUnattended, register as registerUnattended, unattendedRefusal } from '../unattended.ts'
import { register as registerWait, Declarations, WAIT_TOOL } from '../wait.ts'
import { logLineOf, lockRun } from './fakes.ts'

const HOME = '/tmp/unattended-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/briefs/app/dispatch-record.jsonl'
const OTHER_RECORD = '/briefs/web/dispatch-record.jsonl'
const NOW = Date.parse('2026-11-14T11:00:00Z')

const line = (pr: number, status: string, detail: Record<string, string>, updated = '2026-11-14T10:50:00Z') =>
  JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr, status, ...detail, since: '2026-11-14T09:00:00Z', updated })

// A row measured now: a live session on the clock a hook reads (the turn end) as on the fixed one of a reading.
const row = (role: string, name: string, repo: string | null = 'acme/app', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ role, name, repo, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString(), ...extra })

type Answers = { forge?: Record<string, string | null>; launcher?: string | null; ps?: string | null }

function world(answers: Answers = {}) {
  const files = new Map<string, string>([
    [`${MODULE}/store/sessions/s-orch`, row('orchestrator', 'Orch: app')],
    [`${MODULE}/records/s-orch`, `${RECORD}\n`],
    [`${RECORD}.owner`, 'Orch: app\n'],
    [RECORD, [
      JSON.stringify({ id: 1, state: 'open', label: 'a row' }),
      line(7, 'working', { agent: 'Agent: seven' }),
      line(8, 'waiting', { on: 'la CI' }, '2026-11-14T10:00:00Z'),
      line(5, 'working', { agent: 'Agent: five' }),
      line(6, 'parked', { ruling: 'plus tard, 2026-11-14' }),
    ].join('\n') + '\n'],
    [`${MODULE}/store/sessions/s-other`, row('orchestrator', 'Orch: web')],
    [`${MODULE}/records/s-other`, `${OTHER_RECORD}\n`],
    [OTHER_RECORD, line(10, 'working', { agent: 'Agent: ten' }) + '\n'],
  ])
  const logs: string[] = []
  const runs: string[][] = []
  const forge = answers.forge ?? { 'acme/app': JSON.stringify([7, 8, 6, 9, 10].map(n => ({ number: n, createdAt: `2026-11-1${n % 10}T08:00:00Z` }))) }
  const dollar: any = {
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    session: { id: async () => 's-orch' },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: files.get(p)!.length, mtimeMs: NOW } },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        runs.push([...argv])
        if (argv[0] === 'mv') { files.set(argv[3], files.get(argv[2])!); files.delete(argv[2]); return { exitCode: 0, stdout: '', stderr: '' } }
        if (argv[0] === 'rm') { for (const p of argv.slice(2)) files.delete(p); return { exitCode: 0, stdout: '', stderr: '' } }
        if (argv[0] === 'gh') {
          const answer = forge[argv[4]]
          return answer === null || answer === undefined ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : { exitCode: 0, stdout: answer, stderr: '' }
        }
        if (argv[0] === 'ps') {
          return answers.ps === undefined || answers.ps === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: answers.ps, stderr: '' }
        }
        if (argv[0] === 'bash' && argv[2] === 'list') {
          const listed = answers.launcher === undefined ? 'w1/t1 | /dev/ttys001 | ✳ Agent: seven | Agent: seven\nw1/t2 | /dev/ttys002 | zsh | Agent: five' : answers.launcher
          return listed === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: listed, stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    ui: { invalidate: () => undefined },
  }
  return { dollar, files, logs, runs }
}

test('the forge is asked for the open pull requests opened under the operator\'s account, and its answer read', () => {
  expect(forgeArgv('acme/app')).toEqual(['gh', 'pr', 'list', '-R', 'acme/app', '--state', 'open', '--author', '@me', '--limit', '200', '--json', 'number,createdAt'])
  expect(parseOpenPrs('acme/app', '[{"number":3,"createdAt":"t"},{"number":0},{"number":"4"},{}]')).toEqual([{ repo: 'acme/app', pr: 3, createdAt: 't' }])
  expect(parseOpenPrs('acme/app', '{}')).toBe(null)
  expect(parseOpenPrs('acme/app', 'not json')).toBe(null)
})

test('an open pull request with no live agent, a stale wait or no line is unattended; a parked one, one another orchestrator records, or one whose agent runs is not', async () => {
  const { dollar } = world()
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.list.map(u => u.pr)).toEqual([8, 9])
  expect(reading?.unread).toEqual([])
  expect(reading?.line).toBe('PR délaissées : acme/app#8 (sans agent depuis 2026-11-14T10:00Z), acme/app#9 (sans agent depuis 2026-11-19T08:00Z)')
})

test('another orchestrator\'s line claims a pull request only while that claim is alive: its session is live, or its line a wait set again within 30 minutes', async () => {
  // Its row, no pid, last measured over an hour before: a session gone (the store's own rule).
  const gone = row('orchestrator', 'Orch: web', 'acme/app', { updated_at: '2026-11-14T08:00:00Z' })
  const fresh = line(10, 'waiting', { on: 'la CI' }, '2026-11-14T10:45:00Z')
  const stale = line(10, 'waiting', { on: 'la CI' }, '2026-11-14T10:29:59Z')
  const unattendedWith = async (otherRow: string, otherLine: string, ps?: string) => {
    const { dollar, files } = world({ ps })
    files.set(`${MODULE}/store/sessions/s-other`, otherRow)
    files.set(OTHER_RECORD, `${otherLine}\n`)
    return (await readUnattended(dollar, 's-orch', NOW))?.list.map(u => u.pr)
  }
  // The live session claims whatever its line says; the record of a dead one claims only a fresh wait.
  expect(await unattendedWith(row('orchestrator', 'Orch: web'), line(10, 'working', { agent: 'Agent: ten' }))).toEqual([8, 9])
  expect(await unattendedWith(gone, line(10, 'working', { agent: 'Agent: ten' }))).toEqual([8, 9, 10])
  expect(await unattendedWith(gone, line(10, 'parked', { ruling: 'plus tard, 2026-11-14' }))).toEqual([8, 9, 10])
  expect(await unattendedWith(gone, stale)).toEqual([8, 9, 10])
  expect(await unattendedWith(gone, fresh)).toEqual([8, 9])
  // A row naming a pid is gone with it, as the pane judges it; a process table that cannot be read knows no death.
  const pid = row('orchestrator', 'Orch: web', 'acme/app', { pid: '4242' })
  expect(await unattendedWith(pid, line(10, 'working', { agent: 'Agent: ten' }), '  999 Ss ttys001\n')).toEqual([8, 9, 10])
  expect(await unattendedWith(pid, line(10, 'working', { agent: 'Agent: ten' }), ' 4242 Ss ttys001\n')).toEqual([8, 9])
  expect(await unattendedWith(pid, line(10, 'working', { agent: 'Agent: ten' }))).toEqual([8, 9])
})

test('the line of a pull request the forge no longer lists open moves to the archive beside its record', async () => {
  const { dollar, files } = world()
  await readUnattended(dollar, 's-orch', NOW)
  const archived = (files.get('/briefs/app/dispatch-record.archive.jsonl') ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(archived.map(l => [l.pr, l.status, typeof l.archived])).toEqual([[5, 'working', 'string']])
  const left = (files.get(RECORD) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(left.map(l => l.pr ?? `row ${l.id}`)).toEqual(['row 1', 7, 8, 6])
})

test('a repository the forge did not list is said unknown, never « none », and nothing of it is archived', async () => {
  const { dollar, files, logs } = world({ forge: { 'acme/app': null } })
  const reading = await readUnattended(dollar, 's-orch', NOW)
  expect(reading?.list).toEqual([])
  expect(reading?.line).toBe('PR délaissées : inconnues pour acme/app (forge illisible)')
  expect(files.has('/briefs/app/dispatch-record.archive.jsonl')).toBe(false)
  expect(logs.some(l => l.includes('forge unread for acme/app: gh exited 1: HTTP 502'))).toBe(true)
})

test('a launcher listing that cannot be read takes every agent a line names for running', async () => {
  const { dollar } = world({ launcher: null })
  expect((await readUnattended(dollar, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([8, 9])
  const { dollar: other } = world({ launcher: '' })
  expect((await readUnattended(other, 's-orch', NOW))?.list.map(u => u.pr)).toEqual([7, 8, 9])
})

test('a session that is no orchestrator reads nothing', async () => {
  const { dollar, files, runs } = world()
  files.set(`${MODULE}/store/sessions/s-orch`, row('agent', 'Agent: seven'))
  expect(await readUnattended(dollar, 's-orch', NOW)).toBe(null)
  expect(runs).toEqual([])
})

function mounted() {
  const handlers: Record<string, Function> = {}
  registerUnattended((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  return handlers
}

test('the turn end leaves the line for the next prompt\'s context, once, and on the session\'s row', async () => {
  const { dollar, files } = world()
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer', answer: 'x' }, (x: unknown) => x)
  const published = JSON.parse(files.get(`${MODULE}/store/sessions/s-orch`) ?? '{}').unattended
  expect(published.prs.map((u: { pr: number }) => u.pr)).toEqual([8, 9])
  expect(published.line).toContain('PR délaissées : acme/app#8')
  const first = await handlers['prompt.submit'](dollar, { text: 'go', context: ['before'] }, (x: any) => x)
  expect(first.context).toEqual(['before', published.line])
  const second = await handlers['prompt.submit'](dollar, { text: 'go' }, (x: any) => x)
  expect(second.context).toBe(undefined)
})

test('a turn end with nothing unattended leaves no line', async () => {
  const { dollar } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }, { number: 6 }]) } })
  const handlers = mounted()
  await handlers['turn.complete'](dollar, { reason: 'answer' }, (x: unknown) => x)
  expect((await handlers['prompt.submit'](dollar, { text: 'go' }, (x: any) => x)).context).toBe(undefined)
  // A subagent's turn end reads nothing.
  const { dollar: quiet, runs } = world()
  await handlers['turn.complete'](quiet, { agentId: 'a-1' }, (x: unknown) => x)
  expect(runs).toEqual([])
})

test('declare_wait refuses done and deferred while a pull request is unattended, naming it, and takes every other kind', async () => {
  const handlers: Record<string, Function> = {}
  const declarations = new Declarations()
  registerWait((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  }, declarations)
  const declare = (dollar: any, input: object) => handlers['tool.call'](dollar, { tool: `mcp__orchestrator__${WAIT_TOOL}`, ...input })
  const { dollar } = world()
  const done = await declare(dollar, { kind: 'done' })
  expect(done.isError).toBe(true)
  expect(done.result).toContain('Not done: PR délaissées : acme/app#8')
  expect(done.result).toContain('acme/app#9')
  expect(declarations.current()).toBe(null)
  expect((await declare(dollar, { kind: 'deferred', blocks: '1 items' })).isError).toBe(true)
  expect((await declare(dollar, { kind: 'tool', blocks: 'ci-watch.sh 12' })).isError).toBe(undefined)
  const { dollar: clear } = world({ forge: { 'acme/app': JSON.stringify([{ number: 7 }]) } })
  expect((await declare(clear, { kind: 'done' })).isError).toBe(undefined)
  expect(declarations.current()?.kind).toBe('done')
  // A forge that cannot be read holds nothing: the refusal is for a pull request known unattended.
  const { dollar: unread } = world({ forge: { 'acme/app': null } })
  expect((await declare(unread, { kind: 'done' })).isError).toBe(undefined)
  expect(unattendedRefusal('PR délaissées : x#1 (sans agent depuis ?)')).toContain('dispatch-record.sh pr <record>')
})
