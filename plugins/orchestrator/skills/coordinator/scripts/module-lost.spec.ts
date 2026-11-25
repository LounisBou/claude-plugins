import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { RunResult } from './context.ts'
import type { Session } from './facts.ts'
import { fixture, type Fixture } from './fixture.ts'
import { main } from './coordinator.ts'
import { lostModuleLines, moduleLost } from './module-lost.ts'

const line = (attachment: object, extra: object = {}): string => JSON.stringify({ type: 'attachment', ...extra, attachment })
const told = (added: readonly string[], removed: readonly string[] = []): string =>
  line({ type: 'mcp_instructions_delta', addedNames: added, removedNames: removed })
const connecting = (...pending: string[]): string => line({ type: 'deferred_tools_delta', addedNames: [], pendingMcpServers: pending })

// What a transcript holds once the host has unloaded the module: every plugin's tools leave, the
// others are connecting again and come back, the module neither.
const born = [connecting(), told(['context7', 'github', 'orchestrator'])]
const dropped = [connecting('github'), told([], ['github', 'orchestrator'])]
const back = [connecting(), told(['github'])]
const transcript = (...parts: readonly string[][]): string => parts.flat().join('\n') + '\n'

const AT = Date.parse('2026-11-25T14:00:00.000Z')
/** A model call's row, `minutes` after AT. */
const call = (minutes: number, model = 'm', isSidechain = false): string =>
  JSON.stringify({ type: 'assistant', isSidechain, timestamp: new Date(AT + minutes * 60_000).toISOString(), message: { model } })

describe('moduleLost', () => {
  it('names a transcript whose module left and never came back', () => {
    assert.equal(moduleLost(transcript(born, dropped, back)), true)
  })

  it('says nothing of a transcript whose module is announced, or came back', () => {
    assert.equal(moduleLost(transcript(born)), false)
    assert.equal(moduleLost(transcript(born, dropped, back, [told(['orchestrator'])])), false)
  })

  it('says nothing while the module is among the ones still connecting', () => {
    assert.equal(moduleLost(transcript(born, [connecting('github', 'orchestrator'), told([], ['github', 'orchestrator'])])), false)
  })

  it('names a session born without the module', () => {
    assert.equal(moduleLost(transcript([connecting(), told(['context7', 'github'])])), true)
  })

  it('says nothing of a transcript with no announcement, whatever its text quotes', () => {
    const quoted = JSON.stringify({ type: 'user', message: { content: told([], ['orchestrator']) } })
    assert.equal(moduleLost(''), false)
    assert.equal(moduleLost(`not json "mcp_instructions_delta"\n${quoted}\n`), false)
    assert.equal(moduleLost(line({ type: 'mcp_instructions_delta', removedNames: ['orchestrator'] }, { isSidechain: true })), false)
  })
})

const session = (pid: string, title: string, config = ''): Session =>
  ({ pid, tty: `ttys${pid}`, title, orch: 'unknown', repo: '-', branch: '-', top: '-', why: '-', plan: 'plan1', config })

/** The host's record of a live session and its transcript, under a configuration directory. */
function record(config: string, pid: string, name: string, text: string | null, startedAt?: number, id = `id-${pid}`): void {
  mkdirSync(join(config, 'sessions'), { recursive: true })
  writeFileSync(join(config, 'sessions', `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: id, name, startedAt }))
  if (text === null) return
  mkdirSync(join(config, 'projects', '-p'), { recursive: true })
  writeFileSync(join(config, 'projects', '-p', `${id}.jsonl`), text)
}

/** The line the launcher's `resume-line` prints for a pid. */
const launch = (pid: string): string => `cd /w && exec env ORCHESTRATOR_SPAWNED=1 hostcli --resume id-${pid} --name n`
const resumeLine = (args: readonly string[]): RunResult => ({ status: 0, stdout: `${launch(args[args.indexOf('--pid') + 1] ?? '')}\n`, stderr: '' })

function home(run: (args: readonly string[]) => RunResult = resumeLine): { f: Fixture; config: string } {
  const base = fixture()
  const f = fixture({ env: { HOME: base.root }, run: (_command, args) => run(args) })
  return { f, config: join(base.root, '.claude') }
}

const lost = transcript(born, dropped, back)
const said = (pid: string, name: string): string =>
  `module-lost ${name} | session id-${pid} | pid ${pid} | ttys${pid} | its orchestrator module is not loaded: tell the operator; cure: end it, then run: ${launch(pid)}`

describe('lostModuleLines', () => {
  it('names a live Coord, Orch or Audit session whose module is absent, and no other', () => {
    const { f, config } = home()
    record(config, '1', 'Coord: general', lost)
    record(config, '2', 'Orch: b', lost)
    record(config, '3', 'Audit: c', lost)
    record(config, '4', 'Orch: fine', transcript(born))
    record(config, '5', 'Agent: d', lost)
    record(config, '6', 'a plain tab', lost)
    const unread: string[] = []
    const sessions = ['1', '2', '3', '4', '5', '6'].map(pid => session(pid, '-'))
    assert.deepEqual(lostModuleLines(f.ctx, sessions, unread), [said('1', 'Coord: general'), said('2', 'Orch: b'), said('3', 'Audit: c')])
    assert.deepEqual(unread, [])
  })

  it("reads each session under its own configuration directory, and takes the launch's title when the record names none", () => {
    const { f, config } = home()
    const other = `${config}-bis`
    record(other, '7', '', lost)
    assert.deepEqual(lostModuleLines(f.ctx, [session('7', 'Orch: e', other)], []), [said('7', 'Orch: e')])
  })

  it('says nothing of a session with no record or no transcript yet', () => {
    const { f, config } = home()
    record(config, '8', 'Orch: new', null)
    const unread: string[] = []
    assert.deepEqual(lostModuleLines(f.ctx, [session('8', '-'), session('9', 'Orch: unrecorded')], unread), [])
    assert.deepEqual(unread, [])
  })

  it("asks the launcher for the launch line of each lost session, and of no other", () => {
    const { f, config } = home()
    record(config, '1', 'Orch: lost', lost)
    record(config, '2', 'Orch: fine', transcript(born))
    lostModuleLines(f.ctx, [session('1', '-'), session('2', '-')], [])
    const launcher = join(f.ctx.here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh')
    assert.deepEqual(f.runs, [['bash', launcher, 'resume-line', '--pid', '1']])
  })

  it('says why when the launcher gives no line, and that the options of the launch are needed', () => {
    const { f, config } = home(() => ({ status: 1, stdout: '', stderr: 'ERROR: resume-line: no environment\n' }))
    record(config, '1', 'Orch: lost', lost)
    assert.deepEqual(lostModuleLines(f.ctx, [session('1', '-')], []), [
      'module-lost Orch: lost | session id-1 | pid 1 | ttys1 | its orchestrator module is not loaded: tell the operator; cure: end it, then resume it from its directory with --resume id-1 and the options it was started with (its launch line cannot be read: resume-line: no environment)',
    ])
  })

  it('says nothing of a resumed process until it calls the model, then names it if the module is still absent', () => {
    const { f, config } = home()
    const lines = (...after: readonly string[]): string[] => {
      record(config, '11', 'Orch: g', lost + transcript([call(1), ...after]), AT + 2 * 60_000)
      return lostModuleLines(f.ctx, [session('11', '-')], [])
    }
    assert.deepEqual(lines(), [])
    // Neither a subagent's call nor a row the host writes itself is a call of this process.
    assert.deepEqual(lines(call(3, 'm', true), call(3, '<synthetic>'), '{"type":"user","text":"assistant"}'), [])
    assert.deepEqual(lines(call(3)), [said('11', 'Orch: g')])
  })

  it('says a transcript it cannot read as unread', () => {
    const { f, config } = home()
    record(config, '10', 'Orch: f', null)
    mkdirSync(join(config, 'projects', '-p', 'id-10.jsonl'), { recursive: true })
    const unread: string[] = []
    assert.deepEqual(lostModuleLines(f.ctx, [session('10', '-')], unread), [])
    assert.deepEqual(unread, [`module of session 10: ${join(config, 'projects', '-p', 'id-10.jsonl')} cannot be read`])
  })
})

describe('facts and check', () => {
  /** A coordinator's context over one live host session, `Coord: general`, on pid 20. */
  function machine(): { f: Fixture; config: string; root: string } {
    const base = fixture()
    const root = base.root
    writeFileSync(join(root, 'ps'), '20 1 ttys20 /usr/bin/hostcli --name Coord: general --remote-control x\n')
    writeFileSync(join(root, 'cwds'), `20 ${root}\n`)
    const f = fixture({
      env: { HOME: root, ORCHESTRATOR_HOST_CLI: 'hostcli', ORCHESTRATOR_MODULE_DIR: join(root, 'module'), COORDINATOR_PS_TABLE: join(root, 'ps'), COORDINATOR_CWDS: join(root, 'cwds') },
      run: (command, args) => command === 'git'
        ? { status: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : args.includes('resume-line') ? resumeLine(args) : { status: 0, stdout: '', stderr: '' },
    })
    return { f, config: join(root, '.claude'), root }
  }
  const lines = (f: Fixture): string[] => f.out.splice(0).filter(l => l.startsWith('module-lost '))
  const named = said('20', 'Coord: general')

  it('facts names the lost module, and check tells it once', () => {
    const { f, config } = machine()
    record(config, '20', 'Coord: general', transcript(born))
    main(f.ctx, ['check'])
    assert.deepEqual(lines(f), [])
    record(config, '20', 'Coord: general', lost)
    main(f.ctx, ['facts'])
    assert.deepEqual(lines(f), [named])
    main(f.ctx, ['check'])
    assert.deepEqual(lines(f), [named])
    main(f.ctx, ['check'])
    assert.deepEqual(lines(f), [])
  })

  it('check says nothing of a cured session, resumed under a new pid, before its first call', () => {
    const { f, config, root } = machine()
    record(config, '20', 'Coord: general', lost + transcript([call(1)]), AT)
    main(f.ctx, ['check'])
    assert.deepEqual(lines(f), [named])
    writeFileSync(join(root, 'ps'), '77 1 ttys20 /usr/bin/hostcli --name Coord: general --remote-control x\n')
    writeFileSync(join(root, 'cwds'), `77 ${root}\n`)
    record(config, '77', 'Coord: general', lost + transcript([call(1)]), AT + 2 * 60_000, 'id-20')
    main(f.ctx, ['check'])
    assert.deepEqual(lines(f), [])
  })

  it('the first check, which reports no other finding, tells a module already lost', () => {
    const { f, config } = machine()
    record(config, '20', 'Coord: general', lost)
    main(f.ctx, ['check'])
    assert.deepEqual(f.out, [named])
  })
})
