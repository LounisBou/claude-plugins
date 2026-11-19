import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { countBucket, firstLine, gateCall, joinNames, listed, logPath, main, parseArgs, parseGate, parseTarget, parseView, registeredCount, Said, USAGE, watch, type Deps, type Options } from './ci-watch.ts'
import type { Ran, RunOptions } from './lib/process.ts'
import { parseJournalEvent } from '../../../core/learning.ts'

const HA = 'a'.repeat(40)
// The call every green line ends with.
const GATE = 'next: mcp__github__gh pr-gate {"pr": 7}'
const HB = 'b'.repeat(40)
const HM = 'c'.repeat(40)
const HN = 'd'.repeat(40)

/** What the fake `gh` and the draft guard answer; a list answers one entry per call, its last repeated. */
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
  /** What the gate answers per read, `<RESULT>:<running>` (none: read from the buckets and failing names, `gateCi`), or `fail`, or `bad`. */
  gate?: string[]
  /** The head the gate speaks of (default HA). */
  gateHead?: string
  /** What the gate lists as unverified. */
  gateUnverified?: string[]
  /** The contexts `gh pr checks --json name` lists on the head, one per line (none: `reg` gives a count). */
  names?: string
  /** What each poll of the checks reads, `name:bucket` entries separated by commas; the last repeated (none: `buckets`). */
  polls?: string[]
  /** The exit code of each `gh pr checks --json name,bucket` read (default 0). */
  pollExit?: number
  /** A failed `gh pr checks --json name,bucket` read: its stderr. */
  pollFails?: string
  /** A poll answer that is printed as it is, not as a list of checks. */
  pollRaw?: string
}

/**
 * The gate's `ci` for a script: its checks are the script's buckets (a cancelled one counted a
 * failure) and its failures those and the `failing` names; its result `<RESULT>:<running>` when the
 * script gives one, else FAILURE on a failure, PENDING when nothing passed and something was
 * skipped, SUCCESS otherwise.
 */
function gateCi(script: Script, answer: string | undefined): object {
  const checks = (script.buckets ?? '').split('\n').filter(Boolean).map(entry => {
    const [name = '', bucket = ''] = entry.split(':')
    return { name, bucket: bucket === 'cancel' ? 'fail' : bucket, link: '' }
  })
  const failures = [...new Set([...(script.failing ?? '').split('\n').filter(Boolean), ...checks.filter(c => c.bucket === 'fail').map(c => c.name)])]
  const [given, running = '0'] = (answer ?? '').split(':')
  const result = given !== undefined && given !== '' ? given
    : failures.length > 0 ? 'FAILURE'
    : !checks.some(c => c.bucket === 'pass') && checks.some(c => c.bucket === 'skipping') ? 'PENDING' : 'SUCCESS'
  return { result, running: Number(running), failed: result === 'FAILURE' ? failures : [], skipped: [], total: checks.length, unverified: script.gateUnverified ?? [], checks }
}

const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const failed = (stderr: string): Ran => ({ status: 1, stdout: '', stderr })

function fake(script: Script): Deps & { readonly calls: string[]; readonly gates: string[]; readonly out: string[]; readonly logs: Map<string, RunOptions['log']> } {
  const calls: string[] = []
  const gates: string[] = []
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
    calls, gates, out, logs,
    io: { out: text => out.push(text), err: () => {} },
    now: () => clock,
    sleep: async seconds => { clock += seconds * 1000 },
    draftGuard: ['node', '/plugin/draft-guard.ts'],
    gate: async (repo, pr) => {
      gates.push(`${repo}#${pr}`)
      if (gates.length > 50) throw new Error('the gate is read without end: the bound is ignored')
      const answer = nth('gate', script.gate)
      if (answer === 'fail') return failed('error: no GitHub token; run /github:install\nmore\n')
      if (answer === 'bad') return ok('not json\n')
      return ok(JSON.stringify({ repo, pr: Number(pr), head: script.gateHead ?? HA, ci: gateCi(script, answer) }))
    },
    run: async (argv, options = {}) => {
      const line = argv.join(' ')
      calls.push(line)
      if (options.log !== undefined) logs.set(line, options.log)
      if (argv[0] === 'node') {
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
          // A poll's checks: `name:bucket` entries, one list per poll (its last repeated), else the buckets.
          const answer = nth('polls', script.polls) ?? script.buckets ?? ''
          if (script.pollFails !== undefined) return failed(script.pollFails)
          if (script.pollRaw !== undefined) return ok(script.pollRaw)
          return { status: script.pollExit ?? 0, stdout: JSON.stringify(answer.split(/[\n,]/).filter(Boolean).map(entry => { const [name = '', bucket = ''] = entry.split(':'); return { name, bucket } })), stderr: '' }
        }
        const reg = nth('reg', script.reg) ?? '0'
        if (reg === 'none') return failed("no checks reported on the 'feat' branch\n")
        if (reg === 'fail') return failed('error connecting to api.github.com\r\nmore\n')
        if (script.names !== undefined) return ok(JSON.stringify(script.names.split('\n').filter(Boolean).map(name => ({ name }))))
        if (/^[0-9]+$/.test(reg)) return ok(JSON.stringify(Array.from({ length: Number(reg) }, (_, k) => ({ name: `check-${k}` }))))
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
  assert.deepEqual([parsed.base, parsed.repo, parsed.workflows, parsed.interval, parsed.registerWait, parsed.stateDir], [false, 'o/r', ['CI'], '30', 180, '/h/.claude/claude-orchestrator'])
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
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], repoViewFails: '' })
  const result = await watch(options(), deps).catch((error: unknown) => error)
  assert.ok(result instanceof Said)
  assert.equal(`${result.line}|${result.code}`, 'unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>|5')
  assert.deepEqual(deps.calls, ['gh repo view --json nameWithOwner --jq .nameWithOwner'])
  const out = fake({ repoViewFails: '' })
  assert.equal(await main(['7'], { ORCHESTRATOR_STATE_DIR: state }, out), 5)
  assert.deepEqual(out.out, ['ci-watch: unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>\n'])
})

test('a failed repo view says why, and an empty answer is refused at once', async () => {
  const refused = async (script: Script): Promise<string> => {
    const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], ...script })
    const result = await watch(options(), deps).catch((error: unknown) => error)
    assert.ok(result instanceof Said)
    assert.deepEqual(deps.calls, ['gh repo view --json nameWithOwner --jq .nameWithOwner'])
    return `${result.line}|${result.code}`
  }
  assert.equal(await refused({ repoViewFails: 'To get started with GitHub CLI, please run:  gh auth login\r\nmore\n' }),
    'unread 7 gh repo view failed: To get started with GitHub CLI, please run:  gh auth login: pass --repo <owner/repo>|5')
  assert.equal(await refused({ repoView: '' }), 'unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>|5')
  assert.equal(await refused({ repoView: '\n' }), 'unread 7 this directory is not a clone of the repository: pass --repo <owner/repo>|5')
})

test('the small readings', () => {
  assert.equal(firstLine('a\r\nb'), 'a')
  assert.equal(joinNames('a\nb,c\n'), 'a, b, c')
  assert.equal(joinNames('\n'), '')
  assert.deepEqual(parseView(`OPEN ${HA} auto draft`), { state: 'OPEN', head: HA, auto: true, draft: true })
  assert.deepEqual(parseView('MERGED'), { state: 'MERGED', head: 'MERGED', auto: false, draft: false })
  assert.equal(countBucket([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }, { name: 'c', bucket: 'pass' }], 'pass', new Set(['c'])), 1)
  assert.equal(parseGate('not json'), null)
  assert.equal(parseGate('{"ci": {"result": "SUCCESS"}}'), null)
  assert.deepEqual(parseGate('{"head": "h", "ci": {"result": "FAILURE", "running": 0, "failed": ["a", 1], "unverified": ["x"], "checks": [{"name": "a", "bucket": "fail"}, {"name": 2}]}}'),
    { head: 'h', result: 'FAILURE', running: 0, unverified: true, failed: ['a'], checks: [{ name: 'a', bucket: 'fail' }], raw: '{"head": "h", "ci": {"result": "FAILURE", "running": 0, "failed": ["a", 1], "unverified": ["x"], "checks": [{"name": "a", "bucket": "fail"}, {"name": 2}]}}' })
  assert.equal(logPath(options(['7', '--repo', 'o/r x']), true), join(state, 'ci-watch', 'o_r_x-pr7-base.log'))
})

test('a green line ends with the github tool\'s read of the gate, on the repository the watch names', () => {
  assert.equal(gateCall('7', undefined), 'next: mcp__github__gh pr-gate {"pr": 7}')
  assert.equal(gateCall('7', 'o/r'), 'next: mcp__github__gh pr-gate {"pr": 7} on o/r')
})

test('a readiness/ status is no registered check: the watch waits for a check of its own', async () => {
  assert.equal(registeredCount('[{"name":"build"},{"name":"readiness/review"}]'), 1)
  assert.equal(registeredCount('[{"name":"readiness/plan"}]'), 0)
  assert.equal(registeredCount('[]'), 0)
  assert.equal(registeredCount('many'), undefined)
  assert.equal(registeredCount('[{"context":"x"}]'), undefined)
  // Only the operator's readiness status is on the head: no check registered, so no-checks at the bound.
  assert.equal(await said({ view: [`OPEN ${HA}`], names: 'readiness/review' }), `no-checks 7 ${HA}|2`)
  // Without the filter this head counts a check, and the gate reads it green.
  assert.equal(await said({ view: [`OPEN ${HA}`], names: 'readiness/review\nbuild', buckets: 'build:pass' }), `green 7 ${HA} ${GATE}|0`)
})

test('a failed readiness/ status while a real check runs: the wait goes on until that check is done', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', polls: ['readiness/review:fail,build:pending', 'readiness/review:fail,build:pass'] })
  assert.equal((await watch(options(), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(deps.calls.filter(call => call.includes('name,bucket')).length, 2)
})

test('a real check failing while another runs: the wait returns at once, the gate reads the red', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:fail\ntest:pending', polls: ['build:fail,test:pending', 'build:fail,test:pass'] })
  assert.equal((await watch(options(), deps)).line, `red 7 ${HA} build`)
  assert.equal(deps.calls.filter(call => call.includes('name,bucket')).length, 1)
})

test('a pending check is an answer, even when gh exits 8 for it: the wait goes on, then green', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', polls: ['build:pending', 'build:pass'], pollExit: 8 })
  assert.equal((await watch(options(), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(deps.calls.filter(call => call.includes('name,bucket')).length, 2)
})

test('a poll that fails is unread, a poll that answers no list is unread, a poll that finds no checks returns quietly', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', pollFails: 'error connecting to api.github.com\n' }), 'unread 7 gh pr checks failed: error connecting to api.github.com|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', pollRaw: 'many\n' }), 'unread 7 gh pr checks failed: an answer that is no list of checks|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', pollFails: "no checks reported on the 'feat' branch\n" }), `green 7 ${HA} ${GATE}|0`)
})

test('the poll sleeps 30 s between two reads by default', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', polls: ['build:pending', 'build:pass'] })
  const start = deps.now()
  assert.equal((await watch(parseArgs(['7'], { ORCHESTRATOR_STATE_DIR: state }), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(deps.now() - start, 30000)
})

test('the checks are read each interval: the wait sleeps the interval between two reads, 30 s by default', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', polls: ['build:pending', 'build:pass'] })
  const start = deps.now()
  assert.equal((await watch(options(['7', '--interval', '3']), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(deps.now() - start, 3000)
  assert.equal(deps.calls.filter(call => call.includes('name,bucket')).length, 2)
  assert.equal(parseArgs(['7'], { ORCHESTRATOR_STATE_DIR: state }).interval, '30')
})

test('green: one passed check at least, the watch output in the log', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' })
  assert.equal(await main(['7', '--interval', '3'], { ORCHESTRATOR_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: 'sess-42' }, deps), 0)
  assert.deepEqual(deps.out, [`ci-watch: green 7 ${HA} ${GATE}\n`])
  const log = join(state, 'ci-watch', 'here-pr7.log')
  assert.equal(readFileSync(log, 'utf8'), '')
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

test('red, cancelled and skipped readings are the gate\'s, whatever the checks watch exits with', async () => {
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [1], failing: 'test\ne2e' }), `red 7 ${HA} test, e2e|1`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:cancel\nunit:pass\ne2e:cancel' }), `red 7 ${HA} build, e2e|1`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'unit:skipping\ndocs:skipping' }), `no-checks 7 ${HA} skipped=2|2`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [4] }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], gate: ['FAILURE:0'] }), 'unread 7 pr-gate read FAILURE with no failing check named|5')
})

// A rerun the gate leaves out (cancelled, superseded by a newer run of its workflow) fails the checks
// watch and `gh pr checks` still names it: the gate reads the head green, and so does the watch.
test('a cancelled run the gate leaves out is no red: the watch says the gate\'s green', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [1], failing: 'build', buckets: 'build:pass', gate: ['SUCCESS:0'] })
  assert.equal((await watch(options(), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(deps.calls.filter(call => call.includes('select(.bucket')).length, 0)
})

// The facts line of a delivery reads CI from the gate's last answer the watch kept, never from GitHub.
test('each gate answer read is kept whole for the facts line, under the gate\'s repository lowercased', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' })
  assert.equal((await watch(options(['Acme/Thing#7', '--interval', '1']), deps)).line, `green 7 ${HA} ${GATE} on Acme/Thing`)
  const kept = JSON.parse(readFileSync(join(state, 'ci-gate', 'acme_thing-pr7.json'), 'utf8')) as { head: string; ci: { result: string } }
  assert.deepEqual([kept.head, kept.ci.result], [HA, 'SUCCESS'])
  // A read that failed keeps nothing; a reading kept before stays.
  assert.match(await said({ view: [`OPEN ${HA}`], reg: ['2'], gate: ['fail'] }, ['Acme/Thing#7', '--interval', '1']), /^unread 7 pr-gate failed/)
  assert.equal((JSON.parse(readFileSync(join(state, 'ci-gate', 'acme_thing-pr7.json'), 'utf8')) as { ci: { result: string } }).ci.result, 'SUCCESS')
  assert.equal(readdirSync(join(state, 'ci-gate')).length, 1)
})

test('a gate answer that cannot be kept stops no watch: the facts line then says CI unread', async () => {
  writeFileSync(join(state, 'ci-gate'), 'a file where the directory goes')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' }), `green 7 ${HA} ${GATE}|0`)
})

test('a pull request GitHub reports as conflicting is no green: its suites never ran, whatever else passed', async () => {
  // GitHub starts no workflow run on a conflicting pull request: only an external check (a secret scanner) reports.
  const external = { reg: ['1'], buckets: 'GitGuardian:pass' }
  assert.equal(await said({ ...external, view: [`OPEN ${HA} conflicting`] }), `no-checks 7 ${HA} conflicting|2`)
  // Auto-merge never merges it: no wait for a merge, no read of the pull request beyond the two of every watch.
  const deps = fake({ ...external, view: [`OPEN ${HA} auto conflicting`] })
  assert.equal((await watch(options(), deps)).line, `no-checks 7 ${HA} conflicting`)
  assert.equal(deps.calls.filter(call => call.startsWith('gh pr view')).length, 2)
  // The read asks GitHub for the mergeability, and only a conflict counts: an uncomputed one is no obstacle.
  assert.ok(deps.calls.some(call => call.includes('--json state,headRefOid,autoMergeRequest,isDraft,mergeable')))
  assert.equal(await said({ ...external, view: [`OPEN ${HA}`] }), `green 7 ${HA} ${GATE}|0`)
  // A red stays a red: the failing names come first.
  assert.equal(await said({ reg: ['1'], buckets: 'build:cancel\nGitGuardian:pass', view: [`OPEN ${HA} conflicting`] }), `red 7 ${HA} build|1`)
})

test('the pull request line: state, head, then the flags it carries', () => {
  assert.deepEqual(parseView(`OPEN ${HA} auto draft conflicting`), { state: 'OPEN', head: HA, auto: true, draft: true, conflicting: true })
  assert.equal(parseView(`OPEN ${HA} conflicting`).conflicting, true)
  assert.equal(parseView(`OPEN ${HA} auto`).conflicting, undefined)
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
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], failing: 'e2e', gate: ['PENDING:1', 'PENDING:1', 'FAILURE:0'], headRuns: ['201:completed;202:in_progress', '-'] })
  assert.equal((await watch(options(), deps)).line, `red 7 ${HA} e2e`)
  assert.equal(deps.calls.filter(call => call.startsWith('gh run watch 202')).length, 1)
  assert.equal(deps.calls.filter(call => call.includes('name,bucket')).length, 2)
  assert.equal(await said({ view: [`OPEN ${HA}`, `OPEN ${HA}`, `OPEN ${HB}`], reg: ['2'], headRuns: ['201:in_progress', '-'] }), `moved 7 ${HA} ${HB}|3`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], headRuns: ['201:in_progress'] }), 'unread 7 workflow runs of the head still unfinished: 201|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], headRuns: ['fail'] }), 'unread 7 gh run list failed: gh: HTTP 502|5')
})

test('a bound shorter than the default interval is slept to its end, never past it', async () => {
  // The default interval is 30 s: a register bound of 10 s sleeps 10 s, not one whole interval.
  let clock = 0
  const sleeps: number[] = []
  const deps = { ...fake({ view: [`OPEN ${HA}`], reg: ['none'] }), now: () => clock, sleep: async (seconds: number) => { sleeps.push(seconds); clock += seconds * 1000 } }
  assert.equal((await watch(options(['7', '--repo', 'o/r'], { CI_WATCH_REGISTER_WAIT: '10' }), deps)).line, `no-checks 7 ${HA}`)
  assert.deepEqual(sleeps, [10])
})

test('a head with a third-party check alone is no green: it waits for the repository\'s own run, within the bound', async () => {
  // Only a secret scanner has registered and passed: the gate still counts the required `ci` as running.
  const alone = { view: [`OPEN ${HA}`], reg: ['1'], buckets: 'scanner:pass', gate: ['PENDING:1'] }
  const bounded = fake(alone)
  assert.equal((await watch(options(), bounded)).line, `no-checks 7 ${HA}`)
  assert.ok(bounded.gates.length <= 3, `${bounded.gates.length} gate reads inside a bound of 2 s at 1 s`)
  // The run registers late: it is watched to its end, the checks read again, and only then is it green.
  const late = fake({ ...alone, headRuns: ['-', '-', '201:in_progress', '201:completed'], gate: ['PENDING:1', 'PENDING:1', 'SUCCESS:0'], buckets: 'scanner:pass\nci:pass' })
  assert.equal((await watch(options(), late)).line, `green 7 ${HA} ${GATE}`)
  assert.equal(late.calls.filter(call => call.startsWith('gh run watch 201')).length, 1)
  assert.equal(late.calls.filter(call => call.includes('name,bucket')).length, 2)
  // The gate is read on the repository the watch names.
  const named = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' })
  await watch(options(['7', '--repo', 'o/r', '--interval', '1']), named)
  assert.deepEqual(named.gates, ['o/r#7'])
  // A head that moves while the run is awaited is said at once.
  assert.equal(await said({ ...alone, view: [`OPEN ${HA}`, `OPEN ${HA}`, `OPEN ${HB}`] }), `moved 7 ${HA} ${HB}|3`)
})

test('the gate: nothing to await, or a read that failed', async () => {
  // PENDING over something that proved nothing (a skipped check) awaits no run, and is no green.
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass\nlint:skipping', gate: ['PENDING:0'] }), `no-checks 7 ${HA} skipped=1|2`)
  // The result counts: a check running under a failure or a success awaits no run.
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:fail', gate: ['FAILURE:1'] }), `red 7 ${HA} build|1`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', gate: ['SUCCESS:1'] }), `green 7 ${HA} ${GATE}|0`)
  // The checks the base requires could not be read: green cannot be told, so it waits, then no-checks.
  const blind = { view: [`OPEN ${HA}`], reg: ['1'], buckets: 'scanner:pass', gate: ['PENDING:0'] }
  assert.equal(await said({ ...blind, gateUnverified: ['rulesets of main: HTTP 403'] }), `no-checks 7 ${HA}|2`)
  assert.equal(await said(blind), `no-checks 7 ${HA} skipped=0|2`)
  // A verdict of another head is none: the watch waits and reads the pull request again.
  assert.equal(await said({ ...blind, gateHead: HB }), `no-checks 7 ${HA}|2`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass', gateHead: HA.toUpperCase() }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], gate: ['fail'] }), 'unread 7 pr-gate failed: error: no GitHub token; run /github:install|5')
  assert.equal(await said({ view: [`OPEN ${HA}`], reg: ['2'], gate: ['bad'] }), 'unread 7 pr-gate failed: an answer with no ci result|5')
  // A red is the gate's: read once, it ends the watch.
  const red = fake({ view: [`OPEN ${HA}`], reg: ['2'], watchCodes: [1], failing: 'e2e' })
  assert.equal((await watch(options(), red)).line, `red 7 ${HA} e2e`)
  assert.deepEqual(red.gates, ['acme/thing#7'])
})

test('a draft: a red of guards alone settles, and its green needs a check behind a guard', async () => {
  const draft = `OPEN ${HA} draft`
  const deps = fake({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', guard: '', buckets: 'build:pass\nwip:fail', dependents: 'build\n' })
  assert.equal((await watch(options(), deps)).line, `green 7 ${HA} ${GATE}`)
  assert.ok(deps.calls.includes('gh pr checks 7 --watch --interval 1'))
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', buckets: 'secrets:pass\nwip:fail', dependents: '' }), `no-checks 7 ${HA} skipped=0|2`)
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1], failing: 'wip', guard: 'tests\n' }), `red 7 ${HA} tests|1`)
  assert.equal(await said({ view: [draft], reg: ['2'], watchCodes: [1] }), `green 7 ${HA} ${GATE}|0`)
  assert.equal(await said({ view: [draft], reg: ['2'], failing: 'wip', guardFails: 'draft_guard: gh failed\n' }), 'unread 7 draft_guard: gh failed|5')
  assert.equal(await said({ view: [draft], reg: ['2'], failing: 'wip', guardFails: '' }), 'unread 7 draft guard failed|5')
  const named = fake({ view: [draft], reg: ['2'], failing: 'wip', guard: 'tests\n' })
  await watch(options(['7', '--repo', 'acme/x']), named).catch(() => undefined)
  assert.ok(named.calls.includes('node /plugin/draft-guard.ts acme/x 7'))
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

test('merged during the watch with no push run on the base branch ends the watch, exit 0', async () => {
  const during = { view: [`OPEN ${HA}`, `MERGED ${HA}`], reg: ['2'], merge: `${HM} main` }
  assert.equal(await said({ ...during, runs: ['-'] }), `merged 7 ${HM} no push run on main filtered=0|0`)
  assert.equal(await said({ ...during, runs: ['101:CI;102:Slow'] }, ['7', '--base-workflow', 'Ci']), `merged 7 ${HM} no push run on main filtered=2|0`)
  // A red on the base branch after a merge during the watch is still a red.
  assert.equal(await said({ ...during, runs: ['101:CI'], runCodes: { 101: 1 }, jobs: 'test\n' }), `base-red 7 ${HM} 101 test|6`)
})

test('the owner file is written whole, through a temporary name and one rename', async () => {
  const deps = fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' })
  await main(['7'], { ORCHESTRATOR_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: 'sess-9' }, deps)
  const dir = join(state, 'ci-watch')
  assert.equal(readFileSync(join(dir, 'here-pr7.log.session'), 'utf8'), 'sess-9\n')
  assert.equal(statSync(join(dir, 'here-pr7.log.session')).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), [])
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

test('a watch is written to the journal as the wait on CI: its start, its end with the result word, the pull request and its head', async () => {
  const events: Record<string, unknown>[] = []
  const deps = { ...fake({ view: [`OPEN ${HA}`], reg: ['2'], buckets: 'build:pass' }), journal: (event: object) => { events.push(event as Record<string, unknown>) } }
  assert.equal(await main(['acme/thing#7'], { ORCHESTRATOR_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: 'sess-42' }, deps), 0)
  assert.deepEqual(events.map(e => [(e['source'] as { code: string }).code, e['fact'], e['subject']]), [
    ['orchestrator.ci-watch.start', { step: 'ci-wait', edge: 'start', record: null, row: null, result: null }, { repo: 'acme/thing', pr: 7, head: null }],
    ['orchestrator.ci-watch.green', { step: 'ci-wait', edge: 'end', record: null, row: null, result: 'green' }, { repo: 'acme/thing', pr: 7, head: HA }],
  ])
  for (const event of events) assert.ok(parseJournalEvent(event), JSON.stringify(event))
})

test('a watch whose command line is refused writes nothing', async () => {
  const events: object[] = []
  assert.equal(await main(['nope'], { ORCHESTRATOR_STATE_DIR: state }, { ...fake({}), journal: (event: object) => { events.push(event) } }), 5)
  assert.deepEqual(events, [])
})
