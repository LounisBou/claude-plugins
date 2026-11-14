// The ready guard, the auto-merge split, the label following the head, the
// records guard and the record tool, through the module as the session runs
// it: the tool's calls, Bash, Write, and the engine stubbed per scenario.
import { expect, mock, test } from 'claude-code/testing'
import { register } from './register.js'
import { RECORDS_REFUSAL, STDIN_REFUSAL } from './ready.js'
import { CONSENT_GRANT } from '../core/consent-record.ts'

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '')
// The writing rules read this file of the plugin, which no scenario below is about.
const NEGATIVE_FILE = ROOT + '/engine/negative-phrases.json'
const NEGATIVE_TEXT = JSON.stringify({ phrases: ['unchanged'] })
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED = 'fedcba9876543210fedcba9876543210fedcba98'
const RECORDS = '/cfg/pr-records'
const HEAD_DIR = RECORDS + '/acme/thing/' + HEAD
const AUTO_MERGE = '/data/auto-merge.json'
const AUTO_DEPLOY = '/data/auto-deploy.json'
const EXEMPTION = '/data/e2e-exempt/acme/thing.json'
const PLAN = '/data/check-plans/acme/thing/12.json'
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
  // The deploy list file, as written (an object) or as raw text.
  deployList?: unknown
  // The CI undrafts the plugin already made, one mark file each.
  ciUndrafts?: Array<{ repo: string; pr: number; head: string }>
  // git's answers, by its argv after git.
  git?: Record<string, { exitCode: number; stdout: string }>
  // git's answers in another directory than the session's, by that directory, then by argv after git.
  gitIn?: Record<string, Record<string, { exitCode: number; stdout: string }>>
  verdict?: any
  answer?: string
  // What the Bash tool answers.
  bashResult?: any
  // What record.py answers when it fails: its exit code and stderr.
  recordFails?: { exitCode: number; stderr: string }
  // The files and directories $.fs sees beside the records, by path.
  tree?: Record<string, { kind: 'file' | 'dir'; mtimeMs: number; text?: string }>
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
  // A stat that fails with this text, whatever the path.
  statFails?: string
  // The branch whose pull request (#12) pr-get answers with its labels as they stand.
  branch?: string
  // Every git run fails in the host itself, with this error.
  gitThrows?: string
  // pr-files' answer: the pull request's files, or a failing exit with this stderr.
  files?: Array<Record<string, unknown>>
  filesFails?: string
  // The repository's E2E exemption file, as written (an object) or as raw text.
  exemption?: unknown
  // The pull request's check plan file, as written.
  plan?: unknown
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
  runs: any[]; asked: string[]; logs: string[]; writes: Array<{ path: string; text: string }>; bash: string[]; skills: string[]
  // The files of the plugin's data directory, by path.
  files: Record<string, string>
  // The context each prompt entered with.
  contexts: string[][]
  // The paths $.fs read, in order.
  reads: string[]
  // The input of each permission check the tools asked.
  checks: any[]
}

function record(kind: string, result: string, at = '2026-11-01T10:00:00Z', over: Record<string, unknown> = {}): [string, string] {
  const name = kind + '.' + at.replace(/[-:]/g, '') + '.p-' + kind + '.json'
  const body = { v: 1, repo: 'acme/thing', pr: 12, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: '', at, ...over }
  return [name, JSON.stringify(body)]
}

const FOUR = Object.fromEntries([record('review', 'pass'), record('norms', 'pass'), record('e2e', 'pass')])
const FOUR_REVIEW = record('review', 'pass')[0]

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
  const seen: Seen = { runs: [], asked: [], logs: [], writes: [], bash: [], skills: [], files: {}, contexts: [], reads: [], checks: [] }
  if (w.autoMerge !== undefined) seen.files[AUTO_MERGE] = JSON.stringify({ repositories: w.autoMerge })
  if (w.deployList !== undefined) seen.files[AUTO_DEPLOY] = typeof w.deployList === 'string' ? w.deployList : JSON.stringify(w.deployList)
  for (const m of w.ciUndrafts ?? []) seen.files[ciUndraftFile(m.repo, m.pr)] = JSON.stringify({ v: 1, ...m })
  if (w.plan !== undefined) seen.files[PLAN] = JSON.stringify(w.plan)
  if (w.exemption !== undefined) seen.files[EXEMPTION] = typeof w.exemption === 'string' ? w.exemption : JSON.stringify(w.exemption)
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
  on('tool.check', (_$: any, e: any) => {
    seen.checks.push(e.input)
    return e.tool === 'AskUserQuestion' || e.tool === 'Read' ? { decision: 'allow' } : w.verdict ?? { decision: 'allow' }
  })
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
  on('tool.call', { tool: 'Skill' }, (_$: any, e: any) => {
    seen.skills.push(e.skill)
    return { result: { success: true, commandName: e.skill } }
  })
  for (const tool of ['Write', 'Edit', 'MultiEdit']) on('tool.call', { tool }, () => ({ result: 'written' }))
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('ui.log', (_$: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in tree || e.path in seen.files || (!!w.listFails && e.path === HEAD_DIR) }))
  on('fs.stat', (_$: any, e: any) => w.statFails ? { deny: w.statFails }
    : e.path in tree ? { value: { kind: tree[e.path].kind, size: 0, mtimeMs: tree[e.path].mtimeMs, isLink: false } } : { deny: 'ENOENT ' + e.path })
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
    if (e.path === NEGATIVE_FILE) return { value: NEGATIVE_TEXT }
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
    if (e.path.startsWith('/data/')) seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
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
      const cwd = e.init?.cwd
      const answers = cwd !== undefined && cwd !== '/work' ? w.gitIn?.[cwd] : w.git
      const answer = answers?.[e.argv.slice(1).join(' ')]
      return { value: answer ? { stderr: '', ...answer } : { exitCode: 1, stdout: '', stderr: 'no' } }
    }
    if (String(e.argv[1] ?? '').endsWith('/engine/record.py')) {
      if (w.recordFails) return { value: { stdout: '', ...w.recordFails } }
      // The record lands among the head's records, as its writer puts it there.
      const option = (name: string) => e.argv[e.argv.indexOf(name) + 1]
      // An acceptance keeps its producer and the detail that names the failed record it answers.
      const acceptance = option('--result') === 'accepted' ? { producer: option('--producer'), detail: option('--detail') } : {}
      const [name, text] = record(option('--kind'), option('--result'), '2026-11-02T10:00:00Z', { producer: 'session-e2e', ...acceptance })
      records[name] = text
      return { value: { exitCode: 0, stdout: HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json\n', stderr: '' } }
    }
    if (stdin.command === 'pr-gate') {
      if (w.gateFails) return { value: { exitCode: 3, stdout: '', stderr: w.gateFails } }
      const gate = gateOf(w, pull)
      return { value: { exitCode: 0, stdout: typeof gate === 'string' ? gate : JSON.stringify(gate), stderr: w.readStderr ?? '' } }
    }
    if (stdin.command === 'pr-files' && w.filesFails) return { value: { exitCode: 3, stdout: '', stderr: w.filesFails } }
    if (stdin.command === 'pr-files' && w.files) return { value: { exitCode: 0, stdout: JSON.stringify(w.files), stderr: '' } }
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

const REFUSAL_END = ' What Ready needs is core\'s readiness contract (core/readiness.ts).'

// ---- the tool ----

test('refused by the person, the gate is read once and nothing runs', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], answer: 'Deny', autoMerge: ['acme/thing'], verdict: { decision: 'ask', rule: 'mcp__github__gh' } })
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(gates(seen)).toBe(1)
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a not-ready pr-ready outside auto-merge is refused before anyone is asked', async ($, on) => {
  const seen = await world($, on, NO_RECORDS)
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toBe('github: pr-ready refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
    + ' 0123456, e2e: no record at 0123456.' + REFUSAL_END)
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a ready pr-ready outside auto-merge is refused, never asked', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate'])
})

// This was the warn phase's test, where a not-ready pr-ready in auto-merge ran with a warn line
// in guard-warn.log. The gate now refuses it, so the act, the question and the log are asserted
// the other way: refused with the missing conditions, nobody asked, only the gate read, no line.
test('in auto-merge a not-ready pr-ready is refused before anyone is asked, nothing run and nothing logged', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toBe('github: pr-ready refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
    + ' 0123456, e2e: no record at 0123456.' + REFUSAL_END)
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate'])
  expect(seen.writes.some((w) => w.path === '/data/guard-warn.log')).toBe(false)
})

test('in auto-merge a not-ready merge is refused before anyone is asked, nothing run', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
    + ' 0123456, e2e: no record at 0123456.' + REFUSAL_END)
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate'])
})

/*
 * These merges ran when CI was left to GitHub alone. A merge now needs the Ready label, which the
 * gate puts only with CI green: a merge whose CI failed or still runs is refused, CI named.
 */
for (const [state, ci, item] of [['failed', { result: 'FAILURE', failed: ['lint'] }, 'CI failed: lint'], ['still runs', { result: 'PENDING', running: 1 }, 'CI still running']] as const) {
  test('in auto-merge a merge whose CI ' + state + ' is refused: Ready needs CI green', async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], ci, verdict: { decision: 'ask' } })
    const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: ' + item + '.' + REFUSAL_END)
    expect(seen.asked.length).toBe(0)
    expect(commands(seen)).toEqual(['pr-gate'])
  })
}

test('in auto-merge a ready merge runs with no question, the gate putting Ready on it first', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness', 'pr-merge'])
  expect(seen.runs.find((r) => r.command === 'pr-readiness')?.args).toEqual({ pr: 12, state: 'ready' })
})

// No route merges a pull request the gate has not labelled Ready: the label lands before the merge
// runs, or the merge is refused and the pull request keeps Not Ready.
const MERGE_ACTS = [
  ['tool', gh('pr-merge', { pr: 12 })],
  ['Bash', bash('gh pr merge 12 -R acme/thing --squash')],
] as const

for (const [route, call] of MERGE_ACTS) {
  for (const [label, w] of [
    ['no review', NO_RECORDS],
    ['CI failed', { ci: { result: 'FAILURE', failed: ['lint'] } }],
    ['CI still running', { ci: { result: 'PENDING', running: 1 } }],
  ] as const) {
    test('a ' + route + ' merge in auto-merge never runs without Ready: ' + label + ' refuses it and Not Ready stays', async ($, on) => {
      const seen = await world($, on, { ...w, autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(call)
      expect(out.deny).toContain('not ready')
      expect(actRan(seen, route, 'pr-merge')).toBe(0)
      expect(seen.pull?.labels).toEqual(['Not Ready'])
    })
  }

  test('a ' + route + ' merge in auto-merge of a ready pull request runs once the gate put Ready', async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'] })
    const out: any = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
    expect(actRan(seen, route, 'pr-merge')).toBe(1)
    expect(seen.pull?.labels).toEqual(['Ready'])
  })
}

test('a merge pinned to a head that moved is refused', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12, sha: MOVED }))
  expect(out.deny).toContain('the head moved: ' + MOVED + ' given, ' + HEAD + ' on GitHub')
})

for (const [where, autoMerge] of [['outside auto-merge', []], ['in auto-merge', ['acme/thing']]] as const) {
  test('a pull request opened out of draft is refused ' + where + ', a draft is not', async ($, on) => {
    const seen = await world($, on, { autoMerge: [...autoMerge] })
    const out: any = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
    expect(out.deny).toBe('github: pr-create refused: open it as a draft, then leave draft once ready.')
    expect(seen.asked.length).toBe(0)
    const draft: any = await $.tool.call(gh('pr-create', { title: 'fix: x' }))
    expect(draft).toEqual({ result: 'ok' })
  })
}

test('an unreadable readiness refuses with the engine error', async ($, on) => {
  await world($, on, { gateFails: 'error: rate limited' })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: rate limited')
})

test('a deny rule still refuses first, and the guard reads nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' } })
  const out: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('denied by rule')
  expect(seen.runs).toEqual([])
})

// ---- a failure of the guard itself ----

// A pr-gate answer with no repository: reading the records at its head throws
// inside the guard.
const BROKEN_GATE = {
  pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
  ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1 },
}

for (const [route, call] of [['Bash', bash('gh pr merge 12 -R acme/thing --squash')], ['tool', gh('pr-merge', { pr: 12 })]] as const) {
  test('a guard that throws on a ' + route + ' merge reads as unverified readiness', async ($, on) => {
    const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/thing'] })
    const out: any = await $.tool.call(call)
    const ran = route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === 'pr-merge').length
    expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: ')
    expect(ran).toBe(0)
  })
}

// A Bash merge outside auto-merge is refused on the list alone, before any
// readiness read, so a guard that would throw on the read changes nothing. An undraft
// reads the readiness first, as a CI undraft passes outside auto-merge: when that read
// throws, the guard's failure handler refuses it on the list.
test('a Bash merge outside auto-merge is refused on the list before any readiness read', async ($, on) => {
  const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
  const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(out.deny).toContain('github: gh pr merge refused on acme/thing: this repository is not in auto-merge')
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})

test('a Bash undraft outside auto-merge whose guard throws is refused on the list', async ($, on) => {
  const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
  const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(String(out.deny)).toContain('github: gh pr ready refused on acme/thing: outside auto-merge, leaving draft is the operator\'s')
  expect(seen.bash.length).toBe(0)
  expect(seen.logs).toEqual([])
})

for (const [where, autoMerge] of [['outside auto-merge', 'acme/other'], ['in auto-merge', 'acme/thing']] as const) {
  test('a Bash pull request opened out of draft ' + where + ' is refused whatever the readiness read gives', async ($, on) => {
    const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: [autoMerge] })
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
    expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
    expect(seen.bash.length).toBe(0)
    expect(commands(seen)).toEqual([])
  })
}

// ---- leaving draft for CI ----

test('a Not Ready pull request whose CI is not green leaves draft through the tool, still Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
})

test('a CI undraft through the tool passes outside auto-merge too, with no question', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, verdict: { decision: 'ask' }, answer: 'Deny', ci: { result: 'PENDING', skipped: ['test'] } })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
})

test('an undraft outside auto-merge that is no CI undraft is refused, never asked', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], answer: 'Allow' })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
  expect(seen.asked).toHaveLength(0)
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a Bash CI undraft passes outside auto-merge too, with one line', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'FAILURE', failed: ['test'] } })
  const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing'])
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
})

test('going back to draft is always let through, and puts Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
  const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo'))
  expect(out.deny).toBeUndefined()
  expect(seen.runs.map((r) => r.command)).toEqual(['pr-readiness'])
  expect(seen.runs[0].args).toEqual({ pr: 12, state: 'not-ready' })
  const tool: any = await $.tool.call(gh('pr-draft', { pr: 12 }))
  expect(tool).toEqual({ result: 'ok' })
  expect(gates(seen)).toBe(0)
})

test('going back to draft through the tool is not asked outside auto-merge', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Deny' })
  const out: any = await $.tool.call(gh('pr-draft', { pr: 12 }, 'acme/other'))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-draft'])
})

test('a pull request that carries Ready, or whose CI is green, is no CI undraft', async ($, on) => {
  await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const green: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(green.deny).toContain('not ready')
})

// ---- the undraft against CI ----

const UNDRAFT_ACTS = [
  ['tool', gh('pr-ready', { pr: 12 })],
  ['Bash', bash('gh pr ready 12 -R acme/thing')],
] as const

// Whether the act itself ran: the engine's command, or the Bash line.
const actRan = (seen: Seen, route: string, command: string) =>
  route === 'Bash' ? seen.bash.length : commands(seen).filter((c) => c === command).length

for (const [route, call] of UNDRAFT_ACTS) {
  // This undraft ran when CI was left to GitHub alone: a Ready label with CI not green is now taken
  // off by the gate, which refuses the act, still no CI undraft.
  test('a ' + route + ' undraft of a pull request carrying Ready with CI not green is no CI undraft, refused and Ready taken off', async ($, on) => {
    const seen = await world($, on, { labels: ['Ready'], autoMerge: ['acme/thing'], ci: { result: 'PENDING', running: 1 } })
    const out: any = await $.tool.call(call)
    expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
    expect(out.deny).toContain('not ready. Missing: CI still running')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.pull?.labels).toEqual(['Not Ready'])
  })

  test('a ' + route + ' undraft of a pull request carrying Ready with no review is refused, never a CI undraft', async ($, on) => {
    const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'], autoMerge: ['acme/thing'], ci: { result: 'PENDING', running: 1 } })
    const out: any = await $.tool.call(call)
    expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at 0123456')
    expect(out.deny).not.toContain('CI still running')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
  })
}

/*
 * The gate puts Ready before a merge or an undraft; when it cannot say whether it did (the label could
 * not be written, the head moved while it read), the act is refused as an unverified readiness and
 * nothing runs: never a pass on a label the gate could not put.
 */
for (const [route, call, command] of [
  ...MERGE_ACTS.map(([route, call]) => [route, call, 'pr-merge'] as const),
  ...UNDRAFT_ACTS.map(([route, call]) => [route, call, 'pr-ready'] as const),
]) {
  for (const [label, w, error] of [
    ['the Ready label cannot be written', { readinessFails: 'error: forbidden' }, 'label not written: error: forbidden'],
    ['the head moves while the gate reads it', { heads: [HEAD, MOVED] }, 'the head moved from 0123456 to fedcba9 while the gate read it'],
  ] as const) {
    test('a ' + route + ' ' + command + ' in auto-merge is refused, nothing run, when ' + label, async ($, on) => {
      const seen = await world($, on, { ...w, autoMerge: ['acme/thing'] })
      const out: any = await $.tool.call(call)
      expect(out.deny).toContain('github: readiness of acme/thing#12 unverified: ')
      expect(out.deny).toContain(error)
      expect(actRan(seen, route, command)).toBe(0)
      expect(seen.asked.length).toBe(0)
      expect(seen.pull?.labels).toEqual(['Not Ready'])
    })
  }
}


// ---- Bash ----

test('a Bash merge or undraft outside auto-merge is refused with the tool call to make', async ($, on) => {
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

test('a Bash merge without a repository is refused, so is a GraphQL merge', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash('gh pr merge 12 --squash'))
  expect(out.deny).toBe('github: gh pr merge refused: name the repository with -R owner/name.')
  const graphql: any = await $.tool.call(bash('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
  expect(graphql.deny).toContain('github: gh api graphql refused')
  expect(seen.bash).toEqual([])
})

test('a ready Bash merge in auto-merge passes', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'] })
  const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD))
  expect(out.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
  expect(seen.logs).toEqual([])
})

// This merge ran when CI was left to GitHub alone: Ready now needs CI green, so it is refused.
test('a Bash merge in auto-merge whose CI failed is refused: Ready needs CI green', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] } })
  const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(out.deny).toBe('github: gh pr merge refused on acme/thing#12 at 0123456: not ready. Missing: CI failed: lint.' + REFUSAL_END)
  expect(seen.bash.length).toBe(0)
})

test('a not-ready Bash merge in auto-merge is refused, --auto too', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const refused: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(refused.deny).toBe('github: gh pr merge refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
    + ' 0123456, e2e: no record at 0123456.' + REFUSAL_END)
  const auto: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing --auto'))
  expect(auto.deny).toContain('github: gh pr merge refused on acme/thing#12 at 0123456: not ready.')
  expect(seen.bash.length).toBe(0)
})

test('a not-ready Bash undraft in auto-merge, out of CI undraft, is refused', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], labels: [] })
  const out: any = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(out.deny).toContain('not ready')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge whose readiness cannot be read is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], gateFails: 'error: boom' })
  const out: any = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
  expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: boom')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge of the current branch\'s pull request reads it with pr-get', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'], pulls: { '': [{ number: 12 }] } })
  await $.tool.call(bash('gh pr merge -R acme/thing'))
  expect(commands(seen)).toEqual(['pr-get', 'pr-gate'])
  expect(seen.runs[0].repo).toBe('acme/thing')
  expect(seen.runs[1].args).toEqual({ pr: 12 })
})

test('a Bash pull request opened out of draft is refused outside auto-merge', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b body'))
  expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  expect(seen.bash.length).toBe(0)
})

test('a Bash gh pr create --draft=false is refused outside auto-merge, like one with no --draft', async ($, on) => {
  const seen = await world($, on)
  const body = '"Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'
  for (const flag of ['--draft=false', '--draft=0']) {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  }
  expect(seen.bash.length).toBe(0)
  for (const flag of ['--draft=true', '--draft']) {
    const out: any = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toBeUndefined()
  }
})

test('a Bash pull request opened out of draft is refused in auto-merge too', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash('gh pr create -R acme/thing -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
  expect(seen.bash.length).toBe(0)
})

test('a Bash pull request opened out of draft with no repository named is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash('gh pr create -t "fix: x" -b body'))
  expect(out.deny).toBe('github: gh pr create refused: open it as a draft, then leave draft once ready.')
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
  for (const command of [ENGINE + ' --repo=acme/thing pr-merge 12', '/plugins/github/engine/gh.py pr-merge 12 --repo acme/thing']) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('github: gh.py pr-merge refused on acme/thing#12 at 0123456: not ready.')
  }
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge or undraft through gh.py with no --repo is refused', async ($, on) => {
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
  expect(out.deny).toBe('github: gh.py pr-create refused: open it as a draft, then leave draft once ready.')
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

test('a Bash gh.py act whose pull request number cannot be read is refused, never read against the current branch', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], pulls: { '': [{ number: 12 }] } })
  for (const command of [
    ENGINE + ' pr-merge {} --repo acme/thing',
    ENGINE + ' pr-merge "$PR" --repo acme/thing',
    ENGINE + ' pr-ready {} --repo acme/thing',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh.py ' + command.split(' ')[2] + ' refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
  }
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})

test('a Bash merge whose pull request is a shell expansion is refused, never read against the current branch', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], pulls: { '': [{ number: 12 }] } })
  for (const command of [
    'gh api repos/acme/thing/pulls/$PR/merge -X PUT',
    'gh api repos/acme/thing/pulls/${PR}/merge -X PUT',
    'gh api repos/$REPO/pulls/12/merge -X PUT',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh api refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
  }
  for (const command of [
    'gh pr merge $(gh pr list -q .[0].number) -R acme/thing',
    'gh pr merge `gh pr list -q .[0].number` -R acme/thing',
    'gh pr ready $(gh pr list -q .[0].number) -R acme/thing',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: ' + command.split(' ').slice(0, 3).join(' ') + ' refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
  }
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})

test('a Bash undraft through gh.py for CI passes in auto-merge too, still Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
  const out: any = await $.tool.call(bash(ENGINE + ' pr-ready 12 --for-ci --repo acme/thing'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
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

test('a --stdin-json request from Bash is refused in auto-merge too', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const line = 'python3 ' + ROOT + '/engine/gh.py --stdin-json < request.json'
  expect(((await $.tool.call(bash(line))) as any).deny).toBe(STDIN_REFUSAL)
  expect(seen.bash).toEqual([])
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

// A session whose own directory is another checkout (the orchestrator's, or a pinned review worktree).
const AWAY = { 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' }, 'status --porcelain -uno': { exitCode: 0, stdout: ' M x.ts\n' } }
const REVIEW_DIR = '/review/thing'
// The checkouts these tests name exist as directories.
const CHECKOUTS: NonNullable<World['tree']> = {
  // The host's own kind for a directory: `dir`.
  [REVIEW_DIR]: { kind: 'dir', mtimeMs: 1 },
  '/nowhere': { kind: 'dir', mtimeMs: 1 },
}
const REVIEW_ORIGIN = { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } }

test('a record names the checkout the tests ran in, and is written at its head there', async ($, on) => {
  const seen = await world($, on, { git: AWAY, gitIn: { [REVIEW_DIR]: { ...CLEAN, ...REVIEW_ORIGIN } }, tree: CHECKOUTS, labels: ['Ready'] })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', detail: 'ran', dir: REVIEW_DIR } as any)
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe(HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json')
  expect(recordRun(seen)!.slice(0, 6)).toEqual(['--repo', 'acme/thing', '--pr', '12', '--head', HEAD])
})

test('a checkout named away from the pull request\'s head is refused, naming both shas and the checkout', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } }, tree: CHECKOUTS })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: REVIEW_DIR } as any)
  expect(out.deny).toContain('the checkout is at fedcba9, the pull request\'s head is 0123456')
  expect(out.deny).toContain(REVIEW_DIR)
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named with changes in its tracked files is refused, whatever the session\'s directory holds', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } }, tree: CHECKOUTS })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: REVIEW_DIR } as any)
  expect(out.deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named by a relative path, or that is no git checkout, is refused', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { '/nowhere': {} }, tree: CHECKOUTS })
  const relative: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: 'review/thing' } as any)
  expect(relative.deny).toContain('dir is the absolute path of the checkout the tests ran in')
  const none: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: '/nowhere' } as any)
  expect(none.deny).toContain('/nowhere has no commit to read')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named that is no directory is refused, naming it, before any git runs there', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: '/gone/away' } as any)
  expect(out.deny).toContain('/gone/away is not a directory')
  expect(seen.runs.filter((r) => r.argv[0] === 'git')).toEqual([])
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named that is a file, or whose stat fails for another reason, is refused with its own cause', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, tree: { '/work/file.txt': { kind: 'file', mtimeMs: 1 } } })
  const file: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: '/work/file.txt' } as any)
  expect(file.deny).toContain('/work/file.txt is not a directory')
  expect(seen.runs.filter((r) => r.argv[0] === 'git')).toEqual([])
})

test('a stat that fails but for a missing path is reported as it failed', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, statFails: 'EACCES: permission denied' })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', dir: '/locked' } as any)
  expect(out.deny).toContain('cannot stat dir /locked: ')
  expect(out.deny).toContain('EACCES')
  expect(out.deny).not.toContain('is not a directory')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named with no GitHub origin, and no repository given, is refused with that cause', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'remote get-url origin': { exitCode: 0, stdout: '/srv/local/thing.git\n' } } }, tree: CHECKOUTS })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', dir: REVIEW_DIR } as any)
  expect(out.deny).toContain(REVIEW_DIR + ' has no GitHub origin remote')
  expect(out.deny).toContain('{"repo": "owner/name"}')
  expect(recordRun(seen)).toBeUndefined()
})

test('a head refusal names the repository and the pull request it compared', async ($, on) => {
  await world($, on, { git: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(out.deny).toContain('the pull request\'s head is 0123456 (acme/thing#12)')
})

test('a git status that fails is reported with its error, not as changed files', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' } } })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(out.deny).toContain('git status failed: fatal: not a git repository')
  expect(out.deny).not.toContain('have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('the permission check receives the checkout the record names', async ($, on) => {
  const seen = await world($, on, { git: AWAY, gitIn: { [REVIEW_DIR]: { ...CLEAN, ...REVIEW_ORIGIN } }, tree: CHECKOUTS, labels: ['Ready'] })
  await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', detail: 'ran', dir: REVIEW_DIR } as any)
  expect(seen.checks.map((c) => c.dir)).toContain(REVIEW_DIR)
})

test('a record is refused on a checkout whose tracked files changed', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } })
  const dirty: any = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass' } as any)
  expect(dirty.deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

const CONSENTS = '/cfg/consents/acme/thing'

function consentWorld(records: Record<string, unknown>, dir = CONSENTS): World {
  const tree: NonNullable<World['tree']> = { [dir]: { kind: 'dir', mtimeMs: 1 } }
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

for (const [plugin, kind, allowed] of [
  ['pr-review', 'review', true], ['pr-review', 'norms', false], ['norms', 'norms', true], ['norms', 'review', false],
  ['orchestrator', 'review', true], ['orchestrator', 'e2e', false],
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

// ---- the orchestrator's review verdict ----

// A failed review at the head, norms and E2E passed: the review is what the pull request misses.
const FAILED = record('review', 'fail', '2026-11-01T11:00:00Z', { producer: 'pr-review', detail: '2 Important' })
const FAILED_AT_HEAD = Object.fromEntries([FAILED, record('norms', 'pass'), record('e2e', 'pass')])
const OTHERS_PASSED = Object.fromEntries([record('norms', 'pass'), record('e2e', 'pass')])
const SET_ASIDE = 'set aside: a.ts:3 — naming only'
const VERDICT = { pr: 12, repo: 'acme/thing', kind: 'review', result: 'accepted', detail: SET_ASIDE }

// A plugin whose command calls the record tool with the verdict its argument holds, as the
// orchestrator's review tool does. Its module runs apart from the test: the call travels as text.
const reviewing = (plugin: string) => ({
  plugins: [{
    name: plugin,
    register(on: any) {
      on('command.run', { command: 'emit-verdict' }, async ($: any, e: any) => {
        const out = await $.tool.call({ tool: 'mcp__github__record', ...JSON.parse(String(e.args)) })
        return { text: JSON.stringify(out) }
      })
    },
  }],
})

const verdict = async ($: any, over: Record<string, unknown> = {}) =>
  JSON.parse(String((await $.command.run({ command: 'emit-verdict', args: JSON.stringify({ ...VERDICT, ...over }) })).text))

for (const [label, records] of [['over a failed review', FAILED_AT_HEAD], ['with no review before it', OTHERS_PASSED]] as const) {
  test('the orchestrator\'s acceptance ' + label + ' passes the review: the gate counts it and names the points set aside', reviewing('orchestrator'), async ($, on) => {
    const seen = await world($, on, { records, git: CLEAN })
    const out = await verdict($)
    const argv = recordRun(seen)!
    expect(argv.slice(6, 14)).toEqual(['--kind', 'review', '--result', 'accepted', '--producer', 'orchestrator', '--detail', SET_ASIDE])
    expect(String(out.result)).toContain('github: acme/thing#12 Ready at 0123456: review accepted by the orchestrator (' + SET_ASIDE + ')')
    expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  })
}

test('the orchestrator\'s pass is written where no review failed, and refused over a failed one', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { records: FAILED_AT_HEAD, git: CLEAN })
  const refused = await verdict($, { result: 'pass', detail: 'clean' })
  expect(refused.deny).toContain('github: the latest review at 0123456 failed: a pass does not override it.')
  expect(recordRun(seen)).toBeUndefined()
})

test('the orchestrator\'s pass with no failed review at the head is written', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { records: OTHERS_PASSED, git: CLEAN })
  expect((await verdict($, { result: 'pass', detail: 'clean' })).deny).toBeUndefined()
  expect(recordRun(seen)).toContain('pass')
})

test('the orchestrator\'s verdict is written from a clean checkout at the head only', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { records: FAILED_AT_HEAD, git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } })
  expect((await verdict($)).deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

for (const plugin of ['pr-review', 'norms']) {
  test('an acceptance from the ' + plugin + ' plugin is refused', reviewing(plugin), async ($, on) => {
    const seen = await world($, on, { records: FAILED_AT_HEAD, git: CLEAN })
    expect(JSON.stringify(await verdict($))).toMatch(/accepted review is the orchestrator's decision|review records are written by their producer/)
    expect(recordRun(seen)).toBeUndefined()
  })
}

test('an acceptance from the model itself is refused', async ($, on) => {
  const seen = await world($, on, { records: FAILED_AT_HEAD, git: CLEAN })
  const out: any = await $.tool.call({ tool: 'mcp__github__record', ...VERDICT } as any)
  expect(out.deny).toContain('review records are written by their producer')
  expect(recordRun(seen)).toBeUndefined()
})

test('an acceptance that names no point set aside is refused', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { records: FAILED_AT_HEAD, git: CLEAN })
  expect((await verdict($, { detail: '  ' })).deny).toContain('an acceptance names each point it sets aside with its reason')
  expect(recordRun(seen)).toBeUndefined()
})

// ---- pruning ----

const DAY = 24 * 3600 * 1000

test('at session start the head directories untouched for 90 days are pruned, once a day', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/o']: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'dir', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + MOVED + '/e2e.x.json']: { kind: 'file', mtimeMs: now - 100 * DAY },
    [RECORDS + '/o/r/' + HEAD]: { kind: 'dir', mtimeMs: now - 200 * DAY },
    [RECORDS + '/o/r/' + HEAD + '/review.x.json']: { kind: 'file', mtimeMs: now - 10 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs.map((r) => r.argv)).toEqual([['rm', '-rf', '--', RECORDS + '/o/r/' + MOVED]])
  expect(seen.writes.map((w) => w.path)).toEqual([RECORDS + '/.pruned'])
})

test('a stamp from today prunes nothing', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/.pruned']: { kind: 'file', mtimeMs: now - 3600 * 1000 },
    [RECORDS + '/o']: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/o/r']: { kind: 'dir', mtimeMs: now },
    [RECORDS + '/o/r/' + MOVED]: { kind: 'dir', mtimeMs: now - 200 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs).toEqual([])
  expect(seen.writes).toEqual([])
})

// ---- auto-merge on the operator's word ----

// What the operator's recorded answer is for a consent that grants: « Accorder » alone; the words a call quotes it with name what it grants.
const HIS_WORDS = CONSENT_GRANT + ' : on est en auto-merge, pour cette orchestration infra compris'
const typed = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })
const setAutoMerge = (on: boolean, words: string, repo = 'acme/thing') =>
  gh('auto-merge-set', { repo, on, words }, undefined as any)
const listed = (seen: Seen) => JSON.parse(seen.files[AUTO_MERGE]).repositories

const mergeConsent = (text = CONSENT_GRANT, subject: unknown = { kind: 'auto-merge', repo: 'acme/thing' }) =>
  consentWorld({ a: consent({ subject, question: 'Put thing in auto-merge?', answer: text, by: 'coordinator' }) })

// A world holding the operator's answer `text` to a round question asking auto-merge on acme/thing.
function mergeWorld(text = CONSENT_GRANT, over: World = {}): World {
  const answered = mergeConsent(text)
  return { ...answered, ...over, tree: { ...answered.tree, ...over.tree } }
}

test('auto-merge-set on, quoting the operator\'s recorded answer, lists the repository, and its pr-ready asks nothing', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { verdict: { decision: 'ask' } }))
  const set: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
  const ready: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(ready.deny).toBeUndefined()
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toContain('pr-ready')
})

test('words the operator typed are no consent: with no consent record auto-merge-set is refused and writes nothing', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_WORDS)
  await typed($, 'oui, vas-y')
  for (const words of [HIS_WORDS, 'oui, vas-y']) {
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny, words).toContain('github: auto-merge-set')
  }
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('consent record (orchestrator) of auto-merge on acme/thing')
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})

// A recorded answer is a grant only as « Accorder »: a refusal quoted with on:true, in the choice's words or in prose, puts nothing in auto-merge.
for (const answer of ['B : ne pas passer thing en auto-merge', 'ne pas passer thing en auto-merge', 'oui, thing passe en auto-merge', 'oui']) {
  test('a recorded answer that is no « ' + CONSENT_GRANT + ' » never carries auto-merge: ' + answer, async ($, on) => {
    const seen = await world($, on, mergeWorld(answer))
    const words = answer + ' : thing en auto-merge'
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toContain('github: auto-merge-set refused on acme/thing')
    expect(out.deny).toContain('« ' + CONSENT_GRANT + ' »')
    expect(seen.files).toEqual({})
    expect(seen.writes).toEqual([])
  })
}

for (const spelling of ['auto-merge', 'auto merge', 'automerge', 'AUTO-MERGE']) {
  test('the word « ' + spelling + ' » names auto-merge in the recorded answer, the repository unnamed', async ($, on) => {
    const words = CONSENT_GRANT + ' : le projet est en ' + spelling
    const seen = await world($, on, mergeWorld())
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toBeUndefined()
    expect(listed(seen)).toEqual(['acme/thing'])
  })
}

test('the words hold the recorded answer with their whitespace normalised', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  const out: any = await $.tool.call(setAutoMerge(true, CONSENT_GRANT + '  :\non est en  auto-merge'))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

test('a consent answer without the auto-merge word is refused', async ($, on) => {
  const seen = await world($, on, mergeConsent())
  const out: any = await $.tool.call(setAutoMerge(true, CONSENT_GRANT + ' : thing passe en automatique'))
  expect(out.deny).toContain('auto-merge')
  expect(seen.files).toEqual({})
})

test('a consent record of an E2E waiver does not carry auto-merge', async ($, on) => {
  const seen = await world($, on, mergeConsent(undefined, { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }))
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toContain('consent record (orchestrator) of auto-merge on acme/thing')
  expect(seen.files).toEqual({})
})

test('auto-merge-set off takes the repository out, whatever its case, and its pr-ready is refused again', async ($, on) => {
  const words = CONSENT_GRANT + ' : thing sort de l\'auto-merge'
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['Acme/Thing', 'acme/other'] }))
  const out: any = await $.tool.call(setAutoMerge(false, words))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/other'])
  const ready: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(seen.asked.length).toBe(0)
  expect(ready.deny).toContain('outside auto-merge, leaving draft is the operator\'s')
})

test('the list is written whole to a temporary file then moved in place, leaving no temporary file', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'] }))
  await $.tool.call(setAutoMerge(true, HIS_WORDS))
  const written = seen.writes.filter((x) => x.path.startsWith('/data/'))
  expect(written.length).toBe(1)
  expect(written[0].path).not.toBe(AUTO_MERGE)
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv' && r.argv.includes(written[0].path) && r.argv.at(-1) === AUTO_MERGE)).toBe(true)
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(JSON.parse(seen.files[AUTO_MERGE])).toEqual({ repositories: ['acme/other', 'acme/thing'] })
})

test('a move that fails removes the temporary file and leaves the list as it was', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], mvFails: 'EACCES' }))
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('EACCES')
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other'])
})

const LOCK = AUTO_MERGE + '.lock'
const lockRuns = (seen: Seen) => seen.runs.filter((r) => r.argv?.includes(LOCK)).map((r) => r.argv[0])

test('auto-merge-set reads and writes the list holding its lock, and releases it', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'] }))
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm'])
  expect(seen.runs.findIndex((r) => r.argv?.[0] === 'sh')).toBeLessThan(seen.runs.findIndex((r) => r.argv?.[0] === 'mv'))
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock left by a holder that died is taken over', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: 0 } } }))
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm', 'sh', 'rm'])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock another session holds refuses the change, and stays its own', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: Date.now() } } }))
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('stays locked by another session')
  expect(lockRuns(seen)).not.toContain('rm')
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv')).toBe(false)
  expect(listed(seen)).toEqual(['acme/other'])
})

test('a malformed list is never overwritten', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  seen.files[AUTO_MERGE] = '{"repositories": [1]}'
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_MERGE]).toBe('{"repositories": [1]}')
})

test('auto-merge-set refuses a repository that is not owner/name', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  const out: any = await $.tool.call(setAutoMerge(true, HIS_WORDS, 'thing'))
  expect(out.deny).toContain('owner/name')
  expect(seen.files).toEqual({})
})

test('auto-merge-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { verdict: { decision: 'deny', reason: 'no' } }))
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

// ---- the operator's recorded answer, quoted inside a wrapping ----

// The moment the module reads on its clock: noon in UTC, a day everywhere the tests run.
const RECEIVED = Date.UTC(2026, 10, 2, 12, 0, 0)
test('auto-merge-set accepts a quote that holds the operator\'s recorded answer whole', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  const wrapped: any = await $.tool.call(setAutoMerge(true, '« ' + HIS_WORDS + ' » — operator'))
  expect(wrapped.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})

test('auto-merge-set refuses spans that hold the recorded answer only in parts', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  for (const words of [
    'they said « Accor » « der » so auto-merge is on',
    'auto-merge: « Accorde »',
    '« Acc » and « order » auto-merge',
  ]) {
    const out: any = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny).toContain('github: auto-merge-set')
  }
  expect(seen.files).toEqual({})
})

// ---- leaving draft is the operator's outside auto-merge ----

const LEAVE_DRAFT = 'outside auto-merge, leaving draft is the operator\'s, on GitHub after their review'

test('a pr-ready outside auto-merge is refused with no question, a ready one too', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toBe('github: pr-ready refused on acme/thing: ' + LEAVE_DRAFT + ', and Ready is put by the gate once'
    + ' the pull request is ready (pr-readiness {"pr": 12, "state": "ready"} reads them now).')
  expect(seen.asked).toEqual([])
  expect(commands(seen)).not.toContain('pr-ready')
})

test('a pr-create out of draft outside auto-merge is refused with no question', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  const out: any = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
  expect(String(out.deny)).toStartWith('github: pr-create refused')
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual([])
})

test('gh pr ready, the engine and GraphQL leaving draft outside auto-merge are refused with the same line', async ($, on) => {
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

test('in auto-merge a ready pr-ready still runs, with no question', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'], verdict: { decision: 'ask' } })
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
    + ' a clean review, passed E2E and green CI hold at its head.')
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

const READY_LINE = 'github: acme/thing#12 Ready at 0123456: a clean review, passed E2E and green CI hold at its head.'

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
  const seen = await world($, on, { readStderr: ACTIONS_LINE + '\n', autoMerge: ['acme/thing'], labels: ['Ready'] })
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

test('a Ready label put by hand on a pull request not ready runs, on every route: the gate alone decides readiness', async ($, on) => {
  const seen = await world($, on, { ci: { result: 'FAILURE', failed: ['test'] }, gateFails: 'error: never read' })
  for (const call of [
    gh('label-add', { pr: 12, label: ['Ready'] }),
    gh('pr-readiness', { pr: 12, state: 'ready' }),
    bash('gh pr edit 12 --add-label Ready'),
    bash('gh issue edit 12 -R acme/thing --add-label ready'),
    bash('gh api --method POST repos/acme/thing/issues/12/labels -f \'labels[]=Ready\''),
    bash('gh api -X PATCH repos/acme/thing/pulls/12 -f labels=\'["Ready"]\''),
    bash('python3 ' + ROOT + '/engine/gh.py label-add 12 Ready --repo acme/thing'),
  ]) {
    const out: any = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
  }
  expect(seen.bash.length).toBe(5)
  // No pr-gate: the label reads no readiness.
  expect(commands(seen).filter((c) => !c.startsWith('git '))).toEqual(['label-add', 'pr-readiness'])
})

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
    expect(out.deny).toBe('github: pr-create refused: open it as a draft, then leave draft once ready.')
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

test('a GraphQL query the command does not show is refused in auto-merge as an unverified readiness', async ($, on) => {
  const seen = await world($, on, { git: ORIGIN, autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash(OPAQUE))
  expect(out.deny).toBe('github: readiness of acme/thing#? unverified: the GraphQL query cannot be read from the command')
  expect(seen.bash).toEqual([])
})

test('a GraphQL query the command does not show is refused when the guard fails to read the origin', async ($, on) => {
  const seen = await world($, on, { gitThrows: 'spawn failed', autoMerge: ['acme/thing'] })
  const out: any = await $.tool.call(bash(OPAQUE))
  expect(String(out.deny)).toStartWith('github: gh api graphql refused: its query cannot be read from the command')
  expect(seen.bash).toEqual([])
})

for (const [route, call] of UNDRAFT_ACTS) {
  test('a ' + route + ' undraft of a Not Ready pull request one of whose checks passed is no CI undraft, refused outside auto-merge', async ($, on) => {
    const seen = await world($, on, { ci: { result: 'FAILURE', failed: ['test'], total: 2 } })
    const out: any = await $.tool.call(call)
    // Bash refuses on the auto-merge list first, the tool on the Ready label CI keeps from it.
    expect(String(out.deny)).toContain(route === 'Bash' ? LEAVE_DRAFT : 'not ready. Missing: CI failed: test')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
  })
}

test('outside auto-merge the gate puts a pull request out of draft for its CI back to draft, then Ready', async ($, on) => {
  const seen = await world($, on, { draft: false, ciUndrafts: [{ repo: 'acme/thing', pr: 12, head: HEAD }] })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-draft', 'pr-readiness'])
  expect(seen.logs).toEqual(['github: acme/thing#12 back to draft, then Ready at 0123456: a clean review,'
    + ' passed E2E and green CI hold at its head.'])
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

// A merge in auto-merge: refused with what the pull request misses at its head.
async function mergeProbe($: any): Promise<any> {
  return $.tool.call(gh('pr-merge', { pr: 12 }))
}

test('records that cannot be listed are an unverified readiness to the guard', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing'], listFails: 'EACCES: permission denied' })
  const out: any = await mergeProbe($)
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

// ---- E2E a pull request does not need ----

const TWO = Object.fromEntries([record('review', 'pass'), record('norms', 'pass')])
const EXEMPT = {
  v: 1, repo: 'acme/thing', exempt: true, paths: [], labels: [], detail: 'no E2E on thing, 2026-11-13', session: 's', at: '2026-11-13T10:00:00Z',
}
const EXEMPT_LINE = 'github: acme/thing#12 Ready at 0123456: a clean review, no E2E needed'
  + ' (E2E exemption of acme/thing, 2026-11-13: no E2E on thing, 2026-11-13) and green CI hold at its head.'

test('a pull request of a repository the operator exempted is Ready with no E2E record, its line naming the exemption', async ($, on) => {
  const seen = await world($, on, { records: TWO, exemption: EXEMPT })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs).toEqual([EXEMPT_LINE])
})

for (const [label, exemption] of [
  ['no exemption', undefined], ['a revoked exemption', { ...EXEMPT, exempt: false }], ['an exemption file that does not parse', '{'],
  ['an exemption of another shape', { ...EXEMPT, v: 2 }],
] as const) {
  test('with ' + label + ' a pull request with no E2E record stays Not Ready, as before', async ($, on) => {
    const seen = await world($, on, { records: TWO, exemption, autoMerge: ['acme/thing'] })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(readinessRuns(seen)).toEqual([])
    const merge: any = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(merge.deny).toContain('Missing: e2e: no record at 0123456')
  })
}

test('an exemption by label or by paths does not cover a pull request without the label and with a file outside the paths', async ($, on) => {
  const ruled = { ...EXEMPT, labels: ['no-e2e'], paths: ['docs/'] }
  const seen = await world($, on, { records: TWO, exemption: ruled, files: [{ filename: 'docs/a.md' }, { filename: 'src/a.ts' }] })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('an exemption by paths covers a pull request whose files all match, and none whose files cannot be read', async ($, on) => {
  const ruled = { ...EXEMPT, paths: ['docs/'] }
  const seen = await world($, on, { records: TWO, exemption: ruled, files: [{ filename: 'docs/a.md' }, { filename: 'docs/b.svg' }] })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('an exemption by paths covers nothing when the files cannot be read', async ($, on) => {
  const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, paths: ['docs/'] }, filesFails: 'error: rate limited' })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('an exemption by label covers a pull request carrying it', async ($, on) => {
  const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, labels: ['no-e2e'] }, labels: ['Not Ready', 'No-E2E'] })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a failed E2E record holds a pull request of an exempted repository', async ($, on) => {
  const seen = await world($, on, { records: { ...TWO, ...Object.fromEntries([record('e2e', 'fail')]) }, exemption: EXEMPT })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

const exemptCall = (exempt: boolean, detail: string, over: Record<string, unknown> = {}) =>
  ({ tool: 'mcp__github__record', repo: 'acme/thing', exempt, detail, ...over }) as any
const exemptionOf = (seen: Seen) => JSON.parse(seen.files[EXEMPTION])
const HIS_EXEMPTION = 'plus de dérogation E2E sur thing pour docs/ et no-e2e, 2026-11-13'
const answeredExemption = (answer: string) => consent({ subject: { kind: 'e2e-exemption', repo: 'acme/thing' }, answer })
// The operator's answers to round questions asking an exemption of acme/thing, one record each.
const exemptionWorld = (...answers: string[]) => consentWorld(Object.fromEntries(answers.map((answer, i) => ['a' + i, answeredExemption(answer)])))

test('words the operator typed are no consent: with no consent record they exempt nothing', async ($, on) => {
  const seen = await world($, on)
  await typed($, HIS_EXEMPTION)
  const out: any = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: ['docs/'], labels: ['no-e2e'] }))
  expect(out.deny).toContain('an E2E exemption quotes the operator')
  expect(seen.files[EXEMPTION]).toBeUndefined()
})

test('the operator\'s recorded answer exempts a repository through the record tool, with its rules, and revokes it', async ($, on) => {
  const seen = await world($, on, exemptionWorld(HIS_EXEMPTION))
  const set: any = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: ['docs/'], labels: ['no-e2e'] }))
  expect(set.deny).toBeUndefined()
  expect(set.result).toBe('github: acme/thing exempt from E2E for its pull requests carrying no-e2e or whose files all match docs/')
  expect(exemptionOf(seen)).toMatchObject({ v: 1, repo: 'acme/thing', exempt: true, paths: ['docs/'], labels: ['no-e2e'], detail: HIS_EXEMPTION })
  const revoke: any = await $.tool.call(exemptCall(false, HIS_EXEMPTION))
  expect(revoke.result).toBe('github: acme/thing no longer exempt from E2E')
  expect(exemptionOf(seen)).toMatchObject({ exempt: false, paths: [], labels: [] })
  expect(recordRun(seen)).toBeUndefined()
})

test('an exemption with no rule covers every pull request of the repository', async ($, on) => {
  const seen = await world($, on, exemptionWorld(HIS_EXEMPTION))
  const set: any = await $.tool.call(exemptCall(true, HIS_EXEMPTION))
  expect(set.result).toBe('github: acme/thing exempt from E2E for all its pull requests')
  expect(exemptionOf(seen).exempt).toBe(true)
})

test('an exemption may quote the operator\'s answer in a consent record of the repository\'s exemption, not of a waiver', async ($, on) => {
  const words = 'exempt thing from E2E, 2026-11-13'
  const seen = await world($, on, exemptionWorld(words))
  const out: any = await $.tool.call(exemptCall(true, 'operator ruled: ' + words))
  expect(out.deny).toBeUndefined()
  expect(exemptionOf(seen).exempt).toBe(true)
})

test('a consent record of a waiver of one pull request does not exempt the repository', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent() }))
  const out: any = await $.tool.call(exemptCall(true, CONSENT_WORDS))
  expect(out.deny).toContain('an E2E exemption quotes the operator')
  expect(seen.files[EXEMPTION]).toBeUndefined()
})

test('the operator\'s answer exempts a repository with no date in it', async ($, on) => {
  const seen = await world($, on, exemptionWorld('plus de dérogation E2E sur thing'))
  const undated: any = await $.tool.call(exemptCall(true, 'plus de dérogation E2E sur thing'))
  expect(undated.deny).toBeUndefined()
  expect(exemptionOf(seen).exempt).toBe(true)
})

test('an exemption is refused without a repository, with rules that are not lists of names, or from a review plugin', async ($, on) => {
  const seen = await world($, on, exemptionWorld(HIS_EXEMPTION))
  const unnamed: any = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { repo: 'thing' }))
  expect(unnamed.deny).toContain('{"repo": "owner/name"}')
  const ruled: any = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: 'docs/' }))
  expect(ruled.deny).toContain('"paths" and "labels" are lists')
  expect(seen.files[EXEMPTION]).toBeUndefined()
})

test('the repository named outside the operator\'s quoted answer does not count', async ($, on) => {
  const seen = await world($, on, exemptionWorld('plus de dérogation E2E pour docs/', 'plus de dérogation E2E sur thing pour docs/'))
  const outside: any = await $.tool.call(exemptCall(true, '« plus de dérogation E2E pour docs/ » — operator about acme/thing', { paths: ['docs/'] }))
  expect(outside.deny).toContain('an E2E exemption quotes the operator')
  expect(seen.files[EXEMPTION]).toBeUndefined()
  const inside: any = await $.tool.call(exemptCall(true, '« plus de dérogation E2E sur thing pour docs/ » — operator', { paths: ['docs/'] }))
  expect(inside.deny).toBeUndefined()
})

test('each rule of an exemption is in the operator\'s answer as given', async ($, on) => {
  const words = 'plus de dérogation E2E sur thing, 2026-11-13'
  const given = 'plus de dérogation E2E sur thing pour docs/ et no-e2e, 2026-11-13'
  const seen = await world($, on, exemptionWorld(words, given))
  for (const rule of [{ paths: ['docs/'] }, { labels: ['no-e2e'] }]) {
    const out: any = await $.tool.call(exemptCall(true, words, rule))
    expect(out.deny, JSON.stringify(rule)).toContain('each rule as given')
  }
  expect(seen.files[EXEMPTION]).toBeUndefined()
  const quoted: any = await $.tool.call(exemptCall(true, given, { paths: ['docs/'], labels: ['no-e2e'] }))
  expect(quoted.deny).toBeUndefined()
  expect(exemptionOf(seen)).toMatchObject({ exempt: true, paths: ['docs/'], labels: ['no-e2e'] })
})

test('a rule found only inside a longer word of the operator\'s answer is not given', async ($, on) => {
  const cases = [
    ['plus de dérogation E2E sur thing pour src/docs/, 2026-11-13', { paths: ['docs/'] }],
    ['plus de dérogation E2E sur thing pour docs/api, 2026-11-13', { paths: ['docs/'] }],
    ['plus de dérogation E2E sur thing avec no-e2e, 2026-11-13', { labels: ['e2e'] }],
    ['plus de dérogation E2E sur thing avec e2e-skip, 2026-11-13', { labels: ['e2e'] }],
  ] as const
  const whole = 'plus de dérogation E2E sur thing pour docs/, avec e2e. 2026-11-13'
  const seen = await world($, on, exemptionWorld(...cases.map(([words]) => words), whole))
  for (const [words, rule] of cases) {
    const out: any = await $.tool.call(exemptCall(true, words, rule))
    expect(out.deny, words).toContain('each rule as given')
  }
  expect(seen.files[EXEMPTION]).toBeUndefined()
  const given: any = await $.tool.call(exemptCall(true, whole, { paths: ['docs/'], labels: ['e2e'] }))
  expect(given.deny).toBeUndefined()
})

for (const [answer, rule] of [
  ['lance les tests du dépôt, 2026-11-13', {}],
  ['lance les tests de thing, 2026-11-13', {}],
  ['plus de dérogation E2E sur ce dépôt, 2026-11-13', {}],
  ['exempt thing from E2E, 2026-11-13', { paths: ['docs/'] }],
  ['exempt thing from E2E for no-e2e, 2026-11-13', { labels: ['e2e'] }],
] as const) {
  test('a consent answer that grants no exemption, names no repository or misses a rule exempts nothing: ' + answer + ' ' + JSON.stringify(rule), async ($, on) => {
    const seen = await world($, on, exemptionWorld(answer))
    const out: any = await $.tool.call(exemptCall(true, 'operator ruled: ' + answer + ' — on acme/thing, exempt, docs/ e2e', rule))
    expect(out.deny).toContain('an E2E exemption quotes the operator')
    expect(seen.files[EXEMPTION]).toBeUndefined()
  })
}

test('a consent answer that does not name the repository revokes nothing', async ($, on) => {
  const seen = await world($, on, { exemption: EXEMPT, ...exemptionWorld('remets les E2E, 2026-11-13') })
  const out: any = await $.tool.call(exemptCall(false, 'operator ruled: remets les E2E, 2026-11-13 — acme/thing'))
  expect(out.deny).toContain('an E2E exemption quotes the operator')
  expect(exemptionOf(seen).exempt).toBe(true)
})

test('a consent answer with the exemption, the repository and each rule exempts', async ($, on) => {
  const seen = await world($, on, exemptionWorld('exempt thing from E2E for docs/, 2026-11-13'))
  const out: any = await $.tool.call(exemptCall(true, 'operator ruled: exempt thing from E2E for docs/, 2026-11-13', { paths: ['docs/'] }))
  expect(out.deny).toBeUndefined()
  expect(exemptionOf(seen)).toMatchObject({ exempt: true, paths: ['docs/'] })
})

test('a revocation names the repository in the operator\'s answer', async ($, on) => {
  const seen = await world($, on, { exemption: EXEMPT, ...exemptionWorld('plus de dérogation E2E sur ce dépôt, 2026-11-13', 'remets les E2E sur thing, 2026-11-13') })
  const unnamed: any = await $.tool.call(exemptCall(false, 'plus de dérogation E2E sur ce dépôt, 2026-11-13'))
  expect(unnamed.deny).toContain('an E2E exemption quotes the operator')
  expect(exemptionOf(seen).exempt).toBe(true)
  const named: any = await $.tool.call(exemptCall(false, 'remets les E2E sur thing, 2026-11-13'))
  expect(named.result).toBe('github: acme/thing no longer exempt from E2E')
})

test('an exemption of a repository named with a dot segment is refused before any file is written', async ($, on) => {
  const seen = await world($, on)
  for (const repo of ['../auto-merge', 'o/..', './thing', '.../x']) {
    const out: any = await $.tool.call(exemptCall(true, 'plus de dérogation E2E sur ' + repo + ', 2026-11-13', { repo }))
    expect(out.deny, repo).toContain('{"repo": "owner/name"}')
  }
  expect(seen.files).toEqual({})
})

const LABELLED = { ...EXEMPT, labels: ['no-e2e'] }

test('a label an exemption names is refused to the tool, on or off, another label passes', async ($, on) => {
  const seen = await world($, on, { exemption: LABELLED })
  const added: any = await $.tool.call(gh('label-add', { pr: 12, label: ['bug', 'No-E2E'] }))
  expect(added.deny).toBe('github: label-add refused: No-E2E exempts pull requests of acme/thing from E2E; only the operator puts it on or takes it off.')
  const removed: any = await $.tool.call(gh('label-remove', { pr: 12, name: 'no-e2e' }))
  expect(removed.deny).toBe('github: label-remove refused: no-e2e exempts pull requests of acme/thing from E2E; only the operator puts it on or takes it off.')
  const other: any = await $.tool.call(gh('label-add', { pr: 12, label: ['bug'] }))
  expect(other.deny).toBeUndefined()
  expect(seen.runs.filter((r) => r.command).map((r) => r.command)).toEqual(['label-add'])
})

test('a label an exemption names is refused to Bash, on any route, another label passes', async ($, on) => {
  const seen = await world($, on, { exemption: LABELLED, git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } } })
  for (const command of [
    'gh pr edit 12 -R acme/thing --add-label no-e2e',
    'gh pr edit 12 --remove-label bug,no-e2e',
    'gh issue edit 12 -R acme/thing --add-label NO-E2E',
    'gh pr create -R acme/thing --draft --label no-e2e',
    ENGINE + ' --repo acme/thing label-add 12 no-e2e',
    ENGINE + ' label-remove 12 no-e2e',
    'gh api -X POST repos/acme/thing/issues/12/labels -f \'labels[]=no-e2e\'',
    'gh api -X DELETE repos/acme/thing/issues/12/labels/no-e2e',
    'gh api -X DELETE repos/acme/thing/issues/12/labels',
    'gh api -X POST repos/acme/thing/issues/12/labels --input body.json',
    'gh api -X POST repos/acme/thing/issues/12/labels -F \'labels[]=@labels.txt\'',
    'gh api repos/acme/thing/issues/12/labels -F labels[]=@labels.txt',
    'gh api -X PATCH repos/acme/thing/issues/12 -F \'labels[]=@labels.txt\'',
    'gh api -X PATCH repos/acme/thing/pulls/12 -f \'labels[]=no-e2e\'',
    'gh label edit bug -R acme/thing --name no-e2e',
    'gh api graphql -f query=\'mutation { addLabelsToLabelable(input: {labelableId: "x", labelIds: ["y"]}) { clientMutationId } }\'',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('exempts pull requests of acme/thing from E2E; only the operator puts it on or takes it off.')
  }
  expect(seen.bash).toEqual([])
  const other: any = await $.tool.call(bash('gh pr edit 12 -R acme/thing --add-label bug'))
  expect(other.deny).toBeUndefined()
})

test('a gh api field joined to its flag is read as a spaced one: a label an exemption names is refused', async ($, on) => {
  const seen = await world($, on, { exemption: LABELLED })
  for (const command of [
    'gh api -X POST repos/acme/thing/issues/12/labels -f labels[]=no-e2e',
    'gh api -X POST repos/acme/thing/issues/12/labels -flabels[]=no-e2e',
    'gh api -X POST repos/acme/thing/issues/12/labels -Flabels[]=no-e2e',
    'gh api -X POST repos/acme/thing/issues/12/labels -Flabels[]=@labels.txt',
    'gh api -XPATCH repos/acme/thing/issues/12 -Flabels[]=@labels.txt',
    'gh api repos/acme/thing/issues/12/labels --raw-field=labels[]=no-e2e',
    'gh api repos/acme/thing/issues/12/labels --field=labels[]=no-e2e',
    'gh api repos/acme/thing/issues/12/labels --field=labels[]=@labels.txt',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('exempts pull requests of acme/thing from E2E; only the operator puts it on or takes it off.')
  }
  expect(seen.bash).toEqual([])
})

test('a gh api path whose repository is a placeholder is read as the checkout\'s repository', async ($, on) => {
  const seen = await world($, on, { exemption: LABELLED, git: { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } } })
  for (const command of [
    'gh api -X POST \'repos/{owner}/{repo}/issues/12/labels\' -f labels[]=no-e2e',
    'gh api -X POST repos/:owner/:repo/issues/12/labels -f labels[]=no-e2e',
    'gh api -X POST "repos/{owner}/thing/issues/12/labels" -f labels[]=no-e2e',
    'gh api -X DELETE \'repos/{owner}/{repo}/issues/12/labels/no-e2e\'',
  ]) {
    const out: any = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('exempts pull requests of acme/thing from E2E; only the operator puts it on or takes it off.')
  }
  expect(seen.bash).toEqual([])
})

test('the exemption files are refused to Write, Edit and Bash', async ($, on) => {
  const seen = await world($, on)
  for (const call of [
    { tool: 'Write', file_path: EXEMPTION, content: '{}' },
    { tool: 'Edit', file_path: '/home/x/.claude/plugins/data/github-lounisbou/e2e-exempt/o/r.json', old_string: 'a', new_string: 'b' },
    bash('echo {} > /data/e2e-exempt/acme/thing.json'),
    bash('rm -r "$CLAUDE_PLUGIN_DATA/e2e-exempt"'),
  ]) {
    const out: any = await $.tool.call(call as any)
    expect(out.deny, JSON.stringify(call)).toContain('github: an E2E exemption changes only through mcp__github__record')
  }
  const mention: any = await $.tool.call(bash('git commit -m "docs: explain e2e-exempt/ files"'))
  expect(mention.deny).toBeUndefined()
  expect(seen.bash).toEqual(['git commit -m "docs: explain e2e-exempt/ files"'])
})

const noneCall = (detail?: string) =>
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'not-applicable', ...(detail === undefined ? {} : { detail }) }) as any
const DOCS_ONLY = [{ filename: 'README.md' }, { filename: 'plugins/github/tests/run-tests.sh' }, { filename: '.github/workflows/ci.yml' }]

test('E2E not applicable on a pull request whose files hold no runtime is recorded without the operator', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, records: TWO, files: DOCS_ONLY })
  const out: any = await $.tool.call(noneCall('documentation and tests only'))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('not-applicable')
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('E2E not applicable on a pull request that changes code is refused, naming the files', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: [...DOCS_ONLY, { filename: 'hooks/register.ts' }, { filename: 'package.json' }] })
  const out: any = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toBe('github: E2E is not applicable only to a pull request whose files hold no runtime;'
    + ' acme/thing#12 changes hooks/register.ts, package.json.')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused without its reason', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: DOCS_ONLY })
  for (const detail of [undefined, '  ']) {
    const bare: any = await $.tool.call(noneCall(detail))
    expect(bare.deny).toContain('its reason in "detail"')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the files of the pull request cannot be read', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, filesFails: 'error: rate limited' })
  const out: any = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the files of acme/thing#12 cannot be read: error: rate limited')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the pull request lists no files yet', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: [] })
  const out: any = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the files of acme/thing#12 cannot be read: pr-files answered no files')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the head moves while the files are read', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: DOCS_ONLY, heads: [HEAD, MOVED] })
  const out: any = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the head moved from 0123456 to fedcba9')
  expect(recordRun(seen)).toBeUndefined()
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
    [RECORDS + '/acme/thing']: { kind: 'dir', mtimeMs: 0 },
    [dir]: { kind: 'dir', mtimeMs: ++earlierMtime },
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

test('a directory named like a record file, in an earlier head, is no unreadable record: the rebase still carries', async ($, on) => {
  const tree = { ...earlier(CLEAN_OLD), [OLD_DIR + '/nested.json']: { kind: 'dir' as const, mtimeMs: 0 } }
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
})

test('a rebase that leaves the diff unchanged carries the orchestrator\'s acceptance of the review', async ($, on) => {
  const accepted = at('review', 'accepted', { producer: 'orchestrator', detail: 'set aside: a.ts:3 — naming only' }, '2026-11-01T11:00:00Z')
  const tree = earlier([at('review', 'fail'), accepted, at('norms', 'pass'), at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' })])
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
})

test('a rebase that changed the diff carries nothing but the operator\'s E2E waiver', async ($, on) => {
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: OTHER } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456;'
    + ' e2e carried from abcdef0'])
})

test('an E2E pass at the earlier head is carried with the review and norms', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('norms', 'pass'), at('e2e', 'pass')])
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(out.result).labels).toEqual(['Ready'])
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
  await world($, on, { autoMerge: ['acme/thing'], records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME, [LATER]: SAME } })
  const out: any = await mergeProbe($)
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

test('a head whose commits cannot be fingerprinted (a merge in the pull request) carries nothing but the E2E waiver, and says so in one line', async ($, on) => {
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual([
    'github: acme/thing#12: no review, norms record carried to 0123456: 0123456\'s commits cannot be fingerprinted: error: commit 1234567 is a merge',
    'github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456;'
      + ' e2e carried from abcdef0',
  ])
})

test('the records of another pull request with the same diff are never carried, nothing is fingerprinted', async ($, on) => {
  const tree = earlier(CLEAN_OLD.map(([name]) => at(name.split('.')[0], name.startsWith('e2e') ? 'waived' : 'pass', { pr: 13, detail: 'no E2E, 2026-11-01' })))
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toContain('Missing: review: no record at 0123456, e2e: no record at 0123456')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('a refused merge names the records carried beside what is missing', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('norms', 'pass')])
  await world($, on, { autoMerge: ['acme/thing'], records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await mergeProbe($)
  expect(out.deny).toContain('Missing: e2e: no record at 0123456; review carried from abcdef0, norms carried from abcdef0.')
})

test('an earlier head whose commits cannot be fingerprinted carries nothing, and says so in one line', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME },
    fingerprintFails: 'error: abcdef0 has fewer than 2 commits along its first parents',
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review, norms record carried to 0123456: abcdef0\'s commits cannot be fingerprinted:'
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

test('an earlier head of more commits whose top ones are the head\'s carries nothing but the E2E waiver, and is not fingerprinted', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], commits: 2, tree: earlier(CLEAN_OLD, OLD_DIR, 3), fingerprints: { [HEAD]: SAME, [OLD]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456;'
    + ' e2e carried from abcdef0'])
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
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review, norms record carried to 0123456: abcdef0\'s commits cannot be fingerprinted:'
    + ' the pull request was never read at that head, its commit count is not known')
  expect(fingerprintRuns(seen)).toEqual([HEAD])
})

test('a review failed at a later head that cannot be fingerprinted is not carried from an earlier head where it passed', async ($, on) => {
  const LATER = '1111111111111111111111111111111111111111'
  const tree = {
    ...earlier(CLEAN_OLD),
    ...earlier([at('review', 'fail', { head: LATER }, '2026-11-01T11:00:00Z')], RECORDS + '/acme/thing/' + LATER),
  }
  const seen = await world($, on, { autoMerge: ['acme/thing'], records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await mergeProbe($)
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
  expect(seen.logs[1]).toContain('Missing: review: no record at 0123456, e2e: no record at 0123456')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('a review record that does not parse at the head is not carried over from an earlier head, and is named', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], records: { 'review.20261102T100000Z.p-review.json': '{"v": 1, "kind": "rev' }, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await mergeProbe($)
  expect(out.deny).toContain('Missing: review: no record at 0123456, unreadable record review.20261102T100000Z.p-review.json;'
    + ' norms carried from abcdef0, e2e carried from abcdef0.')
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('a record that does not parse at the head and whose name gives no kind lets no kind be carried', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], records: { 'stray.json': 'not json' }, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out: any = await mergeProbe($)
  expect(out.deny).toContain('Missing: review: no record at 0123456, e2e: no record at 0123456, unreadable record stray.json.')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('a review record that does not parse at a later head of the same diff is not carried over from an earlier head, read after read', async ($, on) => {
  const LATER = '1111111111111111111111111111111111111111'
  const tree = {
    ...earlier(CLEAN_OLD),
    ...earlier([['review.20261101T110000Z.p-review.json', '']], RECORDS + '/acme/thing/' + LATER),
  }
  const seen = await world($, on, { autoMerge: ['acme/thing'], records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME, [LATER]: SAME } })
  for (const read of [1, 2]) {
    const out: any = await mergeProbe($)
    expect(out.deny).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
    expect(seen.logs[read - 1]).toBe('github: acme/thing#12: no review record carried to 0123456:'
      + ' 1111111\'s record review.20261101T110000Z.p-review.json does not parse')
  }
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
  tree![OLD_DIR] = { kind: 'dir', mtimeMs: ++earlierMtime }
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  // Read again once it changed: the new record names the pull request, so it is fingerprinted.
  expect(oldReads()).toBe(3)
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('the daily pruning removes the fingerprints kept past 90 days with the old records', async ($, on) => {
  const now = Date.now()
  const tree: World['tree'] = {
    [RECORDS]: { kind: 'dir', mtimeMs: now },
    '/data': { kind: 'dir', mtimeMs: now },
    [fingerprintFile(OLD)]: { kind: 'file', mtimeMs: now - 100 * DAY },
    [fingerprintFile(HEAD)]: { kind: 'file', mtimeMs: now - 10 * DAY },
    '/data/auto-merge.json': { kind: 'file', mtimeMs: now - 100 * DAY },
  }
  const seen = await world($, on, { tree })
  expect(seen.runs.map((r) => r.argv)).toEqual([['rm', '-rf', '--', fingerprintFile(OLD)]])
})

// ---- the check plan of a pull request, and its durable waiver ----

const planOf = (e2e: Record<string, string>, norms: Record<string, string> = { need: 'required', reason: '' }) => ({
  v: 1, repo: 'acme/thing', pr: 12, e2e: { reason: '', ...e2e }, norms: { reason: '', ...norms }, review: { need: 'full', reason: '' }, at: '2026-11-14T09:00:00Z',
})
const planCall = (plan: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', plan, ...over }) as any
// The plan as the orchestrator's review tool sends it: a call from that plugin, its answer as text.
const planned = async ($: any, plan: unknown) =>
  JSON.parse(String((await $.command.run({ command: 'emit-verdict', args: JSON.stringify({ pr: 12, repo: 'acme/thing', plan }) })).text))
const ONLY_REVIEW = Object.fromEntries([record('review', 'pass')])

test('a pull request whose plan needs no E2E is Ready with no E2E record, its line naming the plan\'s reason', async ($, on) => {
  const seen = await world($, on, { records: TWO, plan: planOf({ need: 'none', reason: 'docs only' }) })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs).toEqual(['github: acme/thing#12 Ready at 0123456: a clean review, no E2E needed'
    + ' (check plan, 2026-11-14: docs only) and green CI hold at its head.'])
})

test('a plan that needs no norms check and screenshots in place of E2E leaves the review alone required', async ($, on) => {
  const plan = planOf({ need: 'screenshots', reason: 'a colour change' }, { need: 'none', reason: 'one CSS line' })
  const seen = await world($, on, { records: ONLY_REVIEW, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 Ready at 0123456: a clean review, no norms check needed (check plan, 2026-11-14:'
    + ' one CSS line), no E2E needed (check plan, 2026-11-14: desktop and mobile screenshots in its place, a colour change) and green CI hold at its head.'])
})

test('a plan that gives the review none is Ready with no review record, its line naming the plan\'s reason', async ($, on) => {
  const plan = { ...planOf({ need: 'required' }), review: { need: 'none', reason: 'a typo' } }
  const seen = await world($, on, { records: OTHERS_PASSED, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs).toEqual(['github: acme/thing#12 Ready at 0123456: no review needed (check plan, 2026-11-14: a typo), passed E2E and green CI hold at its head.'])
})

test('a plan that requires a review of two rounds stays Not Ready with no review record', async ($, on) => {
  const plan = { ...planOf({ need: 'required' }), review: { need: 'required', reason: '', max: 2 } }
  const seen = await world($, on, { records: OTHERS_PASSED, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

for (const [label, w] of [
  ['a plan that requires E2E', { records: TWO, plan: planOf({ need: 'required' }) }],
  ['a failed run under a plan that needs no E2E', { records: { ...TWO, ...Object.fromEntries([record('e2e', 'fail')]) }, plan: planOf({ need: 'none', reason: 'docs only' }) }],
  ['a plan that does not parse', { records: TWO, plan: planOf({ need: 'none', reason: '' }) }],
] as const) {
  test('with ' + label + ' a pull request with no passed E2E stays Not Ready', async ($, on) => {
    const seen = await world($, on, w)
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(readinessRuns(seen)).toEqual([])
  })
}

test('the record tool writes the plan, posts it on the pull request, and the gate reads it at once', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { records: TWO })
  const out: any = await planned($, { e2e: 'none: docs only', norms: 'required' })
  expect(out.deny).toBeUndefined()
  expect(out.result).toContain('github: check plan of acme/thing#12: e2e none, norms required, review required: max 3')
  expect(out.result).toContain('Ready at 0123456')
  expect(JSON.parse(seen.files[PLAN])).toMatchObject({ v: 1, repo: 'acme/thing', pr: 12, e2e: { need: 'none', reason: 'docs only' }, norms: { need: 'required', reason: '' } })
  const comment = seen.runs.find((r) => r.command === 'pr-comment')
  expect(comment.args.pr).toBe(12)
  expect(comment.args.body).toContain('- e2e: none — docs only')
  expect(recordRun(seen)).toBeUndefined()
})

test('pr-plan answers the pull request\'s check plan as it stands, its number with or without #, with no engine run', async ($, on) => {
  const seen = await world($, on, { plan: { ...planOf({ need: 'required' }), review: { need: 'required', reason: '', max: 2 } } })
  const out: any = await $.tool.call(gh('pr-plan', { pr: 12 }))
  expect(JSON.parse(out.result)).toMatchObject({ repo: 'acme/thing', pr: 12, review: { need: 'required', max: 2 } })
  const hashed: any = await $.tool.call(gh('pr-plan', { pr: '#12' }))
  expect(JSON.parse(hashed.result).review.max).toBe(2)
  expect(seen.runs).toEqual([])
})

test('pr-plan says when the pull request has no check plan, or one that does not parse', async ($, on) => {
  await world($, on, { plan: planOf({ need: 'none', reason: '' }) })
  expect(((await $.tool.call(gh('pr-plan', { pr: 12 }))) as any).result).toBe('no check plan for acme/thing#12')
  expect(((await $.tool.call(gh('pr-plan', { pr: 13 }))) as any).result).toBe('no check plan for acme/thing#13')
  expect(((await $.tool.call(gh('pr-plan', {}))) as any).isError).toBe(true)
})

test('pr-plan reads a former full plan file as a required review of the cap\'s rounds', async ($, on) => {
  await world($, on, { plan: planOf({ need: 'required' }) })
  expect(JSON.parse(((await $.tool.call(gh('pr-plan', { pr: 12 }))) as any).result).review).toEqual({ need: 'required', reason: '', max: 3 })
})

test('a plan is refused when a need other than required gives no reason, or a need is unknown', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on)
  for (const plan of [{ e2e: 'none', norms: 'required' }, { e2e: 'required', norms: 'screenshots: x' }, { e2e: 'maybe' }, { review: 'none' }, []]) {
    expect((await planned($, plan)).deny).toContain('github: a check plan is')
  }
  expect(seen.files[PLAN]).toBeUndefined()
})

test('a new plan replaces the previous one, whatever it requires', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { plan: planOf({ need: 'none', reason: 'docs only' }) })
  const stricter: any = await planned($, { e2e: 'required', norms: 'required' })
  expect(stricter.deny).toBeUndefined()
  expect(JSON.parse(seen.files[PLAN]).e2e.need).toBe('required')
  const lighter: any = await planned($, { e2e: 'none: changed my mind', norms: 'none: small', review: 'one-pass: small' })
  expect(lighter.deny).toBeUndefined()
  expect(JSON.parse(seen.files[PLAN]).e2e.need).toBe('none')
})

test('an E2E waiver is refused when the plan needs no E2E: nothing was planned to waive', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, plan: planOf({ need: 'none', reason: 'docs only' }) })
  const words = 'no E2E for this docs change, 2026-11-02'
  await ($ as any).prompt.submit({ text: words, origin: { kind: 'composer' }, wait: false })
  const out: any = await $.tool.call(waiveCall(words))
  expect(out.deny).toContain('needs no E2E (none: docs only): a waiver lifts only a check the plan requires')
  expect(recordRun(seen)).toBeUndefined()
})

test('the operator\'s waiver at an earlier head stands for a later head of another diff', async ($, on) => {
  const waived = earlier([at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' })])
  const seen = await world($, on, { records: TWO, tree: waived, fingerprints: { [HEAD]: SAME, [OLD]: OTHER } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a failed run after the waiver at an earlier head voids it for the later heads', async ($, on) => {
  const failedLater = earlier([at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' }), at('e2e', 'fail', {}, '2026-11-01T11:00:00Z')])
  const seen = await world($, on, { records: TWO, tree: failedLater, fingerprints: { [HEAD]: SAME, [OLD]: OTHER } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('the plan files are refused to Write and Bash', async ($, on) => {
  await world($, on)
  expect(((await $.tool.call({ tool: 'Write', file_path: PLAN, content: '{}' } as any)) as any).deny).toContain('a check plan through')
  expect(((await $.tool.call(bash('rm -rf "$CLAUDE_PLUGIN_DATA/check-plans/acme"'))) as any).deny).toContain('a check plan through')
})

// ---- who writes the plan ----

test('a plan from the model itself, as an implementer would send it, is refused and writes nothing', async ($, on) => {
  const seen = await world($, on)
  const out: any = await $.tool.call(planCall({ e2e: 'none: docs only' }))
  expect(out.deny).toBe('github: a check plan is written by mcp__orchestrator__review, from an orchestrator session.')
  expect(seen.files[PLAN]).toBeUndefined()
})

for (const plugin of ['pr-review', 'norms', 'implement']) {
  test('a plan from the ' + plugin + ' plugin is refused', reviewing(plugin), async ($, on) => {
    const seen = await world($, on)
    expect((await planned($, { e2e: 'none: docs only' })).deny).toContain('mcp__orchestrator__review')
    expect(seen.files[PLAN]).toBeUndefined()
  })
}

// ---- the operator's waiver: his answer to one question, from any channel ----

const WAIVER_Q = 'Dispense d\'E2E pour acme/thing#12 : the plan required E2E for its API change, now reverted to docs only'
const askWaiver = ($: any, question = WAIVER_Q, labels = ['Accorder', 'Refuser']) => $.tool.call({
  tool: 'AskUserQuestion',
  questions: [{ question, header: 'E2E', multiSelect: false, options: labels.map((label) => ({ label, description: label })) }],
})
const consentWrites = (seen: Seen) => seen.writes.filter((w) => w.path.startsWith(CONSENTS + '/dialog-')).map((w) => JSON.parse(w.text))
// What the dialog's answer leaves, the module's date being its clock's.
const DIALOG = { v: 1, subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }, question: WAIVER_Q, by: 'tab', at: '2026-11-02T12:00:00Z' }
const granted = (over: Record<string, unknown> = {}) => consent({ answer: 'Accorder', ...over })

for (const answer of ['Accorder', 'Refuser']) {
  test('the operator\'s « ' + answer + ' » to the waiver dialog is recorded once, dated by the module', async ($, on) => {
    mock.clock(on, { now: RECEIVED })
    const seen = await world($, on, { records: TWO, answer })
    await askWaiver($)
    const [written, ...more] = consentWrites(seen)
    expect(more).toEqual([])
    expect(written).toMatchObject({ ...DIALOG, answer })
    expect(String(written.entry)).toStartWith('dialog-guard-session-')
  })
}

test('a dialog that is no waiver question records nothing', async ($, on) => {
  const seen = await world($, on, { answer: 'Accorder' })
  await askWaiver($, WAIVER_Q, ['Accorder', 'Plus tard'])
  await askWaiver($, 'Merge acme/thing#12 ?')
  expect(consentWrites(seen)).toEqual([])
})

test('a successor session reads the dialog\'s « Accorder » at a head with no E2E record: Ready, and says the waiver', async ($, on) => {
  const seen = await world($, on, { records: TWO, ...consentWorld({ x: { ...DIALOG, entry: 'dialog-s-1', answer: 'Accorder' } }) })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs[0]).toContain('(e2e waived by the operator (tab, 2026-11-02T12:00:00Z)).')
})

for (const by of ['pane', 'coordinator']) {
  test('the « Accorder » given in the ' + by + ' counts as the dialog\'s does', async ($, on) => {
    const seen = await world($, on, { records: TWO, ...consentWorld({ a: granted({ by }) }) })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  })
}

for (const [label, records] of [
  ['a « Refuser »', { a: consent({ answer: 'Refuser' }) }],
  ['a « Refuser » after an « Accorder »', { a: granted(), b: consent({ entry: 'b', answer: 'Refuser', at: '2026-11-04T10:00:00Z' }) }],
  ['an « Accorder » of another pull request', { a: granted({ subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 13 } }) }],
  ['an answer that is no choice of the question', { a: consent() }],
] as const) {
  test('with ' + label + ' the E2E is not waived', async ($, on) => {
    const seen = await world($, on, { records: TWO, labels: ['Ready'], ...consentWorld(records) })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: no record at 0123456'])
  })
}

test('a run that failed at an earlier head after the « Accorder » voids it', async ($, on) => {
  const failedAfter = earlier([at('e2e', 'fail', {}, '2026-11-04T10:00:00Z')])
  const seen = await world($, on, { records: TWO, labels: ['Ready'], tree: { ...failedAfter, ...consentWorld({ a: granted() }).tree } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: no record at 0123456'])
})

test('a run that failed at an earlier head before the « Accorder » leaves it standing', async ($, on) => {
  const failedBefore = earlier([at('e2e', 'fail', {}, '2026-11-02T10:00:00Z')])
  const seen = await world($, on, { records: TWO, tree: { ...failedBefore, ...consentWorld({ a: granted() }).tree } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a waived record with no « Accorder » recorded is refused, and names the question to put and where it goes', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent({ answer: 'Refuser' }) }))
  const out: any = await $.tool.call(waiveCall('the operator said so'))
  expect(out.deny).toContain('github: an E2E waiver is the operator\'s « Accorder » to one question, « Dispense d\'E2E pour acme/thing#12 : <why> »')
  expect(out.deny).toContain('asked as method:lifecycle « Questions to the operator » says')
  expect(recordRun(seen)).toBeUndefined()
})

test('a waived record over an « Accorder » carries his answer, dated by the module that recorded it', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: granted() }))
  const out: any = await $.tool.call(waiveCall(''))
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv[argv.indexOf('--detail') + 1]).toBe('operator: Accorder (pane, 2026-11-03T10:00:00Z)')
})

// ---- the operator's waiver of required norms: the same question, naming the check ----

const NORMS_Q = 'Dispense de normes pour acme/thing#12 : the plan required the norms check, the repository has no CONTRIBUTING.md'
// A plan that requires norms and needs no E2E: the review alone is recorded at the head.
const NORMS_REQUIRED = planOf({ need: 'none', reason: 'docs only' })
const normsAnswer = (answer: string, over: Record<string, unknown> = {}) =>
  consent({ subject: { kind: 'norms-waiver', repo: 'acme/thing', pr: 12 }, question: NORMS_Q, answer, ...over })
const NORMS_MISSING = 'github: acme/thing#12 back to Not Ready at 0123456. Missing: norms: no record at 0123456'

test('the operator\'s « Accorder » to the norms waiver dialog is recorded with the norms subject', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { records: ONLY_REVIEW, answer: 'Accorder' })
  await askWaiver($, NORMS_Q)
  const [written, ...more] = consentWrites(seen)
  expect(more).toEqual([])
  expect(written).toMatchObject({ subject: { kind: 'norms-waiver', repo: 'acme/thing', pr: 12 }, question: NORMS_Q, answer: 'Accorder', by: 'tab' })
})

test('norms required by the plan and waived by his « Accorder »: Ready with no norms record, and says the waiver', async ($, on) => {
  const seen = await world($, on, { records: ONLY_REVIEW, plan: NORMS_REQUIRED, ...consentWorld({ a: normsAnswer('Accorder') }) })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs[0]).toContain('norms waived by the operator (pane, 2026-11-03T10:00:00Z)')
})

for (const [label, records] of [
  ['his « Refuser »', { a: normsAnswer('Refuser') }],
  ['an « Accorder » of the E2E only', { a: granted() }],
] as const) {
  test('norms required by the plan with ' + label + ' stay missing', async ($, on) => {
    const seen = await world($, on, { records: ONLY_REVIEW, plan: NORMS_REQUIRED, labels: ['Ready'], ...consentWorld(records) })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(seen.logs).toHaveLength(1)
    expect(seen.logs[0]).toStartWith(NORMS_MISSING)
    expect(seen.logs[0]).not.toContain('norms waived')
  })
}

test('a norms check that failed at an earlier head after his « Accorder » voids the waiver', async ($, on) => {
  const failedAfter = earlier([at('norms', 'fail', {}, '2026-11-04T10:00:00Z')])
  const seen = await world($, on, { records: ONLY_REVIEW, plan: NORMS_REQUIRED, labels: ['Ready'], tree: { ...failedAfter, ...consentWorld({ a: normsAnswer('Accorder') }).tree } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual([NORMS_MISSING])
})

test('a waived norms record with no « Accorder » to the norms question is refused', reviewing('norms'), async ($, on) => {
  const seen = await world($, on, { plan: NORMS_REQUIRED, ...consentWorld({ a: granted() }) })
  const out: any = await verdict($, { kind: 'norms', result: 'waived', detail: '' })
  expect(out.deny).toContain('github: a norms waiver is the operator\'s « Accorder » to one question, « Dispense de normes pour acme/thing#12 : <why> »')
  expect(recordRun(seen)).toBeUndefined()
})

test('a waived norms record over his « Accorder » to the norms question is written', reviewing('norms'), async ($, on) => {
  const seen = await world($, on, { plan: NORMS_REQUIRED, ...consentWorld({ a: normsAnswer('Accorder') }) })
  const out: any = await verdict($, { kind: 'norms', result: 'waived', detail: '' })
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv[argv.indexOf('--kind') + 1]).toBe('norms')
  expect(argv[argv.indexOf('--detail') + 1]).toBe('operator: Accorder (pane, 2026-11-03T10:00:00Z)')
})

// ---- the deploy list ----

const INFRA = 'acme/infra'
const DEPLOYS = [
  { repo: INFRA, kind: 'command', argv: ['composer', 'deploy:api:prod'], env: 'prod' },
  { repo: INFRA, kind: 'command', argv: ['composer', 'deploy:api:staging'], env: 'staging' },
  { repo: INFRA, kind: 'skill', name: 'infra-deploy-prod', env: 'prod' },
  { repo: 'acme/site', kind: 'workflow', workflow: 'deploy.yml', input: 'environment' },
]
const deployList = (...grants: Array<[string, string]>) =>
  ({ repositories: grants.map(([repo, env]) => ({ repo, env })), commands: DEPLOYS })
const STAGING_ONLY = { deployList: deployList([INFRA, 'staging']) }
const PROD_DEPLOY = 'cd ~/infra && composer deploy:api:prod -- 1.2.3 > /tmp/log 2>&1'
const AUTO_DEPLOY_WORDS = CONSENT_GRANT + ' : infra passe en auto-deploy'
const setDeploy = (on: boolean, words: string, env = 'prod', extra: Record<string, unknown> = {}, repo = INFRA) =>
  gh('auto-deploy-set', { repo, env, on, words, ...extra }, undefined as any)
const deployGrants = (seen: Seen) => JSON.parse(seen.files[AUTO_DEPLOY]).repositories

test('a deploy of a repository the list does not grant for that environment is refused, and never runs', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out: any = await $.tool.call(bash(PROD_DEPLOY))
  expect(out.deny).toContain('acme/infra is not in the deploy list for prod')
  expect(out.deny).toContain('auto-deploy-set')
  expect(out.deny).not.toContain('\n')
  expect(seen.bash).toEqual([])
})

test('a deploy the list grants is not refused, whatever else the line does', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out: any = await $.tool.call(bash('composer deploy:api:staging'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['composer deploy:api:staging'])
})

test('a workflow, a skill and a script are refused the same way, and a deploy of no declared path is not read', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const flow: any = await $.tool.call(bash('gh workflow run deploy.yml -f environment=prod'))
  expect(flow.deny).toContain('acme/site is not in the deploy list for prod')
  const skill: any = await $.tool.call({ tool: 'Skill', skill: 'infra-deploy-prod' } as any)
  expect(skill.deny).toContain('acme/infra is not in the deploy list for prod')
  expect(seen.skills).toEqual([])
  const undeclared: any = await $.tool.call(bash('./scripts/other-deploy.sh prod'))
  expect(undeclared.deny).toBeUndefined()
  expect(seen.bash).toEqual(['./scripts/other-deploy.sh prod'])
})

test('a listed skill runs', async ($, on) => {
  const seen = await world($, on, { deployList: deployList([INFRA, 'prod']) })
  const out: any = await $.tool.call({ tool: 'Skill', skill: 'infra-deploy-prod' } as any)
  expect(out.deny).toBeUndefined()
  expect(seen.skills).toEqual(['infra-deploy-prod'])
})

test('the list only denies: a granted deploy and an undeclared prod path both stay with the host\'s own decision', async ($, on) => {
  await world($, on, { deployList: deployList([INFRA, 'prod']), verdict: { decision: 'ask' } })
  for (const line of [PROD_DEPLOY, 'ssh deploy@api.prod.example.net ./release.sh']) {
    expect(((await $.tool.check({ tool: 'Bash', input: { command: line } })) as any).decision, line).toBe('ask')
  }
})

test('a deploy whose environment the call does not name is refused', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out: any = await $.tool.call(bash('gh workflow run deploy.yml'))
  expect(out.deny).toContain('its environment is none of dev, staging, prod')
  expect(seen.bash).toEqual([])
})

test('with no grant in the file every declared deploy is refused', async ($, on) => {
  const none = await world($, on, { deployList: { commands: DEPLOYS } })
  expect(((await $.tool.call(bash('composer deploy:api:staging'))) as any).deny).toContain('not in the deploy list for staging')
  expect(none.bash).toEqual([])
})

test('a list that cannot be read lists nothing and says so in one line, and a deploy meets the host\'s decision', async ($, on) => {
  const seen = await world($, on, { deployList: '{not json' })
  const out: any = await $.tool.call(bash('composer deploy:api:prod'))
  expect(out.deny).toBeUndefined()
  expect(seen.logs.some((l) => l.includes('auto-deploy.json') && l.includes('unread'))).toBe(true)
})

// A world holding the operator's answer `text` to a round question asking auto-deploy of acme/infra on `env`.
function deployWorld(text = CONSENT_GRANT, env = 'prod', over: World = {}): World {
  const answered = consentWorld({
    a: consent({ subject: { kind: 'auto-deploy', repo: INFRA, env }, question: 'Auto-deploy infra on ' + env + '?', answer: text, by: 'coordinator' }),
  }, '/cfg/consents/acme/infra')
  return { ...answered, ...over, tree: { ...answered.tree, ...over.tree } }
}

test('auto-deploy-set grants one environment of a repository on the operator\'s recorded answer naming auto-deploy', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', STAGING_ONLY))
  const set: any = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod'))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }, { repo: INFRA, env: 'prod' }])
  expect(JSON.parse(seen.files[AUTO_DEPLOY]).commands).toEqual(DEPLOYS)
  expect(((await $.tool.call(bash(PROD_DEPLOY))) as any).deny).toBeUndefined()
})

test('words the operator typed are no consent: with no consent record a list change is refused and writes nothing', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  await typed($, AUTO_DEPLOY_WORDS)
  const out: any = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))
  expect(out.deny).toContain('consent record (orchestrator) of auto-deploy on acme/infra for prod')
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
  expect(seen.writes).toEqual([])
})

// A recorded answer is a grant only as « Accorder »: a refusal quoted with on:true, in the choice's words or in prose, grants no environment.
for (const answer of ['B : ne pas passer infra en auto-deploy sur prod', 'ne pas passer infra en auto-deploy sur prod', 'oui, infra passe en auto-deploy', 'oui']) {
  test('a recorded answer that is no « ' + CONSENT_GRANT + ' » never carries auto-deploy: ' + answer, async ($, on) => {
    const seen = await world($, on, deployWorld(answer, 'prod', STAGING_ONLY))
    const out: any = await $.tool.call(setDeploy(true, answer + ' : infra en auto-deploy'))
    expect(out.deny).toContain('github: auto-deploy-set refused on acme/infra for prod')
    expect(out.deny).toContain('« ' + CONSENT_GRANT + ' »')
    expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
    expect(seen.writes).toEqual([])
  })
}


const DEPLOY_ANSWER = CONSENT_GRANT + ' : infra passe en auto-deploy sur staging'

test('auto-deploy-set may quote the operator\'s answer in a consent record of that repository and environment', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'staging'))
  const out: any = await $.tool.call(setDeploy(true, DEPLOY_ANSWER, 'staging'))
  expect(out.deny).toBeUndefined()
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
})

test('a consent record of auto-deploy on one environment does not carry another', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'staging'))
  const out: any = await $.tool.call(setDeploy(true, DEPLOY_ANSWER, 'prod'))
  expect(out.deny).toContain('consent record (orchestrator) of auto-deploy on acme/infra for prod')
  expect(seen.writes).toEqual([])
})

test('auto-deploy-set off takes the environment out, and the deploy is refused again', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { deployList: deployList([INFRA, 'staging'], [INFRA, 'prod']) }))
  expect(((await $.tool.call(setDeploy(false, AUTO_DEPLOY_WORDS, 'prod'))) as any).deny).toBeUndefined()
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
  expect(((await $.tool.call(bash(PROD_DEPLOY))) as any).deny).toContain('not in the deploy list for prod')
})

test('auto-deploy-set names a repository and an environment, and says in or out', async ($, on) => {
  const seen = await world($, on, deployWorld())
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', {}, 'infra'))) as any).deny).toContain('owner/name')
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'production'))) as any).deny).toContain('"env"')
  expect(((await $.tool.call(gh('auto-deploy-set', { repo: INFRA, env: 'prod', words: AUTO_DEPLOY_WORDS }, undefined as any))) as any).deny).toContain('{"on": true}')
  expect(seen.writes).toEqual([])
})

test('auto-deploy-set adds the commands a repository declares as its deploys, and refuses a malformed one', async ($, on) => {
  const seen = await world($, on, deployWorld())
  const declared = { kind: 'script', path: 'scripts/deploy.sh' }
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', { commands: [declared] }))) as any).deny).toBeUndefined()
  expect(JSON.parse(seen.files[AUTO_DEPLOY]).commands).toEqual([{ repo: INFRA, ...declared }])
  const bad: any = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', { commands: [{ kind: 'cron' }] }))
  expect(bad.deny).toContain('"script", a "workflow" or a "skill"')
  expect(JSON.parse(seen.files[AUTO_DEPLOY]).commands).toEqual([{ repo: INFRA, ...declared }])
})

test('auto-deploy-set holds the file\'s lock, and releases it', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', STAGING_ONLY))
  await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))
  expect(seen.runs.filter((r) => r.argv?.includes(AUTO_DEPLOY + '.lock')).map((r) => r.argv[0])).toEqual(['sh', 'rm'])
})

test('a malformed deploy list is never overwritten', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { deployList: '{"repositories": [1]}' }))
  const out: any = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_DEPLOY]).toBe('{"repositories": [1]}')
})

test('auto-deploy-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { verdict: { decision: 'deny', reason: 'no' } }))
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))) as any).deny).toBe('no')
  expect(seen.writes).toEqual([])
})

test('auto-deploy-list prints each environment granted', async ($, on) => {
  await world($, on, { deployList: deployList([INFRA, 'staging'], ['acme/site', 'dev']) })
  expect(((await $.tool.call(gh('auto-deploy-list', {}, undefined as any))) as any).result).toBe('acme/infra staging\nacme/site dev')
})

test('auto-deploy-list says when no repository is in auto-deploy', async ($, on) => {
  await world($, on)
  expect(((await $.tool.call(gh('auto-deploy-list', {}, undefined as any))) as any).result).toBe('no repository in auto-deploy')
})

test('the deploy list is refused to Write, Edit and Bash, and a read of it is not', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  for (const tool of ['Write', 'Edit']) {
    const out: any = await $.tool.call({ tool, file_path: AUTO_DEPLOY, content: '{}' } as any)
    expect(out.deny, tool).toContain('the deploy list changes only through mcp__github__gh auto-deploy-set')
  }
  const home: any = await $.tool.call({ tool: 'Write', file_path: '/home/x/.claude/plugins/data/github-lounisbou/auto-deploy.json', content: '{}' } as any)
  expect(home.deny).toContain('auto-deploy-set')
  for (const line of ['echo \'{}\' > /data/auto-deploy.json', 'cd ~/.claude/plugins/data/github-lounisbou && jq . auto-deploy.json > x && mv x auto-deploy.json']) {
    expect(((await $.tool.call(bash(line))) as any).deny, line).toContain('auto-deploy-set')
  }
  expect(seen.bash).toEqual([])
  expect(((await $.tool.call(bash('grep -n auto-deploy.json README.md'))) as any).deny).toBeUndefined()
})
