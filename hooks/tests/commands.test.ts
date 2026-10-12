// hooks/tests/commands.test.ts
// The three commands the markdown files name, answered by the module without a
// model turn. The engine refuses a plugin's registration of a built-in's name —
// "/status" and "/agents" are built-ins, and a colon is outside the registered
// name's charset — so the commands stay what the markdown files declared them
// as and this module answers their runs: the matcher names the invocation
// spelling the markdown commands carry, the handler answers { text }, and the
// markdown body never runs (no model turn is spent). The store read is this
// file's own subject under test through a fake $, the same convention as the
// pane's; the engine entry at the bottom runs the real chain once.
import { expect, test, mock } from 'claude-code/testing'
import { statusText, agentsText, progressLines, parseDispatchRow, register as registerCommands } from '../commands.ts'
import type { SessionRow } from '../supervision.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const SESSIONS = `${HOME}/.claude/claude-orchestrator/store/sessions`
const RECORDS = `${HOME}/.claude/claude-orchestrator/records`

// --- the texts -----------------------------------------------------------------------------

// A row with every figure a real measure writes, overridable field by field.
function row(over: {
  role?: SessionRow['role']
  name?: string | null
  context_percent?: number
  updated_at?: string
} = {}): SessionRow {
  return {
    role: 'role' in over ? over.role : 'agent',
    name: 'name' in over ? over.name : null,
    repo: null,
    context_percent: over.context_percent ?? 30,
    context_tokens: 30000,
    window: 100000,
    model: 'a-model',
    busy: false,
    updated_at: over.updated_at ?? new Date().toISOString(),
  }
}

test('status lists the live sessions, the urgent first, or says none', () => {
  const text = statusText({
    'sessions/hot': row({ name: 'Agent : hot', context_percent: 85 }),
    'sessions/low': row({ name: 'Agent : low', context_percent: 30 }),
  })
  expect(text).toContain('Agent : hot')
  expect(text).toContain('Agent : low')
  expect(text.indexOf('Agent : hot')).toBeLessThan(text.indexOf('Agent : low'))
  expect(statusText({})).toBe('Live sessions: none measured yet.')
})

test('agents keeps the implementer agents alone and says so when none runs', () => {
  const text = agentsText({
    'sessions/agent': row({ role: 'agent', name: 'Agent : belt-p3' }),
    'sessions/coord': row({ role: 'coordinator', name: 'Coord : main' }),
    'sessions/none': row({ role: null }),
  })
  expect(text).toContain('Agent : belt-p3')
  expect(text).not.toContain('Coord : main')
  expect(text).not.toContain('unnamed')
  expect(agentsText({
    'sessions/coord': row({ role: 'coordinator', name: 'Coord : main' }),
  })).toBe('Implementer agents: none running.')
})

test('a dispatch row is one JSON line, and a line that is no row is no row', () => {
  expect(parseDispatchRow('{"id":3,"label":"Add the retry knob","state":"open","rounds":1}')).toEqual({
    id: 3, label: 'Add the retry knob', state: 'open', rounds: 1,
  })
  expect(parseDispatchRow('')).toBeNull()
  expect(parseDispatchRow('not json')).toBeNull()
  expect(parseDispatchRow('{"id":"three"}')).toBeNull()
})

test('progress names the open rows and the tally, or says no record stands', () => {
  const lines = progressLines([
    [
      { id: 1, label: 'Belt the parser', state: 'closed', rounds: 1 },
      { id: 2, label: 'Add the retry knob', state: 'open', rounds: 2 },
      { id: 3, label: '', state: 'open', rounds: 0 },
    ],
  ])
  expect(lines).toEqual([
    'open=2 label=Add the retry knob',
    'open=3 label=no label',
    'dispatches=3 closed=1 rounds_avg=1',
  ])
  expect(progressLines([])).toEqual(['no dispatch record registered'])
  expect(progressLines([[{ id: 1, label: 'x', state: 'closed', rounds: 0 }]], ['goals met=3/5 ruled_out=1 open=G3 unplanned=none']))
    .toEqual(['goals met=3/5 ruled_out=1 open=G3 unplanned=none', 'dispatches=1 closed=1 rounds_avg=0'])
})

test('progress leads with the goals line of each record that has a goals.md, and nothing for one without', async () => {
  const { registrations } = mounted()
  const progress = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:progress')!
  const fx = fakeDollar()
  const withGoals = `${HOME}/belt/dispatch.jsonl`
  const without = `${HOME}/legacy/dispatch.jsonl`
  fx.files.set(withGoals, '{"id":1,"label":"a","rounds":0,"state":"closed"}\n')
  fx.files.set(`${HOME}/belt/goals.md`, '# Goals\nspec: none\n')
  fx.files.set(without, '{"id":1,"label":"b","rounds":0,"state":"closed"}\n')
  fx.files.set(`${RECORDS}/s-one`, `${withGoals}\n${without}\n`)
  const answer = await progress.handler(fx.dollar, { command: 'orchestrator:progress', args: '' })
  expect(answer).toEqual({ text: ['goals met=3/5 ruled_out=1 open=G3 unplanned=none', 'dispatches=2 closed=2 rounds_avg=0'].join('\n') })
})

// --- the wiring ----------------------------------------------------------------------------

// The harness hands a test a $ of its own, reduced — neither fs nor process
// among its nouns — so the commands are exercised over a complete fake: an
// in-memory file map holding the store and the dispatch records, a recorded
// session id, a log the failures land in.
type Fx = {
  dollar: any
  alive: string[]
  psFails: boolean
  files: Map<string, string>
  written: string[]
  env: Record<string, string>
  sessionId: string
}

function fakeDollar(over: { failEnv?: boolean; failSession?: boolean } = {}): Fx {
  const files = new Map<string, string>()
  const written: string[] = []
  const env: Record<string, string> = { HOME }
  const fx: Fx = { dollar: null, files, written, env, sessionId: 's-one', alive: [], psFails: false }
  fx.dollar = {
    session: {
      id: async () => {
        if (over.failSession) throw new Error('session noun unavailable')
        return fx.sessionId
      },
    },
    env: {
      get: async (name: string) => {
        if (over.failEnv) throw new Error('env noun unavailable')
        return env[name]
      },
    },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => {
        files.set(p, text)
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const p of files.keys()) {
          if (!p.startsWith(`${dir}/`)) continue
          const rest = p.slice(dir.length + 1)
          if (rest) names.add(rest.split('/')[0])
        }
        return [...names].map(name => {
          const text = files.get(`${dir}/${name}`)
          return text !== undefined
            ? { name, kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
            : { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        })
      },
      exists: async (p: string) => files.has(p),
    },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) written.push(line)
        if (argv[0] === 'python3' && String(argv[1]).endsWith('/skills/orchestrator/scripts/goals.py') && argv[2] === 'line') {
          return { exitCode: 0, stdout: 'goals met=3/5 ruled_out=1 open=G3 unplanned=none\n', stderr: '' }
        }
        // ps -A -o pid=: every pid this fixture holds alive, pid 1 among them.
        if (argv[0] === 'ps' && argv[1] === '-A') {
          if (fx.psFails) throw new Error('ps did not answer in time')
          return { exitCode: 0, stdout: ['1', ...fx.alive].join('\n'), stderr: '' }
        }
        // ps -o pid= -p <list>, as the machine answers it: one pid it refuses
        // fails the whole call, exit 1 and nothing printed.
        if (argv[0] === 'ps' && argv[argv.length - 2] === '-p') {
          if (fx.psFails) throw new Error('ps did not answer in time')
          const asked = String(argv[argv.length - 1]).split(',')
          if (asked.some(pid => !fx.alive.includes(pid))) return { exitCode: 1, stdout: '', stderr: 'ps: process id too large' }
          return { exitCode: 0, stdout: asked.join('\n'), stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return fx
}

// Every registration the module makes, in order, matchers beside them — the
// three command hooks this file pins, and nothing else.
function mounted(): { registrations: { event: string; matcher: object | undefined; handler: Function }[] } {
  const registrations: { event: string; matcher: object | undefined; handler: Function }[] = []
  registerCommands((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    registrations.push({
      event: args[0],
      matcher: args.length === 3 ? args[1] : undefined,
      handler: args[args.length - 1] as Function,
    })
    return { catch: () => undefined }
  })
  return { registrations }
}

test('the module hooks the three markdown names and registers on nothing else', () => {
  // The stored-matcher convention: the engine validates neither key nor field,
  // so the exact invocation spellings live here. The names are the markdown
  // commands' own — a registered copy is refused (a built-in's name, a colon
  // outside the charset), so no session event registers anything and the
  // markdown entries stay the commands' only typeahead rows.
  const { registrations } = mounted()
  expect(registrations.map(r => [r.event, r.matcher])).toEqual([
    ['command.run', { command: 'orchestrator:status' }],
    ['command.run', { command: 'orchestrator:progress' }],
    ['command.run', { command: 'orchestrator:agents' }],
  ])
})

test('status answers the store read through its own fs calls, dropping the stale row', async () => {
  const { registrations } = mounted()
  const status = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:status')!
  const fx = fakeDollar()
  fx.files.set(`${SESSIONS}/hot`, JSON.stringify(row({ name: 'Agent : hot', context_percent: 85 })) + '\n')
  fx.files.set(`${SESSIONS}/gone`, JSON.stringify(row({ name: 'Agent : gone', updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })) + '\n')
  fx.files.set(`${SESSIONS}/torn`, 'caught mid-write')
  const answer = await status.handler(fx.dollar, { command: 'orchestrator:status', args: '' })
  expect(answer).toEqual({ text: 'Live sessions (1), most urgent first — name · role · context · last measured:\n  Agent : hot · agent · 85% past the gate · now' })
  // An absent store is no failure: nothing was ever written.
  const bare = fakeDollar()
  expect(await status.handler(bare.dollar, { command: 'orchestrator:status', args: '' })).toEqual({ text: 'Live sessions: none measured yet.' })
})

test('agents answers the agent rows alone', async () => {
  const { registrations } = mounted()
  const agents = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:agents')!
  const fx = fakeDollar()
  fx.files.set(`${SESSIONS}/agent`, JSON.stringify(row({ role: 'agent', name: 'Agent : belt-p3' })) + '\n')
  fx.files.set(`${SESSIONS}/coord`, JSON.stringify(row({ role: 'coordinator', name: 'Coord : main' })) + '\n')
  const answer = await agents.handler(fx.dollar, { command: 'orchestrator:agents', args: '' })
  expect(answer).toEqual({ text: 'Implementer agents (1), most urgent first — name · role · context · last measured:\n  Agent : belt-p3 · agent · 30% · now' })
  const bare = fakeDollar()
  expect(await agents.handler(bare.dollar, { command: 'orchestrator:agents', args: '' })).toEqual({ text: 'Implementer agents: none running.' })
})

test('agents lists a live agent no measure has written yet, beside the measured ones', async () => {
  const { registrations } = mounted()
  const agents = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:agents')!
  const fx = fakeDollar()
  const HOSTS = `${HOME}/.claude/sessions`
  fx.files.set(`${SESSIONS}/s-measured`, JSON.stringify(row({ role: 'agent', name: 'Agent : belt-p3' })) + '\n')
  // The measured agent's own record: its row already lists it, never twice.
  fx.files.set(`${HOSTS}/101.json`, JSON.stringify({ sessionId: 's-measured', name: 'Agent : belt-p3', status: 'idle' }))
  // In its first turn: no row yet, the host's record names it.
  fx.files.set(`${HOSTS}/102.json`, JSON.stringify({ sessionId: 's-first-turn', name: '"Agent : alert lists"', status: 'busy' }))
  // Not an agent, a dead agent, and a record that is no record: none listed.
  fx.files.set(`${HOSTS}/103.json`, JSON.stringify({ sessionId: 's-orch', name: 'Orch : main', status: 'idle' }))
  fx.files.set(`${HOSTS}/104.json`, JSON.stringify({ sessionId: 's-dead', name: 'Agent : gone', status: 'idle' }))
  fx.files.set(`${HOSTS}/105.json`, 'caught mid-write')
  fx.files.set(`${HOSTS}/notes.txt`, 'not a record')
  fx.alive = ['101', '102', '103', '105']
  const answer = await agents.handler(fx.dollar, { command: 'orchestrator:agents', args: '' })
  expect(answer).toEqual({ text: [
    'Implementer agents (2), most urgent first — name · role · context · last measured:',
    '  Agent : belt-p3 · agent · 30% · now',
    '  Agent : alert lists · agent · busy · not measured yet',
  ].join('\n') })
  // The same agent alone, before its first measure: never « none running ».
  fx.files.delete(`${SESSIONS}/s-measured`)
  fx.alive = ['102']
  expect(await agents.handler(fx.dollar, { command: 'orchestrator:agents', args: '' })).toEqual({ text: [
    'Implementer agents (1), most urgent first — name · role · context · last measured:',
    '  Agent : alert lists · agent · busy · not measured yet',
  ].join('\n') })
})

test('status keeps the live rows beside a dead pid, and every row when ps fails', async () => {
  const { registrations } = mounted()
  const status = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:status')!
  const fx = fakeDollar()
  fx.files.set(`${SESSIONS}/live`, JSON.stringify({ ...row({ name: 'Agent : live' }), pid: '501' }) + '\n')
  fx.files.set(`${SESSIONS}/dead`, JSON.stringify({ ...row({ name: 'Agent : dead' }), pid: '99999' }) + '\n')
  fx.alive = ['501']
  expect(await status.handler(fx.dollar, { command: 'orchestrator:status', args: '' })).toEqual({ text: [
    'Live sessions (1), most urgent first — name · role · context · last measured:',
    '  Agent : live · agent · 30% · now',
  ].join('\n') })
  // A ps that fails knows of no death: both rows stay listed, neither hidden.
  fx.psFails = true
  expect(await status.handler(fx.dollar, { command: 'orchestrator:status', args: '' })).toEqual({ text: [
    'Live sessions (2), most urgent first — name · role · context · last measured:',
    '  Agent : live · agent · 30% · now',
    '  Agent : dead · agent · 30% · now',
  ].join('\n') })
})

test('agents still lists an agent in its first turn when ps fails', async () => {
  const { registrations } = mounted()
  const agents = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:agents')!
  const fx = fakeDollar()
  fx.files.set(`${HOME}/.claude/sessions/102.json`, JSON.stringify({ sessionId: 's-first-turn', name: 'Agent : first turn', status: 'busy' }))
  fx.alive = ['102']
  fx.psFails = true
  expect(await agents.handler(fx.dollar, { command: 'orchestrator:agents', args: '' })).toEqual({ text: [
    'Implementer agents (1), most urgent first — name · role · context · last measured:',
    '  Agent : first turn · agent · busy · not measured yet',
  ].join('\n') })
})

test('progress answers the records this session registered, under the side-read bound', async () => {
  const { registrations } = mounted()
  const progress = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:progress')!
  const fx = fakeDollar()
  fx.env.ORCHESTRATOR_SIDE_READ_MS = '50'
  const record = `${HOME}/belt/dispatch.jsonl`
  fx.files.set(record, [
    '{"id":1,"opened":"2026-10-07T10:00:00Z","class":"feature","tier":"deep","label":"Belt the parser","rounds":1,"state":"closed","verdict":"approved","cascade":false}',
    '{"id":2,"opened":"2026-10-08T10:00:00Z","class":"feature","tier":"light","label":"Add the retry knob","rounds":2,"state":"open","verdict":"","cascade":false}',
    '',
  ].join('\n'))
  fx.files.set(`${RECORDS}/s-one`, `${record}\n`)
  const answer = await progress.handler(fx.dollar, { command: 'orchestrator:progress', args: '' })
  expect(answer).toEqual({
    text: [
      'open=2 label=Add the retry knob',
      'dispatches=2 closed=1 rounds_avg=1.5',
    ].join('\n'),
  })
  // No registry file: no record this session touched, said as that and nothing else.
  const bare = fakeDollar()
  expect(await progress.handler(bare.dollar, { command: 'orchestrator:progress', args: '' })).toEqual({ text: 'no dispatch record registered' })
})

test('the registry is read under the state override, and under the config dir without it', async () => {
  // The registry's writer — the launcher's dispatch tool — resolves ORCHESTRATOR_STATE_DIR
  // before the config dir, the resolution the shell pipeline always had; the module's
  // reader resolves the same root or the override silences /orchestrator:progress forever
  // (the reviewed boundary this wiring closes). The module's own artifacts — the store,
  // the log — stay config-dir-bound: no surviving script shares them.
  const { registrations } = mounted()
  const progress = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:progress')!
  const record = `${HOME}/belt/dispatch.jsonl`
  const rows = [
    '{"id":1,"opened":"2026-10-07T10:00:00Z","class":"feature","tier":"deep","label":"Belt the parser","rounds":1,"state":"closed","verdict":"approved","cascade":false}',
    '{"id":2,"opened":"2026-10-08T10:00:00Z","class":"feature","tier":"light","label":"Add the retry knob","rounds":2,"state":"open","verdict":"","cascade":false}',
    '',
  ].join('\n')
  const expected = { text: ['open=2 label=Add the retry knob', 'dispatches=2 closed=1 rounds_avg=1.5'].join('\n') }
  // The override set: the registry is found under it...
  const over = fakeDollar()
  over.env.ORCHESTRATOR_STATE_DIR = `${HOME}/elsewhere`
  over.files.set(record, rows)
  over.files.set(`${HOME}/elsewhere/records/s-one`, `${record}\n`)
  expect(await progress.handler(over.dollar, { command: 'orchestrator:progress', args: '' })).toEqual(expected)
  // ...and a registry the config dir still holds answers nothing under it.
  const orphaned = fakeDollar()
  orphaned.env.ORCHESTRATOR_STATE_DIR = `${HOME}/elsewhere`
  orphaned.files.set(record, rows)
  orphaned.files.set(`${RECORDS}/s-one`, `${record}\n`)
  expect(await progress.handler(orphaned.dollar, { command: 'orchestrator:progress', args: '' })).toEqual({ text: 'no dispatch record registered' })
  // The override absent: the config dir's own registry answers, the branch every plain
  // install walks.
  const plain = fakeDollar()
  plain.files.set(record, rows)
  plain.files.set(`${RECORDS}/s-one`, `${record}\n`)
  expect(await progress.handler(plain.dollar, { command: 'orchestrator:progress', args: '' })).toEqual(expected)
})

test('a handler that cannot read falls back to the markdown command and is said', async () => {
  // The net every registration chains inline: a command whose reader fails is
  // skipped, its catch lets the markdown command run as it always did, and the
  // failure lands in the module's log — the person keeps a working command.
  // The failed noun here is the session's own id (the progress handler's first
  // read), with env still answering: a failed env would take the log's own
  // path with it, and the net's word is exactly what must survive that.
  const registrations: { event: string; matcher: object | undefined; handler: Function; net: Function }[] = []
  registerCommands((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const handler = args[args.length - 1] as Function
    const caught: { net: Function } = { net: () => undefined }
    registrations.push({
      event: args[0],
      matcher: args.length === 3 ? args[1] : undefined,
      handler,
      // The registration's .catch lands after the push, so the entry carries a
      // dispatcher and not the stub's value as the push found it.
      net: (...call: unknown[]) => (caught.net as (...x: unknown[]) => unknown)(...call),
    })
    return {
      catch: (net: Function) => {
        caught.net = net
      },
    }
  })
  const progress = registrations.find(r => r.matcher && (r.matcher as any).command === 'orchestrator:progress')!
  const fx = fakeDollar({ failSession: true })
  const e = { command: 'orchestrator:progress', args: '' }
  let answered: unknown = null
  await assertRejects(progress.handler(fx.dollar, e))
  // The real next is a function the engine decorates (called, error), so the
  // fake is built the same way: a callable with the fields, never a spread,
  // which would leave an object no chain can call.
  const through = (x: unknown) => { answered = { passed: x }; return answered }
  const next = Object.assign(through, { called: false, error: { kind: 'failure', message: 'session noun unavailable' } })
  const netAnswer = await progress.net(fx.dollar, e, next)
  expect(netAnswer).toEqual({ passed: e })
  expect(fx.written.some(l => l.includes('| commands |') && l.includes('session noun unavailable'))).toBe(true)
})

async function assertRejects(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    return
  }
  throw new Error('the handler was expected to reject')
}

// --- the engine entry ----------------------------------------------------------------------

// The engine entry, the kit's own way: the test's on carries the mocked world
// beneath the plugins (mock.env answers the handler's $.env.get; the kit has
// no fs noun, and the reader's own catch reads that as an absent store), so
// the run reaches the module's hook through the real chain — the matcher
// selects it, it answers { text } without calling next, and no bottom is
// needed: no model turn, no markdown body, the answer is the handler's own.
test('/orchestrator:status answers through the engine without a model turn', async ($, on) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: '/tmp/h' })
  const answer = await $.command.run({ command: 'orchestrator:status', args: '' })
  expect(answer).toEqual({ text: 'Live sessions: none measured yet.' })
})
