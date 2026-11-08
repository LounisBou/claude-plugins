import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { defaultBranch, main, mergesPerWeek, numstat, parseArgs, remoteHead, sinceForGit, typeOf, USAGE } from './rhythm.ts'
import type { Io, Ran, Run, RunOptions } from './lib/process.ts'

function recorder(): Io & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, out: text => stdout.push(text), err: text => stderr.push(text) }
}

/** A git that answers each subcommand from `answers`, keyed by the argv after `-C <repo>`. */
function fakeGit(answers: Record<string, Ran | ((options: RunOptions) => Promise<Ran>)>): Run & { readonly calls: string[] } {
  const calls: string[] = []
  const git = async (argv: readonly string[], options: RunOptions = {}): Promise<Ran> => {
    const key = argv.slice(3).join(' ')
    calls.push(key)
    const answer = answers[key]
    if (answer === undefined) return { status: 1, stdout: '', stderr: '' }
    return typeof answer === 'function' ? answer(options) : answer
  }
  return Object.assign(git, { calls })
}

const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })

test('the command line: a repository, a required --since, repeated globs', () => {
  assert.deepEqual(parseArgs(['r', '--since', '2026-08-10', '--product', 'a/**', '--instrument', 'b', '--product', 'c']), {
    repo: 'r', since: '2026-08-10T00:00:00', product: ['a/**', 'c'], instrument: ['b'],
  })
  assert.deepEqual(parseArgs([]), { error: USAGE })
  assert.deepEqual(parseArgs(['r']), { error: '--since <date> is required' })
  assert.deepEqual(parseArgs(['r', '--since']), { error: '--since needs a value' })
  assert.deepEqual(parseArgs(['r', '--bogus', 'x']), { error: `unknown argument: --bogus (${USAGE})` })
})

test('a bare date is its midnight; a date with a time is passed as given', () => {
  assert.equal(sinceForGit('2026-08-12'), '2026-08-12T00:00:00')
  assert.equal(sinceForGit('2026-08-12T13:00:00'), '2026-08-12T13:00:00')
  assert.equal(sinceForGit('last week'), 'last week')
})

test('the remote names its HEAD on a `ref:` line', () => {
  assert.equal(remoteHead('ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n'), 'trunk')
  assert.equal(remoteHead('abc\tHEAD\n'), '')
})

test('a title is typed by its conventional-commit prefix, scope and bang allowed', () => {
  assert.equal(typeOf('feat(core)!: x'), 'feat')
  assert.equal(typeOf('fix: x'), 'fix')
  assert.equal(typeOf('Merge branch x'), 'other')
  assert.equal(typeOf('feature: x'), 'other')
})

test('merges per week: a merge by its body\'s first line, any other commit by its subject, weeks in order', () => {
  const record = (week: string, parents: string, subject: string, body: string): string => `\x1e${week}\x1f${parents}\x1f${subject}\x1f${body}\n`
  const log = [
    record('2026-W34', 'a b', 'Merge pull request #2', '\n  \nci: a pipeline\n'),
    record('2026-W33', 'a b', 'Merge pull request #1', 'docs: a page'),
    record('2026-W33', 'a', 'fix: direct', 'feat: not read'),
    record('2026-W33', 'a b', 'refactor: subject kept', ' \t\n'),
  ].join('')
  assert.deepEqual(mergesPerWeek(log), [
    'week feat fix chore docs ci build test refactor other total',
    '2026-W33 0 1 0 1 0 0 0 1 0 3',
    '2026-W34 0 0 0 0 1 0 0 0 0 1',
  ])
  assert.deepEqual(mergesPerWeek(''), ['week feat fix chore docs ci build test refactor other total'])
})

test('numstat sums the numbered lines and skips binary files', () => {
  assert.deepEqual(numstat('3\t1\ta b.ts\n-\t-\timg.png\n\n10\t0\tc\n'), { added: 13, removed: 1 })
})

test('origin/HEAD set: read silently', async () => {
  const io = recorder()
  assert.equal(await defaultBranch('r', fakeGit({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': ok('origin/main\n') }), io), 'origin/main')
  assert.deepEqual(io.stderr, [])
})

test('origin/HEAD unset: the remote\'s answer, through its tracking ref or a local branch', async () => {
  const listing = ok('ref: refs/heads/trunk\tHEAD\n')
  let io = recorder()
  assert.equal(await defaultBranch('r', fakeGit({ 'ls-remote --symref origin HEAD': listing, 'rev-parse --verify --quiet refs/remotes/origin/trunk': ok() }), io), 'origin/trunk')
  assert.deepEqual(io.stderr, ['rhythm: origin/HEAD is unset; read origin/trunk from the remote\n'])
  io = recorder()
  assert.equal(await defaultBranch('r', fakeGit({ 'ls-remote --symref origin HEAD': listing, 'rev-parse --verify --quiet refs/heads/trunk': ok() }), io), 'trunk')
  assert.deepEqual(io.stderr, ['rhythm: origin/HEAD is unset; read trunk from the remote\n'])
})

test('a name the clone lacks, or no answer: the guess is said as one', async () => {
  let io = recorder()
  const git = fakeGit({ 'ls-remote --symref origin HEAD': ok('ref: refs/heads/trunk\tHEAD\n'), 'rev-parse --verify --quiet refs/heads/master': ok() })
  assert.equal(await defaultBranch('r', git, io), 'master')
  assert.deepEqual(io.stderr, ['rhythm: origin/HEAD is unset; the remote names trunk, which this clone does not have; guessed master\n'])
  io = recorder()
  assert.equal(await defaultBranch('r', fakeGit({ 'rev-parse --abbrev-ref HEAD': ok('work\n') }), io), 'work')
  assert.deepEqual(io.stderr, ['rhythm: origin/HEAD is unset and the remote did not answer; guessed work\n'])
})

test('a remote past its deadline is cancelled, and read as no answer', async () => {
  let aborted = false
  const hanging = (options: RunOptions): Promise<Ran> =>
    new Promise(resolve => options.signal?.addEventListener('abort', () => { aborted = true; resolve({ status: null, stdout: 'ref: refs/heads/late\tHEAD\n', stderr: '' }) }))
  const io = recorder()
  const git = fakeGit({ 'ls-remote --symref origin HEAD': hanging, 'rev-parse --verify --quiet refs/heads/main': ok() })
  assert.equal(await defaultBranch('r', git, io, 5), 'main')
  assert.equal(aborted, true)
  assert.deepEqual(io.stderr, ['rhythm: origin/HEAD is unset and the remote did not answer; guessed main\n'])
})

test('a failure of the remote other than its deadline is not hidden', async () => {
  const git = fakeGit({ 'ls-remote --symref origin HEAD': () => Promise.reject(new Error('boom')) })
  await assert.rejects(defaultBranch('r', git, recorder()), /boom/)
})

test('main: refusals exit 1 with one line on stderr', async () => {
  let io = recorder()
  assert.equal(await main(['r'], fakeGit({}), io), 1)
  assert.deepEqual(io.stderr, ['rhythm: --since <date> is required\n'])
  io = recorder()
  assert.equal(await main(['r', '--since', '2026-08-10'], fakeGit({}), io), 1)
  assert.deepEqual(io.stderr, ['rhythm: not a git repository: r\n'])
})

test('main: the header, the table and both readings', async () => {
  const io = recorder()
  const git = fakeGit({
    'rev-parse --git-dir': ok('.git\n'),
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': ok('origin/main\n'),
    'log origin/main --first-parent --since=2026-08-10T00:00:00 --date=format:%G-W%V --format=%x1e%cd%x1f%P%x1f%s%x1f%b': ok('\x1e2026-W33\x1fa\x1ffeat: x\x1f\n'),
    'log origin/main --since=2026-08-10T00:00:00 --no-merges --numstat --format= -- src/** lib': ok('4\t2\tsrc/a\n'),
  })
  assert.equal(await main(['r', '--since', '2026-08-10', '--product', 'src/**', '--product', 'lib'], git, io), 0)
  assert.deepEqual(io.stdout.join('').split('\n'), [
    'rhythm: r on origin/main since 2026-08-10T00:00:00',
    "merges per week (first-parent commits on origin/main, typed by their pull request's title):",
    'week feat fix chore docs ci build test refactor other total',
    '2026-W33 1 0 0 0 0 0 0 0 0 1',
    'lines since 2026-08-10T00:00:00 (non-merge commits on origin/main; globs are git pathspecs, where * crosses directories):',
    'product +4 -2  (src/** lib)',
    'instrument: no --instrument glob given',
    '',
  ])
  assert.deepEqual(io.stderr, [])
})
