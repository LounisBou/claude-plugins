// The orchestration arm's driver against a fake launcher and a scripted transcript: what it
// opens, when it decides the orchestration is over, what it counts, and that it closes the home
// and proves nothing is left. No host session is started.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Case } from './cases.ts'
import type { Meter } from './harness.ts'
import {
  benchLauncher,
  benchPathError,
  benchTitle,
  NO_OPERATOR,
  orchestrationAgent,
  METER_BLIND_MS,
  STARTUP_MS,
  startupPrompt,
  type BenchHome,
  type Launcher,
  type OpenRequest,
  type Pane,
} from './orchestration.ts'
import { WAIT_TOOL } from './transcript.ts'

const TASK: Case = { id: 'a-case', pr: 1, base: 'a'.repeat(40), merge: 'b'.repeat(40), plugin: 'demo', task: 'Make the value 2.' }
const HOME: BenchHome = { socket: 'orch-abc12345', tty: '/dev/ttys009', session: '11111111-2222-3333-4444-555555555555' }
const BENCH = '/b'
const GONE = 'closed 0 session(s): the home server orch-abc12345 is not running'

type Line = Record<string, unknown>
const prompt = (): Line => ({ type: 'user', message: { role: 'user', content: 'go' } })
const said = (text: string): Line => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
const declare = (kind: string, blocks = ''): Line => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: WAIT_TOOL, input: { kind, blocks } }] },
})
const result: Line = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }
const jsonl = (lines: readonly Line[]): string => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
const ended = (kind: string, blocks = '', say = 'Over.'): string => jsonl([prompt(), declare(kind, blocks), result, said(say)])

interface Fake extends Launcher {
  readonly opened: OpenRequest[]
  readonly closed: string[]
  panesSeen: number
}

/** A launcher whose panes and close answers are scripted; its home is gone after `closesToEnd` closes. */
function fakeLauncher(script: { panes?: (poll: number) => Pane[] | null; open?: () => Promise<BenchHome>; close?: (call: number) => string | Error; servers?: string[]; closesToEnd?: number } = {}): Fake {
  const fake: Fake = {
    opened: [],
    closed: [],
    panesSeen: 0,
    async open(request) {
      fake.opened.push(request)
      return script.open === undefined ? HOME : script.open()
    },
    async panes(bench, socket) {
      assert.equal(bench, BENCH, 'the panes are read in the arm’s bench')
      assert.equal(socket, HOME.socket, 'the panes are read on the home’s server')
      if (fake.closed.length >= (script.closesToEnd ?? 1)) return null
      return (script.panes ?? (() => [{ window: 0, id: '%0', tty: '/dev/ttys100' }]))(fake.panesSeen++)
    },
    async servers(bench) {
      assert.equal(bench, BENCH, 'the servers listed are the arm’s bench’s')
      return script.servers ?? []
    },
    async close(bench, socket) {
      assert.equal(bench, BENCH, 'the home is closed in the arm’s bench')
      fake.closed.push(socket)
      const answer = script.close === undefined ? 'closed 1 session(s)' : script.close(fake.closed.length)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return fake
}

/** A meter that reads what `reading` says on each read, counting the reads. */
function meterReading(reading: (read: number) => number): Meter & { reads: number } {
  const meter = {
    reads: 0,
    async start() {
      return { spent: async () => reading(meter.reads++) }
    },
  }
  return meter
}

function agent(launcher: Launcher, transcript: (poll: number) => string | null, now?: () => number, meter: Meter = meterReading(() => 1), ttys = new Set<string>()) {
  let poll = 0
  return orchestrationAgent({
    ...(now === undefined ? {} : { now }),
    meter,
    ttys,
    bench: BENCH,
    model: 'm',
    orchestratorDir: '/o',
    dependencyDirs: ['/d'],
    settingsFile: '/s.json',
    launcher,
    transcript: session => {
      assert.equal(session, HOME.session, 'the transcript read is the orchestrator session’s')
      return transcript(poll++)
    },
    pollMs: 5,
  })
}

const input = (signal = new AbortController().signal) => ({ case: TASK, arm: 'orchestration' as const, dir: '/b/work/a-case/orchestration', prompt: 'Brief.', budgetUsd: 8, signal })

describe('outcome evals: opening the orchestration', () => {
  it('opens the checkout’s orchestrator in the arm’s bench, with no operator to answer', async () => {
    const launcher = fakeLauncher()
    await agent(launcher, () => ended('done')).run(input())
    const [request] = launcher.opened
    assert.equal(request?.bench, '/b')
    assert.equal(request?.dir, '/b/work/a-case/orchestration')
    assert.equal(request?.title, 'Orch: eval a-case')
    assert.deepEqual(request?.pluginDirs, ['/o', '/d'])
    assert.equal(request?.settingsFile, '/s.json')
    assert.equal(request?.model, 'm')
    assert.ok(request?.prompt.startsWith('/orchestrator:orchestrator build\n'))
    assert.ok(request?.prompt.includes('Brief.'))
    assert.ok(request?.prompt.includes(NO_OPERATOR))
    assert.equal(startupPrompt('B'), `/orchestrator:orchestrator build\n\nB\n\n${NO_OPERATOR}`)
  })

  it('tells the orchestrator to keep its agents writing in the graded checkout, one at a time', () => {
    assert.ok(NO_OPERATOR.includes('spawn every agent with `--dir` set to this checkout'))
    assert.ok(NO_OPERATOR.includes('never through `workspace.sh create`'))
    assert.ok(NO_OPERATOR.includes('one agent writing at a time'))
  })

  it('names the session after the case, cut to what a session name holds', () => {
    assert.equal(benchTitle('a-case'), 'Orch: eval a-case')
    const long = benchTitle('github-auto-merge-list-under-a-lock')
    assert.equal(long, 'Orch: eval github-auto-merge-li')
    assert.ok(long.length <= 'Orch: '.length + 25)
    assert.equal(benchTitle('x'.repeat(19) + ' y'), `Orch: eval ${'x'.repeat(19)}`)
  })

  it('refuses a bench whose socket would not fit an address, before any arm', () => {
    assert.equal(benchPathError('/tmp/oc1', 501, '/Users/me'), null)
    assert.match(benchPathError('/tmp', 501, '/Users/me') ?? '', /two levels/)
    assert.match(benchPathError('/Users/me', 501, '/Users/me') ?? '', /home directory/)
    assert.match(benchPathError('/Users', 501, '/Users/me') ?? '', /two levels/)
    assert.match(benchPathError('/Users/me/', 501, '/Users/me') ?? '', /home directory/)
    assert.match(benchPathError(`/tmp/${'x'.repeat(80)}`, 501, '/Users/me') ?? '', /too long for a socket's address/)
    assert.match(benchPathError('relative', 501, '/Users/me') ?? '', /absolute/)
  })

  it('reports a launcher that refuses to open, and closes nothing', async () => {
    const launcher = fakeLauncher({ open: async () => { throw new Error('bench-open: refused: x') } })
    const run = await agent(launcher, () => null).run(input())
    assert.deepEqual(run, { costUsd: null, error: 'could not open the orchestrator: bench-open: refused: x' })
    assert.deepEqual(launcher.closed, [])
  })

  it('closes a home the launcher left half made when it failed to open', async () => {
    const launcher = fakeLauncher({ open: async () => { throw new Error('timed out') }, servers: ['orch-half1', 'orch-half2'], close: () => GONE })
    const run = await agent(launcher, () => null).run(input())
    assert.deepEqual(launcher.closed, ['orch-half1', 'orch-half2'])
    assert.equal(run.error, 'could not open the orchestrator: timed out')
    const refused = fakeLauncher({ open: async () => { throw new Error('timed out') }, servers: ['orch-half1'], close: () => new Error('busy') })
    assert.equal((await agent(refused, () => null).run(input())).error, 'could not open the orchestrator: timed out; could not close the home orch-half1: busy')
  })
})

describe('outcome evals: deciding the orchestration is over', () => {
  it('ends on a turn that declared done, read on two polls in a row', async () => {
    const launcher = fakeLauncher()
    const polls: number[] = []
    const run = await agent(launcher, poll => (polls.push(poll), ended('done'))).run(input())
    assert.equal(run.error, null)
    assert.deepEqual(run.orchestration, { agentsOpened: 0, decisions: [], askedOperator: null })
    assert.deepEqual(polls, [0, 1])
  })

  it('does not end on a done that the next poll finds taken back', async () => {
    const working = jsonl([prompt(), declare('done'), result, said('Over.'), { type: 'user', message: { role: 'user', content: 'an agent reported' } }])
    const texts = [ended('done'), working, working, ended('done', '', 'Really over.'), ended('done', '', 'Really over.')]
    let last = 0
    const run = await agent(fakeLauncher(), poll => (last = poll, texts[Math.min(poll, texts.length - 1)] ?? null)).run(input())
    assert.equal(run.error, null)
    assert.equal(last, 4)
  })

  it('ends on a turn waiting on the operator, with the question', async () => {
    const run = await agent(fakeLauncher(), () => ended('operator', 'which name?')).run(input())
    assert.deepEqual(run.orchestration, { agentsOpened: 0, decisions: [], askedOperator: 'which name?' })
  })

  it("reports the question the operator wait carries in place of what it blocks", async () => {
    const asking = jsonl([prompt(), { ...declare('operator', 'the name'), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: WAIT_TOOL, input: { kind: 'operator', blocks: 'the name', question: '**Question 1 of 1**' } }] } }, result, said('Over.')])
    const run = await agent(fakeLauncher(), () => asking).run(input())
    assert.equal(run.orchestration?.askedOperator, '**Question 1 of 1**')
  })

  it('keeps waiting through turns that wait on a tool or declare nothing', async () => {
    const quiet = jsonl([prompt(), said('Spawned.')])
    const watching = ended('tool', 'a monitor')
    let last = 0
    const run = await agent(fakeLauncher(), poll => (last = poll, poll < 3 ? quiet : poll < 6 ? watching : ended('done'))).run(input())
    assert.equal(run.error, null)
    assert.ok(last >= 7)
  })

  it('counts every agent window the home held, those closed since included, and the decisions', async () => {
    const panes: Record<number, Pane[]> = {
      0: [{ window: 0, id: '%0', tty: '/dev/ttys100' }],
      1: [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }],
      2: [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }, { window: 2, id: '%2', tty: '/dev/ttys102' }],
      3: [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%5', tty: '/dev/ttys105' }],
    }
    const launcher = fakeLauncher({ panes: poll => panes[Math.min(poll, 3)] ?? null })
    const text = jsonl([prompt(), said('Decision: model → sonnet'), declare('done'), result, said('Over.')])
    const run = await agent(launcher, poll => (poll < 3 ? jsonl([prompt(), said('Decision: model → sonnet')]) : text)).run(input())
    assert.deepEqual(run.orchestration, { agentsOpened: 3, decisions: ['model → sonnet'], askedOperator: null })
  })

  it('stops with the arm when it is aborted, and still reports what it counted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cap')), 40)
    const launcher = fakeLauncher({ panes: () => [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }] })
    const run = await agent(launcher, () => jsonl([prompt(), said('Working.')])).run(input(controller.signal))
    assert.equal(run.error, null)
    assert.equal(run.orchestration?.agentsOpened, 1)
    assert.equal(launcher.closed.length, 1)
  })

  it('reports an orchestrator whose home ended before it was over', async () => {
    const launcher = fakeLauncher({ panes: poll => (poll < 2 ? [{ window: 0, id: '%0', tty: '/dev/ttys100' }] : null) })
    const run = await agent(launcher, () => jsonl([prompt(), said('Working.')])).run(input())
    assert.match(run.error ?? '', /home ended before the orchestration was over/)
    assert.equal(launcher.closed.length, 1)
  })

  it('goes on through a failed read of the home, followed by good ones', async () => {
    const home = (poll: number): Pane[] | null => {
      if (poll === 1) return null
      if (poll === 3) throw new Error('tmux timed out')
      return [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }]
    }
    const launcher = fakeLauncher({ panes: home })
    const run = await agent(launcher, poll => (poll < 6 ? jsonl([prompt(), said('Working.')]) : ended('done'))).run(input())
    assert.equal(run.error, null)
    assert.equal(run.orchestration?.agentsOpened, 1)
  })

  it('ends on three failed reads of the home in a row', async () => {
    const reads = [true, false, false, true, false, false, false]
    const launcher = fakeLauncher({ panes: poll => (reads[poll] === true ? [{ window: 0, id: '%0', tty: '/dev/ttys100' }] : null) })
    let last = 0
    const run = await agent(launcher, poll => (last = poll, jsonl([prompt(), said('Working.')]))).run(input())
    assert.match(run.error ?? '', /home ended before the orchestration was over/)
    assert.equal(last, 6)
    const throwing = fakeLauncher({ panes: () => { throw new Error('tmux timed out') } })
    const failed = await agent(throwing, () => jsonl([prompt(), said('Working.')])).run(input())
    assert.match(failed.error ?? '', /could not be followed: tmux timed out/)
  })

  it('ends an orchestrator that never declared a wait nor opened an agent, as not graded', async () => {
    const minutes = (): (() => number) => {
      let calls = 0
      return () => calls++ * 60_000
    }
    const launcher = fakeLauncher()
    let last = 0
    const run = await agent(launcher, poll => (last = poll, jsonl([prompt(), said('Unknown skill.')])), minutes()).run(input())
    assert.equal(run.error, null)
    assert.equal(run.orchestration?.notGraded, 'the orchestrator did not start')
    assert.ok(last >= STARTUP_MS / 60_000 - 2 && last <= STARTUP_MS / 60_000 + 1, `ended at poll ${last}`)
    assert.ok(launcher.closed.length >= 1)
    // one that declared a wait, or opened an agent, has started
    const waiting = await agent(fakeLauncher(), poll => (poll < 20 ? ended('tool', 'a monitor') : ended('done')), minutes()).run(input())
    assert.equal(waiting.orchestration?.notGraded, undefined)
    const spawned = fakeLauncher({ panes: () => [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }] })
    const working = await agent(spawned, poll => (poll < 20 ? jsonl([prompt(), said('Working.')]) : ended('done')), minutes()).run(input())
    assert.equal(working.orchestration?.notGraded, undefined)
  })

  it('gives the meter the terminals of every pane the home held', async () => {
    const ttys = new Set<string>(['/dev/ttys999'])
    const panes = [[{ window: 0, id: '%0', tty: '/dev/ttys100' }], [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }], [{ window: 0, id: '%0', tty: '/dev/ttys100' }]]
    const launcher = fakeLauncher({ panes: poll => panes[Math.min(poll, 2)] ?? null })
    await agent(launcher, poll => (poll < 3 ? jsonl([prompt(), said('Working.')]) : ended('done')), undefined, undefined, ttys).run(input())
    assert.deepEqual([...ttys].sort(), ['/dev/ttys009', '/dev/ttys100', '/dev/ttys101'])
  })

  it('ends an arm whose meter still reads nothing once its agents have worked a while, as not graded', async () => {
    const minutes = (): (() => number) => {
      let calls = 0
      return () => calls++ * 60_000
    }
    const spawned = (): Launcher => fakeLauncher({ panes: () => [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%1', tty: '/dev/ttys101' }] })
    const blind = meterReading(() => 0)
    const launcher = spawned()
    let last = 0
    const run = await agent(launcher, poll => (last = poll, jsonl([prompt(), said('Working.')])), minutes(), blind).run(input())
    assert.equal(run.orchestration?.notGraded, 'the meter cannot see the bench')
    assert.ok(blind.reads >= 1)
    assert.ok(last <= METER_BLIND_MS / 60_000 + 1, `ended at poll ${last}`)
    assert.ok((launcher as Fake).closed.length >= 1)
    // a meter that reads a spend lets the arm go on, and is read once
    const seeing = meterReading(() => 0.5)
    const metered = await agent(spawned(), poll => (poll < 30 ? jsonl([prompt(), said('Working.')]) : ended('done')), minutes(), seeing).run(input())
    assert.equal(metered.orchestration?.notGraded, undefined)
    assert.equal(metered.error, null)
    assert.equal(seeing.reads, 1)
  })

  it('closes the home even when reading the transcript fails', async () => {
    const launcher = fakeLauncher()
    const run = await agent(launcher, () => { throw new Error('unreadable') }).run(input())
    assert.match(run.error ?? '', /unreadable/)
    assert.equal(launcher.closed.length, 1)
  })
})

describe('outcome evals: closing the orchestration', () => {
  it('closes the home once when its server then reads gone', async () => {
    const launcher = fakeLauncher()
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.deepEqual(launcher.closed, ['orch-abc12345'])
    assert.equal(run.error, null)
  })

  it('closes the home a second time when the first close left it running', async () => {
    const launcher = fakeLauncher({ closesToEnd: 2 })
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.deepEqual(launcher.closed, ['orch-abc12345', 'orch-abc12345'])
    assert.equal(run.error, null)
  })

  it('reports sessions left running after the second close, with the panes left', async () => {
    const launcher = fakeLauncher({ closesToEnd: Infinity, panes: () => [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 2, id: '%2', tty: '/dev/ttys102' }] })
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.equal(launcher.closed.length, 2)
    assert.match(run.error ?? '', /sessions are left open: 2 pane\(s\) of the home server orch-abc12345/)
    assert.equal(run.orchestration?.askedOperator, null)
  })

  it('reports a close the launcher refused', async () => {
    const launcher = fakeLauncher({ close: () => new Error('close: the home server cannot be listed') })
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.match(run.error ?? '', /could not close the home: close: the home server cannot be listed/)
    assert.equal(launcher.closed.length, 1)
  })
})

describe('outcome evals: the launcher on the checkout', () => {
  /** A stand-in for the launcher script and for tmux, recording how each is called. */
  function fakeBinaries(): { dir: string; log: string; launcher: Launcher } {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-launcher-'))
    const scripts = join(dir, 'orchestrator', 'skills', 'iterm-agents', 'scripts')
    const log = join(dir, 'log')
    const run = (path: string, body: string): void => {
      writeFileSync(path, `#!/bin/bash\nprintf '%s|TRUST=%s|TMUX=%s\\n' "$*" "$ORCHESTRATOR_TRUST_FILE" "$TMUX_TMPDIR" >> '${log}'\n${body}\n`)
      chmodSync(path, 0o755)
    }
    mkdirSync(scripts, { recursive: true })
    run(join(scripts, 'iterm-agent.sh'), 'case "$1" in bench-open) printf "socket=orch-abc12345\\ntty=/dev/ttys009\\nsession=%s\\n" 11111111-2222-3333-4444-555555555555;; close) echo "closed 0 session(s): the home server orch-abc12345 is not running";; esac')
    run(join(dir, 'tmux'), 'printf "0 %%0 /dev/ttys100\\n1 %%7 /dev/ttys107\\nbad\\n"')
    const launcher = benchLauncher({ orchestratorDir: join(dir, 'orchestrator'), tmux: join(dir, 'tmux'), env: { PATH: '/usr/bin:/bin' } })
    return { dir, log, launcher }
  }

  it('opens a bench orchestrator, reads its panes and closes it, through the checkout’s own launcher', async () => {
    const { dir, log, launcher } = fakeBinaries()
    const bench = join(dir, 'bench')
    const home = await launcher.open({ bench, dir: join(bench, 'work'), title: 'Orch: eval x', pluginDirs: ['/o', '/d'], settingsFile: '/s.json', prompt: 'p', model: 'm' })
    assert.deepEqual(home, HOME)
    assert.deepEqual(await launcher.panes(bench, home.socket), [{ window: 0, id: '%0', tty: '/dev/ttys100' }, { window: 1, id: '%7', tty: '/dev/ttys107' }])
    assert.equal(await launcher.close(bench, home.socket), GONE)
    const [open, panes, close] = readFileSync(log, 'utf8').trim().split('\n')
    assert.match(open ?? '', /^bench-open --bench .*bench --dir .*work --title Orch: eval x --plugin-dir \/o --plugin-dir \/d --settings \/s\.json --prompt-file \S+prompt\.txt --model m --trust\|/)
    assert.match(panes ?? '', /^-L orch-abc12345 list-panes -a -F #\{window_index\} #\{pane_id\} #\{pane_tty\}\|.*\|TMUX=.*bench\/tmux$/)
    assert.match(close ?? '', /^close --bench .*bench --socket orch-abc12345\|/)
    assert.equal(readFileSync(/--prompt-file (\S+) /u.exec(open ?? '')?.[1] ?? '', 'utf8'), 'p')
  })

  it('leaves the trust record to the launcher’s own ladder, where the host reads it', async () => {
    const { dir, log, launcher } = fakeBinaries()
    const bench = join(dir, 'bench')
    await launcher.open({ bench, dir: bench, title: 't', pluginDirs: ['/o'], settingsFile: '/s', prompt: 'p', model: 'm' })
    assert.match(readFileSync(log, 'utf8'), /^bench-open .*--trust\|TRUST=\|/)
  })

  it('lists the home servers of the bench, and nothing else', async () => {
    const { dir, launcher } = fakeBinaries()
    const bench = join(dir, 'bench')
    assert.deepEqual(await launcher.servers(bench), [])
    mkdirSync(join(bench, 'tmux', 'tmux-501'), { recursive: true })
    for (const name of ['orch-abc12345', 'default', 'orch-toolongname']) writeFileSync(join(bench, 'tmux', 'tmux-501', name), '')
    assert.deepEqual(await launcher.servers(bench), ['orch-abc12345'])
  })

  it('refuses a launcher answer that names no home, and a socket that is not one the launcher makes', async () => {
    const { dir, launcher } = fakeBinaries()
    writeFileSync(join(dir, 'orchestrator', 'skills', 'iterm-agents', 'scripts', 'iterm-agent.sh'), '#!/bin/bash\necho nothing\n')
    const bench = join(dir, 'bench')
    await assert.rejects(launcher.open({ bench, dir: bench, title: 't', pluginDirs: ['/o'], settingsFile: '/s', prompt: 'p', model: 'm' }), /printed no socket, tty and session/)
    await assert.rejects(launcher.close(bench, 'not-a-socket'), /not a home server/)
    assert.equal(await launcher.panes(bench, 'not-a-socket'), null)
  })
})
