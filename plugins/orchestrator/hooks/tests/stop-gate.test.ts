// hooks/tests/stop-gate.test.ts
// An orchestrator's turn end: the deadline race, the parsers of the launcher's listing and the
// chain, the refusals of a declared done or deferred wait, and the handler over a faked $ — every
// field the classic.Stop event really carries pinned by a test that fails under the wrong spelling.
// The stop always passes, nothing journalled: what stays is what the turn end does — the module's
// tick on the busy agents and the pull requests, the idle agents' windows, and the sweep.
import { expect, test } from 'claude-code/testing'
import {
  withDeadline, isDegradedPass,
  deferredRows, listing, ownAgents, hostStatusOf, openRows, watchNumberOf, pullRequestOf,
  checkWakeDone, chainEntries, isSuccessorSpawn, hostTasks,
  NOTICE_TTL_MS, busyWake, parseGoalsCheck, goalsPaths,
  orchestrationOf, ownerOf, isOwnRecord, recordsWithOpenRows,
} from '../stop-gate.ts'
import { register as registerGuards } from '../guards.ts'
import { oweRound, owedOf, settleOwed } from '../review-close.ts'
import { register as registerWait, ASK_FIRST, Declarations, parseDeclaration } from '../wait.ts'
import { WAIT_TOOL } from '../../core/orchestration.ts'
import { journalled, logLineOf, blockOf, prQueryRun } from './fakes.ts'
import { capture, hookOf, hooksOn, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Hook, type Host, type Matcher, type Noun, type ProcessRunInit, type ToolSpec } from '../../core/host.ts'

// The host a hook under test is handed: every noun, those a fake does not set throwing.
type World = Host<Noun>
type StopEvent = Events['classic.Stop']
// The chain beneath a hook: it answers what it is handed.
type Pass = (x: unknown) => Promise<unknown>
const through: Pass = async x => x
// A decision's or an answer's fields, as a test reads them.
type Read = { readonly case?: unknown; readonly reason?: unknown; readonly warn?: unknown; readonly detail?: unknown; readonly block?: unknown; readonly result?: unknown; readonly isError?: unknown }
const fieldsIn = (value: unknown): Read => fieldsOf(value) ?? {}
import { VERDICT_LIMIT } from '../../core/verdict.ts'

// A question block in the decide shape, the text a turn's message may still carry around its wait.
const ASKED = ['**Question 1 of 1**', '_Subject_ : the report', '- **A** : yes', '- **B** : no'].join('\n')

// A question this session asked with `ask` (question.ts), open in the round.
const askedHere = (over: object = {}) => JSON.stringify({
  v: 2, id: 'q-a1b2c3-1', sender: { session: 'a1b2c3', name: 'Orch: belt', role: 'orchestrator', machine: 'box-1' },
  subject: 'the report', context: 'what is known', ask: 'Which one?', choices: [], recommended: null, why: null,
  blocks: 'the mode', status: 'open', at: '2026-11-14T10:00:00Z', answer: null, seq: 1, ...over,
})
const ASKED_HERE = askedHere()


// --- the decision shapes -----------------------------------------------------------------

test('a CI read that exceeds its time bound degrades to pass-and-log', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 250))
  const outcome = await withDeadline(slow, 10)
  expect(isDegradedPass(outcome) && outcome.decision).toBe('pass')
})

test('the read that wins the race is answered as itself, and the degraded pass is told apart', async () => {
  const outcome = await withDeadline(Promise.resolve('the launcher said'), 10)
  expect(outcome).toBe('the launcher said')
  expect(isDegradedPass(outcome)).toBe(false)
  expect(isDegradedPass(await withDeadline(new Promise(() => undefined), 10))).toBe(true)
})

test('work given a deadline is cancelled at the deadline, never left to write later', async () => {
  const wrote: string[] = []
  let seen: AbortSignal | null = null
  const outcome = await withDeadline(async (signal: AbortSignal) => {
    seen = signal
    await new Promise(resolve => setTimeout(resolve, 60))
    if (!signal.aborted) wrote.push('late')
    return 'finished'
  }, 10)
  expect(isDegradedPass(outcome)).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(seen!.aborted).toBe(true)
  expect(wrote).toEqual([])
  // Within its deadline the work is answered as itself, its signal never aborted.
  let kept: AbortSignal | null = null
  expect(await withDeadline(async (signal: AbortSignal) => { kept = signal; return 'in time' }, 50)).toBe('in time')
  expect(kept!.aborted).toBe(false)
  // A failure of the work is the work's own, not a degraded pass.
  await expect(withDeadline(async () => { throw new Error('the read broke') }, 50)).rejects.toThrow('the read broke')
})

// --- the ported parsers ------------------------------------------------------------------

test('the listing parses the launcher rows and drops the marks', () => {
  const rows = listing('w1/t1 | /dev/ttys001 | a title | Orch: belt | self\nw1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3 | hidden\nnot a row\n')
  expect(rows).toEqual([
    { tty: '/dev/ttys001', title: 'a title', name: 'Orch: belt' },
    { tty: '/dev/ttys002', title: '⠋ Agent: belt', name: 'Agent: belt-p3' },
  ])
})

test('a chain file with one corrupt line reads as empty', () => {
  // The launcher's chain_read empties the whole file on one bad line (its writes are
  // atomic, so a bad line means the file is not a chain), and the remains of a
  // non-atomic write must not anchor on a stranger's surviving entry.
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002","owner":"17"}\nnot json\n{"tab_id":"T2","tty":"/dev/ttys003","owner":"17"}\n')).toEqual([])
  expect(chainEntries('{"tab_id":"T1","tty":"/dev/ttys002"}\n{"tty":"/dev/ttys003"}\n'))
    .toEqual([{ tab_id: 'T1', tty: '/dev/ttys002', owner: '', resident: false }])
})

test('own agents are the owner entries that still run one, an idle resident left out', () => {
  const rows = listing('w1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3\nw1/t3 | /dev/ttys003 | ✳ Agent: idle | Agent: idle-p3\nw1/t4 | /dev/ttys004 | ✳ Agent: resident | Agent: resident-p3\nw1/t5 | /dev/ttys005 | a plain shell | (host default)\n')
  const entries = [
    { tab_id: 'T1', tty: '/dev/ttys002', owner: '17', resident: false },
    { tab_id: 'T2', tty: '/dev/ttys003', owner: '17', resident: false },
    { tab_id: 'T3', tty: '/dev/ttys004', owner: '17', resident: true },
    { tab_id: 'T4', tty: '/dev/ttys005', owner: '17', resident: false },
    { tab_id: 'T5', tty: '/dev/ttys006', owner: 'someone-else', resident: false },
  ]
  expect(ownAgents(rows, entries, '17')).toEqual([
    { label: 'Agent: belt-p3', state: 'busy', tty: '/dev/ttys002' },
    { label: 'Agent: idle-p3', state: 'idle', tty: '/dev/ttys003' },
  ])
  // With no owner known, no entry is counted: a recycled tty's occupant would be.
  expect(ownAgents(rows, entries, '')).toEqual([])
  // The host's own status outranks the glyph, which lags a turn's start: a tab still
  // reading ✳ whose session the host records busy is busy.
  const busy = ownAgents(rows, entries, '17', new Map([['/dev/ttys003', 'busy' as const]]))
  expect(busy.find(a => a.tty === '/dev/ttys003')?.state).toBe('busy')
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
  // Ready is the label of that name; an answer with no labels says nothing of it.
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN","labels":[{"name":"Ready"}]}')).toEqual({ number: '160', state: 'OPEN', ready: true })
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN","labels":[{"name":"ready-ish"}]}')).toEqual({ number: '160', state: 'OPEN', ready: false })
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN","labels":[]}')).toEqual({ number: '160', state: 'OPEN', ready: false })
  // The repository comes from the address the answer carries.
  expect(pullRequestOf('feat/belt', '{"number":160,"state":"OPEN","url":"https://github.com/acme/app/pull/160"}')).toEqual({ number: '160', state: 'OPEN', repo: 'acme/app' })
  expect(pullRequestOf('feat/belt', null)).toBeNull()
  expect(pullRequestOf('feat/belt', 'not json')).toBeNull()
})

test('open rows are the records still open, one per register path', () => {
  expect(openRows([
    '{"id":"r-12","label":"the report row","state":"open"}\n{"id":"r-13","state":"closed"}\n',
    'not json\n{"id":"r-14","state":"open"}\n',
  ])).toEqual(['r-12 (the report row)', 'r-14 (no label)'])
})

test('the pull request number is the log name, the base watches apart', () => {
  expect(watchNumberOf('here-pr160.log')).toBe('160')
  expect(watchNumberOf('owner_repo-pr12.log')).toBe('12')
  expect(watchNumberOf('here-pr160-base.log')).toBeNull()
  expect(watchNumberOf('notes.txt')).toBeNull()
})

// --- the refusals of a declared done or deferred wait (wait.ts) -----------------------------

test('a declared done is refused on open rows, and taken with none', () => {
  expect(checkWakeDone({ deferred: [] })).toBeNull()
  expect(checkWakeDone({ deferred: ['r-12 (the report row)'] })).toEqual({
    case: 'not-done',
    reason: 'Not done: row r-12 (the report row) is open. Dispatch it, close it, or say what blocks it'
      + ' — or, if the operator deferred it, set its revisit date (dispatch-record.sh blocker <record> <id> "until <ISO UTC time>"), record his ruling with dispatch-record.sh defer <record> <id> --ruling "<his words, dated>" '
      + 'and declare a deferred wait.',
  })
})

// --- the wiring --------------------------------------------------------------------------

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/tmp/h/rec/round.jsonl'
const STAMP = `${STATE}/sweep.stamp`
const PROJECTS = `${HOME}/.claude/projects`
const TRANSCRIPT = `${HOME}/elsewhere/s-stop.jsonl`
const LAUNCHER = '/plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh'
const WORKSPACE = '/plugins/orch-root/skills/orchestrator/scripts/workspace.sh'
const GOALS_SH = '/plugins/orch-root/skills/orchestrator/scripts/goals.sh'
const GOALS_FILE = '/tmp/h/rec/goals.md'

const BUSY_ROW = 'w1/t2 | /dev/ttys002 | ⠋ Agent: belt | Agent: belt-p3'
const IDLE_ROW = 'w1/t3 | /dev/ttys003 | ✳ Agent: idle | Agent: idle-p3'
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
  heads?: string | undefined
  ciLogs?: Record<string, { mtimeMs: number; text: string }>
  ps?: string
  agentCwd?: string
  agentBranch?: string
  // The agent's checkout HEAD, as `git rev-parse HEAD` prints it.
  agentHead?: string
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
  // The answer of `gh pr view <ref>` by its first argument (a branch, or the number of another pull request), over prAnswer.
  prByRef?: Record<string, string>
  // The panes the home server lists (`<tty> <pane id> <state>` a line), read by the tab-state write.
  panes?: string
  selfBin?: string
  goals?: { exitCode: number; stdout: string } | 'hang'
  goalsShown?: string
  round?: Record<string, string>
  // The session rows of the store (store/sessions/<name>), by file name.
  sessions?: Record<string, string>
  roundHang?: 'list' | 'read'
  // The to-do list of the session (todo.ts), read from the module's todo directory.
  todos?: string
  // The owner file of the register's record, and further registered records beside it, each
  // with its text, its owner file and its goals.md reading.
  recordOwner?: string
  shared?: { path: string; text: string; owner?: string; goals?: { exitCode: number; stdout: string } }[]
  // The busy agent's host process on ttys002 (its pid), and further files read by path.
  busyAgentPid?: string
  files?: Record<string, string>
  // The forge's open pull requests by repository, answering the machine file's query (prQueryRun): the
  // records registry then lists this session's register, and the file written is read back.
  forge?: Record<string, string>
  // A record another session of the machine registered (its predecessor's, `records/p9z8`), with its text and its owner file.
  predecessor?: { path: string; text: string; owner?: string }
}

function fakeDollar(setup: Setup): { dollar: World; written: string[]; ran: string[]; wrote: Record<string, string>; stamp: { atRun?: string | undefined }; inits: Record<string, ProcessRunInit | undefined> } {
  const inits: Record<string, ProcessRunInit | undefined> = {}
  const written: string[] = []
  const ran: string[] = []
  const wrote: Record<string, string> = {}
  const stamp: { atRun?: string | undefined } = {}
  const env: Readonly<Record<string, string>> = {
    HOME, ITERM_SESSION_ID: 'w0t0:2:17',
    ORCHESTRATOR_HOST_CLI: 'hostcli', ...(setup.env ?? {}),
  }
  // The fake serves whatever root the module resolves: the default config-dir root, or the
  // override's when the setup sets one.
  const S = statePaths(env['ORCHESTRATOR_STATE_DIR'] ?? STATE)
  const plugin = { name: 'orchestrator', root: '/plugins/orch-root' }
  const dollar = hostOf({
    // The launcher's scripts are found under the engine's $.plugin.root: the
    // environment above deliberately carries no CLAUDE_PLUGIN_ROOT, as live.
    plugin,
    session: { id: async () => 'a1b2c3' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => {
        if (p === S.chain) return setup.chain ?? ''
        if (p === S.register) return [...(setup.records ? [RECORD] : []), ...(setup.shared ?? []).map(r => r.path)].map(r => `${r}\n`).join('')
        if (p === RECORD) return (setup.records ?? [])[0] ?? ''
        if (p === `${RECORD}.owner` && setup.recordOwner !== undefined) return `${setup.recordOwner}\n`
        if (p === `${S.root}/records/p9z8` && setup.predecessor !== undefined) return `${setup.predecessor.path}\n`
        for (const record of [...(setup.shared ?? []), ...(setup.predecessor ? [setup.predecessor] : [])]) {
          if (p === record.path) return record.text
          if (p === `${record.path}.owner` && record.owner !== undefined) return `${record.owner}\n`
        }
        if (p === S.heads) return setup.heads ?? ''
        if (p === S.ignored) {
          if (setup.failIgnoredRead) throw new Error('EACCES: permission denied')
          if (setup.ignoredText !== undefined) return setup.ignoredText
          // Absent: the same answer a missing file gives.
          throw new Error(`ENOENT: ${p}`)
        }
        if (p === `${HOME}/.claude/sessions/77.json` && setup.hostRecord !== undefined) return setup.hostRecord
        if (setup.files?.[p] !== undefined) return setup.files[p]
        if (setup.forge !== undefined && wrote[p] !== undefined) return wrote[p]!
        if (p === `${S.root}/stop-gate/a1b2c3.goals` && setup.goalsShown !== undefined) return setup.goalsShown
        if (p.startsWith(`${S.root}/store/sessions/`) && setup.sessions?.[p.slice(`${S.root}/store/sessions/`.length)] !== undefined) return setup.sessions[p.slice(`${S.root}/store/sessions/`.length)]!
        if (setup.roundHang === 'read' && (p.startsWith(`${S.root}/round/`))) return new Promise(() => undefined)
        const asked = p.startsWith(`${S.root}/round/`) ? setup.round?.[p.slice(S.root.length + 7)] : undefined
        if (asked !== undefined) return asked
        if (p.startsWith(`${S.root}/todo/`) && setup.todos !== undefined) return setup.todos
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
        if (p === `${S.root}/records` && (setup.forge !== undefined || setup.predecessor !== undefined)) {
          return [...(setup.forge !== undefined ? ['a1b2c3'] : []), ...(setup.predecessor ? ['p9z8'] : [])].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
        }
        if (p === `${HOME}/.claude/sessions` && setup.hostRecord !== undefined) return [{ name: '77.json', kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }]
        if (p === `${S.root}/store/sessions`) return Object.keys(setup.sessions ?? {}).map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
        if (p === `${S.root}/round`) {
          if (setup.roundHang === 'list') return new Promise(() => undefined)
          return Object.entries(setup.round ?? {}).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: 0, isLink: false }))
        }
        return []
      },
      exists: async (p: string) => (p === GOALS_FILE && setup.goals !== undefined)
        || (setup.shared ?? []).some(record => record.goals !== undefined && p === `${record.path.replace(/\/[^/]*$/, '')}/goals.md`),
    },
    process: {
      run: async (argv: readonly string[], init?: ProcessRunInit) => {
        inits[argv.join(' ')] = init
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, () => setup.transcript ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        // The store's rename (core's renameArgv, `mv -f <temporary> <path>`): the file lands on its name.
        if (argv[0] === 'mv') { wrote[argv[3]!] = wrote[argv[2]!]!; return { exitCode: 0, stdout: '', stderr: '' } }
        if (setup.forge !== undefined) {
          const asked = prQueryRun(argv, repo => setup.forge?.[repo] ?? null)
          if (asked !== null) return asked
          if (argv[0] === 'sh' && String(argv[2] ?? '').includes('set -C')) return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'tmux') {
          const answer = argv[3] === 'display-message' ? '1|home:@3.%7\n' : argv[3] === 'list-panes' ? setup.panes ?? '' : ''
          return { exitCode: 0, stdout: answer, stderr: '' }
        }
        if (argv[0] === 'sh') {
          return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys001') {
          // The session's own process, as the listing prints it.
          const bin = setup.selfBin ?? 'hostcli'
          return { exitCode: 0, stdout: setup.noLaunchName ? `  501 ${bin}\n` : `  501 ${bin} --name ${setup.launchName ?? 'Orch: belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] === 'ttys002' && setup.busyAgentPid) return { exitCode: 0, stdout: `${setup.busyAgentPid}\n`, stderr: '' }
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
        if (argv[0] === 'git' && argv[3] === 'rev-parse' && argv[4] === 'HEAD' && argv[2] === '/tmp/h/work/belt') {
          return setup.agentHead ? { exitCode: 0, stdout: `${setup.agentHead}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: '' }
        }
        if (argv[0] === 'git' && argv[3] === 'rev-parse') {
          return argv[2] === '/tmp/h/work/repo' && setup.top
            ? { exitCode: 0, stdout: `${setup.top}\n`, stderr: '' }
            : { exitCode: 128, stdout: '', stderr: '' }
        }
        if (argv[0] === 'gh') {
          const byRef = setup.prByRef?.[argv[3] ?? '']
          if (byRef !== undefined) return { exitCode: 0, stdout: byRef, stderr: '' }
          // Another pull request, asked by its number in its repository, has only the answer given for it.
          if (argv[4] === '-R') return { exitCode: 1, stdout: '', stderr: 'no answer' }
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
        if (argv[0] === 'bash' && argv[1] === GOALS_SH) {
          const sharedGoals = (setup.shared ?? []).find(record => `${record.path.replace(/\/[^/]*$/, '')}/goals.md` === argv[3])
          if (sharedGoals?.goals) return { exitCode: sharedGoals.goals.exitCode, stdout: sharedGoals.goals.stdout, stderr: '' }
          if (setup.goals === 'hang') return new Promise(() => undefined)
          return { exitCode: setup.goals?.exitCode ?? 2, stdout: setup.goals?.stdout ?? '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, written, ran, wrote, stamp, inits }
}

// `declarations`: given, the guards share it with the caller, as the host shares the wait module's.
type Guards = {
  'classic.Stop': Hook<World, Events['classic.Stop']>
  'prompt.submit': Hook<World, Events['prompt.submit']>
  // The guard on Bash, the last tool call it registers.
  'tool.call': Hook<World, Events['tool.call']>
}
function mounted(declarations: Declarations = new Declarations()): { handlers: Guards; matchers: { 'classic.Stop': Matcher | undefined } } {
  const hooks = capture<World>(on => registerGuards(on, declarations))
  const stopHook = hookOf(hooks, 'classic.Stop')
  const handlers: Guards = {
    'classic.Stop': stopHook.handler,
    'prompt.submit': hookOf(hooks, 'prompt.submit').handler,
    'tool.call': hooksOn(hooks, 'tool.call').filter(h => h.matcher?.['tool'] === 'Bash').at(-1)!.handler,
  }
  return { handlers, matchers: { 'classic.Stop': stopHook.matcher } }
}

const stopEvent = (over: Record<string, unknown> = {}): StopEvent => ({
  session_id: 'a1b2c3',
  transcript_path: TRANSCRIPT,
  cwd: '/tmp/h/work/repo',
  stop_hook_active: false,
  last_assistant_message: 'stopped.',
  ...over,
})

// A stop through the handler: `observed` would be what a refusal's log line said, and none is ever written.
async function stop(handler: Guards['classic.Stop'], dollar: World, e: StopEvent) {
  return observing(dollar, async (seen, pass) => handler(seen, e, pass))
}

// Runs `through` over a $ whose log lines and journal are read: a stop that passes journals nothing.
async function observing(dollar: World, through: (dollar: World, pass: Pass) => Promise<unknown>) {
  let passed: unknown = null
  const lines: string[] = []
  const fx = journalled({ ...dollar, process: { ...dollar.process, run: async (argv: readonly string[], init?: ProcessRunInit) => {
    const line = logLineOf(argv)
    if (line !== null) lines.push(line)
    return init === undefined ? dollar.process.run(argv) : dollar.process.run(argv, init)
  } } })
  const answer = await through(fx.dollar, async (x: unknown) => { passed = x; return x })
  // The reason a refusal would have given, read off its log line: none is ever written.
  const mark = '| stop gate: let through: '
  const held = lines.find(line => line.includes(mark))
  const observed = held === undefined ? undefined : held.slice(held.indexOf(mark) + mark.length)
  expect(observed).toBeUndefined()
  expect(fx.journal()).toEqual([])
  return { answer, passed, observed }
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
  const { dollar, ran } = fakeDollar({ launchName: 'Agent: belt' })
  const e = stopEvent({})
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(ran.filter(l => l.includes('iterm-agent.sh')).length).toBe(0)
})

// His ruling of 2026-11-18 (the sweep, P1): the turn end observes nothing. Whatever is left open — rows,
// goals, to-dos, a pending check, an idle agent, no wait declared — the stop passes with no reason
// logged and no escape journalled, for an orchestrator, an auditor and an agent alike.
test('a stop always passes, no reason logged and nothing journalled, whatever is left open', async () => {
  const { handlers } = mounted()
  const todo = `${JSON.stringify({ v: 1, id: 1, opened: '2026-11-14T15:00:00Z', label: 'item 1', state: 'open', verdict: '', words: 'his words', said_at: '2026-11-14T14:58:00Z', from: 'Coord: general' })}\n`
  const open = {
    records: ['{"id":"r-12","label":"the report row","state":"open"}\n'], todos: todo,
    listing: IDLE_ROW, chain: '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n',
    agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"OPEN"}',
    ciLogs: { 'here-pr160.log': { mtimeMs: 1, text: 'build\tfail\t9\tu\n' }, 'here-pr160.log.session': { mtimeMs: 1, text: 'a1b2c3\n' } },
  }
  const ends = [
    { launchName: 'Orch: belt', message: 'waiting: done' },
    { launchName: 'Orch: belt', message: 'Stopped.' },
    { launchName: 'Audit: belt', message: 'The report is written.' },
    { launchName: 'Agent: belt-p3', message: 'w'.repeat(VERDICT_LIMIT + 20) },
  ]
  for (const { launchName, message } of ends) {
    const fx = fakeDollar({ ...open, launchName })
    const e = stopEvent({ last_assistant_message: message, background_tasks: [], session_crons: [] })
    const out = await stop(handlers['classic.Stop'], fx.dollar, e)
    expect(out.answer).toBe(e)
    expect(out.passed).toBe(e)
    expect(fx.written.filter(l => /stop gate: (?:let through|check|warn)|names no report file|open to-do/.test(l))).toEqual([])
  }
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

// A busy own agent releases the stop, and arms the busy wake: its host record (busy since its
// turn's start) is read when the timer fires, and the session's own (pid 501) when there is one.
function busyWorld(busyFor: number, drops = 0) {
  const since = Date.now() - busyFor
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/88.json`]: JSON.stringify({ pid: 88, sessionId: 's-agent', status: 'busy', statusUpdatedAt: since }),
  }
  const fx = fakeDollar({ listing: BUSY_ROW, chain: OWNED, busyAgentPid: '88', files })
  const timers: { ms: number; fire: () => unknown; cancelled: boolean }[] = []
  const submitted: string[] = []
  const dollar = {
    ...fx.dollar,
    clock: { ...fx.dollar.clock, after: (ms: number, fire: () => unknown) => {
      const timer = { ms, fire, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    } },
    prompt: { ...fx.dollar.prompt, submit: async ({ text }: { text: string }) => {
      if (drops-- > 0) return { drop: 'the session is busy' }
      submitted.push(text)
      return undefined
    } },
  } as unknown as World
  return { dollar, timers, submitted, ran: fx.ran, files }
}

test('a busy own agent past the bound wakes its orchestrator once, with a line naming it, its time and its fill', async () => {
  const { handlers } = mounted()
  const w = busyWorld(NOTICE_TTL_MS + 5 * 60_000)
  const e = stopEvent({})
  expect((await stop(handlers['classic.Stop'], w.dollar, e)).passed).toBe(e)
  const before = w.ran.length
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual(['[module] Agent: belt-p3 busy 2h05 in one turn — read its tree'])
  // Local reads only: the tick runs no forge call.
  expect(w.ran.slice(before).filter(l => l.startsWith('gh'))).toEqual([])
  // Armed again at the next bound of the same turn, and the same bound never told twice.
  expect(w.timers.length).toBe(1)
  expect(w.timers[0]!.ms).toBeGreaterThan(NOTICE_TTL_MS - 6 * 60_000)
  expect(w.timers[0]!.ms).toBeLessThanOrEqual(NOTICE_TTL_MS - 5 * 60_000)
  await stop(handlers['classic.Stop'], w.dollar, e)
  await w.timers.pop()!.fire()
  expect(w.submitted.length).toBe(1)
})

test('a busy own agent under the bound wakes nothing: the timer waits for the bound', async () => {
  const { handlers } = mounted()
  const w = busyWorld(60 * 60_000)
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual([])
  expect(w.timers.length).toBe(1)
  expect(w.timers[0]!.ms).toBeLessThanOrEqual(60 * 60_000)
  expect(w.timers[0]!.ms).toBeGreaterThan(59 * 60_000)
})

test('the busy wake waits while the session is in a turn of its own, then wakes it at its end', async () => {
  const { handlers } = mounted()
  const w = busyWorld(NOTICE_TTL_MS + 5 * 60_000)
  const own = `${HOME}/.claude/sessions/501.json`
  w.files[own] = JSON.stringify({ pid: 501, sessionId: 'a1b2c3', status: 'busy', statusUpdatedAt: 1 })
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  // The wake stands across the session's turns: nothing cancels it but the next arm.
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual([])
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
  w.files[own] = JSON.stringify({ pid: 501, sessionId: 'a1b2c3', status: 'idle', statusUpdatedAt: 2 })
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual(['[module] Agent: belt-p3 busy 2h05 in one turn — read its tree'])
})

test('a busy wake the host drops is tried again a minute later, its bound still untold', async () => {
  const { handlers } = mounted()
  const w = busyWorld(NOTICE_TTL_MS + 5 * 60_000, 1)
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual([])
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
  await w.timers.shift()!.fire()
  expect(w.submitted.length).toBe(1)
})

// An orchestrator whose record holds the line of acme/app#9, the forge answering the machine file's query.
function prWorld(open: number[], drops = 0, over: Parameters<typeof fakeDollar>[0] = {}) {
  const fx = fakeDollar({
    records: [OPEN_PR_LINE('Agent: nine')], recordOwner: 'Orch: belt',
    sessions: { a1b2c3: JSON.stringify({ role: 'orchestrator', name: 'Orch: belt', repo: 'acme/app', context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() }) },
    forge: { 'acme/app': JSON.stringify(open.map(number => ({ number, createdAt: '2026-11-15T06:00:00Z' }))) },
    ...over,
  })
  const timers: { ms: number; fire: () => unknown; cancelled: boolean }[] = []
  const submitted: string[] = []
  const dollar = {
    ...fx.dollar,
    clock: { ...fx.dollar.clock, after: (ms: number, fire: () => unknown) => {
      const timer = { ms, fire, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    } },
    prompt: { ...fx.dollar.prompt, submit: async ({ text }: { text: string }) => {
      if (drops-- > 0) return { drop: 'the session is busy' }
      submitted.push(text)
      return undefined
    } },
  } as unknown as World
  return { dollar, timers, submitted, ran: fx.ran, wrote: fx.wrote }
}

test('a pull request of the orchestration merged outside the session wakes it at the tick, its agent no longer running, the line archived', async () => {
  const { handlers } = mounted()
  const w = prWorld([])
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  expect(w.timers.map(t => t.ms)).toEqual([0])
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual(['[module] acme/app#9 merged.'])
  expect(w.ran.filter(l => l.startsWith('gh api graphql')).length).toBe(1)
  expect(w.wrote[`${RECORD.replace(/\.jsonl$/, '')}.archive.jsonl`]).toContain('"pr":9')
  // Nothing open left to watch: the tick is not armed again.
  expect(w.timers).toEqual([])
})

test('an open pull request entering the anomaly wakes the orchestrator once; nothing changed wakes nothing, read again an interval later', async () => {
  const { handlers } = mounted()
  const w = prWorld([9])
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  await w.timers.shift()!.fire()
  // Agent: nine is no running agent: the pull request is in anomaly, told once.
  expect(w.submitted).toEqual(['[module] acme/app#9 en anomalie (sans agent depuis 2026-11-15T07:00Z) — reattach an agent, refresh its wait, or ask'])
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
  await w.timers.shift()!.fire()
  expect(w.submitted.length).toBe(1)
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
})

test('the tick that finds the pull requests of the record moved puts them on the session\'s row and in the deck, with no turn ended', async () => {
  const { handlers } = mounted()
  const w = prWorld([9])
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  await w.timers.shift()!.fire()
  const rowPath = Object.keys(w.wrote).find(path => path.endsWith('/store/sessions/a1b2c3'))
  expect(JSON.parse(w.wrote[rowPath ?? ''] ?? '{}').unattended?.open).toEqual(['acme/app#9'])
  const deckPath = Object.keys(w.wrote).find(path => path.endsWith('/deck.json'))
  expect(JSON.parse(w.wrote[deckPath ?? ''] ?? '{}').orchestrators?.find((o: { name: string }) => o.name === 'Orch: belt')?.prs).toEqual(['acme/app#9'])
})

test('with no pull request of its own, the tick keeps the file current while a reader wants it: one call an interval', async () => {
  const { handlers } = mounted()
  const w = prWorld([], 0, { records: [''], files: { [`${STATE}/prs.wanted`]: `acme/web ${new Date().toISOString()}\n` }, forge: { 'acme/web': '[]' } })
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  expect(w.timers.map(t => t.ms)).toEqual([0])
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual([])
  expect(w.ran.filter(l => l.startsWith('gh api graphql')).length).toBe(1)
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
})

// The review session of acme/app#12 as the launcher leaves it, owed a close by the orchestrator session `a1b2c3`.
async function oweReviewSession(): Promise<void> {
  const prompts = `${STATE}/prompts`
  const files: Record<string, string> = {
    [`${STATE}/store/sessions/s-rev`]: JSON.stringify({ role: 'agent', name: 'Agent: review 12 r1 [a1b2c3]', tty: '/dev/ttys007', updated_at: '2026-11-15T07:00:00.000Z' }) + '\n',
    [`${prompts}/launch-Agent--review-12-r1-1795386718957.sh`]: '#!/bin/sh\ncd /w && export ORCHESTRATOR_BRIEF=/briefs/review.md && exec sh\n',
    '/briefs/review.md': [
      '# app — review: the delivery', '', 'You are the REVIEW agent for this round. You read; you never implement.', '',
      '4. The delivery: pull request 12 (the implementer\'s report, `/b/report.md`), branch `fix/x`, head `0123456789`, base `origin/main`',
    ].join('\n'),
  }
  const $ = hostOf({
    plugin: { root: '/plugins/orch-root' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    fs: {
      read: async (p: string) => { const text = files[p]; if (text !== undefined) return text; throw new Error(`ENOENT: ${p}`) },
      list: async (dir: string) => Object.keys(files).filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, isLink: false })),
    },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  })
  const line = await oweRound($, { session: 'a1b2c3', pr: 12, round: async () => ({ repo: 'acme/app', head: '0123456789abcdef0123456789abcdef01234567' }) })
  expect(line).not.toBeNull()
}

// Mutation: `|| hasOwed(sessionId)` removed from `tick.watch` (guards.ts): the first stop arms no tick and this test falls.
test('the tick keeps running after the turn that recorded a verdict while a review session\'s close is owed, and stops once it is settled', async () => {
  owedOf('a1b2c3').forEach(settleOwed)
  const { handlers } = mounted()
  // No ledger line, no reader of the pull request file: nothing else keeps the tick.
  const none = prWorld([], 0, { records: [''] })
  await stop(handlers['classic.Stop'], none.dollar, stopEvent({}))
  expect(none.timers).toEqual([])
  await oweReviewSession()
  expect(owedOf('a1b2c3').length).toBe(1)
  const owing = prWorld([], 0, { records: [''] })
  await stop(handlers['classic.Stop'], owing.dollar, stopEvent({}))
  expect(owing.timers.map(t => t.ms)).toEqual([0])
  owedOf('a1b2c3').forEach(settleOwed)
  const settled = prWorld([], 0, { records: [''] })
  await stop(handlers['classic.Stop'], settled.dollar, stopEvent({}))
  expect(settled.timers).toEqual([])
})

// Mutation: `onClosedRow` removed from `tick.watch` (guards.ts): the first stop arms no tick and this test falls.
test('with no ledger line, an idle agent of its own done on a closed row arms the tick, which closes it, then stops', async () => {
  const { handlers } = mounted()
  const world = (state: string) => prWorld([], 0, {
    records: [`${JSON.stringify({ id: 8, state, label: 'row 8', agent: 'Agent: idle-p3' })}\n`],
    listing: IDLE_ROW, chain: IDLE_OWNED,
    sessions: {
      a1b2c3: JSON.stringify({ role: 'orchestrator', name: 'Orch: belt', tty: '/dev/ttys001', updated_at: new Date().toISOString() }),
      's-idle': JSON.stringify({ role: 'agent', name: 'Agent: idle-p3 [a1b2c3]', tty: '/dev/ttys003', updated_at: new Date().toISOString() }),
    },
    hostRecord: JSON.stringify({ pid: 77, sessionId: 's-idle', cwd: '/tmp/h/work/belt', status: 'idle', name: 'Agent: idle-p3' }),
    files: { [`${STATE}/store/waits/s-idle`]: JSON.stringify({ waiting: 'delivered', blocks: 'row 8', waiting_since: '2026-11-15T07:00:00Z', name: 'Agent: idle-p3', pid: '77' }) },
  })
  const open = world('open')
  await stop(handlers['classic.Stop'], open.dollar, stopEvent({}))
  expect(open.timers).toEqual([])
  const closed = world('closed')
  await stop(handlers['classic.Stop'], closed.dollar, stopEvent({}))
  expect(closed.timers.map(t => t.ms)).toEqual([0])
  await closed.timers.shift()!.fire()
  expect(closed.submitted).toEqual(['[module] row 8 (rec) is closed: its agent Agent: idle-p3 is done: the module closes it now (session s-idle, resumable within the hour).'])
  expect(closed.ran.filter(l => l.startsWith(`bash ${LAUNCHER} close`))).toEqual([`bash ${LAUNCHER} close --tty /dev/ttys003 --expect-title Agent: idle-p3`])
})

test('a pull request wake the host drops is tried again a minute later, told then, and its line archived only once told', async () => {
  const { handlers } = mounted()
  const w = prWorld([], 1)
  await stop(handlers['classic.Stop'], w.dollar, stopEvent({}))
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual([])
  expect(Object.keys(w.wrote).some(p => p.endsWith('.archive.jsonl'))).toBe(false)
  expect(w.timers.map(t => t.ms)).toEqual([60_000])
  await w.timers.shift()!.fire()
  expect(w.submitted).toEqual(['[module] acme/app#9 merged.'])
  expect(Object.keys(w.wrote).some(p => p.endsWith('.archive.jsonl'))).toBe(true)
})

test('the busy wake tells each bound of a turn once, and a new turn afresh', () => {
  const told = new Map<string, number>()
  const agent = (key: string, since: number) => ({ label: 'Agent: a', key, since })
  expect(busyWake([agent('s 0', 0)], told, NOTICE_TTL_MS - 1)).toEqual({ lines: [], next: NOTICE_TTL_MS })
  expect(busyWake([agent('s 0', 0)], told, NOTICE_TTL_MS).lines).toEqual(['[module] Agent: a busy 2h00 in one turn — read its tree'])
  expect(busyWake([agent('s 0', 0)], told, NOTICE_TTL_MS + 1)).toEqual({ lines: [], next: 2 * NOTICE_TTL_MS })
  expect(busyWake([agent('s 0', 0)], told, 2 * NOTICE_TTL_MS).lines.length).toBe(1)
  // A new turn: the old one's bounds are dropped, and its own first bound is told.
  expect(busyWake([agent('s 9', 9)], told, 9 + NOTICE_TTL_MS).lines.length).toBe(1)
  expect([...told.keys()]).toEqual(['s 9'])
})

const OPEN_PR_LINE = (agent: string) => `${JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr: 9, status: 'working', agent, since: '2026-11-15T07:00:00Z', updated: '2026-11-15T07:00:00Z' })}\n`

// The stop's read of an idle agent's pull request moves the agent's window in the home session: over
// when the pull request is merged or closed, done or review by its Ready label for a delivery.
const HOME_ENV = { TMUX: '/tmp/home.sock,4242,0', TMUX_PANE: '%1' }
// In a home session the owner of a chain entry is the pane (`tmux:<socket>:<pane id>`), not the iTerm2 tab.
const HOME_CHAIN = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"tmux:/tmp/home.sock:%1"}\n'
const AGENT_CHAIN = '{"tab_id":"T1","tty":"/dev/ttys003","owner":"17"}\n'
const stateWrites = (ran: readonly string[]) => ran.filter(c => c.startsWith('tmux ') && c.includes(' set-option '))
// The agent's checkout HEAD, and the head commit of its branch's pull request: the same commit, as an own pull request has.
const HEAD = 'abc1234'
const atHead = (answer: string) => JSON.stringify({ ...JSON.parse(answer), headRefOid: HEAD })
async function stopOn(prAnswer: string, panes: string, env: Record<string, string> = HOME_ENV) {
  const { handlers } = mounted()
  const fx = fakeDollar({ listing: IDLE_ROW, chain: env === HOME_ENV ? HOME_CHAIN : AGENT_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', agentHead: HEAD, prAnswer: atHead(prAnswer), panes, env })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  return stateWrites(fx.ran)
}

test('the window of an idle agent whose pull request is merged or closed shows over, once', async () => {
  const over = ['tmux -S /tmp/home.sock set-option -w -t %9 @state over']
  expect(await stopOn('{"number":160,"state":"MERGED","labels":[]}', '/dev/ttys002 %8 idle\n/dev/ttys003 %9 done\n')).toEqual(over)
  expect(await stopOn('{"number":160,"state":"CLOSED","labels":[]}', '/dev/ttys003 %9 review\n')).toEqual(over)
  expect(await stopOn('{"number":160,"state":"MERGED"}', '/dev/ttys003 %9 over\n')).toEqual([])
})

// A long-lived branch: the checkout's HEAD is past the head of the old merged pull request its name answers.
const OLD_MAIN_PR = '{"number":1747,"state":"MERGED","labels":[],"headRefOid":"cbce845"}'

test('a checkout whose HEAD is not the head of its branch\'s merged pull request keeps its window', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ listing: IDLE_ROW, chain: HOME_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'main\n', agentHead: '9b173df', prByRef: { main: OLD_MAIN_PR }, panes: '/dev/ttys003 %9 done\n', env: HOME_ENV })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  expect(stateWrites(fx.ran)).toEqual([])
})

test('an agent whose HEAD is the head of its merged pull request shows over', async () => {
  const { handlers } = mounted()
  const merged = '{"number":160,"state":"MERGED","labels":[],"headRefOid":"abc1234"}'
  const fx = fakeDollar({ listing: IDLE_ROW, chain: HOME_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', agentHead: 'abc1234', prAnswer: merged, panes: '/dev/ttys003 %9 done\n', env: HOME_ENV })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  expect(stateWrites(fx.ran)).toEqual(['tmux -S /tmp/home.sock set-option -w -t %9 @state over'])
})

test('a branch that moved past its old pull request still counts the pull requests its record entrusts to it', async () => {
  const { handlers } = mounted()
  const merged = '{"number":9,"state":"MERGED","labels":[],"headRefOid":"f00ba12"}'
  const fx = fakeDollar({ listing: IDLE_ROW, chain: HOME_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'main\n', agentHead: '9b173df', prByRef: { main: OLD_MAIN_PR, '9': merged }, records: [LEDGER(9)], panes: '/dev/ttys003 %9 done\n', env: HOME_ENV })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  expect(stateWrites(fx.ran)).toEqual(['tmux -S /tmp/home.sock set-option -w -t %9 @state over'])
})

test('the window of a delivery moves between review and done by the Ready label of its open pull request', async () => {
  const ready = '{"number":160,"state":"OPEN","labels":[{"name":"enhancement"},{"name":"Ready"}]}'
  const notReady = '{"number":160,"state":"OPEN","labels":[{"name":"enhancement"}]}'
  expect(await stopOn(ready, '/dev/ttys003 %9 review\n')).toEqual(['tmux -S /tmp/home.sock set-option -w -t %9 @state done'])
  expect(await stopOn(notReady, '/dev/ttys003 %9 done\n')).toEqual(['tmux -S /tmp/home.sock set-option -w -t %9 @state review'])
  // An agent at rest on no delivery, a window already right, and an answer with no labels stay as they are.
  // The label's case does not matter, as at the github ready gate.
  expect(await stopOn('{"number":160,"state":"OPEN","labels":[{"name":"ready"}]}', '/dev/ttys003 %9 review\n')).toEqual(['tmux -S /tmp/home.sock set-option -w -t %9 @state done'])
  expect(await stopOn(ready, '/dev/ttys003 %9 idle\n')).toEqual([])
  expect(await stopOn(ready, '/dev/ttys003 %9 done\n')).toEqual([])
  expect(await stopOn('{"number":160,"state":"OPEN"}', '/dev/ttys003 %9 review\n')).toEqual([])
})

// An agent holding several pull requests is ready only when each open one carries Ready: the branch's
// own, and the others the dispatch record entrusts to it (its `working` lines).
const LEDGER = (...prs: number[]) => prs.map(pr => JSON.stringify({ v: 1, ledger: 'pr', repo: 'acme/app', pr, status: 'working', agent: 'Agent: idle-p3', since: '2026-11-15T07:00:00Z', updated: '2026-11-15T07:00:00Z' })).join('\n') + '\n'
const branchPr = (state: string, ready: boolean) => `{"number":160,"state":"${state}","url":"https://github.com/acme/app/pull/160","headRefOid":"${HEAD}","labels":[${ready ? '{"name":"Ready"}' : ''}]}`
const otherPr = (state: string, ready: boolean) => `{"number":9,"state":"${state}","labels":[${ready ? '{"name":"Ready"}' : ''}]}`
async function stopWithTwo(branch: string, other: string | undefined, shown: string) {
  const { handlers } = mounted()
  const fx = fakeDollar({
    listing: IDLE_ROW, chain: HOME_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', agentHead: HEAD, prAnswer: branch,
    prByRef: other === undefined ? {} : { '9': other }, records: [LEDGER(160, 9)], panes: `/dev/ttys003 %9 ${shown}\n`, env: HOME_ENV,
  })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  return { writes: stateWrites(fx.ran), read9: fx.ran.some(c => c.startsWith('gh pr view 9 -R acme/app')), read160: fx.ran.some(c => c.startsWith('gh pr view 160')) }
}

test('an agent with two pull requests shows ready only when both carry Ready, merged ones set aside', async () => {
  const toReview = ['tmux -S /tmp/home.sock set-option -w -t %9 @state review']
  const toDone = ['tmux -S /tmp/home.sock set-option -w -t %9 @state done']
  const toOver = ['tmux -S /tmp/home.sock set-option -w -t %9 @state over']
  // One Ready and one not: not ready, so a window that shows ✓ goes back under review, and one under review stays.
  const mixed = await stopWithTwo(branchPr('OPEN', true), otherPr('OPEN', false), 'done')
  expect(mixed.writes).toEqual(toReview)
  expect(mixed.read9).toBe(true)
  // The branch's own pull request is read once, never again for its ledger line.
  expect(mixed.read160).toBe(false)
  expect((await stopWithTwo(branchPr('OPEN', true), otherPr('OPEN', false), 'review')).writes).toEqual([])
  expect((await stopWithTwo(branchPr('OPEN', false), otherPr('OPEN', true), 'done')).writes).toEqual(toReview)
  // Both Ready: ready.
  expect((await stopWithTwo(branchPr('OPEN', true), otherPr('OPEN', true), 'review')).writes).toEqual(toDone)
  // One merged and the other open and not Ready: not over, not ready. Open and Ready: ready.
  expect((await stopWithTwo(branchPr('MERGED', true), otherPr('OPEN', false), 'done')).writes).toEqual(toReview)
  expect((await stopWithTwo(branchPr('MERGED', false), otherPr('OPEN', true), 'review')).writes).toEqual(toDone)
  // Everything merged or closed: over.
  expect((await stopWithTwo(branchPr('MERGED', true), otherPr('CLOSED', false), 'done')).writes).toEqual(toOver)
  // The other one cannot be read: nothing is known, so nothing moves.
  expect((await stopWithTwo(branchPr('OPEN', true), undefined, 'review')).writes).toEqual([])
  expect((await stopWithTwo(branchPr('MERGED', true), undefined, 'done')).writes).toEqual([])
})

test('a tmux that fails, or a pane the server does not list, never fails the stop: said once in the log, nothing written', async () => {
  const merged = '{"number":160,"state":"MERGED","labels":[]}'
  // The agent's tty is not among the panes: nothing is written.
  expect(await stopOn(merged, '/dev/ttys009 %3 done\n')).toEqual([])
  // The pane list fails: the stop passes, the log says so.
  const { handlers } = mounted()
  const down = fakeDollar({ listing: IDLE_ROW, chain: HOME_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', agentHead: HEAD, prAnswer: atHead(merged), panes: '/dev/ttys003 %9 done\n', env: HOME_ENV })
  const failing = { ...down.dollar, process: { ...down.dollar.process, run: async (argv: readonly string[], init?: ProcessRunInit) =>
    argv[0] === 'tmux' && argv[3] === 'list-panes' ? { exitCode: 1, stdout: '', stderr: 'no server' } : init === undefined ? down.dollar.process.run(argv) : down.dollar.process.run(argv, init) } }
  const out = await stop(handlers['classic.Stop'], failing as World, stopEvent({}))
  expect(out.answer).toBe(out.passed)
  expect(down.written.filter(l => l.includes('tab-state: tmux exited 1 listing the panes')).length).toBe(1)
  expect(stateWrites(down.ran)).toEqual([])
})

test('outside a home session the stop writes no window state, and no tmux is called', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ listing: IDLE_ROW, chain: AGENT_CHAIN, agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"MERGED","labels":[]}', panes: '/dev/ttys003 %9 done\n' })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({}))
  expect(fx.ran.filter(c => c.startsWith('tmux '))).toEqual([])
})

test('the transcript is read from the event, not by hunting the projects directory', async () => {
  // The rename lives outside the projects directory: only the event's transcript_path
  // reaches it, the fallback the prompt gate needs would not.
  const renamed = ['{"type":"assistant","message":{"role":"assistant","content":"an answer"}}', '{"type":"custom-title","customTitle":"Orch: round 3"}'].join('\n') + '\n'
  const { handlers } = mounted()
  const named = fakeDollar({ transcript: renamed, noLaunchName: true })
  const read = await stop(handlers['classic.Stop'], named.dollar, stopEvent({}))
  expect(read.answer).toBe(read.passed)
  // Named an orchestrator by the rename, the session's agents are read off the launcher's listing.
  expect(named.ran.some(l => l.includes('iterm-agent.sh list'))).toBe(true)
  const unnamed = fakeDollar({ noLaunchName: true })
  const quiet = await stop(handlers['classic.Stop'], unnamed.dollar, stopEvent({ transcript_path: '' }))
  expect(quiet.answer).toBe(quiet.passed)
  expect(quiet.observed).toBeUndefined()
  expect(unnamed.written.length).toBe(1)
  expect(unnamed.ran.some(l => l.includes('iterm-agent.sh list'))).toBe(false)
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

// --- the sweep -----------------------------------------------------------------------------

// A passing, scoped stop: the blocks line releases check 1 and no ci-watch log exists,
// so the stop reaches the sweep at its final exit.
const PASSING = { last_assistant_message: ASKED + '\nwaiting: operator — blocks: the report' }
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

test('the stamp, a fixed name of the data root, is renamed into place: a link planted at it is replaced, never written through', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({ stampMtimeMs: OLD_STAMP })
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent(PASSING))
  expect(fx.ran.some(l => l.startsWith(`mv -f ${STAMP}.tmp-`) && l.endsWith(` ${STAMP}`))).toBe(true)
  expect(fx.stamp.atRun).toMatch(/^\d{10}\n$/)
})

test('a due sweep logs what it pushed and the reason a checkout stays when first written, never its kept lines', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({
    stampMtimeMs: OLD_STAMP,
    sweep: {
      exitCode: 0,
      stdout: 'pushed feat/x of /tmp/h/work/repo/x\ndeleted /tmp/h/work/repo/x\nkept /tmp/h/work/repo/y: the tree is dirty (no live orchestrator or agent)\n',
      stderr: 'workspace: ledger: /tmp/h/work/repo/y stays: the tree is dirty (orchestrator Orch: P, agent none)\nworkspace: other\n',
    },
  })
  const { answer, passed } = await stop(handlers['classic.Stop'], fx.dollar, stopEvent(PASSING))
  expect(answer).toBe(passed)
  expect(fx.written.some(l => l.includes('sweep pushed feat/x of /tmp/h/work/repo/x'))).toBe(true)
  expect(fx.written.some(l => l.includes('sweep ledger: /tmp/h/work/repo/y stays: the tree is dirty (orchestrator Orch: P, agent none)'))).toBe(true)
  expect(fx.written.some(l => l.includes('kept') || l.includes('other'))).toBe(false)
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

test('a session outside the orchestration runs no sweep', async () => {
  const { handlers } = mounted()
  const { dollar, ran, wrote } = fakeDollar({ stampMtimeMs: OLD_STAMP, launchName: 'Agent: belt' })
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

test('a stop without ITERM_SESSION_ID is told that no chain entry is counted', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ env: { ITERM_SESSION_ID: '' } })
  const e = stopEvent(PASSING)
  const { answer } = await stop(handlers['classic.Stop'], dollar, e)
  expect(answer).toBe(e)
  expect(written.some(l => l.includes('ITERM_SESSION_ID is not set: no chain entry is counted'))).toBe(true)
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

// --- the state root's override ----------------------------------------------------------------

test('the state root follows ORCHESTRATOR_STATE_DIR, the module\'s own log staying in the config dir', async () => {
  // The launcher's dispatch tool and ci-watch honor the override before the config dir; the
  // module resolves the same root, and what the turn end writes under it moves as one: the sweep
  // stamp. The module's own log is config-dir-bound and moves with nothing. Without the override
  // every test above pins the config-dir root; this one pins the branch the override selects.
  const { handlers } = mounted()
  const OVER = '/tmp/h/over'
  const swept = fakeDollar({ env: { ORCHESTRATOR_STATE_DIR: OVER }, stampMtimeMs: OLD_STAMP })
  const passed = await stop(handlers['classic.Stop'], swept.dollar, stopEvent(PASSING))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
  expect(swept.wrote[`${OVER}/sweep.stamp`]).toMatch(/^\d{10}\n$/)
  expect(Object.keys(swept.wrote).every(p => p.startsWith(OVER))).toBe(true)
  expect(swept.written.every(l => l.includes('| guards |'))).toBe(true)
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
  const gh = 'gh pr view feat/belt --json number,state,labels,url,headRefOid'
  expect(fx.ran).toContain(gh)
  expect(fx.inits[gh]?.cwd).toBe('/tmp/h/work/belt')
  expect(fx.inits[gh]?.timeoutMs).toBeGreaterThan(0)
})

test('the agent on a tty is found by its host record, or by the basename of an absolute host path', async () => {
  // HOST_CLI an absolute path and the agent typed as a bare name: the old pattern
  // matched only the exact path and found no agent process on the tty.
  const { handlers } = mounted()
  const pr = { agentCwd: '/tmp/h/work/belt', agentBranch: 'feat/belt\n', prAnswer: '{"number":160,"state":"MERGED"}' }
  // Found, the agent's checkout is read and its pull request asked of the forge.
  const gh = 'gh pr view feat/belt --json number,state,labels,url,headRefOid'
  const bare = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 hostcli --resume x\n', selfBin: '/opt/homebrew/bin/hostcli', env: { ORCHESTRATOR_HOST_CLI: '/opt/homebrew/bin/hostcli' } })
  await stop(handlers['classic.Stop'], bare.dollar, stopEvent({}))
  expect(bare.ran).toContain(gh)
  const wrapped = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 /usr/bin/node /x/cli.js\n', hostRecord: '{"pid":77,"sessionId":"s-a","status":"idle"}' })
  await stop(handlers['classic.Stop'], wrapped.dollar, stopEvent({}))
  expect(wrapped.ran).toContain(gh)
  // A process on the tty that is neither is no agent: nothing is asked of the forge.
  const stranger = fakeDollar({ ...pr, listing: IDLE_ROW, chain: IDLE_OWNED, agentRow: '   77 vim notes.md\n' })
  await stop(handlers['classic.Stop'], stranger.dollar, stopEvent({}))
  expect(stranger.ran).not.toContain(gh)
})

// The successor's spawn, run through Bash without error, is the hand-over the turn's end reads (supervision.ts).
test('the successor spawn run without error hands over, one that failed hands nothing over', async () => {
  const declarations = new Declarations()
  const { handlers } = mounted(declarations)
  const fx = fakeDollar({})
  const spawn = { tool: 'Bash', tool_use_id: 't9', command: 'bash iterm-agent.sh spawn --successor' }
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ isError: true, result: 'never started', text: 'Exit code 1' }))
  expect(declarations.handedOver('a1b2c3')).toBe(false)
  await handlers['tool.call'](fx.dollar, spawn, async () => ({ result: { stdout: 'spawned' } }))
  expect(declarations.handedOver('a1b2c3')).toBe(true)
})

test('the successor spawn is the launcher\'s spawn with --successor alone', () => {
  expect(isSuccessorSpawn('bash /p/skills/iterm-agents/scripts/iterm-agent.sh spawn --successor --title "Orch: x"')).toBe(true)
  expect(isSuccessorSpawn('python3 -I /p/iterm_agent.py spawn --successor')).toBe(true)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh spawn --title "Agent: x"')).toBe(false)
  expect(isSuccessorSpawn('bash /p/iterm-agent.sh list # --successor')).toBe(false)
  expect(isSuccessorSpawn('grep -n successor notes.md')).toBe(false)
})

// --- the spec's goals (goals.md beside a registered record) --------------------------------

// A build was declared done against its plan while the plan had moved three of the spec's
// five goals « after the build ». The done branch now reads goals.sh check over each goals.md
// beside a registered record, and refuses while a goal is open or the file does not hold.
const goalsAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  ok: false, open: ['G3'], unplanned: ['G3'], faults: [], notes: [], rows: 5, met: 3, ruled_out: 1,
  table: '| id | status |\n| G3 | open |', ...over,
})

test('the refusal names open goals and faults in their own texts, after the rows', () => {
  const open = checkWakeDone({ deferred: [], goalsOpen: ['G3', 'G4'] })
  expect(open?.reason).toBe('Not done against the spec: G3, G4 open. Dispatch the work that meets it and record its evidence '
    + '(dispatch-record.sh goals <record> met <G> --evidence …), or put it to the operator when he has not ruled, '
    + 'with an operator wait that blocks on <G> — or, if he deferred it, record his ruling with '
    + 'dispatch-record.sh goals <record> defer <G> --ruling "<his words, dated>" and declare a deferred wait.')
  const faulty = checkWakeDone({ deferred: [], goalsFaults: ['G1 met without evidence on disk: x does not exist', '4 rows, the spec\'s Goals list 5'] })
  expect(faulty?.reason).toBe("goals.md is not a record of the spec: G1 met without evidence on disk: x does not exist; 4 rows, the spec's Goals list 5.")
  const all = checkWakeDone({ deferred: ['r-1 (x)'], goalsOpen: ['G3'], goalsFaults: ['G4 ruled out without the operator\'s words'] })!
  const at = (needle: string) => all.reason.indexOf(needle)
  expect(at('row r-1 (x) is open')).toBeGreaterThanOrEqual(0)
  expect(at('Not done against the spec: G3')).toBeGreaterThan(at('row r-1 (x) is open'))
  expect(at('goals.md is not a record')).toBeGreaterThan(at('Not done against the spec'))
  expect(checkWakeDone({ deferred: [], goalsOpen: [], goalsFaults: [] })).toBeNull()
})

test('goals.sh check --json is parsed, and anything else is no reading', () => {
  expect(parseGoalsCheck('/r/goals.md', goalsAnswer())?.open).toEqual(['G3'])
  expect(parseGoalsCheck('/r/goals.md', 'Traceback')).toBeNull()
  expect(parseGoalsCheck('/r/goals.md', '{"ok":false,"error":"cannot read"}')).toBeNull()
  expect(goalsPaths(['/a/rec.jsonl', '/a/other.jsonl', '/b/rec.jsonl', ''])).toEqual(['/a/goals.md', '/b/goals.md'])
})

// --- what a turn truly waits on ------------------------------------------------------------

// The host's own list of the session's background work, carried on the stop (the deck reads it).
const SHELL_TASK = { id: 'b1', type: 'shell', status: 'running', description: 'deploy', command: 'bash deploy.sh' }

test('the host task list names each task by what it runs, and is null when the host gives none', () => {
  expect(hostTasks(undefined, [])).toBe(null)
  expect(hostTasks('x', undefined)).toBe(null)
  expect(hostTasks([], undefined)).toEqual([])
  expect(hostTasks([SHELL_TASK, { id: 'a', type: 'subagent', status: 'running', description: 'search' }, { id: 'm', type: 'monitor', status: 'running', description: '' }, null], [{ schedule: '0 9 * * *' }, {}]))
    .toEqual(['bash deploy.sh', 'search', 'monitor', 'a scheduled wake-up (0 9 * * *)', 'a scheduled wake-up'])
})

// The host's list carries a status per task and only promises a string: a task it lists as
// finished wakes nothing. A status not known to be terminal, or none, still counts.
test('the host task list leaves out a completed, failed, killed or stopped task', () => {
  const settled = ['completed', 'failed', 'killed', 'stopped'].map(status => ({ ...SHELL_TASK, status, command: `bash ${status}.sh` }))
  expect(hostTasks(settled, [])).toEqual([])
  expect(hostTasks([...settled, { ...SHELL_TASK, status: 'pending' }, { id: 'a', type: 'subagent', description: 'search' }], []))
    .toEqual(['bash deploy.sh', 'search'])
})

// --- work the operator deferred: the ending « waiting: deferred — <n> items » ------------------

// The operator ruled G5 and G6 « later, when I am on mini-tech »: the session had nothing left
// to do, and the gate's only ending for open work was a question to him, which raised an alert
// for a question that did not exist. A ruling that defers work is recorded (dispatch-record.sh
// defer, goals … defer), and the ending that fits is its own machine line, never a question.
const DEFERRED_ROW = '{"id":5,"label":"the mini-tech row","state":"open","deferred":"2026-10-29: later"}\n'
const DEFERRED_GOALS = { exitCode: 1, stdout: goalsAnswer({ open: [], deferred: ['G5', 'G6'], unplanned: [], table: '| G5 | deferred |' }) }

test('open rows that carry a ruling are the deferred ones, still open', () => {
  const texts = [DEFERRED_ROW + '{"id":6,"label":"live","state":"open"}\n{"id":7,"label":"old","state":"closed","deferred":"x"}\n']
  expect(openRows(texts)).toEqual(['5 (the mini-tech row)', '6 (live)'])
  expect(deferredRows(texts)).toEqual(['5 (the mini-tech row)'])
})

test('a deferred ending passes when every open row and goal is deferred, and nothing else is left', () => {
  const left = { deferred: ['5 (the mini-tech row)'], deferredRows: ['5 (the mini-tech row)'], goalsOpen: [], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone(left)).toBeNull()
})

test('a deferred ending is refused while an open row or goal is not deferred, naming it', () => {
  const left = { deferred: ['5 (a)', '6 (live)'], deferredRows: ['5 (a)'], goalsOpen: ['G4'], goalsDeferred: ['G5'], ending: 'deferred' as const }
  const held = checkWakeDone(left)!
  expect(held.reason).toContain('row 6 (live) is open')
  expect(held.reason).not.toContain('row 5 (a)')
  expect(held.reason).toContain('Not done against the spec: G4 open')
  expect(held.reason).toContain('record his ruling with dispatch-record.sh defer')
  expect(held.reason).toContain('goals <record> defer <G>')
  expect(held.reason).toContain('declare a deferred wait')
})

test('a deferred ending with nothing deferred is refused: the done line fits', () => {
  const held = checkWakeDone({ deferred: [], ending: 'deferred' })!
  expect(held.reason).toContain('Nothing is deferred')
  expect(held.reason).toContain('declare done')
})

test('a done ending is refused on deferred work, which names the deferred line', () => {
  const held = checkWakeDone({ deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5'] })!
  expect(held.reason).toBe('Not done: row 5 (a), G5 deferred by the operator, still open. Declare a deferred wait, not done.')
  // An open row that is not deferred keeps its own reason beside it.
  const both = checkWakeDone({ deferred: ['5 (a)', '6 (b)'], deferredRows: ['5 (a)'] })!
  expect(both.reason).toContain('row 6 (b) is open')
  expect(both.reason).toContain('row 5 (a) deferred by the operator')
})

test('a faulty goals file refuses the deferred ending too', () => {
  const held = checkWakeDone({ deferred: [], goalsDeferred: ['G5'], goalsFaults: ['G5 deferred without the operator\'s words'], ending: 'deferred' })!
  expect(held.reason).toBe("goals.md is not a record of the spec: G5 deferred without the operator's words.")
})

test('the goals reading carries the goals the operator deferred', () => {
  expect(parseGoalsCheck('/r/goals.md', DEFERRED_GOALS.stdout)?.deferred).toEqual(['G5', 'G6'])
  expect(parseGoalsCheck('/r/goals.md', goalsAnswer())?.deferred).toEqual([])
})

// The ids after « waiting: deferred — » are compared with the deferred items: a line that names
// nothing of what is put off, or not all of it, is no record of what the session ended on.
test('a deferred ending passes only when its ids name every deferred item, rows by number, goals as G<n>', () => {
  const left = { deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '5, G5, G6' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5 G5 G6' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'row 5, g5, G6' })).toBeNull()
  const none = checkWakeDone({ ...left, ids: 'nothing' })!
  expect(none.case).toBe('not-done')
  expect(none.reason).toContain('missing row 5, G5, G6')
  expect(none.reason).toContain('unknown nothing')
  const part = checkWakeDone({ ...left, ids: '5, G5, G9' })!
  expect(part.reason).toContain('missing G6')
  expect(part.reason).not.toContain('missing row 5')
  expect(part.reason).toContain('unknown G9')
})

// The short form: the count of deferred rows, and of deferred goals when there are any.
test('the short deferred line passes when its counts are the records\' deferred rows and goals', () => {
  const left = { deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6', 'G8'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '2 rows G3' })).toBeNull()
  expect(checkWakeDone({ ...left, goalsDeferred: [], ids: '2 rows' })).toBeNull()
  expect(checkWakeDone({ ...left, deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: [], ids: '1 row' })).toBeNull()
})

test('the short deferred line with a wrong count is refused, the message giving the right line', () => {
  const left = { deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  const wrongRows = checkWakeDone({ ...left, ids: '3 rows G2' })!
  expect(wrongRows.case).toBe('not-done')
  expect(wrongRows.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '2 rows' })!.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '5, 7, G5, G6' })).toBeNull()
})

// The taught form: one count of the deferred items, rows and goals together.
test('the items line passes when its count is the deferred rows and goals together', () => {
  const left = { deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '4 items' })).toBeNull()
  expect(checkWakeDone({ ...left, deferred: ['5 (a)'], deferredRows: ['5 (a)'], goalsDeferred: ['G5'], ids: '2 items' })).toBeNull()
})

test('the items line with a wrong count is refused, the message giving the total', () => {
  const left = { deferred: ['5 (a)', '7 (b)'], deferredRows: ['5 (a)', '7 (b)'], goalsDeferred: ['G5', 'G6'], ending: 'deferred' as const }
  const wrong = checkWakeDone({ ...left, ids: '2 items' })!
  expect(wrong.case).toBe('not-done')
  expect(wrong.reason).toContain('A deferred wait must give the number of deferred rows and goals together')
  expect(wrong.reason).toContain('the right count is 4 items.')
  expect(checkWakeDone({ ...left, ids: '2 rows G2' })).toBeNull()
})

// Every window of a tmux server inherits the server's ITERM_SESSION_ID, so the owner of a
// chain entry cannot be read from it there: the pane names the session.
const TMUX_ENV = { ITERM_SESSION_ID: 'w0t0:2:17', TMUX: '/private/tmp/tmux-501/orch,4242,0' }
const TMUX_OWNED = '{"tab_id":"tmux:/private/tmp/tmux-501/orch:@1","tty":"/dev/ttys002","owner":"tmux:/private/tmp/tmux-501/orch:%3"}\n'

test('an entry owned by a tmux pane is counted for that pane only, not for a sibling sharing the server\'s ITERM_SESSION_ID', async () => {
  const { handlers } = mounted()
  // Counted, the agent's session is read on its tty; not counted, its tty is never read.
  const status = 'ps -t ttys002 -o pid='
  const own = fakeDollar({ listing: BUSY_ROW, chain: TMUX_OWNED, env: { ...TMUX_ENV, TMUX_PANE: '%3' } })
  const mine = stopEvent({})
  expect((await stop(handlers['classic.Stop'], own.dollar, mine)).answer).toBe(mine)
  expect(own.ran).toContain(status)
  const sibling = fakeDollar({ listing: BUSY_ROW, chain: TMUX_OWNED, env: { ...TMUX_ENV, TMUX_PANE: '%4' } })
  const theirs = stopEvent({})
  expect((await stop(handlers['classic.Stop'], sibling.dollar, theirs)).answer).toBe(theirs)
  expect(sibling.ran).not.toContain(status)
})

// --- a dispatch record belongs to one orchestration ------------------------------------------

// A record was read by every session that had touched it, and its open rows and goals.md were
// the session's to answer for whoever opened them. The owner file beside the record
// (`<record>.owner`, written by dispatch-record.sh) names the orchestration; the gate reads a
// record that is its session's own, or has no owner yet, and no other.
test('an orchestration is its name without the reference, in the house shape', () => {
  expect(orchestrationOf('Orch: Shipping')).toBe('Orch: Shipping')
  expect(orchestrationOf('Orch: Shipping [a1b2c3]')).toBe('Orch: Shipping')
  expect(orchestrationOf('Orch: belt')).toBe('Orch: belt')
  expect(orchestrationOf('  Orch:  belt  ')).toBe('Orch: belt')
  expect(orchestrationOf('Agent: belt')).toBeNull()
  expect(orchestrationOf(null)).toBeNull()
})

test('an orchestration reads the former « Orch : x » the current way, and only a name core reads as one', () => {
  expect(orchestrationOf('Orch : belt [a1b2c3]')).toBe('Orch: belt')
  expect(orchestrationOf('Orch:belt')).toBe('Orch: belt')
  expect(orchestrationOf('Orch: ' + 'a'.repeat(25))).toBe('Orch: ' + 'a'.repeat(25))
  expect(orchestrationOf('Orch: ' + 'a'.repeat(26))).toBeNull()
  expect(ownerOf('Orch : other\n')).toBe('Orch: other')
})

test('an owner file names its owner on its first line, and a blank file names nobody', () => {
  expect(ownerOf('Orch: other\n')).toBe('Orch: other')
  expect(ownerOf('Orch: other [a1b2c3]\nignored\n')).toBe('Orch: other')
  expect(ownerOf('\n  \n')).toBeNull()
  expect(ownerOf('')).toBeNull()
})

test('an owner line that is no orchestration name is the owner as written', () => {
  expect(ownerOf('o-1234\n')).toBe('o-1234')
})

test('a record is the session\'s own when it has no owner or the owner is the session\'s orchestration', () => {
  expect(isOwnRecord(null, 'Orch: belt')).toBe(true)
  expect(isOwnRecord('Orch: belt', 'Orch: belt')).toBe(true)
  expect(isOwnRecord('Orch: other', 'Orch: belt')).toBe(false)
  expect(isOwnRecord('Orch: belt', null)).toBe(false)
  expect(isOwnRecord(null, null)).toBe(true)
})

test('the records that hold an open row not deferred are the ones the refusal names', () => {
  const live = '{"id":1,"label":"a","state":"open"}\n'
  const putOff = '{"id":2,"label":"b","state":"open","deferred":"2026-11-03: later"}\n'
  const closed = '{"id":3,"label":"c","state":"closed"}\n'
  expect(recordsWithOpenRows(['/r/a.jsonl', '/r/b.jsonl', '/r/c.jsonl'], [live, putOff, closed])).toEqual(['/r/a.jsonl'])
})

test('the refusals name the record or the goals file they read, when they are given', () => {
  const rows = checkWakeDone({ deferred: ['5 (a)'], rowRecords: ['/r/dispatch.jsonl'] })!
  expect(rows.reason).toContain('Not done: row 5 (a) is open in /r/dispatch.jsonl. Dispatch it')
  const many = checkWakeDone({ deferred: ['5 (a)', '6 (b)'], rowRecords: ['/r/x.jsonl', '/s/y.jsonl'] })!
  expect(many.reason).toContain('Not done: rows 5 (a), 6 (b) are open in /r/x.jsonl, /s/y.jsonl. Dispatch them')
  const goals = checkWakeDone({ deferred: [], goalsOpen: ['G3'], goalsRecords: ['/r/goals.md'] })!
  expect(goals.reason).toContain('Not done against the spec: G3 open in /r/goals.md. Dispatch the work')
})

// The turn end reads the ledger of its orchestration's records alone: a record another owns arms no tick.
test('the ledger the turn end reads is its orchestration\'s own records alone', async () => {
  const { handlers } = mounted()
  const foreign = prWorld([9], 0, { recordOwner: 'Orch: other' })
  await stop(handlers['classic.Stop'], foreign.dollar, stopEvent({}))
  expect(foreign.timers).toEqual([])
  const own = prWorld([9], 0, { recordOwner: 'Orch: belt [a1b2c3]' })
  await stop(handlers['classic.Stop'], own.dollar, stopEvent({}))
  expect(own.timers.map(t => t.ms)).toEqual([0])
})

// --- the declared wait (hooks/wait.ts) ---------------------------------------------------------

// The declarations each wait mounting holds: the gate chained after it reads the same ones.
type Waits = {
  'session.start': Hook<World, Events['session.start']>
  'turn.start': Hook<World, Events['turn.start']>
  'tool.call': Hook<World, Events['tool.call']>
  'turn.complete': Hook<World, Events['turn.complete']>
}
// A property of a registered tool's input schema.
const propertyOf = (spec: ToolSpec | undefined, name: string) => fieldsOf(fieldsOf(spec?.inputSchema?.['properties'])?.[name])
const WAITS = new WeakMap<Waits, Declarations>()
function waitMounted(): Waits {
  const declarations = new Declarations()
  const hooks = capture<World>(on => registerWait(on, declarations))
  const handlers: Waits = {
    'session.start': hookOf(hooks, 'session.start', {}).handler,
    'turn.start': hookOf(hooks, 'turn.start', {}).handler,
    'tool.call': hookOf(hooks, 'tool.call', { tool: `mcp__orchestrator__${WAIT_TOOL}` }).handler,
    'turn.complete': hookOf(hooks, 'turn.complete', {}).handler,
  }
  WAITS.set(handlers, declarations)
  return handlers
}

// The stop as the gate reads it: the declarations of the wait module beside it, read directly.
async function chainedStop(wait: Waits, dollar: World, e: StopEvent) {
  const gate = mounted(WAITS.get(wait)).handlers['classic.Stop']
  return observing(dollar, async (seen, pass) => gate(seen, e, pass))
}

// A declaration through the tool, and its answer as it came.
const declare = async (wait: Waits, dollar: World, input: object) =>
  fieldsIn(await wait['tool.call'](dollar, { tool: `mcp__orchestrator__${WAIT_TOOL}`, ...input }, through))
const turnStarts = (wait: Waits, dollar: World) => wait['turn.start'](dollar, {}, through)
const NOTHING_RUNS = { background_tasks: [], session_crons: [] }

test('a declaration is validated: a known kind, and what it blocks where the kind needs it', () => {
  expect(parseDeclaration({ kind: 'operator', blocks: '  G3:\n the scope ' }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G3: the scope', asked: ['q-1'] } })
  expect(parseDeclaration({ kind: 'deferred', blocks: '2 items' })).toEqual({ wait: { kind: 'deferred', blocks: '2 items' } })
  expect(parseDeclaration({ kind: 'done', blocks: 'whatever' })).toEqual({ wait: { kind: 'done', blocks: '' } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: true }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G1', urgent: true, asked: ['q-1'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: false }, [{ id: 'q-1', blocks: 'x' }])).toEqual({ wait: { kind: 'operator', blocks: 'G1', asked: ['q-1'] } })
  for (const bad of [{}, { kind: 'later' }, { kind: 'operator' }, { kind: 'deferred', blocks: ' ' }, { kind: 'deferred', blocks: 3 }, { kind: 'deferred', blocks: 'x'.repeat(301) }, { kind: 'done', urgent: true }, { kind: 'operator', blocks: 'G1', urgent: 'yes' }]) {
    expect('error' in parseDeclaration(bad)).toBe(true)
  }
})

test('an operator wait carries no consent subject: consent rests on his quoted, dated words', () => {
  const asked = [{ id: 'q-1', blocks: 'x' }]
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', consent_kind: 'e2e-waiver', consent_repo: 'acme/thing', consent_pr: 12 }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', asked: ['q-1'] } })
})

test('the declare_wait tool is registered at every start, and refused to a subagent and on a bad input', async () => {
  const wait = waitMounted()
  const tools: ToolSpec[] = []
  const { dollar } = fakeDollar({})
  dollar.tool = { ...dollar.tool, register: async spec => { tools.push(spec) } }
  await wait['session.start'](dollar, { cwd: '/tmp/h/work/repo' }, through)
  expect(tools.map(t => [t.name, t.isDeferred])).toEqual([[WAIT_TOOL, false]])
  expect(propertyOf(tools[0], 'consent_kind')).toBe(undefined)
  expect((await declare(wait, dollar, { kind: 'done', agentId: 'a-1' })).isError).toBe(true)
  expect((await declare(wait, dollar, { kind: 'soon' })).isError).toBe(true)
  // Neither is a declaration.
  expect(WAITS.get(wait)?.current()).toBeNull()
})


test('a declared done is refused on the open rows, and taken once none is', async () => {
  const wait = waitMounted()
  // The declaration itself refuses a done while a row is open (wait.ts holdsRecord): the row here opens after it.
  const none = fakeDollar({})
  expect((await declare(wait, none.dollar, { kind: 'done' })).isError).toBeUndefined()
  const open = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open"}\n'] })
  expect(String((await declare(waitMounted(), open.dollar, { kind: 'done' })).result)).toContain('row r-12 (the report row) is open')
})

test('a successor that registered no record is held to the open rows of the record its orchestration owns', async () => {
  // Orch: Blitz's successor of 2026-11-18 (session 160a0bed) declared done at 13:01Z with 5 rows open: its own
  // registry was empty, the record registered by its predecessors alone, and the declaration did not read it.
  const rows = '{"id":"r-12","label":"the report row","state":"open"}\n'
  const taken = fakeDollar({ predecessor: { path: '/tmp/h/rec/blitz.jsonl', text: rows, owner: 'Orch: belt' } })
  expect(String((await declare(waitMounted(), taken.dollar, { kind: 'done' })).result)).toContain('row r-12 (the report row) is open')
  // A record another orchestration owns is not this one's to answer for.
  const foreign = fakeDollar({ predecessor: { path: '/tmp/h/rec/blitz.jsonl', text: rows, owner: 'Orch: other' } })
  expect((await declare(waitMounted(), foreign.dollar, { kind: 'done' })).isError).toBeUndefined()
})

test('a declared deferred wait is refused when nothing is deferred, and passes on the right count', async () => {
  const wait = waitMounted()
  // The declaration itself refuses a deferred wait when nothing is deferred (wait.ts holdsRecord): the ruling here goes after it.
  const none = fakeDollar({})
  expect(String((await declare(waitMounted(), none.dollar, { kind: 'deferred', blocks: '1 items' })).result)).toContain('Nothing is deferred')
  const put = fakeDollar({ records: ['{"id":"r-12","label":"the report row","state":"open","deferred":"later, 2026-11-08"}\n'] })
  expect((await declare(wait, put.dollar, { kind: 'deferred', blocks: '1 items' })).isError).toBeUndefined()
})

test('a wait declared in an earlier turn is stale and never read', async () => {
  const wait = waitMounted()
  const { dollar } = fakeDollar({})
  await declare(wait, dollar, { kind: 'done' })
  expect(WAITS.get(wait)?.current()).toEqual({ kind: 'done', blocks: '' })
  await turnStarts(wait, dollar)
  expect(WAITS.get(wait)?.current()).toBeNull()
  // A subagent's turn starting is not the session's: the declaration stands.
  await declare(wait, dollar, { kind: 'done' })
  await wait['turn.start'](dollar, { agentId: 'a-1' }, through)
  expect(WAITS.get(wait)?.current()).toEqual({ kind: 'done', blocks: '' })
})

test('the turn\'s end passes the answer on unchanged: its readers read the declaration itself', async () => {
  const wait = waitMounted()
  const { dollar } = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE }, records: [
    '{"id":"r-1","label":"one","state":"open","deferred":"later, 2026-11-08"}\n{"id":"r-2","label":"two","state":"open","deferred":"later, 2026-11-08"}\n',
  ] })
  expect((await declare(wait, dollar, { kind: 'deferred', blocks: '2 items' })).isError).toBeUndefined()
  let seen = ''
  const shown = await wait['turn.complete'](dollar, { reason: 'answer', answer: 'Watching.' }, async x => { seen = String(x.answer); return { text: x.answer } })
  expect(seen).toBe('Watching.')
  expect(shown).toEqual({ text: 'Watching.' })
})

// --- an agent's message to its orchestrator -------------------------------------------------

// Auto mode refuses a call whose input a hook changed after it judged it (« gave no verdict »), so
// no hook rewrites a SendMessage: the message goes as written, whatever its length or sender.
test("no hook is mounted on SendMessage: an agent's long message to its orchestrator goes as written", () => {
  const hooks = capture<World>(on => registerGuards(on, new Declarations()))
  expect(hooksOn(hooks, 'tool.call').filter(h => h.matcher?.['tool'] === 'SendMessage')).toEqual([])
})

// --- an operator wait waits on the questions asked with `ask` (hooks/wait.ts, hooks/guards.ts) ------------

test('an operator wait waits on the questions asked with ask: their blocks unless it names its own, none asked refused', () => {
  const asked = [{ id: 'q-1', blocks: 'the mode' }, { id: 'q-2', blocks: 'acme/app#1' }]
  expect(parseDeclaration({ kind: 'operator' }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'the mode; acme/app#1', asked: ['q-1', 'q-2'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', urgent: true }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', urgent: true, asked: ['q-1', 'q-2'] } })
  expect(parseDeclaration({ kind: 'operator', blocks: 'G1', question: ASKED }, asked)).toEqual({ wait: { kind: 'operator', blocks: 'G1', asked: ['q-1', 'q-2'] } })
  const none = parseDeclaration({ kind: 'operator', blocks: 'G1' }, [])
  expect('error' in none && none.error).toBe(ASK_FIRST)
  expect('error' in parseDeclaration({ kind: 'tool' }, asked)).toBe(true)
})

test('a turn that asked with ask and declared its wait without question passes the stop, first stop and re-fired alike', async () => {
  const wait = waitMounted()
  const fx = fakeDollar({ round: { 'q-a1b2c3-1.json': ASKED_HERE } })
  const declared = await declare(wait, fx.dollar, { kind: 'operator' })
  expect(declared).toEqual({ result: 'Wait declared: waiting: operator — blocks: the mode. End the turn now.' })
  const first = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'J\'attends votre choix.', ...NOTHING_RUNS }))
  expect(first.answer).toBe(first.passed)
  expect(first.observed).toBeUndefined()
  const refired = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'J\'attends toujours.', stop_hook_active: true, ...NOTHING_RUNS }))
  expect(refired.answer).toBe(refired.passed)
  expect(refired.observed).toBeUndefined()
  expect(fx.written.some(l => l.includes('an operator wait with no question'))).toBe(false)
  // With no question asked here, the same call is refused, as before.
  const bare = fakeDollar({})
  expect((await declare(waitMounted(), bare.dollar, { kind: 'operator', blocks: 'the mode' })).isError).toBe(true)
})

// A stop re-fired after another gate held it: this gate, which only observes, steps aside before
// reading anything, an operator wait with no question included; nothing is sent, nothing journalled.
const UNASKED = 'the report\n\nwaiting: operator — blocks: the mode'

test('a re-fired stop whose operator wait holds no question passes untouched, nothing read, nothing sent', async () => {
  const { handlers } = mounted(new Declarations())
  const fx = fakeDollar({})
  const sent: string[] = []
  fx.dollar.session.send = async ({ text }: { to: unknown; text: string }) => { sent.push(text); return { isDelivered: true } }
  await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: UNASKED }))
  const ran = fx.ran.length
  for (let i = 0; i < 3; i++) {
    const refired = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: UNASKED, stop_hook_active: true }))
    expect(refired.answer).toBe(refired.passed)
    expect(refired.observed).toBeUndefined()
  }
  expect(fx.ran.length).toBe(ran)
  expect(sent).toEqual([])
})

test('a re-fired stop the gate used to step aside from still does when nothing asks the operator, or the session is no orchestrator', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar({})
  const quiet = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: 'stopped.', stop_hook_active: true }))
  expect(quiet.answer).toBe(quiet.passed)
  expect(quiet.observed).toBeUndefined()
  const asked = await stop(handlers['classic.Stop'], fx.dollar, stopEvent({ last_assistant_message: `${ASKED}\nwaiting: operator — blocks: the mode`, stop_hook_active: true }))
  expect(asked.answer).toBe(asked.passed)
  expect(asked.observed).toBeUndefined()
  const coord = fakeDollar({ launchName: 'Coord: machine' })
  const relay = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: UNASKED, stop_hook_active: true }))
  expect(relay.answer).toBe(relay.passed)
  expect(relay.observed).toBeUndefined()
})

// --- the to-do list beside the record (todo.ts) -------------------------------------------------

const todoLine = (id: number, change: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, id, opened: '2026-11-14T15:00:00Z', label: `item ${id}`, state: 'open', verdict: '', words: `his words ${id}`, said_at: '2026-11-14T14:58:00Z', from: 'Coord: general', ...change,
}) + '\n'

test('a done ending is refused while a to-do is open, a deferred one while one he did not put off is, each named', () => {
  const held = checkWakeDone({ deferred: [], todos: ['3 (item 3)'] })!
  expect(held.case).toBe('not-done')
  expect(held.reason).toContain('to-do 3 (item 3) is open')
  expect(held.reason).toContain('todo done')
  const later = checkWakeDone({ deferred: [], todos: ['3 (item 3)'], ending: 'deferred' })!
  expect(later.reason).toContain('to-do 3 (item 3) is open')
  expect(checkWakeDone({ deferred: [] })).toBeNull()
})

test('a to-do he put off is deferred work: a done ending names the deferred line, the deferred ending counts it', () => {
  const left = { deferred: ['5 (a)'], deferredRows: ['5 (a)'], todosDeferred: ['3 (item 3)'] }
  expect(checkWakeDone(left)!.reason).toContain('to-do 3 (item 3)')
  expect(checkWakeDone(left)!.reason).toContain('deferred by the operator')
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '2 items' })).toBeNull()
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '5, T3' })).toBeNull()
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '1 items' })!.reason).toContain('the right count is 2 items')
  expect(checkWakeDone({ ...left, ending: 'deferred', ids: '5' })!.reason).toContain('missing to-do 3')
  expect(checkWakeDone({ ...left, deferred: [], deferredRows: [], ending: 'deferred', ids: '1 items' })).toBeNull()
})

test('the ids of a deferred ending accept the to-do form its refusal prints (to-do 3, todo 3, to-dos 3)', () => {
  const left = { deferred: ['5 (a)'], deferredRows: ['5 (a)'], todosDeferred: ['3 (item 3)'], ending: 'deferred' as const }
  expect(checkWakeDone({ ...left, ids: '5, to-do 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'row 5, to-do 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, todo 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, to-dos 3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5, T3' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: '5' })!.reason).toContain('missing to-do 3')
  expect(checkWakeDone({ ...left, ids: '5, to-do 9' })!.reason).toContain('unknown to-do 9')
  expect(checkWakeDone({ ...left, ids: 'to-do 3, row 5' })).toBeNull()
  expect(checkWakeDone({ ...left, ids: 'to-do 3, 5' })!.reason).toContain('unknown to-do 5')
})

test('a coordinator\'s stop is never held by its list: only its end command is', async () => {
  const { handlers } = mounted()
  const coord = fakeDollar({ launchName: 'Coord: machine', todos: todoLine(1) })
  const passed = await stop(handlers['classic.Stop'], coord.dollar, stopEvent({ last_assistant_message: 'Nothing more.' }))
  expect(passed.answer).toBe(passed.passed)
  expect(passed.observed).toBeUndefined()
})

// --- the waits the module reads itself: no declaration for them ------------------------------

// His ruling of 2026-11-14 (« on n'est plus obligé de déclarer l'attente d'un outil »): a command,
// a monitor, a subagent or an awaited agent of the session is read by the gate, so `declare_wait`
// is for a question to the operator or the ending alone.
test('declare_wait takes no tool wait: what the module reads in flight passes with nothing declared', async () => {
  expect(parseDeclaration({ kind: 'tool', blocks: 'the deploy run' })).toEqual({ error: 'kind is one of operator, done, deferred' })
  const wait = waitMounted()
  const tools: ToolSpec[] = []
  const fx = fakeDollar({})
  fx.dollar.tool = { ...fx.dollar.tool, register: async spec => { tools.push(spec) } }
  await wait['session.start'](fx.dollar, { cwd: '/tmp/h/work/repo' }, through)
  expect(propertyOf(tools[0], 'kind')?.['enum']).toEqual(['operator', 'done', 'deferred'])
  expect(tools[0]?.description).not.toContain('`tool`')
  const SUBAGENT = { id: 'a', type: 'subagent', status: 'running', description: 'search' }
  const MONITOR = { id: 'm', type: 'monitor', status: 'running', description: 'the deploy log' }
  for (const task of [SHELL_TASK, SUBAGENT, MONITOR]) {
    const out = await chainedStop(wait, fx.dollar, stopEvent({ last_assistant_message: 'Deploy started.', background_tasks: [task], session_crons: [] }))
    expect(out.answer).toBe(out.passed)
  expect(out.observed).toBeUndefined()
  }
  expect(fx.written.some(l => l.includes('| stop gate: warn') || l.includes('| stop gate: check1'))).toBe(false)
})
