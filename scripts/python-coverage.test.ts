import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main, parseFloors, plan, rcText, sitecustomize, type Run } from './python-coverage.ts'

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  /** The coverage configuration as it stood during the call, when the call names one. */
  readonly rc?: string
}

function repo(floors: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'pycov-test-'))
  mkdirSync(join(root, 'ci'))
  writeFileSync(join(root, 'ci', 'python-coverage.json'), JSON.stringify({ floors }))
  return root
}

function fake(statuses: Record<string, number> = {}): { run: Run; calls: Call[]; out: string[]; err: string[] } {
  const calls: Call[] = []
  const run: Run = (command, args, env) => {
    const rcArg = args.find(arg => arg.startsWith('--rcfile='))
    const rcPath = rcArg?.slice('--rcfile='.length) ?? env['COVERAGE_PROCESS_START']
    calls.push({ command, args, env, ...(rcPath !== undefined && existsSync(rcPath) ? { rc: readFileSync(rcPath, 'utf8') } : {}) })
    return statuses[args[2] ?? command] ?? 0
  }
  return { run, calls, out: [], err: [] }
}

function io(f: { out: string[]; err: string[] }, env: Record<string, string | undefined> = {}) {
  return { out: (line: string) => f.out.push(line), err: (line: string) => f.err.push(line), env }
}

describe('parseFloors', () => {
  it('reads each plugin with its whole percent', () => {
    assert.deepEqual([...parseFloors({ floors: { a: 90, b: 0 } })], [['a', 90], ['b', 0]])
  })
  it('refuses a file without floors and a floor that is not a whole percent', () => {
    assert.throws(() => parseFloors({}), /expected/)
    assert.throws(() => parseFloors({ floors: { a: 90.5 } }), /"a" needs a whole percent/)
    assert.throws(() => parseFloors({ floors: { a: 101 } }), /whole percent/)
    assert.throws(() => parseFloors({ floors: { a: '90' } }), /whole percent/)
  })
})

describe('plan', () => {
  it('measures a plugin with a floor, held to it', () => {
    assert.deepEqual(plan(80, false, undefined), { measure: true, floor: 80 })
  })
  it('runs the suite alone for a plugin without a floor and for a part of a split suite', () => {
    assert.deepEqual(plan(undefined, false, ''), { measure: false })
    assert.deepEqual(plan(80, false, '2'), { measure: false })
    assert.deepEqual(plan(80, true, '2'), { measure: false })
  })
  it('measures without a floor when asked to measure', () => {
    assert.deepEqual(plan(undefined, true, undefined), { measure: true, floor: null })
  })
})

describe('rcText', () => {
  it('counts branches over the plugin, its tests left out, one data file per process', () => {
    const text = rcText('/r/plugins/a', '/w/data')
    for (const line of ['branch = True', 'parallel = True', 'data_file = /w/data', 'source = /r/plugins/a', 'omit = /r/plugins/a/tests/*']) assert.ok(text.includes(line), line)
  })
})

describe('sitecustomize', () => {
  it('starts coverage in a process that names the plugin or runs a module, not in a helper', () => {
    const site = mkdtempSync(join(tmpdir(), 'pycov-site-'))
    writeFileSync(join(site, 'sitecustomize.py'), sitecustomize('/r/plugins/alpha'))
    writeFileSync(join(site, 'coverage.py'), "def process_startup():\n    print('started')\n")
    const python = (...args: string[]): string => execFileSync('python3', args, { env: { ...process.env, PYTHONPATH: site }, encoding: 'utf8' }).trim()
    assert.equal(python('-c', 'pass', '/r/plugins/alpha/engine'), 'started')
    assert.equal(python('-m', 'this').startsWith('started'), true)
    assert.equal(python('-c', 'pass'), '')
  })
})

describe('main', () => {
  it('runs the suite under coverage, combines, and reports against the floor', () => {
    const root = repo({ alpha: 85 })
    const f = fake()
    assert.equal(main(['alpha'], root, io(f, { PYTHONPATH: '/already', PATH: '/bin' }), f.run), 0)
    const [suite, combine, report] = f.calls
    assert.equal(suite?.command, join(root, 'plugins', 'alpha', 'tests', 'run-tests.sh'))
    assert.match(suite?.env['PYTHONPATH'] ?? '', /site:\/already$/)
    assert.equal(suite?.env['PATH'], '/bin')
    assert.ok(suite?.rc?.includes(`source = ${join(root, 'plugins', 'alpha')}`))
    const site = (suite?.env['PYTHONPATH'] ?? '').split(':')[0] ?? ''
    assert.ok(site.endsWith('site'))
    assert.deepEqual(combine?.args.slice(0, 4), ['-m', 'coverage', 'combine', '--quiet'])
    assert.ok(report?.args.includes('--fail-under=85'))
    assert.deepEqual(f.out, ['python coverage of alpha, lines and branches, floor 85 %:'])
  })
  it('writes the sitecustomize that starts coverage in each process', () => {
    const root = repo({ alpha: 85 })
    let seen = ''
    const run: Run = (command, _args, env) => {
      if (command.endsWith('run-tests.sh')) seen = readFileSync(join((env['PYTHONPATH'] ?? '').split(':')[0] ?? '', 'sitecustomize.py'), 'utf8')
      return 0
    }
    main(['alpha'], root, io({ out: [], err: [] }), run)
    assert.equal(seen, sitecustomize(join(root, 'plugins', 'alpha')))
  })
  it('answers the report status: under the floor fails', () => {
    const f = fake({ report: 2 })
    assert.equal(main(['alpha'], repo({ alpha: 85 }), io(f), f.run), 2)
  })
  it('stops at a failing suite, and at a failing combine', () => {
    const failing = fake()
    const run: Run = (command, args, env) => (command.endsWith('run-tests.sh') ? 3 : failing.run(command, args, env))
    assert.equal(main(['alpha'], repo({ alpha: 85 }), io(failing), run), 3)
    assert.equal(failing.calls.length, 0)
    const f = fake({ combine: 1 })
    assert.equal(main(['alpha'], repo({ alpha: 85 }), io(f), f.run), 1)
    assert.equal(f.calls.length, 2)
  })
  it('measures without a floor on --measure', () => {
    const f = fake()
    assert.equal(main(['beta', '--measure'], repo({}), io(f), f.run), 0)
    assert.ok(!f.calls.at(-1)?.args.some(arg => arg.startsWith('--fail-under')))
    assert.deepEqual(f.out, ['python coverage of beta, lines and branches, measured:'])
  })
  it('runs the suite alone for a plugin without a floor, and for a part of a split suite', () => {
    const f = fake()
    assert.equal(main(['beta'], repo({}), io(f), f.run), 0)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0]?.env['COVERAGE_PROCESS_START'], undefined)
    const g = fake()
    main(['alpha'], repo({ alpha: 85 }), io(g, { SUITE_SHARD: '1' }), g.run)
    assert.equal(g.calls.length, 1)
  })
  it('names its usage without a plugin', () => {
    const f = fake()
    assert.equal(main([], repo({}), io(f), f.run), 2)
    assert.match(f.err[0] ?? '', /^usage:/)
  })
})
