// The reconciler the module runs on its timer: one per machine, the gate read only on a changed fingerprint,
// a listing a repository per beat at most, backing off when the quota runs low.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, NounEvents, TestOn } from 'claude-code/testing'
import { fieldsOf } from '../core/host.ts'
import { parseReconcile } from '../core/pr-reconcile.ts'
import { JOURNAL_EVERY_MS } from './register.ts'
import { parseAuditEvent } from '../core/learning.ts'
import { FLAP_UNDONE, FOREIGN_WAIT_MS, GATES_PER_TICK, IDLE_MAX_MS, LEASE_MS, PUBLISH_WAIT_MS, QUOTA_LOW, QUOTA_WAIT_MS, RETRY_MS, TICK_MS } from './reconcile.ts'
import { POSTS_PER_TICK } from './forge-sync.ts'

const T0 = Date.parse('2026-11-19T10:00:00Z')
const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const CFG = '/cfg'
const RECORDS = CFG + '/pr-' + 'records'
const READING = CFG + '/pr-reconcile/acme/app/7.json'
const LEASE = CFG + '/pr-reconcile/.lease'
const LISTED = '/data/github/label-seen/acme/app/.listed'
const FAILING = '/data/github/label-seen/acme/app/.failing'
const EDGE = CFG + '/pr-reconcile/.edge'

// mergeable and mergeState: GitHub's listed mergeability against the base, as the listing carries it.
type Status = { context: string; state: string; description: string; creator: string }
type Pull = {
  number: number; draft: boolean; head: string; base: string; labels: string[]; rollup: string | null; mergeable?: string; mergeState?: string; statuses?: Status[]
}

// The gate's answer for a listed mergeability: pr-gate reads REST's mergeable and mergeable_state, null while computed.
const mergeableOf = (mergeable: string | undefined): Record<string, unknown> => {
  if (mergeable === 'CONFLICTING') return { mergeable: false, mergeable_state: 'dirty' }
  if (mergeable === 'UNKNOWN') return { mergeable: null, mergeable_state: 'unknown' }
  return mergeable === undefined ? {} : { mergeable: true, mergeable_state: 'clean' }
}

// The machine and GitHub as the reconciler sees them: files by path with their mtimes, the open pull requests of
// acme/app, the quota the listing reports, every engine run by its subcommand and every line the module said.
// `gateFails` makes the gate fail; `panelFails` makes the listing fail with that text on stderr. With `viewer`, the listing
// names the account that reads; `posted` and `copied` are the statuses posted and the records copied from the forge.
function world(on: TestOn, over: { pulls?: Pull[]; files?: Record<string, string>; remaining?: number; resetAt?: string; viewer?: string; other?: Pull[] } = {}) {
  const files = new Map<string, { text: string; mtime: number }>()
  const dirs = new Map<string, number>()
  const put = (path: string, text: string, mtime = T0) => {
    files.set(path, { text, mtime })
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) dirs.set(path.slice(0, at), Math.max(dirs.get(path.slice(0, at)) ?? 0, mtime))
  }
  // A record of acme/app at an earlier head: the repository is followed.
  put(RECORDS + '/acme/app/' + OTHER + '/review.x.json', '{}', T0 - 24 * 3600 * 1000)
  if (over.other) put(RECORDS + '/acme/other/' + OTHER + '/review.x.json', '{}', T0 - 24 * 3600 * 1000)
  for (const [path, text] of Object.entries(over.files ?? {})) put(path, text)
  const state = {
    pulls: over.pulls ?? [{ number: 7, draft: false, head: HEAD, base: 'main', labels: [] as string[], rollup: 'SUCCESS' }],
    remaining: over.remaining ?? 4000, resetAt: over.resetAt ?? '2026-11-19T11:00:00Z',
    runs: [] as string[],
    labelled: [] as string[],
    said: [] as string[],
    gateFails: false,
    panelFails: undefined as string | undefined,
    // With `panelFails`, only the listing of this repository fails (all, when undefined).
    panelFailsRepo: undefined as string | undefined,
    readinessFails: false,
    // Run inside the next label write, as a record written while the gate runs.
    duringReadiness: undefined as (() => void) | undefined,
    posted: [] as string[],
    // What reached GitHub, in order: each status posted ('post <name> <state>') and each label written ('label <state>').
    order: [] as string[],
    postFails: false,
    // The refusal text on stderr when `postFails`; the default is a 403.
    postRefusal: undefined as string | undefined,
    // With `postFails`, only the posts to this repository are refused (all, when undefined).
    postFailsRepo: undefined as string | undefined,
    // Whether the forge's listing says acme/app is archived (read-only).
    archived: false,
    // The open pull requests of acme/other, a second followed repository; and the repositories listed and posted to, in order.
    otherPulls: over.other ?? [],
    listedRepos: [] as string[],
    postedRepos: [] as string[],
    copied: [] as string[],
    // Whether each copy was written as one (record.py --copy), keeping a record of that name and result already there.
    asCopies: [] as boolean[],
    // Every copy of a record from the forge fails; a write to a path matching this is refused; this directory cannot be listed, once.
    copyFails: false,
    writeFails: undefined as RegExp | undefined,
    listFails: undefined as string | undefined,
    // Whether the forge listing's file was there when a record was copied.
    listedWhenCopied: undefined as boolean | undefined,
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
    if (state.writeFails?.test(e.path)) return { deny: 'EACCES ' + e.path }
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    if (files.has(e.path)) return { value: { kind: 'file', size: 1, mtimeMs: files.get(e.path)?.mtime } }
    return dirs.has(e.path) ? { value: { kind: 'dir', size: 1, mtimeMs: dirs.get(e.path) } } : { deny: 'ENOENT ' + e.path }
  })
  on('fs.list', (_$, e) => {
    if (e.path === state.listFails) {
      // Once: the gate reads the same directory by another path, which then goes through.
      state.listFails = undefined
      return { deny: 'EACCES ' + e.path }
    }
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
      state.postedRepos.push(flag('--repo'))
      state.posted.push(flag('--what') + ' ' + flag('--head').slice(0, 1) + ' ' + flag('--description'))
      if (!state.postFails) state.order.push('post ' + flag('--what') + ' ' + flag('--state'))
      return state.postFails && (state.postFailsRepo === undefined || state.postFailsRepo === flag('--repo')) ? done('', 1, state.postRefusal ?? 'error: cannot post: HTTP 403') : done('posted')
    }
    if (String(argv[1] ?? '').endsWith('/engine/record.py')) {
      const at = flag('--at')
      state.runs.push('record.py')
      state.listedWhenCopied = files.has(LISTED)
      if (state.copyFails) return done('', 1, 'record.py: cannot write')
      state.copied.push(flag('--kind') + ' ' + flag('--result') + ' ' + flag('--producer') + ' ' + at + ' ' + flag('--session'))
      state.asCopies.push(argv.includes('--copy'))
      const record = { v: 1, repo: flag('--repo'), pr: Number(flag('--pr')), head: flag('--head'), kind: flag('--kind'), result: flag('--result'), producer: flag('--producer'), detail: flag('--detail'), session: flag('--session'), at }
      put(RECORDS + '/' + record.repo + '/' + record.head + '/' + record.kind + '.' + at.replace(/[-:]/g, '') + '.' + record.producer + '.json', JSON.stringify(record), T0 + 10 * TICK_MS)
      return done('written')
    }
    const request = fieldsOf(JSON.parse(e.init?.stdin ?? '{}')) ?? {}
    const args = fieldsOf(request['args']) ?? {}
    const command = String(request['command'] ?? '')
    state.runs.push(command + (args['head-only'] ? ' head' : '') + (args['state'] ? ' ' + String(args['state']) : ''))
    if (command === 'pr-panel') {
      state.listedRepos.push(String(request['repo']))
      if (state.panelFails !== undefined && (state.panelFailsRepo === undefined || state.panelFailsRepo === request['repo'])) return done('', 1, state.panelFails)
      return done(JSON.stringify({ rows: request['repo'] === 'acme/other' ? state.otherPulls : state.pulls, ...(state.archived && request['repo'] === 'acme/app' ? { archived: true } : {}), ...(over.viewer ? { viewer: over.viewer } : {}), rate: { remaining: state.remaining, resetAt: state.resetAt, cost: 1 } }))
    }
    const pull = state.pulls.find((p) => p.number === Number(args['pr']))
    if (command === 'pr-gate' && state.gateFails) return done('', 1, 'gh: HTTP 502')
    if (command === 'pr-gate' && pull) {
      return done(JSON.stringify({
        repo: 'acme/app', pr: pull.number, state: 'open', draft: pull.draft, head: pull.head, labels: pull.labels, commits: 1, base: pull.base, stacked: false,
        ...mergeableOf(pull.mergeable),
        ci: { result: pull.rollup === 'SUCCESS' ? 'SUCCESS' : 'PENDING', failed: [], running: pull.rollup === 'SUCCESS' ? 0 : 1, skipped: [], total: 1, checks: [{ name: 'ci', bucket: 'pass' }] },
      }))
    }
    if (command === 'pr-readiness' && state.readinessFails) return done('', 1, 'gh: HTTP 403 label')
    if (command === 'pr-readiness' && pull) {
      state.duringReadiness?.()
      state.duringReadiness = undefined
      pull.labels = [...pull.labels.filter((l) => !['ready', 'not ready'].includes(l.toLowerCase())), args['state'] === 'ready' ? 'Ready' : 'Not Ready']
      state.labelled.push(pull.number + ' ' + String(args['state']))
      state.order.push('label ' + String(args['state']))
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

// The review and E2E records passing at HEAD, so that the pull request is ready on its records alone.
const passingRecords = (): Record<string, string> => Object.fromEntries(['review', 'e2e'].map((kind) => [
  RECORDS + '/acme/app/' + HEAD + '/' + kind + '.20261119T090000Z.p-' + kind + '.json',
  JSON.stringify({ v: 1, repo: 'acme/app', pr: 7, head: HEAD, kind, result: 'pass', producer: 'p-' + kind, detail: '', session: '', at: '2026-11-19T09:00:00Z' }),
]))

test('a Ready pull request whose base moves into conflict is gated at the next listing, and Ready leaves', async ($, on) => {
  const { clock, state } = await started($, on, {
    pulls: [{ number: 7, draft: false, head: HEAD, base: 'main', labels: ['Ready'], rollup: 'SUCCESS', mergeable: 'MERGEABLE', mergeState: 'CLEAN' }],
    files: passingRecords(),
  })
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  expect(state.pulls[0]?.labels).toEqual(['Ready'])
  // Only the listed mergeability changes: the head, the base, the labels and the CI are the same.
  const pull = state.pulls[0]
  if (pull) {
    pull.mergeable = 'CONFLICTING'
    pull.mergeState = 'DIRTY'
  }
  await clock.advance(IDLE_MAX_MS)
  await clock.settle()
  expect(count(state.runs, 'pr-gate')).toBe(2)
  expect(state.pulls[0]?.labels).toEqual(['Not Ready'])
  expect(state.labelled).toContain('7 not-ready')
})

test('a mergeability GitHub computes lazily is read again at the next beat once it settles', async ($, on) => {
  const { clock, state } = await started($, on, {
    pulls: [{ number: 7, draft: false, head: HEAD, base: 'main', labels: ['Not Ready'], rollup: 'SUCCESS', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN', statuses: [] }],
    files: passingRecords(),
    // The listing names its account: the forge's statuses are imported, so the listing counts for the Not Ready's wait.
    viewer: 'operator',
  })
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  // Still unknown: the listing is read at each beat, and the same fingerprint reads no gate.
  await beat(clock, 2)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  const pull = state.pulls[0]
  if (pull) {
    pull.mergeable = 'MERGEABLE'
    pull.mergeState = 'CLEAN'
  }
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(2)
  expect(state.pulls[0]?.labels).toEqual(['Ready'])
  expect(state.labelled).toContain('7 ready')
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

test('two failures that alternate are each said once, not again at every turn', async ($, on) => {
  const { clock, state, put } = await started($, on)
  const reasons = ['gh: HTTP 502', 'gh: HTTP 504']
  // A producer touches the edge marker before each beat: the repository is listed at every beat, and fails by turns.
  for (let i = 0; i < 6; i++) {
    state.panelFails = reasons[i % 2]
    put(EDGE, '', T0 + (i + 1) * TICK_MS - 1)
    await beat(clock)
  }
  expect(count(state.runs, 'pr-panel')).toBe(6)
  for (const reason of reasons) expect(state.said.filter((line) => line.includes('could not list acme/app: ' + reason))).toHaveLength(1)
})

const TRACEBACK = (last: string) => 'Traceback (most recent call last):\n  File "/x/engine/gh.py", line 10, in <module>\n    main()\n' + last
const OFFLINE_LINE = 'the reconciler cannot reach GitHub'

test('an unreachable forge is one line for the machine, and the beat lists no repository after the first', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const { clock, state } = await started($, on, { other: [other] })
  state.panelFails = TRACEBACK('socket.gaierror: [Errno 8] nodename nor servname provided, or not known')
  await beat(clock)
  expect(state.listedRepos).toEqual(['acme/app'])
  const lines = state.said.filter((line) => line.includes(OFFLINE_LINE))
  expect(lines).toEqual(['github: the reconciler cannot reach GitHub (socket.gaierror: [Errno 8] nodename nor servname provided, or not known); listings resume when it answers'])
  expect(state.said.filter((line) => line.includes('could not list'))).toEqual([])
  expect(state.said.some((line) => line.includes('Traceback'))).toBe(false)
  // The next beats keep saying nothing more, whichever repository is tried.
  await beat(clock, 3)
  expect(state.said.filter((line) => line.includes(OFFLINE_LINE))).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not list'))).toEqual([])
})

test('the engine call\'s own timeout is an unreachable forge too: one line, no listing after the first', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const { clock, state } = await started($, on, { other: [other] })
  state.panelFails = 'github: $.process.run(python3) aborted: still running after 120000ms'
  await beat(clock)
  expect(state.listedRepos).toEqual(['acme/app'])
  expect(state.said.filter((line) => line.includes(OFFLINE_LINE + ' ($.process.run(python3) aborted: still running after 120000ms)'))).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not list'))).toEqual([])
})

test('an unreachable forge said once is said again when a listing went through between two outages', async ($, on) => {
  const { clock, state, put } = await started($, on)
  const outage = () => state.said.filter((line) => line.includes(OFFLINE_LINE)).length
  const edge = async (n: number) => {
    put(EDGE, '', T0 + n * TICK_MS - 1)
    await beat(clock)
  }
  state.panelFails = TRACEBACK('socket.gaierror: [Errno 8] nodename nor servname provided, or not known')
  await edge(1)
  await edge(2)
  expect(outage()).toBe(1)
  state.panelFails = undefined
  await edge(3)
  expect(outage()).toBe(1)
  state.panelFails = TRACEBACK('socket.gaierror: [Errno 8] nodename nor servname provided, or not known')
  await edge(4)
  expect(outage()).toBe(2)
})

test('an outage under a touched marker retries the failing repository on its back-off, and lists the next one once its schedule comes', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const { clock, state, put } = await started($, on, { other: [other] })
  // Both repositories listed at idle intervals that have doubled: neither is due on its own schedule at the beats that follow.
  await beat(clock, 4)
  const before = state.listedRepos.length
  expect(state.listedRepos.filter((repo) => repo === 'acme/other')).toHaveLength(3)
  // A producer touches the marker while GitHub does not answer: the first repository fails, the second is not tried.
  put(EDGE, '', T0 + 5 * TICK_MS - 1)
  state.panelFails = TRACEBACK('socket.gaierror: [Errno 8] nodename nor servname provided, or not known')
  await beat(clock, 3)
  // The marker is still newer than at the first beat, yet the failing repository is not retried at every beat.
  expect(state.listedRepos.slice(before)).toEqual(['acme/app'])
  state.panelFails = undefined
  await beat(clock)
  expect(state.listedRepos.slice(before + 1)).toEqual(['acme/other'])
})

for (const reason of [
  'urllib.error.URLError: <urlopen error [Errno 111] Connection refused>',
  'ConnectionResetError: [Errno 54] Connection reset by peer',
  'OSError: [Errno 51] Network is unreachable',
  'OSError: [Errno 65] No route to host',
  'socket.gaierror: [Errno -2] Name or service not known',
  'socket.gaierror: [Errno -3] Temporary failure in name resolution',
  'TimeoutError: _ssl.c:1112: The handshake operation timed out',
  'TimeoutError: timed out',
]) {
  test('a reason that shows the forge cannot be reached says one line for the machine: ' + reason, async ($, on) => {
    const { clock, state } = await started($, on)
    state.panelFails = TRACEBACK(reason)
    await beat(clock)
    expect(state.said.filter((line) => line.includes(OFFLINE_LINE + ' (' + reason + ')'))).toHaveLength(1)
    expect(state.said.filter((line) => line.includes('could not list'))).toEqual([])
  })
}

test('a traceback whose earlier lines name a timeout is no outage: only its last line tells', async ($, on) => {
  const { clock, state } = await started($, on)
  state.panelFails = 'Traceback (most recent call last):\n  File "x.py", line 3, in fetch  # timed out? handshake gaierror\nKeyError: \'rows\''
  await beat(clock)
  expect(state.said).toContain('github: the reconciler could not list acme/app: KeyError: \'rows\'')
  expect(state.said.some((line) => line.includes(OFFLINE_LINE))).toBe(false)
})

test('a failure that is no outage keeps its line for the repository, cut to the last line of its traceback', async ($, on) => {
  const { clock, state } = await started($, on)
  state.panelFails = TRACEBACK('ValueError: the listing is not JSON')
  await beat(clock)
  const lines = state.said.filter((line) => line.includes('could not list acme/app'))
  expect(lines).toEqual(['github: the reconciler could not list acme/app: ValueError: the listing is not JSON'])
  expect(state.said.some((line) => line.includes(OFFLINE_LINE))).toBe(false)
})

test('a reason longer than a line is bounded', async ($, on) => {
  const { clock, state } = await started($, on)
  state.panelFails = 'error: ' + 'x'.repeat(1000)
  await beat(clock)
  const [line] = state.said.filter((said) => said.includes('could not list acme/app'))
  expect(line?.length ?? 0).toBeLessThan(300)
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

test('a record written while the gate moves the label reads the gate again at the next beat', async ($, on) => {
  const { clock, state, put } = await started($, on)
  state.duringReadiness = () => put(RECORDS + '/acme/app/' + HEAD + '/e2e.y.json', '{}', T0 + TICK_MS)
  await beat(clock)
  expect(state.labelled).toEqual(['7 not-ready'])
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(2)
})

// The reconciler's events in the github journal, by path order (their ids start with their time).
const journaled = (files: Map<string, { text: string }>) => [...files.keys()].filter((path) => path.startsWith(CFG + '/github/journal/')).sort()
  .map((path) => parseAuditEvent(JSON.parse(files.get(path)?.text ?? 'null')))

// The lease's counts, which every journaled event adds up to once it is written.
const leaseCounts = (files: Map<string, { text: string }>) => {
  const { ticks, listings, gates, moves } = JSON.parse(files.get(LEASE)?.text ?? '{}').counts ?? {}
  return { ticks, listings, gates, moves }
}
// Beats one at a time until the journal holds `n` events, at most `max` beats: the lease then holds what the last one counted.
const beatUntil = async (clock: MockClock, files: Map<string, { text: string }>, n: number, max: number) => {
  for (let i = 0; i < max && journaled(files).length < n; i++) await beat(clock)
  return journaled(files)
}
const summed = (events: ReturnType<typeof journaled>) => events.reduce((sum, event) => {
  const fact = event?.kind === 'reconcile' ? event.fact : { ticks: 0, listings: 0, gates: 0, moves: 0 }
  return { ticks: sum.ticks + fact.ticks, listings: sum.listings + fact.listings, gates: sum.gates + fact.gates, moves: sum.moves + fact.moves }
}, { ticks: 0, listings: 0, gates: 0, moves: 0 })

test('the lease renewals of an hour journal one event for telemetry\'s sweep, the hour after the summed counts since', async ($, on) => {
  const { clock, files } = await started($, on)
  await beat(clock, 3)
  expect(journaled(files)).toEqual([])
  // Taken at the first beat for LEASE_MS, renewed at the fourth with under LEASE_RENEW_MS left: the first three beats go.
  await beat(clock)
  expect(journaled(files).map((event) => [event?.kind, event?.source, event?.context.session, event?.fact])).toEqual([
    ['reconcile', { plugin: 'github', code: 'github.reconcile.counts' }, 'session-r', { ticks: 3, listings: 3, gates: 1, moves: 1 }],
  ])
  // Renewed every three beats for an hour: nothing more journaled.
  await beat(clock, JOURNAL_EVERY_MS / TICK_MS - 1)
  expect(journaled(files)).toHaveLength(1)
  const events = await beatUntil(clock, files, 2, 3)
  expect(events).toHaveLength(2)
  expect(summed(events)).toEqual(leaseCounts(files))
})

test('an hour with no forge call journals nothing; its beats go with the next event', async ($, on) => {
  const resetAt = new Date(T0 + 3 * JOURNAL_EVERY_MS).toISOString()
  const { clock, files, state } = await started($, on, { remaining: QUOTA_LOW - 1, resetAt })
  await beat(clock, 4)
  expect(journaled(files).map((event) => event?.fact)).toEqual([{ ticks: 3, listings: 1, gates: 0, moves: 0 }])
  // The quota waits for its reset, three hours on: no listing, no gate, nothing journaled.
  await beat(clock, 3 * JOURNAL_EVERY_MS / TICK_MS - 4)
  expect(journaled(files)).toHaveLength(1)
  state.remaining = 4000
  const events = await beatUntil(clock, files, 2, 6)
  expect(events).toHaveLength(2)
  expect(events[1]?.kind === 'reconcile' && events[1].fact.ticks).toBeGreaterThan(3 * JOURNAL_EVERY_MS / TICK_MS - 10)
  expect(summed(events)).toEqual(leaseCounts(files))
})

// ---- the forge's copies (forge-sync.ts) ----

const reviewAt = (at: string, result = 'pass', producer = 'orchestrator') => JSON.stringify({
  v: 1, repo: 'acme/app', pr: 7, head: HEAD, kind: 'review', result, producer, detail: '', session: 's', at,
})
const status = (context: string, state: string, description: string, creator = 'operator'): Status => ({ context, state, description, creator })
const PLAN = '/data/github/check-plans/acme/app/7.json'
// A check plan of this machine, the vehicle of the reconciler's posts: a record's status is posted by its tool, never here.
const planOf = (pr: number, repo = 'acme/app') => '/data/github/check-plans/' + repo + '/' + pr + '.json'
const planAt = (at: string, pr = 7, repo = 'acme/app') => JSON.stringify({
  v: 1, repo, pr, e2e: { need: 'required', reason: '' }, norms: { need: 'none', reason: 'docs' }, review: { need: 'required', reason: '', max: 2 }, at,
})
const pullWith = (statuses: Status[]): Pull[] => [{ number: 7, draft: false, head: HEAD, base: 'main', labels: [], rollup: 'SUCCESS', statuses }]

test('a record the other machine posted is copied here before the gate reads it', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  expect(state.copied).toEqual(['review pass orchestrator 2026-11-19T09:00:00Z forge'])
  expect(state.runs.slice(0, 3)).toEqual(['pr-panel', 'record.py', 'pr-gate'])
  expect(state.posted).toEqual([])
  await beat(clock, 3)
  expect(state.copied).toHaveLength(1)
})

test('a record the other machine posted is written here as a copy, which keeps the record of that name its tool wrote in between', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  expect(state.asCopies).toEqual([true])
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

test('a record this machine holds newer than the forge\'s is not posted over it: its tool posted it before writing it', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T08:00:00Z pass orchestrator')])
  const files = { [RECORDS + '/acme/app/' + HEAD + '/review.a.json']: reviewAt('2026-11-19T09:00:00Z', 'fail') }
  const { clock, state } = await started($, on, { pulls, files, viewer: 'operator' })
  await beat(clock, 4)
  expect([state.posted, state.copied]).toEqual([[], []])
})

test('a post refused is said once and tried again after RETRY_MS', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  await beat(clock, RETRY_MS / TICK_MS - 1)
  expect(state.posted).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7'))).toHaveLength(1)
  state.postFails = false
  await beat(clock)
  expect(state.posted).toHaveLength(2)
})

test('a post refused because the repository is archived stops the reconciler on it: no more posts, listings or gates, said once', async ($, on) => {
  const second = { number: 8, draft: false, head: 'd'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const pulls = [...pullWith([]), second]
  const files = {
    [PLAN]: planAt('2026-11-19T09:00:00Z'),
    [planOf(8)]: planAt('2026-11-19T09:00:00Z', 8),
  }
  const { clock, state } = await started($, on, { pulls, files, viewer: 'operator' })
  state.postFails = true
  state.postRefusal = 'error: cannot post readiness/plan at aaaaaaa: Repository was archived so is read-only.'
  await beat(clock)
  // The first refusal ends the beat for the repository: the second pull request is not posted, nor a gate read.
  expect(state.posted).toHaveLength(1)
  expect(count(state.runs, 'pr-gate')).toBe(0)
  const listed = count(state.runs, 'pr-panel')
  await beat(clock, 2 * RETRY_MS / TICK_MS)
  await clock.advance(IDLE_MAX_MS)
  await clock.settle()
  expect(state.posted).toHaveLength(1)
  expect(count(state.runs, 'pr-panel')).toBe(listed)
  expect(count(state.runs, 'pr-gate')).toBe(0)
  expect(state.labelled).toEqual([])
  expect(state.said.filter((line) => line.includes('acme/app') && line.includes('archived'))).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not post'))).toHaveLength(0)
})

test('two posts of one pull request that keep failing are each said once, over many retries', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z'), ['/data/github/e2e-exempt/acme/app.json']: JSON.stringify({ v: 1, repo: 'acme/app', exempt: true, paths: ['docs/**'], labels: [], detail: '« docs only », 2026-11-19', session: 's', at: '2026-11-19T09:00:00Z' }) }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock, 3 * RETRY_MS / TICK_MS + 1)
  // Each retry posts again (plan and exemption), and says nothing new.
  expect(state.posted.length).toBeGreaterThanOrEqual(6)
  expect(state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7'))).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not post readiness/exemption of acme/app#7'))).toHaveLength(1)
})

test('a failure that recovers is said again when it fails again, though another failure keeps speaking at every beat', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state, put } = await started($, on, { pulls: pullWith([]), other: [other], files, viewer: 'operator' })
  // acme/other fails to list at every beat (the edge marker wakes each listing), acme/app's post fails, goes through, then fails again.
  state.panelFails = 'gh: HTTP 502'
  state.panelFailsRepo = 'acme/other'
  state.postFails = true
  const edge = async (n: number) => {
    put(EDGE, '', T0 + n * TICK_MS - 1)
    await beat(clock)
  }
  const posting = (n: number) => state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7')).length === n
  for (let n = 1; n <= RETRY_MS / TICK_MS + 1; n++) await edge(n)
  expect(posting(1)).toBe(true)
  state.postFails = false
  const first = RETRY_MS / TICK_MS + 2
  for (let n = first; n < first + RETRY_MS / TICK_MS; n++) await edge(n)
  const posted = state.posted.length
  // A newer plan of this machine is due on the forge, and its post is refused again, as before.
  put(PLAN, planAt('2026-11-19T09:30:00Z'), T0 + 40 * TICK_MS)
  state.postFails = true
  await edge(first + RETRY_MS / TICK_MS)
  expect(state.posted.length).toBeGreaterThan(posted)
  expect(posting(2)).toBe(true)
  expect(state.said.filter((line) => line.includes('could not list acme/other: gh: HTTP 502'))).toHaveLength(1)
})

test('a repository the forge lists as archived is left alone: no post, no gate, no label, no second listing, said once', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.archived = true
  await beat(clock, 3 * RETRY_MS / TICK_MS)
  await clock.advance(IDLE_MAX_MS)
  await clock.settle()
  expect(state.posted).toEqual([])
  expect(count(state.runs, 'pr-panel')).toBe(1)
  expect(count(state.runs, 'pr-gate')).toBe(0)
  expect(state.labelled).toEqual([])
  expect(state.said.filter((line) => line.includes('acme/app') && line.includes('archived'))).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not'))).toHaveLength(0)
})

test('the posts a repository had waiting are not tried again once the forge lists it as archived, said once', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state, put } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  expect(state.posted).toHaveLength(1)
  expect(state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7'))).toHaveLength(1)
  // The repository is archived meanwhile: the edge marker wakes a listing, which says so.
  const gates = count(state.runs, 'pr-gate')
  state.archived = true
  put(EDGE, '', T0 + 2 * TICK_MS)
  await beat(clock)
  const posted = state.posted.length
  const listed = count(state.runs, 'pr-panel')
  await beat(clock, 3 * RETRY_MS / TICK_MS)
  expect(state.posted).toHaveLength(posted)
  expect(count(state.runs, 'pr-panel')).toBe(listed)
  expect(count(state.runs, 'pr-gate')).toBe(gates)
  expect(state.said.filter((line) => line.includes('acme/app') && line.includes('archived'))).toHaveLength(1)
})

test('the other repositories go on when the forge lists one as archived: still listed, still posted to', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const files = {
    [PLAN]: planAt('2026-11-19T09:00:00Z'),
    [planOf(9, 'acme/other')]: planAt('2026-11-19T09:00:00Z', 9, 'acme/other'),
  }
  const { clock, state } = await started($, on, { pulls: pullWith([]), other: [other], files, viewer: 'operator' })
  state.archived = true
  await beat(clock)
  expect(state.postedRepos).toEqual(['acme/other'])
  state.listedRepos.length = 0
  await beat(clock, 12)
  expect(state.listedRepos.length).toBeGreaterThan(0)
  expect(state.listedRepos.every((repo) => repo === 'acme/other')).toBe(true)
})

test('a repository found archived stays left alone after the session restarts, its line unsaid again', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.archived = true
  await beat(clock)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await beat(clock, 3)
  expect(count(state.runs, 'pr-panel')).toBe(1)
  expect(state.posted).toEqual([])
  expect(state.said.filter((line) => line.includes('acme/app') && line.includes('archived'))).toHaveLength(1)
})

test('a repository found archived by a refused post leaves no failing marker for the tools of the sessions', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state, files: written } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  state.postRefusal = 'error: cannot post readiness/plan at aaaaaaa: Repository was archived so is read-only.'
  await beat(clock, 3)
  expect(written.has(FAILING)).toBe(false)
})

test('a failure said before the session restarts (resume, clear, compact) is not said again', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await beat(clock, 2 * RETRY_MS / TICK_MS)
  expect(state.posted.length).toBeGreaterThanOrEqual(2)
  expect(state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7'))).toHaveLength(1)
})

test('a post failing another way is said again, once', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  await beat(clock, RETRY_MS / TICK_MS + 1)
  state.postRefusal = 'error: cannot post: HTTP 502'
  await beat(clock, 2 * RETRY_MS / TICK_MS)
  const said = state.said.filter((line) => line.includes('could not post readiness/plan of acme/app#7'))
  expect(said).toHaveLength(2)
  expect(said[0]).toContain('HTTP 403')
  expect(said[1]).toContain('HTTP 502')
})

test('a refusal that only names "archived" is no archive: the post is tried again after RETRY_MS', async ($, on) => {
  const files = { [PLAN]: planAt('2026-11-19T09:00:00Z') }
  const { clock, state } = await started($, on, { pulls: pullWith([]), files, viewer: 'operator' })
  state.postFails = true
  state.postRefusal = 'error: HTTP 502 from the proxy of archived-mirror.example'
  await beat(clock)
  await beat(clock, RETRY_MS / TICK_MS)
  expect(state.posted).toHaveLength(2)
})

test('the other repositories go on when one is archived: still listed, still posted to', async ($, on) => {
  const other = { number: 9, draft: false, head: 'e'.repeat(40), base: 'main', labels: [] as string[], rollup: 'SUCCESS', statuses: [] as Status[] }
  const files = {
    [PLAN]: planAt('2026-11-19T09:00:00Z'),
    [planOf(9, 'acme/other')]: planAt('2026-11-19T09:00:00Z', 9, 'acme/other'),
  }
  const { clock, state } = await started($, on, { pulls: pullWith([]), other: [other], files, viewer: 'operator' })
  state.postFails = true
  state.postFailsRepo = 'acme/app'
  state.postRefusal = 'error: cannot post readiness/plan at aaaaaaa: Repository was archived so is read-only.'
  await beat(clock)
  expect(state.postedRepos.sort()).toEqual(['acme/app', 'acme/other'])
  state.listedRepos.length = 0
  await beat(clock, 12)
  expect(state.listedRepos.length).toBeGreaterThan(0)
  expect(state.listedRepos.every((repo) => repo === 'acme/other')).toBe(true)
})

test('no more than POSTS_PER_TICK statuses are posted at one beat, the others at the next', async ($, on) => {
  const numbers = Array.from({ length: POSTS_PER_TICK + 2 }, (_, i) => i + 1)
  const headOf = (n: number) => n.toString(16).padStart(40, 'c')
  const pulls = numbers.map((number) => ({ number, draft: false, head: headOf(number), base: 'main', labels: [], rollup: 'SUCCESS', statuses: [] }))
  const files = Object.fromEntries(numbers.map((number) => [planOf(number), planAt('2026-11-19T09:00:00Z', number)]))
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

test('a plan this machine just wrote is posted at the first listing, left to no tool', async ($, on) => {
  const { clock, state } = await started($, on, { pulls: pullWith([]), files: { [PLAN]: planAt(new Date(T0 + TICK_MS).toISOString().replace(/\.\d+Z$/, 'Z')) }, viewer: 'operator' })
  await beat(clock)
  expect(state.posted).toEqual(['plan a v1 2026-11-19T10:01:00Z e2e=required norms=none review=required/2'])
})

const EXEMPTION = '/data/github/e2e-exempt/acme/app.json'
const exemptionAt = (at: string, detail = '« docs only », 2026-11-19') =>
  JSON.stringify({ v: 1, repo: 'acme/app', exempt: true, paths: ['docs/**'], labels: [], detail, session: 's', at })

test('an exemption the other machine posted is written here before the gate reads it, its words left there', async ($, on) => {
  const pulls = pullWith([status('readiness/exemption', 'success', 'v1 2026-11-19T09:00:00Z {"e":true,"p":["docs/**"],"l":[]}')])
  const { clock, state, files } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  const exemption = JSON.parse(files.get(EXEMPTION)?.text ?? '{}')
  expect([exemption.exempt, exemption.paths, exemption.at, exemption.detail]).toEqual([true, ['docs/**'], '2026-11-19T09:00:00Z', 'copied from the forge, posted by operator'])
  expect(state.posted).toEqual([])
  expect(count(state.runs, 'pr-gate')).toBe(1)
})

test('this machine\'s exemption is posted where the forge lacks it', async ($, on) => {
  const { clock, state } = await started($, on, { pulls: pullWith([]), viewer: 'operator', files: { [EXEMPTION]: exemptionAt('2026-11-19T09:00:00Z') } })
  await beat(clock)
  expect(state.posted).toEqual(['exemption a v1 2026-11-19T09:00:00Z {"e":true,"p":["docs/**"],"l":[]}'])
})

test('an exemption too long for the forge is said once and never posted', async ($, on) => {
  const long = JSON.stringify({ v: 1, repo: 'acme/app', exempt: true, paths: Array.from({ length: 12 }, (_, i) => 'docs/part-' + i + '/**'), labels: [], detail: '« ok », 2026-11-19', session: 's', at: '2026-11-19T09:00:00Z' })
  const { clock, state } = await started($, on, { pulls: pullWith([]), viewer: 'operator', files: { [EXEMPTION]: long } })
  await beat(clock, 3)
  expect(state.posted).toEqual([])
  expect(state.said.filter((line) => line.includes('E2E exemption of acme/app is too long for the forge'))).toHaveLength(1)
})

test('two machines in lasting disagreement: after FLAP_UNDONE undos this one stops moving the label and says so once', async ($, on) => {
  const { clock, state } = await started($, on)
  const pull = state.pulls[0]
  // The other machine puts Ready back after each of this one's moves: this one reads the pull request as missing records.
  for (let i = 0; i < 2 * FLAP_UNDONE + 4; i++) {
    await beat(clock)
    if (pull) pull.labels = ['Ready']
    await clock.advance(IDLE_MAX_MS)
    await clock.settle()
  }
  expect(state.labelled).toHaveLength(FLAP_UNDONE + 1)
  const flapLines = state.said.filter((line) => line.includes('put back'))
  expect(flapLines).toHaveLength(1)
  expect(flapLines[0]).toContain('acme/app#7')
})

test('a label write that fails counts no undo: the label is put back once the write goes through', async ($, on) => {
  const { clock, state } = await started($, on)
  const pull = state.pulls[0]
  await beat(clock)
  expect(state.labelled).toHaveLength(1)
  // The other machine takes the label away; this one's writes then fail for far longer than FLAP_UNDONE retries.
  if (pull) pull.labels = ['Ready']
  state.readinessFails = true
  for (let i = 0; i < 2 * FLAP_UNDONE + 2; i++) {
    await clock.advance(RETRY_MS)
    await clock.settle()
  }
  state.readinessFails = false
  await clock.advance(RETRY_MS)
  await clock.settle()
  expect(state.labelled).toHaveLength(2)
  expect(state.said.filter((line) => line.includes('put back'))).toHaveLength(0)
})

// A record this machine wrote at the first beat's instant, its status posted by its tool before it was written.
const FRESH = new Date(T0 + TICK_MS).toISOString().replace(/\.\d+Z$/, 'Z')
const freshRecord = (kind: string, result: string) => ({
  [RECORDS + '/acme/app/' + HEAD + '/' + kind + '.a.json']:
    JSON.stringify({ v: 1, repo: 'acme/app', pr: 7, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: 's', at: FRESH }),
})
const readyPull = (labels: string[], rollup = 'SUCCESS'): Pull[] => [{ number: 7, draft: false, head: HEAD, base: 'main', labels, rollup, statuses: [] }]

test('a fail written here moves the label to Not Ready at the first beat, the reconciler posting nothing and holding nothing', async ($, on) => {
  const files = { ...freshRecord('review', 'fail'), ...freshRecord('e2e', 'pass') }
  const { clock, state } = await started($, on, { pulls: readyPull(['Ready']), files, viewer: 'operator' })
  await beat(clock)
  expect([state.order, state.posted]).toEqual([['label not-ready'], []])
})

test('a pass written here moves the label to Ready at the first beat, the reconciler posting nothing and holding nothing', async ($, on) => {
  const files = { ...freshRecord('review', 'pass'), ...freshRecord('e2e', 'pass') }
  const { clock, state } = await started($, on, { pulls: readyPull([]), files, viewer: 'operator' })
  await beat(clock)
  expect([state.order, state.posted]).toEqual([['label ready'], []])
})

test('a pass written here holds no move to Not Ready', async ($, on) => {
  const { clock, state } = await started($, on, { pulls: readyPull(['Ready'], 'PENDING'), files: freshRecord('review', 'pass'), viewer: 'operator' })
  await beat(clock)
  expect(state.order).toEqual(['label not-ready'])
})

test('a Not Ready this machine did not set stays until the forge was read FOREIGN_WAIT_MS after it was first seen, then the gate decides as before', async ($, on) => {
  const { clock, state, files } = await started($, on, { pulls: readyPull(['Not Ready']), files: passingRecords(), viewer: 'operator' })
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  expect(state.labelled).toEqual([])
  // Held back: no gate read while it waits, then the forge listed once the wait is over, and the gate decides as before.
  await beat(clock)
  expect(count(state.runs, 'pr-gate')).toBe(1)
  expect(count(state.runs, 'pr-panel')).toBe(2)
  await beat(clock)
  expect(count(state.runs, 'pr-panel')).toBe(3)
  expect(state.labelled).toEqual(['7 ready'])
  expect(state.runs.filter((run) => run === 'pr-gate')).toHaveLength(2)
  expect(parseReconcile(files.get(READING)?.text ?? '')?.labels).toEqual(['Ready'])
  expect(FOREIGN_WAIT_MS).toBe(2 * TICK_MS)
})

test('the other machine\'s fail, posted before its Not Ready, is copied at once, and the label stays after the wait: the gate judges against it', async ($, on) => {
  const pulls = readyPull(['Not Ready'])
  const row = pulls[0]
  if (row) row.statuses = [status('readiness/review', 'failure', 'v1 2026-11-19T10:00:30Z fail orchestrator')]
  const { clock, state } = await started($, on, { pulls, files: passingRecords(), viewer: 'operator' })
  await beat(clock, 6)
  expect(state.copied).toEqual(['review fail orchestrator 2026-11-19T10:00:30Z forge'])
  expect(state.labelled).toEqual([])
  expect(state.pulls[0]?.labels).toEqual(['Not Ready'])
})

test('a Not Ready this machine set is undone by the gate at once, with no wait', async ($, on) => {
  const { clock, state, put } = await started($, on)
  await beat(clock)
  expect(state.labelled).toEqual(['7 not-ready'])
  for (const [path, text] of Object.entries(passingRecords())) put(path, text, T0 + 2 * TICK_MS)
  await beat(clock)
  expect(state.labelled).toEqual(['7 not-ready', '7 ready'])
})

test('a Not Ready this machine did not set stays while the forge only holds what this machine already knew, and goes at the first listing after the wait when the forge brings the missing pass', async ($, on) => {
  const pulls = readyPull(['Not Ready'])
  const row = pulls[0]
  // This machine holds the review pass; the other machine's E2E pass is on the forge alone.
  if (row) row.statuses = [status('readiness/e2e', 'success', 'v1 2026-11-19T09:30:00Z pass p-e2e')]
  const review = Object.entries(passingRecords()).filter(([path]) => path.includes('/review.'))
  const { clock, state } = await started($, on, { pulls, files: Object.fromEntries(review), viewer: 'operator' })
  await beat(clock)
  expect(state.copied).toEqual(['e2e pass p-e2e 2026-11-19T09:30:00Z forge'])
  expect(state.labelled).toEqual([])
  await beat(clock)
  expect(state.labelled).toEqual([])
  await beat(clock)
  expect(state.labelled).toEqual(['7 ready'])
})

test('a plan whose post is refused holds the move to Ready, the post tried again after RETRY_MS and the label moved once it reached the forge', async ($, on) => {
  const { clock, state } = await started($, on, { pulls: readyPull([]), files: { ...passingRecords(), [PLAN]: planAt('2026-11-19T09:00:00Z') }, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  await beat(clock, RETRY_MS / TICK_MS - 1)
  expect(state.posted).toHaveLength(1)
  expect(state.labelled).toEqual([])
  state.postFails = false
  await beat(clock)
  expect(state.order).toEqual(['post plan success', 'label ready'])
})

test('a post the forge refuses for good holds the label no longer than PUBLISH_WAIT_MS, and the move then goes with a line saying so', async ($, on) => {
  const { clock, state } = await started($, on, { pulls: readyPull([]), files: { ...passingRecords(), [PLAN]: planAt('2026-11-19T09:00:00Z') }, viewer: 'operator' })
  state.postFails = true
  await beat(clock, PUBLISH_WAIT_MS / TICK_MS - 1)
  expect(state.labelled).toEqual([])
  await beat(clock, 2)
  expect(state.labelled).toEqual(['7 ready'])
  expect(state.said.filter((line) => line.includes('no longer waits for readiness/plan'))).toHaveLength(1)
})

test('the listing is kept for the tools of the sessions once the forge\'s statuses are imported, not before', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state, files } = await started($, on, { pulls, viewer: 'operator' })
  await beat(clock)
  expect(state.copied).toHaveLength(1)
  expect(state.listedWhenCopied).toBe(false)
  expect(files.get(LISTED)?.text).toBe(String(T0 + TICK_MS) + '\n')
})

test('a forge status that cannot be imported leaves the kept listing as it was: the tools go on waiting for a listing', async ($, on) => {
  const pulls = pullWith([status('readiness/review', 'success', 'v1 2026-11-19T09:00:00Z pass orchestrator')])
  const { clock, state, files } = await started($, on, { pulls, viewer: 'operator' })
  state.copyFails = true
  await beat(clock, 2)
  expect(files.has(LISTED)).toBe(false)
  state.copyFails = false
  await beat(clock, RETRY_MS / TICK_MS)
  expect(state.copied).toHaveLength(1)
  expect(Number(files.get(LISTED)?.text)).toBeGreaterThan(T0 + 2 * TICK_MS)
})

test('a listing that cannot be kept is said once, and this machine\'s own gate still goes on it after the wait', async ($, on) => {
  const { clock, state, files } = await started($, on, { pulls: readyPull(['Not Ready']), files: passingRecords(), viewer: 'operator' })
  state.writeFails = /\.listed/
  await beat(clock, 3)
  expect(files.has(LISTED)).toBe(false)
  expect(state.said.filter((line) => line.includes('the listing of acme/app could not be kept'))).toHaveLength(1)
  expect(state.labelled).toEqual(['7 ready'])
})

test('records that cannot be read keep what the head waited to post: the move still waits for it', async ($, on) => {
  const records = passingRecords()
  const { clock, state, put } = await started($, on, { pulls: readyPull([]), files: { ...records, [PLAN]: planAt('2026-11-19T09:00:00Z') }, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  expect(state.posted).toHaveLength(1)
  // The records directory cannot be listed at the next sync, and a record changed: the head is read again, the gate reads it fine.
  state.listFails = RECORDS + '/acme/app/' + HEAD
  const [review, text] = Object.entries(records).find(([path]) => path.includes('/review.')) ?? ['', '']
  put(review, text, T0 + 5 * TICK_MS)
  await beat(clock)
  expect(state.said.filter((line) => line.includes('could not read the records of acme/app#7'))).toHaveLength(1)
  expect(count(state.runs, 'pr-gate')).toBeGreaterThan(1)
  expect(state.labelled).toEqual([])
})

test('a post the forge refuses does not hold back the kept listing: what the forge holds was imported', async ($, on) => {
  const { clock, state, files } = await started($, on, { pulls: readyPull(['Ready']), files: { [PLAN]: planAt('2026-11-19T09:00:00Z') }, viewer: 'operator' })
  state.postFails = true
  await beat(clock)
  expect(state.posted).toHaveLength(1)
  expect(files.get(LISTED)?.text).toBe(String(T0 + TICK_MS) + '\n')
})

test('a listing that names no account imports nothing: the kept listing is not renewed and the hold stays, past the ceiling', async ($, on) => {
  const { clock, state, files } = await started($, on, { pulls: readyPull(['Not Ready']), files: passingRecords() })
  await beat(clock, PUBLISH_WAIT_MS / TICK_MS + 3)
  expect(files.has(LISTED)).toBe(false)
  expect(files.get(FAILING)?.text).toMatch(/^\d+\n$/)
  expect(state.labelled).toEqual([])
})

test('a Not Ready this machine did not set stays past the ceiling while the import of the forge\'s statuses fails', async ($, on) => {
  const pulls = readyPull(['Not Ready'])
  const { clock, state, files } = await started($, on, { pulls, files: passingRecords(), viewer: 'operator' })
  await beat(clock)
  const imported = files.get(LISTED)?.text
  expect(imported).toBe(String(T0 + TICK_MS) + '\n')
  // The other machine's fail reaches the forge, and this machine cannot copy it from now on.
  state.copyFails = true
  const row = pulls[0]
  if (row) row.statuses = [status('readiness/review', 'failure', 'v1 2026-11-19T10:00:30Z fail orchestrator')]
  await beat(clock, PUBLISH_WAIT_MS / TICK_MS + 3)
  expect(state.copied).toEqual([])
  expect(files.get(LISTED)?.text).toBe(imported)
  expect(Number(files.get(FAILING)?.text)).toBeGreaterThan(Number(imported))
  expect(state.labelled).toEqual([])
  expect(state.pulls[0]?.labels).toEqual(['Not Ready'])
})
