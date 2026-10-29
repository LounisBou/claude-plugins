// hooks/tests/stop-gate.test.ts
// The stop gate's boundaries: the decision shapes (the module's own `block` field for the
// classic decision, the summary-level wake decision, the deadline race), the ported checks
// (the wake walk, the once-per-tell CI read over ci-watch's precomputed logs), and the
// wiring over a faked $ — every field the classic.Stop event really carries pinned by a
// test that fails under the wrong spelling. The refusal texts are stop_gate.py's, verbatim
// where the data source did not change beneath them.
import { expect, test } from 'claude-code/testing'
import {
  refuse, wakeDecision, withDeadline, isDegradedPass,
  machineLine, readHeads, writeHeads, headsPath, listing, ownAgents, hostStatusOf, openRows,
  projectCheckouts, watchedNumbers, parseCiWatchLog, watchNumberOf, pullRequestOf,
  checkWake, checkWakeDone, checkCi, chainEntries, logTell, isSuccessorSpawn, processTable, ownWatches, ownBackground,
  noticeFrom, awaitingAny, NOTICE_TTL_MS, parseGoalsCheck, goalsPaths, presentGoals, goalsShownPath, GOALS_SHOW,
} from '../stop-gate.ts'
import { register as registerGuards } from '../guards.ts'
import { logLineOf, blockOf } from './fakes.ts'

// --- the decision shapes -----------------------------------------------------------------

test('a refusal is the documented shape', () => {
  // The shipped types map the classic decision `{"decision":"block","reason":…}` onto the
  // module's own field: `block` carries the reason text (ClassicResult — the doc on `block`
  // names the decision it answers). A `decision` field is a wrong shape on classic.Stop
  // and the hook is skipped, so the stop would never be held; the types are the authority.
  expect(refuse('an agent of yours is still busy')).toEqual({ block: 'an agent of yours is still busy' })
})

test('a summary with nothing holding the stop passes', () => {
  expect(wakeDecision({ busyOwnAgents: [], blockingQuestion: null, openRows: [] })).toEqual({ decision: 'pass' })
})

test('a busy own agent releases the stop — its idle notice will wake the orchestrator', () => {
  // Declared deviation from the brief's sketch, which expected 'block': stop_gate.py:363-364
  // returns the moment one of its own agents is busy, the shell wrapper's own header names
  // the busy agent first among the things that release the hold, and the design doc lists
  // it among the wake conditions. Inverting it here would refuse every stop an agent
  // survives — the opposite of the ported gate.
  expect(wakeDecision({ busyOwnAgents: ['Agent : belt-p3'], blockingQuestion: null, openRows: [] })).toEqual({ decision: 'pass' })
})

test('a blocking question declared on the last line releases the stop', () => {
  expect(wakeDecision({ busyOwnAgents: [], blockingQuestion: 'the operator', openRows: [] }).decision).toBe('pass')
})

test('an open dispatch row holds the stop and names the row', () => {
  const d = wakeDecision({ busyOwnAgents: [], blockingQuestion: null, openRows: ['r-12 (the report row)'] })
  expect(d.decision).toBe('block')
  expect((d as { reason: string }).reason).toBe('Not done: row r-12 (the report row) is open. Dispatch it, close it, or say what blocks it.')
})

test('a CI read that exceeds its time bound degrades to pass-and-log', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 250))
  const outcome = await withDeadline(slow, 10)
  expect(outcome.decision).toBe('pass')
})

test('the read that wins the race is answered as itself, and the degraded pass is told apart', async () => {
  const outcome = await withDeadline(Promise.resolve('the launcher said'), 10)
  expect(outcome).toBe('the launcher said')
  expect(isDegradedPass(outcome)).toBe(false)
  expect(isDegradedPass(await withDeadline(new Promise(() => undefined), 10))).toBe(true)
})

// --- the ported parsers ------------------------------------------------------------------

test('the machine line is read through whatever markup wraps it', () => {
  expect(machineLine('a report\n`waiting: operator — blocks: the report`.')).toBe('waiting: operator — blocks: the report')
  expect(machineLine('> waiting: done')).toBe('waiting: done')
  expect(machineLine('- *waiting: done*')).toBe('waiting: done')
  expect(machineLine('Waiting:  operator – blocks: x')).toBe('Waiting:  operator – blocks: x')
  expect(machineLine('waiting: operator-blocks: stand-by')).toBe('waiting: operator-blocks: stand-by')
})

test('the listing parses the launcher rows and drops the marks', () => {
  const rows = listing('w1/t1 | /dev/ttys001 | a title | Orch : belt | self\nw1/t2 | /dev/ttys002 | ⠋ Agent : belt | Agent : belt-p3 | hidden\nnot a row\n')
  expect(rows).toEqual([
    { tty: '/dev/ttys001', title: 'a title', name: 'Orch : belt' },
    { tty: '/dev/ttys002', title: '⠋ Agent : belt', name: 'Agent : belt-p3' },
  ])
})

test('a chain file with one corrupt line reads as empty', () => {
  // The launcher's chain_read empties the whole file on one bad line (its writes are
  // atomic, so a bad line means the file is not a chain), and the remains of a
  // non-atomic write must not anchor on a stranger's surviving entry.
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002","owner":"17"}\nnot json\n{"tab_id":"T2","tty":"/dev/ttys003","owner":"17"}\n')).toEqual([])
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002"}\n{"tty":"/dev/ttys003"}\n'))
    .toEqual([{ tab_id: 'T1', tty: '/dev/ttys002' }])
})

test('own agents are the owner entries that still run one, residents apart', () => {
  const rows = listing('w1/t2 | /dev/ttys002 | ⠋ Agent : belt | Agent : belt-p3\nw1/t3 | /dev/ttys003 | ✳ Agent : idle | Agent : idle-p3\nw1/t4 | /dev/ttys004 | ✳ Agent : resident | Agent : resident-p3\nw1/t5 | /dev/ttys005 | a plain shell | (host default)\n')
  const entries = [
    { tab_id: 'T1', tty: '/dev/ttys002', owner: '17' },
    { tab_id: 'T2', tty: '/dev/ttys003', owner: '17' },
    { tab_id: 'T3', tty: '/dev/ttys004', owner: '17', resident: true },
    { tab_id: 'T4', tty: '/dev/ttys005', owner: '17' },
    { tab_id: 'T5', tty: '/dev/ttys006', owner: 'someone-else' },
  ]
  const { agents, resident } = ownAgents(rows, entries, '17')
  expect(agents).toEqual([
    { label: 'Agent : belt-p3', state: 'busy', tty: '/dev/ttys002' },
    { label: 'Agent : idle-p3', state: 'idle', tty: '/dev/ttys003' },
  ])
  expect(resident).toBe(true)
  // With no owner known, no entry is counted: a recycled tty's occupant would be.
  expect(ownAgents(rows, entries, '').agents).toEqual([])
  // The host's own status outranks the glyph, which lags a turn's start: a tab still
  // reading ✳ whose session the host records busy is busy.
  const busy = ownAgents(rows, entries, '17', new Map([['/dev/ttys003', 'busy' as const]]))
  expect(busy.agents.find(a => a.tty === '/dev/ttys003')?.state).toBe('busy')
})

test("the host's session record is read for its status alone", () => {
  expect(hostStatusOf('{"pid":77,"status":"busy","statusUpdatedAt":1}')).toBe('busy')
  expect(hostStatusOf('{"pid":77,"status":"idle"}')).toBe('idle')
  expect(hostStatusOf('{"pid":77,"status":"compacting"}')).toBeNull()
  expect(hostStatusOf('{"pid":77}')).toBeNull()
  expect(hostStatusOf('torn')).toBeNull()
})

test('a pull request is read from the branch and the answer, or not at all', () => {
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN"}')).toEqual({ number: '160', state: 'OPEN' })
  expect(pullRequestOf(null, '{"number":160,"state":"OPEN"}')).toBeNull()
  expect(pullRequestOf('feat/belt', null)).toBeNull()
  expect(pullRequestOf('feat/belt', 'not json')).toBeNull()
})

test('open rows are the records still open, one per register path', () => {
  expect(openRows([
    '{"id":"r-12","label":"the report row","state":"open"}\n{"id":"r-13","state":"closed"}\n',
    'not json\n{"id":"r-14","state":"open"}\n',
  ])).toEqual(['r-12 (the report row)', 'r-14 (no label)'])
})

test('the checkouts of the project are the workspace rows under its name', () => {
  const out = '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n/tmp/h/work/other/x | feat/x | def | clean | pushed\n/tmp/h/work/repo | main | fed | clean | pushed\n'
  expect(projectCheckouts('/tmp/h/work/repo', out)).toEqual(['/tmp/h/work/repo/belt'])
})

test('the watched numbers are the live ci-watch processes alone', () => {
  const ps = [
    '  501 hostcli',
    '  /bin/bash /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh 160',
    '  sh -c grep ci-watch.sh 12',
    '  zsh -x /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh 161',
    '  /bin/bash /plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh --help',
  ].join('\n')
  expect(watchedNumbers(ps)).toEqual(new Set(['160', '161']))
})

test('a ci-watch log is read as the last bucket each check carries', () => {
  const text = 'build\tpending\t0\tu\r\nbuild\tpending\t9\tu\ntest\tfail\t30\tu\nnot a table line\n'
  expect(parseCiWatchLog(text)).toEqual({ build: 'pending', test: 'fail' })
  expect(parseCiWatchLog('')).toEqual({})
})

test('the pull request number is the log name, the base watches apart', () => {
  expect(watchNumberOf('here-pr160.log')).toBe('160')
  expect(watchNumberOf('owner_repo-pr12.log')).toBe('12')
  expect(watchNumberOf('here-pr160-base.log')).toBeNull()
  expect(watchNumberOf('notes.txt')).toBeNull()
})

// --- the heads record --------------------------------------------------------------------

test('a heads record reads and writes the same line', () => {
  const text = '160 1728000000000 pending build,test\n170 abc123 done\n'
  const heads = readHeads(text)
  expect(heads.get('160')).toEqual(['1728000000000', 'pending', new Set(['build', 'test'])])
  expect(heads.get('170')).toEqual(['abc123', 'done', new Set()])
  expect(writeHeads(heads)).toBe(text)
  // A two-field line, written by the previous shape, reads as done; a bad state is skipped.
  expect(readHeads('170 abc123\n').get('170')).toEqual(['abc123', 'done', new Set()])
  expect(readHeads('170 abc123 weird x\n').size).toBe(0)
  // A name carries whatever the forge allows, beyond latin-1: the record survives the
  // cycle as UTF-8 bytes (python's quote/unquote), a comma and a percent included.
  const wide = writeHeads(new Map([['160', ['t1', 'pending', new Set(['✓ lint', '🚀 deploy', 'a,b', '100%'])]]]))
  expect(readHeads(wide).get('160')![2]).toEqual(new Set(['✓ lint', '🚀 deploy', 'a,b', '100%']))
})

test('the heads path is per session and sanitised', () => {
  expect(headsPath('/tmp/h/state', 'a1b2c3')).toBe('/tmp/h/state/stop-gate/a1b2c3.mheads')
  expect(headsPath('/tmp/h/state', 'a/1 b')).toBe('/tmp/h/state/stop-gate/a_1_b.mheads')
})

// --- check 1 -----------------------------------------------------------------------------

const AGENT_BUSY = { label: 'Agent : belt-p3', state: 'busy' as const, tty: '/dev/ttys002' }
const AGENT_IDLE = { label: 'Agent : idle-p3', state: 'idle' as const, tty: '/dev/ttys003' }

test('an idle agent delivered of its pull request refuses before anything else', () => {
  const held = checkWake({
    agents: [AGENT_IDLE, AGENT_BUSY], resident: false,
    delivered: ['Agent : idle-p3 (pull request #160, OPEN)'], message: 'anything',
  })
  expect(held).toEqual({
    case: 'idle-delivered',
    reason: 'Idle with its pull request open or merged: Agent : idle-p3 (pull request #160, OPEN). Stand it down now — or, if it waits on a question you have not answered, answer it.',
  })
})

test('a busy agent passes, the blocks line passes, the done line asks for the facts', () => {
  expect(checkWake({ agents: [AGENT_BUSY], resident: false, delivered: [], message: 'done?' })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'x\n`waiting: operator — blocks: the report`.' }))
    .toEqual({ blocks: 'the report' })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done' })).toBe('read-what-is-left')
})

test('a wait its sender marked urgent passes the gate as the plain one does', () => {
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'x\nwaiting: operator (urgent) — blocks: the production fault' }))
    .toEqual({ blocks: 'the production fault' })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'Waiting: Operator (URGENT) - blocks: x' }))
    .toEqual({ blocks: 'x' })
})

test('the done line holds the stop on what is left and on open rows', () => {
  expect(checkWakeDone({ agents: [], checkouts: [], deferred: [] })).toBeNull()
  expect(checkWakeDone({
    agents: [AGENT_IDLE], checkouts: ['/tmp/h/work/repo/belt'], deferred: ['r-12 (the report row)'],
  })).toEqual({
    case: 'not-done',
    reason: 'Not done: /tmp/h/work/repo/belt, Agent : idle-p3 are still there. Finish them, or say what blocks them. '
      + 'Not done: row r-12 (the report row) is open. Dispatch it, close it, or say what blocks it.',
  })
})

test('the remaining cases refuse each with their own text', () => {
  expect(checkWake({ agents: [AGENT_IDLE], resident: false, delivered: [], message: 'I stopped.' })).toEqual({
    case: 'idle-agents', reason: 'Agent : idle-p3 is idle: its notice was spent. Read its report or relaunch it.',
  })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: operater blocks x' })).toEqual({
    case: 'malformed-machine-line',
    reason: 'Your last line is not the machine line: end the message with the line waiting: operator — blocks: <what it blocks>, or with waiting: done, as the message\'s last line, no markup. '
      + 'waiting: tool — <what is watched> fits only while a command or monitor you started runs in the background.',
  })
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: your call?' })).toEqual({
    case: 'question-without-blocks',
    reason: 'Your question blocks nothing declared: advance everything that can advance; its answer will come in a later turn.',
  })
  expect(checkWake({ agents: [], resident: true, delivered: [], message: 'stopped.' })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'stopped.' })).toEqual({
    case: 'nothing-will-wake',
    reason: 'Nothing will wake you: no agent of yours is running, and no command or monitor you started runs in the background. '
      + 'Launch what you announced — an agent, or a command whose end or events wake you, then end with the line waiting: tool — <what is watched> —, '
      + 'or, if a question for the operator truly blocks, end with the line waiting: operator — blocks: <what it blocks>, or with waiting: done. '
      + 'The line goes as the message\'s last line, no markup.',
  })
})

// --- check 2 -----------------------------------------------------------------------------

const CI_WATCH = '/plugins/orch-root/skills/orchestrator/scripts/ci-watch.sh'
const ciLog = (tell: string, checks: readonly { name: string; bucket: string }[]) => ({ number: '160', tell, checks })

test('a pending head is told once, again only for a failing set not yet told', () => {
  const run = (log: ReturnType<typeof ciLog>, reported: Map<string, unknown>, watched = new Set<string>(), ignored = new Set<string>()) =>
    checkCi({ logs: [log], reported: reported as any, watched, ignored, watchCommand: CI_WATCH })
  const pending = ciLog('t1', [{ name: 'build', bucket: 'pending' }])
  const first = run(pending, readHeads(''))
  expect(first.lines.length).toBe(1)
  expect(first.lines[0]).toContain('#160')
  expect(first.lines[0]).toContain('1 checks pending (build)')
  expect(first.lines[0]).toContain(CI_WATCH + ' 160')
  // The next stop knows it was told: the same state says nothing.
  const told = run(pending, first.heads)
  expect(told.lines).toEqual([])
  // A failing set it has not been told refuses again and is recorded.
  const failing = ciLog('t1', [{ name: 'build', bucket: 'fail' }, { name: 'test', bucket: 'fail' }])
  const again = run(failing, told.heads)
  expect(again.lines.length).toBe(1)
  expect(again.lines[0]).toContain('2 failing (build, test)')
  // A moved tell starts over.
  const moved = run(ciLog('t2', [{ name: 'build', bucket: 'pending' }]), again.heads)
  expect(moved.lines.length).toBe(1)
})

test('a watched pull request is waited for, and nothing is recorded for it', () => {
  const outcome = checkCi({
    logs: [ciLog('t1', [{ name: 'build', bucket: 'pending' }])], reported: readHeads(''),
    watched: new Set(['160']), ignored: new Set(), watchCommand: CI_WATCH,
  })
  expect(outcome.lines).toEqual([])
  expect(outcome.heads.size).toBe(0)
})

test('a head with no checks read is unread, and ignored checks filter nothing else out', () => {
  const unread = checkCi({ logs: [ciLog('t1', [])], reported: readHeads(''), watched: new Set(), ignored: new Set(), watchCommand: CI_WATCH })
  expect(unread.lines).toEqual([])
  expect(unread.heads.size).toBe(0)
  const ignored = checkCi({
    logs: [ciLog('t1', [{ name: 'build', bucket: 'fail' }])], reported: readHeads(''),
    watched: new Set(), ignored: new Set(['build']), watchCommand: CI_WATCH,
  })
  expect(ignored.lines).toEqual([])
})

// --- the wiring --------------------------------------------------------------------------

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const CHAIN = `${STATE}/chains/ttys001.jsonl`
const REGISTER = `${STATE}/records/a1b2c3`
const RECORD = '/tmp/h/rec/round.jsonl'
const HEADS = `${STATE}/stop-gate/a1b2c3.mheads`
const STAMP = `${STATE}/sweep.stamp`
const CIDIR = `${STATE}/ci-watch`
const PROJECTS = `${HOME}/.claude/projects`
const TRANSCRIPT = `${HOME}/elsewhere/s-stop.jsonl`
const LAUNCHER = '/plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh'
const WORKSPACE = '/plugins/orch-root/skills/orchestrator/scripts/workspace.sh'
const GOALS_PY = '/plugins/orch-root/skills/orchestrator/scripts/goals.py'
const GOALS_FILE = '/tmp/h/rec/goals.md'

const BUSY_ROW = 'w1/t2 | /dev/ttys002 | ⠋ Agent : belt | Agent : belt-p3'
const IDLE_ROW = 'w1/t3 | /dev/ttys003 | ✳ Agent : idle | Agent : idle-p3'
const OWNED = '{"tab_id":"T1","tty":"/dev/ttys002","owner":"17"}\n'

// The paths that hang off the state root: the shell gate kept them under one root and the
// override moves them as one. The module's own log is not among them — it stays in the
// config dir, which is exactly what the override test below pins.
function statePaths(root: string) {
  return {
    root,
    chain: `${root}/chains/ttys001.jsonl`,
    register: `${root}/records/a1b2c3`,
    heads: `${root}/stop-gate/a1b2c3.mheads`,
    stamp: `${root}/sweep.stamp`,
    ci: `${root}/ci-watch`,
    ignored: `${root}/ignored-checks`,
  }
}

type Setup = {
  transcript?: string
  noLaunchName?: boolean
  launchName?: string
  chain?: string
  listing?: string
  records?: string[]
  heads?: string
  ciLogs?: Record<string, { mtimeMs: number; text: string }>
  ps?: string
  agentCwd?: string
  agentBranch?: string
  prAnswer?: string
  workspace?: string
  top?: string
  env?: Record<string, string>
  hangListing?: boolean
  failCiList?: boolean
  stampMtimeMs?: number
  sweep?: { exitCode: number; stdout: string; stderr: string }
  hangSweep?: boolean
  sweepStartFail?: boolean
  origin?: string
  ignoredText?: string
  failIgnoredRead?: boolean
  failLogRead?: boolean
  hangHeadsWrite?: boolean
  hostRecord?: string
  agentRow?: string
  selfBin?: string
  goals?: { exitCode: number; stdout: string } | 'hang'
  goalsShown?: string
}

function fakeDollar(setup: Setup): { dollar: any; written: string[]; ran: string[]; wrote: Record<string, string>; stamp: { atRun?: string }; inits: Record<string, any> } {
  const inits: Record<string, any> = {}
  const written: string[] = []
  const ran: string[] = []
  const wrote: Record<string, string> = {}
  const stamp: { atRun?: string } = {}
  const env = {
    HOME, ITERM_SESSION_ID: 'w0t0:2:17',
    ORCHESTRATOR_HOST_CLI: 'hostcli', ...(setup.env ?? {}),
  }
  // The fake serves whatever root the module resolves: the default config-dir root, or the
  // override's when the setup sets one.
  const S = statePaths(env.ORCHESTRATOR_STATE_DIR ?? STATE)
  const dollar = {
    // The launcher's scripts are found under the engine's $.plugin.root: the
    // environment above deliberately carries no CLAUDE_PLUGIN_ROOT, as live.
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    session: { id: async () => 'a1b2c3' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => {
        if (p === S.chain) return setup.chain ?? ''
        if (p === S.register) return setup.records ? `${RECORD}\n` : ''
        if (p === RECORD) return (setup.records ?? [])[0] ?? ''
        if (p === S.heads) return setup.heads ?? ''
        if (p === S.ignored) {
          if (setup.failIgnoredRead) throw new Error('EACCES: permission denied')
          if (setup.ignoredText !== undefined) return setup.ignoredText
          // Absent: the same answer a missing file gives.
          throw new Error(`ENOENT: ${p}`)
        }
        if (p === `${HOME}/.claude/sessions/77.json` && setup.hostRecord !== undefined) return setup.hostRecord
        if (p === `${S.root}/stop-gate/a1b2c3.goals` && setup.goalsShown !== undefined) return setup.goalsShown
        if (p.startsWith(`${S.ci}/`)) {
          // The owner file is read before its log: the log's own read is the one that fails.
          if (setup.failLogRead && !p.endsWith('.session')) throw new Error('EIO: the log cannot be read')
          return setup.ciLogs?.[p.slice(S.ci.length + 1)]?.text ?? ''
        }
        throw new Error(`unread: ${p}`)
      },
      write: async (p: string, text: string) => {
        if (p === S.heads && setup.hangHeadsWrite) return new Promise(() => undefined)
        wrote[p] = text
      },
      stat: async (p: string) => {
        if (p === TRANSCRIPT && setup.transcript !== undefined) {
          return { kind: 'file', size: setup.transcript.length, mtimeMs: 0, isLink: false }
        }
        if (p === S.stamp && setup.stampMtimeMs !== undefined) {
          return { kind: 'file', size: 12, mtimeMs: setup.stampMtimeMs, isLink: false }
        }
        throw new Error('ENOENT')
      },
      list: async (p: string) => {
        if (p === S.ci) {
          if (setup.failCiList) throw new Error('the ci-watch directory cannot be read')
          return Object.entries(setup.ciLogs ?? {}).map(([name, log]) => (
            { name, kind: 'file', size: log.text.length, mtimeMs: log.mtimeMs, isLink: false }
          ))
        }
        if (p === PROJECTS) return []
        return []
      },
      exists: async (p: string) => p === GOALS_FILE && setup.goals !== undefined,
    },
    process: {
      run: async (argv: readonly string[], init?: object) => {
        inits[argv.join(' ')] = init
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, (p: string) => setup.transcript ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        if (argv[0] === 'sh') {
          return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys001') {
          // The session's own process, as the listing prints it.
          const bin = setup.selfBin ?? 'hostcli'
          return { exitCode: 0, stdout: setup.noLaunchName ? `  501 ${bin}\n` : `  501 ${bin} --name ${setup.launchName ?? 'Orch : belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys003') {
          // The idle agent's host process: its pid, then its working directory.
          return { exitCode: 0, stdout: setup.agentRow ?? '   77 hostcli\n', stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: setup.ps ?? '1 ??\n', stderr: '' }
        if (argv[0] === 'lsof') {
          return { exitCode: 0, stdout: `p77\nn${setup.agentCwd ?? '/tmp/h/work/belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'git' && argv[3] === 'remote') {
          return setup.origin ? { exitCode: 0, stdout: `${setup.origin}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'no origin' }
        }
        if (argv[0] === 'git' && argv[3] === 'symbolic-ref') {
          return setup.agentBranch ? { exitCode: 0, stdout: setup.agentBranch, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
        }
        if (argv[0] === 'git' && argv[3] === 'rev-parse') {
          return argv[2] === '/tmp/h/work/repo' && setup.top
            ? { exitCode: 0, stdout: `${setup.top}\n`, stderr: '' }
            : { exitCode: 128, stdout: '', stderr: '' }
        }
        if (argv[0] === 'gh') {
          return setup.prAnswer ? { exitCode: 0, stdout: setup.prAnswer, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no answer' }
        }
        if (argv[0] === 'bash' && argv[1] === LAUNCHER) {
          if (setup.hangListing) return new Promise(() => undefined)
          return { exitCode: 0, stdout: setup.listing ?? '', stderr: '' }
        }
        if (argv[0] === 'bash' && argv[1] === WORKSPACE && argv[2] === 'sweep') {
          // The stamp as it stood when the sweep began: it must already be written.
          stamp.atRun = wrote[S.stamp]
          if (setup.sweepStartFail) return Promise.reject(new Error('spawn bash ENOENT'))
          if (setup.hangSweep) return new Promise(() => undefined)
          return { exitCode: setup.sweep?.exitCode ?? 0, stdout: setup.sweep?.stdout ?? '', stderr: setup.sweep?.stderr ?? '' }
        }
        if (argv[0] === 'bash' && argv[1] === WORKSPACE) return { exitCode: 0, stdout: setup.workspace ?? '', stderr: '' }
        if (argv[0] === 'python3' && argv[1] === GOALS_PY) {
          if (setup.goals === 'hang') return new Promise(() => undefined)
          return { exitCode: setup.goals?.exitCode ?? 2, stdout: setup.goals?.stdout ?? '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, written, ran, wrote, stamp, inits }
}

function mounted(): { handlers: Record<string, Function>; matchers: Record<string, object | undefined> } {
  const handlers: Record<string, Function> = {}
  const matchers: Record<string, object | undefined> = {}
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    // The two tool calls the guards watch are told apart by their tool: Bash keeps the
    // event's own key, SendMessage gets its own.
    const key = args.length === 3 && (args[1] as any).tool === 'SendMessage' ? 'tool.call:SendMessage' : args[0]
    handlers[key] = args[args.length - 1] as Function
    matchers[key] = args.length === 3 ? args[1] : undefined
    // The engine's on returns a registration taking one .catch; the fake accepts it and
    // drops it — the body's own catch is what the wiring tests.
    return { catch: () => undefined }
  })
  return { handlers, matchers }
}

const stopEvent = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'Stop',
  session_id: 'a1b2c3',
  transcript_path: TRANSCRIPT,
  cwd: '/tmp/h/work/repo',
  stop_hook_active: false,
  last_assistant_message: 'stopped.',
  ...over,
})

async function stop(handler: Function, dollar: any, e: object) {
  let passed: unknown = null
  const answer = await handler(dollar, e, (x: unknown) => { passed = x; return x })
  return { answer, passed }
}

test('the stop gate mounts on classic.Stop with no matcher', () => {
  const { handlers, matchers } = mounted()
  expect(typeof handlers['classic.Stop']).toBe('function')
  expect(matchers['classic.Stop']).toBeUndefined()
})

test('a stop already refused this turn is left alone, nothing read', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({})
  const e = stopEvent({ stop_hook_active: true })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(passed).toBe(e)
  expect(answer).toBe(e)
  expect(ran.length).toBe(0)
})

test('a session that is no orchestrator stops untouched, the launcher never asked', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ launchName: 'Agent : belt' })
  const e = stopEvent({})
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(ran.filter(l => l.includes('iterm-agent.sh')).length).toBe(0)
})

test('a busy own agent releases the stop, no pull request read for it', async () => {
  const { handlers } = mounted()
  const { dollar, ran } = fakeDollar({ listing: BUSY_ROW, chain: OWNED })
  const e = stopEvent({})
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(passed).toBe(e)
  expect(answer).toBe(e)
  expect(ran.filter(l => l.startsWith('gh')).length).toBe(0)
})

test('a stop with nothing to wake the orchestrator is refused with the machine line named', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})
  const refused = await stop(handlers['classic.Stop'], dollar, stopEvent({}))
  expect((refused.answer as any).block).toContain('Nothing will wake you')
  // The same session declaring its block on the last line passes instead — the message
  // is read where the event carries it.
  const declared = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'a report\nwaiting: operator — blocks: the report' }))
  expect(declared.answer).toBe(declared.passed)
})

test('an idle agent delivered of its open pull request is stood down', async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({
    listing: IDLE_ROW,
    chain: '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n',
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
  })
  const { answer } = await stop(handlers['classic.Stop'], dollar, stopEvent({}))
  expect((answer as any).block).toContain('Stand it down now')
  expect((answer as any).block).toContain('pull request #160')
})

test('the transcript is read from the event, not by hunting the projects directory', async () => {
  // The rename lives outside the projects directory: only the event's transcript_path
  // reaches it, the fallback the prompt gate needs would not.
  const renamed = ['{"type":"assistant","message":{"role":"assistant","content":"an answer"}}', '{"type":"custom-title","customTitle":"Orch : round 3"}'].join('\n') + '\n'
  const { handlers } = mounted()
  const named = fakeDollar({ transcript: renamed, noLaunchName: true })
  const refused = await stop(handlers['classic.Stop'], named.dollar, stopEvent({}))
  expect((refused.answer as any).block).toContain('Nothing will wake you')
  const unnamed = fakeDollar({ noLaunchName: true })
  const quiet = await stop(handlers['classic.Stop'], unnamed.dollar, stopEvent({ transcript_path: '' }))
  expect(quiet.answer).toBe(quiet.passed)
  expect(unnamed.written.length).toBe(1)
})

test('the open rows are the session register\'s, read under the event\'s session id', async () => {
  const { handlers } = mounted()
  const open = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  const held = await stop(handlers['classic.Stop'], open.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect((held.answer as any).block).toContain('row r-12 (the report row) is open')
  const none = fakeDollar({})
  const passed = await stop(handlers['classic.Stop'], none.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(passed.answer).toBe(passed.passed)
})

test('a checkout left of the project holds a done stop, read from the event\'s cwd', async () => {
  const { handlers } = mounted()
  const left = fakeDollar({
    top: '/tmp/h/work/repo',
    workspace: '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n',
  })
  const held = await stop(handlers['classic.Stop'], left.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect((held.answer as any).block).toContain('/tmp/h/work/repo/belt is still there')
  const gone = fakeDollar({ cwd: '', top: '', workspace: '/tmp/h/work/repo/belt | feat/belt | abc1234 | clean | pushed\n' })
  const passed = await stop(handlers['classic.Stop'], gone.dollar, stopEvent({ last_assistant_message: 'waiting: done', cwd: '' }))
  expect(passed.answer).toBe(passed.passed)
})

test('a pending ci-watch log holds the stop once and records the telling', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: 'waiting: operator — blocks: the report' }
  const first = fakeDollar({ ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\ntest\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } } })
  const held = await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))
  expect((held.answer as any).block).toContain('#160')
  expect((held.answer as any).block).toContain('run_in_background')
  expect(first.wrote[HEADS]).toBe(`160 ${logTell('build\tpending\t9\tu\n')} pending test\n`)
  // Check 2 pays no network at the stop: no gh call on its path either.
  expect(first.ran.filter(l => l.startsWith('gh')).length).toBe(0)
  // Told once: the next stop passes and leaves the record as it is.
  const second = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\ntest\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
    heads: first.wrote[HEADS],
  })
  const passed = await stop(handlers['classic.Stop'], second.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
})

test('a pull request waited on in the background is not told', async () => {
  const { handlers } = mounted()
  const { dollar, wrote } = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
    ps: `  900   1 /bin/bash ${CI_WATCH} 160\n`,
  })
  const outcome = await stop(handlers['classic.Stop'], dollar, stopEvent({ last_assistant_message: 'waiting: operator — blocks: the report' }))
  expect(outcome.answer).toBe(outcome.passed)
  // Nothing recorded for a watched pull request, so a watch that dies is still told once.
  expect(wrote[HEADS]).toBe('')
})

test('a pending watch another session armed is neither told nor recorded', async () => {
  const { handlers } = mounted()
  const { dollar, written, wrote } = fakeDollar({
    ciLogs: {
      'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'zz9999\n' },
    },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('#160'))).toBe(false)
  expect(wrote[HEADS]).toBe('')
})

test('a pending watch with no owner file is neither told nor recorded', async () => {
  const { handlers } = mounted()
  const { dollar, written, wrote } = fakeDollar({
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('#160'))).toBe(false)
  expect(wrote[HEADS]).toBe('')
})

test('a read that cannot answer in time lets the stop pass and says so', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ hangListing: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.05' } })
  const e = stopEvent({})
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.length).toBe(1)
  expect(written[0]).toContain('| guards |')
  expect(written[0]).toContain('unread')
})

test('a directory that cannot be read lets the stop pass and says so', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ failCiList: true })
  const e = stopEvent({ last_assistant_message: 'waiting: operator — blocks: the report' })
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  // The blocks line the gate logs beside the unread one it stands down on.
  expect(written.length).toBe(2)
  expect(written[1]).toContain('| guards |')
  expect(written[1]).toContain('unread')
})

// --- the sweep -----------------------------------------------------------------------------

// A passing, scoped stop: the blocks line releases check 1 and no ci-watch log exists,
// so the stop reaches the sweep at its final exit.
const PASSING = { last_assistant_message: 'a report\nwaiting: operator — blocks: the report' }
// Fifteen minutes old: past the default interval, inside a longer override.
const OLD_STAMP = Date.now() - 15 * 60 * 1000
const sweepLine = (ran: readonly string[]) => ran.find(l => l.includes(' sweep --deadline'))

test('a sweep that ran within the interval is not run again', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote, written } = fakeDollar({ stampMtimeMs: Date.now() })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
  expect(written.filter(l => l.includes('sweep')).length).toBe(0)
})

test('a due sweep runs once, writes the shared stamp first, and logs its deletions', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    stampMtimeMs: OLD_STAMP,
    sweep: { exitCode: 0, stdout: 'deleted /tmp/h/work/repo/belt\nkept /tmp/h/work/repo/pin: dirty\n', stderr: '' },
  })
  const { answer, passed } = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  // The shell gate's own stamp file, shared: epoch seconds and a newline, before the run.
  expect(Object.keys(fx.wrote)).toContain(STAMP)
  expect(fx.wrote[STAMP]).toMatch(/^\d{10}\n$/)
  expect(fx.stamp.atRun).toBe(fx.wrote[STAMP])
  expect(sweepLine(fx.ran)).toContain(`bash ${WORKSPACE} sweep --deadline`)
  expect(fx.written.some(l => l.includes('sweep deleted /tmp/h/work/repo/belt'))).toBe(true)
  expect(fx.written.some(l => l.includes('kept'))).toBe(false)
})

test('a sweep that overruns lets the stop answer on time, said once, the stamp already written', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    stampMtimeMs: OLD_STAMP, hangSweep: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '5' },
  })
  const e = stopEvent(PASSING)
  const started = Date.now()
  const { answer } = await stop(handlers['classic.Stop'], fx.dollar, e)
  expect(answer).toBe(e)
  expect(Date.now() - started).toBeLessThan(10000)
  expect(fx.written.filter(l => l.includes('did not finish within')).length).toBe(1)
  // The stamp was written before a run that never answers: the next stop will not retry it.
  expect(fx.stamp.atRun).toMatch(/^\d{10}\n$/)
})

test('no time left in the deadline skips the sweep silently', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote, written } = fakeDollar({
    stampMtimeMs: OLD_STAMP, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '2' },
  })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
  expect(written.filter(l => l.includes('sweep')).length).toBe(0)
})

test('the interval is read from the environment, a longer one holding the sweep back', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, env: { ORCHESTRATOR_SWEEP_INTERVAL: '1200' } })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
})

test('a refused stop runs no sweep', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP })
  const refused = await stop(handlers['classic.Stop'], dollar, stopEvent({}))
  expect((refused.answer as any).block).toContain('Nothing will wake you')
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
})

test('a session outside the orchestration runs no sweep', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, launchName: 'Agent : belt' })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeUndefined()
  expect(wrote[STAMP]).toBeUndefined()
})

test('a stop the gate could not read through still sweeps — the shell gate\'s own finally', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, failCiList: true })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(sweepLine(ran)).toBeDefined()
  expect(wrote[STAMP]).toMatch(/^\d{10}\n$/)
})

test('a sweep that fails is said with its first stderr line', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    stampMtimeMs: OLD_STAMP,
    sweep: { exitCode: 3, stdout: '', stderr: 'kept /tmp/h/work/repo/pin: no pull request\nand more\n' },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('sweep error exit 3: kept /tmp/h/work/repo/pin: no pull request'))).toBe(true)
  expect(written.some(l => l.includes('and more'))).toBe(false)
})

// --- fix round 2: the scope of the telling, the record's codec, the dropped lines ------

test('a failing check named beyond latin-1 is told once for its tell', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: 'waiting: operator — blocks: the report' }
  // One pending check beside the failing one: the record keeps the pending state and
  // the failing SET, and the next stop compares that set — where the codec shows.
  const log = 'build\tpending\t9\tu\n🚀 deploy\tfail\t30\tu\n'
  const first = fakeDollar({ ciLogs: { 'here-pr161.log': { mtimeMs: 1728000000000, text: log }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } } })
  const held = await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))
  expect((held.answer as any).block).toContain('🚀 deploy')
  // The record carries the name as its UTF-8 bytes; the next stop at the same tell
  // decodes the same set back and does not refuse again — the once-per-tell law.
  const second = fakeDollar({
    ciLogs: { 'here-pr161.log': { mtimeMs: 1728000000000, text: log }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } }, heads: first.wrote[HEADS],
  })
  const passed = await stop(handlers['classic.Stop'], second.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
})

test("another session's watch never refuses this stop", async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ciLogs: {
      'other_repo-pr99.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'other_repo-pr99.log.session': { mtimeMs: 1728000000000, text: 'zz9999\n' },
    },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.filter(l => l.includes('#99')).length).toBe(0)
})

test("this session's watches are told whatever repository they name", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ciLogs: {
      'far_repo-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' },
      'far_repo-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' },
      'here-pr161.log': { mtimeMs: 1728000000000, text: 'test\tfail\t30\tu\n' }, 'here-pr161.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' },
    },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect((held.answer as any).block).toContain('#160')
  expect((held.answer as any).block).toContain('#161')
})

test('a stop without ITERM_SESSION_ID is told that no chain entry is counted', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ env: { ITERM_SESSION_ID: '' } })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('ITERM_SESSION_ID is not set: no chain entry is counted'))).toBe(true)
})

test('ignored-checks says its malformed lines and still filters the well-formed ones', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    origin: 'git@github.com:me/belt.git',
    ignoredText: 'me/belt build\nno-slash-name\n',
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('ignored-checks malformed line: no-slash-name'))).toBe(true)
})

test('a repository that cannot be read filters nothing and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    ignoredText: 'me/belt build\n',
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect((held.answer as any).block).toContain('1 failing (build)')
  expect(written.some(l => l.includes('ignored-checks repository unread'))).toBe(true)
})

test('an ignored-checks file that cannot be read is said, and filters nothing', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    failIgnoredRead: true,
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tfail\t30\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], dollar, stopEvent(PASSING))
  expect((held.answer as any).block).toContain('1 failing (build)')
  expect(written.some(l => l.includes('ignored-checks unreadable'))).toBe(true)
})

test('a sweep that cannot start is said with its own failure', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ stampMtimeMs: OLD_STAMP, sweepStartFail: true })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('sweep error spawn bash ENOENT'))).toBe(true)
  expect(written.some(l => l.includes('did not finish within'))).toBe(false)
})

test('a heads record that cannot be written lets the stop pass and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    hangHeadsWrite: true, env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.05' },
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('the reported heads unread: the write did not answer in time'))).toBe(true)
})

test('a ci-watch log that cannot be read lets the stop pass and is said', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({
    failLogRead: true,
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('the ci-watch log here-pr160.log unread: EIO: the log cannot be read'))).toBe(true)
})

test('a stop with no session id passes, said once', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({})
  const e = stopEvent({ ...PASSING, session_id: '' })
  const { answer, passed } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(passed)
  expect(written.filter(l => l.includes('no session id: the reported heads cannot be kept')).length).toBe(1)
})

// --- the state root's override ----------------------------------------------------------------

test('the state root follows ORCHESTRATOR_STATE_DIR, the module\'s own log staying in the config dir', async () => {
  // The writers that survive the shell gate — the launcher's dispatch tool, ci-watch —
  // honor the override before the config dir, the resolution the shell gate always had;
  // the module resolves the same root or check 2 reads no watch and the open rows vanish
  // (the reviewed boundary this wiring closes). Everything the root carries moves as one:
  // the registry, the ci-watch logs, the heads record, the sweep stamp. The module's own
  // log is config-dir-bound and moves with nothing. Without the override every test above
  // pins the config-dir root; this one pins the branch the override selects.
  const { handlers } = mounted()
  const OVER = '/tmp/h/over'
  const message = { last_assistant_message: 'waiting: operator — blocks: the report' }
  const watched = fakeDollar({
    env: { ORCHESTRATOR_STATE_DIR: OVER },
    ciLogs: { 'here-pr160.log': { mtimeMs: 1728000000000, text: 'build\tpending\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1728000000000, text: 'a1b2c3\n' } },
  })
  const held = await stop(handlers['classic.Stop'], watched.dollar, stopEvent(message))
  expect((held.answer as any).block).toContain('#160')
  expect(watched.wrote[`${OVER}/stop-gate/a1b2c3.mheads`]).toBe(`160 ${logTell('build\tpending\t9\tu\n')} pending\n`)
  expect(Object.keys(watched.wrote).every(p => p.startsWith(OVER))).toBe(true)
  // The refusal's own two lines land in the module's log — the blocks line, the
  // ci-not-finished one — which the config dir still holds.
  expect(watched.written.length).toBe(2)
  expect(watched.written.every(l => l.includes('| guards |'))).toBe(true)
  expect(watched.written.some(l => l.includes('check1 blocks the report'))).toBe(true)
  expect(watched.written.some(l => l.includes('ci-not-finished'))).toBe(true)
  // The open rows move with the root too: a registry under the override holds the stop.
  const deferred = fakeDollar({
    env: { ORCHESTRATOR_STATE_DIR: OVER },
    records: ['{"id":"r-12","label":"the report row","state":"open"}\n'],
  })
  const rows = await stop(handlers['classic.Stop'], deferred.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect((rows.answer as any).block).toContain('row r-12 (the report row) is open')
  // A due sweep's stamp is the shell gate's own file, written under the same root.
  const swept = fakeDollar({ env: { ORCHESTRATOR_STATE_DIR: OVER }, stampMtimeMs: OLD_STAMP })
  const passed = await stop(handlers['classic.Stop'], swept.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(swept.wrote[`${OVER}/sweep.stamp`]).toMatch(/^\d{10}\n$/)
  expect(swept.wrote[`${OVER}/stop-gate/a1b2c3.mheads`]).toBe('')
})

test("an agent whose tab still reads idle but whose session the host records busy releases the stop", async () => {
  // Live finding: a freshly spawned agent's tab reads ✳ through its first half-minute of
  // work, and the gate refused its orchestrator's stop on it. The host's own record of
  // the session (<config dir>/sessions/<pid>.json) says busy for the whole turn.
  const { handlers } = mounted()
  const chain = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n'
  const busy = fakeDollar({ listing: IDLE_ROW, chain, hostRecord: '{"pid":77,"status":"busy"}' })
  const released = await stop(handlers['classic.Stop'], busy.dollar, stopEvent({}))
  expect(released.answer).toBe(released.passed)
  // Recorded idle, or with no record at all, the glyph's idle stands and the stop is held.
  const idle = fakeDollar({ listing: IDLE_ROW, chain, hostRecord: '{"pid":77,"status":"idle"}' })
  expect(((await stop(handlers['classic.Stop'], idle.dollar, stopEvent({}))).answer as any).block).toContain('is idle')
  const none = fakeDollar({ listing: IDLE_ROW, chain })
  expect(((await stop(handlers['classic.Stop'], none.dollar, stopEvent({}))).answer as any).block).toContain('is idle')
})

// --- fix round 3: the gh read, the identity rule, the succession, the block, the watch ----

const IDLE_OWNED = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n'

test("the idle agent's pull request is read with one --json argument, in the agent's checkout", async () => {
  // gh reads a second word after --json as a second positional and exits 1: every idle
  // agent read as having no pull request, and « Stand it down » never fired.
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW, chain: IDLE_OWNED,
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
  })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  const gh = 'gh pr view feat/belt --json number,state'
  expect(fx.ran).toContain(gh)
  expect(fx.inits[gh].cwd).toBe('/tmp/h/work/belt')
  expect(fx.inits[gh].timeoutMs).toBeGreaterThan(0)
})

test('the agent on a tty is found by its host record, or by the basename of an absolute host path', async () => {
  // HOST_CLI an absolute path and the agent typed as a bare name: the old pattern
  // matched only the exact path and found no agent process on the tty.
  const { handlers } = mounted()
  const pr = { agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}' }
  const bare = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 hostcli --resume x\n', selfBin: '/opt/homebrew/bin/hostcli', env: { ORCHESTRATOR_HOST_CLI: '/opt/homebrew/bin/hostcli' } })
  expect(((await stop(handlers['classic.Stop'], bare.dollar, stopEvent({}))).answer as any).block).toContain('pull request #160')
  const wrapped = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 /usr/bin/node /x/cli.js\n', hostRecord: '{"pid":77,"sessionId":"s-a","status":"idle"}' })
  expect(((await stop(handlers['classic.Stop'], wrapped.dollar, stopEvent({}))).answer as any).block).toContain('pull request #160')
})

test("a declared block is honoured before « stand it down »: the idle agent may wait on that answer", async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW, chain: IDLE_OWNED,
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
  })
  const outcome = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'A or B?\nwaiting: operator — blocks: the choice of A or B' }))
  expect(outcome.answer).toBe(outcome.passed)
})

test('the predecessor of a succession may stop: its last line « handed over », or its done line once it handed over', async () => {
  const { handlers } = mounted()
  const open = { records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] }
  // « handed over » as the last line passes whatever is left: the successor holds it.
  const last = fakeDollar(open)
  const over = await stop(handlers['classic.Stop'], last.dollar, stopEvent({ last_assistant_message: 'Takeover confirmed.\nhanded over' }))
  expect(over.answer).toBe(over.passed)
  // Before the hand-over, a done line is held on the rows still open.
  const before = fakeDollar(open)
  expect(((await stop(handlers['classic.Stop'], before.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))).answer as any).block).toContain('row r-12')
  // The successor's spawn, run through Bash without error, is the hand-over.
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch : belt"' }
  await handlers['tool.call'](before.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const after = fakeDollar(open)
  const done = await stop(handlers['classic.Stop'], after.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))
  expect(done.answer).toBe(done.passed)
})

test('a successor spawn that failed hands nothing over', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash iterm-agent.sh spawn --successor' }
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ isError: true, result: 'never started', text: 'Exit code 1' }))
  expect(((await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'waiting: done' }))).answer as any).block).toContain('row r-12')
})

// Live, both sides of a succession were refused « Nothing will wake you » while each waited on
// the other: the predecessor for « takeover confirmed » after its successor's spawn, the
// successor for « handed over ». A peer's idle notice the session subscribed to wakes it as a
// busy agent's would, until that notice or a message from the peer arrives; and a session
// that handed over is never told nothing will wake it.
test('the predecessor that spawned its successor is never told nothing will wake it', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({})
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch : belt"' }
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const waiting = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Successor spawned; waiting for its « takeover confirmed ».' }))
  expect(waiting.answer).toBe(waiting.passed)
})

const SUBSCRIBE = { tool: 'SendMessage', tool_use_id: 't7', to: 'Orch : belt [b7f1]', message: 'takeover confirmed', notify_when_idle: true }
const SENT = async () => ({ result: { delivered: true } })
const WAITING = { last_assistant_message: 'Takeover confirmed sent; waiting for « handed over ».' }

test("a peer's idle notice the session subscribed to will wake it, until the notice arrives", async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:SendMessage']).toEqual({ tool: 'SendMessage' })
  const fx = fakeDollar({})
  // Not subscribed: refused.
  await handlers['tool.call:SendMessage'](fx.dollar, { ...SUBSCRIBE, notify_when_idle: false }, SENT)
  expect(((await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))).answer as any).block).toContain('Nothing will wake you')
  await handlers['tool.call:SendMessage'](fx.dollar, SUBSCRIBE, SENT)
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))
  expect(held.answer).toBe(held.passed)
  // A prompt from someone else leaves the subscription standing.
  await handlers['prompt.submit'](fx.dollar, { text: 'what is the state?', origin: { kind: 'composer' }, wait: false }, (x: unknown) => x)
  const still = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))
  expect(still.answer).toBe(still.passed)
  // The peer's message arrives: the wait is over, and the gate reads the session again.
  await handlers['prompt.submit'](fx.dollar, { text: 'Message from Orch : belt [b7f1]: handed over', origin: { kind: 'peer-send-message' }, wait: false }, (x: unknown) => x)
  expect(((await stop(handlers['classic.Stop'], fx.dollar, stopEvent(WAITING))).answer as any).block).toContain('Nothing will wake you')
})

test('a subscription a subagent made, or one whose send failed, wakes nothing', async () => {
  const { handlers } = mounted()
  const sub = fakeDollar({})
  await handlers['tool.call:SendMessage'](sub.dollar, { ...SUBSCRIBE, agentId: 'a-1' }, SENT)
  expect(((await stop(handlers['classic.Stop'], sub.dollar, stopEvent(WAITING))).answer as any).block).toContain('Nothing will wake you')
  const failed = fakeDollar({})
  await handlers['tool.call:SendMessage'](failed.dollar, SUBSCRIBE, async () => ({ isError: true, result: 'no such peer' }))
  expect(((await stop(handlers['classic.Stop'], failed.dollar, stopEvent(WAITING))).answer as any).block).toContain('Nothing will wake you')
})

test('a subscription past its time-to-live wakes nothing: a notice that never comes holds no gate open', () => {
  const peers = new Map([['Orch : belt', 1_000], ['Agent : x', 1_000 + NOTICE_TTL_MS]])
  expect(awaitingAny(peers, 1_000 + NOTICE_TTL_MS)).toBe(true)
  expect(awaitingAny(peers, 1_001 + NOTICE_TTL_MS)).toBe(true)
  expect([...peers.keys()]).toEqual(['Agent : x'])
  expect(awaitingAny(peers, 2_001 + 2 * NOTICE_TTL_MS)).toBe(false)
  expect(NOTICE_TTL_MS).toBe(2 * 60 * 60 * 1000)
})

test("a notice is the awaited peer's when it names it, by name or by reference", () => {
  expect(noticeFrom('Orch : belt [b7f1]', 'Orch : belt is idle', 'unclassified')).toBe(true)
  expect(noticeFrom('Orch : belt [b7f1]', 'session b7f1 exited', 'unclassified')).toBe(true)
  expect(noticeFrom('Orch : belt', 'handed over — Orch : belt', 'peer')).toBe(true)
  expect(noticeFrom('Orch : belt', 'handed over — Orch : belt', 'peer-send-message')).toBe(true)
  // The operator's own words, a stranger's message, a delivery receipt: not the notice.
  expect(noticeFrom('Orch : belt', 'is Orch : belt idle?', 'composer')).toBe(false)
  expect(noticeFrom('Orch : belt', 'Agent : x is idle', 'unclassified')).toBe(false)
  expect(noticeFrom('Orch : belt', 'Message delivered to Orch : belt', 'unclassified')).toBe(false)
})

test('the wake decision: an awaited notice wakes, and a handed-over session is never told nothing will', () => {
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting for it', awaiting: true })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting for it', handedOver: true })).toBeNull()
  // A delivered idle agent is still told: a subscription does not lift it.
  expect((checkWake({ agents: [{ label: 'Agent : a', state: 'idle', tty: '/dev/ttys003' }], resident: false, delivered: ['Agent : a (pull request #1, OPEN)'], message: 'x', awaiting: true }) as any).case).toBe('idle-delivered')
})

test('a ci-watch this session started, still running, will wake it; a stranger\'s will not', async () => {
  const { handlers } = mounted()
  // The session's host is pid 501 on ttys001; its background shell 800 runs the watch.
  const own = fakeDollar({ ps: `  800   501 /bin/zsh -c bash ${CI_WATCH} 160\n  900   800 /bin/bash ${CI_WATCH} 160\n` })
  const released = await stop(handlers['classic.Stop'], own.dollar, stopEvent({}))
  expect(released.answer).toBe(released.passed)
  const stranger = fakeDollar({ ps: `  900   1 /bin/bash ${CI_WATCH} 160\n` })
  expect(((await stop(handlers['classic.Stop'], stranger.dollar, stopEvent({}))).answer as any).block).toContain('Nothing will wake you')
})

test('a failing set is told once per watch, whatever the log\'s mtime does while the watch appends', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: 'waiting: operator — blocks: the report' }
  const at = (mtimeMs: number, text: string) => ({ 'here-pr160.log': { mtimeMs, text }, 'here-pr160.log.session': { mtimeMs, text: 'a1b2c3\n' } })
  const first = fakeDollar({ ciLogs: at(1, 'build\tpending\t9\tu\ntest\tfail\t30\tu\n') })
  expect(((await stop(handlers['classic.Stop'], first.dollar, stopEvent(message))).answer as any).block).toContain('1 failing (test)')
  // Ten seconds on the watch appended a snapshot: a new mtime, the same failing set.
  const later = fakeDollar({ ciLogs: at(2, 'build\tpending\t9\tu\ntest\tfail\t30\tu\nbuild\tpending\t19\tu\n'), heads: first.wrote[HEADS] })
  const passed = await stop(handlers['classic.Stop'], later.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  // A new watch (a new head) truncates the log: a new first line, told again.
  const fresh = fakeDollar({ ciLogs: at(3, 'build\tpending\t2\tv\ntest\tfail\t4\tv\n'), heads: later.wrote[HEADS] })
  expect(((await stop(handlers['classic.Stop'], fresh.dollar, stopEvent(message))).answer as any).block).toContain('#160')
})

test('the successor spawn is the launcher\'s spawn with --successor alone', () => {
  expect(isSuccessorSpawn('bash /p/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch : x"')).toBe(true)
  expect(isSuccessorSpawn('python3 -I /p/iterm_agent.py spawn --successor')).toBe(true)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh spawn --title "Agent : x"')).toBe(false)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh list # --successor')).toBe(false)
  expect(isSuccessorSpawn('grep -n successor notes.md')).toBe(false)
})

test('own watches are the ci-watches whose parents reach the host process', () => {
  const rows = processTable(`  501     1 hostcli\n  800   501 /bin/zsh -c x\n  900   800 /bin/bash ${CI_WATCH} 160\n  901     1 /bin/bash ${CI_WATCH} 161\n`)
  expect([...ownWatches(rows, '501')]).toEqual(['160'])
  expect([...ownWatches(rows, null)]).toEqual([])
})

test('the wake decision: handed over, a block before a delivered agent, a watch as a waker', () => {
  const idle = [{ label: 'Agent : a', state: 'idle' as const, tty: '/dev/ttys003' }]
  expect(checkWake({ agents: [], resident: false, delivered: [], message: '`handed over`.' })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done', handedOver: true })).toBeNull()
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting: done' })).toBe('read-what-is-left')
  expect(checkWake({ agents: idle, resident: false, delivered: ['Agent : a (pull request #1, OPEN)'], message: 'waiting: operator — blocks: x' })).toEqual({ blocks: 'x' })
  expect((checkWake({ agents: idle, resident: false, delivered: ['Agent : a (pull request #1, OPEN)'], message: 'done', watching: true }) as any).case).toBe('idle-delivered')
  expect(checkWake({ agents: [], resident: false, delivered: [], message: 'waiting on CI', watching: true })).toBeNull()
  // A bare question still blocks nothing declared.
  expect((checkWake({ agents: [], resident: false, delivered: [], message: 'You decide: A or B?' }) as any).case).toBe('question-without-blocks')
})

// --- the spec's goals (goals.md beside a registered record) --------------------------------

// A build was declared done against its plan while the plan had moved three of the spec's
// five goals « after the build ». The done branch now reads goals.py check over each goals.md
// beside a registered record, and refuses while a goal is open or the file does not hold.
const goalsAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  ok: false, open: ['G3'], unplanned: ['G3'], faults: [], notes: [], rows: 5, met: 3, ruled_out: 1,
  table: '| id | status |\n| G3 | open |', ...over,
})
const OPEN_GOALS = { exitCode: 1, stdout: goalsAnswer() }
const ALL_MET = { exitCode: 0, stdout: goalsAnswer({ ok: true, open: [], unplanned: [], table: '| G1 | met |' }) }
const DONE = { last_assistant_message: 'All five goals hold.\nwaiting: done' }
const NO_ROWS = { records: [''] }

test('the done branch names open goals and faults in their own texts, after what is left and the rows', () => {
  const open = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsOpen: ['G3', 'G4'] })
  expect(open?.reason).toBe('Not done against the spec: G3, G4 open. Dispatch the work that meets it and record its evidence '
    + '(dispatch-record.sh goals <record> met <G> --evidence …), or put it to the operator: '
    + 'waiting: operator — blocks: <G>: <what he must rule>.')
  const faulty = checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsFaults: ['G1 met without evidence on disk: x does not exist', '4 rows, the spec\'s Goals list 5'] })
  expect(faulty?.reason).toBe("goals.md is not a record of the spec: G1 met without evidence on disk: x does not exist; 4 rows, the spec's Goals list 5.")
  const all = checkWakeDone({ agents: [], checkouts: ['/tmp/c'], deferred: ['r-1 (x)'], goalsOpen: ['G3'], goalsFaults: ['G4 ruled out without the operator\'s words'] })!
  const at = (needle: string) => all.reason.indexOf(needle)
  expect(at('/tmp/c is still there')).toBeGreaterThanOrEqual(0)
  expect(at('row r-1 (x) is open')).toBeGreaterThan(at('/tmp/c is still there'))
  expect(at('Not done against the spec: G3')).toBeGreaterThan(at('row r-1 (x) is open'))
  expect(at('goals.md is not a record')).toBeGreaterThan(at('Not done against the spec'))
  expect(checkWakeDone({ agents: [], checkouts: [], deferred: [], goalsOpen: [], goalsFaults: [] })).toBeNull()
})

test('goals.py check --json is parsed, and anything else is no reading', () => {
  expect(parseGoalsCheck('/r/goals.md', goalsAnswer())?.open).toEqual(['G3'])
  expect(parseGoalsCheck('/r/goals.md', 'Traceback')).toBeNull()
  expect(parseGoalsCheck('/r/goals.md', '{"ok":false,"error":"cannot read"}')).toBeNull()
  expect(goalsPaths(['/a/rec.jsonl', '/a/other.jsonl', '/b/rec.jsonl', ''])).toEqual(['/a/goals.md', '/b/goals.md'])
  expect(goalsShownPath('/s', 'a/b')).toBe('/s/stop-gate/a_b.goals')
})

test('the presentation pass shows a table once per content, never an empty one', () => {
  const reading = parseGoalsCheck('/r/goals.md', ALL_MET.stdout)!
  const first = presentGoals([reading], '')!
  expect(first.reason.startsWith(GOALS_SHOW)).toBe(true)
  expect(first.reason).toContain('| G1 | met |')
  expect(presentGoals([reading], `${first.tell}\n`)).toBeNull()
  const changed = parseGoalsCheck('/r/goals.md', goalsAnswer({ ok: true, open: [], table: '| G1 | met | commit:abc1234 |' }))!
  expect(presentGoals([changed], `${first.tell}\n`)).not.toBeNull()
  expect(presentGoals([parseGoalsCheck('/r/goals.md', goalsAnswer({ ok: true, open: [], rows: 0 }))!], '')).toBeNull()
})

test('a registered record whose goals.md holds an open goal refuses waiting: done, naming it', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const held = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect((held.answer as any).block).toContain('Not done against the spec: G3 open')
  expect(fx.ran).toContain(`python3 ${GOALS_PY} check ${GOALS_FILE} --json`)
})

test('the same goals, all met, pass once the operator was shown the table', async () => {
  const { handlers } = mounted()
  const first = fakeDollar({ ...NO_ROWS, goals: ALL_MET })
  const shown = await stop(handlers['classic.Stop'], first.dollar, stopEvent(DONE))
  expect((shown.answer as any).block).toContain(GOALS_SHOW)
  const tell = first.wrote[`${STATE}/stop-gate/a1b2c3.goals`]
  expect(tell).toBeDefined()
  const again = fakeDollar({ ...NO_ROWS, goals: ALL_MET, goalsShown: tell })
  const passed = await stop(handlers['classic.Stop'], again.dollar, stopEvent(DONE))
  expect(passed.answer).toBe(passed.passed)
  // A changed file is shown once more.
  const changed = fakeDollar({ ...NO_ROWS, goals: { exitCode: 0, stdout: goalsAnswer({ ok: true, open: [], table: '| G1 | met | new |' }) }, goalsShown: tell })
  expect(((await stop(handlers['classic.Stop'], changed.dollar, stopEvent(DONE))).answer as any).block).toContain(GOALS_SHOW)
})

test('a declared block passes with goals open, and the goals are never read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'waiting: operator — blocks: G3: plan it or rule it out' }))
  expect(out.answer).toBe(out.passed)
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a predecessor that handed over passes with goals open, the goals never read', async () => {
  const { handlers } = mounted()
  const last = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const over = await stop(handlers['classic.Stop'], last.dollar, stopEvent({ last_assistant_message: 'handed over' }))
  expect(over.answer).toBe(over.passed)
  expect(last.ran.some(l => l.startsWith('python3'))).toBe(false)
  const spawned = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash /plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch : belt"' }
  await handlers['tool.call'](spawned.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  const done = await stop(handlers['classic.Stop'], spawned.dollar, stopEvent(DONE))
  expect(done.answer).toBe(done.passed)
  expect(spawned.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('an agent session with open goals stops untouched, nothing read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS, launchName: 'Agent : belt' })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('no record registered: the done passes and no goals check runs', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a legacy record with no goals.md passes and is said in one line', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar(NO_ROWS)
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(fx.written.filter(l => l.endsWith('| stop gate: /tmp/h/rec has no goals.md')).length).toBe(1)
  expect(fx.ran.some(l => l.startsWith('python3'))).toBe(false)
})

test('a goals check that hangs or exits 2 lets the stop pass, said, and still sweeps', async () => {
  const { handlers } = mounted()
  const broken = fakeDollar({ ...NO_ROWS, goals: { exitCode: 2, stdout: '{"ok":false,"error":"x"}' }, stampMtimeMs: Date.now() - 3600 * 1000 })
  const out = await stop(handlers['classic.Stop'], broken.dollar, stopEvent(DONE))
  expect(out.answer).toBe(out.passed)
  expect(broken.written.some(l => l.endsWith(`| stop gate: goals unread: ${GOALS_FILE}: it exited 2`))).toBe(true)
  expect(broken.ran.some(l => l.includes('workspace.sh sweep'))).toBe(true)
  const hung = fakeDollar({ ...NO_ROWS, goals: 'hang', env: { ORCHESTRATOR_STOP_GATE_DEADLINE: '0.2' } })
  const late = await stop(handlers['classic.Stop'], hung.dollar, stopEvent(DONE))
  expect(late.answer).toBe(late.passed)
  expect(hung.written.some(l => l.includes('goals unread') || l.includes('did not answer in time'))).toBe(true)
})

test('the stop re-fired this turn passes with goals open, nothing read', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ...NO_ROWS, goals: OPEN_GOALS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ ...DONE, stop_hook_active: true }))
  expect(out.answer).toBe(out.passed)
  expect(fx.ran.length).toBe(0)
})

// --- what a turn truly waits on ------------------------------------------------------------

// An orchestrator whose turn waited on a monitor it had started, no agent busy, was refused
// every stop until its last line read `waiting: operator — blocks: …` or `waiting: done`:
// only a ci-watch counted as something running, so each monitor event woke a turn the gate
// sent back, and every one of them ended on a wait for the operator that asked him nothing.
const SNAPSHOT = '/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && '
const shellOf = (command: string) => `${SNAPSHOT}eval '${command}' < /dev/null && pwd -P >| /tmp/x-cwd`
const MONITOR_PS = `  800   501 ${shellOf('tail -f deploy.log | grep --line-buffered done')}\n  801   800 tail -f deploy.log\n`

test('own background processes are the host shells under the host process, what each runs named', () => {
  const rows = processTable([
    '  501     1 hostcli',
    `  800   501 ${shellOf('sleep 300')}`,
    '  801   800 sleep 300',
    `  810   501 ${shellOf(`python3 - <<'"'"'EOF'"'"'\\012print(1)\\012EOF`)}`,
    `  820     1 ${shellOf('sleep 9')}`,
    '  830   501 caffeinate -i -t 300',
    '  840   501 ps -axo pid=,ppid=,command=',
    `  850   501 /bin/zsh -c x`,
    `  851   850 /bin/bash ${CI_WATCH} 160`,
  ].join('\n') + '\n')
  expect(ownBackground(rows, '501')).toEqual(['sleep 300', "python3 - <<'EOF' print(1) EOF", `ci-watch.sh 160`])
  expect(ownBackground(rows, null)).toEqual([])
})

test('a stop that ends on no machine line while a background process of the session runs passes', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ ps: MONITOR_PS })
  const out = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'Both deploys are running; the monitor will tell.' }))
  expect(out.answer).toBe(out.passed)
})

test('waiting: tool passes while a background process of the session runs, and is refused when none does', async () => {
  const { handlers } = mounted()
  const message = { last_assistant_message: 'Deploys started.\nwaiting: tool — the deploy monitor' }
  const watched = fakeDollar({ ps: MONITOR_PS })
  const passed = await stop(handlers['classic.Stop'], watched.dollar, stopEvent(message))
  expect(passed.answer).toBe(passed.passed)
  expect(watched.written.some(l => l.endsWith('| stop gate: check1 tool the deploy monitor'))).toBe(true)
  const idle = fakeDollar({ ps: `  820     1 ${shellOf('sleep 9')}\n` })
  const held = ((await stop(handlers['classic.Stop'], idle.dollar, stopEvent(message))).answer as any).block
  expect(held).toContain('Nothing of yours runs in the background')
  expect(held).toContain('waiting: operator — blocks: <what it blocks>')
  expect(held).toContain('waiting: done')
})

test('the tool line, decided over the facts', () => {
  const base = { agents: [], resident: false, delivered: [] }
  expect(checkWake({ ...base, message: 'x\n`waiting: tool — the deploy monitor`.', background: ['tail -f deploy.log'] })).toEqual({ tool: 'the deploy monitor' })
  expect(checkWake({ ...base, message: 'Waiting: Tool - ci-watch 12', watching: true })).toEqual({ tool: 'ci-watch 12' })
  expect((checkWake({ ...base, message: 'waiting: tool — the deploy monitor' }) as any).case).toBe('tool-not-running')
  // A busy agent is what wakes it: the line fits nothing, and the text says the turn ends on none.
  const busy = checkWake({ ...base, agents: [AGENT_BUSY], message: 'waiting: tool — the monitor' }) as any
  expect(busy.case).toBe('tool-not-running')
  expect(busy.reason).toContain('An agent of yours is busy: end on no machine line')
  // A delivered idle agent is told first, as for every line but a blocking question.
  expect((checkWake({ ...base, agents: [AGENT_IDLE], delivered: ['Agent : idle-p3 (pull request #1, OPEN)'], message: 'waiting: tool — x', background: ['sleep 9'] }) as any).case).toBe('idle-delivered')
})

test('a wait on the operator that blocks nothing is refused, the right line named', () => {
  const base = { agents: [], resident: false, delivered: [] }
  for (const blocks of ['nothing', 'Nothing.', 'none', 'NONE', 'nothing yet', 'nothing to ask', 'none for now', 'nothing.', 'n/a', 'N/A', '-', '']) {
    const held = checkWake({ ...base, message: `Watching the deploys.\nwaiting: operator — blocks: ${blocks}` }) as any
    expect([blocks, held.case]).toEqual([blocks, 'blocks-nothing'])
    expect(held.reason).toContain('waiting: done')
  }
  const urgent = checkWake({ ...base, message: 'waiting: operator (urgent) — blocks: nothing.' }) as any
  expect(urgent.case).toBe('blocks-nothing')
  const running = checkWake({ ...base, message: 'waiting: operator — blocks: nothing', background: ['tail -f deploy.log'] }) as any
  expect(running.reason).toContain('waiting: tool — <what is watched>')
  expect(running.reason).toContain('tail -f deploy.log')
  const busy = checkWake({ ...base, agents: [AGENT_BUSY], message: 'waiting: operator — blocks: none' }) as any
  expect(busy.case).toBe('blocks-nothing')
  expect(busy.reason).toContain('An agent of yours is busy: end on no machine line')
  // What blocks something is still the operator's wait.
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing else than the merge' })).toEqual({ blocks: 'nothing else than the merge' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing but G5' })).toEqual({ blocks: 'nothing but G5' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: none, except row 3' })).toEqual({ blocks: 'none, except row 3' })
  expect(checkWake({ ...base, message: 'waiting: operator — blocks: nothing before geonative-api#12' })).toEqual({ blocks: 'nothing before geonative-api#12' })
})

test('a true tool line is accepted when the host pid could not be read', () => {
  const base = { agents: [], resident: false, delivered: [] }
  expect(checkWake({ ...base, message: 'waiting: tool — the deploy monitor', hostUnread: true })).toEqual({ tool: 'the deploy monitor' })
  // A read host pid still refuses a tool line with nothing running.
  expect((checkWake({ ...base, message: 'waiting: tool — the deploy monitor' }) as any).case).toBe('tool-not-running')
})

test('the refusals offer the tool line only as what follows a launch, never as a line that fits now', () => {
  const nothing = (checkWake({ agents: [], resident: false, delivered: [], message: 'stopped.' }) as any).reason
  expect(nothing).toContain('no command or monitor you started runs in the background')
  expect(nothing).toContain('waiting: tool — <what is watched>')
})
