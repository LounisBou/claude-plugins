// The ready guard, the auto-merge split, the label following the head, the
// records guard and the record tool, through the module as the session runs
// it: the tool's calls, Bash, Write, and the engine stubbed per scenario.
import { expect, mock as hostMock, test } from 'claude-code/testing'
import type { Engine, NounEvents, Reply, TestOn } from 'claude-code/testing'
import { EXEMPT_REFUSAL } from './register.js'
import { RECORDS_REFUSAL, STATUS_REFUSAL, STDIN_REFUSAL } from './ready.js'
import { FOREIGN_CEILING_MS, FOREIGN_WAIT_MS } from './reconcile.ts'
import { parseLearningEvent } from '../core/learning.ts'
// The tests that set the clock themselves, by their event registry: the other worlds get a clock, and their Not Ready is this machine's.
const clocked = new WeakSet<object>()
const mock = { ...hostMock, clock: (on: TestOn, options?: { readonly now?: number }) => (clocked.add(on), hostMock.clock(on, options)) }
// The choices a consent question offered, which an old consent file still holds.
const CONSENT_GRANT = 'Accorder'
const CONSENT_REFUSE = 'Refuser'
import { dialogOf, fieldsOf, listOf } from '../core/host.ts'

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '')
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED = 'fedcba9876543210fedcba9876543210fedcba98'
const RECORDS = '/cfg/pr-records'
const HEAD_DIR = RECORDS + '/acme/thing/' + HEAD
// The E2E command a pass or a fail rests on: the world runs it with exit 0.
const E2E_RUN = ['npm', 'run', 'e2e']
const AUTO_MERGE = '/data/auto-merge.json'
const AUTO_DEPLOY = '/data/auto-deploy.json'
const EXEMPTION = '/data/e2e-exempt/acme/thing.json'
const PLAN = '/data/check-plans/acme/thing/12.json'

let sessions = 0

type World = {
  // pr-gate's answer: an object, raw text, or a failing exit with this stderr.
  gate?: unknown
  gateFails?: string
  // The line pr-gate and pr-checks print on stderr while they succeed (the Actions runs unread).
  readStderr?: string
  labels?: string[]
  ci?: Record<string, unknown>
  // The records at the head, by file name; omitted: the four pass.
  records?: Record<string, string>
  // pr-get's pull requests, by branch ('' for the current one).
  pulls?: Record<string, unknown[]>
  autoMerge?: string[]
  // pr-gate's mergeability of the head against its base, carried into the gate answer when given.
  mergeable?: boolean | null
  mergeable_state?: string
  // The deploy list file, as written (an object) or as raw text.
  deployList?: unknown
  // git's answers, by its argv after git.
  git?: Record<string, { exitCode: number; stdout: string; stderr?: string }>
  // git's answers in another directory than the session's, by that directory, then by argv after git.
  gitIn?: Record<string, Record<string, { exitCode: number; stdout: string }>>
  verdict?: { decision: string; rule?: unknown; reason?: string }
  answer?: string
  // What the Bash tool answers.
  bashResult?: unknown
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
  // Every write of the journal fails with this text.
  journalFails?: string
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
  // The pull request's Not Ready was written by this machine, as the machine's sighting of its label keeps it.
  ownLabel?: boolean
  // No clock is answered: the module cannot read the time.
  noClock?: boolean
  // What pr-fingerprint answers, by head, over two commits; a head absent fails with this error, or a merge's.
  fingerprints?: Record<string, string>
  fingerprintFails?: string
  // The heads holding a merge of the base, and the diff of the pull request by head, answered to `merges`.
  merged?: string[]
  diffs?: Record<string, string>
  // The pull request's commit count pr-gate answers; omitted, none.
  commits?: number
  // A head directory that is there but cannot be listed.
  unlistable?: string
  // Whether pr-gate reads the pull request stacked (on feat-a); omitted, it says nothing of it.
  stacked?: boolean
  // What light_ci.py answers; with a result, it writes a tests record of that result at the head, by light-ci.
  lightCi?: { exitCode: number; stdout: string; stderr: string; result?: string }
  // The exit code of the E2E command (E2E_RUN): 0 when not given.
  e2eExit?: number
  // What engine/forge_status.py answers on stderr when it fails; omitted, it posts.
  forgeFails?: string
}

// A command the session ran: its argv, and for the engine the request it read on stdin.
type GuardRun = { readonly argv: readonly string[]; readonly command?: string | undefined; readonly repo?: unknown; readonly args?: Readonly<Record<string, unknown>> | undefined }

function runOf(e: NounEvents['process.run']): GuardRun {
  const request = fieldsOf(JSON.parse(e.init?.stdin ?? '{}')) ?? {}
  const command = request['command']
  return { argv: e.argv, command: typeof command === 'string' ? command : undefined, repo: request['repo'], args: fieldsOf(request['args']) }
}

type Seen = {
  pull?: Pull
  runs: GuardRun[]; asked: string[]; logs: string[]; writes: Array<{ path: string; text: string }>; bash: string[]; skills: string[]
  // The files of the plugin's data directory, by path.
  files: Record<string, string>
  // The context each prompt entered with.
  contexts: string[][]
  // The paths $.fs read, in order.
  reads: string[]
  // The input of each permission check the tools asked.
  checks: unknown[]
  // The code of each refusal event the module journaled: one per guard it observed and let the call through.
  journal: string[]
  // The text of each of those events.
  events: string[]
}

const JOURNAL = '/cfg/github/journal/'

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
    ...(w.stacked === undefined ? {} : { stacked: w.stacked, base: 'feat-a' }),
    ...(w.mergeable === undefined ? {} : { mergeable: w.mergeable }),
    ...(w.mergeable_state === undefined ? {} : { mergeable_state: w.mergeable_state }),
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1, ...(w.ci ?? {}) },
  }
}

async function world($: Engine, on: TestOn, w: World = {}): Promise<Seen> {
  const seen: Seen = { runs: [], asked: [], logs: [], writes: [], bash: [], skills: [], files: {}, contexts: [], reads: [], checks: [], journal: [], events: [] }
  if (w.autoMerge !== undefined) seen.files[AUTO_MERGE] = JSON.stringify({ repositories: w.autoMerge })
  if (w.deployList !== undefined) seen.files[AUTO_DEPLOY] = typeof w.deployList === 'string' ? w.deployList : JSON.stringify(w.deployList)
  if (w.plan !== undefined) seen.files[PLAN] = JSON.stringify(w.plan)
  if (w.ownLabel) seen.files['/data/label-seen/acme/thing/12.json'] = JSON.stringify({ v: 1, head: HEAD, label: 'not-ready', own: true, since: 0 })
  if (w.exemption !== undefined) seen.files[EXEMPTION] = typeof w.exemption === 'string' ? w.exemption : JSON.stringify(w.exemption)
  // A test that sets no clock reads the label of its pull request as this machine's own, unless the world says it is not.
  const own = w.ownLabel ?? (!clocked.has(on) && !w.noClock)
  // Such a world keeps the machine's sightings out of what its test reads of the files, the writes and the runs.
  const defaulted = !clocked.has(on)
  if (defaulted && !w.noClock) hostMock.clock(on, { now: RECEIVED })
  const hidden: Record<string, string> = {}
  const quiet = (path: unknown): boolean => defaulted && String(path).includes('/label-seen/')
  const filesOf = (path: unknown): Record<string, string> => (quiet(path) ? hidden : seen.files)
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
  on('tool.check', (_$, e) => {
    seen.checks.push(e.input)
    return e.tool === 'AskUserQuestion' || e.tool === 'Read' ? { decision: 'allow' } : w.verdict ?? { decision: 'allow' }
  })
  on('tool.call', { tool: 'Read' }, (_$, e) =>
    ({ result: { type: 'text', file: { filePath: e['file_path'], content: '', numLines: 222, startLine: 1, totalLines: 222 } } }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = dialogOf(e).question
    seen.asked.push(question)
    return { result: { questions: e['questions'], answers: { [question]: w.answer ?? 'Allow' } } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.bash.push(String(e['command']))
    return w.bashResult ?? { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Skill' }, (_$, e) => {
    seen.skills.push(String(e['skill']))
    return { result: { success: true, commandName: e['skill'] } }
  })
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) on('tool.call', { tool }, () => ({ result: 'written' }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('prompt.submit', (_$, e) => {
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path in tree || e.path in seen.files || (!!w.listFails && e.path === HEAD_DIR) }))
  on('fs.stat', (_$, e) => w.statFails ? { deny: w.statFails }
    : e.path in tree ? { value: { kind: tree[e.path]?.kind, size: 0, mtimeMs: tree[e.path]?.mtimeMs, isLink: false } } : { deny: 'ENOENT ' + e.path })
  on('fs.list', (_$, e) => {
    if (e.path === HEAD_DIR && w.listFails) return { deny: w.listFails }
    if (e.path === w.unlistable) return { deny: 'EACCES ' + e.path }
    if (e.path === HEAD_DIR) {
      return { value: Object.keys(records).map((name) => ({ name, kind: 'file', size: 1, isLink: false })) }
    }
    const below = Object.keys(tree).filter((p) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
    if (e.path in tree) return { value: below.map((p) => ({ name: p.slice(e.path.length + 1), kind: tree[p]?.kind, size: 0, isLink: false })) }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    if (e.path in filesOf(e.path)) return { value: filesOf(e.path)[e.path] }
    if (own && e.path === '/data/label-seen/acme/thing/12.json') return { value: JSON.stringify({ v: 1, head: HEAD, label: 'not-ready', own: true, since: 0 }) }
    if (tree[e.path]?.text !== undefined) return { value: tree[e.path]?.text }
    if (e.path.startsWith(HEAD_DIR + '/')) {
      const name = e.path.slice(HEAD_DIR.length + 1)
      if (name in records) return { value: records[name] }
    }
    return { deny: 'ENOENT ' + e.path }
  })
  on('fs.write', (_$, e) => {
    if (e.path.startsWith(JOURNAL)) {
      if (w.journalFails) return { deny: w.journalFails }
      seen.journal.push(String(fieldsOf(fieldsOf(JSON.parse(e.text))?.['source'])?.['code']))
      seen.events.push(e.text)
      return { value: undefined }
    }
    if (quiet(e.path)) {
      hidden[e.path] = e.text
      return { value: undefined }
    }
    seen.writes.push({ path: e.path, text: e.text })
    if (e.path.startsWith('/data/')) seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh' && e.argv[2] === 'set -C; echo "$$" > "$1"') {
      // The list's lock, taken with noclobber: refused while the file is there.
      const lock = String(e.argv[4])
      if (!quiet(lock)) seen.runs.push({ argv: e.argv })
      if (lock in filesOf(lock) || lock in tree) return { value: { exitCode: 1, stdout: '', stderr: 'sh: cannot overwrite existing file' } }
      filesOf(lock)[String(lock)] = '4242\n'
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    // The machine's sightings of labels are locked and moved by the same commands: kept out of the runs a test reads.
    if (e.argv[0] === 'sh' && quiet(e.argv[4])) {
      const lock = String(e.argv[4])
      if (lock in hidden) return { value: { exitCode: 1, stdout: '', stderr: 'sh: cannot overwrite existing file' } }
      hidden[lock] = '4242\n'
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[0] === 'sleep') {
      seen.runs.push({ argv: e.argv })
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    // The journal's event moves into place: no act of the session.
    if (e.argv[0] === 'mv' && String(e.argv[3]).startsWith(JOURNAL)) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (e.argv[0] === 'mv' || e.argv[0] === 'rm' || e.argv[0] === 'mkdir') {
      const [from, to] = e.argv.slice(-2)
      if (!quiet(to) && !quiet(e.argv[2])) seen.runs.push({ argv: e.argv })
      if (e.argv[0] === 'mv') {
        if (w.mvFails && !quiet(to)) return { value: { exitCode: 1, stdout: '', stderr: w.mvFails } }
        filesOf(to)[String(to)] = filesOf(from)[String(from)] ?? ''
        delete filesOf(from)[String(from)]
      }
      if (e.argv[0] === 'rm') {
        delete filesOf(to)[String(to)]
        delete tree[String(to)]
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const stdin = runOf(e)
    seen.runs.push(stdin)
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
      const [name, text] = record(String(option('--kind')), String(option('--result')), '2026-11-02T10:00:00Z', { producer: 'session-e2e', ...acceptance })
      records[name] = text
      return { value: { exitCode: 0, stdout: HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json\n', stderr: '' } }
    }
    if (String(e.argv[1] ?? '').endsWith('/engine/forge_status.py') && w.forgeFails) {
      return { value: { exitCode: 1, stdout: '', stderr: w.forgeFails } }
    }
    if (e.argv.join(' ') === E2E_RUN.join(' ')) {
      return { value: { exitCode: w.e2eExit ?? 0, stdout: '', stderr: w.e2eExit ? '2 scenarios failed\n' : '' } }
    }
    if (String(e.argv[1] ?? '').endsWith('/engine/light_ci.py')) {
      const answer = w.lightCi ?? { exitCode: 0, stdout: '', stderr: '' }
      if (answer.exitCode === 0 && answer.result) {
        const [name, text] = record('tests', answer.result, '2026-11-02T10:00:00Z', { producer: 'light-ci', detail: 'npm test — exit 0 — 9s' })
        records[name] = text
      }
      return { value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr } }
    }
    if (stdin.command === 'pr-gate') {
      if (w.gateFails) return { value: { exitCode: 3, stdout: '', stderr: w.gateFails } }
      const gate = gateOf(w, pull)
      return { value: { exitCode: 0, stdout: typeof gate === 'string' ? gate : JSON.stringify(gate), stderr: w.readStderr ?? '' } }
    }
    if (stdin.command === 'pr-files' && w.filesFails) return { value: { exitCode: 3, stdout: '', stderr: w.filesFails } }
    if (stdin.command === 'pr-files' && w.files) return { value: { exitCode: 0, stdout: JSON.stringify(w.files), stderr: '' } }
    if (stdin.command === 'pr-fingerprint') {
      const head = String(stdin.args?.['head'])
      const fingerprint = w.fingerprints?.[head]
      const merged = w.merged?.includes(head) === true
      const diff = stdin.args?.['merges'] === true ? w.diffs?.[head] : undefined
      if (merged ? !diff : !fingerprint) return { value: { exitCode: 1, stdout: '', stderr: w.fingerprintFails ?? 'error: commit 1234567 is a merge' } }
      return { value: { exitCode: 0, stdout: JSON.stringify({ head, commits: stdin.args?.['count'] ?? 2, ...(merged ? {} : { fingerprint }), ...(diff ? { diff } : {}) }), stderr: '' } }
    }
    if (stdin.command === 'pr-checks' && w.readStderr) return { value: { exitCode: 0, stdout: 'ok', stderr: w.readStderr } }
    if (stdin.command === 'pr-readiness' && w.readinessFails) return { value: { exitCode: 3, stdout: '', stderr: w.readinessFails } }
    if (stdin.command === 'pr-readiness') pull.labels = [stdin.args?.['state'] === 'ready' ? 'Ready' : 'Not Ready']
    if (stdin.command === 'pr-draft') pull.draft = true
    if (stdin.command === 'pr-get' && w.branch !== undefined && (stdin.args?.['branch'] ?? '') === w.branch) {
      return { value: { exitCode: 0, stdout: JSON.stringify([{ number: 12, labels: pull.labels.map((name) => ({ name })) }]), stderr: '' } }
    }
    if (stdin.command === 'pr-get') {
      return { value: { exitCode: 0, stdout: JSON.stringify(w.pulls?.[String(stdin.args?.['branch'] ?? '')] ?? []), stderr: '' } }
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
  ({ tool: 'mcp__github__gh', command, args, repo })
const bash = (command: string) => ({ tool: 'Bash', command })
const commands = (seen: Seen) => seen.runs.map((r) => r.command ?? r.argv.join(' '))
const gates = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-gate').length
// No record at all: review, norms and E2E missing, CI green.
const NO_RECORDS = { records: {} }
// A review that failed at the head, beside an E2E that passed.
const REVIEW_FAILED = { records: Object.fromEntries([record('review', 'fail'), record('e2e', 'pass')]) }
const REVIEW_FAILED_ITEM = 'review: fail at 0123456 by p-review'

// The four sections a description ends with.
const SECTIONS = '**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none'
// A description that keeps the writing rules, quoted for a shell line.
const BODY_OK = '"Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'

const REFUSAL_END = ' What Ready needs is core\'s readiness contract (core/readiness.ts).'

// ---- the tool ----

test('refused by the person, the gate is read once and nothing runs', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], answer: 'Deny', autoMerge: ['acme/thing'], verdict: { decision: 'ask', rule: 'mcp__github__gh' } })
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(gates(seen)).toBe(1)
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a not-ready pr-ready outside auto-merge is refused before anyone is asked', async ($, on) => {
  const seen = await world($, on, REVIEW_FAILED)
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toBe('github: pr-ready refused on acme/thing#12 at 0123456: not ready. Missing: ' + REVIEW_FAILED_ITEM + '.' + REFUSAL_END)
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate'])
})


test('a ready pr-ready outside auto-merge goes through, never asked', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(seen.journal).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
})

test('pr-readiness ready on a Ready pull request the gate reads not ready takes Ready off and answers Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.deny).toBeUndefined()
  expect(out.isError).toBeUndefined()
  expect(out.result).toStartWith('github: acme/thing#12 carries Not Ready at 0123456, Ready not put: not ready. Missing: review')
  expect(seen.runs.filter((r) => r.command === 'pr-readiness').every((r) => r.args?.['state'] === 'not-ready')).toBe(true)
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('pr-readiness ready whose CI is not green answers with CI named, no error', async ($, on) => {
  const seen = await world($, on, { ci: { result: 'PENDING', running: 1 } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out).toEqual({ result: 'github: acme/thing#12 carries Not Ready at 0123456, Ready not put: not ready. Missing: CI still running.' })
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('pr-readiness ready on a pull request the gate reads ready puts Ready', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.deny).toBeUndefined()
  expect(commands(seen)).toContain('pr-readiness')
  expect(seen.pull?.labels).toEqual(['Ready'])
})

test('pr-readiness ready whose gate cannot be read answers it unverified, no error', async ($, on) => {
  const seen = await world($, on, { gateFails: 'error: rate limited' })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out).toEqual({ result: 'github: acme/thing#12, Ready not put: readiness unverified: error: rate limited' })
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('pr-readiness ready refused by a permission rule stays refused: only the gate\'s verdict is an answer', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, verdict: { decision: 'deny', reason: 'no labels here' } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out).toEqual({ deny: 'no labels here' })
  expect(gates(seen)).toBe(0)
})

/*
 * One readiness contract: pr-readiness ready, pr-ready and pr-merge read the same head through the
 * same function, so where one is held the others are, for the same missing conditions. On
 * claude-plugins at one head, pr-readiness ready put Ready while pr-ready and pr-merge refused it.
 * A record absent at the head is the one difference: the label is not put, the acts go through.
 */
for (const [label, w, missing] of [
  ['a failed review', REVIEW_FAILED, 'Missing: ' + REVIEW_FAILED_ITEM + '.'],
  // A check that passed beside them: no CI undraft, which pr-ready may run on a pull request none of whose checks passed.
  ['CI still running', { ci: { result: 'PENDING', running: 1, total: 2 } }, 'Missing: CI still running.'],
  ['CI failed', { ci: { result: 'FAILURE', failed: ['lint'], total: 2 } }, 'Missing: CI failed: lint.'],
] as const) {
  test('pr-readiness ready, pr-ready and pr-merge hold the same head for the same reason: ' + label, async ($, on) => {
    await world($, on, { ...w, autoMerge: ['acme/thing'] })
    const answer = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
    expect(answer.result).toEndWith('Ready not put: not ready. ' + missing)
    for (const command of ['pr-ready', 'pr-merge']) {
      const out = await $.tool.call(gh(command, { pr: 12 }))
      expect(out.deny).toBe('github: ' + command + ' refused on acme/thing#12 at 0123456: not ready. ' + missing + REFUSAL_END)
    }
  })
}

test('pr-readiness not-ready is let through with the gate unread', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'not-ready' }))
  expect(out.deny).toBeUndefined()
  expect(commands(seen)).toEqual(['pr-readiness'])
  expect(gates(seen)).toBe(0)
})

test('in auto-merge a merge whose records are only absent goes through, Ready never put', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(seen.journal).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-merge'])
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('in auto-merge a merge whose review failed at the head is refused before anyone is asked, nothing run', async ($, on) => {
  const seen = await world($, on, { ...REVIEW_FAILED, autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: ' + REVIEW_FAILED_ITEM + '.' + REFUSAL_END)
  expect(seen.asked.length).toBe(0)
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('in auto-merge a merge with a record absent and CI failed is refused, both named, nothing observed', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] }, verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at'
    + ' 0123456, e2e: no record at 0123456, CI failed: lint.' + REFUSAL_END)
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a merge of a pull request carrying Ready whose records are absent goes through, Ready taken off', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'], autoMerge: ['acme/thing'] })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.journal).toEqual([])
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

/*
 * These merges ran when CI was left to GitHub alone. The gate now reads CI at the head: a merge
 * whose CI failed or still runs is refused, CI named.
 */
for (const [state, ci, item] of [['failed', { result: 'FAILURE', failed: ['lint'] }, 'CI failed: lint'], ['still runs', { result: 'PENDING', running: 1 }, 'CI still running']] as const) {
  test('in auto-merge a merge whose CI ' + state + ' is refused: Ready needs CI green', async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'], ci, verdict: { decision: 'ask' } })
    const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
    expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: ' + item + '.' + REFUSAL_END)
    expect(seen.asked.length).toBe(0)
    expect(commands(seen)).toEqual(['pr-gate'])
  })
}

test('in auto-merge a ready merge runs with no question, the gate putting Ready on it first', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked.length).toBe(0)
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness', 'pr-merge'])
  expect(seen.runs.find((r) => r.command === 'pr-readiness')?.args).toEqual({ pr: 12, state: 'ready' })
})

// No route merges a pull request whose CI is not green or whose record failed: the Ready label lands
// before the merge runs, or the merge is refused and the pull request keeps Not Ready. A pull request
// that misses only records absent at its head is merged without the label.
const MERGE_ACTS = [
  ['tool', gh('pr-merge', { pr: 12 })],
  ['Bash', bash('gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD)],
] as const

for (const [route, call] of MERGE_ACTS) {
  for (const [label, w] of [
    ['a failed review', REVIEW_FAILED],
    ['CI failed', { ci: { result: 'FAILURE', failed: ['lint'] } }],
    ['CI still running', { ci: { result: 'PENDING', running: 1 } }],
  ] as const) {
    test('a ' + route + ' merge in auto-merge never runs without Ready: ' + label + ' refuses it and Not Ready stays', async ($, on) => {
      const seen = await world($, on, { ...w, autoMerge: ['acme/thing'] })
      const out = await $.tool.call(call)
      expect(out.deny).toContain('not ready')
      expect(actRan(seen, route, 'pr-merge')).toBe(0)
      expect(seen.pull?.labels).toEqual(['Not Ready'])
    })
  }

  test('a ' + route + ' merge in auto-merge with no record at the head runs, and Not Ready stays', async ($, on) => {
    const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
    const out = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
    expect(actRan(seen, route, 'pr-merge')).toBe(1)
    expect(seen.journal).toEqual([])
    expect(seen.pull?.labels).toEqual(['Not Ready'])
  })

  test('a ' + route + ' merge in auto-merge of a ready pull request runs once the gate put Ready', async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'] })
    const out = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
    expect(actRan(seen, route, 'pr-merge')).toBe(1)
    expect(seen.pull?.labels).toEqual(['Ready'])
  })
}

test('a merge pinned to a head that moved is refused', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing'] })
  const out = await $.tool.call(gh('pr-merge', { pr: 12, sha: MOVED }))
  expect(out.deny).toContain('the head moved: ' + MOVED + ' given, ' + HEAD + ' on GitHub')
})

test('a merge pinned by a short prefix of the head runs, pinned to the full head; a wrong prefix is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out = await $.tool.call(gh('pr-merge', { pr: 12, sha: HEAD.slice(0, 7) }))
  expect(out.deny).toBeUndefined()
  expect(seen.runs.find((r) => r.command === 'pr-merge')?.args?.['sha']).toBe(HEAD)
  const wrong = await $.tool.call(gh('pr-merge', { pr: 12, sha: MOVED.slice(0, 7) }))
  expect(wrong.deny).toContain('the head moved: ' + MOVED.slice(0, 7) + ' given, ' + HEAD + ' on GitHub')
})

// A push between the gate's read and the merge must not merge a head nobody checked.
test('a tool merge with no sha is pinned to the head the gate checked', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBeUndefined()
  expect(seen.runs.find((r) => r.command === 'pr-merge')?.args?.['sha']).toBe(HEAD)
})

for (const [command, flag] of [
  ['gh pr merge 12 -R acme/thing --squash', '--match-head-commit '],
  ['python3 /plugins/github/engine/gh.py pr-merge 12 --repo acme/thing', '--sha '],
  ['gh api -X PUT repos/acme/thing/pulls/12/merge', '-f sha='],
] as const) {
  test('a ready Bash merge pinning no head is refused with the flag that pins the gated one: ' + flag.trim(), async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'] })
    const out = await $.tool.call(bash(command))
    expect(out.deny).toContain('refused on acme/thing#12: pin the head the gate checked, ' + flag + HEAD + '.')
    expect(seen.bash).toEqual([])
  })
}

for (const [command, flag] of [
  ['gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD.slice(0, 7), '--match-head-commit '],
  ['python3 /plugins/github/engine/gh.py pr-merge 12 --repo acme/thing --sha ' + HEAD.slice(0, 7), '--sha '],
  ['gh api -X PUT repos/acme/thing/pulls/12/merge -f sha=' + HEAD.slice(0, 7), '-f sha='],
] as const) {
  test('a Bash merge pinned by a prefix of the head is refused with the full head to pin: ' + flag.trim(), async ($, on) => {
    const seen = await world($, on, { autoMerge: ['acme/thing'] })
    const out = await $.tool.call(bash(command))
    expect(out.deny).toContain('refused on acme/thing#12: pin the head the gate checked, ' + flag + HEAD + '.')
    expect(seen.bash).toEqual([])
  })
}

test('a Bash merge through gh api pinned to a head that moved is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out = await $.tool.call(bash('gh api -X PUT repos/acme/thing/pulls/12/merge -f sha=' + MOVED))
  expect(out.deny).toContain('the head moved: ' + MOVED + ' given, ' + HEAD + ' on GitHub')
  expect(seen.bash).toEqual([])
})


for (const [where, autoMerge] of [['outside auto-merge', []], ['in auto-merge', ['acme/thing']]] as const) {
  test('a pull request opened out of draft goes through ' + where + ', a draft too', async ($, on) => {
    const seen = await world($, on, { autoMerge: [...autoMerge] })
    const out = await $.tool.call(gh('pr-create', { title: 'fix: x', draft: false }))
    expect(out).toEqual({ result: 'ok' })
    expect(seen.journal).toEqual([])
    expect(seen.asked.length).toBe(0)
    const draft = await $.tool.call(gh('pr-create', { title: 'fix: x' }))
    expect(draft).toEqual({ result: 'ok' })
    expect(seen.journal).toEqual([])
  })
}

test('an unreadable readiness refuses with the engine error', async ($, on) => {
  await world($, on, { gateFails: 'error: rate limited' })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: rate limited')
})

test('a deny rule still refuses first, and the guard reads nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'deny', reason: 'denied by rule', rule: 'mcp__github__gh' } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
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
    const out = await $.tool.call(call)
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
  const out = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(out.deny).toContain('github: gh pr merge refused on acme/thing: this repository is not in auto-merge')
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})


test('a Bash undraft outside auto-merge whose guard throws is refused as an unverified readiness', async ($, on) => {
  const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: ['acme/other'] })
  const out = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(String(out.deny)).toStartWith('github: readiness of acme/thing#12 unverified: ')
  expect(seen.bash.length).toBe(0)
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(seen.logs).toEqual([])
})


for (const [where, autoMerge] of [['outside auto-merge', 'acme/other'], ['in auto-merge', 'acme/thing']] as const) {
  test('a Bash pull request opened out of draft ' + where + ' goes through, whatever the readiness read gives', async ($, on) => {
    const seen = await world($, on, { gate: BROKEN_GATE, autoMerge: [autoMerge] })
    const line = 'gh pr create -R acme/thing -t "fix: x" -b ' + BODY_OK
    const out = await $.tool.call(bash(line))
    expect(out.deny).toBeUndefined()
    expect(seen.bash).toEqual([line])
    expect(seen.journal).toEqual([])
    expect(commands(seen)).toEqual([])
  })
}

// ---- leaving draft for CI ----

test('a Not Ready pull request whose CI is not green leaves draft through the tool, still Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
})

test('a CI undraft through the tool passes outside auto-merge too, with no question', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, verdict: { decision: 'ask' }, answer: 'Deny', ci: { result: 'PENDING', skipped: ['test'] } })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12, 'for-ci': true })
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
  expect(seen.journal).toEqual([])
})


test('an undraft outside auto-merge that is no CI undraft goes through when ready, never asked', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], answer: 'Allow' })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toHaveLength(0)
  expect(seen.journal).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
})

test('an undraft outside auto-merge of a pull request not ready is still refused by the gate', async ($, on) => {
  const seen = await world($, on, { ...REVIEW_FAILED })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toContain('github: pr-ready refused on acme/thing#12 at 0123456: not ready.')
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(commands(seen)).toEqual(['pr-gate'])
})

test('a Bash CI undraft passes outside auto-merge too, with one line', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'FAILURE', failed: ['test'] } })
  const out = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing'])
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
  expect(seen.journal).toEqual([])
})

test('going back to draft is always let through and moves no label', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'] })
  const out = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo'))
  expect(out.deny).toBeUndefined()
  expect(seen.runs.map((r) => r.command)).toEqual([])
  const tool = await $.tool.call(gh('pr-draft', { pr: 12 }))
  expect(tool).toEqual({ result: 'ok' })
  expect(gates(seen)).toBe(0)
})

test('going back to draft through the tool is not asked outside auto-merge', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Deny' })
  const out = await $.tool.call(gh('pr-draft', { pr: 12 }, 'acme/other'))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-draft'])
})

test('a pull request that carries Ready, or whose CI is green, is no CI undraft', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'] })
  const green = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(green).toEqual({ result: 'ok' })
  expect(seen.runs.find((r) => r.command === 'pr-ready')?.args).toEqual({ pr: 12 })
  expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
  expect(seen.journal).toEqual([])
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
    const out = await $.tool.call(call)
    expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
    expect(out.deny).toContain('not ready. Missing: CI still running')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.pull?.labels).toEqual(['Not Ready'])
  })

  test('a ' + route + ' undraft of a pull request carrying Ready with no review and CI not green is refused, never a CI undraft', async ($, on) => {
    const seen = await world($, on, { ...NO_RECORDS, labels: ['Ready'], autoMerge: ['acme/thing'], ci: { result: 'PENDING', running: 1 } })
    const out = await $.tool.call(call)
    expect(out.deny).toContain('refused on acme/thing#12 at 0123456: not ready. Missing: review: no record at 0123456, e2e: no record at 0123456, CI still running')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.journal).toEqual(['github.ready.held'])
    expect(seen.pull?.labels).toEqual(['Not Ready'])
  })

  test('a ' + route + ' undraft in auto-merge with no record at the head and CI green runs', async ($, on) => {
    const seen = await world($, on, { ...NO_RECORDS, labels: [], autoMerge: ['acme/thing'] })
    const out = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
    expect(actRan(seen, route, 'pr-ready')).toBe(1)
    expect(seen.journal).toEqual([])
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
  ] satisfies Array<[string, World, string]>) {
    test('a ' + route + ' ' + command + ' in auto-merge is refused, nothing run, when ' + label, async ($, on) => {
      const seen = await world($, on, { ...w, autoMerge: ['acme/thing'] })
      const out = await $.tool.call(call)
      expect(out.deny).toContain('github: readiness of acme/thing#12 unverified: ')
      expect(out.deny).toContain(error)
      expect(actRan(seen, route, command)).toBe(0)
      expect(seen.asked.length).toBe(0)
      expect(seen.pull?.labels).toEqual(['Not Ready'])
    })
  }
}


// ---- Bash ----


test('a Bash merge outside auto-merge is refused with the tool call to make, an undraft goes on to the gate', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const merge = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(merge.deny).toBe('github: gh pr merge refused on acme/thing: this repository is not in auto-merge, so a merge'
    + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": 12}'
    + ' on acme/thing: it checks that the pull request is ready, then asks them in the conversation.')
  const api = await $.tool.call(bash('gh api -X PUT repos/acme/thing/pulls/12/merge'))
  expect(api.deny).toContain('not in auto-merge')
  expect(seen.bash).toEqual([])
  expect(seen.journal).toEqual(['github.ready.held', 'github.ready.held'])
  const ready = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(ready.deny).toBeUndefined()
  expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing'])
  expect(seen.journal).toEqual(['github.ready.held', 'github.ready.held'])
})

test('a Bash merge without a repository is refused, so is a GraphQL merge', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const out = await $.tool.call(bash('gh pr merge 12 --squash'))
  expect(out.deny).toBe('github: gh pr merge refused: name the repository with -R owner/name.')
  const graphql = await $.tool.call(bash('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
  expect(graphql.deny).toContain('github: gh api graphql refused')
  expect(seen.bash).toEqual([])
})

test('a ready Bash merge in auto-merge passes', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'] })
  const out = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash --match-head-commit ' + HEAD))
  expect(out.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
  expect(seen.logs).toEqual([])
})

// This merge ran when CI was left to GitHub alone: Ready now needs CI green, so it is refused.
test('a Bash merge in auto-merge whose CI failed is refused: Ready needs CI green', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] } })
  const out = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(out.deny).toBe('github: gh pr merge refused on acme/thing#12 at 0123456: not ready. Missing: CI failed: lint.' + REFUSAL_END)
  expect(seen.bash.length).toBe(0)
})

test('a not-ready Bash merge in auto-merge is refused, --auto too', async ($, on) => {
  const seen = await world($, on, { ...REVIEW_FAILED, autoMerge: ['acme/thing'] })
  const refused = await $.tool.call(bash('gh pr merge 12 -R acme/thing --squash'))
  expect(refused.deny).toBe('github: gh pr merge refused on acme/thing#12 at 0123456: not ready. Missing: ' + REVIEW_FAILED_ITEM + '.' + REFUSAL_END)
  const auto = await $.tool.call(bash('gh pr merge 12 -R acme/thing --auto'))
  expect(auto.deny).toContain('github: gh pr merge refused on acme/thing#12 at 0123456: not ready.')
  expect(seen.bash.length).toBe(0)
})

test('a not-ready Bash undraft in auto-merge, out of CI undraft, is refused', async ($, on) => {
  const seen = await world($, on, { ...REVIEW_FAILED, autoMerge: ['acme/thing'], labels: [] })
  const out = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(out.deny).toContain('not ready')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge whose readiness cannot be read is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], gateFails: 'error: boom' })
  const out = await $.tool.call(bash('gh pr merge 12 -R acme/thing'))
  expect(out.deny).toBe('github: readiness of acme/thing#12 unverified: error: boom')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge of the current branch\'s pull request reads it with pr-get', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'], pulls: { '': [{ number: 12 }] } })
  await $.tool.call(bash('gh pr merge -R acme/thing'))
  expect(commands(seen)).toEqual(['pr-get', 'pr-gate'])
  expect(seen.runs[0]?.repo).toBe('acme/thing')
  expect(seen.runs[1]?.args).toEqual({ pr: 12 })
})


test('a Bash pull request opened out of draft goes through outside auto-merge', async ($, on) => {
  const seen = await world($, on)
  const line = 'gh pr create -R acme/thing -t "fix: x" -b ' + BODY_OK
  const out = await $.tool.call(bash(line))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual([line])
  expect(seen.journal).toEqual([])
})


test('a Bash gh pr create --draft=false goes through outside auto-merge, like one with no --draft', async ($, on) => {
  const seen = await world($, on)
  const body = '"Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'
  for (const flag of ['--draft=false', '--draft=0']) {
    const out = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toBeUndefined()
  }
  expect(seen.bash.length).toBe(2)
  expect(seen.journal).toEqual([])
  for (const flag of ['--draft=true', '--draft']) {
    const out = await $.tool.call(bash('gh pr create -R acme/thing ' + flag + ' -t "fix: x" -b ' + body))
    expect(out.deny, flag).toBeUndefined()
  }
  expect(seen.journal).toEqual([])
})


test('a Bash pull request opened out of draft goes through in auto-merge too', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const line = 'gh pr create -R acme/thing -t "fix: x" -b ' + BODY_OK
  const out = await $.tool.call(bash(line))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual([line])
  expect(seen.journal).toEqual([])
})


test('a Bash pull request opened out of draft with no repository named goes through', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const line = 'gh pr create -t "fix: x" -b ' + BODY_OK
  const out = await $.tool.call(bash(line))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual([line])
  expect(seen.journal).toEqual([])
})

// The engine run through Bash, as the github-curl skill runs it.
const ENGINE = 'python3 /plugins/github/engine/gh.py'

test('a Bash merge through gh.py is refused outside auto-merge, as gh pr merge is', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(bash(ENGINE + ' pr-merge 12 --repo acme/thing --method squash'))
  expect(out.deny).toBe('github: gh.py pr-merge refused on acme/thing: this repository is not in auto-merge, so a merge'
    + ' needs the operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": 12} on'
    + ' acme/thing: it checks that the pull request is ready, then asks them in the conversation.')
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge through gh.py in auto-merge meets the ready guard', async ($, on) => {
  const seen = await world($, on, { ...REVIEW_FAILED, autoMerge: ['acme/thing'] })
  for (const command of [ENGINE + ' --repo=acme/thing pr-merge 12', '/plugins/github/engine/gh.py pr-merge 12 --repo acme/thing']) {
    const out = await $.tool.call(bash(command))
    expect(out.deny, command).toContain('github: gh.py pr-merge refused on acme/thing#12 at 0123456: not ready.')
  }
  expect(seen.bash.length).toBe(0)
})

test('a Bash merge or undraft through gh.py with no --repo is refused', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  for (const command of [ENGINE + ' pr-merge 12', ENGINE + ' pr-ready 12']) {
    const out = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh.py ' + command.split(' ')[2] + ' refused: name the repository with --repo owner/name.')
  }
  expect(seen.bash.length).toBe(0)
})



test('a Bash undraft through gh.py passes for CI with --for-ci, any other meets the gate', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, ci: { result: 'PENDING', skipped: ['test'] } })
  const forCi = await $.tool.call(bash(ENGINE + ' pr-ready 12 --for-ci --repo acme/thing'))
  expect(forCi.deny).toBeUndefined()
  expect(seen.logs).toEqual(['github: acme/thing#12 out of draft to run CI, still Not Ready'])
  const ready = await $.tool.call(bash(ENGINE + ' pr-ready 12 --repo acme/thing'))
  expect(ready.deny).toContain('github: gh.py pr-ready refused on acme/thing#12 at 0123456: not ready.')
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(seen.bash.length).toBe(1)
})

test('a Bash pr-create through gh.py without --draft goes through outside auto-merge, with --draft too', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(bash(ENGINE + ' pr-create --repo acme/thing --title "fix: x"'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash.length).toBe(1)
  expect(seen.journal).toEqual([])
  const draft = await $.tool.call(bash(ENGINE + ' pr-create --repo acme/thing --title "fix: x" --draft'))
  expect(draft.deny).toBeUndefined()
  expect(seen.bash.length).toBe(2)
  expect(seen.journal).toEqual([])
})

test('a Bash merge through gh.py with a global --repo or python -W before the script is read as a merge', async ($, on) => {
  const seen = await world($, on)
  for (const command of [
    'python3 "$GH" --repo acme/thing pr-merge 12',
    'python3 "$GH" -R acme/thing pr-merge 12',
    'python3 -W ignore /plugins/github/engine/gh.py pr-merge 12 --repo acme/thing',
  ]) {
    const out = await $.tool.call(bash(command))
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
    const out = await $.tool.call(bash(command))
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
    const out = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: gh api refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
  }
  for (const command of [
    'gh pr merge $(gh pr list -q .[0].number) -R acme/thing',
    'gh pr merge `gh pr list -q .[0].number` -R acme/thing',
    'gh pr ready $(gh pr list -q .[0].number) -R acme/thing',
  ]) {
    const out = await $.tool.call(bash(command))
    expect(out.deny, command).toBe('github: ' + command.split(' ').slice(0, 3).join(' ') + ' refused: the pull request number cannot be read from the command.'
      + ' Write it as a number, or run the tool\'s mcp__github__gh call with {"pr": <n>}.')
  }
  expect(seen.bash.length).toBe(0)
  expect(commands(seen)).toEqual([])
})

test('a Bash undraft through gh.py for CI passes in auto-merge too, still Not Ready', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS, autoMerge: ['acme/thing'], ci: { result: 'PENDING', skipped: ['test'] } })
  const out = await $.tool.call(bash(ENGINE + ' pr-ready 12 --for-ci --repo acme/thing'))
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
    const out = await $.tool.call(bash(line))
    expect(out.deny, line).toBeUndefined()
  }
  expect(seen.runs).toEqual([])
})

test('gh.py reads that act on nothing pass the ready guard unread, a --stdin-json request from Bash is refused', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(bash(ENGINE + ' pr-get --format pr-number'))
  await $.tool.call(bash(ENGINE + ' pr-readiness 12 not-ready --repo acme/thing'))
  const stdin = await $.tool.call(bash('printf %s \'{"command":"pr-merge","args":{"pr":12}}\' | ' + ENGINE + ' --stdin-json'))
  expect(stdin.deny).toBe(STDIN_REFUSAL)
  expect(seen.bash.length).toBe(2)
  expect(commands(seen)).toEqual([])
})

test('a --stdin-json request from Bash is refused in auto-merge too', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'] })
  const line = 'python3 ' + ROOT + '/engine/gh.py --stdin-json < request.json'
  expect(((await $.tool.call(bash(line)))).deny).toBe(STDIN_REFUSAL)
  expect(seen.bash).toEqual([])
})

test('a Bash draft opened gets Not Ready from the URL gh printed', async ($, on) => {
  const seen = await world($, on, { bashResult: { result: { stdout: 'https://github.com/acme/thing/pull/31\n', stderr: '', interrupted: false } } })
  await $.tool.call(bash('gh pr create --draft -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(seen.runs.map((r) => [r.command, r.repo, r.args])).toEqual([['pr-readiness', 'acme/thing', { pr: 31, state: 'not-ready' }]])
})

test('a Bash pull request opened out of draft gets Not Ready from the URL gh printed', async ($, on) => {
  const seen = await world($, on, { bashResult: { result: { stdout: 'https://github.com/acme/thing/pull/31\n', stderr: '', interrupted: false } } })
  const out = await $.tool.call(bash('gh pr create -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(out.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  expect(seen.runs.map((r) => [r.command, r.repo, r.args])).toEqual([['pr-readiness', 'acme/thing', { pr: 31, state: 'not-ready' }]])
})

for (const [name, labels, line] of [
  ['an opening out of draft', ['Not Ready'], 'gh pr create -t "fix: x" -b "Adds the reset." && gh pr merge 12 -R acme/thing'],
  ['a pull request left out of draft', ['Ready'], 'gh pr ready 12 -R acme/thing && gh pr merge 12 -R acme/thing'],
] as const) {
  test('a Bash line whose first act is observed and whose second is refused leaves no line: ' + name, async ($, on) => {
    const seen = await world($, on, { labels: [...labels] })
    const out = await $.tool.call(bash('echo {} > /data/e2e-exempt/acme/thing.json && ' + line))
    expect(out.deny).toContain('refused')
    expect(seen.journal).toEqual(['github.ready.held'])
    expect(seen.bash).toEqual([])
  })
}

test('a call a later check refuses leaves no observation: the journal is written just before the command runs', async ($, on) => {
  const seen = await world($, on, { ...NO_RECORDS })
  const out = await $.tool.call(bash('echo {} > /data/e2e-exempt/acme/thing.json && gh pr merge 12 -R acme/thing'))
  expect(out.deny).toContain('refused')
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(seen.bash).toEqual([])
})

test('commands that only look like an act pass with nothing read', async ($, on) => {
  const seen = await world($, on)
  for (const line of ['gh pr merge 12 -R acme/thing --disable-auto', 'git commit -m "run gh pr merge later"', 'gh pr view 12']) {
    const out = await $.tool.call(bash(line))
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


test('the records are written through Write, Edit and Bash with nothing journaled, as a Read of one is', async ($, on) => {
  const seen = await world($, on)
  const calls = [
    { tool: 'Write', file_path: RECORDS + '/acme/thing/' + HEAD + '/e2e.x.json', content: '{}' },
    { tool: 'Edit', file_path: '/home/x/.claude/pr-records/o/r/x.json', old_string: 'a', new_string: 'b' },
    { tool: 'NotebookEdit', notebook_path: RECORDS + '/acme/thing/' + HEAD + '/review.x.ipynb', new_source: 'x' },
    { tool: 'MultiEdit', file_path: RECORDS + '/o/r/x.json', edits: [] },
    bash('echo x > ~/.claude/pr-records/o/r/x.json'),
    bash('python3 ' + ROOT + '/engine/record.py --repo o/r --pr 1'),
  ]
  for (const call of calls) {
    const out = await $.tool.call(call)
    expect(out.deny, JSON.stringify(call)).toBeUndefined()
  }
  expect(seen.journal).toEqual([])
  const read = await $.tool.call({ tool: 'Read', file_path: HEAD_DIR + '/e2e.x.json' })
  expect(read.deny).toBeUndefined()
  const other = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' })
  expect(other.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  expect(seen.bash).toEqual(calls.slice(4).map((call) => fieldsOf(call)?.['command']))
})


test('the event a guard journals is core\'s refusal event under the guard\'s code, with no command in it', async ($, on) => {
  const seen = await world($, on)
  const command = 'rm ~/.claude/pr-records/secret-name'
  await $.tool.call(bash(command))
  expect(seen.events.length).toBe(1)
  const event = parseLearningEvent(JSON.parse(String(seen.events[0])))
  expect(event?.kind).toBe('refusal')
  expect(event?.source).toEqual({ plugin: 'github', code: 'github.records.delete' })
  expect(event?.evidence).toEqual([{ type: 'refusal', code: 'github.records.delete' }])
  expect(seen.events[0]).not.toContain('secret-name')
})

test('a command that only mentions the records in its text passes, a write to them passes unjournaled, a deletion in them is refused', async ($, on) => {
  const seen = await world($, on)
  const commit = await $.tool.call(bash('git commit -m "docs: mention pr-records in the README"'))
  expect(commit.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  const touch = await $.tool.call(bash('touch ~/.claude/pr-records/x'))
  expect(touch.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  const rm = await $.tool.call(bash('rm ~/.claude/pr-records/x'))
  expect(rm.deny).toBe(RECORDS_REFUSAL)
  expect(seen.journal).toEqual(['github.records.delete'])
  expect(seen.bash).toEqual(['git commit -m "docs: mention pr-records in the README"', 'touch ~/.claude/pr-records/x'])
})

test('a journal that cannot be written leaves each decision standing: the deletion refused, the write let through, one log line for the deletion', async ($, on) => {
  const seen = await world($, on, { journalFails: 'ENOSPC: no space left on device' })
  const rm = await $.tool.call(bash('rm ~/.claude/pr-records/x'))
  expect(rm.deny).toBe(RECORDS_REFUSAL)
  const touch = await $.tool.call(bash('touch ~/.claude/pr-records/x'))
  expect(touch.deny).toBeUndefined()
  expect(seen.bash).toEqual(['touch ~/.claude/pr-records/x'])
  expect(seen.journal).toEqual([])
  const lines = seen.logs.filter((line) => line.includes('ENOSPC'))
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('github.records.delete')
})

const RECORDS_READS = [
  'ls ~/.claude/pr-records',
  'ls /Users/lounis/.claude/pr-records/lounisbou/claude-plugins/' + HEAD + '/',
  'cat ~/.claude/pr-records/o/r/' + HEAD + '/e2e.x.json',
  'head -n 5 ~/.claude/pr-records/o/r/x.json',
  'tail -f ~/.claude/pr-records/o/r/x.json',
  'grep -rn pass ~/.claude/pr-records/o/r',
  'find ~/.claude/pr-records -name "e2e.*" -newer /tmp/x',
  'stat ~/.claude/pr-records/o/r/x.json',
  'wc -l ~/.claude/pr-records/o/r/x.json',
  'jq .result ~/.claude/pr-records/o/r/x.json',
  'cat ~/.claude/pr-records/o/r/x.json | jq . | wc -l',
  'cat ' + RECORDS + '/o/r/x.json',
]

for (const command of RECORDS_READS) {
  test('a Bash command that only reads the records passes: ' + command.slice(0, 40), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toBeUndefined()
    expect(seen.journal).toEqual([])
    expect(seen.bash).toEqual([command])
  })
}

// A read that waits, loops or silences its errors is still a read: nothing is journaled.
const RECORDS_QUIET_READS = [
  'ls ~/.claude/pr-records/o/r/' + HEAD + ' 2>/dev/null',
  'cat ~/.claude/pr-records/o/r/x.json 2>&1 | jq .result',
  'until ls ~/.claude/pr-records/o/r/' + HEAD + '/e2e.json; do sleep 2; done',
  'for f in ~/.claude/pr-records/o/r/*; do cat $f; done',
  'sleep 5; ls ~/.claude/pr-records/o/r',
]

for (const command of RECORDS_QUIET_READS) {
  test('a Bash command that only reads the records, waiting or silencing its errors, raises no event: ' + command.slice(0, 40), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toBeUndefined()
    expect(seen.journal).toEqual([])
    expect(seen.bash).toEqual([command])
  })
}

const RECORDS_WRITES = [
  'echo x > ~/.claude/pr-records/o/r/x.json',
  'echo x >> ~/.claude/pr-records/o/r/x.json',
  'cat ~/.claude/pr-records/o/r/x.json > /tmp/copy',
  'cat /tmp/x | tee ~/.claude/pr-records/o/r/x.json',
  'sed -i s/fail/pass/ ~/.claude/pr-records/o/r/x.json',
  'cp /tmp/x.json ~/.claude/pr-records/o/r/x.json',
  'mv /tmp/x.json ~/.claude/pr-records/o/r/x.json',
  'touch ~/.claude/pr-records/o/r/x.json',
  'ls ~/.claude/pr-records; python3 -c "open(1)"',
  'ls ~/.claude/pr-records/o/r >&~/.claude/pr-records/o/r/x.json',
  'ls ~/.claude/pr-records/o/r 1>&~/.claude/pr-records/o/r/x.json',
  'echo "$(echo x > ~/.claude/pr-records/o/r/x.json)"',
  'echo "`echo x > ~/.claude/pr-records/o/r/x.json`"',
  "echo $'a\\'' > ~/.claude/pr-records/o/r/x.json",
  'cd ~/.claude/pr-records',
  '/tmp/x/cat ~/.claude/pr-records/o/r/x.json',
  './ls ~/.claude/pr-records/o/r',
  'python3 ' + ROOT + '/engine/record.py --repo o/r --pr 1',
  'cat ~/.claude/pr-records/o/r/x.json && python3 ' + ROOT + '/engine/record.py --repo o/r --pr 1',
]

// Deleting is irreversible: a deletion in the records keeps its refusal, as on main.
const RECORDS_DELETIONS = [
  'rm ~/.claude/pr-records/o/r/x.json',
  'rm -rf ' + RECORDS + '/o',
  'find ~/.claude/pr-records -name "*.json" -delete',
  'find ~/.claude/pr-records -name "*.json" -exec rm {} +',
  'ls ~/.claude/pr-records/o/r | xargs rm',
  'cd ~/.claude/pr-records/o/r && rm x.json',
  'bash -c "rm ~/.claude/pr-records/o/r/x.json"',
  '/bin/rm ~/.claude/pr-records/o/r/x.json',
  'rm ~/.claude/pr-records/o/r/x.json $(',
  'git -C ~/.claude/pr-records clean -fdx',
  'git -c core.x=y clean -fdx ~/.claude/pr-records/o',
  'git --git-dir=/tmp/g rm -r ~/.claude/pr-records/o',
  'rsync -a --delete-after /tmp/empty/ ~/.claude/pr-records/',
  'rsync -a --del /tmp/empty/ ~/.claude/pr-records/',
  'tar --remove-files -cf /tmp/a.tar ~/.claude/pr-records/o',
  'rm${IFS}~/.claude/pr-records/o/r/x.json',
  'mv -t /tmp ~/.claude/pr-records/o/r/x.json',
  'find ~/.claude/pr-records -name "*.json" -exec mv {} /tmp \\;',
  'ls ~/.claude/pr-records/o/r | xargs mv -t /tmp',
  'python3 -c "from pathlib import Path; Path(\'/home/x/.claude/pr-records/o/r/x.json\').unlink()"',
  'ls {1..9}{1..9}{1..9}{1..9}; rm ~/.claude/pr-records/o/r/x.json',
  'r""m ~/.claude/pr-records/o/r/x.json',
  'unlink ~/.claude/pr-records/o/r/x.json',
  'mv ~/.claude/pr-records/o/r/x.json /tmp/x.json',
  'python3 -c "import os; os.remove(\'/home/x/.claude/pr-records/o/r/x.json\')"',
]

for (const command of RECORDS_DELETIONS) {
  test('a Bash command that deletes in the records stays refused: ' + command.slice(0, 40), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toBe(RECORDS_REFUSAL)
    expect(seen.journal).toEqual(['github.records.delete'])
    expect(seen.bash).toEqual([])
  })
}

for (const command of RECORDS_WRITES) {
  test('a Bash command that writes into the records goes through, nothing journaled: ' + command.slice(0, 40), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toBeUndefined()
    expect(seen.journal).toEqual([])
    expect(seen.bash).toEqual([command])
  })
}

const LIST = '~/.claude/plugins/data/github-lounisbou/auto-merge.json'

test('a Bash command that only reads the auto-merge list passes', async ($, on) => {
  const seen = await world($, on)
  const read = await $.tool.call(bash('cat ' + LIST))
  expect(read.deny).toBeUndefined()
  expect(seen.bash).toEqual(['cat ' + LIST])
})

for (const command of [
  'sed -i s/a/b/ ' + LIST,
  'cat ' + LIST + ' > /tmp/copy',
  'ls ' + LIST + ' >&' + LIST,
  'ls ' + LIST + ' 1>&' + LIST,
  'echo "$(echo x > ' + LIST + ')"',
  'echo "`echo x > ' + LIST + '`"',
  "echo $'a\\'' > " + LIST,
  'cd ~/.claude/plugins/data/github-lounisbou && cat auto-merge.json',
  '/tmp/x/cat ' + LIST,
  './ls ' + LIST,
]) {
  test('a Bash command that writes the auto-merge list stays refused: ' + command.slice(0, 40), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toContain('auto-merge-set')
    expect(seen.bash).toEqual([])
  })
}

// ---- the record tool ----

const CLEAN = {
  'rev-parse HEAD': { exitCode: 0, stdout: HEAD + '\n' },
  'status --porcelain -uno': { exitCode: 0, stdout: '' },
}

const recordRun = (seen: Seen) => seen.runs.find((r) => String(r.argv[1]).endsWith('/engine/record.py'))?.argv.slice(2)

test('the model records its E2E at the pull request\'s head from a clean checkout', async ($, on) => {
  // Already Ready: the record's answer is its path alone (the gate's line has its own tests).
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'] })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, detail: 'ran the smoke suite' })
  expect(out.result).toBe(HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json')
  const argv = recordRun(seen)!
  expect(argv.slice(0, 14)).toEqual(['--repo', 'acme/thing', '--pr', '12', '--head', HEAD, '--kind', 'e2e', '--result', 'pass',
    '--producer', 'session-e2e', '--detail', 'ran `npm run e2e` at 0123456: exit 0 in 0 s; ran the smoke suite'])
  expect(argv[15]).toContain('guard-session-')
})

// Program goal 8: the E2E result is computed from a run, never taken from the session's word.
// Program goal 8: the E2E result is computed from a run; one made elsewhere is still written, as stated, and observed.
test('an E2E pass or fail with no run is written as stated and observed, never refused', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', detail: 'campaign on the test box' })
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv.slice(6, 10)).toEqual(['--kind', 'e2e', '--result', 'pass'])
  expect(argv[13]).toBe('stated, not computed: campaign on the test box')
  expect(seen.journal).toEqual(['github.record.e2e-stated'])
  const none = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', detail: 'x' })
  expect(none.deny).toContain('gives "run"')
})

test('a run decides the E2E result whatever the session states', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, e2eExit: 1 })
  await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
  const argv = recordRun(seen)!
  expect(argv.slice(6, 12)).toEqual(['--kind', 'e2e', '--result', 'fail', '--producer', 'session-e2e'])
  expect(argv[13]).toBe('ran `npm run e2e` at 0123456: exit 1 in 0 s (2 scenarios failed)')
  expect(seen.journal).toEqual([])
})

test('a run Bash would ask for is not run by the record tool', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, verdict: { decision: 'ask' } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', run: E2E_RUN })
  expect(out.deny ?? out.result).toBeDefined()
  expect(recordRun(seen)).toBeUndefined()
  expect(seen.runs.some((r) => r.argv.join(' ') === E2E_RUN.join(' '))).toBe(false)
})

test('an E2E "ran" rests on a Bash run this session observed in the checkout since its head moved', async ($, on) => {
  const moved = { 'log -g -1 --date=unix --format=%gd HEAD': { exitCode: 0, stdout: 'HEAD@{1000}\n' } }
  const seen = await world($, on, { git: { ...CLEAN, ...moved } })
  const unseen = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e' })
  expect(unseen.deny).toContain('this session ran no `npm run e2e` in /work')
  await $.tool.call({ tool: 'Bash', command: 'npm run e2e' })
  await $.tool.call({ tool: 'Bash', command: 'npm run e2e:slow', run_in_background: true })
  await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e' })
  const argv = recordRun(seen)!
  expect(argv[9]).toBe('pass')
  expect(argv[13]).toContain('observed `npm run e2e` at 0123456, run by this session')
  const background = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e:slow' })
  expect(background.deny).toContain('a background run is not observed')
})

test('an E2E "ran" not seen is written as stated under the result given, and observed, not refused', async ($, on) => {
  const moved = { 'log -g -1 --date=unix --format=%gd HEAD': { exitCode: 0, stdout: 'HEAD@{1000}\n' } }
  const seen = await world($, on, { git: { ...CLEAN, ...moved } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e', result: 'fail', detail: 'ran on the test box' })
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv[9]).toBe('fail')
  expect(argv[13]).toBe('stated, not computed: `npm run e2e` at 0123456 not observed in /work; ran on the test box')
  expect(seen.journal).toEqual(['github.record.e2e-stated'])
})

test('an E2E "ran" not seen is written as a stated pass when the session says it passed', async ($, on) => {
  const moved = { 'log -g -1 --date=unix --format=%gd HEAD': { exitCode: 0, stdout: 'HEAD@{1000}\n' } }
  const seen = await world($, on, { git: { ...CLEAN, ...moved } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e', result: 'pass' })
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)![9]).toBe('pass')
  expect(recordRun(seen)![13]).toMatch(/^stated, not computed: /)
})

test('an E2E "ran" whose checkout reflog cannot be read is refused, not stated', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'log -g -1 --date=unix --format=%gd HEAD': { exitCode: 128, stdout: '' } } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e', result: 'pass' })
  expect(out.deny).toContain('cannot be read from its reflog')
  expect(recordRun(seen)).toBeUndefined()
})

test('an E2E "ran" seen is computed, not stated, whatever result the session gives', async ($, on) => {
  const moved = { 'log -g -1 --date=unix --format=%gd HEAD': { exitCode: 0, stdout: 'HEAD@{1000}\n' } }
  const seen = await world($, on, { git: { ...CLEAN, ...moved } })
  await $.tool.call({ tool: 'Bash', command: 'npm run e2e' })
  await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', ran: 'npm run e2e', result: 'fail' })
  const argv = recordRun(seen)!
  expect(argv[9]).toBe('pass')
  expect(argv[13]).toContain('observed `npm run e2e`')
  expect(seen.journal).toEqual([])
})

test('a push keeps its head on disk with the session that pushed it, for any later session to read', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feat-a' })
  const kept = seen.writes.find((w) => w.path === '/cfg/pushed-heads/' + HEAD)
  expect(kept?.text).toMatch(/^guard-session-\d+\n$/)
})

test('a record.py that fails is an error to the caller, with its message', async ($, on) => {
  await world($, on, { git: CLEAN, recordFails: { exitCode: 2, stderr: 'error: --detail is past 500 characters\n' } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, detail: 'x' })
  expect(out).toEqual({ result: 'error: --detail is past 500 characters', isError: true })
})

test('the model may not record a review or a norms check', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  for (const kind of ['review', 'norms']) {
    const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind, result: 'pass' })
    expect(out.deny).toContain('github: ' + kind + ' records are written by their producer')
    expect(out.deny).toContain('this tool writes e2e only')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('a record is refused away from the head, or on a checkout with changes', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } })
  const moved = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
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
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', run: E2E_RUN, detail: 'ran', dir: REVIEW_DIR })
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe(HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json')
  expect(recordRun(seen)!.slice(0, 6)).toEqual(['--repo', 'acme/thing', '--pr', '12', '--head', HEAD])
})

test('a checkout named away from the pull request\'s head is refused, naming both shas and the checkout', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } }, tree: CHECKOUTS })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: REVIEW_DIR })
  expect(out.deny).toContain('the checkout is at fedcba9, the pull request\'s head is 0123456')
  expect(out.deny).toContain(REVIEW_DIR)
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named with changes in its tracked files is refused, whatever the session\'s directory holds', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } }, tree: CHECKOUTS })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: REVIEW_DIR })
  expect(out.deny).toContain('the tracked files have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named by a relative path, or that is no git checkout, is refused', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { '/nowhere': {} }, tree: CHECKOUTS })
  const relative = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: 'review/thing' })
  expect(relative.deny).toContain('dir is the absolute path of the checkout the tests ran in')
  const none = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: '/nowhere' })
  expect(none.deny).toContain('/nowhere has no commit to read')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named that is no directory is refused, naming it, before any git runs there', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: '/gone/away' })
  expect(out.deny).toContain('/gone/away is not a directory')
  expect(seen.runs.filter((r) => r.argv[0] === 'git')).toEqual([])
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named that is a file, or whose stat fails for another reason, is refused with its own cause', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, tree: { '/work/file.txt': { kind: 'file', mtimeMs: 1 } } })
  const file = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: '/work/file.txt' })
  expect(file.deny).toContain('/work/file.txt is not a directory')
  expect(seen.runs.filter((r) => r.argv[0] === 'git')).toEqual([])
})

test('a stat that fails but for a missing path is reported as it failed', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, statFails: 'EACCES: permission denied' })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, dir: '/locked' })
  expect(out.deny).toContain('cannot stat dir /locked: ')
  expect(out.deny).toContain('EACCES')
  expect(out.deny).not.toContain('is not a directory')
  expect(recordRun(seen)).toBeUndefined()
})

test('a checkout named with no GitHub origin, and no repository given, is refused with that cause', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, gitIn: { [REVIEW_DIR]: { ...CLEAN, 'remote get-url origin': { exitCode: 0, stdout: '/srv/local/thing.git\n' } } }, tree: CHECKOUTS })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', run: E2E_RUN, dir: REVIEW_DIR })
  expect(out.deny).toContain(REVIEW_DIR + ' has no GitHub origin remote')
  expect(out.deny).toContain('{"repo": "owner/name"}')
  expect(recordRun(seen)).toBeUndefined()
})

test('a head refusal names the repository and the pull request it compared', async ($, on) => {
  await world($, on, { git: { ...CLEAN, 'rev-parse HEAD': { exitCode: 0, stdout: MOVED + '\n' } } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
  expect(out.deny).toContain('the pull request\'s head is 0123456 (acme/thing#12)')
})

test('a git status that fails is reported with its error, not as changed files', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' } } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
  expect(out.deny).toContain('git status failed: fatal: not a git repository')
  expect(out.deny).not.toContain('have changes')
  expect(recordRun(seen)).toBeUndefined()
})

test('the permission check receives the checkout the record names', async ($, on) => {
  const seen = await world($, on, { git: AWAY, gitIn: { [REVIEW_DIR]: { ...CLEAN, ...REVIEW_ORIGIN } }, tree: CHECKOUTS, labels: ['Ready'] })
  await $.tool.call({ tool: 'mcp__github__record', pr: 12, result: 'pass', run: E2E_RUN, detail: 'ran', dir: REVIEW_DIR })
  expect(seen.checks.map((c) => fieldsOf(c)?.['dir'])).toContain(REVIEW_DIR)
})

test('a record is refused on a checkout whose tracked files changed', async ($, on) => {
  const seen = await world($, on, { git: { ...CLEAN, 'status --porcelain -uno': { exitCode: 0, stdout: ' M a.ts\n' } } })
  const dirty = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
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
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'waived', detail })

for (const [plugin, kind, allowed] of [
  ['pr-review', 'review', true], ['pr-review', 'norms', false], ['norms', 'norms', true], ['norms', 'review', false],
  ['orchestrator', 'review', true], ['orchestrator', 'e2e', false],
] as const) {
  test('a call from the ' + plugin + ' plugin ' + (allowed ? 'writes' : 'is refused') + ' a ' + kind + ' record', {
    plugins: [{
      name: plugin,
      register(on: TestOn) {
        on('command.run', { command: 'emit-record' }, async ($, e) => {
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
    register(on: TestOn) {
      on('command.run', { command: 'emit-verdict' }, async ($, e) => {
        const out = await $.tool.call({ tool: 'mcp__github__record', ...JSON.parse(String(e.args)) })
        return { text: JSON.stringify(out) }
      })
    },
  }],
})

const verdict = async ($: Engine, over: Record<string, unknown> = {}) =>
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
  const out = await $.tool.call({ tool: 'mcp__github__record', ...VERDICT })
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

// The operator's words, quoted with their date: what auto-merge rests on.
const HIS_WORDS = '« on est en auto-merge, pour cette orchestration infra compris », 2026-11-18T19:33Z'
const typed = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })
const setAutoMerge = (on: boolean, words: string, repo = 'acme/thing') =>
  gh('auto-merge-set', { repo, on, words }, undefined)
const listed = (seen: Seen) => JSON.parse(String(seen.files[AUTO_MERGE])).repositories

const mergeConsent = (text: string = CONSENT_GRANT, subject: unknown = { kind: 'auto-merge', repo: 'acme/thing' }) =>
  consentWorld({ a: consent({ subject, question: 'Put thing in auto-merge?', answer: text, by: 'coordinator' }) })

// A world holding the operator's answer `text` to a round question asking auto-merge on acme/thing.
function mergeWorld(text: string = CONSENT_GRANT, over: World = {}): World {
  const answered = mergeConsent(text)
  return { ...answered, ...over, tree: { ...answered.tree, ...over.tree } }
}

test('auto-merge-set on, quoting the operator\'s dated words, lists the repository, and its pr-ready asks nothing', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { verdict: { decision: 'ask' } }))
  const set = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
  const ready = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(ready.deny).toBeUndefined()
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toContain('pr-ready')
})

test('words with no date are no consent: auto-merge-set is refused and writes nothing', async ($, on) => {
  const seen = await world($, on)
  for (const words of ['oui, vas-y', 'on est en auto-merge', '']) {
    const out = await $.tool.call(setAutoMerge(true, words))
    expect(out.deny, words).toContain('github: auto-merge-set rests on the operator\'s words, quoted in "words" with their date')
  }
  expect(seen.files).toEqual({})
  expect(seen.writes).toEqual([])
})







test('auto-merge-set off takes the repository out, whatever its case, and its pr-ready is asked again', async ($, on) => {
  const words = '« thing sort de l\'auto-merge », 2026-11-18T19:40Z'
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['Acme/Thing', 'acme/other'], verdict: { decision: 'ask' }, answer: 'Allow' }))
  const before = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(before.deny).toBeUndefined()
  expect(seen.asked).toEqual([])
  const out = await $.tool.call(setAutoMerge(false, words))
  expect(out.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/other'])
  const ready = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(ready.deny).toBeUndefined()
  expect(seen.asked.length).toBe(1)
})

test('the list is written whole to a temporary file then moved in place, leaving no temporary file', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'] }))
  await $.tool.call(setAutoMerge(true, HIS_WORDS))
  const written = seen.writes.filter((x) => x.path.startsWith('/data/'))
  expect(written.length).toBe(1)
  expect(written[0]?.path).not.toBe(AUTO_MERGE)
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv' && r.argv.includes(String(written[0]?.path)) && r.argv.at(-1) === AUTO_MERGE)).toBe(true)
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(JSON.parse(String(seen.files[AUTO_MERGE]))).toEqual({ repositories: ['acme/other', 'acme/thing'] })
})

test('a move that fails removes the temporary file and leaves the list as it was', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], mvFails: 'EACCES' }))
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('EACCES')
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other'])
})

const LOCK = AUTO_MERGE + '.lock'
const lockRuns = (seen: Seen) => seen.runs.filter((r) => r.argv?.includes(LOCK)).map((r) => r.argv[0])

test('auto-merge-set reads and writes the list holding its lock, and releases it', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'] }))
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm'])
  expect(seen.runs.findIndex((r) => r.argv?.[0] === 'sh')).toBeLessThan(seen.runs.findIndex((r) => r.argv?.[0] === 'mv'))
  expect(Object.keys(seen.files)).toEqual([AUTO_MERGE])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock left by a holder that died is taken over', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: 0 } } }))
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBeUndefined()
  expect(lockRuns(seen)).toEqual(['sh', 'rm', 'sh', 'rm'])
  expect(listed(seen)).toEqual(['acme/other', 'acme/thing'])
})

test('a lock another session holds refuses the change, and stays its own', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { autoMerge: ['acme/other'], tree: { [LOCK]: { kind: 'file', mtimeMs: Date.now() } } }))
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(out.result).toContain('stays locked by another session')
  expect(lockRuns(seen)).not.toContain('rm')
  expect(seen.runs.some((r) => r.argv?.[0] === 'mv')).toBe(false)
  expect(listed(seen)).toEqual(['acme/other'])
})

test('a malformed list is never overwritten', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  seen.files[AUTO_MERGE] = '{"repositories": [1]}'
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_MERGE]).toBe('{"repositories": [1]}')
})

test('auto-merge-set refuses a repository that is not owner/name', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS, 'thing'))
  expect(out.deny).toContain('owner/name')
  expect(seen.files).toEqual({})
})

test('auto-merge-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, mergeWorld(CONSENT_GRANT, { verdict: { decision: 'deny', reason: 'no' } }))
  const out = await $.tool.call(setAutoMerge(true, HIS_WORDS))
  expect(out.deny).toBe('no')
  expect(seen.files).toEqual({})
})

test('auto-merge-list prints the repositories in auto-merge', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing', 'acme/other'] })
  const out = await $.tool.call(gh('auto-merge-list', {}, undefined))
  expect(out.result).toBe('acme/thing\nacme/other')
})

test('auto-merge-list with no file says so', async ($, on) => {
  await world($, on)
  const out = await $.tool.call(gh('auto-merge-list', {}, undefined))
  expect(out.result).toBe('no repository in auto-merge')
})

for (const command of [
  'echo \'{"repositories":["a/b"]}\' > /data/auto-merge.json',
  'cd ~/.claude/plugins/data/github-lounisbou && jq . auto-merge.json > x && mv x auto-merge.json',
]) {
  test('a Bash command that names the auto-merge list is refused: ' + command.slice(0, 30), async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(bash(command))
    expect(out.deny).toContain('auto-merge-set')
    expect(seen.bash).toEqual([])
  })
}

for (const [tool, path] of [
  ['Write', AUTO_MERGE], ['Edit', AUTO_MERGE], ['Write', '/home/x/.claude/plugins/data/github-lounisbou/auto-merge.json'],
] as const) {
  test('a ' + tool + ' of the auto-merge list is refused: ' + path, async ($, on) => {
    await world($, on)
    const out = await $.tool.call({ tool, file_path: path, content: '{}', old_string: 'a', new_string: 'b' })
    expect(out.deny).toContain('auto-merge-set')
  })
}

test('a Bash command that names the file outside the plugins\' data goes through', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(bash('grep -n auto-merge.json README.md'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['grep -n auto-merge.json README.md'])
})

test('a Write of another auto-merge.json, outside the plugins\' data, goes through', async ($, on) => {
  await world($, on)
  const out = await $.tool.call({ tool: 'Write', file_path: '/work/fixtures/auto-merge.json', content: '{}' })
  expect(out.deny).toBeUndefined()
})

// ---- the operator's recorded answer, quoted inside a wrapping ----

// The moment the module reads on its clock: noon in UTC, a day everywhere the tests run.
const RECEIVED = Date.UTC(2026, 10, 2, 12, 0, 0)
test('auto-merge-set accepts his dated words inside a wrapping', async ($, on) => {
  const seen = await world($, on, mergeWorld())
  const wrapped = await $.tool.call(setAutoMerge(true, '« ' + HIS_WORDS + ' » — operator'))
  expect(wrapped.deny).toBeUndefined()
  expect(listed(seen)).toEqual(['acme/thing'])
})


// ---- leaving draft is the operator's outside auto-merge ----

const LEAVE_DRAFT = 'leaving draft meets the readiness gate, which needs the pull request named'


test('a pr-ready outside auto-merge is asked write no rule allows', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.journal).toEqual([])
  expect(seen.asked.length).toBe(1)
  expect(commands(seen)).toContain('pr-ready')
})

test('a pr-ready outside auto-merge that the person denies runs nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Deny' })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out.deny).toBe('the user refused gh pr-ready')
  expect(commands(seen)).not.toContain('pr-ready')
})


test('a pr-create out of draft outside auto-merge is asked write no rule allows', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-create', { title: 'fix: x', body: 'Adds the reset.\n\n' + SECTIONS, draft: false }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.journal).toEqual([])
  expect(seen.asked.length).toBe(1)
  expect(commands(seen)).toEqual(['pr-create'])
})


test('gh pr ready and the engine leaving draft outside auto-merge go through, a GraphQL one that names no pull request is refused', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const ready = await $.tool.call(bash('gh pr ready 12 -R acme/thing'))
  expect(ready.deny).toBeUndefined()
  const engine = await $.tool.call(bash('python3 ' + ROOT + '/engine/gh.py pr-ready 12 --repo acme/thing'))
  expect(engine.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  expect(seen.bash.length).toBe(2)
  const graphql = await $.tool.call(bash('gh api graphql -f query=\'mutation{markPullRequestReadyForReview(input:{pullRequestId:"x"}){clientMutationId}}\''))
  expect(graphql.deny).toContain(LEAVE_DRAFT)
  expect(seen.bash.length).toBe(2)
  expect(seen.journal).toEqual(['github.ready.held'])
  expect(seen.asked).toEqual([])
})

test('in auto-merge a ready pr-ready still runs, with no question', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], labels: ['Ready'], verdict: { decision: 'ask' } })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(seen.asked).toEqual([])
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
})

test('a merge outside auto-merge is still asked', async ($, on) => {
  const seen = await world($, on, { answer: 'Deny' })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('the user refused gh pr-merge')
  expect(seen.asked[0]).toContain('Merge a pull request')
})

// ---- the gate puts Ready ----

const readinessRuns = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-readiness').map((r) => [r.repo, r.args])
const e2eCall = { tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN, detail: 'ran the smoke suite' }
const WRITTEN = HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json'

test('a record that completes the four puts Ready, with one line', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, records: Object.fromEntries([record('review', 'pass'), record('norms', 'pass')]) })
  const out = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(out.result).toBe(WRITTEN + '\ngithub: acme/thing#12 Ready at 0123456:'
    + ' a clean review, passed E2E and green CI hold at its head.')
})

test('a record written where CI is red puts no Ready, and says what is missing', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, ci: { result: 'FAILURE', failed: ['test'] } })
  const out = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([])
  expect(out.result).toBe(WRITTEN + '\ngithub: acme/thing#12 not Ready yet at 0123456. Missing: CI failed: test')
})

test('a record that leaves a Ready pull request short of the four puts Not Ready back', async ($, on) => {
  const records = Object.fromEntries([record('review', 'pass'), record('norms', 'pass'), record('e2e', 'fail')])
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'], records, e2eExit: 1 })
  const out = await $.tool.call({ ...e2eCall, result: 'fail' })
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(out.result).toContain('github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: fail at 0123456 by session-e2e')
})

test('a record on a pull request already Ready changes no label', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'] })
  const out = await $.tool.call(e2eCall)
  expect(readinessRuns(seen)).toEqual([])
  expect(out.result).toBe(WRITTEN)
})

test('a label the gate cannot put leaves the record written, and says so', async ($, on) => {
  await world($, on, { git: CLEAN, readinessFails: 'error: forbidden' })
  const out = await $.tool.call(e2eCall)
  expect(out.isError).toBeUndefined()
  expect(out.result).toStartWith(WRITTEN + '\n')
  expect(out.result).toContain('github: the Ready label of acme/thing#12: label not written: error: forbidden')
})

const READY_LINE = 'github: acme/thing#12 Ready at 0123456: a clean review, passed E2E and green CI hold at its head.'

test('a read of the gate through the tool puts Ready when the four hold, its JSON pure and its line the module\'s own', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  const gate = JSON.parse(String(out.result))
  expect(gate.labels).toEqual(['Ready'])
  expect(gate.head).toBe(HEAD)
  expect(seen.logs).toEqual([READY_LINE])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  // The read of the gate answers the gate; the head is read once more just before the write.
  expect(gates(seen)).toBe(2)
})

test('a read of the checks through the tool puts Ready when the four hold, its output left as it is', async ($, on) => {
  const seen = await world($, on)
  const checks = await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(checks.result).toBe('ok')
  expect(seen.logs).toEqual([READY_LINE])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(gates(seen)).toBe(2)
})

// The head is read again before the label is written by the one read that says it, not by a second gate.
const headChecks = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-gate').map((r) => r.args?.['head-only'] === true)

test('a read of the gate rechecks the head with a head-only read', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(headChecks(seen)).toEqual([false, true])
})

test('a read of the checks computes the gate once and rechecks the head with a head-only read', async ($, on) => {
  const seen = await world($, on)
  await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(headChecks(seen)).toEqual([false, true])
})

const ACTIONS_LINE = 'error: cannot read the Actions runs of ' + HEAD + ': boom (HTTP 500)'

test('a read of the gate through the tool shows the line of its Actions call, after a JSON the module still read', async ($, on) => {
  const seen = await world($, on, { readStderr: ACTIONS_LINE + '\n' })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  const result = String(out.result)
  const cut = result.lastIndexOf('\n')
  expect(result.slice(cut + 1)).toBe(ACTIONS_LINE)
  // The module parsed the output as the gate wrote it: it put Ready and rewrote the labels.
  expect(fieldsOf(JSON.parse(result.slice(0, cut)))?.['labels']).toEqual(['Ready'])
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a read of the checks through the tool shows the line of its Actions call', async ($, on) => {
  await world($, on, { readStderr: ACTIONS_LINE + '\n' })
  const out = await $.tool.call(gh('pr-checks', { pr: 12 }))
  expect(out.result).toBe('ok\n' + ACTIONS_LINE)
})

test('the guard reads the gate with that line on stderr, shows it nowhere, and still parses', async ($, on) => {
  const seen = await world($, on, { readStderr: ACTIONS_LINE + '\n', autoMerge: ['acme/thing'], labels: ['Ready'] })
  const out = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(out).toEqual({ result: 'ok' })
  expect(commands(seen)).toEqual(['pr-gate', 'pr-ready'])
  expect(seen.logs).toEqual([])
})

test('a read that finds the four short of a pull request not Ready says nothing', async ($, on) => {
  const seen = await world($, on, { ci: { result: 'PENDING', running: 1 } })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(out.result).not.toContain('github:')
  expect(readinessRuns(seen)).toEqual([])
})

test('a read of a Ready pull request whose CI turned red puts Not Ready back', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], ci: { result: 'FAILURE', failed: ['lint'] } })
  const out = await $.tool.call(gh('pr-checks', { pr: 12 }))
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
    bash('gh pr edit 12 --add-label Ready'),
    bash('gh issue edit 12 -R acme/thing --add-label ready'),
    bash('gh api --method POST repos/acme/thing/issues/12/labels -f \'labels[]=Ready\''),
    bash('gh api -X PATCH repos/acme/thing/pulls/12 -f labels=\'["Ready"]\''),
    bash('python3 ' + ROOT + '/engine/gh.py label-add 12 Ready --repo acme/thing'),
  ]) {
    const out = await $.tool.call(call)
    expect(out.deny).toBeUndefined()
  }
  expect(seen.bash.length).toBe(5)
  // No pr-gate: the label reads no readiness.
  expect(commands(seen).filter((c) => !c.startsWith('git '))).toEqual(['label-add'])
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
// their modules: a norms module here calls it as such a call reaches it, its caller a plugin.
test('a norms record written from the norms module puts Ready through the record tool\'s handler', {
  plugins: [{
    name: 'norms',
    register(on: TestOn) {
      on('command.run', { command: 'emit-norms' }, async ($) => {
        const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind: 'norms', result: 'pass' })
        return { text: JSON.stringify(out) }
      })
    },
  }],
}, async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out = await $.command.run({ command: 'emit-norms', args: '' })
  const argv = recordRun(seen) ?? []
  expect(argv[argv.indexOf('--kind') + 1]).toBe('norms')
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(out.text).toContain('github: acme/thing#12 Ready at 0123456')
})

// ---- the routes around leaving draft and around the gate ----


test('a pr-create out of draft outside auto-merge is asked write', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'ask' }, answer: 'Allow' })
  const call = gh('pr-create', { title: 'fix: x', body: 'no sections', draft: false }, 'geonativefr/thing')
  const out = await $.tool.call(call)
  expect(out).toEqual({ result: 'ok' })
  expect(seen.journal).toEqual([])
  expect(seen.asked.length).toBe(1)
  expect(commands(seen)).toEqual(['pr-create'])
})


test('gh pr ready --undo=false leaves draft outside auto-merge, --undo=true goes back to draft', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'] })
  const out = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo=false'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['gh pr ready 12 -R acme/thing --undo=false'])
  expect(seen.journal).toEqual([])
  const back = await $.tool.call(bash('gh pr ready 12 -R acme/thing --undo=true'))
  expect(back.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  expect(readinessRuns(seen)).toEqual([])
})

const ORIGIN = { 'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/thing.git\n' } }
const OPAQUE = 'gh api graphql -F query=@mutation.graphql'

test('a GraphQL query the command does not show is refused outside auto-merge', async ($, on) => {
  const seen = await world($, on, { git: ORIGIN, autoMerge: ['acme/other'] })
  for (const line of [OPAQUE, 'gh api /graphql --input body.json', 'gh api https://api.github.com/graphql -f query="$Q"']) {
    const out = await $.tool.call(bash(line))
    expect(String(out.deny), line).toStartWith('github: gh api graphql refused: its query cannot be read from the command')
  }
  expect(seen.bash).toEqual([])
})

test('a GraphQL query the command does not show is refused in auto-merge as an unverified readiness', async ($, on) => {
  const seen = await world($, on, { git: ORIGIN, autoMerge: ['acme/thing'] })
  const out = await $.tool.call(bash(OPAQUE))
  expect(out.deny).toBe('github: readiness of acme/thing#? unverified: the GraphQL query cannot be read from the command')
  expect(seen.bash).toEqual([])
})

test('a GraphQL query the command does not show is refused when the guard fails to read the origin', async ($, on) => {
  const seen = await world($, on, { gitThrows: 'spawn failed', autoMerge: ['acme/thing'] })
  const out = await $.tool.call(bash(OPAQUE))
  expect(String(out.deny)).toStartWith('github: gh api graphql refused: its query cannot be read from the command')
  expect(seen.bash).toEqual([])
})

for (const [route, call] of UNDRAFT_ACTS) {
  test('a ' + route + ' undraft of a Not Ready pull request one of whose checks passed is no CI undraft, refused by the gate outside auto-merge', async ($, on) => {
    const seen = await world($, on, { ci: { result: 'FAILURE', failed: ['test'], total: 2 } })
    const out = await $.tool.call(call)
    expect(String(out.deny)).toContain('not ready. Missing: CI failed: test')
    expect(actRan(seen, route, 'pr-ready')).toBe(0)
    expect(seen.logs.some((l) => l.includes('out of draft to run CI'))).toBe(false)
  })
}

const CI_PENDING = { result: 'PENDING', running: 0, skipped: ['test'], total: 1 }

test('a pull request the plugin took out of draft for its CI stays out of draft when the gate writes Ready', async ($, on) => {
  const w: World = { ci: CI_PENDING }
  const seen = await world($, on, w)
  await $.tool.call(gh('pr-ready', { pr: 12 }))
  seen.pull!.draft = false
  w.ci = {}
  seen.runs.length = 0
  seen.logs.length = 0
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
  expect(seen.logs).toEqual([READY_LINE])
  const gate = JSON.parse(String(out.result))
  expect([gate.draft, gate.labels]).toEqual([false, ['Ready']])
})

test('a pull request the operator took out of draft gets Ready and stays out of draft', async ($, on) => {
  const seen = await world($, on, { draft: false })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(commands(seen)).toEqual(['pr-gate', 'pr-gate', 'pr-readiness'])
  expect(seen.logs).toEqual([READY_LINE])
  const gate = JSON.parse(String(out.result))
  expect([gate.draft, gate.labels]).toEqual([false, ['Ready']])
})

test('a head that moves while the gate reads it gets no label, and the line says so', async ($, on) => {
  const seen = await world($, on, { heads: [HEAD, MOVED] })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(JSON.parse(String(out.result)).labels).toEqual(['Not Ready'])
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

// A merge in auto-merge: refused with what the pull request misses at its head, unless only records are absent there.
async function mergeProbe($: Engine): Promise<Reply> {
  return $.tool.call(gh('pr-merge', { pr: 12 }))
}

// pr-readiness ready: its result answers everything the pull request misses at its head, absent records included.
async function missingProbe($: Engine): Promise<Reply> {
  return $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
}

test('records that cannot be listed are an unverified readiness to the guard', async ($, on) => {
  await world($, on, { autoMerge: ['acme/thing'], listFails: 'EACCES: permission denied' })
  const out = await mergeProbe($)
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
  const out = await $.tool.call(e2eCall)
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
    const missing = await missingProbe($)
    expect(missing.result).toContain('Missing: e2e: no record at 0123456')
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

// ---- an exemption the operator limited in time ----

// The clock reads RECEIVED (2026-11-02T12:00:00Z): one exemption ends a day after, one a day before.
const AHEAD = '2026-11-03T12:00:00Z'
const BEHIND = '2026-11-01T12:00:00Z'

test('an exemption whose expiry is ahead covers a pull request, its line naming the expiry', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  // The test's subject is the expiry, not the Not Ready's origin: this machine wrote it.
  const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, until: AHEAD }, ownLabel: true })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs).toEqual([EXEMPT_LINE.replace('2026-11-13:', '2026-11-13, until ' + AHEAD + ':')])
})

for (const [label, until] of [['an expiry behind', BEHIND], ['an expiry that is now', '2026-11-02T12:00:00Z']] as const) {
  test('an exemption with ' + label + ' covers nothing: the gate asks E2E again and says why in one line', async ($, on) => {
    mock.clock(on, { now: RECEIVED })
    const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, until }, autoMerge: ['acme/thing'] })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(readinessRuns(seen)).toEqual([])
    const missing = await missingProbe($)
    expect(missing.result).toContain('Missing: e2e: no record at 0123456')
    expect(missing.result).toContain('E2E exemption of acme/thing expired at ' + until + ': it no longer excuses E2E')
    expect(String(missing.result).split('expired at').length).toBe(2)
    // The expiry line beside the absent record is no reason of its own: the merge is observed.
    expect(await $.tool.call(gh('pr-merge', { pr: 12 }))).toEqual({ result: 'ok' })
    expect(seen.journal).toEqual(['github.ready.held'])
  })
}

test('the gate takes a Ready pull request back to Not Ready on an expired exemption, its one line saying why', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, until: BEHIND }, labels: ['Ready'], draft: false })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }]])
  expect(seen.logs.join('\n')).toContain('E2E exemption of acme/thing expired at ' + BEHIND)
})

test('an exemption whose expiry cannot be read exempts nothing', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  // The Not Ready is this machine's: the gate alone says no.
  const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, until: 'tomorrow' }, autoMerge: ['acme/thing'], ownLabel: true })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('a failed E2E record holds a pull request of an exempted repository', async ($, on) => {
  const seen = await world($, on, { records: { ...TWO, ...Object.fromEntries([record('e2e', 'fail')]) }, exemption: EXEMPT })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

const exemptCall = (exempt: boolean, detail: string, over: Record<string, unknown> = {}) =>
  ({ tool: 'mcp__github__record', repo: 'acme/thing', exempt, detail, ...over })
const exemptionOf = (seen: Seen) => JSON.parse(String(seen.files[EXEMPTION]))
const HIS_EXEMPTION = 'plus de dérogation E2E sur thing pour docs/ et no-e2e, 2026-11-13'
test('the operator\'s quoted, dated words exempt a repository through the record tool, with its rules, and revoke it: no consent record is read', async ($, on) => {
  const seen = await world($, on)
  const set = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: ['docs/'], labels: ['no-e2e'] }))
  expect(set.deny).toBeUndefined()
  expect(set.result).toBe('github: acme/thing exempt from E2E for its pull requests carrying no-e2e or whose files all match docs/')
  expect(exemptionOf(seen)).toMatchObject({ v: 1, repo: 'acme/thing', exempt: true, paths: ['docs/'], labels: ['no-e2e'], detail: HIS_EXEMPTION })
  const revoke = await $.tool.call(exemptCall(false, HIS_EXEMPTION))
  expect(revoke.result).toBe('github: acme/thing no longer exempt from E2E')
  expect(exemptionOf(seen)).toMatchObject({ exempt: false, paths: [], labels: [] })
  expect(recordRun(seen)).toBeUndefined()
  expect(Object.keys(seen.files).filter((path) => path.includes('/consents/'))).toEqual([])
})

test('an exemption with no rule covers every pull request of the repository', async ($, on) => {
  const seen = await world($, on)
  const set = await $.tool.call(exemptCall(true, HIS_EXEMPTION))
  expect(set.result).toBe('github: acme/thing exempt from E2E for all its pull requests')
  expect(exemptionOf(seen).exempt).toBe(true)
})

test('an exemption is refused without a repository or with rules that are not lists of names', async ($, on) => {
  const seen = await world($, on)
  const unnamed = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { repo: 'thing' }))
  expect(unnamed.deny).toContain('{"repo": "owner/name"}')
  const ruled = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: 'docs/' }))
  expect(ruled.deny).toContain('"paths" and "labels" are lists')
  expect(seen.files[EXEMPTION]).toBeUndefined()
})

test('an exemption with no expiry is written as before, with no until in the file', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on)
  const out = await $.tool.call(exemptCall(true, HIS_EXEMPTION))
  expect(out.result).toBe('github: acme/thing exempt from E2E for all its pull requests')
  expect(exemptionOf(seen)).not.toHaveProperty('until')
})

test('an exemption with a limit rests on the operator\'s quoted, dated words, with no consent record', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on)
  const out = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { paths: ['docs/'], labels: ['no-e2e'], until: AHEAD }))
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('github: acme/thing exempt from E2E for its pull requests carrying no-e2e or whose files all match docs/ until ' + AHEAD)
  expect(exemptionOf(seen)).toMatchObject({ exempt: true, until: AHEAD, detail: HIS_EXEMPTION })
  expect(Object.keys(seen.files).filter((path) => path.includes('/consents/'))).toEqual([])
})

const SEEN_FILE = '/data/label-seen/acme/thing/12.json'
const LISTED_FILE = '/data/label-seen/acme/thing/.listed'
const FAILING_FILE = '/data/label-seen/acme/thing/.failing'

test('a pr-gate read does not put Ready over a Not Ready this machine did not set before the forge was listed after the wait', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, {})
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(seen.logs.join('\n')).toContain('the Not Ready it carries was not set by this machine')
  expect(JSON.parse(seen.files[SEEN_FILE] ?? '{}')).toMatchObject({ head: HEAD, label: 'not-ready', own: false, since: RECEIVED })
  // The wait is over, the forge was last listed before it: still held, until a listing follows.
  await clock.advance(FOREIGN_WAIT_MS + 1000)
  seen.files[LISTED_FILE] = String(RECEIVED)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  seen.files[LISTED_FILE] = String(RECEIVED + FOREIGN_WAIT_MS + 500)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  // What the tool wrote is its own.
  expect(JSON.parse(seen.files[SEEN_FILE] ?? '{}')).toMatchObject({ label: 'ready', own: true })
})

test('a Not Ready another session of this machine wrote is undone by a pr-gate read at once', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: true })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('pr-readiness ready, pr-ready and pr-merge are held over a Not Ready this machine did not set, and go once the forge was listed after the wait', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false, autoMerge: ['acme/thing'] })
  const asked = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(String(asked.result)).toContain('Ready not put: the Not Ready it carries was not set by this machine')
  const undraft = await $.tool.call(gh('pr-ready', { pr: 12 }))
  expect(undraft.deny).toContain('pr-ready refused on acme/thing#12')
  expect(undraft.deny).toContain('not set by this machine')
  const merge = await $.tool.call(gh('pr-merge', { pr: 12, sha: HEAD }))
  expect(merge.deny).toContain('not set by this machine')
  expect(readinessRuns(seen)).toEqual([])
  expect(commands(seen)).not.toContain('pr-ready')
  expect(commands(seen)).not.toContain('pr-merge')
  await clock.advance(FOREIGN_WAIT_MS + 1000)
  seen.files[LISTED_FILE] = String(RECEIVED + FOREIGN_WAIT_MS + 500)
  await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(readinessRuns(seen)).toContainEqual(['acme/thing', { pr: 12, state: 'ready' }])
  // The act goes too, no longer refused.
  expect((await $.tool.call(gh('pr-ready', { pr: 12 }))).deny).toBeUndefined()
  expect(commands(seen)).toContain('pr-ready')
})

test('a clock the module cannot read holds the explicit acts too, naming it', async ($, on) => {
  const seen = await world($, on, { noClock: true })
  const asked = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(String(asked.result)).toContain('the clock cannot be read')
  expect((await $.tool.call(gh('pr-ready', { pr: 12 }))).deny).toContain('pr-ready refused on acme/thing#12')
  expect(readinessRuns(seen)).toEqual([])
})

test('the Not Ready the gate puts back on a Ready pull request through pr-readiness is this machine\'s own, at the head it read', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false, labels: ['Ready'], records: TWO })
  await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(seen.pull?.labels).toEqual(['Not Ready'])
  expect(JSON.parse(seen.files[SEEN_FILE] ?? '{}')).toMatchObject({ head: HEAD, label: 'not-ready', own: true })
})

test('with the last listing whose statuses were imported older than the wait, Ready stays held, and goes at FOREIGN_CEILING_MS with a line saying so', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false })
  seen.files[LISTED_FILE] = String(RECEIVED - 3_600_000)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  await clock.advance(FOREIGN_WAIT_MS + 1000)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(seen.logs.join('\n')).toContain('the forge is not known to be listed since the wait')
  await clock.advance(FOREIGN_CEILING_MS)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
  expect(seen.logs.join('\n')).toContain('no listing of the forge followed the wait within 10 minutes')
})

test('with no listing whose statuses were imported known, Ready stays held past FOREIGN_CEILING_MS', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  await clock.advance(FOREIGN_CEILING_MS + FOREIGN_WAIT_MS)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('while the import of the other machine\'s statuses fails, Ready stays held past FOREIGN_CEILING_MS, on the label and on the acts, the line saying why', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false, autoMerge: ['acme/thing'] })
  // The last import that went through is older than the wait, a listing since could not import.
  seen.files[LISTED_FILE] = String(RECEIVED - 3_600_000)
  seen.files[FAILING_FILE] = String(RECEIVED)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  await clock.advance(FOREIGN_CEILING_MS + FOREIGN_WAIT_MS)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(seen.logs.join('\n')).toContain('cannot be imported here')
  const asked = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(String(asked.result)).toContain('cannot be imported here')
  expect((await $.tool.call(gh('pr-merge', { pr: 12, sha: HEAD }))).deny).toContain('cannot be imported here')
  expect(readinessRuns(seen)).toEqual([])
  // An import that went through after the failure ends it: the listing counts again.
  seen.files[LISTED_FILE] = String(RECEIVED + FOREIGN_CEILING_MS + FOREIGN_WAIT_MS)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('the ceiling never releases pr-readiness ready, pr-ready or pr-merge: a stale listing keeps them held', async ($, on) => {
  const clock = mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false, autoMerge: ['acme/thing'] })
  seen.files[LISTED_FILE] = String(RECEIVED - 3_600_000)
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  await clock.advance(FOREIGN_CEILING_MS + FOREIGN_WAIT_MS)
  expect(String((await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))).result)).toContain('Ready not put')
  expect((await $.tool.call(gh('pr-ready', { pr: 12 }))).deny).toContain('not set by this machine')
  expect((await $.tool.call(gh('pr-merge', { pr: 12, sha: HEAD }))).deny).toContain('not set by this machine')
  expect(readinessRuns(seen)).toEqual([])
  expect(commands(seen)).not.toContain('pr-ready')
  expect(commands(seen)).not.toContain('pr-merge')
})

test('a clock the module cannot read holds Ready over a Not Ready, with a line', async ($, on) => {
  const seen = await world($, on, { noClock: true })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
  expect(seen.logs.join('\n')).toContain('the clock cannot be read')
})

test('the Not Ready a Bash pull request opening puts is this machine\'s own: the first gate read puts Ready at once', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on, { ownLabel: false, bashResult: { result: { stdout: 'https://github.com/acme/thing/pull/12\n', stderr: '', interrupted: false } } })
  await $.tool.call(bash('gh pr create --draft -t "fix: x" -b "Adds the reset.\n\n**TODO Staging:** none\n**TODO Prod:** none\n**PRs Dependency:** none\n**Related PRs:** none"'))
  expect(JSON.parse(seen.files[SEEN_FILE] ?? '{}')).toMatchObject({ label: 'not-ready', own: true })
  seen.pull = { ...(seen.pull as Pull), labels: ['Not Ready'] }
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'not-ready' }], ['acme/thing', { pr: 12, state: 'ready' }]])
})

// The operator's case at the gate: until 2026-11-16T11:00:00Z (Paris noon), it excuses E2E before that instant and nothing at it.
const OPERATOR_UNTIL = '2026-11-16T11:00:00Z'
for (const [label, now, covered] of [
  ['one second before', Date.UTC(2026, 10, 16, 10, 59, 59), true], ['at', Date.UTC(2026, 10, 16, 11, 0, 0), false],
  ['a day after', Date.UTC(2026, 10, 17, 11, 0, 0), false],
] as const) {
  test('the operator\'s exemption until ' + OPERATOR_UNTIL + ' ' + (covered ? 'covers' : 'covers nothing') + ' a pull request ' + label + ' it', async ($, on) => {
    mock.clock(on, { now })
    // The test's subject is the expiry, not the Not Ready's origin: this machine wrote it.
    const seen = await world($, on, { records: TWO, exemption: { ...EXEMPT, until: OPERATOR_UNTIL }, autoMerge: ['acme/thing'], ownLabel: true })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    if (covered) {
      expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
    } else {
      expect(readinessRuns(seen)).toEqual([])
      const missing = await missingProbe($)
      expect(missing.result).toContain('Missing: e2e: no record at 0123456')
      expect(missing.result).toContain('E2E exemption of acme/thing expired at ' + OPERATOR_UNTIL)
    }
  })
}

// The operator's own sentence, quoted with its date: the exemption until the Paris noon of 2026-11-16 (11:00 UTC).
test('the operator\'s sentence « Dispense valable jusqu\'au 16/11/2026 12h00 heure de Paris », quoted and dated, exempts a repository until 11:00 UTC', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const repo = 'geonativefr/geo-git-flow'
  const until = '2026-11-16T11:00:00Z'
  const words = '« Accorder la dispense de geo-git-flow et fusionner les PRS. Dispense valable jusqu\'au 16/11/2026 12h00 heure de Paris ! » — operator, 2026-11-15T08:06:00Z'
  const seen = await world($, on)
  const out = await $.tool.call(exemptCall(true, words, { repo, until }))
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('github: ' + repo + ' exempt from E2E for all its pull requests until ' + until)
  expect(JSON.parse(String(seen.files['/data/e2e-exempt/' + repo + '.json']))).toMatchObject({ repo, exempt: true, until, detail: words })
})

test('an expiry that is past, unreadable or given to a revocation is refused', async ($, on) => {
  mock.clock(on, { now: RECEIVED })
  const seen = await world($, on)
  const past = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { until: BEHIND }))
  expect(past.deny).toContain('already past')
  const now = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { until: '2026-11-02T12:00:00Z' }))
  expect(now.deny).toContain('already past')
  for (const until of ['tomorrow', '2026-11-03', '2026-11-03T12:00:00+01:00', '2026-02-31T00:00:00Z', 7]) {
    const bad = await $.tool.call(exemptCall(true, HIS_EXEMPTION, { until }))
    expect(bad.deny, String(until)).toContain('"until" is the instant the exemption ends')
  }
  const revoked = await $.tool.call(exemptCall(false, HIS_EXEMPTION, { until: AHEAD }))
  expect(revoked.deny).toContain('revoked with no "until"')
  expect(seen.files[EXEMPTION]).toBeUndefined()
})

// The limits of «quoted with its date», at their edges: accepted forms, one by one.
const QUOTED_FORMS: Array<[string, string]> = [
  ['the documented time with no seconds', '« plus de dérogation », 2026-11-15T08:50Z'],
  ['a date alone', 'plus de dérogation E2E, 2026-11-15'],
  ['six letters', 'abcdef 2026-11-15'],
  ['500 characters', 'plus de dérogation E2E, 2026-11-15 '.padEnd(500, 'x')],
]
for (const [why, detail] of QUOTED_FORMS) {
  test('a quote with ' + why + ' stands for an E2E waiver and an exemption', async ($, on) => {
    const seen = await world($, on, { git: CLEAN })
    expect(((await $.tool.call(waiveCall(detail)))).deny).toBeUndefined()
    expect(((await $.tool.call(exemptCall(true, detail)))).deny).toBeUndefined()
    expect(recordRun(seen)).toBeDefined()
  })
}

test('a recorded « Accorder » of the E2E waiver does not stand for an unquoted detail', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, ...consentWorld({ a: granted() }) })
  const out = await $.tool.call(waiveCall(''))
  expect(out.deny).toContain('an E2E waiver rests on the operator\'s words, quoted in "detail" with their date')
  expect(recordRun(seen)).toBeUndefined()
})

// What «quoted with its date» means for an exemption and for a waiver: words, and a date.
const UNQUOTED: Array<[string, string]> = [
  ['an empty detail', ''],
  ['a blank detail', '   \n '],
  ['words with no date', 'plus de dérogation E2E sur thing'],
  ['a date with no words', '2026-11-13'],
  ['a date with a few characters', 'ok, 2026-11-13T10:00:00Z'],
  ['digits for words', '12345678 2026-11-13'],
  ['two dates and no words', '2026-11-13, 2026-11-13'],
  ['a time and no words', '2026-11-13 08:50:00 UTC'],
  ['501 characters', 'plus de dérogation E2E sur thing, 2026-11-13 '.padEnd(501, 'x')],
  ['a detail past the record\'s limit', 'plus de dérogation E2E sur thing, 2026-11-13 ' + 'x'.repeat(500)],
]
for (const [why, detail] of UNQUOTED) {
  test('an exemption is refused with ' + why + ', and a revocation too: nothing is written', async ($, on) => {
    const seen = await world($, on, { exemption: EXEMPT })
    const set = await $.tool.call(exemptCall(true, detail, { repo: 'acme/other' }))
    expect(set.deny).toContain('an E2E exemption rests on the operator\'s words, quoted in "detail" with their date')
    const revoke = await $.tool.call(exemptCall(false, detail))
    expect(revoke.deny).toContain('rests on the operator\'s words, quoted in "detail" with their date')
    expect(seen.files['/data/e2e-exempt/acme/other.json']).toBeUndefined()
    expect(exemptionOf(seen).exempt).toBe(true)
  })
}

test('an exemption of a repository named with a dot segment is refused before any file is written', async ($, on) => {
  const seen = await world($, on)
  for (const repo of ['../auto-merge', 'o/..', './thing', '.../x']) {
    const out = await $.tool.call(exemptCall(true, 'plus de dérogation E2E sur ' + repo + ', 2026-11-13', { repo }))
    expect(out.deny, repo).toContain('{"repo": "owner/name"}')
  }
  expect(seen.files).toEqual({})
})

const LABELLED = { ...EXEMPT, labels: ['no-e2e'] }


test('a label an exemption names goes through like another label, on or off, nothing journaled', async ($, on) => {
  const seen = await world($, on, { exemption: LABELLED })
  const added = await $.tool.call(gh('label-add', { pr: 12, label: ['bug', 'No-E2E'] }))
  expect(added.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  const removed = await $.tool.call(gh('label-remove', { pr: 12, name: 'no-e2e' }))
  expect(removed.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  const other = await $.tool.call(gh('label-add', { pr: 12, label: ['bug'] }))
  expect(other.deny).toBeUndefined()
  expect(seen.journal).toEqual([])
  expect(seen.runs.filter((r) => r.command).map((r) => r.command)).toEqual(['label-add', 'label-remove', 'label-add'])
})

test('the exemption files are written through Write, Edit and Bash, each observed, a deletion in them is refused', async ($, on) => {
  const seen = await world($, on)
  const calls = [
    { tool: 'Write', file_path: EXEMPTION, content: '{}' },
    { tool: 'Edit', file_path: '/home/x/.claude/plugins/data/github-lounisbou/e2e-exempt/o/r.json', old_string: 'a', new_string: 'b' },
    bash('echo {} > /data/e2e-exempt/acme/thing.json'),
  ]
  for (const call of calls) {
    const out = await $.tool.call(call)
    expect(out.deny, JSON.stringify(call)).toBeUndefined()
  }
  expect(seen.journal).toEqual(calls.map(() => 'github.exemption.write'))
  for (const command of ['rm -r "$CLAUDE_PLUGIN_DATA/e2e-exempt"', 'find /data/e2e-exempt -delete', 'mv /data/e2e-exempt/acme/thing.json /tmp/x', 'bash -c "rm /data/e2e-exempt/acme/thing.json"']) {
    const out = await $.tool.call(bash(command))
    expect(out.deny, command).toBe(EXEMPT_REFUSAL)
  }
  expect(seen.journal.length).toBe(calls.length + 4)
  for (const command of ['cat /data/e2e-exempt/acme/thing.json', 'ls /data/check-plans/acme']) {
    const read = await $.tool.call(bash(command))
    expect(read.deny, command).toBeUndefined()
  }
  expect(seen.journal.length).toBe(calls.length + 4)
  const mention = await $.tool.call(bash('git commit -m "docs: explain e2e-exempt/ files"'))
  expect(mention.deny).toBeUndefined()
  expect(seen.journal.length).toBe(calls.length + 4)
  expect(seen.bash).toEqual([calls[2], bash('cat /data/e2e-exempt/acme/thing.json'), bash('ls /data/check-plans/acme'), bash('git commit -m "docs: explain e2e-exempt/ files"')].map((call) => fieldsOf(call)?.['command']))
})

const noneCall = (detail?: string) =>
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'not-applicable', ...(detail === undefined ? {} : { detail }) })
const DOCS_ONLY = [{ filename: 'README.md' }, { filename: 'plugins/github/tests/run-tests.sh' }, { filename: '.github/workflows/ci.yml' }]

test('E2E not applicable on a pull request whose files hold no runtime is recorded without the operator', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, records: TWO, files: DOCS_ONLY })
  const out = await $.tool.call(noneCall('documentation and tests only'))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toContain('not-applicable')
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('E2E not applicable on a pull request that changes code is refused, naming the files', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: [...DOCS_ONLY, { filename: 'hooks/register.ts' }, { filename: 'package.json' }] })
  const out = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toBe('github: E2E is not applicable only to a pull request whose files hold no runtime;'
    + ' acme/thing#12 changes hooks/register.ts, package.json.')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused without its reason', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: DOCS_ONLY })
  for (const detail of [undefined, '  ']) {
    const bare = await $.tool.call(noneCall(detail))
    expect(bare.deny).toContain('its reason in "detail"')
  }
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the files of the pull request cannot be read', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, filesFails: 'error: rate limited' })
  const out = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the files of acme/thing#12 cannot be read: error: rate limited')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the pull request lists no files yet', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: [] })
  const out = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the files of acme/thing#12 cannot be read: pr-files answered no files')
  expect(recordRun(seen)).toBeUndefined()
})

test('E2E not applicable is refused when the head moves while the files are read', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, files: DOCS_ONLY, heads: [HEAD, MOVED] })
  const out = await $.tool.call(noneCall('documentation only'))
  expect(out.deny).toContain('the head moved from 0123456 to fedcba9')
  expect(recordRun(seen)).toBeUndefined()
})

// ---- records carried across a rebase that leaves the diff unchanged ----

const OLD = 'abcdef0123456789abcdef0123456789abcdef01'
const OLD_DIR = RECORDS + '/acme/thing/' + OLD
const SAME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const fingerprintRuns = (seen: Seen) => seen.runs.filter((r) => r.command === 'pr-fingerprint')
  .map((r) => r.args?.['head'] + (r.args?.['count'] === undefined ? '' : ' x' + r.args?.['count']))
// Each world's earlier head directory has a new mtime, as a directory a record lands in does.
let earlierMtime = 0
const fingerprintFile = (head: string) => '/data/fingerprint.acme%2Fthing.12.' + head + '.json'

// The earlier head's records as the store holds them, beside the current head's directory, and the
// commit count a gate read found at that head (none when null).
function earlier(records: Array<[string, string]>, dir = OLD_DIR, commits: number | null = 2): NonNullable<World['tree']> {
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
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_LINE.slice(0, -1)
    + ' (review carried from abcdef0, norms carried from abcdef0, e2e carried from abcdef0).'])
  // Each head is fingerprinted once, the earlier one over the head's commit count: the second read takes both from the data directory.
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('a directory named like a record file, in an earlier head, is no unreadable record: the rebase still carries', async ($, on) => {
  const tree = { ...earlier(CLEAN_OLD), [OLD_DIR + '/nested.json']: { kind: 'dir' as const, mtimeMs: 0 } }
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
})

test('a rebase that leaves the diff unchanged carries the orchestrator\'s acceptance of the review', async ($, on) => {
  const accepted = at('review', 'accepted', { producer: 'orchestrator', detail: 'set aside: a.ts:3 — naming only' }, '2026-11-01T11:00:00Z')
  const tree = earlier([at('review', 'fail'), accepted, at('norms', 'pass'), at('e2e', 'waived', { detail: 'no E2E, 2026-11-01' })])
  await world($, on, { records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
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
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
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
  const out = await missingProbe($)
  expect(out.result).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
})

test('a second gate read with the records unchanged still reads Ready with the same carried kinds', async ($, on) => {
  const seen = await world($, on, { records: {}, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
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

// A head that merged the base: its commits cannot be told apart from the base's, its diff against the base can.
test('a head that merged the base carries the records of the head before the merge when the pull request\'s diff is unchanged', async ($, on) => {
  const seen = await world($, on, {
    records: {}, commits: 3, tree: earlier(CLEAN_OLD), merged: [HEAD], fingerprints: { [OLD]: SAME }, diffs: { [HEAD]: SAME, [OLD]: SAME },
  })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_LINE.slice(0, -1)
    + ' (review carried from abcdef0, norms carried from abcdef0, e2e carried from abcdef0).'])
  // The earlier head is read over its own commit count, not the head's.
  expect(fingerprintRuns(seen)).toEqual([HEAD + ' x3', OLD + ' x2'])
})

test('a head that merged the base carries nothing when the merge changed the pull request\'s diff (a conflict resolved in its files)', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], commits: 3, tree: earlier(CLEAN_OLD), merged: [HEAD], fingerprints: { [OLD]: SAME }, diffs: { [HEAD]: OTHER, [OLD]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: review: no record at 0123456;'
    + ' e2e carried from abcdef0'])
})

test('a head that merged the base carries from an earlier head that merged it too, whatever their commit counts', async ($, on) => {
  const seen = await world($, on, {
    records: {}, commits: 4, tree: earlier(CLEAN_OLD, OLD_DIR, 3), merged: [HEAD, OLD], diffs: { [HEAD]: SAME, [OLD]: SAME },
  })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(fingerprintRuns(seen)).toEqual([HEAD + ' x4', OLD + ' x3'])
})

test('a head with no merge carries from an earlier head that merged the base, of as many commits, when the diffs are the same', async ($, on) => {
  const seen = await world($, on, {
    records: {}, tree: earlier(CLEAN_OLD), merged: [OLD], fingerprints: { [HEAD]: SAME }, diffs: { [HEAD]: SAME, [OLD]: SAME },
  })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('an earlier head whose kept fingerprint holds no diff is asked again for it when the head merged the base', async ($, on) => {
  const tree = earlier(CLEAN_OLD)
  tree[fingerprintFile(OLD)] = { kind: 'file', mtimeMs: 0, text: JSON.stringify({ v: 3, repo: 'acme/thing', pr: 12, head: OLD, commits: 2, fingerprint: SAME }) }
  const seen = await world($, on, { records: {}, commits: 3, tree, merged: [HEAD], fingerprints: { [OLD]: SAME }, diffs: { [HEAD]: SAME, [OLD]: SAME } })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(fingerprintRuns(seen)).toEqual([HEAD + ' x3', OLD + ' x2'])
  expect(JSON.parse(String(seen.files[fingerprintFile(OLD)]))).toEqual({ v: 3, repo: 'acme/thing', pr: 12, head: OLD, commits: 2, fingerprint: SAME, diff: SAME })
})

test('a head whose own diff cannot be read is blamed, not the earlier head that merged the base', async ($, on) => {
  const seen = await world($, on, {
    records: {}, labels: ['Ready'], tree: earlier(CLEAN_OLD), merged: [OLD], fingerprints: { [HEAD]: SAME }, diffs: { [OLD]: SAME },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toBe('github: acme/thing#12: no review, norms record carried to 0123456: 0123456\'s commits cannot be fingerprinted: pr-fingerprint answered no fingerprint')
})

test('a head that merged the base carries nothing from an earlier head with another diff', async ($, on) => {
  await world($, on, {
    records: {}, labels: ['Ready'], commits: 3, tree: earlier(CLEAN_OLD), merged: [HEAD], fingerprints: { [OLD]: SAME }, diffs: { [HEAD]: SAME, [OLD]: OTHER },
  })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  const out = await missingProbe($)
  expect(out.result).toContain('Missing: review: no record at 0123456; e2e carried from abcdef0')
})

test('the records of another pull request with the same diff are never carried, nothing is fingerprinted', async ($, on) => {
  const tree = earlier(CLEAN_OLD.map(([name]) => at(String(name.split('.')[0]), name.startsWith('e2e') ? 'waived' : 'pass', { pr: 13, detail: 'no E2E, 2026-11-01' })))
  const seen = await world($, on, { records: {}, labels: ['Ready'], tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.logs[0]).toContain('Missing: review: no record at 0123456, e2e: no record at 0123456')
  expect(fingerprintRuns(seen)).toEqual([])
})

test('a refused merge names the records carried beside what is missing', async ($, on) => {
  const tree = earlier([at('review', 'pass'), at('norms', 'pass')])
  await world($, on, { autoMerge: ['acme/thing'], records: {}, tree, fingerprints: { [HEAD]: SAME, [OLD]: SAME }, ci: { result: 'FAILURE', failed: ['lint'] } })
  const out = await mergeProbe($)
  expect(out.deny).toContain('Missing: e2e: no record at 0123456, CI failed: lint; review carried from abcdef0, norms carried from abcdef0.')
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
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
  expect(JSON.parse(String(seen.files[fingerprintFile(OLD)]))).toEqual({ v: 3, repo: 'acme/thing', pr: 12, head: OLD, commits: 2, fingerprint: SAME })
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
  expect(JSON.parse(String(seen.files[fingerprintFile(HEAD)]))).toEqual({ v: 3, repo: 'acme/thing', pr: 12, head: HEAD, commits: 4 })
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
  const out = await missingProbe($)
  expect(out.result).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
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
  const out = await mergeProbe($)
  expect(out.deny).toContain('Missing: review: no record at 0123456, unreadable record review.20261102T100000Z.p-review.json;'
    + ' norms carried from abcdef0, e2e carried from abcdef0.')
  expect(fingerprintRuns(seen)).toEqual([HEAD, OLD + ' x2'])
})

test('a record that does not parse at the head and whose name gives no kind lets no kind be carried', async ($, on) => {
  const seen = await world($, on, { autoMerge: ['acme/thing'], records: { 'stray.json': 'not json' }, tree: earlier(CLEAN_OLD), fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  const out = await mergeProbe($)
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
    const out = await missingProbe($)
    expect(out.result).toContain('Missing: review: no record at 0123456; norms carried from abcdef0, e2e carried from abcdef0.')
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
  ({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', plan, ...over })
// The plan as the orchestrator's review tool sends it: a call from that plugin, its answer as text.
const planned = async ($: Engine, plan: unknown) =>
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

test('a plan that gives the review one pass is Not Ready with no review record', async ($, on) => {
  const plan = { ...planOf({ need: 'required' }), review: { need: 'required', reason: '', max: 1 } }
  const seen = await world($, on, { records: OTHERS_PASSED, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
})

test('a plan that gives the review one pass is Ready once the review record passes', async ($, on) => {
  const plan = { ...planOf({ need: 'required' }), review: { need: 'required', reason: '', max: 1 } }
  const seen = await world($, on, { records: { ...OTHERS_PASSED, ...ONLY_REVIEW }, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([['acme/thing', { pr: 12, state: 'ready' }]])
})

test('a plan file that still gives the review none leaves it owed', async ($, on) => {
  const plan = { ...planOf({ need: 'required' }), review: { need: 'none', reason: 'a typo' } }
  const seen = await world($, on, { records: OTHERS_PASSED, plan })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(readinessRuns(seen)).toEqual([])
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
  const out = await planned($, { e2e: 'none: docs only', norms: 'required' })
  expect(out.deny).toBeUndefined()
  expect(out.result).toContain('github: check plan of acme/thing#12: e2e none, norms required, review required: max 3')
  expect(out.result).toContain('Ready at 0123456')
  expect(JSON.parse(String(seen.files[PLAN]))).toMatchObject({ v: 1, repo: 'acme/thing', pr: 12, e2e: { need: 'none', reason: 'docs only' }, norms: { need: 'required', reason: '' } })
  const comment = seen.runs.find((r) => r.command === 'pr-comment')
  expect(comment?.args?.['pr']).toBe(12)
  expect(comment?.args?.['body']).toContain('- e2e: none — docs only')
  expect(recordRun(seen)).toBeUndefined()
})

test('pr-plan answers the pull request\'s check plan as it stands, its number with or without #, with no engine run', async ($, on) => {
  const seen = await world($, on, { plan: { ...planOf({ need: 'required' }), review: { need: 'required', reason: '', max: 2 } } })
  const out = await $.tool.call(gh('pr-plan', { pr: 12 }))
  expect(JSON.parse(String(out.result))).toMatchObject({ repo: 'acme/thing', pr: 12, review: { need: 'required', max: 2 } })
  const hashed = await $.tool.call(gh('pr-plan', { pr: '#12' }))
  expect(JSON.parse(String(hashed.result)).review.max).toBe(2)
  expect(seen.runs).toEqual([])
})

test('pr-plan says when the pull request has no check plan, or one that does not parse', async ($, on) => {
  await world($, on, { plan: planOf({ need: 'none', reason: '' }) })
  expect(((await $.tool.call(gh('pr-plan', { pr: 12 })))).result).toBe('no check plan for acme/thing#12')
  expect(((await $.tool.call(gh('pr-plan', { pr: 13 })))).result).toBe('no check plan for acme/thing#13')
  expect(((await $.tool.call(gh('pr-plan', {})))).isError).toBe(true)
})

test('pr-plan reads a former full plan file as a required review of the cap\'s rounds', async ($, on) => {
  await world($, on, { plan: planOf({ need: 'required' }) })
  expect(JSON.parse(String(((await $.tool.call(gh('pr-plan', { pr: 12 })))).result)).review).toEqual({ need: 'required', reason: '', max: 3 })
})

test('a plan is refused when a need other than required gives no reason, or a need is unknown', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on)
  for (const plan of [{ e2e: 'none', norms: 'required' }, { e2e: 'required', norms: 'screenshots: x' }, { e2e: 'maybe' }, { review: 'maybe' }, []]) {
    expect((await planned($, plan)).deny).toContain('github: a check plan is')
  }
  expect(seen.files[PLAN]).toBeUndefined()
})

test('a new plan replaces the previous one, whatever it requires', reviewing('orchestrator'), async ($, on) => {
  const seen = await world($, on, { plan: planOf({ need: 'none', reason: 'docs only' }) })
  const stricter = await planned($, { e2e: 'required', norms: 'required' })
  expect(stricter.deny).toBeUndefined()
  expect(JSON.parse(String(seen.files[PLAN])).e2e.need).toBe('required')
  const lighter = await planned($, { e2e: 'none: changed my mind', norms: 'none: small', review: 'one-pass: small' })
  expect(lighter.deny).toBeUndefined()
  expect(JSON.parse(String(seen.files[PLAN])).e2e.need).toBe('none')
})

test('an E2E waiver is refused when the plan needs no E2E: nothing was planned to waive', async ($, on) => {
  const seen = await world($, on, { git: CLEAN, plan: planOf({ need: 'none', reason: 'docs only' }) })
  const words = 'no E2E for this docs change, 2026-11-02'
  await ($).prompt.submit({ text: words, origin: { kind: 'composer' }, wait: false })
  const out = await $.tool.call(waiveCall(words))
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


test('the plan files are written through Write, observed, and deleted through Bash, refused', async ($, on) => {
  const seen = await world($, on)
  expect(((await $.tool.call({ tool: 'Write', file_path: PLAN, content: '{}' }))).deny).toBeUndefined()
  expect(seen.journal).toEqual(['github.exemption.write'])
  expect(((await $.tool.call(bash('touch "$CLAUDE_PLUGIN_DATA/check-plans/acme/12.json"')))).deny).toBeUndefined()
  expect(seen.journal).toEqual(['github.exemption.write', 'github.exemption.write'])
  expect(((await $.tool.call(bash('rm -rf "$CLAUDE_PLUGIN_DATA/check-plans/acme"')))).deny).toBe(EXEMPT_REFUSAL)
  expect(seen.journal.length).toBe(3)
})

// ---- who writes the plan ----

test('a plan from the model itself, as an implementer would send it, is refused and writes nothing', async ($, on) => {
  const seen = await world($, on)
  const out = await $.tool.call(planCall({ e2e: 'none: docs only' }))
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
const askWaiver = ($: Engine, question = WAIVER_Q, labels = ['Accorder', 'Refuser']) => $.tool.call({
  tool: 'AskUserQuestion',
  questions: [{ question, header: 'E2E', multiSelect: false, options: labels.map((label) => ({ label, description: label })) }],
})
const consentWrites = (seen: Seen) => seen.writes.filter((w) => w.path.startsWith(CONSENTS + '/dialog-')).map((w) => JSON.parse(w.text))
// What the dialog's answer leaves, the module's date being its clock's.
const DIALOG = { v: 1, subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 12 }, question: WAIVER_Q, by: 'tab', at: '2026-11-02T12:00:00Z' }
const granted = (over: Record<string, unknown> = {}) => consent({ answer: 'Accorder', ...over })


test('a waiver dialog records nothing: a waiver rests on his quoted, dated words', async ($, on) => {
  const seen = await world($, on, { answer: 'Accorder' })
  await askWaiver($)
  await askWaiver($, WAIVER_Q, ['Accorder', 'Plus tard'])
  await askWaiver($, 'Merge acme/thing#12 ?')
  expect(consentWrites(seen)).toEqual([])
})



for (const [label, records] of [
  ['a « Refuser »', { a: consent({ answer: 'Refuser' }) }],
  ['a « Refuser » after an « Accorder »', { a: granted(), b: consent({ entry: 'b', answer: 'Refuser', at: '2026-11-04T10:00:00Z' }) }],
  ['an « Accorder » of another pull request', { a: granted({ subject: { kind: 'e2e-waiver', repo: 'acme/thing', pr: 13 } }) }],
  ['an answer that is no choice of the question', { a: consent() }],
  ['an « Accorder »', { a: granted() }],
] as const) {
  test('with ' + label + ' the E2E is not waived', async ($, on) => {
    const seen = await world($, on, { records: TWO, labels: ['Ready'], ...consentWorld(records) })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(seen.logs).toEqual(['github: acme/thing#12 back to Not Ready at 0123456. Missing: e2e: no record at 0123456'])
  })
}



// ---- the operator's quoted words, with their date: from any channel, no consent record ----

const QUOTED = 'operator, 2026-11-03: ' + CONSENT_WORDS
const NO_CONSENT_FILE = (seen: Seen) => Object.keys(seen.files).filter((path) => path.includes('/consents/'))

test('an E2E waiver quoting the operator\'s dated words is written as given, with no consent record', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out = await $.tool.call(waiveCall(QUOTED))
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv[argv.indexOf('--kind') + 1]).toBe('e2e')
  expect(argv[argv.indexOf('--result') + 1]).toBe('waived')
  expect(argv[argv.indexOf('--detail') + 1]).toBe(QUOTED)
  expect(NO_CONSENT_FILE(seen)).toEqual([])
})

test('an E2E waiver is written over a recorded « Refuser »: his later words, quoted, stand', async ($, on) => {
  const seen = await world($, on, consentWorld({ a: consent({ answer: 'Refuser' }) }))
  const out = await $.tool.call(waiveCall(QUOTED))
  expect(out.deny).toBeUndefined()
  expect(recordRun(seen)).toBeDefined()
})

for (const [why, detail] of UNQUOTED) {
  test('an E2E waiver with ' + why + ' is refused, and says what to quote', async ($, on) => {
    const seen = await world($, on)
    const out = await $.tool.call(waiveCall(detail))
    expect(out.deny).toContain('github: an E2E waiver rests on the operator\'s words, quoted in "detail" with their date')
    expect(recordRun(seen)).toBeUndefined()
  })
}

// ---- the operator's waiver of required norms: the same question, naming the check ----

const NORMS_Q = 'Dispense de normes pour acme/thing#12 : the plan required the norms check, the repository has no CONTRIBUTING.md'
// A plan that requires norms and needs no E2E: the review alone is recorded at the head.
const NORMS_REQUIRED = planOf({ need: 'none', reason: 'docs only' })
const normsAnswer = (answer: string, over: Record<string, unknown> = {}) =>
  consent({ subject: { kind: 'norms-waiver', repo: 'acme/thing', pr: 12 }, question: NORMS_Q, answer, ...over })
const NORMS_MISSING = 'github: acme/thing#12 back to Not Ready at 0123456. Missing: norms: no record at 0123456'



for (const [label, records] of [
  ['his « Refuser »', { a: normsAnswer('Refuser') }],
  ['an « Accorder » of the E2E only', { a: granted() }],
  ['his « Accorder »', { a: normsAnswer('Accorder') }],
] as const) {
  test('norms required by the plan with ' + label + ' stay missing', async ($, on) => {
    const seen = await world($, on, { records: ONLY_REVIEW, plan: NORMS_REQUIRED, labels: ['Ready'], ...consentWorld(records) })
    await $.tool.call(gh('pr-gate', { pr: 12 }))
    expect(seen.logs).toHaveLength(1)
    expect(seen.logs[0]).toStartWith(NORMS_MISSING)
    expect(seen.logs[0]).not.toContain('norms waived')
  })
}


test('a norms waiver quoting the operator\'s dated words is written as given, with no consent record', reviewing('norms'), async ($, on) => {
  const seen = await world($, on, { plan: NORMS_REQUIRED, git: CLEAN })
  const out = await verdict($, { kind: 'norms', result: 'waived', detail: QUOTED })
  expect(out.deny).toBeUndefined()
  const argv = recordRun(seen)!
  expect(argv[argv.indexOf('--kind') + 1]).toBe('norms')
  expect(argv[argv.indexOf('--detail') + 1]).toBe(QUOTED)
  expect(NO_CONSENT_FILE(seen)).toEqual([])
})

test('a norms waiver with no quoted words is refused', reviewing('norms'), async ($, on) => {
  const seen = await world($, on, { plan: NORMS_REQUIRED, ...consentWorld({ a: normsAnswer('Accorder') }) })
  const out = await verdict($, { kind: 'norms', result: 'waived', detail: '' })
  expect(out.deny).toContain('github: a norms waiver rests on the operator\'s words, quoted in "detail" with their date')
  expect(recordRun(seen)).toBeUndefined()
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
const AUTO_DEPLOY_WORDS = '« infra passe en auto-deploy », 2026-11-18T19:35Z'
const setDeploy = (on: boolean, words: string, env = 'prod', extra: Record<string, unknown> = {}, repo = INFRA) =>
  gh('auto-deploy-set', { repo, env, on, words, ...extra }, undefined)
const deployGrants = (seen: Seen) => JSON.parse(String(seen.files[AUTO_DEPLOY])).repositories

test('a deploy of a repository the list does not grant for that environment is refused, and never runs', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out = await $.tool.call(bash(PROD_DEPLOY))
  expect(out.deny).toContain('acme/infra is not in the deploy list for prod')
  expect(out.deny).toContain('auto-deploy-set')
  expect(out.deny).not.toContain('\n')
  expect(seen.bash).toEqual([])
})

test('a deploy the list grants is not refused, whatever else the line does', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out = await $.tool.call(bash('composer deploy:api:staging'))
  expect(out.deny).toBeUndefined()
  expect(seen.bash).toEqual(['composer deploy:api:staging'])
})

test('a workflow, a skill and a script are refused the same way, and a deploy of no declared path is not read', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const flow = await $.tool.call(bash('gh workflow run deploy.yml -f environment=prod'))
  expect(flow.deny).toContain('acme/site is not in the deploy list for prod')
  const skill = await $.tool.call({ tool: 'Skill', skill: 'infra-deploy-prod' })
  expect(skill.deny).toContain('acme/infra is not in the deploy list for prod')
  expect(seen.skills).toEqual([])
  const undeclared = await $.tool.call(bash('./scripts/other-deploy.sh prod'))
  expect(undeclared.deny).toBeUndefined()
  expect(seen.bash).toEqual(['./scripts/other-deploy.sh prod'])
})

test('a listed skill runs', async ($, on) => {
  const seen = await world($, on, { deployList: deployList([INFRA, 'prod']) })
  const out = await $.tool.call({ tool: 'Skill', skill: 'infra-deploy-prod' })
  expect(out.deny).toBeUndefined()
  expect(seen.skills).toEqual(['infra-deploy-prod'])
})

test('the list only denies: a granted deploy and an undeclared prod path both stay with the host\'s own decision', async ($, on) => {
  await world($, on, { deployList: deployList([INFRA, 'prod']), verdict: { decision: 'ask' } })
  for (const line of [PROD_DEPLOY, 'ssh deploy@api.prod.example.net ./release.sh']) {
    expect(((await $.tool.check({ tool: 'Bash', input: { command: line } }))).decision, line).toBe('ask')
  }
})

test('a deploy whose environment the call does not name is refused', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  const out = await $.tool.call(bash('gh workflow run deploy.yml'))
  expect(out.deny).toContain('its environment is none of dev, staging, prod')
  expect(seen.bash).toEqual([])
})

test('with no grant in the file every declared deploy is refused', async ($, on) => {
  const none = await world($, on, { deployList: { commands: DEPLOYS } })
  expect(((await $.tool.call(bash('composer deploy:api:staging')))).deny).toContain('not in the deploy list for staging')
  expect(none.bash).toEqual([])
})

test('a list that cannot be read lists nothing and says so in one line, and a deploy meets the host\'s decision', async ($, on) => {
  const seen = await world($, on, { deployList: '{not json' })
  const out = await $.tool.call(bash('composer deploy:api:prod'))
  expect(out.deny).toBeUndefined()
  expect(seen.logs.some((l) => l.includes('auto-deploy.json') && l.includes('unread'))).toBe(true)
})

// A world holding the operator's answer `text` to a round question asking auto-deploy of acme/infra on `env`.
function deployWorld(text: string = CONSENT_GRANT, env = 'prod', over: World = {}): World {
  const answered = consentWorld({
    a: consent({ subject: { kind: 'auto-deploy', repo: INFRA, env }, question: 'Auto-deploy infra on ' + env + '?', answer: text, by: 'coordinator' }),
  }, '/cfg/consents/acme/infra')
  return { ...answered, ...over, tree: { ...answered.tree, ...over.tree } }
}

test('auto-deploy-set grants one environment of a repository on the operator\'s quoted, dated words', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', STAGING_ONLY))
  const set = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod'))
  expect(set.deny).toBeUndefined()
  expect(set.isError).toBeUndefined()
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }, { repo: INFRA, env: 'prod' }])
  expect(JSON.parse(String(seen.files[AUTO_DEPLOY])).commands).toEqual(DEPLOYS)
  expect(((await $.tool.call(bash(PROD_DEPLOY)))).deny).toBeUndefined()
})

test('words with no date are no consent: a list change is refused and writes nothing', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  for (const words of ['oui', CONSENT_GRANT, 'infra passe en auto-deploy']) {
    const out = await $.tool.call(setDeploy(true, words))
    expect(out.deny, words).toContain('github: auto-deploy-set rests on the operator\'s words, quoted in "words" with their date')
  }
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
  expect(seen.writes).toEqual([])
})








test('auto-deploy-set on adds the declared commands on his dated words too', async ($, on) => {
  const seen = await world($, on, deployWorld())
  const declared = { kind: 'script', path: 'scripts/deploy.sh' }
  const out = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', { commands: [declared] }))
  expect(out.deny).toBeUndefined()
  expect(JSON.parse(String(seen.files[AUTO_DEPLOY])).commands).toContainEqual({ repo: INFRA, ...declared })
})

// Two answers to the same question: the newest one is the operator's word.
const answers = (older: string, newer: string): World => consentWorld({
  a: consent({ subject: { kind: 'auto-deploy', repo: INFRA, env: 'prod' }, entry: 'a', answer: older, by: 'coordinator', at: '2026-11-03T10:00:00Z' }),
  b: consent({ subject: { kind: 'auto-deploy', repo: INFRA, env: 'prod' }, entry: 'b', answer: newer, by: 'coordinator', at: '2026-11-04T10:00:00Z' }),
}, '/cfg/consents/acme/infra')





test('auto-deploy-set off takes the environment out, and the deploy is refused again', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { deployList: deployList([INFRA, 'staging'], [INFRA, 'prod']) }))
  expect(((await $.tool.call(setDeploy(false, AUTO_DEPLOY_WORDS, 'prod')))).deny).toBeUndefined()
  expect(deployGrants(seen)).toEqual([{ repo: INFRA, env: 'staging' }])
  expect(((await $.tool.call(bash(PROD_DEPLOY)))).deny).toContain('not in the deploy list for prod')
})

test('auto-deploy-set names a repository and an environment, and says in or out', async ($, on) => {
  const seen = await world($, on, deployWorld())
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', {}, 'infra')))).deny).toContain('owner/name')
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'production')))).deny).toContain('"env"')
  expect(((await $.tool.call(gh('auto-deploy-set', { repo: INFRA, env: 'prod', words: AUTO_DEPLOY_WORDS }, undefined)))).deny).toContain('{"on": true}')
  expect(seen.writes).toEqual([])
})

test('auto-deploy-set adds the commands a repository declares as its deploys, and refuses a malformed one', async ($, on) => {
  const seen = await world($, on, deployWorld())
  const declared = { kind: 'script', path: 'scripts/deploy.sh' }
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', { commands: [declared] })))).deny).toBeUndefined()
  expect(JSON.parse(String(seen.files[AUTO_DEPLOY])).commands).toEqual([{ repo: INFRA, ...declared }])
  const bad = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS, 'prod', { commands: [{ kind: 'cron' }] }))
  expect(bad.deny).toContain('"script", a "workflow" or a "skill"')
  expect(JSON.parse(String(seen.files[AUTO_DEPLOY])).commands).toEqual([{ repo: INFRA, ...declared }])
})

test('auto-deploy-set holds the file\'s lock, and releases it', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', STAGING_ONLY))
  await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))
  expect(seen.runs.filter((r) => r.argv?.includes(AUTO_DEPLOY + '.lock')).map((r) => r.argv[0])).toEqual(['sh', 'rm'])
})

test('a malformed deploy list is never overwritten', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { deployList: '{"repositories": [1]}' }))
  const out = await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS))
  expect(out.isError).toBe(true)
  expect(seen.files[AUTO_DEPLOY]).toBe('{"repositories": [1]}')
})

test('auto-deploy-set denied by a permission rule is refused', async ($, on) => {
  const seen = await world($, on, deployWorld(CONSENT_GRANT, 'prod', { verdict: { decision: 'deny', reason: 'no' } }))
  expect(((await $.tool.call(setDeploy(true, AUTO_DEPLOY_WORDS)))).deny).toBe('no')
  expect(seen.writes).toEqual([])
})

test('auto-deploy-list prints each environment granted', async ($, on) => {
  await world($, on, { deployList: deployList([INFRA, 'staging'], ['acme/site', 'dev']) })
  expect(((await $.tool.call(gh('auto-deploy-list', {}, undefined)))).result).toBe('acme/infra staging\nacme/site dev')
})

test('auto-deploy-list says when no repository is in auto-deploy', async ($, on) => {
  await world($, on)
  expect(((await $.tool.call(gh('auto-deploy-list', {}, undefined)))).result).toBe('no repository in auto-deploy')
})

test('the deploy list is refused to Write, Edit and Bash, and a read of it is not', async ($, on) => {
  const seen = await world($, on, STAGING_ONLY)
  for (const tool of ['Write', 'Edit']) {
    const out = await $.tool.call({ tool, file_path: AUTO_DEPLOY, content: '{}' })
    expect(out.deny, tool).toContain('the deploy list changes only through mcp__github__gh auto-deploy-set')
  }
  const home = await $.tool.call({ tool: 'Write', file_path: '/home/x/.claude/plugins/data/github-lounisbou/auto-deploy.json', content: '{}' })
  expect(home.deny).toContain('auto-deploy-set')
  for (const line of ['echo \'{}\' > /data/auto-deploy.json', 'cd ~/.claude/plugins/data/github-lounisbou && jq . auto-deploy.json > x && mv x auto-deploy.json']) {
    expect(((await $.tool.call(bash(line)))).deny, line).toContain('auto-deploy-set')
  }
  expect(seen.bash).toEqual([])
  expect(((await $.tool.call(bash('grep -n auto-deploy.json README.md')))).deny).toBeUndefined()
})

// ---- the light CI of a stacked pull request ----

const LIGHT_CI_FILE = '/cfg/light-ci/acme-thing.json'
const lightCiRun = (seen: Seen) => seen.runs.find((r) => String(r.argv[1]).endsWith('/engine/light_ci.py'))
const PENDING = { ci: { result: 'PENDING', running: 1 } }
const READY_BEFORE_CI = READY_LINE.slice(0, READY_LINE.indexOf(' green CI'))
// A repository whose light CI the operator configured: its stacked pull requests need their tests.
const LIGHT_CI_ON = { [LIGHT_CI_FILE]: { kind: 'file' as const, mtimeMs: 0, text: JSON.stringify({ command: ['npm', 'test'] }) } }

test('a stacked pull request with neither a tests record nor its checks green is not ready, and the gate names the light CI', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, tree: LIGHT_CI_ON })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out).toEqual({ result: 'github: acme/thing#12 carries Not Ready at 0123456, Ready not put: not ready. Missing: tests: no record at'
    + ' 0123456 and its checks not green: stacked on feat-a, run mcp__github__light_ci {"action": "run", "pr": 12} from a clean checkout of its head.' })
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a stacked pull request is ready on its review and the light CI\'s tests passed at its head, CI still pending', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, tree: LIGHT_CI_ON, records: { ...FOUR, ...Object.fromEntries([record('tests', 'pass', '2026-11-01T10:00:00Z', { producer: 'light-ci' })]) } })
  const out = await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(JSON.parse(String(out.result)).labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_BEFORE_CI + ' passed local tests (light-ci) hold at its head.'])
})

test('a tests record from another producer stands for nothing on a stacked pull request', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, tree: LIGHT_CI_ON, records: { ...FOUR, ...Object.fromEntries([record('tests', 'pass')]) } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a stacked pull request with no tests record is ready on its checks green, and the line says green CI', async ($, on) => {
  const seen = await world($, on, { stacked: true, tree: LIGHT_CI_ON })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_LINE])
})

test('a failed tests run, or a failed check, keeps a stacked pull request not ready over the other', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, tree: LIGHT_CI_ON, records: { ...FOUR, ...Object.fromEntries([record('tests', 'fail', '2026-11-01T10:00:00Z', { producer: 'light-ci', detail: 'npm test — exit 1 — 4s' })]) } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.result).toEndWith('Missing: tests: fail at 0123456 by light-ci, npm test — exit 1 — 4s.')
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a stacked pull request whose checks are green at its head is ready over a failed local run', async ($, on) => {
  const seen = await world($, on, { stacked: true, tree: LIGHT_CI_ON, records: { ...FOUR, ...Object.fromEntries([record('tests', 'fail', '2026-11-01T10:00:00Z', { producer: 'light-ci', detail: 'npm test — exit 1 — 4s' })]) } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
})

test('a failed local run keeps a stacked pull request of a repository with no CI at all not ready', async ($, on) => {
  const seen = await world($, on, { stacked: true, tree: LIGHT_CI_ON, ci: { result: 'NONE' },
    records: { ...FOUR, ...Object.fromEntries([record('tests', 'fail', '2026-11-01T10:00:00Z', { producer: 'light-ci', detail: 'npm test — exit 1 — 4s' })]) } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.result).toEndWith('Missing: tests: fail at 0123456 by light-ci, npm test — exit 1 — 4s.')
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a stacked pull request of a repository with no light CI file is ready on its review when no check runs at its head, the line saying so', async ($, on) => {
  const seen = await world($, on, { stacked: true, ci: { result: 'NONE', total: 0, running: 0 } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_BEFORE_CI + ' no light CI configured for this repository hold at its head.'])
})

test('a stacked pull request of a repository with no light CI file is not ready while its check runs, CI still running', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.result).toEndWith('Missing: CI still running.')
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a check that failed at a stacked pull request\'s head blocks it though its tests passed, and the gate refuses its merge', async ($, on) => {
  await world($, on, { stacked: true, tree: LIGHT_CI_ON, autoMerge: ['acme/thing'], ci: { result: 'FAILURE', failed: ['lint'] },
    records: { ...FOUR, ...Object.fromEntries([record('tests', 'pass', '2026-11-01T10:00:00Z', { producer: 'light-ci' })]) } })
  const out = await $.tool.call(gh('pr-merge', { pr: 12 }))
  expect(out.deny).toBe('github: pr-merge refused on acme/thing#12 at 0123456: not ready. Missing: CI failed: lint.' + REFUSAL_END)
})

test('the bottom pull request is unchanged: a tests record stands for no CI, and its merge waits on GitHub\'s check', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: false, records: { ...FOUR, ...Object.fromEntries([record('tests', 'pass', '2026-11-01T10:00:00Z', { producer: 'light-ci' })]) } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out).toEqual({ result: 'github: acme/thing#12 carries Not Ready at 0123456, Ready not put: not ready. Missing: CI still running.' })
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a stacked pull request of a repository whose light CI the operator refused is ready on its review when no check runs at its head, the line saying so with its date', async ($, on) => {
  const seen = await world($, on, { stacked: true, ci: { result: 'NONE', total: 0, running: 0 },
    tree: { [LIGHT_CI_FILE]: { kind: 'file', mtimeMs: 0, text: JSON.stringify({ off: 'non, pas pour ce projet', at: '2026-11-14T18:30:00Z' }) } } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
  expect(seen.logs).toEqual([READY_BEFORE_CI + ' the operator\'s refusal of light CI for this repository (2026-11-14) hold at its head.'])
})

test('a stacked pull request of a repository whose light CI the operator refused is not ready while its check runs, CI still running', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true,
    tree: { [LIGHT_CI_FILE]: { kind: 'file', mtimeMs: 0, text: JSON.stringify({ off: 'non, pas pour ce projet', at: '2026-11-14T18:30:00Z' }) } } })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.result).toEndWith('Missing: CI still running.')
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a Ready pull request that conflicts with its base moves to Not Ready, and the answer names the conflict', async ($, on) => {
  const seen = await world($, on, { labels: ['Ready'], mergeable: false, mergeable_state: 'dirty' })
  const out = await $.tool.call(gh('pr-readiness', { pr: 12, state: 'ready' }))
  expect(out.result).toEndWith('Missing: conflict with base.')
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a light CI file that cannot be read refuses nothing', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true,
    tree: { [LIGHT_CI_FILE]: { kind: 'file', mtimeMs: 0, text: '{"off": ' } } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Not Ready'])
})

test('a rebase that leaves a stacked pull request\'s diff unchanged carries its tests record', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, records: {},
    tree: { ...LIGHT_CI_ON, ...earlier([...CLEAN_OLD, at('tests', 'pass', { producer: 'light-ci' })]) }, fingerprints: { [HEAD]: SAME, [OLD]: SAME } })
  await $.tool.call(gh('pr-gate', { pr: 12 }))
  expect(seen.pull?.labels).toEqual(['Ready'])
  expect(seen.logs[0]).toContain('passed local tests (light-ci) hold at its head')
  expect(seen.logs[0]).toContain('tests carried from abcdef0')
})

test('the model may not record tests through the record tool, which names the light CI', async ($, on) => {
  const seen = await world($, on, { git: CLEAN })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', kind: 'tests', result: 'pass' })
  expect(out.deny).toBe('github: tests records are written by mcp__github__light_ci alone, from the run of the project\'s command: this tool writes e2e only.')
  expect(recordRun(seen)).toBeUndefined()
})

test('light_ci run runs the script in the checkout named with the session, then the gate follows its record', async ($, on) => {
  const seen = await world($, on, { ...PENDING, stacked: true, tree: { ...CHECKOUTS, ...LIGHT_CI_ON }, gitIn: { [REVIEW_DIR]: REVIEW_ORIGIN },
    lightCi: { exitCode: 0, stdout: 'tests pass at 0123456 of acme/thing#12: npm test — exit 0 — 9s; output /tmp/x.log; record /r.json\n', stderr: '', result: 'pass' } })
  const out = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12, dir: REVIEW_DIR })
  const run = lightCiRun(seen)!
  expect(run.argv.slice(2, 6)).toEqual(['run', '--pr', '12', '--session'])
  expect(run.argv[6]).toContain('guard-session-')
  expect(run.argv.slice(7)).toEqual(['--budget', '570'])
  expect(out.result).toBe('tests pass at 0123456 of acme/thing#12: npm test — exit 0 — 9s; output /tmp/x.log; record /r.json\n'
    + READY_BEFORE_CI + ' passed local tests (light-ci) hold at its head.')
  expect(seen.pull?.labels).toEqual(['Ready'])
})

const forgeRun = (seen: Seen) => seen.runs.filter((r) => String(r.argv[1]).endsWith('/engine/forge_status.py')).map((r) => r.argv.slice(2))
const flagOf = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1]

test('a record the tool writes is posted to the forge at its head at once', async ($, on) => {
  const written = HEAD_DIR + '/e2e.20261102T100000Z.session-e2e.json'
  const [, text] = record('e2e', 'pass', '2026-11-02T10:00:00Z', { producer: 'session-e2e' })
  const seen = await world($, on, { git: CLEAN, labels: ['Ready'], tree: { [written]: { kind: 'file', mtimeMs: 1, text } } })
  const out = await $.tool.call({ tool: 'mcp__github__record', pr: 12, repo: 'acme/thing', result: 'pass', run: E2E_RUN })
  expect(out.result).toBe(written)
  const posts = forgeRun(seen)
  expect(posts).toHaveLength(1)
  expect(['--repo', '--head', '--what', '--state', '--description'].map((name) => flagOf(posts[0] ?? [], name)))
    .toEqual(['acme/thing', HEAD, 'e2e', 'success', 'v1 2026-11-02T10:00:00Z pass session-e2e'])
})

test('light_ci run posts the record its line names, and a post refused is one line, the answer unchanged', async ($, on) => {
  const [name] = record('tests', 'pass', '2026-11-02T10:00:00Z')
  const line = 'tests pass at 0123456 of acme/thing#12: npm test — exit 0 — 9s; output /tmp/x.log; record ' + HEAD_DIR + '/' + name + '\n'
  const seen = await world($, on, { ...PENDING, stacked: true, tree: { ...CHECKOUTS, ...LIGHT_CI_ON }, gitIn: { [REVIEW_DIR]: REVIEW_ORIGIN },
    lightCi: { exitCode: 0, stdout: line, stderr: '', result: 'pass' }, forgeFails: 'error: cannot post: HTTP 403' })
  const out = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12, dir: REVIEW_DIR })
  expect(forgeRun(seen).map((argv) => flagOf(argv, '--what') + ' ' + flagOf(argv, '--description'))).toEqual(['tests v1 2026-11-02T10:00:00Z pass light-ci'])
  expect(out.result).toBe(line + READY_BEFORE_CI + ' passed local tests (light-ci) hold at its head.')
  expect(seen.logs.filter((log) => log.startsWith('github: the record is not copied to the forge yet'))).toEqual([
    'github: the record is not copied to the forge yet (error: cannot post: HTTP 403): the reconciler copies it at a later beat.',
  ])
})

test('a record written in an archived repository is not posted again, and its note does not promise a later copy', async ($, on) => {
  const [name] = record('tests', 'pass', '2026-11-02T10:00:00Z')
  const line = 'tests pass at 0123456 of acme/thing#12: npm test — exit 0 — 9s; output /tmp/x.log; record ' + HEAD_DIR + '/' + name + '\n'
  const seen = await world($, on, { ...PENDING, stacked: true, tree: { ...CHECKOUTS, ...LIGHT_CI_ON }, gitIn: { [REVIEW_DIR]: REVIEW_ORIGIN },
    lightCi: { exitCode: 0, stdout: line, stderr: '', result: 'pass' }, forgeFails: 'error: cannot post tests at 0123456: Repository was archived so is read-only.' })
  await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12, dir: REVIEW_DIR })
  await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12, dir: REVIEW_DIR })
  expect(forgeRun(seen)).toHaveLength(1)
  expect(seen.logs.filter((log) => log.includes('later beat'))).toEqual([])
  expect(seen.logs.filter((log) => log.includes('acme/thing is archived (read-only)'))).toHaveLength(1)
})

test('light_ci run that writes nothing is an error with its line, and the gate is not read', async ($, on) => {
  const seen = await world($, on, { lightCi: { exitCode: 1, stdout: '', stderr: 'error: acme/thing has no light CI: no /cfg/light-ci/acme-thing.json\n' } })
  const out = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12, repo: 'acme/thing' })
  expect(out).toEqual({ result: 'error: acme/thing has no light CI: no /cfg/light-ci/acme-thing.json', isError: true })
  expect(gates(seen)).toBe(0)
})

test('light_ci status answers the script\'s line; a call with no action, no pull request or a bad repository is refused', async ($, on) => {
  const seen = await world($, on, { lightCi: { exitCode: 0, stdout: 'acme/thing: off: non, 2026-11-14; /cfg/light-ci/acme-thing.json\n', stderr: '' } })
  const status = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'status', repo: 'acme/thing' })
  expect(status).toEqual({ result: 'acme/thing: off: non, 2026-11-14; /cfg/light-ci/acme-thing.json' })
  expect(lightCiRun(seen)!.argv.slice(2)).toEqual(['status', '--repo', 'acme/thing'])
  const none = await $.tool.call({ tool: 'mcp__github__light_ci' })
  expect(none.deny).toContain('takes {"action": "run", "pr": <n>} or {"action": "status"}')
  const noPr = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run' })
  expect(noPr.deny).toBe('github: name the pull request: {"action": "run", "pr": <n>}')
  const badRepo = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'status', repo: 'thing' })
  expect(badRepo.deny).toBe('github: repo is owner/name, got: thing')
  const relative = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'status', dir: 'co' })
  expect(relative.deny).toBe('github: dir is the absolute path of the checkout, got: co')
})

test('light_ci refused by a permission rule runs nothing', async ($, on) => {
  const seen = await world($, on, { verdict: { decision: 'deny', reason: 'no light CI here' } })
  const out = await $.tool.call({ tool: 'mcp__github__light_ci', action: 'run', pr: 12 })
  expect(out.deny).toBe('no light CI here')
  expect(lightCiRun(seen)).toBeUndefined()
})

test('a session posting a commit status from the shell is refused and journaled, nothing run; reading the statuses passes', async ($, on) => {
  const seen = await world($, on)
  const post = await $.tool.call(bash('gh api repos/acme/app/statuses/' + 'a'.repeat(40) + ' -f state=success -f context=readiness/review'))
  expect(post.deny).toBe(STATUS_REFUSAL)
  expect(seen.journal).toEqual(['github.status.write'])
  const read = await $.tool.call(bash('gh api repos/acme/app/commits/' + 'a'.repeat(40) + '/statuses'))
  expect(read.deny).toBeUndefined()
  expect(seen.bash).toEqual(['gh api repos/acme/app/commits/' + 'a'.repeat(40) + '/statuses'])
})
