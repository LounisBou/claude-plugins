// The reconciler the module runs on its timer: one per machine, the gate read only on a changed fingerprint,
// a listing a repository per beat at most, backing off when the quota runs low.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, NounEvents, TestOn } from 'claude-code/testing'
import { fieldsOf } from '../core/host.ts'
import { parseReconcile } from '../core/pr-reconcile.ts'
import { GATES_PER_TICK, IDLE_MAX_MS, LEASE_MS, QUOTA_LOW, QUOTA_WAIT_MS, RETRY_MS, TICK_MS } from './reconcile.ts'
import { POSTS_PER_TICK } from './forge-sync.ts'

const T0 = Date.parse('2026-11-19T10:00:00Z')
const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const CFG = '/cfg'
const RECORDS = CFG + '/pr-' + 'records'
const READING = CFG + '/pr-reconcile/acme/app/7.json'
const LEASE = CFG + '/pr-reconcile/.lease'
const EDGE = CFG + '/pr-reconcile/.edge'

type Status = { context: string; state: string; description: string; creator: string }
type Pull = { number: number; draft: boolean; head: string; base: string; labels: string[]; rollup: string | null; statuses?: Status[] }

// The machine and GitHub as the reconciler sees them: files by path with their mtimes, the open pull requests of
// acme/app, the quota the listing reports, every engine run by its subcommand and every line the module said.
// `gateFails` makes the gate fail; `panelFails` makes the listing fail with that text on stderr. With `viewer`, the listing
// names the account that reads; `posted` and `copied` are the statuses posted and the records copied from the forge.
function world(on: TestOn, over: { pulls?: Pull[]; files?: Record<string, string>; remaining?: number; resetAt?: string; viewer?: string } = {}) {
  const files = new Map<string, { text: string; mtime: number }>()
  const dirs = new Map<string, number>()
  const put = (path: string, text: string, mtime = T0) => {
    files.set(path, { text, mtime })
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) dirs.set(path.slice(0, at), Math.max(dirs.get(path.slice(0, at)) ?? 0, mtime))
  }
  // A record of acme/app at an earlier head: the repository is followed.
  put(RECORDS + '/acme/app/' + OTHER + '/review.x.json', '{}', T0 - 24 * 3600 * 1000)
  for (const [path, text] of Object.entries(over.files ?? {})) put(path, text)
  const state = {
    pulls: over.pulls ?? [{ number: 7, draft: false, head: HEAD, base: 'main', labels: [] as string[], rollup: 'SUCCESS' }],
    remaining: over.remaining ?? 4000, resetAt: over.resetAt ?? '2026-11-19T11:00:00Z',
    runs: [] as string[],
    labelled: [] as string[],
    said: [] as string[],
    gateFails: false,
    panelFails: undefined as string | undefined,
    readinessFails: false,
    posted: [] as string[],
    postFails: false,
    copied: [] as string[],
  }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-r' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    state.said.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: ({ CLAUDE_CONFIG_DIR: CFG, CLAUDE_PLUGIN_DATA: '/data/github' } as Record<string, string>)[e.name] }))
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)?.text } : { deny: 'ENOENT ' + e.path }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.write', (_$, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    if (files.has(e.path)) return { value: { kind: 'file', size: 1, mtimeMs: files.get(e.path)?.mtime } }
    return dirs.has(e.path) ? { value: { kind: 'dir', size: 1, mtimeMs: dirs.get(e.path) } } : { deny: 'ENOENT ' + e.path }
  })
  on('fs.list', (_$, e) => {
    if (!dirs.has(e.path)) return { deny: 'ENOENT ' + e.path }
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of [...files.keys(), ...dirs.keys()]) {
      if (!path.startsWith(e.path + '/')) continue
      const rest = path.slice(e.path.length + 1)
      names.set(rest.split('/')[0] ?? '', rest.includes('/') || dirs.has(path) && !files.has(path) ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, isLink: false })) }
  })
  on('process.run', (_$, e: NounEvents['process.run']) => {
    const argv = e.argv
    const done = (stdout = '', exitCode = 0, stderr = 'refused') => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : stderr } })
    if (argv[0] === 'sh') {
      const lock = String(argv[argv.length - 1])
      if (files.has(lock)) return done('', 1)
      put(lock, '1\n')
      return done()
    }
    if (argv[0] === 'mkdir') return done()
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2).map(String)
      const moved = files.get(from ?? '')
      if (moved && to) put(to, moved.text)
      files.delete(from ?? '')
      return done()
    }
    if (argv[0] === 'rm') {
      for (const path of argv.slice(1)) files.delete(String(path))
      return done()
    }
    const flag = (name: string) => String(argv[argv.indexOf(name) + 1] ?? '')
    if (String(argv[1] ?? '').endsWith('/engine/forge_status.py')) {
      state.posted.push(flag('--what') + ' ' + flag('--head').slice(0, 1) + ' ' + flag('--description'))
      return state.postFails ? done('', 1, 'error: cannot post: HTTP 403') : done('posted')
    }
    if (String(argv[1] ?? '').endsWith('/engine/record.py')) {
      const at = flag('--at')
      state.copied.push(flag('--kind') + ' ' + flag('--result') + ' ' + flag('--producer') + ' ' + at + ' ' + flag('--session'))
      const record = { v: 1, repo: flag('--repo'), pr: Number(flag('--pr')), head: flag('--head'), kind: flag('--kind'), result: flag('--result'), producer: flag('--producer'), detail: flag('--detail'), session: flag('--session'), at }
      put(RECORDS + '/' + record.repo + '/' + record.head + '/' + record.kind + '.' + at.replace(/[-:]/g, '') + '.' + record.producer + '.json', JSON.stringify(record), T0 + 10 * TICK_MS)
      return done('written')
    }
    const request = fieldsOf(JSON.parse(e.init?.stdin ?? '{}')) ?? {}
    const args = fieldsOf(request['args']) ?? {}
    const command = String(request['command'] ?? '')
    state.runs.push(command + (args['head-only'] ? ' head' : '') + (args['state'] ? ' ' + String(args['state']) : ''))
    if (command === 'pr-panel') {
      if (state.panelFails !== undefined) return done('', 1, state.panelFails)
      return done(JSON.stringify({ rows: state.pulls, ...(over.viewer ? { viewer: over.viewer } : {}), rate: { remaining: state.remaining, resetAt: state.resetAt, cost: 1 } }))
    }
    const pull = state.pulls.find((p) => p.number === Number(args['pr']))
    if (command === 'pr-gate' && state.gateFails) return done('', 1, 'gh: HTTP 502')
    if (command === 'pr-gate' && pull) {
      return done(JSON.stringify({
        repo: 'acme/app', pr: pull.number, state: 'open', draft: pull.draft, head: pull.head, labels: pull.labels, commits: 1, base: pull.base, stacked: false,
        ci: { result: pull.rollup === 'SUCCESS' ? 'SUCCESS' : 'PENDING', failed: [], running: pull.rollup === 'SUCCESS' ? 0 : 1, skipped: [], total: 1, checks: [{ name: 'ci', bucket: 'pass' }] },
      }))
    }
    if (command === 'pr-readiness' && state.readinessFails) return done('', 1, 'gh: HTTP 403 label')
    if (command === 'pr-readiness' && pull) {
      pull.labels = [...pull.labels.filter((l) => !['ready', 'not ready'].includes(l.toLowerCase())), args['state'] === 'ready' ? 'Ready' : 'Not Ready']
      state.labelled.push(pull.number + ' ' + String(args['state']))
      return done('ok')
    }
    return done('', 1)
  })
  return { files, put, state }
}

async function started($: Engine, on: TestOn, over: Parameters<typeof world>[1] = {}): Promise<{ clock: MockClock } & ReturnType<typeof world>> {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, over)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return { clock, ...w }
}

const beat = async (clock: MockClock, times = 1) => {
  for (let i = 0; i < times; i++) {
    await clock.advance(TICK_MS)
    await clock.settle()
  }
}
const count = (runs: readonly string[], command: string) => runs.filter((run) => run === command).length

test('at its first beat a pull request carrying neither label gets Not Ready, its reading kept for the orchestrator', async ($, on) => {
  const { clock, files, state } = await started($, on)
  expect(state.runs).toEqual([])
  await beat(clock)
  expect(state.runs).toEqual(['pr-panel', 'pr-gate', 'pr-gate head', 'pr-readiness not-ready'])
  const reading = parseReconcile(files.get(READING)?.text ?? '')
  expect(reading?.head).toBe(HEAD)
  expect(reading?.labels).toEqual(['Not Ready'])
  expect(reading?.ci).toMatchObject({ result: 'SUCCESS', running: 0, failed: [], checks: [{ name: 'ci', bucket: 'pass' }] })
  expect(reading?.missing.length).toBeGreaterThan(0)
  expect(files.get(LEASE)?.text).toContain('"holder":"session-r:')
})

test('a fingerprint unchanged reads no gate: beats after the first list the repository and read nothing more', async ($, on) => {
  const { clock, state } = await started($, on)
  await beat(clock, 4)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  expect(state.labelled).toEqual(['7 not-ready'])
})

test('a base retargeted reads the gate again at the next listing', async ($, on) => {
  const { clock, state } = await started($, on)
  await beat(clock, 2)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  const pull = state.pulls[0]
  if (pull) pull.base = 'develop'
  await clock.advance(IDLE_MAX_MS)
  await clock.settle()
  expect(count(state.runs, 'pr-gate')).toBe(2)
})

test('a record written at the head reads the gate again at the next beat, with no new listing', async ($, on) => {
  const { clock, state, put } = await started($, on)
  await beat(clock, 3)
  const listings = count(state.runs, 'pr-panel')
  put(RECORDS + '/acme/app/' + HEAD + '/e2e.y.json', '{}', T0 + 3 * TICK_MS)
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(2)
  expect(count(state.runs, 'pr-panel')).toBe(listings)
})

test('an idle repository is listed less and less often, and at once when a producer touches the edge marker', async ($, on) => {
  const { clock, state, put } = await started($, on)
  await beat(clock, 10)
  // Listed at beats 1, 2 (its labels moved) and 3 (nothing moved), then idle: beats 5 and 9, the next at 14.
  expect(count(state.runs, 'pr-panel')).toBe(5)
  put(EDGE, '', T0 + 10 * TICK_MS + 1)
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(6)
  await beat(clock, 2)
  expect(count(state.runs, 'pr-panel')).toBe(6)
})

test('a low quota lists nothing until its reset', async ($, on) => {
  const resetAt = new Date(T0 + 20 * 60_000).toISOString()
  const { clock, state } = await started($, on, { remaining: QUOTA_LOW - 1, resetAt })
  await beat(clock, 15)
  expect(count(state.runs, 'pr-panel')).toBe(1)
  await beat(clock, 6)
  expect(count(state.runs, 'pr-panel')).toBe(2)
})

test('another session holding the lease reconciles alone; this one takes over once that lease runs out', async ($, on) => {
  const held = JSON.stringify({ v: 1, holder: 'session-other:1', until: T0 + 3 * TICK_MS + 1 })
  const { clock, state, files } = await started($, on, { files: { [LEASE]: held } })
  await beat(clock, 3)
  expect(state.runs).toEqual([])
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(1)
  expect(files.get(LEASE)?.text).toContain('"holder":"session-r:')
  expect(JSON.parse(files.get(LEASE)?.text ?? '{}').until).toBe(T0 + 4 * TICK_MS + LEASE_MS)
})

test('a repository with no recent records, and no orchestrator file naming it, is never listed and takes no lease', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31 * 24 * 3600 * 1000 })
  const { state, files } = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5 * TICK_MS)
  await clock.settle()
  expect(state.runs).toEqual([])
  expect(files.has(LEASE)).toBe(false)
})

test('the repositories the orchestrator\'s pull request file read are followed too', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31 * 24 * 3600 * 1000 })
  const { state } = world(on, { files: { [CFG + '/claude-orchestrator/prs.json']: JSON.stringify({ v: 1, repos: ['acme/app'], prs: [] }) } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(TICK_MS)
  await clock.settle()
  expect(count(state.runs, 'pr-panel')).toBe(1)
})

test('a pull request no longer listed open loses its reading', async ($, on) => {
  const { clock, state, files } = await started($, on)
  await beat(clock)
  expect(files.has(READING)).toBe(true)
  state.pulls = []
  await beat(clock)
  expect(files.has(READING)).toBe(false)
})

test('no more than GATES_PER_TICK gates are read at one beat, the others at the next', async ($, on) => {
  const pulls = [1, 2, 3, 4, 5, 6].map((number) => ({ number, draft: false, head: HEAD, base: 'main', labels: ['Not Ready'], rollup: 'SUCCESS' }))
  const { clock, state } = await started($, on, { pulls })
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(GATES_PER_TICK)
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(6)
})

test('a gate that failed is not tried again on the same fingerprint before RETRY_MS; said again only after beats that said nothing', async ($, on) => {
  const { clock, state } = await started($, on)
  state.gateFails = true
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  await beat(clock, RETRY_MS / TICK_MS - 1)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(2)
  expect(state.said.filter((line) => line.includes('HTTP 502'))).toHaveLength(2)
  expect(state.labelled).toEqual([])
})

test('a listing refused for the rate limit lists nothing more for QUOTA_WAIT_MS, said once', async ($, on) => {
  const { clock, state, files } = await started($, on)
  state.panelFails = 'gh: API rate limit exceeded'
  await beat(clock, QUOTA_WAIT_MS / TICK_MS)
  expect(count(state.runs, 'pr-panel')).toBe(1)
  expect(state.said.filter((line) => line.includes('could not list acme/app: gh: API rate limit exceeded'))).toHaveLength(1)
  expect(files.has(READING)).toBe(false)
  state.panelFails = undefined
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(2)
  expect(files.has(READING)).toBe(true)
})

test('a listing that fails keeps the rows last listed: a record written at the head still reads the gate', async ($, on) => {
  const { clock, state, put, files } = await started($, on)
  await beat(clock)
  state.panelFails = 'gh: HTTP 502'
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(2)
  expect(files.has(READING)).toBe(true)
  const gates = count(state.runs, 'pr-gate')
  put(RECORDS + '/acme/app/' + HEAD + '/e2e.y.json', '{}', T0 + 2 * TICK_MS)
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(2)
  expect(count(state.runs, 'pr-gate')).toBe(gates + 1)
  expect(state.said.filter((line) => line.includes('could not list acme/app'))).toHaveLength(1)
})

test('a low quota reads no gate and heeds no edge marker until its reset', async ($, on) => {
  const resetAt = new Date(T0 + 20 * 60_000).toISOString()
  const { clock, state, put } = await started($, on, { remaining: QUOTA_LOW - 1, resetAt })
  await beat(clock)
  expect([count(state.runs, 'pr-panel'), count(state.runs, 'pr-gate')]).toEqual([1, 0])
  put(RECORDS + '/acme/app/' + HEAD + '/e2e.y.json', '{}', T0 + TICK_MS)
  put(EDGE, '', T0 + TICK_MS + 1)
  await beat(clock, 5)
  expect([count(state.runs, 'pr-panel'), count(state.runs, 'pr-gate')]).toEqual([1, 0])
})

test('a gate read whose label cannot be written still keeps its reading for the orchestrator, the label tried again after RETRY_MS', async ($, on) => {
  const { clock, state, files } = await started($, on)
  state.readinessFails = true
  await beat(clock)
  const reading = parseReconcile(files.get(READING)?.text ?? '')
  expect([reading?.head, reading?.ci.result, reading?.labels]).toEqual([HEAD, 'SUCCESS', []])
  await beat(clock, RETRY_MS / TICK_MS - 1)
  expect(count(state.runs, 'pr-readiness not-ready')).toBe(1)
  state.readinessFails = false
  await beat(clock)
  expect(state.labelled).toEqual(['7 not-ready'])
})

test('the same session started again keeps its lease: it reconciles at the next beat', async ($, on) => {
  const { clock, state } = await started($, on)
  await beat(clock)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(2)
})

// ---- the forge's copies (forge-sync.ts) ----

const reviewAt = (at: string, result = 'pass', producer = 'orchestrator') => JSON.stringify({
  v: 1, repo: 'acme/app', pr: 7, head: HEAD, kind: 'review', result, producer, detail: '', session: 's', at,
})
const status = (context: string, state: string, description: string, creator = 'operator'): Status => ({ context, state, description, creator })
const PLAN = '/data/github/check-plans/acme/app/7.json'
const pullWith = (statuses: Status[]): Pull[] => [{ number: 7, draft: false, head: HEAD, base: 'main', labels: [], rollup: 'SUCCESS', statuses }]

test('a record the other machine posted is copied here before the gate reads it', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  expect(state.copied).toEqual(['review pass orchestrator 2026-11-19T09:00:00Z forge'])
  expect(state.runs.slice(0, 2)).toEqual(['pr-panel', 'pr-gate'])
  expect(state.posted).toEqual([])
  await beat(clock, 3)
  expect(state.copied).toHaveLength(1)
})

test('a status another account posted is never copied', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator', 'intruder')])
  const { clock, state } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  expect(state.copied).toEqual([])
})

test('a listing that names no account copies nothing either way', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state } = await started($, on, { pulls, files: { [RECORDS + '/acme/app/' + HEAD + '/review.a.json']: reviewAt('2026-11-19T08:00:00Z') } })
  await beat(clock)
  expect([state.copied, state.posted]).toEqual([[], []])
})

test('a record this machine holds newer than the forge\'s is posted over it, once', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T08:00:00Z pass orchestrator')])
  const files = { [RECORDS + '/acme/app/' + HEAD + '/review.a.json']: reviewAt('2026-11-19T09:00:00Z', 'fail') }
  const { clock, state } = await started($, on, { pulls, files, viewer: 'operator' })
  await beat(clock)
  expect(state.posted).toEqual(['review a v1 2026-11-19T09:00:00Z fail orchestrator'])
  expect(state.copied).toEqual([])
  await beat(clock, 3)
  expect(state.posted).toHaveLength(1)
})

test('a post refused is said once and tried again after RETRY_MS', async ($, on) => {
  const files = { [RECORDS + '/acme/app/' + HEAD + '/review.a.json']: reviewAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  await beat(clock, RETRY_MS / TICK_MS - 1)
  expect(state.posted).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not post readiness/review of acme/app#7'))).toHaveLength(1)
  state.postFails = false
  await beat(clock)
  expect(state.posted).toHaveLength(2)
})

test('no more than POSTS_PER_TICK statuses are posted at one beat, the others at the next', async ($, on) => {
  const numbers = Array.from({ length: POSTS_PER_TICK + 2 }, (_, i) => i + 1)
  const headOf = (n: number) => n.toString(16).padStart(40, 'c')
  const pulls = numbers.map((number) => ({ number, draft: false, head: headOf(number), base: 'main', labels: [], rollup: 'SUCCESS', statuses: [] }))
  const files = Object.fromEntries(numbers.map((number) => [RECORDS + '/acme/app/' + headOf(number) + '/review.a.json',
    JSON.stringify({ v: 1, repo: 'acme/app', pr: number, head: headOf(number), kind: 'review', result: 'pass', producer: 'orchestrator', detail: '', session: 's', at: '2026-11-19T09:00:00Z' })]))
  const { clock, state } = await started($, on, { pulls, files, viewer: 'operator' })
  await beat(clock)
  expect(state.posted).toHaveLength(POSTS_PER_TICK)
  await beat(clock)
  expect(state.posted).toHaveLength(POSTS_PER_TICK + 2)
})

test('a check plan the other machine posted is written here', async ($, on) => {
  const pulls = pullWith([status('readiness/plan', 'success', 'v1 2026-11-19T09:00:00Z e2e=none norms=required review=required/2')])
  const { clock, state, files } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  const plan = JSON.parse(files.get(PLAN)?.text ?? '{}')
  expect([plan.at, plan.e2e, plan.review]).toEqual(['2026-11-19T09:00:00Z', { need: 'none', reason: 'copied from the forge' }, { need: 'required', reason: '', max: 2 }])
  expect(state.posted).toEqual([])
})

test('this machine\'s check plan is posted at a head where the forge lacks it', async ($, on) => {
  const plan = JSON.stringify({ v: 1, repo: 'acme/app', pr: 7, e2e: { need: 'none', reason: 'docs' }, norms: { need: 'required', reason: '' }, review: { need: 'required', reason: '', max: 2 }, at: '2026-11-19T09:00:00Z' })
  const { clock, state } = await started($, on, { pulls: pullWith([]), viewer: 'operator', files: { [PLAN]: plan } })
  await beat(clock)
  expect(state.posted).toEqual(['plan a v1 2026-11-19T09:00:00Z e2e=none norms=required review=required/2'])
})
