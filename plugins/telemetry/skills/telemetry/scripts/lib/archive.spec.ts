// The archive of closed work: what the plan names from a fixture state with a closed and an open
// row, and what the export does with it against a real scratch repository: the closed row's files
// land under `<project>/<YYYY-MM>/`, leave the machine only once the push is done, and the open row's
// stay; a refused push removes nothing; the secret scan holds a file back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { archiveProject, planArchive } from './archive.ts'
import { exportStore, type Git } from './export.ts'

const SECRET = ['sk-', 'ant-', 'api03-', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gj'].join('')
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const NOW = Date.parse('2026-11-15T12:00:00Z')

const git: Git = (args, cwd) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, HOME: cwd ?? tmpdir() } })
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const row = (fields: Record<string, unknown>): string => `${JSON.stringify({ tier: 'standard', rounds: 1, cascade: false, verdict: '', ...fields })}\n`

/** A brief as the orchestrator writes it: its report is named by the path it had when the brief was written, in a state directory that may since have moved. */
const brief = (id: number, report: string, dir: string): string => `# a brief\n\nRow: ${id} LABEL: what\nReport: /old-state/briefs/${basename(dir)}/${report}\n\nbody\n`

/** A module directory with one project, `demo`: row 1 closed in October, row 2 closed in November, row 3 open. */
function fixture(root: string): { module: string; dir: string } {
  const module = join(root, 'config', 'claude-orchestrator')
  const dir = join(module, 'briefs', 'demo')
  put(join(dir, 'dispatch-record.jsonl'), [
    row({ id: 1, state: 'closed', opened: '2026-10-19T09:00:00Z', closed: '2026-10-20T10:00:00Z', label: 'ONE: first', verdict: 'merged; report-shared.md and report-one-brief.md', review: { verdict: { findings: join(dir, 'review-1-r1-index.md') } } }),
    row({ id: 2, state: 'closed', opened: '2026-11-02T09:00:00Z', closed: '2026-11-03T10:00:00Z', label: 'TWO: second' }),
    row({ id: 3, state: 'open', opened: '2026-11-14T09:00:00Z', label: 'THREE: third', note: 'reads report-shared.md first' }),
    `${JSON.stringify({ v: 1, ledger: 'pr', repo: 'o/r', pr: 9, status: 'working', agent: 'Agent: x', since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:00:00Z' })}\n`,
  ].join(''))
  put(join(dir, 'one-brief.md'), brief(1, 'report-one-brief.md', dir))
  put(join(dir, 'report-one-brief.md'), 'the report of row one\n')
  put(join(dir, 'review-1-r1-index.md'), 'the index of row one\n')
  put(join(dir, 'review-1-r1-index', '1.md'), 'finding 1\n')
  put(join(dir, 'review-1-r1-index', '2.md'), 'finding 2\n')
  put(join(dir, 'report-shared.md'), 'named by a closed row and by an open one\n')
  put(join(dir, 'two-brief.md'), brief(2, 'report-two-brief.md', dir))
  put(join(dir, 'report-two-brief.md'), 'the report of row two\n')
  put(join(dir, 'three-brief.md'), brief(3, 'report-three-brief.md', dir))
  put(join(dir, 'report-three-brief.md'), 'the report of the open row\n')
  put(join(dir, 'orphan.md'), 'no row names this file\n')
  put(join(dir, 'plans', 'next.md'), 'a plan\n')
  put(join(dir, 'dispatch-record.archive.jsonl'), [
    JSON.stringify({ v: 1, ledger: 'pr', repo: 'o/r', pr: 1, status: 'working', agent: 'a', since: 's', updated: 'u', archived: '2026-10-05T10:00:00Z' }),
    JSON.stringify({ v: 1, ledger: 'pr', repo: 'o/r', pr: 2, status: 'working', agent: 'a', since: 's', updated: 'u', archived: '2026-11-14T10:00:00Z' }),
  ].join('\n') + '\n')
  const asked = (id: string, name: string, at: string): string => `${JSON.stringify({ v: 2, id, sender: { session: '60ed5626-9879-4041-892a-5db0ff0bad69', name }, choices: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], recommended: 'A', status: 'answered', at, answer: { text: 'b', by: 'pane', at } })}\n`
  put(join(module, 'round', 'archive', 'q-old.json'), asked('q-old', 'Orch : Demo work', '2026-10-10T10:00:00Z'))
  put(join(module, 'round', 'archive', 'q-new.json'), asked('q-new', 'Orch: Demo work', '2026-11-14T10:00:00Z'))
  put(join(module, 'round', 'archive', 'withdrawn', 'q-gone.json'), asked('q-gone', 'Coord: machine', '2026-09-01T10:00:00Z').replace('"answered"', '"withdrawn"'))
  return { module, dir }
}

const remoteOf = (root: string): string => {
  const remote = join(root, 'logs.git')
  assert.equal(git(['init', '--quiet', '--bare', remote], root).status, 0)
  return remote
}

function scratch(work: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-archive-'))
  try {
    work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const exported = (root: string, remote: string, options: { git?: Git; now?: number } = {}) => {
  const { module } = { module: join(root, 'config', 'claude-orchestrator') }
  return exportStore({
    stateDir: join(root, 'state'),
    secrets: new Map(),
    repo: remote,
    machine: 'box',
    git: options.git ?? git,
    now: () => options.now ?? NOW,
    archive: (machine, now) => planArchive({ moduleDir: module, machine, now }),
  })
}

const tree = (remote: string): string[] => git(['ls-tree', '-r', '--name-only', 'main'], remote).stdout.split('\n').filter(line => line !== '' && !line.startsWith('index/') && !line.startsWith('machines/')).sort()

/** What the fixture's closed rows send: three kinds of file, a review directory, one ledger month and two questions. */
const SENT = [
  'demo/2026-10/box/brief/one-brief.md',
  'demo/2026-10/box/ledger/dispatch-record.archive.jsonl',
  'demo/2026-10/box/report/report-one-brief.md',
  'demo/2026-10/box/review/review-1-r1-index.md',
  'demo/2026-10/box/review/review-1-r1-index/1.md',
  'demo/2026-10/box/review/review-1-r1-index/2.md',
  'demo/2026-11/box/brief/two-brief.md',
  'demo/2026-11/box/report/report-two-brief.md',
  'demo-work/2026-10/box/round/q-old.json',
  'machine/2026-09/box/round/withdrawn/q-gone.json',
]

/** What stays: the open row's brief and report, the report both a closed and an open row name, a file no row names, the plans, and the month in progress's question. */
const KEPT = ['orphan.md', 'plans', 'report-shared.md', 'report-three-brief.md', 'three-brief.md']

test('the plan names the closed rows\' files by project and month, and nothing an open row names', () => {
  scratch(root => {
    fixture(root)
    const plan = planArchive({ moduleDir: join(root, 'config', 'claude-orchestrator'), machine: 'box', now: NOW })
    assert.deepEqual(plan.items.map(item => item.rel).sort(), [...SENT].sort())
    assert.equal(plan.kept, 6)
  })
})

test('a closed row\'s files land under project and month and leave the machine; the open row\'s stay', () => {
  scratch(root => {
    const { dir, module } = fixture(root)
    const remote = remoteOf(root)
    const result = exported(root, remote)
    assert.equal(result.code, 0)
    assert.equal(result.lines.at(-1), 'export: archive: 10 file(s) exported, 10 removed from this machine, 6 kept')
    assert.deepEqual(tree(remote), [...SENT].sort())
    assert.equal(git(['show', 'main:demo/2026-10/box/brief/one-brief.md'], remote).stdout, brief(1, 'report-one-brief.md', dir))
    assert.deepEqual(readdirSync(dir).sort(), ['dispatch-record.archive.jsonl', 'dispatch-record.jsonl', ...KEPT].sort())
    assert.equal(existsSync(join(dir, 'review-1-r1-index')), false)
    assert.deepEqual(readFileSync(join(dir, 'dispatch-record.archive.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { pr: number }).pr), [2])
    assert.deepEqual(readdirSync(join(module, 'round', 'archive')).sort(), ['q-new.json', 'withdrawn'])
    assert.deepEqual(readdirSync(join(module, 'round', 'archive', 'withdrawn')), [])
    // The record's own rows are not touched.
    assert.equal(readFileSync(join(dir, 'dispatch-record.jsonl'), 'utf8').split('\n').filter(Boolean).length, 4)
    // A second export finds nothing more to take.
    assert.deepEqual(exported(root, remote).lines, ['export: no event recorded yet, nothing pushed', 'export: archive: 0 file(s) exported, 0 removed from this machine, 6 kept'])
  })
})

test('a refused push removes nothing, and the next export that pushes removes everything it sent', () => {
  scratch(root => {
    const { dir, module } = fixture(root)
    const remote = remoteOf(root)
    const before = readdirSync(dir).sort()
    const refused: Git = (args, cwd) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'remote: denied' } : git(args, cwd))
    const failed = exported(root, remote, { git: refused })
    assert.equal(failed.code, 1)
    assert.match(failed.lines[0] ?? '', /^export failed at push/)
    assert.deepEqual(readdirSync(dir).sort(), before)
    assert.equal(existsSync(join(module, 'round', 'archive', 'q-old.json')), true)
    assert.equal(readFileSync(join(dir, 'dispatch-record.archive.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2)
    assert.notEqual(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], remote).status, 0)
    assert.equal(exported(root, remote).code, 0)
    assert.deepEqual(tree(remote), [...SENT].sort())
    assert.deepEqual(readdirSync(dir).sort(), ['dispatch-record.archive.jsonl', 'dispatch-record.jsonl', ...KEPT].sort())
  })
})

test('a file the repository already holds is removed on the next export, and one changed since it was copied stays', () => {
  scratch(root => {
    const { dir } = fixture(root)
    const remote = remoteOf(root)
    assert.equal(exported(root, remote).code, 0)
    // The earlier removal did not happen: both files are back as they were pushed.
    put(join(dir, 'one-brief.md'), brief(1, 'report-one-brief.md', dir))
    put(join(dir, 'report-one-brief.md'), 'the report of row one\n')
    // A session writes the report again while the export checks what the repository holds.
    const racing: Git = (args, cwd) => {
      if (args[0] === 'ls-tree' && args.includes('demo')) put(join(dir, 'report-one-brief.md'), 'the report of row one, edited since\n')
      return git(args, cwd)
    }
    const again = exported(root, remote, { git: racing })
    assert.equal(again.code, 0)
    assert.equal(again.lines.at(-1), 'export: archive: 2 file(s) exported, 1 removed from this machine, 6 kept')
    assert.equal(existsSync(join(dir, 'one-brief.md')), false)
    assert.equal(readFileSync(join(dir, 'report-one-brief.md'), 'utf8'), 'the report of row one, edited since\n')
  })
})

test('a row opened between the plan and the removal that names a file keeps it', () => {
  scratch(root => {
    const { dir } = fixture(root)
    const remote = remoteOf(root)
    assert.equal(exported(root, remote).code, 0)
    put(join(dir, 'one-brief.md'), brief(1, 'report-one-brief.md', dir))
    const opening: Git = (args, cwd) => {
      if (args[0] === 'ls-tree' && args.includes('demo')) writeFileSync(join(dir, 'dispatch-record.jsonl'), `${readFileSync(join(dir, 'dispatch-record.jsonl'), 'utf8')}${row({ id: 4, state: 'open', opened: '2026-11-15T09:00:00Z', label: 'FOUR', note: 'starts from one-brief.md' })}`)
      return git(args, cwd)
    }
    assert.equal(exported(root, remote, { git: opening }).code, 0)
    assert.equal(existsSync(join(dir, 'one-brief.md')), true)
  })
})

test('a row closed within the day keeps its files, and a row that names none leaves the rest where they are', () => {
  scratch(root => {
    const { dir } = fixture(root)
    const recent = new Date(NOW - 3_600_000).toISOString()
    writeFileSync(join(dir, 'dispatch-record.jsonl'), `${readFileSync(join(dir, 'dispatch-record.jsonl'), 'utf8')}${row({ id: 5, state: 'closed', opened: recent, closed: recent, label: 'FIVE: fresh' })}`)
    put(join(dir, 'five-brief.md'), brief(5, 'report-five-brief.md', dir))
    put(join(dir, 'report-five-brief.md'), 'fresh\n')
    const plan = planArchive({ moduleDir: join(root, 'config', 'claude-orchestrator'), machine: 'box', now: NOW })
    assert.deepEqual(plan.items.map(item => item.rel).sort(), [...SENT].sort())
    assert.equal(plan.kept, 8)
  })
})

test('the secret scan runs on the files: one with a secret stays, is named by its pattern, and the others go', () => {
  scratch(root => {
    const { dir } = fixture(root)
    put(join(dir, 'report-two-brief.md'), `a token ${SECRET} in the report\n`)
    const remote = remoteOf(root)
    const result = exported(root, remote)
    assert.equal(result.code, 0)
    assert.deepEqual(result.lines.slice(-2), ['export: archive: 9 file(s) exported, 9 removed from this machine, 7 kept', 'export: demo/2026-11/box/report/report-two-brief.md left in place (secret pattern: anthropic-key)'])
    assert.ok(!result.lines.join('\n').includes(SECRET))
    assert.deepEqual(tree(remote), SENT.filter(rel => !rel.endsWith('report-two-brief.md')).sort())
    assert.equal(existsSync(join(dir, 'report-two-brief.md')), true)
    assert.equal(git(['grep', '-c', 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gj', 'main'], remote).status, 1)
  })
})

test('a ledger month adds to the lines the repository holds, and a project named like the repository\'s own directory is set apart', () => {
  scratch(root => {
    const { dir } = fixture(root)
    const remote = remoteOf(root)
    assert.equal(exported(root, remote).code, 0)
    const line = JSON.stringify({ v: 1, ledger: 'pr', repo: 'o/r', pr: 7, status: 'working', agent: 'a', since: 's', updated: 'u', archived: '2026-10-28T10:00:00Z' })
    writeFileSync(join(dir, 'dispatch-record.archive.jsonl'), `${readFileSync(join(dir, 'dispatch-record.archive.jsonl'), 'utf8')}${line}\n`)
    assert.equal(exported(root, remote).code, 0)
    assert.deepEqual(git(['show', 'main:demo/2026-10/box/ledger/dispatch-record.archive.jsonl'], remote).stdout.split('\n').filter(Boolean).map(l => (JSON.parse(l) as { pr: number }).pr), [1, 7])
    assert.deepEqual(['machines', 'index', '.git', 'Owner/Name'].map(archiveProject), ['_machines', '_index', '_.git', 'owner-name'])
  })
})

test('with no orchestrator module the archive is silent, and the export prints what it printed before', () => {
  scratch(root => {
    const remote = remoteOf(root)
    assert.deepEqual(exported(root, remote).lines, ['export: no event recorded yet, nothing pushed'])
  })
})
