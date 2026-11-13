import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { countBucket, firstLine, gateCall, joinNames, logPath, main, parseArgs, parseTarget, parseView, Said, USAGE, watch, type Deps, type Options } from './ci-watch.ts'
import type { Ran, RunOptions } from './lib/process.ts'

const HA = 'a'.repeat(40)
// The call every green line ends with.
const GATE = 'next: mcp__github__gh pr-gate {"pr": 7}'
const HB = 'b'.repeat(40)
const HM = 'c'.repeat(40)
const HN = 'd'.repeat(40)

/** What the fake `gh` and `draft_guard.py` answer; a list answers one entry per call, its last repeated. */
interface Script {
  view?: string[]
  viewFails?: string
  reg?: string[]
  watchCodes?: number[]
  buckets?: string
  failing?: string
  headRuns?: string[]
  merge?: string
  runs?: string[]
  runCodes?: Record<string, number>
  conclusions?: Record<string, string>
  jobs?: string
  newest?: string[]
  guard?: string
  dependents?: string
  guardFails?: string
  repoView?: string
  repoViewFails?: string
}

const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const failed = (stderr: string): Ran => ({ status: 1, stdout: '', stderr })

function fake(script: Script): Deps & { readonly calls: string[]; readonly out: string[]; readonly logs: Map<string, RunOptions['log']> } {
  const calls: string[] = []
  const out: string[] = []
  const logs = new Map<string, RunOptions['log']>()
  const counters = new Map<string, number>()
  const nth = (key: string, list: readonly string[] | undefined): string | undefined => {
    if (list === undefined || list.length === 0) return undefined
    const n = counters.get(key) ?? 0
    counters.set(key, n + 1)
    return list[Math.min(n, list.length - 1)]
  }
  let clock = 0
  return {
    calls, out, logs,
    io: { out: text => out.push(text), err: () => {} },
    now: () => clock,
    sleep: async seconds => { clock += seconds * 1000 },
    draftGuard: '/plugin/draft_guard.py',
    run: async (argv, options = {}) => {
      const line = argv.join(' ')
      calls.push(line)
      if (options.log !== undefined) logs.set(line, options.log)
      if (argv[0] === 'python3') {
        if (script.guardFails !== undefined) return failed(script.guardFails)
        return ok(argv.includes('--dependents') ? script.dependents ?? '' : script.guard ?? '')
      }
      const verb = `${argv[1]} ${argv[2]}`
      if (verb === 'repo view') return script.repoViewFails !== undefined ? failed(script.repoViewFails) : ok(script.repoView ?? 'acme/thing\n')
      if (verb === 'pr view') {
        if (line.includes('mergeCommit')) return script.merge === undefined ? failed('gh: HTTP 404\n') : ok(`${script.merge}\n`)
        const view = nth('view', script.view)
        return view === undefined ? failed(script.viewFails ?? 'gh: HTTP 502\n') : ok(`${view}\n`)
      }
      if (verb === 'pr checks') {
        if (line.includes('--watch')) return { status: Number(nth('watch', (script.watchCodes ?? [0]).map(String))), stdout: '', stderr: '' }
        if (line.includes('select')) return script.failing === undefined ? { status: 0, stdout: '', stderr: '' } : ok(`${script.failing}\n`)
        if (line.includes('name,bucket')) {
          if (script.buckets === undefined) return failed('gh: HTTP 502\n')
          return ok(script.buckets.split('\n').map(entry => { const [name, bucket] = entry.split(':'); return `${bucket}\t${name}\n` }).join(''))
        }
        const reg = nth('reg', script.reg) ?? '0'
        if (reg === 'none') return failed("no checks reported on the 'feat' branch\n")
        if (reg === 'fail') return failed('error connecting to api.github.com\r\nmore\n')
        return ok(`${reg}\n`)
      }
      if (verb === 'run list') {
        if (line.includes('databaseId,status')) {
          const runs = nth('head-runs', script.headRuns) ?? '-'
          if (runs === 'fail') return failed('gh: HTTP 502\n')
          return ok(runs === '-' ? '' : runs.split(';').filter(r => !r.endsWith(':completed')).map(r => `${r.split(':')[0]}\n`).join(''))
        }
        if (line.includes('--workflow')) {
          const newest = nth('newest', script.newest)
          return newest === undefined ? failed('gh: HTTP 502\n') : ok(newest === '-' ? '' : `${newest}\n`)
        }
        const runs = nth('runs', script.runs)
        if (runs === undefined) return failed('gh: HTTP 502\n')
        return ok(runs === '-' ? '' : runs.split(';').map(r => `${r.replace(':', '\t')}\n`).join(''))
      }
      const id = argv[3] ?? ''
      if (verb === 'run watch') return { status: script.runCodes?.[id] ?? 0, stdout: '', stderr: '' }
      if (verb === 'run view') {
        if (line.includes('--json conclusion')) return ok(`${script.conclusions?.[id] ?? ((script.runCodes?.[id] ?? 0) === 0 ? 'success' : 'failure')}\n`)
        return ok(script.jobs ?? '')
      }
      return failed('unknown\n')
    },
  }
}

let state = ''
test.beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'ci-watch-')) })
test.afterEach(() => rmSync(state, { recursive: true, force: true }))

const options = (argv: readonly string[] = ['7', '--interval', '1'], env: Record<string, string> = {}): Options =>
  parseArgs(argv, { ORCHESTRATOR_STATE_DIR: state, CI_WATCH_REGISTER_WAIT: '2', CI_WATCH_BASE_WAIT: '2', CI_WATCH_MERGE_WAIT: '4', ...env })

async function said(script: Script, argv?: readonly string[], env?: Record<string, string>): Promise<string> {
  const deps = fake(script)
  const result = await watch(options(argv, env), deps).catch((error: unknown) => {
    if (error instanceof Said) return error
    throw error
  })
  return `${result.line}|${result.code}`
}

test('the command line: a number, then known options; the bounds are numbers', () => {
  const bad = (argv: string[], env: Record<string, string> = {}): string => {
    try {
      parseArgs(argv, env)
    } catch (error) {
      if (error instanceof Said) return `${error.line}|${error.code}`
      throw error
    }
    return 'accepted'
  }
  assert.equal(bad([]), `unread - ${USAGE}|5`)
  assert.equal(bad(['x7']), `unread - ${USAGE}|5`)
  assert.equal(bad(['7', '--repo']), 'unread 7 --repo needs a value|5')
  assert.equal(bad(['7', '--bogus', 'x']), `unread 7 unknown argument: --bogus (${USAGE})|5`)
  assert.equal(bad(['7', '--interval', '0']), 'unread 7 the interval is a positive number of seconds|5')
  assert.equal(bad(['7'], { CI_WATCH_REGISTER_WAIT: '1m' }), 'unread 7 CI_WATCH_REGISTER_WAIT is a number of seconds|5')
  assert.equal(bad(['7'], { CI_WATCH_BASE_WAIT: 'x' }), 'unread 7 CI_WATCH_BASE_WAIT is a number of seconds|5')
  assert.equal(bad(['7'], { CI_WATCH_MERGE_WAIT: 'x' }), 'unread 7 CI_WATCH_MERGE_WAIT is a number of seconds|5')
  const parsed = parseArgs(['7', '--no-base', '--repo', 'o/r', '--base-workflow', 'CI'], { HOME: '/h', CI_WATCH_BASE_WORKFLOWS: 'A,B' })
  assert.deepEqual([parsed.base, parsed.repo, parsed.workflows, parsed.interval, parsed.registerWait, parsed.stateDir], [false, 'o/r', ['CI'], '10', 180, '/h/.claude/claude-orchestrator'])
  assert.deepEqual(parseArgs(['7'], { CI_WATCH_BASE_WORKFLOWS: 'Lint,CI,\nX' }).workflows, ['Lint', 'CI'])
})

test('the target: a number, owner/name#number or a pull request URL, and a repository named twice is one', () => {
  assert.deepEqual(parseTarget('7'), { pr: '7', repo: undefined })
  assert.deepEqual(parseTarget('Acme/the-thing.js#12'), { pr: '12', repo: 'Acme/the-thing.js' })
  assert.deepEqual(parseTarget('https://github.com/acme/thing/pull/12'), { pr: '12', repo: 'acme/thing' })
  assert.deepEqual(parseTarget('https://github.com/acme/thing/pull/12/files?w=1#diff'), { pr: '12', repo: 'acme/thing' })
  for (const bad of ['', 'x7', 'acme#7', 'acme/thing', 'acme/thing#', 'a/b/c#7', 'https://github.com/acme/thing/issues/7', 'https://example.com/acme/thing/pull/7']) {
    assert.equal(parseTarget(bad), undefined, bad)
  }
  const named = (argv: string[]): string => {
    try {
      const parsed = parseArgs(argv, {})
      return `${parsed.pr}|${parsed.repo}`
    } catch (error) {
      if (error instanceof Said) return `${error.line}|${error.code}`
      throw error
    }
  }
  assert.equal(named(['acme/thing#12']), '12|acme/thing')
  assert.equal(named(['https://github.com/acme/thing/pull/12']), '12|acme/thing')
  assert.equal(named(['7', '--repo', 'acme/thing']), '7|acme/thing')
  assert.equal(named(['acme/thing#12', '--repo', 'ACME/Thing']), '12|ACME/Thing')
  assert.equal(named(['acme/thing#12', '--repo', 'other/thing']), 'unread 12 the target names acme/thing and --repo names other/thing|5')
  assert.equal(named(['https://github.com/acme/thing/pull/12', '--repo', 'other/thing']), 'unread 12 the target names acme/thing and --repo names other/thing|5')
})

test('a target that names the repository is watched on it, whatever the directory is', async () => {
  for (const argv of [['acme/thing#7', '--interval', '1'], ['https://github.com/acme/thing/pull/7', '--interval', '1']]) {
    const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', repoViewFails: 'fatal: not a git repository\n' })
    assert.equal((await watch(options(argv), deps)).line, `green 7 ${HA} ${GATE} on acme/thing`)
    assert.deepEqual(deps.calls.filter(call => !call.includes(' -R acme/thing') && !call.startsWith('gh pr checks 7 --watch')), [])
    assert.equal(deps.calls.some(call => call.startsWith('gh repo view')), false)
  }
})

test('no repository named, outside a clone: refused in one line, nothing read', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], repoViewFails: 'fatal: not a git repository\n' })
  const result = await watch(options(), deps).catch((error: unknown) => error)
  assert.ok(result instanceof Said)
  assert.equal(`${result.line}|${result.code}`, 'unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>|5')
  assert.deepEqual(deps.calls, ['gh repo view --json nameWithOwner --jq .nameWithOwner'])
  const out = fake({ repoViewFails: 'x' })
  assert.equal(await main(['7'], { ORCHESTRATOR_STATE_DIR: state }, out), 5)
  assert.deepEqual(out.out, ['ci-watch: unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>\n'])
})

test('the small readings', () => {
  assert.equal(firstLine('a\r\nb'), 'a')
  assert.equal(joinNames('a\nb,c\n'), 'a, b, c')
  assert.equal(joinNames('\n'), '')
  assert.deepEqual(parseView(`OPEN ${HA} auto draft`), { state: 'OPEN', head: HA, auto: true, draft: true })
  assert.deepEqual(parseView('MERGED'), { state: 'MERGED', head: 'MERGED', auto: false, draft: false })
  assert.equal(countBucket('pass\ta\nskipping\tb\npass\tc', 'pass', new Set(['c'])), 1)
  assert.equal(logPath(options(['7', '--repo', 'o/r x']), '-base'), join(state, 'ci-watch', 'o_r_x-pr7-base.log'))
})

test('a green line ends with the github tool\'s read of the gate, on the repository the watch names', () => {
  assert.equal(gateCall('7', undefined), 'next: mcp__github__gh pr-gate {"pr": 7}')
  assert.equal(gateCall('7', 'o/r'), 'next: mcp__github__gh pr-gate {"pr": 7} on o/r')
})

test('green: one passed check at least, the watch output in the log', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' })
  assert.equal(await main(['7', '--interval', '3'], { ORCHESTRATOR_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: 'sess-42' }, deps), 0)
  assert.deepEqual(deps.out, [`ci-watch: green 7 ${HA} ${GATE}\n`])
  const log = join(state, 'ci-watch', 'here-pr7.log')
  assert.deepEqual(deps.logs.get('gh pr checks 7 --watch --fail-fast --interval 3'), { path: log, append: false })
  assert.equal(readFileSync(`${log}.session`, 'utf8'), 'sess-42\n')
  await main(['7'], { ORCHESTRATOR_STATE_DIR: state }, fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' }))
  assert.equal(existsSync(`${log}.session`), false)
})

test('the repository is passed to every gh call', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', headRuns: ['201:in_progress', '201:completed'] })
  await watch(options(['7', '--repo', 'o/r', '--interval', '1']), deps)
  assert.deepEqual(deps.calls.filter(call => !call.includes(' -R o/r')), [])
  assert.ok(deps.calls.includes('gh run list -R o/r --commit ' + HA + ' --json databaseId,status --jq .[] | select(.status != "completed") | .databaseId'))
})

test('red, cancelled and skipped readings after the watch', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [1], failing: 'test\ne2e' }), `red 7 ${HA} test, e2e|1`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:cancel\nunit:pass\ne2e:cancel' }), `red 7 ${HA} build, e2e|1`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'unit:skipping\ndocs:skipping' }), `no-checks 7 ${HA} skipped=2|2`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'] }), 'unread 7 gh pr checks failed: gh: HTTP 502|5')
  assert.match(await said({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [4] }), /^unread 7 gh pr checks --watch exited 4 with no failing check named \(log: .*here-pr7\.log\)\|5$/)
})

test('registration: waited for, bounded, and a failure is unread', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['none'] }), `no-checks 7 ${HA}|2`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['0'] }), `no-checks 7 ${HA}|2`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['none', '2'], buckets: 'a:pass' }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['fail'] }), 'unread 7 gh pr checks failed: error connecting to api.github.com|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['many'] }), 'unread 7 gh pr checks failed: an answer that is no count|5')
  assert.equal(await said({}), 'unread 7 gh pr view failed: gh: HTTP 502|5')
  assert.equal(await said({ viewFails: '' }), 'unread 7 gh pr view failed: no answer|5')
})

test('moved and closed, at each read', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HB}`], reg: ['2'] }), `moved 7 ${HA} ${HB}|3`)
  assert.equal(await said({ view: [`OPEN ${HA}`, `CLOSED ${HA}`], reg: ['2'] }), 'closed 7 CLOSED|4')
  assert.equal(await said({ view: [`CLOSED ${HA}`] }), 'closed 7 CLOSED|4')
  assert.equal(await said({ view: [`OPEN ${HA}`, `MERGED ${HA}`], reg: ['2'] }, ['7', '--no-base']), 'closed 7 MERGED|4')
})

test('the head\'s unfinished runs are watched, then the checks again', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [0, 1], failing: 'e2e', headRuns: ['201:completed;202:in_progress', '-'] })
  assert.equal((await watch(options(), deps)).line, `red 7 ${HA} e2e`)
  assert.equal(deps.calls.filter(call => call.startsWith('gh run watch 202')).length, 1)
  assert.equal(deps.calls.filter(call => call.includes('--watch')).length, 2)
  assert.equal(deps.logs.get('gh pr checks 7 --watch --fail-fast --interval 1')?.append, true)
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA}`, `OPEN ${HB}`], reg: ['2'], headRuns: ['201:in_progress', '-'] }), `moved 7 ${HA} ${HB}|3`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], headRuns: ['201:in_progress'] }), 'unread 7 workflow runs of the head still unfinished: 201|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], headRuns: ['fail'] }), 'unread 7 gh run list failed: gh: HTTP 502|5')
})

test('a draft: a red of guards alone settles, and its green needs a check behind a guard', async () => {
  const draft = `OPEN ${HA} draft`
  const deps = fake({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', guard: '', buckets: 'build:pass\nwip:fail', dependents: 'build\n' })
  assert.equal((await watch(options(), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.ok(deps.calls.includes('gh pr checks 7 --watch --interval 1'))
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', buckets: 'secrets:pass\nwip:fail', dependents: '' }), `no-checks 7 ${HA} skipped=0|2`)
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', guard: 'tests\n' }), `red 7 ${HA} tests|1`)
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1] }), `unread 7 gh pr checks --watch exited 1 with no failing check named (log: ${join(state, 'ci-watch', 'here-pr7.log')})|5`)
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], guardFails: 'draft_guard: gh failed\n' }), 'unread 7 draft_guard: gh failed|5')
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], guardFails: '' }), 'unread 7 draft_guard.py failed|5')
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], repoView: '' }), 'unread 7 gh repo view failed: no repository read|5')
  const named = fake({ view: [draft], reg: ['2'], watchCodes: [1], guard: 'tests\n' })
  await watch(options(['7', '--repo', 'acme/x']), named).catch(() => undefined)
  assert.ok(named.calls.includes('python3 /plugin/draft_guard.py acme/x 7'))
})

test('auto-merge: the merge is waited for, bounded, and followed', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA} auto`, `MERGED ${HA}`], reg: ['2'], buckets: 'a:pass', merge: `${HM} main`, runs: ['101:CI'] }), `base-green 7 ${HM}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA} auto`], reg: ['2'], buckets: 'a:pass' }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA} auto`, `OPEN ${HA}`], reg: ['2'], buckets: 'a:pass' }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA} auto`, `OPEN ${HB} auto`], reg: ['2'], buckets: 'a:pass' }), `moved 7 ${HA} ${HB}|3`)
})

test('merged: the base branch\'s push runs are followed', async () => {
  const merged = { view: [`MERGED ${HA}`], merge: `${HM} main` }
  const deps = fake({ ...merged, runs: ['101:CI'] })
  assert.equal((await watch(options(), deps)).line, `base-green 7 ${HM}`)
  assert.deepEqual(deps.logs.get('gh run watch 101 --exit-status --interval 1'), { path: join(state, 'ci-watch', 'here-pr7-base.log'), append: true })
  assert.equal(readFileSync(join(state, 'ci-watch', 'here-pr7-base.log'), 'utf8'), '')
  assert.equal(await said({ ...merged, runs: ['101:CI'], runCodes: { 101: 1 }, jobs: 'test\nlint\n' }), `base-red 7 ${HM} 101 test, lint|6`)
  assert.equal(await said({ ...merged, runs: ['-'] }), `base-no-run 7 ${HM} filtered=0|7`)
  assert.equal(await said({ ...merged, runs: ['101:CI;102:Slow'] }, ['7', '--base-workflow', 'Ci']), `base-no-run 7 ${HM} filtered=2|7`)
  assert.equal(await said({ ...merged, runs: ['-', '101:CI'] }), `base-green 7 ${HM}|0`)
  assert.equal(await said({ ...merged, runs: ['101:CI;102:Slow'], runCodes: { 102: 1 }, jobs: 'e2e\n' }, ['7', '--base-workflow', 'CI']), `base-green 7 ${HM}|0`)
  assert.equal(await said({ ...merged, runs: ['101:CI'], runCodes: { 101: 1 } }), `unread 7 gh run watch 101 exited 1 with no failing job named (log: ${join(state, 'ci-watch', 'here-pr7-base.log')})|5`)
  assert.equal(await said({ view: [`MERGED ${HA}`] }), 'unread 7 gh pr view failed: gh: HTTP 404|5')
  assert.equal(await said({ view: [`MERGED ${HA}`], merge: ` main` }), 'unread 7 gh pr view failed: no merge commit or base branch read|5')
  assert.equal(await said({ ...merged }), 'unread 7 gh run list failed: gh: HTTP 502|5')
})

test('a cancelled base run is replaced by its newer run, never by itself', async () => {
  const merged = { view: [`MERGED ${HA}`], merge: `${HM} main`, runs: ['101:CI'] }
  assert.equal(await said({ ...merged, runCodes: { 101: 1 }, conclusions: { 101: 'cancelled' }, newest: [`103 ${HN}`] }), `base-green 7 ${HN}|0`)
  assert.equal(await said({ ...merged, runCodes: { 101: 1, 103: 1 }, conclusions: { 101: 'cancelled' }, newest: [`103 ${HN}`], jobs: 'test\n' }), `base-red 7 ${HN} 103 test|6`)
  assert.equal(await said({ ...merged, runCodes: { 101: 1 }, conclusions: { 101: 'cancelled' }, newest: [`101 ${HM}`], jobs: 'test\n' }), `base-red 7 ${HM} 101 test|6`)
  assert.equal(await said({ ...merged, runCodes: { 101: 1 }, conclusions: { 101: 'cancelled' }, newest: ['-'], jobs: 'test\n' }), `base-red 7 ${HM} 101 test|6`)
  assert.equal(await said({ ...merged, runCodes: { 101: 1 }, conclusions: { 101: 'cancelled' } }), 'unread 7 gh run list failed: gh: HTTP 502|5')
})

test('the state directory: one that cannot be made, an owner file that cannot be written', async () => {
  const blocked = join(state, 'file')
  mkdirSync(join(state, 'ci-watch', 'here-pr7.log.session'), { recursive: true })
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'] }, undefined, { CLAUDE_CODE_SESSION_ID: 's' }), `unread 7 cannot write ${join(state, 'ci-watch', 'here-pr7.log.session')}|5`)
  rmSync(join(state, 'ci-watch'), { recursive: true })
  await import('node:fs').then(fs => fs.writeFileSync(blocked, ''))
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'] }, undefined, { ORCHESTRATOR_STATE_DIR: blocked }), `unread 7 cannot create ${blocked}/ci-watch|5`)
})

test('main: a failure that is no watch line is not hidden', async () => {
  const deps = fake({})
  await assert.rejects(main(['7'], { ORCHESTRATOR_STATE_DIR: state }, { ...deps, run: () => Promise.reject(new Error('boom')) }), /boom/)
})
