import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, type Fixture } from './fixture.ts'
import { isSleeperName, sleepingLine } from './sleeping.ts'

function project(f: Fixture): { brief: string; dir: string } {
  const dir = join(f.root, 'proj')
  mkdirSync(join(dir, 'briefs'), { recursive: true })
  const brief = join(dir, 'briefs', 'succession-brief.md')
  writeFileSync(brief, 'brief\n')
  return { brief, dir }
}

function records(f: Fixture): unknown {
  return JSON.parse(readFileSync(join(f.state, 'sleeping.json'), 'utf8'))
}

describe('sleep', () => {
  it('records a paused orchestrator with every field a wake needs', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    assert.equal(main(f.ctx, ['sleep', '--name', 'Orch: alpha', '--brief', brief, '--dir', dir, '--model', 'a-model', '--effort', 'high',
      '--pr', 'forge.example/o/app#9 feat/z', '--checkout', dir, '--session', 'abc-123']), 0)
    assert.deepEqual(f.out, ['sleeping Orch: alpha'])
    assert.deepEqual(records(f), [{ name: 'Orch: alpha', brief, dir, model: 'a-model', effort: 'high', slept: '2026-10-18T10:06:07Z',
      prs: ['forge.example/o/app#9 feat/z'], checkouts: [dir], session: 'abc-123' }])
    assert.equal(main(f.ctx, ['sleep', '--name', 'Orch: alpha', '--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'low']), 1)
    assert.deepEqual(f.err, ['coordinator: sleep: refused: Orch: alpha is already sleeping'])
  })

  it('refuses what a wake could not start on, and records nothing', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    const base = ['--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'high']
    const cases: Array<[string[], string]> = [
      [['--name', 'Orch: b [a1b2c3]', ...base], "sleep: refused: the name reads \"Orch: <subject>\", without its reference, the subject at most 25 characters, got 'Orch: b [a1b2c3]'"],
      [['--name', 'Agent: b', ...base], "sleep: refused: the name reads \"Orch: <subject>\", without its reference, the subject at most 25 characters, got 'Agent: b'"],
      [['--name', 'Orch: b', '--brief', 'rel.md', '--dir', dir, '--model', 'm'], "sleep: refused: the brief's path must be absolute, got rel.md"],
      [['--name', 'Orch: b', '--brief', join(dir, 'gone.md'), '--dir', dir, '--model', 'm'], `sleep: refused: the brief ${join(dir, 'gone.md')} cannot be read: a wake starts on it`],
      [['--name', 'Orch: b', '--brief', brief, '--dir', 'proj', '--model', 'm'], 'sleep: refused: the directory must be absolute, got proj'],
      [['--name', 'Orch: b', '--brief', brief, '--dir', join(dir, 'gone'), '--model', 'm'], `sleep: refused: the directory ${join(dir, 'gone')} does not exist: a wake starts in it`],
      [['--name', 'Orch: b', '--brief', brief, '--dir', dir, '--model', 'm'], 'sleep: refused: no effort: a pause records the model with its effort, --effort <level> (the paused orchestrator reads both with iterm-agent.sh pair)'],
      [['--name', 'Orch: b', ...base.slice(0, 6), '--effort', 'huge'], 'sleep: refused: unknown effort huge (low, medium, high, xhigh or max)'],
      [['--name', 'Orch: b', ...base, '--session', 'x y'], "sleep: refused: a session id reads letters, digits and hyphens, got 'x y'"],
      [['--name', 'Orch: b', '--brief', brief], 'sleep: usage: sleep --name "Orch: <subject>" --brief <path> --dir <path> --model <id> --effort <level> [--session <id>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...'],
      [['--name', 'Orch: b', ...base, '--pr', ''], 'sleep: --pr needs a value'],
      [['--name', 'Orch: b', ...base, '--checkout'], 'sleep: --checkout needs a value'],
      [['--name'], 'sleep: --name needs a value'],
      [['--colour', 'red'], 'sleep: unknown option --colour'],
    ]
    for (const [args, message] of cases) {
      f.err.length = 0
      assert.equal(main(f.ctx, ['sleep', ...args]), 1, message)
      assert.deepEqual(f.err, [`coordinator: ${message}`])
    }
    assert.equal(existsSync(join(f.state, 'sleeping.json')), false)
  })

  it('refuses an unreadable record rather than read it as none', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    mkdirSync(f.state, { recursive: true })
    for (const text of ['not json', '{"a":1}', '']) {
      writeFileSync(join(f.state, 'sleeping.json'), text)
      f.err.length = 0
      assert.equal(main(f.ctx, ['sleeping']), 1)
      assert.equal(main(f.ctx, ['sleep', '--name', 'Orch: c', '--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'high']), 1)
      assert.deepEqual(new Set(f.err), new Set([`coordinator: the sleeping record ${join(f.state, 'sleeping.json')} cannot be read: remove or repair it`]))
    }
    mkdirSync(join(f.root, 'dirstate', 'sleeping.json'), { recursive: true })
    const g = { ...f.ctx, env: { ORCHESTRATOR_STATE_DIR: join(f.root, 'dirstate') } }
    assert.equal(main(g, ['sleeping']), 1)
  })
})

describe('sleeping, wake-done and drop', () => {
  it('lists each sleeper in the order they went to sleep, nothing when none sleeps', () => {
    const f = fixture()
    assert.equal(main(f.ctx, ['sleeping']), 0)
    assert.deepEqual(f.out, [])
    assert.equal(main(f.ctx, ['sleeping', 'x']), 1)
    assert.equal(sleepingLine({ name: 'Orch: a', slept: 'T', dir: '/p', prs: ['r#1 b', 'r#2 c'], checkouts: [], brief: '/b', model: 'm', effort: 'high', session: 's-1' }),
      'sleeping Orch: a | since T | /p | prs r#1 b, r#2 c | checkouts none | brief /b | model m | effort high | session s-1')
    assert.equal(sleepingLine({ name: 'Orch: a', slept: 'T', dir: '/p', prs: [], checkouts: ['/c'], brief: '/b', model: 'm', effort: '' }),
      'sleeping Orch: a | since T | /p | prs none | checkouts /c | brief /b | model m | effort none')
    assert.equal(sleepingLine({ name: 'Orch: a', effort: 3 }),
      'sleeping Orch: a | since null | null | prs none | checkouts none | brief null | model null | effort 3')
  })

  it('wake-done removes the woken one alone, and refuses one that does not sleep', () => {
    const f = fixture()
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([{ name: 'Orch: a', x: 1 }, { name: 'Orch: b' }, 7]))
    assert.equal(main(f.ctx, ['wake-done', '--name', 'Orch: b']), 0)
    assert.deepEqual(f.out, ['woken Orch: b'])
    assert.deepEqual(records(f), [{ name: 'Orch: a', x: 1 }, 7])
    assert.equal(main(f.ctx, ['wake-done', '--name', 'Orch: b']), 1)
    assert.equal(main(f.ctx, ['wake-done']), 1)
    assert.equal(main(f.ctx, ['wake-done', '--name']), 1)
    assert.equal(main(f.ctx, ['drop', '--who', 'x']), 1)
    assert.deepEqual(f.err, [
      'coordinator: wake-done: refused: Orch: b is not sleeping (coordinator.sh sleeping lists who is)',
      'coordinator: wake-done: usage: wake-done --name "Orch: <subject>"',
      'coordinator: wake-done: --name needs a value',
      'coordinator: drop: unknown option --who',
    ])
  })

  it('a record written in the former shape is the same sleeper, either way the name is given', () => {
    const f = fixture()
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([{ name: 'Orch : a' }, { name: 'Orch: b' }]))
    assert.equal(main(f.ctx, ['wake-done', '--name', 'Orch: a']), 0)
    assert.equal(main(f.ctx, ['wake-done', '--name', 'Orch : b']), 0)
    assert.deepEqual(records(f), [])
  })

  it('a record written in the former shape already sleeps under the current name', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([{ name: 'Orch : alpha', brief, dir }]))
    assert.equal(main(f.ctx, ['sleep', '--name', 'Orch: alpha', '--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'high']), 1)
    assert.deepEqual(f.err, ['coordinator: sleep: refused: Orch: alpha is already sleeping'])
    assert.equal((records(f) as unknown[]).length, 1)
  })

  it('drop takes a record written in the former shape, and moves its brief', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([{ name: 'Orch : alpha', brief, prs: [], checkouts: [] }]))
    assert.equal(main(f.ctx, ['drop', '--name', 'Orch: alpha']), 0)
    const moved = join(dir, 'briefs', 'abandoned', '20261018T100607Z-succession-brief.md')
    assert.deepEqual(f.out, ['dropped Orch: alpha', `brief moved to ${moved}`, 'left untouched: none'])
    assert.deepEqual(records(f), [])
  })

  it('drop moves the brief under abandoned/ beside it, removes the record and names what it left', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    main(f.ctx, ['sleep', '--name', 'Orch: alpha', '--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'high', '--pr', 'r#9 z', '--checkout', dir])
    f.out.length = 0
    assert.equal(main(f.ctx, ['drop', '--name', 'Orch: alpha']), 0)
    const moved = join(dir, 'briefs', 'abandoned', '20261018T100607Z-succession-brief.md')
    assert.deepEqual(f.out, ['dropped Orch: alpha', `brief moved to ${moved}`, `left untouched: r#9 z, ${dir}`])
    assert.equal(readFileSync(moved, 'utf8'), 'brief\n')
    assert.deepEqual(records(f), [])
    assert.deepEqual(readdirSync(f.state), ['sleeping.json'])
  })

  it('drop says a brief already gone, and drops nothing when the brief cannot be moved', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([{ name: 'Orch: a', brief: join(dir, 'gone.md'), prs: [], checkouts: [] }, { name: 'Orch: b', brief, prs: [], checkouts: [] }]))
    assert.equal(main(f.ctx, ['drop', '--name', 'Orch: a']), 0)
    assert.deepEqual(f.out, ['dropped Orch: a', `brief ${join(dir, 'gone.md')} was already gone`, 'left untouched: none'])
    writeFileSync(join(dir, 'briefs', 'abandoned'), 'in the way')
    assert.equal(main(f.ctx, ['drop', '--name', 'Orch: b']), 1)
    assert.deepEqual(f.err, [`coordinator: drop: cannot move the brief ${brief} into ${join(dir, 'briefs', 'abandoned')}: nothing was dropped`])
    assert.equal((records(f) as unknown[]).length, 1)
  })

  it('a drop that cannot take the lock drops nothing', () => {
    const f = fixture()
    const { brief, dir } = project(f)
    main(f.ctx, ['sleep', '--name', 'Orch: alpha', '--brief', brief, '--dir', dir, '--model', 'm', '--effort', 'high'])
    mkdirSync(join(f.state, 'coordinator.lock'))
    assert.equal(main(f.ctx, ['drop', '--name', 'Orch: alpha']), 1)
    assert.equal((records(f) as unknown[]).length, 1)
    assert.equal(existsSync(brief), true)
  })

  it('knows the shape of a sleeper\'s name from core', () => {
    assert.equal(isSleeperName('Orch: alpha'), true)
    assert.equal(isSleeperName('Orch: a subject of exactly 25'.slice(0, 32)), true)
    assert.equal(isSleeperName('Orch: a subject longer than twenty-five'), false)
    assert.equal(isSleeperName('Orch:  padded'), false)
    assert.equal(isSleeperName('Orch: b [a1b2c3]'), false)
    assert.equal(isSleeperName('Coord: b'), false)
  })
})
