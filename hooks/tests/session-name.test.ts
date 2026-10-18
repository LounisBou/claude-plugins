// hooks/tests/session-name.test.ts
// The naming domain: the pure parsers and the walk's core from session-name.ts
// (the engine fences $ to the file whose handlers hold it, so the walk runs
// over reader thunks the $-holding files build — the tests build the same
// ones guards.ts builds, over their own fake $).
import { expect, test } from 'claude-code/testing'
import {
  roleOf, titleOf, lastCustomTitle, hostRecordOf, hostOn, hostBasenames, walkName, scanTail,
  blockArgv, bytesOfBase64, BLOCK, TAIL_CAP,
} from '../session-name.ts'
import { blockOf } from './fakes.ts'

test('the role is the prefix of the name', () => {
  expect(roleOf('Orch : payments')).toBe('orchestrator')
  expect(roleOf('Agent : belt-p3')).toBe('agent')
  expect(roleOf('Audit : 1712')).toBe('auditor')
  expect(roleOf('Coord : main')).toBe('coordinator')
  expect(roleOf('Orch: claude-orchestrator')).toBe('orchestrator')
  expect(roleOf('Agent: belt-p3')).toBe('agent')
  expect(roleOf('Orchestra : x')).toBeNull()
  expect(roleOf('a plain session')).toBeNull()
  expect(roleOf('')).toBeNull()
})

// The same three lines as tests/fixtures/transcript-renamed.jsonl, kept in step
// with it: the file serves the run that holds a real $, the string the run
// that holds none.
const FIXTURE_TEXT = [
  '{"type":"user","message":{"role":"user","content":"first turn"}}',
  '{"type":"custom-title","customTitle":"Agent : first-name"}',
  '{"type":"custom-title","customTitle":"Agent : renamed-later"}',
].join('\n') + '\n'

// The harness hands a test a $ of its own, reduced: the nouns it carries name
// the session's own surfaces, and neither fs nor process is among them. Where
// they are absent a fake serves the transcript through the same seam the
// module reads (stat for the size, dd for the window), the way the band test
// fakes its own $ whole. The fixture is plain ASCII, so chars count as bytes
// here.
function fakeDollar(text: string): any {
  const bytes = new TextEncoder().encode(text)
  return {
    fs: { stat: async () => ({ kind: 'file', size: bytes.length }) },
    process: {
      run: async (argv: readonly string[]) => ({ exitCode: 0, stdout: blockOf(argv, () => text) ?? '', stderr: '' }),
    },
  }
}

// The walk's core driven the way the $-holding files drive it: stat for the
// size, the block argv for the window, both plain thunks over the fake $.
const lastTitle = (dollar: any, path: string): Promise<string | null> =>
  lastCustomTitle(
    async (p: string) => (await dollar.fs.stat(p)).size,
    async (p: string, index: number) => {
      const { exitCode, stdout } = await dollar.process.run(blockArgv(p, index))
      if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${p}`)
      return bytesOfBase64(stdout)
    },
    path,
  )

// The brief spells the fixture from the repo root; the plugin test runner
// stands in hooks/. The spelling that stats is the one read, wherever the
// runner's working directory is.
async function spelled(dollar: any, path: string): Promise<string> {
  for (const s of [path, `../${path}`]) {
    try {
      await dollar.fs.stat(s)
      return s
    } catch { /* not spelled from here */ }
  }
  return path
}

test('the last custom-title entry wins, read from the end', async ($: any) => {
  const path = 'tests/fixtures/transcript-renamed.jsonl'
  const dollar = ($ && $.fs && $.process) ? $ : fakeDollar(FIXTURE_TEXT)
  expect(await lastTitle(dollar, await spelled(dollar, path))).toBe('Agent : renamed-later')
})

test('an entry cut by the block boundary is carried whole and still read', async () => {
  const BLOCK = 65536
  const entry = '{"type":"custom-title","customTitle":"Agent : straddles-the-cut"}'
  // One long line ends ten bytes short of the boundary, so the entry after it
  // crosses it: its head closes the last block's first line, its rest opens
  // the block before, and only the carried cut line joins the two halves.
  const text = 'a'.repeat(BLOCK - 10) + '\n' + entry + '\n'
  expect(await lastTitle(fakeDollar(text), 'a-transcript.jsonl')).toBe('Agent : straddles-the-cut')
})

test('a transcript no rename was written to names nothing', async () => {
  const text = '{"type":"user","message":{"role":"user","content":"a turn"}}\n'
  expect(await lastTitle(fakeDollar(text), 'a-transcript.jsonl')).toBeNull()
})

// unquoted()'s own rule (session_name.py:75-78): a rename the host stored with
// padding or surrounding quotes reads back trimmed, so its role prefix still
// matches; what trims to nothing names nothing. titleOf carries the rule; the
// walk returns it as the name.
test('a padded rename reads back trimmed, quotes stripped, empties to null', async () => {
  const entry = (title: string) => `{"type":"custom-title","customTitle":${JSON.stringify(title)}}`
  expect(titleOf(entry('  Agent : x  '))).toBe('Agent : x')
  expect(titleOf(entry('" Agent : quoted "'))).toBe('Agent : quoted')
  expect(titleOf(entry('  ""  '))).toBeNull()
  expect(titleOf('{"type":"user","message":{"role":"user","content":"no title"}}')).toBeNull()
  expect(await lastTitle(fakeDollar(entry('  Agent : x  ') + '\n'), 'a-transcript.jsonl')).toBe('Agent : x')
})

// title_in answers its FIRST match from the end unconditionally, and unquoted
// maps both a value the host did not store as a string and one that trims to
// nothing to None — terminal: the LAST rename decides even when it names
// nothing, and the walk must not resurrect the name before it. An operator who
// de-roles an agent by renaming it away would keep being addressed as an agent
// past the gate otherwise.
test('a last rename that names nothing unnames the session, the rename before it notwithstanding', async () => {
  const entry = (title: string) => `{"type":"custom-title","customTitle":${JSON.stringify(title)}}`
  const earlier = entry('Agent : earlier') + '\n'
  const walk = (text: string) => lastTitle(fakeDollar(text), 'a-transcript.jsonl')
  expect(await walk(earlier + entry('   ') + '\n')).toBeNull()
  expect(await walk(earlier + entry('  "  ') + '\n')).toBeNull()
  expect(await walk(earlier + '{"type":"custom-title","customTitle":42}\n')).toBeNull()
})

// --- the bytes, the tail, the quotes ---------------------------------------------------

test('a character the block boundary cuts in two is read whole', async () => {
  // « é » is two bytes; the line before the entry ends so the boundary falls between
  // them. Decoded block by block the name read « strat\uFFFD\uFFFDgie »; carried as
  // bytes, it reads as written.
  const entry = '{"type":"custom-title","customTitle":"Orch : stratégie"}'
  const head = '{"type":"custom-title","customTitle":"Orch : strat'
  const filler = 'a'.repeat(BLOCK - head.length - 2) + '\n'
  const text = filler + entry + '\n'
  expect(new TextEncoder().encode(filler + head).length).toBe(BLOCK - 1)
  expect(await lastTitle(fakeDollar(text), 'a-transcript.jsonl')).toBe('Orch : stratégie')
})

test('the walk reads the tail alone, and says when it stopped short', async () => {
  // A rename further back than the cap is not looked for: the walk stops, and says it
  // did not read the whole file — the caller then keeps the name it had.
  const entry = '{"type":"custom-title","customTitle":"Agent : far"}\n'
  const text = entry + ('x'.repeat(1000) + '\n').repeat(Math.ceil((TAIL_CAP + 2 * BLOCK) / 1001))
  const dollar = fakeDollar(text)
  let reads = 0
  const scan = await scanTail(
    async () => new TextEncoder().encode(text).length,
    async (p: string, index: number) => { reads++; return bytesOfBase64((await dollar.process.run(blockArgv(p, index))).stdout) },
    'a-transcript.jsonl',
    (line: string) => line.includes('custom-title'),
  )
  expect(scan).toEqual({ line: null, complete: false })
  expect(reads).toBe(TAIL_CAP / BLOCK)
})

test('a stored name loses its quotes, straight or curly', () => {
  const entry = (title: string) => `{"type":"custom-title","customTitle":${JSON.stringify(title)}}`
  expect(titleOf(entry("'Agent : x'"))).toBe('Agent : x')
  expect(titleOf(entry('“Orch : y”'))).toBe('Orch : y')
  expect(hostRecordOf(JSON.stringify({ sessionId: 's', name: "'Agent : x'", status: 'idle' })))
    .toEqual({ sessionId: 's', name: 'Agent : x', status: 'idle' })
  expect(hostRecordOf(JSON.stringify({ sessionId: 's', name: '"Orch : PTI"', status: 'busy' })))
    .toEqual({ sessionId: 's', name: 'Orch : PTI', status: 'busy' })
})

// --- the identity rule ---------------------------------------------------------------------

const TTY_ROWS = '  400 -zsh\n  501 /opt/homebrew/bin/hostcli --resume x\n  502 node /mcp/server.js\n'
const runRows = (rows: string) => async (argv: readonly string[]) => {
  if (argv[0] === 'sh') return { exitCode: 0, stdout: '123 ttys001\n' }
  if (argv[0] === 'ps' && argv[1] === '-t') return { exitCode: 0, stdout: rows }
  return { exitCode: 1, stdout: '' }
}

test('the host on a tty is the process with a host record, whatever it is called', async () => {
  const records: Record<string, string> = { '777': JSON.stringify({ sessionId: 's-1', name: 'Orch : belt', status: 'busy' }) }
  const host = await hostOn(runRows('  400 -zsh\n  777 /tmp/wrap/run-host --resume x\n'), async pid => records[pid] ?? null, async () => ['hostcli'], '/dev/ttys001')
  expect(host?.pid).toBe('777')
  expect(host?.record?.name).toBe('Orch : belt')
})

test('with no record, the host is the process whose argv[0] goes by one of its basenames', async () => {
  // An absolute HOST_CLI matched only its exact path: a session typed as a bare name,
  // or a wrapper exec'ing the binary, was no host. The basenames match both.
  expect(hostBasenames('/opt/homebrew/bin/hostcli', null)).toEqual(['hostcli'])
  expect(hostBasenames('/tmp/wrap/run-host', '/opt/homebrew/Cellar/hostcli/1/bin/hostcli')).toEqual(['run-host', 'hostcli'])
  const none = async () => null
  const bare = await hostOn(runRows('  400 -zsh\n  501 hostcli --resume x\n'), none, async () => hostBasenames('/opt/homebrew/bin/hostcli', null), '/dev/ttys001')
  expect(bare?.pid).toBe('501')
  const full = await hostOn(runRows(TTY_ROWS), none, async () => hostBasenames('/tmp/wrap/run-host', '/opt/homebrew/bin/hostcli'), '/dev/ttys001')
  expect(full?.pid).toBe('501')
  expect(await hostOn(runRows('  400 -zsh\n'), none, async () => ['hostcli'], '/dev/ttys001')).toBeNull()
})

test("a session's name is its record's, else its launch name, else none — a record outranks the transcript", async () => {
  const transcript = '{"type":"custom-title","customTitle":"Orch : from-transcript"}\n'
  const size = async () => transcript.length
  const block = async () => new TextEncoder().encode(transcript)
  const names = async () => ['hostcli']
  const walk = (rows: string, records: Record<string, string>) =>
    walkName(runRows(rows), size, block, 't.jsonl', async pid => records[pid] ?? null, names, 's-1')
  const recorded = { '501': JSON.stringify({ sessionId: 's-1', name: '“Orch : renamed”', status: 'idle' }) }
  expect(await walk(TTY_ROWS, recorded)).toEqual({ tty: '/dev/ttys001', name: 'Orch : renamed', pid: '501', known: true })
  const launched = '  501 hostcli --name Agent : belt\n'
  expect((await walk(launched, {})).name).toBe('Agent : belt')
  // A record with no name, and no launch name: none — the transcript is not asked.
  expect((await walk(TTY_ROWS, { '501': JSON.stringify({ sessionId: 's-1', status: 'idle' }) })).name).toBeNull()
  // No record at all (a host that keeps none): the transcript's last rename.
  expect((await walk(TTY_ROWS, {})).name).toBe('Orch : from-transcript')
})

// --- a session launched underneath another -------------------------------------------------

// An agent's tab and a headless run started from its shell, as the host lays them out: the
// agent's host process (501) on ttys005, recorded under the agent's id and launched with its
// --name; its shell (850) and the run (900) on no tty, the run recorded under its own id.
// The module's shell is a child of its session's host process, on no tty either.
const UNDERNEATH: Record<string, { ppid: string; tty: string; command: string }> = {
  '400': { ppid: '1', tty: 'ttys005', command: '-zsh' },
  '501': { ppid: '400', tty: 'ttys005', command: 'hostcli --name Agent : belt' },
  '850': { ppid: '501', tty: '??', command: '/bin/zsh -c hostcli -p reply' },
  '900': { ppid: '850', tty: '??', command: 'hostcli -p reply' },
}
const runUnder = (session: string) => async (argv: readonly string[]) => {
  if (argv[0] === 'sh') return { exitCode: 0, stdout: `${session} ??\n` }
  if (argv[0] === 'ps' && argv[1] === '-p') {
    const at = UNDERNEATH[argv[2]]
    return at ? { exitCode: 0, stdout: `${at.ppid} ${at.tty}\n` } : { exitCode: 1, stdout: '' }
  }
  if (argv[0] === 'ps' && argv[1] === '-t') {
    const rows = Object.entries(UNDERNEATH).filter(([, at]) => at.tty === argv[2])
    return { exitCode: 0, stdout: rows.map(([pid, at]) => `  ${pid} ${at.command}\n`).join('') }
  }
  return { exitCode: 1, stdout: '' }
}

test("a run launched from a session's shell speaks for no one; the session itself still does", async () => {
  const transcript = '{"type":"custom-title","customTitle":"Agent : from-transcript"}\n'
  const size = async () => transcript.length
  const block = async () => new TextEncoder().encode(transcript)
  const walk = (session: string, id: string, records: Record<string, string>) =>
    walkName(runUnder(session), size, block, 't.jsonl', async pid => records[pid] ?? null, async () => ['hostcli'], id)
  const records = (agent: object) => ({
    '501': JSON.stringify({ sessionId: 's-agent', kind: 'interactive', entrypoint: 'cli', status: 'busy', ...agent }),
    '900': JSON.stringify({ sessionId: 's-run', kind: 'interactive', entrypoint: 'sdk-cli', name: 'probe-cwd-17', status: 'busy' }),
  })
  const headless = { tty: null, name: null, pid: null, known: false }
  // The run climbs past its own process to the agent's tty: the record there carries
  // another id, so neither its name, nor the launch --name, nor a transcript names the run.
  expect(await walk('900', 's-run', records({ name: 'Agent : belt' }))).toEqual(headless)
  expect(await walk('900', 's-run', records({}))).toEqual(headless)
  // The agent, given the same process table, is named as before.
  expect(await walk('501', 's-agent', records({ name: 'Agent : belt' })))
    .toEqual({ tty: '/dev/ttys005', name: 'Agent : belt', pid: '501', known: true })
  expect((await walk('501', 's-agent', records({}))).name).toBe('Agent : belt')
})

test('the host on a tty, asked for a session id no record carries, is none', async () => {
  const records: Record<string, string> = { '501': JSON.stringify({ sessionId: 's-agent', name: 'Agent : belt', status: 'busy' }) }
  const read = async (pid: string) => records[pid] ?? null
  const names = async () => ['hostcli']
  expect(await hostOn(runUnder('900'), read, names, '/dev/ttys005', 's-run')).toBeNull()
  expect((await hostOn(runUnder('900'), read, names, '/dev/ttys005', 's-agent'))?.pid).toBe('501')
  // Asked for no session (another session's tty, read for its own sake): its recorded host.
  expect((await hostOn(runUnder('900'), read, names, '/dev/ttys005'))?.pid).toBe('501')
})

// --- what a record answers -----------------------------------------------------------------

test('a record with no session id still names its tty, the tty being foreign only when every record carries another id', async () => {
  const names = async () => ['hostcli']
  const record = (fields: object) => JSON.stringify({ status: 'idle', ...fields })
  const rows = '  400 -zsh\n  501 hostcli --resume x\n'
  const anon = { '501': record({ name: 'Orch : anon' }) }
  const read = (records: Record<string, string>) => async (pid: string) => records[pid] ?? null
  // The host writes its record without a session id: the record is the tty's only one, so it answers.
  expect((await hostOn(runRows(rows), read(anon), names, '/dev/ttys001', 's-1'))?.record?.name).toBe('Orch : anon')
  const walked = await walkName(runRows(rows), async () => 0, async () => new Uint8Array(0), 't.jsonl', read(anon), names, 's-1')
  expect(walked).toEqual({ tty: '/dev/ttys001', name: 'Orch : anon', pid: '501', known: true })
  // Beside a record that carries another id, the one with none still answers.
  const mixed = { '501': record({ sessionId: 's-other', name: 'Agent : other' }), '502': record({ name: 'Orch : anon' }) }
  expect((await hostOn(runRows('  501 hostcli\n  502 hostcli\n'), read(mixed), names, '/dev/ttys001', 's-1'))?.pid).toBe('502')
})

test("a tty with two records answers the one that carries the session's id", async () => {
  const names = async () => ['hostcli']
  const records: Record<string, string> = {
    '501': JSON.stringify({ sessionId: 's-other', name: 'Agent : other', status: 'busy' }),
    '502': JSON.stringify({ sessionId: 's-1', name: 'Orch : mine', status: 'busy' }),
  }
  const read = async (pid: string) => records[pid] ?? null
  const rows = '  501 hostcli\n  502 hostcli\n'
  expect((await hostOn(runRows(rows), read, names, '/dev/ttys001', 's-1'))?.pid).toBe('502')
  const walked = await walkName(runRows(rows), async () => 0, async () => new Uint8Array(0), 't.jsonl', read, names, 's-1')
  expect(walked).toEqual({ tty: '/dev/ttys001', name: 'Orch : mine', pid: '502', known: true })
})

test('a tty whose records all carry other ids is foreign: no host, no name', async () => {
  const names = async () => ['hostcli']
  const records: Record<string, string> = {
    '501': JSON.stringify({ sessionId: 's-a', name: 'Agent : a', status: 'busy' }),
    '502': JSON.stringify({ sessionId: 's-b', name: 'Agent : b', status: 'busy' }),
  }
  const read = async (pid: string) => records[pid] ?? null
  const rows = '  501 hostcli\n  502 hostcli\n'
  expect(await hostOn(runRows(rows), read, names, '/dev/ttys001', 's-1')).toBeNull()
  const walked = await walkName(runRows(rows), async () => 0, async () => new Uint8Array(0), 't.jsonl', read, names, 's-1')
  expect(walked).toEqual({ tty: null, name: null, pid: null, known: false })
})
