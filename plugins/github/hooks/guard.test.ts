// The ready guard, the auto-merge split, the label following the head, the
// records guard and the record tool, through the module as the session runs
// it: the tool's calls, Bash, Write, and the engine stubbed per scenario.
import { expect, mock, test } from 'claude-code/testing'
import { ENFORCE_ENV, READY_PHASE, register } from './register.js'
import { RECORDS_REFUSAL, STDIN_REFUSAL } from './ready.js'

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '')
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED = 'fedcba9876543210fedcba9876543210fedcba98'
const RECORDS = '/cfg/pr-records'
const HEAD_DIR = RECORDS + '/acme/thing/' + HEAD
const WARN_LOG = '/data/guard-warn.log'
const AUTO_MERGE = '/data/auto-merge.json'
const ciUndraftFile = (repo: string, pr: number) => '/data/ci-undraft.' + encodeURIComponent(repo) + '.' + pr + '.json'

let sessions = 0

type World = {
  // pr-gate's answer: an object, raw text, or a failing exit with this stderr.
  gate?: any
  gateFails?: string
  // The line pr-gate and pr-checks print on stderr while they succeed (the Actions runs unread).
  readStderr?: string
  labels?: string[]
  ci?: Record<string, unknown>
  // The records at the head, by file name; omitted: the four pass.
  records?: Record<string, string>
  // pr-get's pull requests, by branch ('' for the current one).
  pulls?: Record<string, any[]>
  autoMerge?: string[]
  // The CI undrafts the plugin already made, one mark file each.
  ciUndrafts?: Array<{ repo: string; pr: number; head: string }>
  // git's answers, by its argv after git.
  git?: Record<string, { exitCode: number; stdout: string }>
  verdict?: any
  answer?: string
  // What the Bash tool answers.
  bashResult?: any
  // What record.py answers when it fails: its exit code and stderr.
  recordFails?: { exitCode: number; stderr: string }
  // guard-warn.log already there with this text, which $.fs cannot read back
  // (a file past what one read copies): only an append keeps it.
  warnLog?: string
  // The files and directories $.fs sees beside the records, by path.
  tree?: Record<string, { kind: 'file' | 'directory'; mtimeMs: number; text?: string }>
  // The move that puts a new auto-merge.json in place fails with this stderr.
  mvFails?: string
  // pr-readiness fails with this stderr.
  readinessFails?: string
  // Whether the pull request is a draft; omitted, it is one.
  draft?: boolean
  // The heads pr-gate answers, one per read, the last one repeated.
  heads?: string[]
  // The head's records directory is there but cannot be listed, with this error.
  listFails?: string
  // The branch whose pull request (#12) pr-get answers with its labels as they stand.
  branch?: string
  // Every git run fails in the host itself, with this error.
  gitThrows?: string
  // What pr-fingerprint answers, by head, over two commits; a head absent fails with this error, or a merge's.
  fingerprints?: Record<string, string>
  fingerprintFails?: string
  // The pull request's commit count pr-gate answers; omitted, none.
  commits?: number
  // A head directory that is there but cannot be listed.
  unlistable?: string
}

type Seen = {
  pull?: Pull
  runs: any[]; asked: string[]; logs: string[]; writes: Array<{ path: string; text: string }>; bash: string[]
  // guard-warn.log's text as the disk holds it, when the world starts with one.
  warnLog?: string
  // The files of the plugin's data directory, guard-warn.log apart, by path.
  files: Record<string, string>
  // The context each prompt entered with.
  contexts: string[][]
  // The paths $.fs read, in order.
  reads: string[]
}

function record(kind: string, result: string, at = '2026-11-01T10:00:00Z', over: Record<string, unknown> = {}): [string, string] {
  const name = kind + '.' + at.replace(/[-:]/g, '') + '.p-' + kind + '.json'
  const body = { v: 1, repo: 'acme/thing', pr: 12, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: '', at, ...over }
  return [name, JSON.stringify(body)]
}

const FOUR = Object.fromEntries([record('review', 'pass'), record('norms', 'pass'), record('e2e', 'pass')])

// The pull request's state as the engine leaves it: its labels and its draft move with pr-readiness and pr-draft.
type Pull = { labels: string[]; draft: boolean; reads: number }

function gateOf(w: World, pull?: Pull) {
  const heads = w.heads ?? [HEAD]
  const head = pull ? heads[Math.min(pull.reads++, heads.length - 1)] : HEAD
  return w.gate ?? {
    repo: 'acme/thing', pr: 12, state: 'open', draft: pull?.draft ?? w.draft ?? true, head, labels: pull?.labels ?? w.labels ?? ['Not Ready'],
    ...(w.commits === undefined ? {} : { commits: w.commits }),
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1, ...(w.ci ?? {}) },
  }
}

async function world($: any, on: any, w: World = {}): Promise<Seen> {
  const seen: Seen = { runs: [], asked: [], logs: [], writes: [], bash: [], warnLog: w.warnLog, files: {}, contexts: [], reads: [] }
  if (w.autoMerge !== undefined) seen.files[AUTO_MERGE] = JSON.stringify({ repositories: w.autoMerge })
  for (const m of w.ciUndrafts ?? []) seen.files[ciUndraftFile(m.repo, m.pr)] = JSON.stringify({ v: 1, ...m })
  const session = 'guard-session-' + ++sessions
  const records: Record<string, string> = { ...(w.records ?? FOUR) }
  const pull: Pull = { labels: [...(w.labels ?? ['Not Ready'])], draft: w.draft ?? true, reads: 0 }
  seen.pull = pull
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_PLUGIN_DATA: '/data', HOME: '/home/x' }
  const tree = w.tree ?? {}
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('tool.check', (_$: any, e: any) => (e.tool === 'AskUserQuestion' || e.tool === 'Read' ? { decision: 'allow' } : w.verdict ?? { decision: 'allow' }))
  on('tool.call', { tool: 'Read' }, (_$: any, e: any) =>
    ({ result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 222, startLine: 1, totalLines: 222 } } }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    seen.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: w.answer ?? 'Allow' } } }
  })
  on('tool.call', { tool: 'Bash' }, (_$: any, e: any) => {
    seen.bash.push(e.command)
    return w.bashResult ?? { result: { stdout: '', stderr: '', interrupted: false } }
  })
  for (const tool of ['Write', 'Edit', 'MultiEdit']) on('tool.call', { tool }, () => ({ result: 'written' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === ENFORCE_ENV ? (enforcing ? '1' : undefined) : env[e.name] }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('ui.log', (_$: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in tree || e.path in seen.files || (!!w.listFails && e.path === HEAD_DIR) }))
  on('fs.stat', (_$: any, e: any) => (e.path === WARN_LOG && seen.warnLog !== undefined
    ? { value: { kind: 'file', size: seen.warnLog.length, mtimeMs: 0, isLink: false } }
    : e.path in tree ? { value: { kind: tree[e.path].kind, size: 0, mtimeMs: tree[e.path].mtimeMs, isLink: false } } : { deny: 'ENOENT ' + e.path }))
  on('fs.list', (_$: any, e: any) => {
    if (e.path === HEAD_DIR && w.listFails) return { deny: w.listFails }
    if (e.path === w.unlistable) return { deny: 'EACCES ' + e.path }
    if (e.path === HEAD_DIR) {
      return { value: Object.keys(records).map((name) => ({ name, kind: 'file', size: 1, isLink: false })) }
    }
    const below = Object.keys(tree).filter((p) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
    if (e.path in tree) return { value: below.map((p) => ({ name: p.slice(e.path.length + 1), kind: tree[p].kind, size: 0, isLink: false })) }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.read', (_$: any, e: any) => {
    seen.reads.push(e.path)
    if (e.path in seen.files) return { value: seen.files[e.path] }
    if (tree[e.path]?.text !== undefined) return { value: tree[e.path].text }
    if (e.path.startsWith(HEAD_DIR + '/')) {
      const name = e.path.slice(HEAD_DIR.length + 1)
      if (name in records) return { value: records[name] }
    }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.write', (_$: any, e: any) => {
    seen.writes.push({ path: e.path, text: e.text })
    if (e.path === WARN_LOG && seen.warnLog !== undefined) seen.warnLog = e.text
    else if (e.path !== WARN_LOG && e.path.startsWith('/data/')) seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    if (e.argv.includes(WARN_LOG)) {
      seen.runs.push({ argv: e.argv })
      if (seen.warnLog !== undefined && /cat >> /.test(e.argv.join(' '))) seen.warnLog += String(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[0] === 'sh' && e.argv[2] === 'set -C; echo "$$" > "$1"') {
      // The list's lock, taken with noclobber: refused while the file is there.
      seen.runs.push({ argv: e.argv })
      const lock = e.argv[4]
      if (lock in seen.files || lock in tree) return { value: { exitCode: 1, stdout: '', stderr: 'sh: cannot overwrite existing file' } }
      seen.files[lock] = '4242\n'
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[0] === 'sleep') {
      seen.runs.push({ argv: e.argv })
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[0] === 'mv' || e.argv[0] === 'rm' || e.argv[0] === 'mkdir') {
      seen.runs.push({ argv: e.argv })
      const [from, to] = e.argv.slice(-2)
      if (e.argv[0] === 'mv') {
        if (w.mvFails) return { value: { exitCode: 1, stdout: '', stderr: w.mvFails } }
        seen.files[to] = seen.files[from]
        delete seen.files[from]
      }
      if (e.argv[0] === 'rm') {
        delete seen.files[to]
        delete tree[to]
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const stdin = JSON.parse(e.init?.stdin ?? '{}')
    seen.runs.push({ argv: e.argv, ...stdin })
    if (e.argv[0] === 'git' && w.gitThrows) return { deny: w.gitThrows }
    if (e.argv[0] === 'git') {
      const answer = w.git?.[e.argv.slice(1).join(' ')]
      return { value: answer ? { stderr: '', ...answer } : { exitCode: 1, stdout: '', stderr: 'no' } }
    }
    if (String(e.argv[1] ?? '').endsWith('/engine/record.py')) {
      if (w.recordFails) return { value: { stdout: '', ...w.recordFails } }
      // The record lands among the head's records, as its writer puts it there.
      const option = (name: string) => e.argv[e.argv.indexOf(name) + 1]
      const [name, text] = record(option('--kind'), option('--result'), '2026-11-02T10:00:00Z', { producer: 'session-e2e' })
      records[name] = text
      return { value: { exitCode: 0, stdout: HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json\n', stderr: '' } }
    }
    if (stdin.command === 'pr-gate') {
      if (w.gateFails) return { value: { exitCode: 3, stdout: '', stderr: w.gateFails } }
      const gate = gateOf(w, pull)
      return { value: { exitCode: 0, stdout: typeof gate === 'string' ? gate : JSON.stringify(gate), stderr: w.readStderr ?? '' } }
    }
    if (stdin.command === 'pr-fingerprint') {
      const fingerprint = w.fingerprints?.[stdin.args.head]
      if (!fingerprint) return { value: { exitCode: 1, stdout: '', stderr: w.fingerprintFails ?? 'error: commit 1234567 is a merge' } }
      return { value: { exitCode: 0, stdout: JSON.stringify({ head: stdin.args.head, commits: stdin.args.count ?? 2, fingerprint }), stderr: '' } }
    }
    if (stdin.command === 'pr-checks' && w.readStderr) return { value: { exitCode: 0, stdout: 'ok', stderr: w.readStderr } }
    if (stdin.command === 'pr-readiness' && w.readinessFails) return { value: { exitCode: 3, stdout: '', stderr: w.readinessFails } }
    if (stdin.command === 'pr-readiness') pull.labels = [stdin.args.state === 'ready' ? 'Ready' : 'Not Ready']
    if (stdin.command === 'pr-draft') pull.draft = true
    if (stdin.command === 'pr-get' && w.branch !== undefined && (stdin.args?.branch ?? '') === w.branch) {
      return { value: { exitCode: 0, stdout: JSON.stringify([{ number: 12, labels: pull.labels.map((name) => ({ name })) }]), stderr: '' } }
    }
    if (stdin.command === 'pr-get') {
      return { value: { exitCode: 0, stdout: JSON.stringify(w.pulls?.[stdin.args?.branch ?? ''] ?? []), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const name of ['commits.md', 'pull-requests.md', 'comments.md', 'references.md']) {
    await $.tool.call({ tool: 'Read', file_path: ROOT + '/engine/writing/' + name })
  }
  return seen
}

const gh = (command: string, args: Record<string, unknown>, repo = 'acme/thing') =>
  ({ tool: 'mcp__github__gh', command, args, repo }) as any
const bash = (command: string) => ({ tool: 'Bash', command }) as any
const commands = (seen: Seen) => seen.runs.map((r) => r.command ?? r.argv.join(' '))
const gates = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-gate').length
// No record at all: review, norms and E2E missing, CI green.
const NO_RECORDS = { records: {} }

// The enforce phase, brought forward through the environment as the tests of
// both phases need it: the module runs apart from the test, out of reach of a setter.
let enforcing = false

async function inPhase(phase: 'warn' | 'enforce', body: () => Promise<void>): Promise<void> {
  enforcing = phase === 'enforce'
  try {
    await body()
  } finally {
    enforcing = false
  }
}

test('this release ships the ready guard in its warn phase', () => {
  expect(READY_PHASE).toBe('warn')
})

// ---- the tool, warn phase ----

test('warn: a pr-ready that is not ready, in auto-merge, runs with no question and a warn line', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('github: pr-ready on acme/thing#12 is not ready')
  expect(seen.logs[0]).toContain('review: no record at 0123456, norms: no record at 0123456, e2e: no record at 0123456')
  const line = JSON.parse(seen.writes.find((w) => w.path === '/data/guard-warn.log')!.text.trim())
  expect(line.repo).toBe('acme/thing')
  expect(line.pr).toBe(12)
  expect(line.head).toBe(HEAD)
  expect(line.act).toBe('pr-ready')
  expect(line.route).toBe('tool')
  expect(line.missing.length).toBe(3)
  expect(typeof line.at).toBe('string')
  expect(line.session).toContain('guard-session-')
})

test('warn: refused by the person, the gate is read once, nothing runs and nothing is logged', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, answer: 'Deny', autoMerge: ['acme/thing'], verdict: { decision: 'ask', rule: 'mcp__github__gh' } })
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(gates(seen)).toBe(1)
  expect(commands(seen)).toEqual(['pr-gate'])
  expect(seen.logs).toEqual([])
})

test('warn: a not-ready pr-merge in auto-merge runs with no question and a warn line', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
  expect(seen.logs.length).toBe(1)
})

test('warn: a ready pr-merge in auto-merge runs with no question and no warn line', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(seen.asked.length).toBe(0)
  expect(seen.logs).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
})

test('warn: an unreadable readiness lets the act through with a warn line naming the error', async ($, on) => {
  const seen = await world($, on, { gateFails: 'error: boom' })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
  expect(seen.logs[0]).toContain('readiness unverified: error: boom')
})

test('warn: a pull request opened out of draft in auto-merge runs with no question, with a warn line', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-create'])
  expect(seen.logs[0]).toContain('opened out of draft')
})

test('warn: the Ready label on a pull request not ready is refused all the same, Not Ready is not', async ($, on) => {
  const seen = await world($, on, { records: Object.fromEntries([record('review', 'pass'), record('norms', 'pass')]) })
  const ready: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(ready.deny).toContain('e2e: no record')
  const label: any = await $.tool.call(gh('label-add', { pr: 12, label: ['Ready'] }))
  expect(label.deny).toContain('e2e: no record')
  await $.tool.call(gh('pr-readiness', { pr: 12, state: 'not-ready' }))
  expect(seen.logs).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
})

test('warn: each warn line is appended to guard-warn.log, the lines before it kept', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], warnLog: '{"old":1}\n' })
  await $.tool.call(gh('pr-merge', { pr: 12 }))
  await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  const lines = String(seen.warnLog).trim().split('\n')
  expect(lines.length).toBe(3)
  expect(lines[0]).toBe('{"old":1}')
  expect(JSON.parse(lines[1]).route).toBe('tool')
  expect(JSON.parse(lines[2]).route).toBe('bash')
})

// ---- the tool, enforce phase ----

test('enforce: a not-ready pr-ready outside auto-merge is refused before anyone is asked', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, NO_RECORDS)
    const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(out.deny).toBe('github: pr-ready refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
      + ' 0123456, norms: no record at 0123456, e2e: no record at 0123456. A pull request is ready when a clean review,'
      + ' a passed norms check, passed E2E and green CI are all at its current head (engine/writing/pull-requests.md « Ready pull requests »).')
    expect(seen.asked.length).toBe(0)
    expect(commands(seen)).toEqual(['pr-gate'])
  })
})

test('enforce: a ready pr-ready outside auto-merge is refused, never asked', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on)
    const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(out.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
    expect(seen.asked.length).toBe(0)
    expect(commands(seen)).toEqual(['pr-gate'])
  })
})

test('enforce: in auto-merge a not-ready merge is refused, a ready one runs with no question', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toContain('Missing: CI failed: lint.')
    expect(seen.asked.length).toBe(0)
  })
})

test('enforce: in auto-merge a ready merge runs with no question', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out).toEqual({ result: 'ok' })
    expect(seen.asked.length).toBe(0)
  })
})

test('enforce: a merge pinned to a head that moved is refused', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { autoMerge: ['acme/thing'] })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12, sha: MOVED }))
    expect(out.deny).toContain('the head moved: ' + MOVED + ' given, ' + HEAD + ' on GitHub')
  })
})

test('enforce: a refused Ready label on a pull request still carrying Ready puts Not Ready back', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
    const out: any = await $.tool.call(gh('label-add', { pr: 12, label: ['Ready'] }))
    expect(out.deny).toContain('not ready')
    expect(seen.runs.find((r) => r.command === 'pr-readiness')?.args).toEqual({ pr: 12, state: 'not-ready' })
    expect(commands(seen)).toEqual(['pr-gate', 'pr-readiness'])
  })
})

test('enforce: a pull request opened out of draft is refused, a draft is not', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on)
    const out: any = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
    expect(out.deny).toBe('github: pr-create refused: open it as a draft, then leave draft once ready.')
    expect(seen.asked.length).toBe(0)
    const draft: any = await $.tool.call(gh('pr-create', { title: 'fix: x' }))
    expect(draft).toEqual({ result: 'ok' })
  })
})

test('enforce: an unreadable readiness refuses with the engine error', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { gateFails: 'error: rate limited' })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: rate limited')
  })
})

test('enforce: a deny rule still refuses first, and the guard reads nothing', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { verdict: { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('denied by rule')
    expect(seen.runs).toEqual([])
  })
})

// ---- a failure of the guard itself ----

// A pr-gate answer with no repository: reading the records at its head throws
// inside the guard.
const BROKEN_GATE = {
  pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
  ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
}

for (const phase of ['warn', 'enforce'] as const) {
  for (const [route, call] of [['Bash', bash('gh pr merge 12 -R acme/thing --squash')], ['tool', gh('pr-merge', { pr: 12 })]] as const) {
    test(phase + ': a guard that throws on a ' + route + ' merge reads as unverified readiness', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/thing'] })
        const out: any = await $.tool.call(call)
        const ran = route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === 'pr-merge').length
        if (phase === 'enforce') {
          expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: ')
          expect(ran).toBe(0)
        } else {
          expect(out.deny).toBeUndefined()
          expect(ran).toBe(1)
          expect(seen.logs.length).toBe(1)
          expect(seen.logs[0]).toContain('github: ' + (route === 'Bash' ? 'gh pr merge' : 'pr-merge') + ' on acme/thing#12 is not ready')
          expect(seen.logs[0]).toContain('readiness unverified: ')
          expect(JSON.parse(seen.writes.find((w) => w.path === '/data/guard-warn.log')!.text.trim()).route).toBe(route.toLowerCase())
        }
      })
    })
  }
}

// A Bash merge outside auto-merge is refused on the list alone, before any
// readiness read, so a guard that would throw on the read changes nothing. An undraft
// reads the readiness first, as a CI undraft passes outside auto-merge: when that read
// throws, the guard's failure handler refuses it on the list, in both phases.
for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Bash merge outside auto-merge is refused on the list before any readiness read', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
      const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
      expect(out.deny).toContain('github: gh pr merge refused on acme/thing: this repository is not in auto-merge')
      expect(seen.bash.length).toBe(0)
      expect(commands(seen)).toEqual([])
    })
  })

  test(phase + ': a Bash undraft outside auto-merge whose guard throws is refused on the list', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
      const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(String(out.deny)).toContain('github: gh pr ready refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
      expect(seen.bash.length).toBe(0)
      expect(seen.logs).toEqual([])
    })
  })

  test(phase + ': a Bash pull request opened out of draft outside auto-merge is refused whatever the readiness read gives', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
      const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
      expect(String(out.deny)).toContain(phase === 'enforce'
        ? 'github: gh pr create refused: open it as a draft'
        : 'github: gh pr create refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
      expect(seen.bash.length).toBe(0)
      expect(commands(seen)).toEqual([])
    })
  })
}

// ---- leaving draft for CI ----

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Not Ready pull request whose CI is not green leaves draft through the tool, still Not Ready', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out).toEqual({ result: 'ok' })
      expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': a CI undraft through the tool passes outside auto-merge too, with no question', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, verdict: { decision: 'ask' }, answer: 'Deny', ci: { result: 'PENDING', skipped: ['test'] } })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out).toEqual({ result: 'ok' })
      expect(seen.asked).toEqual([])
      expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': an undraft outside auto-merge that is no CI undraft is refused, never asked', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { answer: 'Allow' })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
      expect(seen.asked).toHaveLength(0)
      expect(commands(seen)).toEqual(['pr-gate'])
    })
  })

  test(phase + ': a Bash CI undraft passes outside auto-merge too, with one line', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'FAILURE', failed: ['test'] } })
      const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(out.deny).toBeUndefined()
      expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing'])
      expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
    })
  })

  test(phase + ': going back to draft is always let through, and puts Not Ready', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
      const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo'))
      expect(out.deny).toBeUndefined()
      expect(seen.runs.map((r) => r.command)).toEqual(['pr-readiness'])
      expect(seen.runs[0].args).toEqual({ pr: 12, state: 'not-ready' })
      const tool: any = await $.tool.call(gh('pr-draft', { pr: 12 }))
      expect(tool).toEqual({ result: 'ok' })
      expect(gates(seen)).toBe(0)
    })
  })
}

test('going back to draft through the tool is not asked outside auto-merge', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Deny' })
  const out: any = await $.tool.call(gh('pr-draft', { pr: 12 }, 'acme/other'))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-draft'])
})

test('a pull request that carries Ready, or whose CI is green, is no CI undraft', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
    const green: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
    expect(green.deny).toContain('not ready')
  })
})

// ---- the Ready label and the undraft against CI ----

const LABEL_ACTS = [
  ['tool', gh('pr-readiness', { pr: 12, state: 'ready' })],
  ['Bash', bash('gh pr edit 12 -R acme/thing --add-label Ready')],
] as const
const UNDRAFT_ACTS = [
  ['tool', gh('pr-ready', { pr: 12 })],
  ['Bash', bash('gh pr ready 12 -R acme/thing')],
] as const

// Whether the act itself ran: the engine's command, or the Bash line.
const actRan = (seen: Seen, route: string, command: string) =>
  route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === command).length

for (const phase of ['warn', 'enforce'] as const) {
  for (const [route, call] of LABEL_ACTS) {
    for (const ci of [{ result: 'PENDING', running: 1 }, { result: 'FAILURE', failed: ['test'] }]) {
      test(phase + ': the ' + route + ' Ready label on a Not Ready pull request with the three records and CI '
        + ci.result + ' is no CI undraft', async ($, on) => {
        await inPhase(phase, async () => {
          const seen = await world($, on, { ci })
          const out: any = await $.tool.call(call)
          const missing = ci.result === 'FAILURE' ? 'CI failed: test' : 'CI still running'
          // The Ready label is the gate's: refused in both phases.
          expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: ' + missing + '.')
          expect(actRan(seen, route, 'pr-readiness')).toBe(0)
        })
      })
    }

    test(phase + ': the ' + route + ' Ready label with the four holding passes with no warn line', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on)
        const out: any = await $.tool.call(call)
        expect(out.deny).toBeUndefined()
        expect(actRan(seen, route, 'pr-readiness')).toBe(1)
        expect(seen.logs).toEqual([])
        expect(seen.writes.filter((w) => w.path === WARN_LOG)).toEqual([])
      })
    })
  }

  for (const [route, call] of UNDRAFT_ACTS) {
    test(phase + ': a ' + route + ' undraft of a pull request carrying Ready with CI not green is no CI undraft', async ($, on) => {
      await inPhase(phase, async () => {
        const seen = await world($, on, { labels: ['Ready'], autoMerge: ['acme/thing'], ci: { result: 'PENDING', running: 1 } })
        const out: any = await $.tool.call(call)
        expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
        if (phase === 'enforce') {
          expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: CI still running.')
          expect(actRan(seen, route, 'pr-ready')).toBe(0)
        } else {
          expect(out.deny).toBeUndefined()
          expect(actRan(seen, route, 'pr-ready')).toBe(1)
          expect(seen.runs.find((r) => r.command === 'pr-ready')?.args?.['for-ci']).toBeUndefined()
          expect(seen.logs).toEqual([expect.stringContaining('is not ready, let through while the guard only warns. Missing: CI still running')])
        }
      })
    })
  }
}

// ---- Bash ----

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Bash merge or undraft outside auto-merge is refused with the tool call to make', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on)
      const merge: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
      expect(merge.deny).toBe('github: gh pr merge refused on acme/thing: this repository is not in auto-merge, so a merge'
        + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": 12}'
        + ' on acme/thing: it checks that the pull request is ready, then asks them in the conversation.')
      const ready: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(ready.deny).toContain('github: gh pr ready refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
      expect(ready.deny).toContain('pr-readiness {"pr": 12, "state": "ready"}')
      const api: any = await $.tool.call(bash('gh api -X PUT repos/acme/thing/pulls/12/merge'))
      expect(api.deny).toContain('not in auto-merge')
      expect(seen.bash).toEqual([])
    })
  })

  test(phase + ': a Bash merge without a repository is refused, so is a GraphQL merge', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(bash('gh pr merge 12 --squash'))
      expect(out.deny).toBe('github: gh pr merge refused: name the repository with -R owner/name.')
      const graphql: any = await $.tool.call(bash('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
      expect(graphql.deny).toContain('github: gh api graphql refused')
      expect(seen.bash).toEqual([])
    })
  })

  test(phase + ': a ready Bash merge in auto-merge passes', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD))
      expect(out.deny).toBeUndefined()
      expect(seen.bash.length).toBe(1)
      expect(seen.logs).toEqual([])
    })
  })
}

test('warn: a not-ready Bash merge in auto-merge passes with a warn line, enforce refuses it', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const warned: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(warned.deny).toBeUndefined()
  expect(seen.logs[0]).toContain('github: gh pr merge on acme/thing#12 is not ready')
  expect(JSON.parse(seen.writes[0].text.trim()).route).toBe('bash')
  await inPhase('enforce', async () => {
    const refused: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --auto'))
    expect(refused.deny).toContain('github: gh pr merge refused on acme/thing#12 at 0123456: not ready.')
  })
  expect(seen.bash.length).toBe(1)
})

test('warn and enforce: a not-ready Bash undraft in auto-merge, out of CI undraft, warns then refuses', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], labels: [] })
  await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(seen.logs.length).toBe(1)
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
    expect(out.deny).toContain('not ready')
  })
})

test('a Bash merge whose readiness cannot be read warns, then is refused under enforce', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], gateFails: 'error: boom' })
  const warned: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
  expect(warned.deny).toBeUndefined()
  expect(seen.logs[0]).toContain('readiness unverified: error: boom')
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
    expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: boom')
  })
})

test('the Ready label needs the four on a draft as out of draft', async ($, on) => {
  await inPhase('enforce', async () => {
    await world($, on, { gate: {
      repo: 'acme/thing', pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
      ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
    }, records: {} })
    const open: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
    expect(open.deny).toContain('not ready')
  })
})

test('the Ready label on a draft needs the four too', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, { records: {} })
    const draft: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
    expect(draft.deny).toContain('not ready')
    expect(commands(seen)).toEqual(['pr-gate'])
  })
})

test('a Bash merge of the current branch\'s pull request reads it with pr-get', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], pulls: { '': [{ number: 12 }] } })
  await $.tool.call(bash('gh pr merge -R acme/thing'))
  expect(commands(seen)).toEqual(['pr-get', 'pr-gate'])
  expect(seen.runs[0].repo).toBe('acme/thing')
  expect(seen.runs[1].args).toEqual({ pr: 12 })
})

test('a Bash Ready label is the ready guard\'s in every repository', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  for (const line of ['gh pr edit 12 -R acme/thing --add-label Ready', 'gh api --method POST repos/acme/thing/issues/12/labels -f \'labels[]=Ready\'']) {
    const out: any = await $.tool.call(bash(line))
    expect(out.deny, line).toContain('not ready')
  }
  expect(seen.bash.length).toBe(0)
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh issue edit 12 -R acme/thing --add-label ready'))
    expect(out.deny).toContain('github: gh issue edit refused on acme/thing#12')
    const unnamed: any = await $.tool.call(bash('gh pr edit 12 --add-label Ready'))
    expect(unnamed.deny).toBe('github: gh pr edit refused: name the repository with -R owner/name.')
  })
})

test('a Bash pull request opened out of draft is refused outside auto-merge in both phases', async ($, on) => {
  const seen = await world($, on)
  const warned: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
  expect(warned.deny).toBe('github: gh pr create refused on acme/thing: outside auto-merge, leaving draft is the operator\'s, on GitHub after their review, and Ready is'
    + ' put by the gate once the four conditions hold (pr-readiness {"pr": <n>, "state": "ready"} reads them now).')
  expect(seen.bash.length).toBe(0)
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
    expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  })
})

test('a Bash gh pr create --draft=false is refused outside auto-merge, like one with no --draft', async ($, on) => {
  const seen = await world($, on)
  const body = '"Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'
  for (const flag of ['--draft=false', '--draft=0']) {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toContain('github: gh pr create refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
  }
  expect(seen.bash.length).toBe(0)
  for (const flag of ['--draft=true', '--draft']) {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toBeUndefined()
  }
})

test('a Bash pull request opened out of draft in auto-merge warns, then is refused under enforce', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(seen.bash.length).toBe(1)
  expect(seen.logs[0]).toContain('opened out of draft')
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
    expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  })
})

test('a Bash pull request opened out of draft with no repository named is refused under warn', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash('gh pr create -t "fix: x" -b body'))
  expect(out.deny).toBe('github: gh pr create refused: name the repository with -R owner/name.')
  expect(seen.bash.length).toBe(0)
})

// The engine run through Bash, as the github-curl skill runs it.
const ENGINE = 'python3 /plugins/github/engine/gh.py'

test('a Bash merge through gh.py is refused outside auto-merge, as gh pr merge is', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(bash(ENGINE + ' pr-merge 12 --repo acme/thing --method squash'))
  expect(out.deny).toBe('github: gh.py pr-merge refused on acme/thing: this repository is not in auto-merge, so a merge'
    + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": 12} on'
    + ' acme/thing: it checks that the pull request is ready, then asks them in the conversation.')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge through gh.py in auto-merge meets the ready guard', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  await $.tool.call(bash(ENGINE + ' --repo=acme/thing pr-merge 12'))
  expect(seen.bash.length).toBe(1)
  expect(seen.logs[0]).toContain('github: gh.py pr-merge on acme/thing#12 is not ready')
  await inPhase('enforce', async () => {
    const out: any = await $.tool.call(bash('/plugins/github/engine/gh.py pr-merge 12 --repo acme/thing'))
    expect(out.deny).toContain('github: gh.py pr-merge refused on acme/thing#12 at 0123456: not ready.')
  })
})

test('a Bash merge or undraft through gh.py with no --repo is refused under warn', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  for (const command of [ENGINE + ' pr-merge 12', ENGINE + ' pr-ready 12']) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh.py ' + command.split(' ')[2] + ' refused: name the repository with --repo owner/name.')
  }
  expect(seen.bash.length).toBe(0)
})

test('a Bash undraft through gh.py passes for CI with --for-ci only', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'PENDING', skipped: ['test'] } })
  const forCi: any = await $.tool.call(bash(ENGINE + ' pr-ready 12 --for-ci --repo acme/thing'))
  expect(forCi.deny).toBeUndefined()
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
  const ready: any = await $.tool.call(bash(ENGINE + ' pr-ready 12 --repo acme/thing'))
  expect(ready.deny).toContain('github: gh.py pr-ready refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
  expect(seen.bash.length).toBe(1)
})

test('a Bash pr-create through gh.py without --draft is refused outside auto-merge, with --draft it passes', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(bash(ENGINE + ' pr-create --repo acme/thing --title "fix: x"'))
  expect(out.deny).toContain('github: gh.py pr-create refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
  expect(seen.bash.length).toBe(0)
  const draft: any = await $.tool.call(bash(ENGINE + ' pr-create --repo acme/thing --title "fix: x" --draft'))
  expect(draft.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
})

test('a Bash merge through gh.py with a global --repo or python -W before the script is read as a merge', async ($, on) => {
  const seen = await world($, on)
  for (const command of [
    'python3 "$GH" --repo acme/thing pr-merge 12',
    'python3 "$GH" -R acme/thing pr-merge 12',
    'python3 -W ignore /plugins/github/engine/gh.py pr-merge 12 --repo acme/thing',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('github: gh.py pr-merge refused on acme/thing: this repository is not in auto-merge')
  }
  expect(seen.bash.length).toBe(0)
})

test('a Bash gh.py act whose pull request number cannot be read is refused in both phases, never read against the current branch', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], pulls: { '': [{ number: 12 }] } })
  for (const command of [
    ENGINE + ' pr-merge {} --repo acme/thing',
    ENGINE + ' pr-merge "$PR" --repo acme/thing',
    ENGINE + ' pr-ready {} --repo acme/thing',
    ENGINE + ' pr-readiness {} ready --repo acme/thing',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh.py ' + command.split(' ')[2] + ' refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
    await inPhase('enforce', async () => {
      const again: any = await $.tool.call(bash(command))
      expect(again.deny, command).toContain('the pull request number cannot be read from the command')
    })
  }
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})

test('a Bash Ready label through gh.py needs the four under enforce', async ($, on) => {
  await inPhase('enforce', async () => {
    const seen = await world($, on, NO_RECORDS)
    for (const command of [ENGINE + ' pr-readiness 12 ready --repo acme/thing', ENGINE + ' label-add 12 bug Ready --repo acme/thing']) {
      const out: any = await $.tool.call(bash(command))
      expect(out.deny, command).toContain('refused on acme/thing#12 at 0123456: not ready.')
    }
    expect(seen.bash.length).toBe(0)
  })
})

test('a Bash undraft through gh.py for CI passes in auto-merge too, still Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
  const out: any = await $.tool.call(bash(ENGINE + ' pr-ready 12 --for-ci --repo acme/thing'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
})

test('a Bash Ready label through gh.py that is not ready is refused under warn too', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  for (const command of [ENGINE + ' pr-readiness 12 ready --repo acme/thing', ENGINE + ' label-add 12 Ready --repo acme/thing']) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('refused on acme/thing#12 at 0123456: not ready.')
  }
  expect(seen.bash.length).toBe(0)
  expect(seen.logs).toEqual([])
})

test('a text quoting a gh.py act passes with nothing read', async ($, on) => {
  const seen = await world($, on)
  for (const line of [
    'echo "python3 engine/gh.py pr-merge 12 --repo acme/thing"',
    'cat <<EOF\npython3 engine/gh.py pr-merge 12 --repo acme/thing\nEOF',
    'git commit -m "fix: stop running python3 engine/gh.py pr-merge 12 twice"',
  ]) {
    const out: any = await $.tool.call(bash(line))
    expect(out.deny, line).toBeUndefined()
  }
  expect(seen.runs).toEqual([])
})

test('gh.py reads that act on nothing pass the ready guard unread, a --stdin-json request from Bash is refused', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(bash(ENGINE + ' pr-get --format pr-number'))
  await $.tool.call(bash(ENGINE + ' pr-readiness 12 not-ready --repo acme/thing'))
  const stdin: any = await $.tool.call(bash('printf %s \'{"command":"pr-merge","args":{"pr":12}}\' | ' + ENGINE + ' --stdin-json'))
  expect(stdin.deny).toBe(STDIN_REFUSAL)
  expect(seen.bash.length).toBe(2)
  expect(commands(seen)).toEqual([])
})

test('a --stdin-json request from Bash is refused in auto-merge and under enforce too', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const line = 'python3 ' + ROOT + '/engine/gh.py --stdin-json < request.json'
  expect(((await $.tool.call(bash(line))) as any).deny).toBe(STDIN_REFUSAL)
  await inPhase('enforce', async () => {
    expect(((await $.tool.call(bash(line))) as any).deny).toBe(STDIN_REFUSAL)
  })
  expect(seen.bash).toEqual([])
})

test('a --stdin-json word among other engine words does not hide the Ready label act', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  const out: any = await $.tool.call(bash(ENGINE + ' --repo acme/thing label-add 12 Ready -- --stdin-json'))
  expect(out.deny).toContain('github: gh.py label-add refused on acme/thing#12 at 0123456: not ready.')
  expect(seen.bash.length).toBe(0)
})

test('a Bash draft opened gets Not Ready from the URL gh printed', async ($, on) => {
  const seen = await world($, on, { bashResult: { result: { stdout: 'https://github.com/acme/thing/pull/31\n', stderr: '', interrupted: false } } })
  await $.tool.call(bash('gh pr create --draft -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(seen.runs.map((r) => [r.command, r.repo, r.args])).toEqual([['pr-readiness', 'acme/thing', { pr: 31, state: 'not-ready' }]])
})

test('commands that only look like an act pass with nothing read', async ($, on) => {
  const seen = await world($, on)
  for (const line of ['gh pr merge 12 -R acme/thing --disable-auto', 'git commit -m "run gh pr merge later"', 'gh pr view 12']) {
    const out: any = await $.tool.call(bash(line))
    expect(out.deny, line).toBeUndefined()
  }
  expect(seen.runs).toEqual([])
})

// ---- the label follows the head ----

test('a push to the branch of a Ready pull request puts Not Ready back, a Not Ready one is left', async ($, on) => {
  const seen = await world($, on, {
    git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }], other: [{ number: 13, labels: [{ name: 'Not Ready' }] }] },
  })
  await $.tool.call(bash('git push origin feat'))
  expect(seen.runs.filter((r) => r.command === 'pr-readiness').map((r) => [r.repo, r.args])).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready after the push to feat'])
  await $.tool.call(bash('git push origin other'))
  expect(seen.runs.filter((r) => r.command === 'pr-readiness').length).toBe(1)
})

test('a push by URL reads the repository and the branch from the command', async ($, on) => {
  const seen = await world($, on, { pulls: { feat: [{ number: 4, labels: [{ name: 'ready' }] }] } })
  await $.tool.call(bash('git push https://github.com/o/r.git HEAD:feat'))
  expect(seen.runs.filter((r) => r.command).map((r) => [r.command, r.repo, r.args])).toEqual([
    ['pr-get', 'o/r', { branch: 'feat' }],
    ['pr-readiness', 'o/r', { pr: 4, state: 'not-ready' }],
  ])
})

test('a failed push changes nothing', async ($, on) => {
  const seen = await world($, on, {
    bashResult: { result: 'rejected', isError: true },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }] },
  })
  await $.tool.call(bash('git push https://github.com/acme/thing.git feat'))
  expect(seen.runs).toEqual([])
})

test('a push whose branch cannot be read writes nothing and says so', async ($, on) => {
  const seen = await world($, on, { git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } } })
  await $.tool.call(bash('git push origin HEAD'))
  expect(seen.runs.filter((r) => r.command).length).toBe(0)
  expect(seen.logs).toEqual(['github: the labels are left as they are after the push: the current branch cannot be read'])
  await $.tool.call(bash('cd /elsewhere && git push origin feat'))
  expect(seen.logs[1]).toContain('changes directory first')
})

test('a push of the current branch reads it in the session\'s checkout', async ($, on) => {
  const seen = await world($, on, {
    git: {
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feat\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'https://github.com/acme/thing.git\n' },
    },
    pulls: { feat: [{ number: 12, labels: [{ name: 'Ready' }] }] },
  })
  await $.tool.call(bash('git push -u origin HEAD'))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready after the push to feat'])
})

// ---- the records guard ----

test('the records are refused to Write, Edit and Bash, a Read of one passes', async ($, on) => {
  const seen = await world($, on)
  const refusal = RECORDS_REFUSAL
  for (const call of [
    { tool: 'Write', file_path: RECORDS + '/acme/thing/' + HEAD + '/e2e.x.json', content: '{}' },
    { tool: 'Edit', file_path: '/home/x/.claude/pr-records/o/r/x.json', old_string: 'a', new_string: 'b' },
    { tool: 'NotebookEdit', notebook_path: RECORDS + '/acme/thing/' + HEAD + '/review.x.ipynb', new_source: 'x' },
    { tool: 'MultiEdit', file_path: RECORDS + '/o/r/x.json', edits: [] },
    bash('echo x > ~/.claude/pr-records/o/r/x.json'),
    bash('python3 ' + ROOT + '/engine/record.py --repo o/r --pr 1'),
    bash('ls ~/.claude/pr-records'),
  ]) {
    const out: any = await $.tool.call(call as any)
    expect(out.deny, JSON.stringify(call)).toBe(refusal)
  }
  const read: any = await $.tool.call({ tool: 'Read', file_path: HEAD_DIR + '/e2e.x.json' } as any)
  expect(read.deny).toBeUndefined()
  const other: any = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' } as any)
  expect(other.deny).toBeUndefined()
  expect(seen.bash).toEqual([])
})

test('a command that only mentions the records in its text passes, a path to them is refused', async ($, on) => {
  const seen = await world($, on)
  const commit: any = await $.tool.call(bash('git commit -m "docs: mention pr-records in the README"'))
  expect(commit.deny).toBeUndefined()
  const rm: any = await $.tool.call(bash('rm ~/.claude/pr-records/x'))
  expect(rm.deny).toContain('github: records are written by their producers')
  expect(seen.bash).toEqual(['git commit -m "docs: mention pr-records in the README"'])
})

// ---- the record tool ----

const CLEAN = {
  'rev-parse HEAD': { exitCode: 0, stdout: HEAD + '\n' },
  'status --porcelain -uno': { exitCode: 0, stdout: '' },
}

const recordRun = (seen: Seen) => seen.runs.find((r) => String(r.argv[1]).endsWith('/engine/record.py'))?.argv.slice(2)

test('the model records its E2E at the pull request\'s head from a clean checkout', async ($, on) => {
  // Already Ready: the record's answer is its path alone (the gate's line has its own tests).
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'] })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'ran the smoke suite' } as any)
  expect(out.result).toBe(HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json')
  const argv = recordRun(seen)!
  expect(argv.slice(0, 14)).toEqual(['--repo', 'acme/thing', '--pr', '12', '--head', HEAD, '--kind', 'e2e', '--result', 'pass',
    '--producer', 'session-e2e', '--detail', 'ran the smoke suite'])
  expect(argv[15]).toContain('guard-session-')
})

test('a record.py that fails is an error to the caller, with its message', async ($, on) => {
  await world($, on, { git: CLEAN, recordFails: { exitCode: 2, stderr: 'error: --detail is past 500 characters\n' } })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'x' } as any)
  expect(out).toEqual({ result: 'error: --detail is past 500 characters', isError: true })
})

test('the model may not record a review or a norms check', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  for (const kind of ['review', 'norms']) {
    const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind, result: 'pass' } as any)
    expect(out.deny).toContain('github: ' + kind + ' records are written by their producer')
    expect(out.deny).toContain('this tool writes e2e only')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('a record is refused away from the head, or on a checkout with changes', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } })
  const moved: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(moved.deny).toContain('the checkout is at fedcba9, the pull request\'s head is 0123456')
  expect(recordRun(seen)).toBeUndefined()
})

test('a record is refused on a checkout whose tracked files changed', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } })
  const dirty: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(dirty.deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('an E2E waiver quotes words the operator typed in this session', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const words = 'no E2E for this docs change, 2026-11-02'
  const before: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail: words } as any)
  expect(before.deny).toContain('an E2E waiver quotes the operator')
  await ($ as any).prompt.submit({ text: 'ok: ' + words, origin: { kind: 'composer' }, wait: false })
  const after: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail: words } as any)
  expect(after.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

const CONSENTS = '/cfg/consents/acme/thing'

function consentWorld(records: Record<string, unknown>, dir = CONSENTS): World {
  const tree: NonNullable<World['tree']> = { [dir]: { kind: 'directory', mtimeMs: 1 } }
  for (const [id, body] of Object.entries(records)) tree[dir + '/' + id + '.json'] = { kind: 'file', mtimeMs: 2, text: JSON.stringify(body) }
  return { git: CLEAN, tree }
}

const CONSENT_WORDS = 'waive it, no E2E for this docs change, 2026-11-03'
const consent = (over: Record<string, unknown> = {}) => ({
  v: 1, subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }, entry: 'a', question: 'E2E for thing#12: waive it?',
  answer: CONSENT_WORDS, by: 'pane', at: '2026-11-03T10:00:00Z', ...over,
})
const waiveCall = (detail: string) =>
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail }) as any

test('an E2E waiver may quote the operator\'s answer in a consent record of that pull request', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent() }))
  const out: any = await $.tool.call(waiveCall('operator ruled: ' + CONSENT_WORDS))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

test('an E2E waiver may quote the operator\'s answer typed in the asking session\'s own tab', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent({ by: 'tab' }) }))
  const out: any = await $.tool.call(waiveCall('operator ruled: ' + CONSENT_WORDS))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

for (const [label, over] of [
  ['another pull request', { subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 13 } }],
  ['auto-merge', { subject: { kind: 'auto-merge', repo: 'acme/thing' } }],
  ['another repository', { subject: { kind: 'e2e-waiver', repo: 'acme/other', pr: 12 } }],
  ['an answer of 3 characters', { answer: 'oui' }],
  ['another contract version', { v: 2 }],
  ['an unknown answerer', { by: 'someone' }],
] as const) {
  test('a consent record of ' + label + ' does not carry a waiver', async ($, on) => {
    const seen = await world($, on, consentWorld({ a: consent(over) }))
    const out: any = await $.tool.call(waiveCall(label === 'an answer of 3 characters' ? 'operator said oui, 2026-11-03' : CONSENT_WORDS))
    expect(out.deny).toContain('an E2E waiver quotes the operator')
    expect(recordRun(seen)).toBeUndefined()
  })
}

test('an answer the orchestrator\'s round holds is no consent: github never reads round/', async ($, on) => {
  const round = '/cfg/claude-orchestrator/round'
  const entry = { question: 'E2E for thing#12: waive it?', blocks: null, status: 'answered', answer: { text: CONSENT_WORDS, by: 'pane', at: 'x' } }
  const seen = await world($, on, { git: CLEAN, tree: { [round]: { kind: 'directory', mtimeMs: 1 }, [round + '/a.json']: { kind: 'file', mtimeMs: 2, text: JSON.stringify(entry) } } })
  const out: any = await $.tool.call(waiveCall(CONSENT_WORDS))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

test('a waiver that quotes no consent is refused, and says both ways to give one', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent(), b: 'not json' }))
  const out: any = await $.tool.call(waiveCall('some words nobody said, 2026-11-03'))
  expect(out.deny).toContain('typed in this session')
  expect(out.deny).toContain('consent record (orchestrator)')
  expect(recordRun(seen)).toBeUndefined()
})

test('no consent records carry no waiver and do not crash', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out: any = await $.tool.call(waiveCall(CONSENT_WORDS))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

for (const [plugin, kind, allowed] of [
  ['pr-review', 'review', true], ['pr-review', 'norms', false], ['norms', 'norms', true], ['norms', 'review', false],
  ['orchestrator', 'review', false], ['orchestrator', 'e2e', true],
] as const) {
  test('a call from the ' + plugin + ' plugin ' + (allowed ? 'writes' : 'is refused') + ' a ' + kind + ' record', {
    plugins: [{
      name: plugin,
      register(on: any) {
        on('command.run', { command: 'emit-record' }, async ($: any, e: any) => {
          const [k] = String(e.args).split(' ')
          const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind: k, result: 'pass' })
          return { text: JSON.stringify(out) }
        })
      },
    }],
  }, async ($, on) => {
    const seen = await world($, on, { git: CLEAN })
    const out = await $.command.run({ command: 'emit-record', args: kind })
    if (allowed) {
      const argv = recordRun(seen)!
      expect(argv[argv.indexOf('--kind') + 1]).toBe(kind)
      expect(argv[argv.indexOf('--producer') + 1]).toBe(plugin)
    } else {
      expect(String(out.text)).toContain(kind + ' records are written by their producer')
      expect(String(out.text)).toContain(plugin + ' writes ')
      expect(recordRun(seen)).toBeUndefined()
    }
  })
}

// ---- pruning ----

const DAY = 24 * 3600 * 1000

test('at session start the head directories untouched for 90 days are pruned, once a day', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'directory', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + MOVED + '/e2e.x.json']: { kind: 'file', mtimeMs: now - 100 * DAY },
    [RECORDS + '/o/r/' + HEAD]: { kind: 'directory', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + HEAD + '/review.x.json']: { kind: 'file', mtimeMs: now - 10 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs.map((r) => r.argv)).toEqual([['rm', '-rf', '--', RECORDS + '/o/r/' + MOVED]])
  expect(seen.writes.map((w) => w.path)).toEqual([RECORDS + '/.pruned'])
})

test('a stamp from today prunes nothing', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/.pruned']: { kind: 'file', mtimeMs: now - 3600 * 1000 },
    [RECORDS + '/o']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'directory', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'directory', mtimeMs: now - 200 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs).toEqual([])
  expect(seen.writes).toEqual([])
})

// ---- auto-merge on the operator's word ----

const HIS_WORDS = 'on est en auto-merge, pour cette orchestration infra compris'
const typed = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })
const setAutoMerge = (on: boolean, words: string, repo = 'acme/thing') =>
  gh('auto-merge-set', { repo, on, words }, undefined as any)
const listed = (seen: Seen) => JSON.parse(seen.files[AUTO_MERGE]).repositories

test('auto-merge-set on with words the operator typed lists the repository, and its pr-ready asks nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  await typed($, 'thing : ' + HIS_WORDS)
  const set: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
  const ready: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(ready.deny).toBeUndefined()
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toContain('pr-ready')
})

test('auto-merge-set with words the operator never typed is refused, naming both proofs, and writes nothing', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'something else entirely')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('typed in this session')
  expect(out.deny).toContain('consent record')
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})

test('a peer message is not the operator\'s word', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_WORDS, 'peer')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('typed in this session')
  expect(seen.files).toEqual({})
})

test('words of a few characters never carry auto-merge, typed or not', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'oui')
  const out: any = await $.tool.call(setAutoMerge(true, 'oui'))
  expect(out.deny).toContain('at least 8 characters')
  expect(seen.files).toEqual({})
})

test('typed words that do not name auto-merge are refused even though they typed them', async ($, on) => {
  const seen = await world($, on)
  const words = 'ok, lance la suite maintenant'
  await typed($, 'thing : ' + words)
  const out: any = await $.tool.call(setAutoMerge(true, words))
  expect(out.deny).toContain('auto-merge')
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})

test('typed words naming auto-merge without the repository pass', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'le projet est en auto-merge')
  const out: any = await $.tool.call(setAutoMerge(true, 'le projet est en auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

for (const spelling of ['auto merge', 'automerge', 'AUTO-MERGE']) {
  test('the word « ' + spelling + ' » names auto-merge in their words', async ($, on) => {
    const seen = await world($, on)
    const words = 'le projet est en ' + spelling
    await typed($, words)
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toBeUndefined()
    expect(listed(seen)).toEqual(['acme/thing'])
  })
}

test('the words match the typed prompt with its whitespace normalised', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'on est en  auto-merge,\npour cette orchestration infra compris')
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

const mergeConsent = (text = 'oui, thing passe en auto-merge', subject: unknown = { kind: 'auto-merge', repo: 'acme/thing' }) =>
  consentWorld({ a: consent({ subject, question: 'Put thing in auto-merge?', answer: text, by: 'coordinator' }) })

test('auto-merge-set may quote the operator\'s answer in a consent record of auto-merge on that repository', async ($, on) => {
  const seen = await world($, on, mergeConsent())
  const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

test('a consent answer without the auto-merge word is refused', async ($, on) => {
  const seen = await world($, on, mergeConsent('oui, thing passe en automatique'))
  const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en automatique'))
  expect(out.deny).toContain('auto-merge')
  expect(seen.files).toEqual({})
})

test('a consent record of an E2E waiver does not carry auto-merge', async ($, on) => {
  const seen = await world($, on, mergeConsent(undefined, { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }))
  const out: any = await $.tool.call(setAutoMerge(true, 'oui, thing passe en auto-merge'))
  expect(out.deny).toContain('consent record (orchestrator) of auto-merge on acme/thing')
  expect(seen.files).toEqual({})
})

test('auto-merge-set off takes the repository out, whatever its case, and its pr-ready is refused again', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['Acme/Thing', 'acme/other'] })
  const words = 'thing sort de l\'auto-merge'
  await typed($, words)
  const out: any = await $.tool.call(setAutoMerge(false, words))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/other'])
  const ready: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(seen.asked.length).toBe(0)
  expect(ready.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
})

test('the list is written whole to a temporary file then moved in place, leaving no temporary file', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'] })
  await typed($, HIS_WORDS)
  await $.tool.call(setAutoMerge(true, HIS_WORDS))
  const written = seen.writes.filter((x) => x.path.startsWith('/data/'))
  expect(written.length).toBe(1)
  expect(written[0].path).not.toBe(AUTO_MERGE)
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv' && r.argv.includes(written[0].path) && r.argv.at(-1) === AUTO_MERGE)).toBe(true)
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(JSON.parse(seen.files[AUTO_MERGE])).toEqual({ repositories: ['acme/other', 'acme/thing'] })
})

test('a move that fails removes the temporary file and leaves the list as it was', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'], mvFails: 'EACCES' })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('EACCES')
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other'])
})

const LOCK = AUTO_MERGE + '.lock'
const lockRuns = (seen: Seen) => seen.runs.filter((r) => r.argv?.includes(LOCK)).map((r) => r.argv[0])

test('auto-merge-set reads and writes the list holding its lock, and releases it', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'] })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm'])
  expect(seen.runs.findIndex((r) => r.argv?.[0] === 'sh')).toBeLessThan(seen.runs.findIndex((r) => r.argv?.[0] === 'mv'))
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock left by a holder that died is taken over', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: 0 } } })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm', 'sh', 'rm'])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock another session holds refuses the change, and stays its own', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: Date.now() } } })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('stays locked by another session')
  expect(lockRuns(seen)).not.toContain('rm')
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv')).toBe(false)
  expect(listed(seen)).toEqual(['acme/other'])
})

test('a malformed list is never overwritten', async ($, on) => {
  const seen = await world($, on)
  seen.files[AUTO_MERGE] = '{"repositories": [1]}'
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_MERGE]).toBe('{"repositories": [1]}')
})

test('auto-merge-set refuses a repository that is not owner/name', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS, 'thing'))
  expect(out.deny).toContain('owner/name')
  expect(seen.files).toEqual({})
})

test('auto-merge-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'deny', reason: 'no' } })
  await typed($, HIS_WORDS)
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toBe('no')
  expect(seen.files).toEqual({})
})

test('auto-merge-list prints the repositories in auto-merge', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing', 'acme/other'] })
  const out: any = await $.tool.call(gh('auto-merge-list', {}, undefined as any))
  expect(out.result).toBe('acme/thing\nacme/other')
})

test('auto-merge-list with no file says so', async ($, on) => {
  await world($, on)
  const out: any = await $.tool.call(gh('auto-merge-list', {}, undefined as any))
  expect(out.result).toBe('no repository in auto-merge')
})

for (const command of [
  'echo \'{"repositories":["a/b"]}\' > /data/auto-merge.json',
  'cd ~/.claude/plugins/data/github-lounisbou && jq . auto-merge.json > x && mv x auto-merge.json',
]) {
  test('a Bash command that names the auto-merge list is refused: ' + command.slice(0, 30), async ($, on) => {
    const seen = await world($, on)
    const out: any = await $.tool.call(bash(command))
    expect(out.deny).toContain('auto-merge-set')
    expect(seen.bash).toEqual([])
  })
}

for (const [tool, path] of [
  ['Write', AUTO_MERGE], ['Edit', AUTO_MERGE], ['Write', '/home/x/.claude/plugins/data/github-lounisbou/auto-merge.json'],
] as const) {
  test('a ' + tool + ' of the auto-merge list is refused: ' + path, async ($, on) => {
    await world($, on)
    const out: any = await $.tool.call({ tool, file_path: path, content: '{}', old_string: 'a', new_string: 'b' } as any)
    expect(out.deny).toContain('auto-merge-set')
  })
}

test('a Bash command that names the file outside the plugins\' data goes through', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(bash('grep -n auto-merge.json README.md'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['grep -n auto-merge.json README.md'])
})

test('a Write of another auto-merge.json, outside the plugins\' data, goes through', async ($, on) => {
  await world($, on)
  const out: any = await $.tool.call({ tool: 'Write', file_path: '/work/fixtures/auto-merge.json', content: '{}' } as any)
  expect(out.deny).toBeUndefined()
})

// ---- the operator speaks of auto-merge ----

test('a typed prompt that speaks of auto-merge enters with the line to call auto-merge-set and today\'s list', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/other'] })
  await typed($, 'le projet est en auto-merge')
  const context = seen.contexts.at(-1) ?? []
  expect(context.length).toBe(1)
  expect(context[0]).toContain('auto-merge-set')
  expect(context[0]).toContain('verbatim')
  expect(context[0]).toContain('acme/other')
})

for (const text of ['passe infra en Auto Merge', 'AUTOMERGE pour tout']) {
  test('every spelling of auto-merge is heard: ' + text, async ($, on) => {
    const seen = await world($, on)
    await typed($, text, 'bridge')
    expect((seen.contexts.at(-1) ?? []).join('')).toContain('auto-merge-set')
  })
}

test('a peer message that speaks of auto-merge adds no line', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'le projet est en auto-merge', 'peer')
  expect(seen.contexts.at(-1)).toEqual([])
})

test('a typed prompt that does not speak of auto-merge adds no line', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'merge it when green')
  expect(seen.contexts.at(-1)).toEqual([])
})

// ---- the operator's words, quoted inside a record's wrapping, and typed while the session works ----

// The moment the prompts are received and the day the module dates them: noon in UTC, a day
// everywhere the tests run.
const RECEIVED = Date.UTC(2026, 10, 2, 12, 0, 0)
const RECEIVED_DAY = '2026-11-02'
const SENTENCE = 'front-office#1660 est dispensé de tests de bout en bout sur la base de la relecture et des captures !'

test('a quote the operator typed counts inside the wrapping « … » — operator, date', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { git: CLEAN })
  await typed($, SENTENCE)
  for (const detail of [
    '« ' + SENTENCE + ' » — operator, ' + RECEIVED_DAY,
    'Operator waived E2E on ' + RECEIVED_DAY + ': "' + SENTENCE + '"',
    'Operator waived E2E on ' + RECEIVED_DAY + ': “' + SENTENCE + '”',
  ]) {
    const out: any = await $.tool.call(waiveCall(detail))
    expect(out.deny).toBeUndefined()
  }
  expect(recordRun(seen)).toContain('waived')
})

test('two quoted spans of one message count, each naming the waiver or the pull request', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  await world($, on, { git: CLEAN })
  await typed($, 'Pas de tests de bout en bout ici, ok. Et la pull request 12 reste telle quelle, merci.')
  const both = '« Pas de tests de bout en bout ici, ok. » and « la pull request 12 reste telle quelle » — operator, ' + RECEIVED_DAY
  expect(((await $.tool.call(waiveCall(both))) as any).deny).toBeUndefined()
})

test('a one-word answer counts in a quote only when it is the whole prompt', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  await world($, on, { git: CLEAN })
  const detail = 'Operator waived E2E on ' + RECEIVED_DAY + ' with « B », answering the E2E question'
  await typed($, 'Bonjour, voyons la suite')
  expect(((await $.tool.call(waiveCall(detail))) as any).deny).toContain('an E2E waiver quotes the operator')
  await typed($, 'B')
  expect(((await $.tool.call(waiveCall(detail))) as any).deny).toBeUndefined()
})

test('a waiver quote is refused when it was not typed, names no waiver, or is dated otherwise', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { git: CLEAN })
  await typed($, SENTENCE + ' Et aussi : je valide la suite des travaux sans réserve.')
  for (const detail of [
    '« ' + SENTENCE.replace('dispensé', 'privé') + ' » — operator, ' + RECEIVED_DAY,
    '« ' + SENTENCE + ' » — operator, 2001-01-01',
    '« ' + SENTENCE + ' » — operator',
    '« ' + SENTENCE + ' » — operator, ' + RECEIVED_DAY + ' and 2001-01-01',
    'B — ' + RECEIVED_DAY,
    '« ' + SENTENCE + ' » and « no E2E at all, ever, anywhere » — operator, ' + RECEIVED_DAY,
    // Free words outside the quote, a quote that says nothing of the waiver.
    'waived E2E for acme/thing#12 on ' + RECEIVED_DAY + ': « je valide la suite des travaux sans réserve »',
  ]) {
    const out: any = await $.tool.call(waiveCall(detail))
    expect(out.deny).toContain('an E2E waiver quotes the operator')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('the date of a waiver is the day its quote was received', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  await world($, on, { git: CLEAN })
  await typed($, SENTENCE)
  await clock.advance(72 * 3600 * 1000)
  const later = '« ' + SENTENCE + ' » — operator, 2026-11-05'
  expect(((await $.tool.call(waiveCall(later))) as any).deny).toContain('an E2E waiver quotes the operator')
  const received = '« ' + SENTENCE + ' » — operator, ' + RECEIVED_DAY
  expect(((await $.tool.call(waiveCall(received))) as any).deny).toBeUndefined()
})

test('auto-merge-set accepts a quote of the operator\'s typed words that names auto-merge in itself', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'thing : ' + HIS_WORDS)
  const wrapped: any = await $.tool.call(setAutoMerge(true, '« ' + HIS_WORDS + ' » — operator'))
  expect(wrapped.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

test('auto-merge-set refuses spans that name auto-merge only together or in the wrapping', async ($, on) => {
  const seen = await world($, on)
  await typed($, 'on est en auto merge, pour cette orchestration infra compris')
  for (const words of [
    'they said « on est en auto » « merge, pour cette orchestration » so it is on',
    'auto-merge: « pour cette orchestration infra compris »',
    '« on est en auto merge, pour cette orchestration » and « infra compris, vraiment » auto-merge',
  ]) {
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toContain('github: auto-merge-set')
  }
  expect(seen.files).toEqual({})
})

test('a prompt typed while the session works, over a running turn, counts as typed', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { git: CLEAN })
  const detail = '« ' + SENTENCE + ' » — operator, ' + RECEIVED_DAY
  expect(((await $.tool.call(waiveCall(detail))) as any).deny).toContain('an E2E waiver quotes the operator')
  await ($ as any).prompt.submit({ text: SENTENCE, origin: { kind: 'composer' }, wait: false, turnId: 'turn-1' })
  expect(((await $.tool.call(waiveCall(detail))) as any).deny).toBeUndefined()
  expect(recordRun(seen)).toContain('waived')
})

test('a peer\'s message delivered into a running turn is not the operator\'s word', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { git: CLEAN })
  await ($ as any).prompt.submit({ text: SENTENCE, origin: { kind: 'peer' }, wait: false, turnId: 'turn-1' })
  const out: any = await $.tool.call(waiveCall('« ' + SENTENCE + ' » — operator, ' + RECEIVED_DAY))
  expect(out.deny).toContain('an E2E waiver quotes the operator')
  expect(recordRun(seen)).toBeUndefined()
})

// ---- leaving draft is the operator's outside auto-merge ----

const LEAVE_DRAFT = 'outside auto-merge, leaving draft is the operator\'s, on GitHub after their review'

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a pr-ready outside auto-merge is refused with no question, a ready one too', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { verdict: { decision: 'ask' } })
      const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
      expect(out.deny).toBe('github: pr-ready refused on acme/thing: ' + LEAVE_DRAFT + ', and Ready is put by the gate once'
        + ' the four conditions hold (pr-readiness {"pr": 12, "state": "ready"} reads them now).')
      expect(seen.asked).toEqual([])
      expect(commands(seen)).not.toContain('pr-ready')
    })
  })

  test(phase + ': a pr-create out of draft outside auto-merge is refused with no question', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { verdict: { decision: 'ask' } })
      const out: any = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
      expect(String(out.deny)).toStartWith('github: pr-create refused')
      expect(seen.asked).toEqual([])
      expect(commands(seen)).toEqual([])
    })
  })

  test(phase + ': gh pr ready, the engine and GraphQL leaving draft outside auto-merge are refused with the same line', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on)
      const ready: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
      expect(ready.deny).toContain('github: gh pr ready refused on acme/thing: ' + LEAVE_DRAFT)
      const engine: any = await $.tool.call(bash('python3 ' + ROOT + '/engine/gh.py pr-ready 12 --repo acme/thing'))
      expect(engine.deny).toContain('github: gh.py pr-ready refused on acme/thing: ' + LEAVE_DRAFT)
      const graphql: any = await $.tool.call(bash('gh api graphql -f query=\'mutation{markPullRequestReadyForReview(input:{pullRequestId:"x"}){clientMutationId}}\''))
      expect(graphql.deny).toContain(LEAVE_DRAFT)
      expect(seen.bash).toEqual([])
      expect(seen.asked).toEqual([])
    })
  })
}

test('in auto-merge a ready pr-ready still runs, with no question', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
})

test('a merge outside auto-merge is still asked', async ($, on) => {
  const seen = await world($, on, { answer: 'Deny' })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('the user refused gh pr-merge')
  expect(seen.asked[0]).toContain('Merge a pull request')
})

// ---- the gate puts Ready ----

const readinessRuns = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-readiness').map((r) => [r.repo, r.args])
const e2eCall = { tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'ran the smoke suite' } as any
const WRITTEN = HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json'

test('a record that completes the four puts Ready, with one line', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, records: Object.fromEntries([record('review', 'pass'), record('norms', 'pass')]) })
  const out: any = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(out.result).toBe(WRITTEN + '\ngithub: acme/thing#12 Ready at 0123456:'
    + ' a clean review, a passed norms check, passed E2E and green CI hold at its head.')
})

test('a record written where CI is red puts no Ready, and says what is missing', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, ci: { result: 'FAILURE', failed: ['test'] } })
  const out: any = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([])
  expect(out.result).toBe(WRITTEN + '\ngithub: acme/thing#12 not Ready yet at 0123456. Missing: CI failed: test')
})

test('a record that leaves a Ready pull request short of the four puts Not Ready back', async ($, on) => {
  const records = Object.fromEntries([record('review', 'pass'), record('norms', 'pass'), record('e2e', 'fail')])
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'], records })
  const out: any = await $.tool.call({ ...e2eCall, result: 'fail' })
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(out.result).toContain('github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: fail at 0123456 by session-e2e')
})

test('a record on a pull request already Ready changes no label', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'] })
  const out: any = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([])
  expect(out.result).toBe(WRITTEN)
})

test('a label the gate cannot put leaves the record written, and says so', async ($, on) => {
  await world($, on, { git: CLEAN, readinessFails: 'error: forbidden' })
  const out: any = await $.tool.call(e2eCall)
  expect(out.isError).toBeUndefined()
  expect(out.result).toStartWith(WRITTEN + '\n')
  expect(out.result).toContain('github: the Ready label of acme/thing#12: label not written: error: forbidden')
})

const READY_LINE = 'github: acme/thing#12 Ready at 0123456: a clean review, a passed norms check, passed E2E and green CI hold at its head.'

test('a read of the gate through the tool puts Ready when the four hold, its JSON pure and its line the module\'s own', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  const gate = JSON.parse(out.result)
  expect(gate.labels).toEqual(['Ready'])
  expect(gate.head).toBe(HEAD)
  expect(seen.logs).toEqual([READY_LINE])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  // The read of the gate answers the gate; the head is read once more just before the write.
  expect(gates(seen)).toBe(2)
})

test('a read of the checks through the tool puts Ready when the four hold, its output left as it is', async ($, on) => {
  const seen = await world($, on)
  const checks: any = await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(checks.result).toBe('ok')
  expect(seen.logs).toEqual([READY_LINE])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(gates(seen)).toBe(2)
})

const ACTIONS_LINE = 'error: cannot read the Actions runs of ' + HEAD + ': boom (HTTP 500)'

test('a read of the gate through the tool shows the line of its Actions call, after a JSON the module still read', async ($, on) => {
  const seen = await world($, on, { readStderr: ACTIONS_LINE + '\n' })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  const cut = out.result.lastIndexOf('\n')
  expect(out.result.slice(cut + 1)).toBe(ACTIONS_LINE)
  // The module parsed the output as the gate wrote it: it put Ready and rewrote the labels.
  expect(JSON.parse(out.result.slice(0, cut)).labels).toEqual(['Ready'])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a read of the checks through the tool shows the line of its Actions call', async ($, on) => {
  await world($, on, { readStderr: ACTIONS_LINE + '\n' })
  const out: any = await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(out.result).toBe('ok\n' + ACTIONS_LINE)
})

test('the guard reads the gate with that line on stderr, shows it nowhere, and still parses', async ($, on) => {
  const seen = await world($, on, { readStderr: ACTIONS_LINE + '\n', autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
  expect(seen.logs).toEqual([])
})

test('a read that finds the four short of a pull request not Ready says nothing', async ($, on) => {
  const seen = await world($, on, { ci: { result: 'PENDING', running: 1 } })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(out.result).not.toContain('github:')
  expect(readinessRuns(seen)).toEqual([])
})

test('a read of a Ready pull request whose CI turned red puts Not Ready back', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], ci: { result: 'FAILURE', failed: ['lint'] } })
  const out: any = await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(out.result).toBe('ok')
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: CI failed: lint'])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
})

test('a merged pull request keeps its labels when read', async ($, on) => {
  const gate = { repo: 'acme/thing', pr: 12, state: 'merged', draft: false, head: HEAD, labels: ['Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 } }
  const seen = await world($, on, { gate })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

// ---- the Ready label by hand ----

for (const phase of ['warn', 'enforce'] as const) {
  test(phase + ': a Ready label put by hand on a pull request not ready is refused, on every route', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { ci: { result: 'FAILURE', failed: ['test'] } })
      for (const call of [
        gh('label-add', { pr: 12, label: ['Ready'] }),
        gh('pr-readiness', { pr: 12, state: 'ready' }),
        bash('gh pr edit 12 -R acme/thing --add-label Ready'),
        bash('gh api --method POST repos/acme/thing/issues/12/labels -f \'labels[]=Ready\''),
        bash('gh api -X PATCH repos/acme/thing/issues/12 -f \'labels[]=Ready\''),
        bash('gh api -X PATCH repos/acme/thing/pulls/12 -f labels=\'["Ready"]\''),
        bash('gh api -X PATCH https://api.github.com/repos/acme/thing/issues/12 --input labels.json'),
        bash('gh api https://api.github.com/repos/acme/thing/issues/12/labels -f labels=\'["Ready"]\''),
        bash('python3 ' + ROOT + '/engine/gh.py label-add 12 Ready --repo acme/thing'),
      ]) {
        const out: any = await $.tool.call(call)
        expect(String(out.deny)).toContain('not ready. Missing: CI failed: test.')
      }
      expect(seen.bash).toEqual([])
      expect(commands(seen).filter((c) => c !== 'pr-gate')).toEqual([])
    })
  })

  test(phase + ': a Ready label whose readiness cannot be read is refused', async ($, on) => {
    await inPhase(phase, async () => {
      const seen = await world($, on, { gateFails: 'error: boom' })
      const out: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
      expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: boom')
      const shell: any = await $.tool.call(bash('gh pr edit 12 --add-label Ready'))
      expect(shell.deny).toBe('github: gh pr edit refused: name the repository with -R owner/name.')
      expect(seen.bash).toEqual([])
    })
  })
}

test('a push still puts Not Ready back on a pull request the gate made Ready', async ($, on) => {
  const seen = await world($, on, {
    git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } },
    branch: 'feat',
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
  await $.tool.call(bash('git push origin feat'))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }], ['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(seen.pull?.labels).toEqual(['Not Ready'])
  expect(seen.logs).toEqual([READY_LINE, 'github: acme/thing#12 back to Not Ready after the push to feat'])
})

// The records norms and pr-review write come through the record tool's own handler, called from
// their modules: the handler is driven here as such a call reaches it, its caller a plugin.
test('a norms record written from the norms module puts Ready through the record tool\'s handler', async () => {
  const hooks: Record<string, Function> = {}
  register(((event: string, matcher: any, hook?: Function) => {
    hooks[event + (hook ? ':' + JSON.stringify(matcher) : '')] = hook ?? matcher
    return { catch: () => undefined }
  }) as any)
  const engine: any[] = []
  const fake: any = {
    plugin: { root: ROOT },
    tool: { check: async () => ({ decision: 'allow' }) },
    env: { get: async (name: string) => ({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/x' } as Record<string, string>)[name] },
    session: { id: async () => 'module-session' },
    ui: { log: () => undefined },
    fs: {
      list: async (path: string) => (path === HEAD_DIR ? Object.keys(FOUR).map((name) => ({ name, kind: 'file' })) : []),
      read: async (path: string) => FOUR[path.slice(HEAD_DIR.length + 1)],
    },
    process: {
      run: async (argv: string[], init: any) => {
        if (argv[0] === 'git') return { exitCode: 0, stdout: argv[1] === 'rev-parse' ? HEAD + '\n' : '', stderr: '' }
        if (String(argv[1]).endsWith('/engine/record.py')) {
          engine.push({ record: argv.slice(2) })
          return { exitCode: 0, stdout: HEAD_DIR + '/norms.json\n', stderr: '' }
        }
        const stdin = JSON.parse(init.stdin)
        engine.push(stdin)
        if (stdin.command === 'pr-gate') return { exitCode: 0, stdout: JSON.stringify(gateOf({})), stderr: '' }
        return { exitCode: 0, stdout: 'ready', stderr: '' }
      },
    },
  }
  const next = Object.assign((x: any) => x, { origin: { plugin: 'norms' } })
  const out = await hooks['tool.call:{"tool":"mcp__github__record"}'](fake, { pr: 12, repo: 'acme/thing', kind: 'norms', result: 'pass' }, next)
  expect(engine.find((r) => r.record)?.record).toContain('norms')
  expect(engine.filter((r) => r.command === 'pr-readiness').map((r) => r.args)).toEqual([{ pr: 12, state: 'ready' }])
  expect(out.result).toContain('github: acme/thing#12 Ready at 0123456')
})

// ---- the routes around leaving draft and around the gate ----

test('a pr-create out of draft outside auto-merge is refused before the writing rules, so no « Send as it is? » opens it', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Send as it is' })
  const call = gh('pr-create', { title: 'fix: x', body: 'no sections', draft: false })
  for (let k = 0; k < 2; k++) {
    const out: any = await $.tool.call(call)
    expect(out.deny).toContain('github: pr-create refused on acme/thing: ' + LEAVE_DRAFT)
  }
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual([])
})

test('gh pr ready --undo=false leaves draft and is refused outside auto-merge, --undo=true goes back to draft', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo=false'))
  expect(out.deny).toContain('github: gh pr ready refused on acme/thing: ' + LEAVE_DRAFT)
  expect(seen.bash).toEqual([])
  const back: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo=true'))
  expect(back.deny).toBeUndefined()
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
})

const ORIGIN = { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } }
const OPAQUE = 'gh api graphql -F query=@mutation.graphql'

test('a GraphQL query the command does not show is refused outside auto-merge', async ($, on) => {
  const seen = await world($, on, { git: ORIGIN, autoMerge: ['acme/other'] })
  for (const line of [OPAQUE, 'gh api /graphql --input body.json', 'gh api https://api.github.com/graphql -f query="$Q"']) {
    const out: any = await $.tool.call(bash(line))
    expect(String(out.deny), line).toStartWith('github: gh api graphql refused: its query cannot be read from the command')
  }
  expect(seen.bash).toEqual([])
})

test('a GraphQL query the command does not show warns in auto-merge, and is refused under enforce', async ($, on) => {
  const seen = await world($, on, { git: ORIGIN, autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash(OPAQUE))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual([OPAQUE])
  expect(seen.logs[0]).toContain('readiness unverified: the GraphQL query cannot be read from the command')
  await inPhase('enforce', async () => {
    const again: any = await $.tool.call(bash(OPAQUE))
    expect(again.deny).toBe('github: readiness of acme/thing#? unverified: the GraphQL query cannot be read from the command')
  })
  expect(seen.bash).toEqual([OPAQUE])
})

test('a GraphQL query the command does not show is refused when the guard fails to read the origin', async ($, on) => {
  const seen = await world($, on, { gitThrows: 'spawn failed', autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash(OPAQUE))
  expect(String(out.deny)).toStartWith('github: gh api graphql refused: its query cannot be read from the command')
  expect(seen.bash).toEqual([])
})

for (const [route, call] of UNDRAFT_ACTS) {
  test('a ' + route + ' undraft of a Not Ready pull request one of whose checks passed is no CI undraft, refused outside auto-merge', async ($, on) => {
    const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'FAILURE', failed: ['test'], total: 2 } })
    const out: any = await $.tool.call(call)
    expect(String(out.deny)).toContain(LEAVE_DRAFT)
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
  })
}

test('outside auto-merge the gate puts a pull request out of draft for its CI back to draft, then Ready', async ($, on) => {
  const seen = await world($, on, { draft: false, ciUndrafts: [{ repo: 'acme/thing', pr: 12, head: HEAD }] })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-draft', 'pr-readiness'])
  expect(seen.logs).toEqual(['github: acme/thing#12 back to draft, then Ready at 0123456: a clean review, a passed norms'
    + ' check, passed E2E and green CI hold at its head.'])
  const gate = JSON.parse(out.result)
  expect([gate.draft, gate.labels]).toEqual([true, ['Ready']])
})

// The head a pull request is marked as undrafted for CI at, or '' when it is not or the mark is spent.
const marked = (seen: Seen, repo = 'acme/thing', pr = 12): string => {
  const text = seen.files[ciUndraftFile(repo, pr)]
  return text === undefined ? '' : JSON.parse(text).head
}
const CI_PENDING = { result: 'PENDING', running: 0, skipped: ['test'], total: 1 }

test('a pull request the plugin undrafted for CI goes back to draft once the four hold, then Ready, and the mark is spent', async ($, on) => {
  const w: World = { ci: CI_PENDING }
  const seen = await world($, on, w)
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(marked(seen)).toBe(HEAD)
  seen.pull!.draft = false
  w.ci = {}
  seen.runs.length = 0
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-draft', 'pr-readiness'])
  expect(marked(seen)).toBe('')
})

test('a Bash CI undraft leaves the same mark', async ($, on) => {
  const seen = await world($, on, { ci: CI_PENDING })
  await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(marked(seen)).toBe(HEAD)
})

test('a pull request the plugin undrafted for CI stays covered when a push moves its head', async ($, on) => {
  const w: World = { ci: CI_PENDING, heads: [MOVED] }
  const seen = await world($, on, w)
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(marked(seen)).toBe(MOVED)
  // A correction is pushed: the head is another one, still out of draft, and the four hold at it.
  seen.pull!.draft = false
  w.ci = {}
  w.heads = [HEAD]
  seen.runs.length = 0
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-draft', 'pr-readiness'])
  expect(marked(seen)).toBe('')
})

for (const [route, call] of [['tool', () => gh('pr-ready', { pr: 12 })], ['Bash', () => bash('gh pr ready 12 -R acme/thing')]] as const) {
  test('a ' + route + ' CI undraft of a pull request the operator already took out of draft leaves no mark', async ($, on) => {
    const w: World = { draft: false, ci: CI_PENDING }
    const seen = await world($, on, w)
    await $.tool.call(call())
    expect(marked(seen)).toBe('')
    w.ci = {}
    seen.runs.length = 0
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
  })
}

test('a pull request the operator took out of draft gets Ready and stays out of draft', async ($, on) => {
  const seen = await world($, on, { draft: false })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
  expect(seen.logs).toEqual([READY_LINE])
  const gate = JSON.parse(out.result)
  expect([gate.draft, gate.labels]).toEqual([false, ['Ready']])
})

test('a mark left before the operator re-drafted and undrafted the pull request no longer covers it', async ($, on) => {
  const w: World = { ci: CI_PENDING }
  const seen = await world($, on, w)
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  // The operator re-drafts: the gate reads the draft and drops the mark.
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(marked(seen)).toBe('')
  // Then undrafts it himself, the four holding.
  seen.pull!.draft = false
  w.ci = {}
  seen.runs.length = 0
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
})

test('a mark is dropped with the pull request it names once that is closed', async ($, on) => {
  const gate = { repo: 'acme/thing', pr: 12, state: 'closed', draft: false, head: HEAD, labels: ['Not Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 } }
  const seen = await world($, on, { gate, ciUndrafts: [{ repo: 'acme/thing', pr: 12, head: HEAD }, { repo: 'acme/other', pr: 3, head: HEAD }] })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(marked(seen)).toBe('')
  expect(marked(seen, 'acme/other', 3)).toBe(HEAD)
})

test('in auto-merge the gate puts Ready on a pull request out of draft as it stands, marked or not', async ($, on) => {
  const seen = await world($, on, { draft: false, autoMerge: ['acme/thing'], ciUndrafts: [{ repo: 'acme/thing', pr: 12, head: HEAD }] })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
  expect(seen.logs).toEqual([READY_LINE])
})

test('a head that moves while the gate reads it gets no label, and the line says so', async ($, on) => {
  const seen = await world($, on, { heads: [HEAD, MOVED] })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(JSON.parse(out.result).labels).toEqual(['Not Ready'])
  expect(seen.logs).toEqual(['github: the Ready label of acme/thing#12 is left as it is: the head moved from 0123456 to'
    + ' fedcba9 while the gate read it, no label written.'])
})

test('records that cannot be listed leave the label as it is, never Not Ready, and say so', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], listFails: 'EACCES: permission denied' })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toStartWith('github: the Ready label of acme/thing#12 is left as it is: the records of 0123456 cannot be listed: ')
  expect(seen.logs[0]).toContain('EACCES: permission denied')
})

test('records that cannot be listed are an unverified readiness to the guard', async ($, on) => {
  await world($, on, { listFails: 'EACCES: permission denied' })
  const out: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: the records of 0123456 cannot be listed: ')
  expect(out.deny).toContain('EACCES: permission denied')
})

test('a head with no records directory holds none: a Ready pull request goes back to Not Ready', async ($, on) => {
  const gate = { repo: 'acme/thing', pr: 12, state: 'open', draft: true, head: MOVED, labels: ['Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 } }
  const seen = await world($, on, { gate })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(seen.logs[0]).toContain('back to Not Ready at fedcba9. Missing: review: no record at fedcba9')
})

test('warn: a Bash Ready label whose guard throws is refused, never let through with a warn line', async ($, on) => {
  const seen = await world($, on, { gate: BROKEN_GATE })
  const out: any = await $.tool.call(bash('gh pr edit 12 -R acme/thing --add-label Ready'))
  expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: ')
  expect(seen.bash).toEqual([])
  expect(seen.logs).toEqual([])
})

test('a record written on a closed pull request moves no label and says nothing more', async ($, on) => {
  const gate = { repo: 'acme/thing', pr: 12, state: 'closed', draft: false, head: HEAD, labels: ['Not Ready'],
    ci: { result: 'FAILURE', failed: ['test'], running: 0, skipped: [], total: 1 } }
  const seen = await world($, on, { git: CLEAN, gate })
  const out: any = await $.tool.call(e2eCall)
  expect(out.result).toBe(WRITTEN)
  expect(readinessRuns(seen)).toEqual([])
})

test('a read the gate does not follow reads no gate: another read, no pull request, no repository, a gate it cannot parse', async ($, on) => {
  const seen = await world($, on)
  expect(await $.tool.call(gh('pr-get', { branch: 'feat' }))).toEqual({ result: '[]' })
  expect(await $.tool.call(gh('pr-checks', {}))).toEqual({ result: 'ok' })
  expect(await $.tool.call(gh('pr-checks', { pr: 'x' }))).toEqual({ result: 'ok' })
  expect(await $.tool.call(gh('pr-checks', { pr: 12 }, ''))).toEqual({ result: 'ok' })
  expect(gates(seen)).toBe(0)
  expect(seen.logs).toEqual([])
})

test('a pr-gate answer that does not parse is given back as it is, with no second read', async ($, on) => {
  const seen = await world($, on, { gate: 'not json' })
  expect(await $.tool.call(gh('pr-gate', { pr: 12 }))).toEqual({ result: 'not json' })
  expect(gates(seen)).toBe(1)
  expect(readinessRuns(seen)).toEqual([])
})

// ---- records carried across a rebase that leaves the diff unchanged ----

const OLD = 'abcdef0123456789abcdef0123456789abcdef01'
const OLD_DIR = RECORDS + '/acme/thing/' + OLD
const SAME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const fingerprintRuns = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-fingerprint')
  .map((r) => r.args.head + (r.args.count === undefined ? '' : ' x' + r.args.count))
// Each world's earlier head directory has a new mtime, as a directory a record lands in does.
let earlierMtime = 0
const fingerprintFile = (head: string) => '/data/fingerprint.acme%2Fthing.12.' + head + '.json'

// The earlier head's records as the store holds them, beside the current head's directory, and the
// commit count a gate read found at that head (none when null).
function earlier(records: Array<[string, string]>, dir = OLD_DIR, commits: number | null = 2): World['tree'] {
  const tree: NonNullable<World['tree']> = {
    [RECORDS + '/acme/thing']: { kind: 'directory', mtimeMs: 0 },
    [dir]: { kind: 'directory', mtimeMs: ++earlierMtime },
  }
  if (commits !== null) {
    const head = dir.slice(dir.lastIndexOf('/') + 1)
    tree[fingerprintFile(head)] = { kind: 'file', mtimeMs: 0, text: JSON.stringify({ v: 3, repo: 'acme/thing', pr: 12, head, commits }) }
  }
  for (const [name, text] of records) tree[dir + '/' + name] = { kind: 'file', mtimeMs: 0, text }
  return tree
}
const at = (kind: string, result: string, over: Record<string, unknown> = {}, when = '2026-11-01T10:00:00Z') =>
  record(kind, result, when, { head: OLD, ...over })
const CLEAN_OLD = [at('review', 'pass'), at('norms', 'pass'), at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' })]

test('a rebase that leaves the diff unchanged carries the review, the norms check and the E2E waiver: Ready on green CI', async ($, on) => {
  const seen = await world($, on, { records: {}, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_LINE.slice(0, -1)
    + ' (review carried from abcdef0, norms carried from abcdef0, e2e carried from abcdef0).'])
  // Each head is fingerprinted once, the earlier one over the head's commit count: the second read takes both from the data directory.
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('a rebase that changed the diff carries nothing', async ($, on) => {
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: OTHER } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456,'
    + ' norms: no record at 0123456, e2e: no record at 0123456'])
})

test('an E2E pass at the earlier head is not carried: E2E runs again, the review and norms are carried', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('norms', 'pass'), at('e2e', 'pass')])
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: no record at 0123456;'
    + ' review carried from abcdef0, norms carried from abcdef0'])
})

test('a review that failed last at the earlier head is not carried, nor is a kind already recorded at the head', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('review', 'fail', {}, '2026-11-01T11:00:00Z'), at('norms', 'pass'), at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' })])
  const seen = await world($, on, {
    records: Object.fromEntries([record('e2e', 'fail')]), labels: ['Ready'], tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456,'
    + ' e2e: fail at 0123456 by p-e2e; norms carried from abcdef0'])
})

test('a review failed at a later head of the same diff is not carried from an earlier head where it passed', async ($, on) => {
  const LATER = '1111111111111111111111111111111111111111'
  const tree = {
    ...earlier(CLEAN_OLD),
    ...earlier([at('review', 'fail', { head: LATER }, '2026-11-01T11:00:00Z')], RECORDS + '/acme/thing/' + LATER),
  }
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME, [LATER]: SAME } })
  const out: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.deny).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
})

test('a second gate read with the records unchanged still reads Ready with the same carried kinds', async ($, on) => {
  const seen = await world($, on, { records: {}, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs).toEqual([READY_LINE.slice(0, -1)
    + ' (review carried from abcdef0, norms carried from abcdef0, e2e carried from abcdef0).'])
})

test('a head whose commits cannot be fingerprinted (a merge in the pull request) carries nothing, and says so in one line', async ($, on) => {
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual([
    'github: acme/thing#12: no record carried to 0123456: 0123456\'s commits cannot be fingerprinted: error: commit 1234567 is a merge',
    'github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456,'
      + ' norms: no record at 0123456, e2e: no record at 0123456',
  ])
})

test('the records of another pull request with the same diff are never carried, nothing is fingerprinted', async ($, on) => {
  const tree = earlier(CLEAN_OLD.map(([name]) => at(name.split('.')[0], name.startsWith('e2e') ? 'waived' : 'pass', { pr: 13, detail: 'no E2E, 2026-11-01' })))
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toContain('Missing: review: no record at 0123456, norms: no record at 0123456, e2e: no record at 0123456')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('a refused Ready label names the records carried beside what is missing', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('norms', 'pass')])
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.deny).toContain('Missing: e2e: no record at 0123456; review carried from abcdef0, norms carried from abcdef0.')
})

test('an earlier head whose commits cannot be fingerprinted carries nothing, and says so in one line', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME },
    fingerprintFails: 'error: abcdef0 has fewer than 2 commits along its first parents',
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review, norms, e2e record carried to 0123456: abcdef0\'s commits cannot be fingerprinted:'
    + ' error: abcdef0 has fewer than 2 commits along its first parents')
  expect(seen.logs[1]).toContain('Missing: review: no record at 0123456')
})

test('a kept fingerprint of another version is computed again, and a kept count is fingerprinted once', async ($, on) => {
  const seen = await world($, on, { records: {}, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  seen.files[fingerprintFile(HEAD)] = JSON.stringify({ v: 2, fingerprint: OTHER, commits: 2 })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
  expect(JSON.parse(seen.files[fingerprintFile(OLD)])).toEqual({ v: 3, repo: 'acme/thing', pr: 12, head: OLD, commits: 2, fingerprint: SAME })
})

test('an earlier head of more commits whose top ones are the head\'s carries nothing, and is not fingerprinted', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], commits: 2, tree: earlier(CLEAN_OLD, OLD_DIR, 3), fingerprints: { [HEAD]: SAME, [OLD]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456,'
    + ' norms: no record at 0123456, e2e: no record at 0123456'])
  expect(fingerprintRuns(seen)).toEqual([HEAD + ' x2'])
})

test('the commit count a gate read finds at its head is kept for when it is an earlier head', async ($, on) => {
  const seen = await world($, on, { commits: 4 })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(seen.files[fingerprintFile(HEAD)])).toEqual({ v: 3, repo: 'acme/thing', pr: 12, head: HEAD, commits: 4 })
})

test('an earlier head whose commit count was never read carries nothing of the kinds it holds, and says so', async ($, on) => {
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD, OLD_DIR, null), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review, norms, e2e record carried to 0123456: abcdef0\'s commits cannot be fingerprinted:'
    + ' the pull request was never read at that head, its commit count is not known')
  expect(fingerprintRuns(seen)).toEqual([HEAD])
})

test('a review failed at a later head that cannot be fingerprinted is not carried from an earlier head where it passed', async ($, on) => {
  const LATER = '1111111111111111111111111111111111111111'
  const tree = {
    ...earlier(CLEAN_OLD),
    ...earlier([at('review', 'fail', { head: LATER }, '2026-11-01T11:00:00Z')], RECORDS + '/acme/thing/' + LATER),
  }
  const seen = await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.deny).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review record carried to 0123456: 1111111\'s commits cannot be fingerprinted:'
    + ' error: commit 1234567 is a merge')
})

test('an earlier head whose records cannot be listed lets no earlier head carry, and says so', async ($, on) => {
  const LATER = '1111111111111111111111111111111111111111'
  const tree = { ...earlier(CLEAN_OLD), ...earlier([], RECORDS + '/acme/thing/' + LATER) }
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], tree, unlistable: RECORDS + '/acme/thing/' + LATER, fingerprints: { [HEAD]: SAME, [OLD]: SAME, [LATER]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toBe('github: acme/thing#12: no record carried to 0123456: the records of 1111111 cannot be listed:'
    + ' github: $.fs.list: EACCES ' + RECORDS + '/acme/thing/' + LATER)
  expect(seen.logs[1]).toContain('Missing: review: no record at 0123456, norms: no record at 0123456, e2e: no record at 0123456')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('an earlier head whose records name only other pull requests is read once, until a record lands in it', async ($, on) => {
  const tree = earlier([at('review', 'pass', { pr: 13 })])
  const seen = await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const oldReads = () => seen.reads.filter((path) => path.startsWith(OLD_DIR + '/')).length
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(oldReads()).toBe(1)
  expect(fingerprintRuns(seen)).toEqual([])
  const [name, text] = at('norms', 'pass')
  tree![OLD_DIR + '/' + name] = { kind: 'file', mtimeMs: 0, text }
  tree![OLD_DIR] = { kind: 'directory', mtimeMs: ++earlierMtime }
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  // Read again once it changed: the new record names the pull request, so it is fingerprinted.
  expect(oldReads()).toBe(3)
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('the daily pruning removes the fingerprints kept past 90 days with the old records', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'directory', mtimeMs: now },
    '/data': { kind: 'directory', mtimeMs: now },
    [fingerprintFile(OLD)]: { kind: 'file', mtimeMs: now - 100 * DAY },
    [fingerprintFile(HEAD)]: { kind: 'file', mtimeMs: now - 10 * DAY },
    '/data/auto-merge.json': { kind: 'file', mtimeMs: now - 100 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs.map((r) => r.argv)).toEqual([['rm', '-rf', '--', fingerprintFile(OLD)]])
})
