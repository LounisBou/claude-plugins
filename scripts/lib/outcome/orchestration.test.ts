// The orchestration arm's driver against a fake launcher and a scripted transcript: what it
// opens, when it decides the orchestration is over, what it counts, and that it closes the home
// and proves nothing is left. No host session is started.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Case } from './cases.ts'
import {
  benchLauncher,
  benchPathError,
  benchTitle,
  NO_OPERATOR,
  orchestrationAgent,
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

/** A launcher whose panes and close answers are scripted. */
function fakeLauncher(script: { panes?: (poll: number) => Pane[] | null; open?: () => Promise<BenchHome>; close?: (call: number) => string | Error } = {}): Fake {
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
      return (script.panes ?? (() => [{ window: 0, id: '%0' }]))(fake.panesSeen++)
    },
    async close(bench, socket) {
      assert.equal(bench, BENCH, 'the home is closed in the arm’s bench')
      fake.closed.push(socket)
      const answer = script.close === undefined ? (fake.closed.length === 1 ? 'closed 1 session(s)' : GONE) : script.close(fake.closed.length)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return fake
}

function agent(launcher: Launcher, transcript: (poll: number) => string | null) {
  let poll = 0
  return orchestrationAgent({
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
    assert.equal(request?.title, 'Orch : eval a-case')
    assert.deepEqual(request?.pluginDirs, ['/o', '/d'])
    assert.equal(request?.settingsFile, '/s.json')
    assert.equal(request?.model, 'm')
    assert.ok(request?.prompt.startsWith('/orchestrator:orchestrator build\n'))
    assert.ok(request?.prompt.includes('Brief.'))
    assert.ok(request?.prompt.includes(NO_OPERATOR))
    assert.equal(startupPrompt('B'), `/orchestrator:orchestrator build\n\nB\n\n${NO_OPERATOR}`)
  })

  it('names the session after the case, cut to what a session name holds', () => {
    assert.equal(benchTitle('a-case'), 'Orch : eval a-case')
    const long = benchTitle('github-auto-merge-list-under-a-lock')
    assert.equal(long, 'Orch : eval github-auto-merge-li')
    assert.ok(long.length <= 'Orch : '.length + 25)
    assert.equal(benchTitle('x'.repeat(19) + ' y'), `Orch : eval ${'x'.repeat(19)}`)
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
      0: [{ window: 0, id: '%0' }],
      1: [{ window: 0, id: '%0' }, { window: 1, id: '%1' }],
      2: [{ window: 0, id: '%0' }, { window: 1, id: '%1' }, { window: 2, id: '%2' }],
      3: [{ window: 0, id: '%0' }, { window: 1, id: '%5' }],
    }
    const launcher = fakeLauncher({ panes: poll => panes[Math.min(poll, 3)] ?? null })
    const text = jsonl([prompt(), said('Decision: model → sonnet'), declare('done'), result, said('Over.')])
    const run = await agent(launcher, poll => (poll < 3 ? jsonl([prompt(), said('Decision: model → sonnet')]) : text)).run(input())
    assert.deepEqual(run.orchestration, { agentsOpened: 3, decisions: ['model → sonnet'], askedOperator: null })
  })

  it('stops with the arm when it is aborted, and still reports what it counted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cap')), 40)
    const launcher = fakeLauncher({ panes: () => [{ window: 0, id: '%0' }, { window: 1, id: '%1' }] })
    const run = await agent(launcher, () => jsonl([prompt(), said('Working.')])).run(input(controller.signal))
    assert.equal(run.error, null)
    assert.equal(run.orchestration?.agentsOpened, 1)
    assert.equal(launcher.closed.length, 2)
  })

  it('reports an orchestrator whose home ended before it was over', async () => {
    const launcher = fakeLauncher({ panes: poll => (poll < 2 ? [{ window: 0, id: '%0' }] : null) })
    const run = await agent(launcher, () => jsonl([prompt(), said('Working.')])).run(input())
    assert.match(run.error ?? '', /home ended before the orchestration was over/)
    assert.equal(launcher.closed.length, 2)
  })

  it('closes the home even when reading the transcript fails', async () => {
    const launcher = fakeLauncher()
    const run = await agent(launcher, () => { throw new Error('unreadable') }).run(input())
    assert.match(run.error ?? '', /unreadable/)
    assert.equal(launcher.closed.length, 2)
  })
})

describe('outcome evals: closing the orchestration', () => {
  it('closes the home, then asks again and finds none left', async () => {
    const launcher = fakeLauncher()
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.deepEqual(launcher.closed, ['orch-abc12345', 'orch-abc12345'])
    assert.equal(run.error, null)
  })

  it('reports sessions left running after the close', async () => {
    const launcher = fakeLauncher({ close: () => 'closed 2 session(s) of the home server orch-abc12345' })
    const run = await agent(launcher, () => ended('done')).run(input())
    assert.match(run.error ?? '', /sessions are left open: closed 2 session\(s\)/)
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
    run(join(dir, 'tmux'), 'printf "0 %%0\\n1 %%7\\nbad\\n"')
    const launcher = benchLauncher({ orchestratorDir: join(dir, 'orchestrator'), tmux: join(dir, 'tmux'), env: { PATH: '/usr/bin:/bin' } })
    return { dir, log, launcher }
  }

  it('opens a bench orchestrator, reads its panes and closes it, through the checkout’s own launcher', async () => {
    const { dir, log, launcher } = fakeBinaries()
    const bench = join(dir, 'bench')
    const home = await launcher.open({ bench, dir: join(bench, 'work'), title: 'Orch : eval x', pluginDirs: ['/o', '/d'], settingsFile: '/s.json', prompt: 'p', model: 'm' })
    assert.deepEqual(home, HOME)
    assert.deepEqual(await launcher.panes(bench, home.socket), [{ window: 0, id: '%0' }, { window: 1, id: '%7' }])
    assert.equal(await launcher.close(bench, home.socket), GONE)
    const [open, panes, close] = readFileSync(log, 'utf8').trim().split('\n')
    assert.match(open ?? '', /^bench-open --bench .*bench --dir .*work --title Orch : eval x --plugin-dir \/o --plugin-dir \/d --settings \/s\.json --prompt-file \S+prompt\.txt --model m --trust\|/)
    assert.match(panes ?? '', /^-L orch-abc12345 list-panes -a -F #\{window_index\} #\{pane_id\}\|.*\|TMUX=.*bench\/tmux$/)
    assert.match(close ?? '', /^close --bench .*bench --socket orch-abc12345\|/)
    assert.equal(readFileSync(/--prompt-file (\S+) /u.exec(open ?? '')?.[1] ?? '', 'utf8'), 'p')
  })

  it('leaves the trust record to the launcher’s own ladder, where the host reads it', async () => {
    const { dir, log, launcher } = fakeBinaries()
    const bench = join(dir, 'bench')
    await launcher.open({ bench, dir: bench, title: 't', pluginDirs: ['/o'], settingsFile: '/s', prompt: 'p', model: 'm' })
    assert.match(readFileSync(log, 'utf8'), /^bench-open .*--trust\|TRUST=\|/)
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
