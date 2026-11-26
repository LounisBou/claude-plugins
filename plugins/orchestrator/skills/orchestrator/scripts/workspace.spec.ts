import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { run, type Ran, type Run, type RunOptions } from './lib/process.ts'
import type { FilePr } from '../../../hooks/pr-file-format.ts'
import { main as brief } from './brief.ts'
import {
  archivePath, bareName, callerOf, ledgerPath, ledgerText, liveSessions, makerOf, parseEntry, parseLedger, type WorkspaceEntry,
} from './lib/workspace-ledger.ts'
import {
  ancestors, branchFacts, carryStore, copyable, copyFiles, copyList, encode, leavesRepository, main, manifestPath, neverCopied, parseCwds,
  settingsRules, underRoot, USAGE, type Deps,
} from './workspace.ts'

// The children git runs read the identity and the global config from the process's own environment.
process.env['GIT_CONFIG_GLOBAL'] = '/nonexistent/gitconfig'
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 't'
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 't@local'

let dir = ''
test.beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-'))) })
test.afterEach(() => {
  try {
    execFileSync('chmod', ['-R', 'u+w', dir])
  } catch {
    // Nothing locked.
  }
  rmSync(dir, { recursive: true, force: true })
})

const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A repository at `path` with one commit on `branch`. */
function repo(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  g(path, 'init', '-q', '-b', branch)
  writeFileSync(join(path, 'README.md'), 'tracked\n')
  g(path, 'add', '-A')
  g(path, 'commit', '-q', '-m', 'One')
  return path
}

/** A source pushed to a bare origin: the base of every checkout that must read as pushed. */
function pushed(name: string, branch = 'main'): string {
  const bare = join(dir, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', bare])
  const src = repo(join(dir, 'src', name), branch)
  g(src, 'remote', 'add', 'origin', bare)
  g(src, 'push', '-q', 'origin', branch)
  return src
}

interface World {
  deps: Deps
  readonly stdout: string[]
  readonly stderr: string[]
  readonly gh: string[]
  cwds: string | Ran
  prs: Record<string, Ran | (() => Promise<Ran>)>
  clock: number
}

const ok = (stdout: string): Ran => ({ status: 0, stdout, stderr: '' })

/** A world under `dir`: real git, a process table and a `gh` it answers, a clock it holds. */
function world(env: Record<string, string> = {}): World {
  const w: World = {
    stdout: [], stderr: [], gh: [], cwds: 'p1\nfcwd\nn/\n', prs: {}, clock: Date.now(),
    deps: undefined as unknown as Deps,
  }
  const fake: Run = async (argv, options = {}) => {
    if (argv[0] === 'lsof') return typeof w.cwds === 'string' ? ok(w.cwds) : w.cwds
    if (argv[0] === 'gh') {
      const origin = g(options.cwd ?? '/', 'remote', 'get-url', 'origin')
      w.gh.push(`${origin} ${argv.slice(1).join(' ')}`)
      const answer = w.prs[origin] ?? { status: 1, stdout: '', stderr: 'gh: no such repository\n' }
      return typeof answer === 'function' ? answer() : answer
    }
    return run(argv, options)
  }
  w.deps = {
    io: { out: (t: string) => w.stdout.push(t), err: (t: string) => w.stderr.push(t) },
    env: {
      HOME: join(dir, 'home'),
      ORCHESTRATOR_WORKSPACES: join(dir, 'root'),
      ORCHESTRATOR_HOST_TMP: join(dir, 'host'),
      ORCHESTRATOR_STATE_DIR: join(dir, 'state'),
      ...env,
    },
    run: fake,
    now: () => w.clock,
    cwd: dir,
    uid: 501,
  }
  return w
}

async function ws(w: World, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  w.stdout.length = 0
  w.stderr.length = 0
  if (argv[0] === 'sweep') sweepFile(w)
  const code = await main(argv, w.deps)
  return { code, out: w.stdout.join(''), err: w.stderr.join('') }
}

/*
 * What the hooks module's refresh would leave for a sweep: every checkout whose origin is a local
 * bare repository `<dir>/<name>.git` given a GitHub address, `https://github.com/acme/<name>`, and the
 * machine's pull request file holding, for each origin `w.prs` answers with a list, its pull requests
 * in that repository; an origin it answers with no list is not in the file.
 */
function sweepFile(w: World): void {
  const root = join(dir, 'root')
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    for (const name of statSync(join(root, project)).isDirectory() ? readdirSync(join(root, project)) : []) {
      const c = join(root, project, name)
      if (!existsSync(join(c, '.git'))) continue
      let origin = ''
      try {
        origin = g(c, 'remote', 'get-url', 'origin')
      } catch {
        continue
      }
      const bare = /^(.*)\/([^/]+)\.git$/.exec(origin)
      if (bare !== null && bare[1] === dir) g(c, 'remote', 'set-url', 'origin', `https://github.com/acme/${bare[2] ?? ''}`)
    }
  }
  const repos: string[] = []
  const prs: object[] = []
  for (const [origin, answer] of Object.entries(w.prs)) {
    if (typeof answer === 'function' || answer.status !== 0) continue
    let listed: unknown
    try {
      listed = JSON.parse(answer.stdout)
    } catch {
      continue
    }
    if (!Array.isArray(listed)) continue
    const repo = `acme/${origin.replace(/^.*\//, '').replace(/\.git$/, '')}`
    repos.push(repo)
    for (const p of listed as { number: number; state: string; headRefName: string; headRefOid: string }[]) {
      prs.push({ repo, pr: p.number, state: p.state, draft: false, head: p.headRefName, sha: p.headRefOid, author: 'me', createdAt: null, labels: [], mergeable: null, fork: null })
    }
  }
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'state', 'prs.json'), JSON.stringify({ v: 1, at: new Date(w.clock).toISOString(), tried: 'x', viewer: 'me', repos, unread: [], prs }))
}

const lsofOf = (...cwds: string[]): string => cwds.map((c, i) => `p${i + 1}\nfcwd\nn${c}\n`).join('')

/** A checkout made by `create`, on its own branch, pushed unless told. */
async function clone(w: World, src: string, name: string, branch: string, how: 'pushed' | 'unpushed' | 'dirty' = 'pushed'): Promise<string> {
  const made = await ws(w, 'create', src, name, '--base', 'main')
  assert.equal(made.code, 0, made.err)
  const c = made.out.trim()
  g(c, 'checkout', '-q', '-b', branch)
  writeFileSync(join(c, `${name}.txt`), `${name}\n`)
  g(c, 'add', '-A')
  g(c, 'commit', '-q', '-m', `Work on ${name}`)
  if (how !== 'unpushed') g(c, 'push', '-q', 'origin', branch)
  if (how === 'dirty') writeFileSync(join(c, `${name}.txt`), 'more\n')
  return c
}

test('the pure readings: the host spelling, the ancestors, the process table, the manifest', () => {
  assert.equal(encode('/a/.b_c'), '-a--b-c')
  assert.deepEqual(ancestors('/a/b/c'), ['/a/b/c', '/a/b', '/a'])
  assert.deepEqual(ancestors('relative/dir'), ['relative/dir', 'relative'])
  assert.deepEqual(ancestors('/'), [])
  assert.deepEqual(parseCwds(ok('p1\nfcwd\nn/x\np2\nn/y\n')), ['/x', '/y'])
  assert.equal(parseCwds(ok('')), null)
  assert.equal(parseCwds({ status: 124, stdout: 'n/x\n', stderr: '' }), null)
  assert.equal(parseCwds({ status: null, stdout: 'n/x\n', stderr: '' }), null)
  assert.deepEqual(parseCwds({ status: 1, stdout: 'n/x\n', stderr: '' }), ['/x'], 'a warning exit with a table is a table')
  assert.equal(manifestPath('  .env  # the environment'), '.env')
  assert.equal(manifestPath('# only a comment'), '')
  assert.deepEqual(['/etc', '..', '../x', 'a/..', 'a/../b', 'a..b'].map(leavesRepository), [true, true, true, true, true, false])
  assert.deepEqual(['.git', '.git/x', 'node_modules', 'vendor/a', 'vendored'].map(neverCopied), [true, true, true, true, false])
  assert.equal(settingsRules('LOCAL.md\n/.claude/\n.claude\n**/.claude/\n**/.claude/worktrees/\nlast'), 'LOCAL.md\n**/.claude/worktrees/\nlast\n')
  assert.ok(underRoot('/r/p/c', '/r'))
  assert.ok(underRoot('/r/p/c/sub', '/r'))
  assert.ok(!underRoot('/r/p', '/r'))
  assert.ok(!underRoot('/r-old/p/c', '/r'))
})

test('the pull requests of a branch: none, the lowest open, or the last over', () => {
  const pr = (n: number, state: FilePr['state'], head: string, sha = ''): FilePr =>
    ({ repo: 'acme/app', pr: n, state, draft: false, head, sha, author: null, createdAt: null, labels: [], mergeable: null, fork: null })
  const prs = [pr(3, 'OPEN', 'a'), pr(2, 'OPEN', 'a'), pr(4, 'MERGED', 'b', 'x'), pr(6, 'CLOSED', 'b', 'y')]
  assert.deepEqual(branchFacts(prs, 'z'), { kind: 'none' })
  assert.deepEqual(branchFacts(prs, 'a'), { kind: 'open', number: 2 })
  assert.deepEqual(branchFacts(prs, 'b'), { kind: 'over', number: 6, state: 'CLOSED', heads: ['x', 'y'] })
})

test('copyList keeps each path at its place, a link as a link; an unreadable file fails the pass', () => {
  const from = join(dir, 'from')
  mkdirSync(join(from, 'a', 'b'), { recursive: true })
  writeFileSync(join(from, 'a', 'b', 'f'), 'f')
  chmodSync(join(from, 'a', 'b', 'f'), 0o750)
  symlinkSync('b/f', join(from, 'a', 'l'))
  assert.ok(copyList(from, join(dir, 'to'), ['a/b/f', 'a/l']))
  assert.equal(readFileSync(join(dir, 'to', 'a', 'l'), 'utf8'), 'f')
  assert.equal(statSync(join(dir, 'to', 'a', 'b', 'f')).mode & 0o777, 0o750)
  assert.ok(!copyList(from, join(dir, 'to'), ['absent']))
})

test('the command line: a usage, an unknown command, options each command refuses', async () => {
  const w = world()
  assert.deepEqual(await ws(w), { code: 1, out: '', err: `workspace: ${USAGE}\n` })
  assert.equal((await ws(w, 'bogus')).err, 'workspace: unknown command: bogus\n')
  assert.equal((await ws(w, 'create', 'a')).err, 'workspace: create: usage: create <source-repo> <name> [--base <ref>]\n')
  assert.equal((await ws(w, 'create', 'a', 'b', '--bogus')).err, 'workspace: create: unknown option --bogus\n')
  assert.equal((await ws(w, 'create', 'a', 'b', 'c')).err, 'workspace: create: unexpected argument c\n')
  assert.equal((await ws(w, 'create', join(dir, 'none'), 'b')).err, `workspace: create: not a git repository: ${join(dir, 'none')}\n`)
  assert.equal((await ws(w, 'pin', 'a', 'b')).err, 'workspace: pin: usage: pin <source-repo> <name> <ref> [--pr <n>]\n')
  assert.equal((await ws(w, 'pin', 'a', 'b', 'c', '--pr', 'seven')).err, 'workspace: pin: --pr needs a pull request number: seven\n')
  assert.equal((await ws(w, 'pin', 'a', 'b', 'c', '--pr')).err, 'workspace: pin: --pr needs a pull request number: \n')
  assert.equal((await ws(w, 'pin', join(dir, 'none'), 'b', 'c')).err, `workspace: pin: not a git repository: ${join(dir, 'none')}\n`)
  assert.equal((await ws(w, 'sweep', '--bogus')).err, 'workspace: sweep: usage: sweep [--deadline <seconds>] [--dry-run]\n')
  assert.equal((await ws(w, 'sweep', '--deadline', 'soon')).err, 'workspace: sweep: --deadline needs a number of seconds: soon\n')
  assert.equal((await ws(w, 'sweep', '--deadline')).err, 'workspace: sweep: --deadline needs a number of seconds: \n')
  assert.deepEqual(await ws(w, 'sweep'), { code: 0, out: '', err: '' }, 'no root, nothing to sweep')
  assert.deepEqual(await ws(w, 'list'), { code: 0, out: '', err: '' }, 'no root, nothing to list')
})

test('create: the checkout carries the local material, minus what never travels, and reads clean', async () => {
  const src = repo(join(dir, 'src', 'proj'))
  g(src, 'remote', 'add', 'origin', 'git@example.invalid:owner/proj.git')
  mkdirSync(join(src, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(src, '.claude', 'worktrees', 'w1'), { recursive: true })
  mkdirSync(join(src, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(src, 'dir', 'deep'), { recursive: true })
  writeFileSync(join(src, '.claude', 'settings.local.json'), '{}')
  writeFileSync(join(src, '.claude', 'agents', 'a.md'), 'a')
  writeFileSync(join(src, '.claude', 'worktrees', 'w1', 'f'), 'w')
  writeFileSync(join(src, '.claude', 'workspace-manifest'), '.env\nabsent.txt\n# a comment\nnode_modules\ndir # a tree\n')
  writeFileSync(join(src, 'LOCAL.md'), 'local')
  writeFileSync(join(src, 'NOTES.md'), 'notes')
  writeFileSync(join(src, '.env'), 'secret')
  writeFileSync(join(src, 'dir', 'deep', 'x'), 'x')
  writeFileSync(join(src, '.git', 'info', 'exclude'), 'LOCAL.md\n/.claude/\n**/.claude/worktrees/')
  writeFileSync(join(src, '.gitignore'), '.env\ndir/\nnode_modules/\n')
  g(src, 'add', '.gitignore')
  g(src, 'commit', '-q', '-m', 'Ignore')
  writeFileSync(join(dir, 'global-ignore'), 'NOTES.md\nLOCAL.md\n')
  writeFileSync(join(dir, 'home-gitconfig'), `[core]\n\texcludesFile = ~/../global-ignore\n`)
  mkdirSync(join(dir, 'home'))
  const w = world()
  const home = process.env['HOME']
  process.env['GIT_CONFIG_GLOBAL'] = join(dir, 'home-gitconfig')
  process.env['HOME'] = join(dir, 'home')
  try {
    const r = await ws(w, 'create', src, 'phase-1')
    const c = join(dir, 'root', 'proj', 'phase-1')
    assert.deepEqual([r.code, r.out], [0, `${c}\n`], r.err)
    assert.equal(g(c, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
    assert.equal(g(c, 'remote', 'get-url', 'origin'), 'git@example.invalid:owner/proj.git')
    assert.equal(readFileSync(join(c, '.claude', 'agents', 'a.md'), 'utf8'), 'a')
    assert.ok(!existsSync(join(c, '.claude', 'worktrees')), 'what the exclude file names inside the settings directory stays')
    assert.ok(!existsSync(join(c, '.claude', 'settings.local.json')), "the operator's local permissions never travel")
    assert.ok(!existsSync(join(c, '.git', 'workspace-rules')), 'the reduced exclude file outlives no copy')
    assert.equal(readFileSync(join(c, 'LOCAL.md'), 'utf8'), 'local')
    assert.equal(readFileSync(join(c, 'NOTES.md'), 'utf8'), 'notes')
    assert.equal(readFileSync(join(c, '.env'), 'utf8'), 'secret')
    assert.equal(readFileSync(join(c, 'dir', 'deep', 'x'), 'utf8'), 'x')
    assert.ok(!existsSync(join(c, 'node_modules')))
    assert.equal(g(c, 'status', '--porcelain'), '', 'every copy is ignored in the checkout')
    assert.deepEqual(r.err.split('\n').filter(l => l !== ''), [
      'workspace: copied the local settings directory (2 files, 1 skipped by the exclude file, 1 withheld: the operator\'s own settings.local.json never travels into a checkout)',
      'workspace: copied 1 excluded files',
      'workspace: copied 1 files kept out by the global excludes',
      'workspace: manifest: never copied: node_modules',
      'workspace: manifest: 2 copied, missing: absent.txt',
    ])
    assert.deepEqual(await ws(w, 'create', src, 'phase-1'), { code: 1, out: '', err: `workspace: create: already exists, delete it first: ${c}\n` })
    assert.equal((await ws(w, 'create', src, 'bad name')).err, 'workspace: create: name must match [A-Za-z0-9._-]+: bad name\n')
    writeFileSync(join(src, '.claude', 'workspace-manifest'), '../outside\n')
    assert.equal((await ws(w, 'create', src, 'phase-2')).err.split('\n').at(-2), 'workspace: create: manifest path leaves the repository: ../outside')
    assert.ok(!existsSync(join(dir, 'root', 'proj', 'phase-2')), 'a refused create leaves no checkout')
  } finally {
    process.env['GIT_CONFIG_GLOBAL'] = '/nonexistent/gitconfig'
    if (home === undefined) delete process.env['HOME']
    else process.env['HOME'] = home
  }
})

test('create: a remote-tracking base, a source without origin, a base the source does not know', async () => {
  const src = pushed('proj2')
  const other = join(dir, 'elsewhere')
  execFileSync('git', ['clone', '-q', '-b', 'main', join(dir, 'proj2.git'), other])
  writeFileSync(join(other, 'README.md'), 'two\n')
  g(other, 'commit', '-q', '-am', 'Two')
  g(other, 'push', '-q', 'origin', 'main')
  g(src, 'fetch', '-q', 'origin')
  const w = world()
  const r = await ws(w, 'create', src, 'fresh', '--base', 'origin/main')
  assert.equal(r.code, 0, r.err)
  const c = r.out.trim()
  assert.equal(g(c, 'rev-parse', 'HEAD'), g(src, 'rev-parse', 'origin/main'))
  assert.equal(g(c, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main')
  assert.equal((await ws(w, 'create', src, 'x', '--base', 'nope')).err, 'workspace: create: the source has no branch or origin/ remote-tracking ref nope\n')
  assert.equal((await ws(w, 'create', src, 'x', '--base', 'upstream/main')).code, 1)
  const lone = repo(join(dir, 'src', 'lone'))
  const made = await ws(w, 'create', lone, 'one')
  assert.equal(made.code, 0)
  assert.match(made.err, /the source has no origin; the checkout has none either/)
  g(lone, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual((await ws(w, 'create', lone, 'two', '--base', 'origin/main')).err.split('\n').at(-2),
    'workspace: create: --base origin/main needs the source to have an origin')
  assert.ok(!existsSync(join(dir, 'root', 'lone', 'two')))
})

test('create --base <branch> starts from the origin, said on stderr, and from the local branch only when the origin has none', async () => {
  const src = pushed('based')
  const other = join(dir, 'elsewhere-based')
  execFileSync('git', ['clone', '-q', '-b', 'main', join(dir, 'based.git'), other])
  g(other, 'checkout', '-q', '-b', 'feat/remote-only')
  writeFileSync(join(other, 'remote.txt'), 'remote\n')
  g(other, 'add', '-A')
  g(other, 'commit', '-q', '-m', 'Remote')
  g(other, 'push', '-q', 'origin', 'feat/remote-only')
  g(other, 'checkout', '-q', 'main')
  writeFileSync(join(other, 'README.md'), 'two\n')
  g(other, 'commit', '-q', '-am', 'Two')
  g(other, 'push', '-q', 'origin', 'main')
  const stale = g(src, 'rev-parse', 'main')
  const fresh = g(other, 'rev-parse', 'main')
  assert.notEqual(stale, fresh)
  const w = world()

  // The source's local main lags the origin and the source never fetched: the checkout starts from the origin.
  const lagging = await ws(w, 'create', src, 'lagging', '--base', 'main')
  assert.equal(lagging.code, 0, lagging.err)
  assert.equal(g(lagging.out.trim(), 'rev-parse', 'HEAD'), fresh)
  assert.match(lagging.err, new RegExp(`workspace: base: origin/main at ${fresh}\n`))
  assert.equal(g(lagging.out.trim(), 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main')

  // A branch only the origin holds, which the source has neither as a branch nor as a remote-tracking ref.
  const remote = await ws(w, 'create', src, 'remote', '--base', 'feat/remote-only')
  assert.equal(remote.code, 0, remote.err)
  assert.equal(readFileSync(join(remote.out.trim(), 'remote.txt'), 'utf8'), 'remote\n')
  assert.match(remote.err, new RegExp(`workspace: base: origin/feat/remote-only at ${g(other, 'rev-parse', 'feat/remote-only')}\n`))

  // A branch only the source holds: the local branch, said so.
  g(src, 'checkout', '-q', '-b', 'feat/local-only')
  writeFileSync(join(src, 'local.txt'), 'local\n')
  g(src, 'add', '-A')
  g(src, 'commit', '-q', '-m', 'Local')
  const localOnly = await ws(w, 'create', src, 'local', '--base', 'feat/local-only')
  assert.equal(localOnly.code, 0, localOnly.err)
  assert.equal(readFileSync(join(localOnly.out.trim(), 'local.txt'), 'utf8'), 'local\n')
  assert.match(localOnly.err, new RegExp(`workspace: base: local branch feat/local-only at ${g(src, 'rev-parse', 'HEAD')}, origin has none\n`))

  // No branch of that name anywhere: refused, nothing left behind.
  assert.equal((await ws(w, 'create', src, 'none', '--base', 'feat/nowhere')).err, 'workspace: create: the source has no branch or origin/ remote-tracking ref feat/nowhere\n')
  assert.ok(!existsSync(join(dir, 'root', 'based', 'none')))

  // An origin that cannot be read: the local branch, said so; with no local branch, a refusal.
  g(src, 'remote', 'set-url', 'origin', join(dir, 'gone.git'))
  const offline = await ws(w, 'create', src, 'offline', '--base', 'feat/local-only')
  assert.equal(offline.code, 0, offline.err)
  assert.match(offline.err, new RegExp(`workspace: base: local branch feat/local-only at ${g(src, 'rev-parse', 'HEAD')}, origin unreadable \\(`))
  const refused = await ws(w, 'create', src, 'gone', '--base', 'feat/remote-only')
  assert.equal(refused.code, 1)
  assert.match(refused.err, /^workspace: create: cannot read origin to resolve feat\/remote-only: /)
  assert.ok(!existsSync(join(dir, 'root', 'based', 'gone')))
})

test('create --base: origin/<branch> works for a branch only the origin holds, a silent probe names its reason, and no credential is asked', async () => {
  const src = pushed('probed')
  const other = join(dir, 'elsewhere-probed')
  execFileSync('git', ['clone', '-q', '-b', 'main', join(dir, 'probed.git'), other])
  g(other, 'checkout', '-q', '-b', 'feat/remote-only')
  writeFileSync(join(other, 'remote.txt'), 'remote\n')
  g(other, 'add', '-A')
  g(other, 'commit', '-q', '-m', 'Remote')
  g(other, 'push', '-q', 'origin', 'feat/remote-only')
  const w = world()

  // The source never fetched that branch, so `origin/<branch>` is no ref of its own: the origin is asked for the bare name.
  const named = await ws(w, 'create', src, 'named', '--base', 'origin/feat/remote-only')
  assert.equal(named.code, 0, named.err)
  assert.equal(readFileSync(join(named.out.trim(), 'remote.txt'), 'utf8'), 'remote\n')
  assert.match(named.err, new RegExp(`workspace: base: origin/feat/remote-only at ${g(other, 'rev-parse', 'feat/remote-only')}\n`))

  // The probe never prompts for a credential, and one that gets no answer says so, with or without a local branch.
  const probes: (RunOptions | undefined)[] = []
  const real = w.deps.run
  const silent: Run = async (argv, options) => {
    if (argv.includes('ls-remote')) {
      probes.push(options)
      return { status: null, stdout: '', stderr: '' }
    }
    return real(argv, options)
  }
  const mute = { ...w, deps: { ...w.deps, run: silent } }
  g(src, 'branch', 'feat/local-only')
  const offline = await ws(mute, 'create', src, 'offline', '--base', 'feat/local-only')
  assert.equal(offline.code, 0, offline.err)
  assert.match(offline.err, /workspace: base: local branch feat\/local-only at [0-9a-f]+, origin unreadable \(no answer within 30 s\)\n/)
  const refused = await ws(mute, 'create', src, 'refused', '--base', 'feat/remote-only')
  assert.equal(refused.code, 1)
  assert.equal(refused.err, 'workspace: create: cannot read origin to resolve feat/remote-only: no answer within 30 s\n')
  assert.equal(probes.length, 2)
  for (const options of probes) assert.equal(options?.env?.['GIT_TERMINAL_PROMPT'], '0')
})

test('create: a nested worktree or repository in the source is skipped from the copy, and a failed copy names its path', async () => {
  const src = repo(join(dir, 'src', 'nested'))
  mkdirSync(join(src, '.claude', 'worktrees'), { recursive: true })
  g(src, 'worktree', 'add', '-q', join(src, '.claude', 'worktrees', 'old'), '-b', 'old')
  writeFileSync(join(src, '.claude', 'worktrees', 'old', 'inside.txt'), 'inside')
  writeFileSync(join(src, '.claude', 'kept.md'), 'kept')
  repo(join(src, 'scratch', 'sub'))
  writeFileSync(join(src, 'scratch', 'plain.txt'), 'plain')
  writeFileSync(join(src, '.git', 'info', 'exclude'), 'scratch/\n')
  const w = world()
  const r = await ws(w, 'create', src, 'copy')
  assert.equal(r.code, 0, r.err)
  const c = r.out.trim()
  assert.equal(readFileSync(join(c, '.claude', 'kept.md'), 'utf8'), 'kept')
  assert.ok(!existsSync(join(c, '.claude', 'worktrees')), 'a nested worktree never travels')
  assert.equal(readFileSync(join(c, 'scratch', 'plain.txt'), 'utf8'), 'plain')
  assert.ok(!existsSync(join(c, 'scratch', 'sub')), 'a nested repository never travels')

  assert.deepEqual(['a/b', 'a/.git/x', 'a/', 'a/.gitignore'].map(copyable), [true, false, false, true])
  const failure = copyFiles(dir, join(dir, 'into'), ['ghost.txt'])
  assert.equal(failure?.path, 'ghost.txt')
  assert.match(failure?.error ?? '', /ENOENT/)
  assert.equal(copyFiles(dir, join(dir, 'into'), []), undefined)
})

/** Whether this machine can run an LFS filter. */
const lfs = ((): boolean => {
  try {
    execFileSync('git-lfs', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const lfsSkip = { skip: !lfs && 'git-lfs is not installed' }

/** Runs `body` with git's global config naming the LFS filter. */
async function withLfs(body: () => Promise<void>): Promise<void> {
  const config = join(dir, 'lfs-gitconfig')
  writeFileSync(config, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n')
  process.env['GIT_CONFIG_GLOBAL'] = config
  try {
    await body()
  } finally {
    process.env['GIT_CONFIG_GLOBAL'] = '/nonexistent/gitconfig'
  }
}

/** A pushed source whose `files`, name to content, are LFS objects both it and its origin hold. */
function pushedLfs(name: string, files: Readonly<Record<string, string>>): string {
  const src = pushed(name)
  writeFileSync(join(src, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  for (const [file, content] of Object.entries(files)) writeFileSync(join(src, file), content)
  g(src, 'add', '-A')
  g(src, 'commit', '-q', '-m', 'Large')
  g(src, 'push', '-q', 'origin', 'main')
  return src
}

/** Where an LFS store keeps the object of that content. */
function objectOf(store: string, content: string): string {
  const oid = createHash('sha256').update(content).digest('hex')
  return join(store, oid.slice(0, 2), oid.slice(2, 4), oid)
}

/** Every entry under `at`, links followed, with whether it is itself a link. */
function entries(at: string, under = ''): { path: string; link: boolean }[] {
  return readdirSync(join(at, under)).sort().flatMap(name => {
    const path = join(under, name)
    const own = { path, link: lstatSync(join(at, path)).isSymbolicLink() }
    return statSync(join(at, path)).isDirectory() ? [own, ...entries(at, path)] : [own]
  })
}

test('create --base: the checkout takes the LFS objects the source holds, and names what git said of one nobody holds', lfsSkip, async () => {
  await withLfs(async () => {
    const src = pushedLfs('large', { 'big.bin': 'large content\n' })
    // The origin serves no LFS object from here on: a download from it fails, as a network's does.
    rmSync(join(dir, 'large.git', 'lfs'), { recursive: true, force: true })
    const w = world()
    const r = await ws(w, 'create', src, 'held', '--base', 'main')
    assert.equal(r.code, 0, r.err)
    assert.equal(readFileSync(join(r.out.trim(), 'big.bin'), 'utf8'), 'large content\n')
    assert.equal(g(r.out.trim(), 'status', '--porcelain'), '')
    const inode = (checkout: string): number => statSync(objectOf(join(checkout, '.git', 'lfs', 'objects'), 'large content\n')).ino
    assert.equal(inode(r.out.trim()), inode(src), 'the object is shared, no second copy of its bytes')

    rmSync(join(src, '.git', 'lfs'), { recursive: true, force: true })
    const refused = await ws(w, 'create', src, 'lost', '--base', 'main')
    assert.equal(refused.code, 1)
    assert.match(refused.err, /^workspace: create: cannot check out main from origin\/main: Error downloading object: big\.bin .*\n$/)
    assert.ok(!existsSync(join(dir, 'root', 'large', 'lost')))
  })
})

test('create --base: a source whose LFS store is reached through links gains nothing, and the checkout holds no link into it', lfsSkip, async () => {
  await withLfs(async () => {
    const files = { 'a.bin': 'first\n', 'b.bin': 'second\n', 'c.bin': 'third\n' }
    const src = pushedLfs('linked', files)
    const objects = join(src, '.git', 'lfs', 'objects')
    const store = join(dir, 'shared-store')
    // A link at the store, one at a directory inside it, one at an object; one object only the origin has.
    renameSync(objects, store)
    symlinkSync(store, objects)
    const prefix = dirname(objectOf(store, files['a.bin']))
    renameSync(prefix, join(dir, 'elsewhere-prefix'))
    symlinkSync(join(dir, 'elsewhere-prefix'), prefix)
    renameSync(objectOf(store, files['c.bin']), join(dir, 'elsewhere-object'))
    symlinkSync(join(dir, 'elsewhere-object'), objectOf(store, files['c.bin']))
    renameSync(objectOf(store, files['b.bin']), join(dir, 'only-on-the-origin'))
    const before = entries(store)
    const r = await ws(world(), 'create', src, 'co', '--base', 'main')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(entries(store), before, "the source's store is as it was")
    const own = join(r.out.trim(), '.git', 'lfs', 'objects')
    assert.ok(!lstatSync(own).isSymbolicLink())
    assert.deepEqual(entries(own).filter(e => e.link), [])
    for (const [file, content] of Object.entries(files)) assert.equal(readFileSync(join(r.out.trim(), file), 'utf8'), content)
  })
})

/** A source of two LFS files whose own objects of them are short, and the paths of those objects. */
function pushedShort(name: string): { readonly src: string; readonly files: Readonly<Record<string, string>>; readonly held: readonly string[] } {
  const files = { 'big.bin': 'large content\n', 'other.bin': 'other content\n' }
  const src = pushedLfs(name, files)
  const held = Object.values(files).map((content, k) => {
    const object = objectOf(join(src, '.git', 'lfs', 'objects'), content)
    // A new inode of the source's own: the push had linked the origin's to the first.
    renameSync(object, join(dir, `${name}-whole-${k}`))
    writeFileSync(object, 'short')
    return object
  })
  return { src, files, held }
}

/** The world, counting its checkouts. */
function countingCheckouts(): { readonly w: World; readonly count: () => number } {
  const w = world()
  const real = w.deps.run
  let n = 0
  w.deps = { ...w.deps, run: async (argv, options) => {
    if (argv.includes('checkout')) n++
    return real(argv, options)
  } }
  return { w, count: () => n }
}

test('create --base: wrong-size LFS objects in the source fail no create, and are never rewritten there', lfsSkip, async () => {
  await withLfs(async () => {
    const { src, files, held } = pushedShort('short')
    const { w, count } = countingCheckouts()
    const r = await ws(w, 'create', src, 'co', '--base', 'main')
    assert.equal(r.code, 0, r.err)
    const c = r.out.trim()
    for (const [file, content] of Object.entries(files)) assert.equal(readFileSync(join(c, file), 'utf8'), content)
    assert.equal(g(c, 'status', '--porcelain'), '')
    assert.equal(g(c, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main')
    assert.deepEqual(held.map(object => readFileSync(object, 'utf8')), ['short', 'short'], "the source's objects are as they were")
    assert.equal(count(), 2)
    assert.match(r.err, /^workspace: the checkout failed with the source's LFS objects, run again without them: .*big\.bin.*$/m)
  })
})

test("create --base: the checkout run again fails once for all, its message carrying git's cause", lfsSkip, async () => {
  await withLfs(async () => {
    const { src } = pushedShort('both')
    renameSync(join(dir, 'both.git', 'lfs'), join(dir, 'both-origin-lfs'))
    const { w, count } = countingCheckouts()
    const r = await ws(w, 'create', src, 'co', '--base', 'main')
    assert.equal(r.code, 1)
    assert.match(r.err.split('\n').at(-2) ?? '', /^workspace: create: cannot check out main from origin\/main: Error downloading object: \S+\.bin /)
    assert.equal(count(), 2)
    assert.ok(!existsSync(join(dir, 'root', 'both', 'co')))
  })
})

test('create --base: LFS objects that cannot all be carried are said so, and the checkout downloads the rest', lfsSkip, async () => {
  await withLfs(async () => {
    const src = pushedLfs('torn', { 'big.bin': 'large content\n' })
    // A link to nothing, read before every object: the pass stops there, whoever runs it.
    symlinkSync(join(dir, 'nowhere'), join(src, '.git', 'lfs', 'objects', '00-dangling'))
    const r = await ws(world(), 'create', src, 'co', '--base', 'main')
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /^workspace: the source's LFS objects were not all carried, the checkout downloads the rest: .*00-dangling.*$/m)
    assert.equal(readFileSync(join(r.out.trim(), 'big.bin'), 'utf8'), 'large content\n')
  })
})

test('an LFS object the filesystem will not link is copied', () => {
  mkdirSync(join(dir, 'store', 'aa'), { recursive: true })
  writeFileSync(join(dir, 'store', 'aa', 'object'), 'bytes')
  carryStore(join(dir, 'store'), join(dir, 'own'), () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }) })
  assert.equal(readFileSync(join(dir, 'own', 'aa', 'object'), 'utf8'), 'bytes')
  assert.notEqual(statSync(join(dir, 'own', 'aa', 'object')).ino, statSync(join(dir, 'store', 'aa', 'object')).ino)
})

test("create: every git step that fails carries git's first stderr line, or its status when it said nothing", async () => {
  const src = pushed('said')
  const w = world()
  const real = w.deps.run
  // As the real runner: the stderr comes back only to a caller that asked for it.
  const failing = (verb: string, ran: Ran): World => ({
    ...w, deps: { ...w.deps, run: async (argv, options) => argv.includes(verb) ? { ...ran, stderr: options?.stderr === 'pipe' ? ran.stderr : '' } : real(argv, options) },
  })
  const ran: Ran = { status: 128, stdout: '', stderr: 'fatal: the reason\nand more\n' }
  const url = join(dir, 'said.git')
  for (const [verb, what] of [
    ['clone', `clone failed from ${src}`], ['set-url', `cannot point origin at ${url}`],
    ['fetch', `cannot fetch main from ${url}`], ['checkout', 'cannot check out main from origin/main'],
  ] as const) {
    const r = await ws(failing(verb, ran), 'create', src, verb, '--base', 'main')
    assert.deepEqual([r.code, r.err.split('\n').at(-2)], [1, `workspace: create: ${what}: fatal: the reason`])
  }
  const mute = await ws(failing('checkout', { status: 1, stdout: '', stderr: '' }), 'create', src, 'mute', '--base', 'main')
  assert.equal(mute.err.split('\n').at(-2), 'workspace: create: cannot check out main from origin/main: git exited 1')
  const killed = await ws(failing('clone', { status: null, stdout: '', stderr: '' }), 'create', src, 'killed')
  assert.equal(killed.err, `workspace: create: clone failed from ${src}: git gave no exit status\n`)
})

test('create: a copy that fails removes the checkout and names the step', async () => {
  const src = repo(join(dir, 'src', 'few'))
  writeFileSync(join(src, 'locked.txt'), 'x')
  writeFileSync(join(src, '.git', 'info', 'exclude'), 'locked.txt\n')
  const w = world()
  w.deps = { ...w.deps, run: async (argv: readonly [string, ...string[]], options?: RunOptions) => {
    // A copy that cannot read: the exclude file's listing names a file that is not there.
    if (argv.includes('--exclude-from=' + join(src, '.git', 'info', 'exclude')) && !argv.includes('--directory')) return ok('missing.txt\0')
    return run(argv, options)
  } }
  const r = await ws(w, 'create', src, 'locked')
  assert.equal(r.code, 1)
  assert.match(r.err, /workspace: create: copying the excluded files failed\n$/)
  assert.match(r.err, /workspace: copy failed at missing\.txt: .*ENOENT/)
  assert.ok(!existsSync(join(dir, 'root', 'few', 'locked')))
})

test('pin: a detached worktree with the global excludes only, its pull request recorded; delete makes the source forget it', async () => {
  const src = pushed('proj')
  writeFileSync(join(src, 'LOCAL.md'), 'local')
  writeFileSync(join(src, 'NOTES.md'), 'notes')
  writeFileSync(join(src, '.git', 'info', 'exclude'), 'LOCAL.md\n')
  writeFileSync(join(dir, 'global-ignore'), 'NOTES.md\nLOCAL.md\n')
  const w = world({ XDG_CONFIG_HOME: join(dir, 'xdg') })
  mkdirSync(join(dir, 'xdg', 'git'), { recursive: true })
  writeFileSync(join(dir, 'xdg', 'git', 'ignore'), 'NOTES.md\nLOCAL.md\n')
  process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg')
  try {
    const r = await ws(w, 'pin', src, 'round-1', 'main', '--pr', '7')
    const p = join(dir, 'root', 'proj', 'round-1')
    assert.deepEqual([r.code, r.out], [0, `${p}\n`], r.err)
    assert.match(r.err, /copied 1 files kept out by the global excludes\n.*pinned [0-9a-f]+ from main\n$/s)
    assert.equal(g(p, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
    assert.equal(readFileSync(join(p, 'NOTES.md'), 'utf8'), 'notes')
    assert.ok(!existsSync(join(p, 'LOCAL.md')), "the source's own exclude file's material stays")
    assert.equal(readFileSync(join(g(p, 'rev-parse', '--absolute-git-dir'), 'workspace-pr'), 'utf8'), '7\n')
    assert.equal((await ws(w, 'list')).out, `${join(dir, 'root')}/proj/round-1 | HEAD | ${g(p, 'rev-parse', '--short', 'HEAD')} | clean | pinned\n`)
    assert.equal((await ws(w, 'pin', src, 'round-9', 'nope')).err, "workspace: pin: the source does not know nope (--pr <n> makes pin fetch that pull request's head)\n")
    assert.equal((await ws(w, 'pin', src, 'round-1', 'main')).err, `workspace: pin: already exists, delete it first: ${p}\n`)
    assert.equal((await ws(w, 'pin', src, 'bad/name', 'main')).code, 1)
    const d = await ws(w, 'delete', p)
    assert.deepEqual([d.code, d.out], [0, `deleted ${p}\n`], d.err)
    assert.ok(!g(src, 'worktree', 'list').includes('round-1'))
  } finally {
    delete process.env['XDG_CONFIG_HOME']
  }
})

test("pin: --pr fetches the pull request's head the source lacks; without it, or for a sha it does not hold, pin refuses", async () => {
  const src = pushed('fetchpr')
  const bare = join(dir, 'fetchpr.git')
  const other = repo(join(dir, 'other'))
  g(other, 'remote', 'add', 'origin', bare)
  writeFileSync(join(other, 'pr.txt'), 'pr\n')
  g(other, 'add', '-A')
  g(other, 'commit', '-q', '-m', 'Pr')
  const head = g(other, 'rev-parse', 'HEAD')
  g(other, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/5/head`)
  const w = world()
  assert.throws(() => g(src, 'cat-file', '-e', head), /Command failed/)
  const no = await ws(w, 'pin', src, 'r0', head)
  assert.match(no.err, /the source does not know [0-9a-f]+ \(--pr <n> makes pin fetch/)
  const miss = await ws(w, 'pin', src, 'r1', 'f'.repeat(40), '--pr', '5')
  assert.match(miss.err, /does not know f+; the head of pull request 5 does not contain it/)
  const r = await ws(w, 'pin', src, 'r2', head, '--pr', '5')
  assert.equal(r.code, 0, r.err)
  assert.equal(g(join(dir, 'root', 'fetchpr', 'r2'), 'rev-parse', 'HEAD'), head)
  const bad = await ws(w, 'pin', src, 'r3', 'f'.repeat(40), '--pr', '404')
  assert.match(bad.err, /fetch of pull request 404 failed: /)
})

test('delete: every guard refuses, says why, and --discard overrides the checkout\'s own', async () => {
  const src = pushed('proj')
  const w = world()
  const refused = async (path: string, why: string): Promise<void> => {
    assert.deepEqual(await ws(w, 'delete', path), { code: 1, out: '', err: `workspace: delete: ${why} (pass --discard to remove it anyway): ${path}\n` })
    assert.ok(existsSync(path))
  }
  const dirty = await clone(w, src, 'dirty', 'feat/dirty', 'dirty')
  await refused(dirty, 'the tree is dirty')
  const untracked = await clone(w, src, 'untracked', 'feat/untracked')
  writeFileSync(join(untracked, 'new.txt'), 'new')
  await refused(untracked, 'the tree is dirty')
  const unpushed = await clone(w, src, 'unpushed', 'feat/unpushed', 'unpushed')
  await refused(unpushed, 'commits on no remote branch')
  const detached = await clone(w, src, 'detached', 'feat/detached')
  g(detached, 'checkout', '-q', '--detach')
  g(detached, 'commit', '-q', '--allow-empty', '-m', 'On a detached head')
  await refused(detached, 'commits on no remote branch')
  const stash = await clone(w, src, 'stash', 'feat/stash')
  writeFileSync(join(stash, 'stash.txt'), 'more')
  g(stash, 'stash', '-q')
  await refused(stash, 'a stash is held')
  const broken = await clone(w, src, 'broken', 'feat/broken')
  writeFileSync(join(broken, '.git', 'HEAD'), 'garbage\n')
  const r = await ws(w, 'delete', broken)
  assert.equal(r.code, 1)
  assert.match(r.err, /^workspace: delete: git cannot read the checkout: .+ \(pass --discard/)
  const live = await clone(w, src, 'live', 'feat/live')
  w.cwds = lsofOf(join(live, 'sub'))
  await refused(live, 'a live process has its working directory inside')
  w.cwds = { status: 1, stdout: '', stderr: '' }
  await refused(live, 'the process table cannot be read')
  w.cwds = lsofOf('/elsewhere')
  const p = join(dir, 'root', 'proj', 'pin')
  assert.equal((await ws(w, 'pin', src, 'pin', 'main')).code, 0)
  g(p, 'commit', '-q', '--allow-empty', '-m', 'On no branch')
  await refused(p, "the pin's head is on no branch of the source")
  for (const path of [dirty, untracked, unpushed, detached, stash, broken, live, p]) {
    assert.deepEqual(await ws(w, 'delete', path, '--discard'), { code: 0, out: `deleted ${path}\n`, err: '' }, path)
    assert.ok(!existsSync(path))
  }
  assert.ok(!g(src, 'worktree', 'list').includes('/pin '), 'a discarded pin is forgotten by its source')
})

test('delete: an ignored file is not work, and holds no delete', async () => {
  // The suspected defect « ignored files outside the delete guard », dropped: what git ignores is
  // what the project keeps out of history, and `create` ignores its own copies so they never hold a delete.
  const src = pushed('proj')
  writeFileSync(join(src, '.gitignore'), 'dist/\n')
  g(src, 'add', '.gitignore')
  g(src, 'commit', '-q', '-m', 'Ignore the build')
  g(src, 'push', '-q', 'origin', 'main')
  writeFileSync(join(src, 'LOCAL.md'), 'local')
  writeFileSync(join(src, '.git', 'info', 'exclude'), 'LOCAL.md\n')
  const w = world()
  const c = await clone(w, src, 'built', 'feat/built')
  mkdirSync(join(c, 'dist'))
  writeFileSync(join(c, 'dist', 'out.js'), 'built')
  writeFileSync(join(c, 'LOCAL.md'), 'edited in the checkout')
  assert.deepEqual(await ws(w, 'delete', c), { code: 0, out: `deleted ${c}\n`, err: '' })
  assert.equal(readFileSync(join(src, 'LOCAL.md'), 'utf8'), 'local', 'the original stays in the source')
})

test('delete: the path must be a checkout under the root, the root readable, the trash usable', async () => {
  const src = pushed('proj')
  const w = world()
  assert.deepEqual(await ws(w, 'delete'), { code: 1, out: '', err: 'workspace: delete: usage: delete <path> [--discard]\n' })
  assert.equal((await ws(w, 'delete', 'a', 'b')).err, 'workspace: delete: unexpected argument b\n')
  assert.equal((await ws(w, 'delete', 'a', '--force')).err, 'workspace: delete: unknown option --force\n')
  assert.equal((await ws(w, 'delete', join(dir, 'none'))).err, `workspace: delete: no such checkout: ${join(dir, 'none')}\n`)
  mkdirSync(join(dir, 'root', 'proj'), { recursive: true })
  assert.equal((await ws(w, 'delete', src)).err, `workspace: delete: refusing a path outside ${join(dir, 'root')}: ${src}\n`)
  assert.equal((await ws(w, 'delete', join(dir, 'root', 'proj'))).err, `workspace: delete: refusing a path outside ${join(dir, 'root')}: ${join(dir, 'root', 'proj')}\n`)
  writeFileSync(join(dir, 'file'), '')
  const nowhere = world({ ORCHESTRATOR_WORKSPACES: join(dir, 'file', 'root') })
  assert.equal((await ws(nowhere, 'delete', src)).err, `workspace: delete: cannot read the root ${join(dir, 'file', 'root')}\n`)
  const c = await clone(w, src, 'c', 'feat/c')
  writeFileSync(join(dir, 'root', '.trash'), 'a file where the trash goes')
  assert.equal((await ws(w, 'delete', c)).err, `workspace: delete: cannot move into the trash: ${c}\n`)
  assert.ok(existsSync(c))
  rmSync(join(dir, 'root', '.trash'))
  const p = join(dir, 'root', 'proj', 'pin')
  await ws(w, 'pin', src, 'pin', 'main')
  writeFileSync(join(p, '.git'), 'gitdir: /nowhere\n')
  assert.equal((await ws(w, 'delete', p, '--discard')).err, `workspace: delete: cannot read the pin's source: ${p}\n`)
  // A relative path is read against the caller's directory.
  const there: World = { ...w, deps: { ...w.deps, cwd: join(dir, 'root') } }
  assert.deepEqual(await ws(there, 'delete', 'proj/c'), { code: 0, out: `deleted ${c}\n`, err: '' })
})

test('delete takes the host temporary directory of each spelling, unless a live process uses it', async () => {
  const src = pushed('proj')
  const w = world()
  const host = join(dir, 'host')
  const scratch = (c: string): string => {
    const h = join(host, encode(c))
    mkdirSync(join(h, 'scratchpad', 's1'), { recursive: true })
    return h
  }
  const a = await clone(w, src, 'del.a_x', 'feat/a')
  const ha = scratch(a)
  mkdirSync(join(dir, 'link-root'))
  symlinkSync(join(dir, 'root', 'proj'), join(dir, 'link-root', 'proj'))
  const logical = join(dir, 'link-root', 'proj', 'del.a_x')
  const hl = scratch(logical)
  assert.deepEqual(await ws(w, 'delete', logical), { code: 0, out: `deleted ${a}\ndeleted ${ha}\ndeleted ${hl}\n`, err: '' })
  const b = await clone(w, src, 'b', 'feat/b')
  const hb = scratch(b)
  w.cwds = lsofOf(join(hb, 'scratchpad'))
  assert.deepEqual(await ws(w, 'delete', b), { code: 0, out: `deleted ${b}\n`, err: `workspace: kept host temporary directory ${hb}: a live process works inside\n` })
  assert.ok(existsSync(hb))
  const c = await clone(w, src, 'c', 'feat/c')
  const hc = scratch(c)
  w.cwds = lsofOf(join(c, 'sub', 'deeper'))
  assert.equal((await ws(w, 'delete', c, '--discard')).err, `workspace: kept host temporary directory ${hc}: a live process works in the directory it is named after\n`)
  const d = await clone(w, src, 'd', 'feat/d')
  const hd = scratch(d)
  let reads = 0
  w.cwds = lsofOf('/elsewhere')
  const counting = w.deps.run
  w.deps = { ...w.deps, run: async (argv: readonly [string, ...string[]], options?: RunOptions) => {
    if (argv[0] === 'lsof' && ++reads > 1) return { status: 1, stdout: '', stderr: '' }
    return counting(argv, options)
  } }
  assert.deepEqual(await ws(w, 'delete', d), { code: 0, out: `deleted ${d}\ndeleted ${hd}\n`, err: '' }, 'the table is read once per run')
  assert.equal(reads, 1)
  assert.ok(!existsSync(hd))
  const e = await clone(w, src, 'e', 'feat/e')
  const he = scratch(e)
  w.deps = { ...w.deps, run: counting }
  w.cwds = { status: 1, stdout: '', stderr: '' }
  assert.equal((await ws(w, 'delete', e, '--discard')).err, `workspace: kept host temporary directory ${he}: the process table cannot be read\n`)
  // A relative working directory in the table ends the walk instead of spinning.
  const f = await clone(w, src, 'f', 'feat/f')
  w.cwds = 'p1\nfcwd\nnrelative/dir\np2\nfcwd\nn/\n'
  assert.equal((await ws(w, 'delete', f)).code, 0)
  const hostless = world({ ORCHESTRATOR_HOST_TMP: 'relative' })
  const h = await clone(hostless, src, 'h', 'feat/h')
  assert.deepEqual(await ws(hostless, 'delete', h), { code: 0, out: `deleted ${h}\n`, err: '' }, 'a host area that is not absolute is never read')
})

test('a removal goes through the trash: what it cannot remove stays there, said, and the next sweep empties it', async () => {
  if (process.getuid?.() === 0) return // root removes a directory it may not write into.
  const src = pushed('proj')
  const w = world()
  const c = await clone(w, src, 'j', 'feat/j')
  mkdirSync(join(c, 'locked'))
  writeFileSync(join(c, 'locked', 'f'), 'x')
  chmodSync(join(c, 'locked'), 0o555)
  const r = await ws(w, 'delete', c, '--discard')
  assert.equal(r.code, 0)
  assert.match(r.err, /the trash keeps .*: the next sweep empties it/)
  assert.ok(!existsSync(c))
  assert.equal(readdirSync(join(dir, 'root', '.trash')).length, 1)
  assert.match((await ws(w, 'sweep')).out, /^deleted .*\.trash/)
  assert.equal(readdirSync(join(dir, 'root', '.trash')).length, 0)
})

test('sweep empties the trashes first; a dry run says so and empties nothing', async () => {
  const w = world()
  mkdirSync(join(dir, 'root', '.trash', 'zy'), { recursive: true })
  mkdirSync(join(dir, 'host', '.workspace-trash', 'zz', 'x'), { recursive: true })
  chmodSync(join(dir, 'host', '.workspace-trash', 'zz', 'x'), 0o555)
  const dry = await ws(w, 'sweep', '--dry-run')
  assert.equal(dry.out, `would delete ${join(dir, 'root', '.trash', 'zy')}: left in the trash by a removal cut short\n`
    + `would delete ${join(dir, 'host', '.workspace-trash', 'zz')}: left in the trash by a removal cut short\n`)
  assert.equal(readdirSync(join(dir, 'root', '.trash')).length, 1)
  assert.equal((await ws(w, 'sweep')).out, `deleted ${join(dir, 'root', '.trash', 'zy')}\ndeleted ${join(dir, 'host', '.workspace-trash', 'zz')}\n`)
  assert.equal((await ws(w, 'list')).out, '', 'the trash is never a checkout')
})

test('sweep decides on facts read in the machine\'s pull request file, asks the forge nothing, and keeps what any guard holds', async () => {
  const src = pushed('proj')
  const src2 = pushed('proj2')
  const src3 = pushed('proj3', 'stable')
  const w = world()
  const head = (c: string): string => g(c, 'rev-parse', 'HEAD')
  const merged = await clone(w, src, 'merged', 'feat/merged')
  const closed = await clone(w, src, 'closed', 'feat/closed')
  const open = await clone(w, src, 'open', 'feat/open')
  const nopr = await clone(w, src, 'nopr', 'feat/nopr')
  const dirty = await clone(w, src, 'dirty', 'feat/dirty', 'dirty')
  const live = await clone(w, src, 'live', 'feat/live')
  const odd = await clone(w, src, 'odd', 'feat/odd')
  const p2 = await clone(w, src2, 'p2', 'feat/p2')
  const onMain = await clone(w, src, 'on-main', 'feat/on-main')
  g(onMain, 'checkout', '-q', 'main')
  const stable = (await ws(w, 'create', src3, 'stable', '--base', 'stable')).out.trim()
  const past = await clone(w, src, 'past', 'feat/past')
  const behind = await clone(w, src, 'behind', 'feat/behind')
  writeFileSync(join(behind, 'second.txt'), 'second')
  g(behind, 'add', '-A')
  g(behind, 'commit', '-q', '-m', 'Second')
  g(behind, 'push', '-q', 'origin', 'feat/behind')
  const behindTip = head(behind)
  g(behind, 'reset', '-q', '--hard', 'HEAD~1')
  const detached = await clone(w, src, 'detached', 'feat/detached')
  g(detached, 'checkout', '-q', '--detach')
  const pinOf = async (name: string, pr?: string): Promise<string> => {
    const r = await ws(w, 'pin', src, name, 'main', ...(pr === undefined ? [] : ['--pr', pr]))
    assert.equal(r.code, 0, r.err)
    return r.out.trim()
  }
  const pMerged = await pinOf('p-merged', '7')
  const pMoved = await pinOf('p-moved', '8')
  const pSame = await pinOf('p-same', '9')
  const pNorec = await pinOf('p-norec')
  const pAbsent = await pinOf('p-absent', '99')
  const pDraft = await pinOf('p-draft', '10')
  const noOrigin = await clone(w, src, 'no-origin', 'feat/no-origin')
  g(noOrigin, 'remote', 'remove', 'origin')
  const origin = join(dir, 'proj.git')
  w.prs[origin] = ok(JSON.stringify([
    { number: 1, state: 'MERGED', headRefName: 'feat/merged', headRefOid: head(merged) },
    { number: 2, state: 'CLOSED', headRefName: 'feat/closed', headRefOid: head(closed) },
    { number: 3, state: 'OPEN', headRefName: 'feat/open', headRefOid: head(open) },
    { number: 4, state: 'MERGED', headRefName: 'feat/dirty', headRefOid: head(dirty) },
    { number: 6, state: 'MERGED', headRefName: 'feat/live', headRefOid: head(live) },
    { number: 7, state: 'MERGED', headRefName: 'feat/seven', headRefOid: '111' },
    { number: 8, state: 'OPEN', headRefName: 'feat/eight', headRefOid: '0'.repeat(40) },
    { number: 9, state: 'OPEN', headRefName: 'feat/nine', headRefOid: head(src) },
    { number: 10, state: 'DRAFT', headRefName: 'feat/ten', headRefOid: '222' },
    { number: 11, state: 'MERGED', headRefName: 'main', headRefOid: head(onMain) },
    { number: 12, state: 'MERGED', headRefName: 'feat/past', headRefOid: g(past, 'rev-parse', 'HEAD~1') },
    { number: 13, state: 'MERGED', headRefName: 'feat/behind', headRefOid: behindTip },
    { number: 14, state: 'WEIRD', headRefName: 'feat/odd', headRefOid: head(odd) },
  ]))
  w.prs[join(dir, 'proj2.git')] = ok(JSON.stringify([{ number: 1, state: 'MERGED', headRefName: 'feat/p2', headRefOid: head(p2) }]))
  w.cwds = lsofOf(live)
  const all = [merged, closed, open, nopr, dirty, live, odd, p2, onMain, stable, past, behind, detached, pMerged, pMoved, pSame, pNorec, pAbsent, pDraft, noOrigin]

  const dry = await ws(w, 'sweep', '--dry-run')
  assert.equal(dry.code, 0)
  assert.ok(all.every(existsSync), 'a dry run deletes nothing')
  assert.equal(dry.out.split('\n').filter(l => l.startsWith('would delete ')).length, 6)
  assert.equal(w.gh.length, 0, 'the forge is never asked: the file is the hooks module\'s to refresh')
  assert.deepEqual(readFileSync(join(dir, 'state', 'prs.wanted'), 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')[0]).sort(), ['acme/proj', 'acme/proj2'],
    'the repositories of the checkouts are asked of the file, a long-lived or default branch\'s none')

  const r = await ws(w, 'sweep')
  assert.equal(r.code, 0, r.err)
  const line = (c: string): string => r.out.split('\n').find(l => l.startsWith(`kept ${c}: `) || l === `deleted ${c}`) ?? ''
  assert.deepEqual([merged, closed, p2, behind, pMerged, pMoved].map(line), [merged, closed, p2, behind, pMerged, pMoved].map(c => `deleted ${c}`))
  assert.ok([merged, closed, p2, behind, pMerged, pMoved].every(c => !existsSync(c)))
  assert.deepEqual([open, nopr, dirty, live, odd, onMain, stable, past, detached, pSame, pNorec, pAbsent, pDraft, noOrigin].map(line), [
    `kept ${open}: pull request #3 for branch feat/open is open`,
    `kept ${nopr}: no pull request for branch feat/nopr`,
    `kept ${dirty}: the tree is dirty`,
    `kept ${live}: a live process has its working directory inside`,
    `kept ${odd}: no pull request for branch feat/odd`,
    `kept ${onMain}: on main, a long-lived branch`,
    `kept ${stable}: on stable, the repository's default branch`,
    `kept ${past}: the head is not the one of pull request #12 (MERGED): the branch moved past it`,
    `kept ${detached}: no branch checked out, so no pull request to match`,
    `kept ${pSame}: pinned to the current head of open pull request #9`,
    `kept ${pNorec}: no recorded pull request for this pin`,
    `kept ${pAbsent}: pull request #99 is not in the repository's list`,
    `kept ${pDraft}: pull request #10 is not in the repository's list`,
    `kept ${noOrigin}: pull requests unreadable: the checkout has no origin to ask`,
  ])
})

test('sweep: a repository the file holds no reading of keeps its checkouts, said once; a deadline stops', async () => {
  const src = pushed('proj')
  const w = world()
  const a = await clone(w, src, 'a', 'feat/a')
  const b = await clone(w, src, 'b', 'feat/b')
  const r = await ws(w, 'sweep')
  const why = "acme/proj is not in the machine's pull request file yet"
  assert.deepEqual(r.out.split('\n').filter(l => l !== ''), [`kept ${a}: pull requests unreadable: ${why}`, `kept ${b}: pull requests unreadable: ${why}`])
  assert.equal(r.err, `workspace: sweep: cannot read the pull requests of acme/proj (${why}); nothing is deleted for it\n`)
  const d = await ws(w, 'sweep', '--deadline', '0')
  assert.deepEqual(d, { code: 0, out: '', err: 'workspace: sweep: deadline of 0s spent; the rest waits for the next sweep\n' })
  assert.ok(existsSync(a) && existsSync(b))
})

test('sweep: an origin that is no GitHub repository keeps its checkout', async () => {
  const src = pushed('proj')
  const w = world()
  const c = await clone(w, src, 'c', 'feat/c')
  g(c, 'remote', 'set-url', 'origin', 'https://gitlab.example/acme/proj.git')
  assert.equal((await ws(w, 'sweep')).out, `kept ${c}: pull requests unreadable: https://gitlab.example/acme/proj.git is no GitHub repository\n`)
})

test('sweep: the orphans of deleted checkouts go, before any checkout; a live session or a sibling of the root keeps its own', async () => {
  const src = pushed('proj')
  const w = world()
  const host = join(dir, 'host')
  const root = join(dir, 'root')
  const kept = await clone(w, src, 'kept', 'feat/kept')
  mkdirSync(join(root, 'plain'))
  const e = encode(root)
  const made = (name: string): string => {
    mkdirSync(join(host, name, 'scratchpad'), { recursive: true })
    return join(host, name)
  }
  const gone = made(`${e}-proj-gone`)
  const project = made(`${e}-proj`)
  const plain = made(`${e}-plain`)
  const ownHost = made(encode(kept))
  const pastName = made(`${e}2-x`)
  const outside = made('-elsewhere-thing')
  const old = made(`${e}-old-x`)
  const liveStart = made(encode(join(kept, 'sub')))
  const liveIn = made(`${e}-proj-inside`)
  const unreadable = made(`${e}-proj-unknown`)
  symlinkSync(join(host, `${e}-proj-gone`), join(host, `${e}-proj-link`))
  writeFileSync(join(host, `${e}-proj-file`), '')
  w.cwds = lsofOf(join(kept, 'sub', 'deeper'), join(liveIn, 'scratchpad'))
  w.prs[join(dir, 'proj.git')] = ok('[]')
  const dry = await ws(w, 'sweep', '--dry-run')
  assert.deepEqual(dry.out.split('\n').filter(l => l !== ''), [
    `would delete ${gone}: no checkout, no live process`,
    `kept ${liveIn}: a live process works inside`,
    `kept ${liveStart}: a live process works in the directory it is named after`,
    `would delete ${unreadable}: no checkout, no live process`,
    `kept ${kept}: no pull request for branch feat/kept`,
  ])
  assert.ok(existsSync(gone))
  const r = await ws(w, 'sweep')
  assert.ok(r.out.startsWith(`deleted ${gone}\nkept ${liveIn}: a live process works inside\n`), r.out)
  for (const stays of [project, plain, ownHost, pastName, outside, old, liveStart, liveIn]) assert.ok(existsSync(stays), stays)
  assert.ok(!existsSync(gone) && !existsSync(unreadable))
  made(`${e}-proj-again`)
  w.cwds = { status: 1, stdout: '', stderr: '' }
  assert.match((await ws(w, 'sweep')).out, /^kept .*-proj-again: the process table cannot be read$/m)
  assert.deepEqual(await ws(w, 'sweep', '--deadline', '0'), { code: 0, out: '', err: 'workspace: sweep: deadline of 0s spent; the rest waits for the next sweep\n' })
})

test('list <repo>: only that repository\'s checkouts, named by its directory or as owner/name', async () => {
  const proj = pushed('proj')
  const other = pushed('other')
  const w = world()
  const c = await clone(w, proj, 'c', 'feat/c')
  const o = await clone(w, other, 'o', 'feat/o')
  const short = (p: string): string => g(p, 'rev-parse', '--short', 'HEAD')
  const root = join(dir, 'root')
  const line = (p: string, name: string, repo: string, branch: string): string => `${root}/${repo}/${name} | ${branch} | ${short(p)} | clean | pushed\n`
  assert.equal((await ws(w, 'list', 'proj')).out, line(c, 'c', 'proj', 'feat/c'))
  assert.equal((await ws(w, 'list', 'acme/proj')).out, line(c, 'c', 'proj', 'feat/c'), 'owner/name reads as its last part')
  assert.equal((await ws(w, 'list', 'other/')).out, line(o, 'o', 'other', 'feat/o'), 'a trailing slash is no part of the name')
  const all = line(o, 'o', 'other', 'feat/o') + line(c, 'c', 'proj', 'feat/c')
  assert.deepEqual(await ws(w, 'list', 'none'), { code: 0, out: all, err: `workspace: list: no directory none under ${root}; every checkout follows\n` }, 'a name no directory carries lists everything, and says so')
  assert.equal((await ws(w, 'list')).out, line(o, 'o', 'other', 'feat/o') + line(c, 'c', 'proj', 'feat/c'), 'without one, every repository')
  assert.deepEqual(await ws(w, 'list', 'a', 'b'), { code: 1, out: '', err: 'workspace: list: usage: list [<repo>]\n' })
})

test('list reads a checkout without running the fsmonitor or the hooks its own settings name', async () => {
  const src = pushed('proj')
  const w = world()
  const c = await clone(w, src, 'agent', 'work')
  const marker = join(dir, 'ran')
  const script = join(dir, 'fsmonitor.sh')
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\n`)
  chmodSync(script, 0o755)
  mkdirSync(join(dir, 'hooks'))
  g(c, 'config', 'core.fsmonitor', script)
  g(c, 'config', 'core.hooksPath', join(dir, 'hooks'))
  assert.match((await ws(w, 'list')).out, /agent \| work \| \S+ \| clean \| pushed\n$/)
  assert.equal(existsSync(marker), false, 'the checkout\'s fsmonitor ran')
  g(c, 'status', '--porcelain')
  assert.equal(existsSync(marker), true, 'a plain git status runs it: the test reads what it claims')
})

test('list: one line per checkout under the root, the trash and loose files left out', async () => {
  const src = pushed('proj')
  const w = world()
  const c = await clone(w, src, 'c', 'feat/c', 'unpushed')
  const d = await clone(w, src, 'd', 'feat/d', 'dirty')
  mkdirSync(join(dir, 'root', 'proj', 'not-a-checkout'))
  writeFileSync(join(dir, 'root', 'proj', 'loose'), '')
  mkdirSync(join(dir, 'root', '.trash', 'x', 'y'), { recursive: true })
  const short = (p: string): string => g(p, 'rev-parse', '--short', 'HEAD')
  assert.equal((await ws(w, 'list')).out,
    `${join(dir, 'root')}/proj/c | feat/c | ${short(c)} | clean | unpushed\n${join(dir, 'root')}/proj/d | feat/d | ${short(d)} | dirty | pushed\n`)
})

// --- the ledger of the checkouts ---------------------------------------------------------------

/** The host's registry under the world's HOME: one record per session, `live` the pids that answer. */
function registry(w: World, sessions: readonly { pid: number; name: string; cwd: string }[], live: ReadonlySet<number>): void {
  const at = join(dir, 'home', '.claude', 'sessions')
  rmSync(at, { recursive: true, force: true })
  mkdirSync(at, { recursive: true })
  for (const x of sessions) writeFileSync(join(at, `${x.pid}.json`), JSON.stringify({ pid: x.pid, sessionId: `s${x.pid}`, name: x.name, cwd: x.cwd }))
  w.deps = { ...w.deps, alive: pid => live.has(pid) }
}

const lines = (w: World): WorkspaceEntry[] => parseLedger(existsSync(ledgerPath(join(dir, 'root'))) ? readFileSync(ledgerPath(join(dir, 'root')), 'utf8') : '')
const lineOf = (w: World, path: string): WorkspaceEntry | undefined => lines(w).find(e => e.path === path)
const archived = (): Record<string, unknown>[] => {
  const a = archivePath(join(dir, 'root'))
  return existsSync(a) ? readFileSync(a, 'utf8').split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Record<string, unknown>) : []
}

/** A command run without the pull request file `ws` writes, whose GitHub origins no push may reach. */
async function bare(w: World, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  w.stdout.length = 0
  w.stderr.length = 0
  const code = await main(argv, w.deps)
  return { code, out: w.stdout.join(''), err: w.stderr.join('') }
}

const HOUR = 60 * 60 * 1000

/** Rewrites one line of the world's ledger, as another writer would. */
function changeEntryOf(path: string, change: (e: WorkspaceEntry) => WorkspaceEntry): void {
  const at = ledgerPath(join(dir, 'root'))
  writeFileSync(at, ledgerText(parseLedger(readFileSync(at, 'utf8')).map(e => (e.path === path ? change(e) : e))))
}

test('the ledger\'s readings: a line, the text, a name without its reference, the maker, the live sessions', () => {
  const e: WorkspaceEntry = { v: 1, path: '/r/p/a', kind: 'clone', repo: 'o/p', branch: 'b', orchestrator: 'Orch: X', agent: null, created: '2026-01-01T00:00:00.000Z' }
  assert.deepEqual(parseEntry(JSON.stringify(e)), e)
  for (const bad of ['', '{', '[]', JSON.stringify({ ...e, v: 2 }), JSON.stringify({ ...e, kind: 'other' }), JSON.stringify({ ...e, path: '' }), JSON.stringify({ ...e, agent: 3 })]) {
    assert.equal(parseEntry(bad), null, bad)
  }
  const z = { ...e, path: '/r/p/z' }
  assert.deepEqual(parseLedger(`${ledgerText([z, e])}garbage\n`), [e, z])
  assert.equal(bareName('Orch: Some project [5860a1]'), 'Orch: Some project')
  assert.equal(bareName('Agent: x'), 'Agent: x')
  const orch = { name: 'Orch: X', session: 's1', cwd: '/w', pid: 1 }
  const agent = { name: 'Agent: y', session: 's2', cwd: '/r/p/a', pid: 2 }
  assert.deepEqual(makerOf(orch, undefined), { orchestrator: 'Orch: X', agent: null })
  assert.deepEqual(makerOf(agent, 'Orch: X [abc123]'), { orchestrator: 'Orch: X', agent: 'Agent: y' })
  assert.deepEqual(makerOf(null, ''), { orchestrator: null, agent: null })
  assert.deepEqual(makerOf(null, 'Orch: X [abc123]'), { orchestrator: 'Orch: X', agent: null })
  assert.deepEqual(makerOf(agent, undefined), { orchestrator: null, agent: 'Agent: y' })
  assert.equal(parseEntry(JSON.stringify({ ...e, reason_at: 3 })), null)
  assert.equal(parseEntry(JSON.stringify({ ...e, adopted: 'yes' })), null)
  assert.equal(callerOf([orch, agent], 's2'), agent)
  assert.equal(callerOf([orch, agent], 'x'), null)
  assert.equal(callerOf([orch, agent], ''), null)
  assert.equal(callerOf([orch, agent], undefined), null)
  const config = join(dir, 'config')
  assert.equal(liveSessions(config, () => true), null, 'a registry that cannot be read is no « nobody lives »')
  mkdirSync(join(config, 'sessions'), { recursive: true })
  writeFileSync(join(config, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 's1', name: 'Orch: X [ab12cd]', cwd: '/w' }))
  writeFileSync(join(config, 'sessions', '6.json'), JSON.stringify({ name: 'Orch: no id', cwd: '/v' }))
  writeFileSync(join(config, 'sessions', '2.json'), JSON.stringify({ pid: 2, name: 'Agent: gone', cwd: '/r' }))
  writeFileSync(join(config, 'sessions', '3.json'), JSON.stringify({ pid: 3, peerToken: 'no name' }))
  writeFileSync(join(config, 'sessions', '4.json'), '{')
  writeFileSync(join(config, 'sessions', '5.key'), 'not a record')
  assert.deepEqual(liveSessions(config, pid => pid !== 2), [{ name: 'Orch: X', session: 's1', cwd: '/w', pid: 1 }, { name: 'Orch: no id', session: '', cwd: '/v', pid: 6 }])
})

test('create and pin open a line naming the maker; delete closes it into the archive, saying how it ended', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41', ORCHESTRATOR_REPORTS_TO: 'Orch: Elsewhere [aaa111]' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const c = await clone(w, src, 'c', 'feat/c')
  const made = lineOf(w, c)
  assert.deepEqual({ ...made, created: '' }, { v: 1, path: c, kind: 'clone', repo: join(dir, 'proj.git'), branch: 'main', orchestrator: 'Orch: Maker', agent: null, created: '' })
  assert.equal(made?.created, new Date(w.clock).toISOString())
  w.deps = { ...w.deps, env: { ...w.deps.env, CLAUDE_CODE_SESSION_ID: 's42' } }
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }, { pid: 42, name: 'Agent: reviewer', cwd: src }], new Set([41, 42]))
  assert.equal((await ws(w, 'pin', src, 'p', 'main')).code, 0)
  const p = join(dir, 'root', 'proj', 'p')
  const pinned = lineOf(w, p)
  assert.deepEqual([pinned?.kind, pinned?.branch, pinned?.orchestrator, pinned?.agent], ['pin', g(src, 'rev-parse', 'main'), 'Orch: Elsewhere', 'Agent: reviewer'])
  assert.equal((await ws(w, 'delete', c)).code, 0)
  assert.equal((await ws(w, 'delete', p, '--discard')).code, 0)
  assert.deepEqual(lines(w), [])
  assert.deepEqual(archived().map(a => [a['path'], a['end'], typeof a['closed']]), [[c, 'removed', 'string'], [p, 'discarded', 'string']])
})

test('delete --push puts the branches on the origin first, never a long-lived one, and refuses what cannot reach it', async () => {
  const src = pushed('proj')
  const w = world()
  const c = await clone(w, src, 'c', 'feat/c', 'unpushed')
  const tip = g(c, 'rev-parse', 'HEAD')
  assert.deepEqual(await bare(w, 'delete', c, '--push'), { code: 0, out: `pushed feat/c of ${c}\ndeleted ${c}\n`, err: '' })
  assert.equal(g(join(dir, 'proj.git'), 'rev-parse', 'refs/heads/feat/c'), tip, 'the branch is on the origin')
  assert.deepEqual(archived().map(a => a['end']), ['pushed and removed'])
  const m = (await ws(w, 'create', src, 'm', '--base', 'main')).out.trim()
  g(m, 'commit', '-q', '--allow-empty', '-m', 'On main')
  assert.deepEqual(await bare(w, 'delete', m, '--push'), { code: 1, out: '', err: `workspace: delete: commits on main, a long-lived branch the sweep never pushes (pass --discard to remove it anyway): ${m}\n` })
  const n = await clone(w, src, 'n', 'feat/n', 'unpushed')
  g(n, 'remote', 'set-url', 'origin', join(dir, 'missing.git'))
  const r = await bare(w, 'delete', n, '--push')
  assert.equal(r.code, 1)
  assert.match(r.err, /^workspace: delete: cannot push feat\/n: .+ \(pass --discard/)
  const o = await clone(w, src, 'o', 'feat/o', 'unpushed')
  g(o, 'remote', 'remove', 'origin')
  assert.equal((await bare(w, 'delete', o, '--push')).err, `workspace: delete: commits on no remote branch, and no origin to push them to (pass --discard to remove it anyway): ${o}\n`)
  // What holds the checkout anyway is read before anything is published.
  const d = await clone(w, src, 'd', 'feat/d', 'unpushed')
  writeFileSync(join(d, 'loose.txt'), 'uncommitted')
  assert.equal((await bare(w, 'delete', d, '--push')).err, `workspace: delete: the tree is dirty (pass --discard to remove it anyway): ${d}\n`)
  assert.throws(() => g(join(dir, 'proj.git'), 'rev-parse', '--verify', '-q', 'refs/heads/feat/d'), 'nothing pushed')
  assert.equal((await bare(w, 'delete', d, '--push', '--discard')).err, 'workspace: delete: --push and --discard do not go together\n')
  // A branch the origin took since the last fetch is not moved: the push is a creation.
  const t = await clone(w, src, 't', 'feat/t', 'unpushed')
  const other = join(dir, 'other')
  execFileSync('git', ['clone', '-q', join(dir, 'proj.git'), other])
  g(other, 'checkout', '-q', '-b', 'feat/t')
  g(other, 'commit', '-q', '--allow-empty', '-m', 'Someone else')
  g(other, 'push', '-q', 'origin', 'feat/t')
  const theirs = g(other, 'rev-parse', 'HEAD')
  const refused = await bare(w, 'delete', t, '--push')
  assert.equal(refused.code, 1)
  assert.match(refused.err, /^workspace: delete: cannot push feat\/t: /)
  assert.equal(g(join(dir, 'proj.git'), 'rev-parse', 'refs/heads/feat/t'), theirs)
  assert.ok(existsSync(m) && existsSync(n) && existsSync(o) && existsSync(d) && existsSync(t))
})

test('sweep: a checkout whose orchestrator and agent are gone is pushed and removed; what cannot be keeps its reason on its line', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const done = await clone(w, src, 'done', 'feat/done')
  const ahead = await clone(w, src, 'ahead', 'feat/ahead', 'unpushed')
  const dirty = await clone(w, src, 'dirty', 'feat/dirty', 'dirty')
  const local = await clone(w, src, 'local', 'feat/local', 'unpushed')
  g(local, 'remote', 'remove', 'origin')
  const moved = await clone(w, src, 'moved', 'feat/moved')
  g(moved, 'commit', '-q', '--allow-empty', '-m', 'Past the pushed head')
  const main_ = (await ws(w, 'create', src, 'on-main', '--base', 'main')).out.trim()
  g(main_, 'commit', '-q', '--allow-empty', '-m', 'On main')
  const pin = join(dir, 'root', 'proj', 'pin')
  assert.equal((await ws(w, 'pin', src, 'pin', 'main')).code, 0)
  // Within the first hour, the checkout is its maker's whoever lives: the pull requests decide.
  registry(w, [], new Set())
  w.cwds = lsofOf('/elsewhere')
  assert.match((await bare(w, 'sweep')).out, new RegExp(`^kept ${done}: pull requests unreadable`, 'm'))
  // Its orchestrator alive: still the pull requests.
  w.clock += 2 * HOUR
  registry(w, [{ pid: 51, name: 'Orch: Maker', cwd: src }], new Set([51]))
  assert.match((await bare(w, 'sweep')).out, new RegExp(`^kept ${done}: pull requests unreadable`, 'm'))
  // Gone: the dry run says what it would do, pushes nothing, writes nothing.
  registry(w, [], new Set())
  const before = readFileSync(ledgerPath(join(dir, 'root')), 'utf8')
  const dry = await bare(w, 'sweep', '--dry-run')
  const gone = '(no live orchestrator or agent)'
  assert.deepEqual(dry.out.split('\n').filter(l => l !== ''), [
    `would delete ${ahead}: no live orchestrator or agent, after pushing feat/ahead`,
    `kept ${dirty}: the tree is dirty ${gone}`,
    `would delete ${done}: no live orchestrator or agent`,
    `kept ${local}: commits on no remote branch, and no origin to push them to ${gone}`,
    `kept ${moved}: commits past origin/feat/moved, a branch the origin holds: only its agent moves it ${gone}`,
    `kept ${main_}: commits on main, a long-lived branch the sweep never pushes ${gone}`,
    `would delete ${pin}: no live orchestrator or agent`,
  ])
  assert.equal(readFileSync(ledgerPath(join(dir, 'root')), 'utf8'), before)
  assert.throws(() => g(join(dir, 'proj.git'), 'rev-parse', '--verify', '-q', 'refs/heads/feat/ahead'))
  // The sweep itself.
  const tip = g(ahead, 'rev-parse', 'HEAD')
  const r = await bare(w, 'sweep')
  assert.equal(r.code, 0, r.err)
  assert.ok(r.err.includes(`workspace: ledger: ${dirty} stays: the tree is dirty (orchestrator Orch: Maker, agent none)\n`), r.err)
  assert.deepEqual(r.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [
    `pushed feat/ahead of ${ahead}`,
    `deleted ${ahead}`,
    `kept ${dirty}: the tree is dirty ${gone}`,
    `deleted ${done}`,
    `kept ${local}: commits on no remote branch, and no origin to push them to ${gone}`,
    `kept ${moved}: commits past origin/feat/moved, a branch the origin holds: only its agent moves it ${gone}`,
    `kept ${main_}: commits on main, a long-lived branch the sweep never pushes ${gone}`,
    `deleted ${pin}`,
  ])
  assert.equal(g(join(dir, 'proj.git'), 'rev-parse', 'refs/heads/feat/ahead'), tip)
  assert.ok(!existsSync(ahead) && !existsSync(done) && !existsSync(pin) && existsSync(dirty) && existsSync(local) && existsSync(main_))
  assert.deepEqual(lines(w).map(e => [e.path, e.reason]), [
    [dirty, 'the tree is dirty'],
    [local, 'commits on no remote branch, and no origin to push them to'],
    [moved, 'commits past origin/feat/moved, a branch the origin holds: only its agent moves it'],
    [main_, 'commits on main, a long-lived branch the sweep never pushes'],
  ])
  assert.deepEqual(archived().map(a => [a['path'], a['end']]), [[ahead, 'pushed and removed'], [done, 'removed'], [pin, 'removed']])
  // A reason is dated when it is first seen, and kept as long as it holds.
  const at = lineOf(w, dirty)?.reason_at
  w.clock += HOUR
  assert.ok(!(await bare(w, 'sweep')).err.includes('ledger:'), 'said once, when first written')
  assert.equal(lineOf(w, dirty)?.reason_at, at)
  // A registry that cannot be read ends nothing.
  rmSync(join(dir, 'home', '.claude', 'sessions'), { recursive: true, force: true })
  const blind = await bare(w, 'sweep')
  assert.ok(blind.out.includes(`kept ${dirty}: the session registry cannot be read\n`), blind.out)
  // Its agent alive by name, wherever it started: no reason is owed.
  registry(w, [{ pid: 71, name: 'Agent: elsewhere', cwd: '/elsewhere' }], new Set([71]))
  changeEntryOf(dirty, e => ({ ...e, agent: 'Agent: elsewhere' }))
  await bare(w, 'sweep')
  assert.deepEqual([lineOf(w, dirty)?.reason, lineOf(w, dirty)?.reason_at], [undefined, undefined])
  changeEntryOf(dirty, e => ({ ...e, agent: null }))
  registry(w, [], new Set())
  await bare(w, 'sweep')
  assert.equal(lineOf(w, dirty)?.reason, 'the tree is dirty')
  // Its orchestrator back (a successor carries its name): no reason is owed any more.
  registry(w, [{ pid: 61, name: 'Orch: Maker', cwd: src }], new Set([61]))
  await bare(w, 'sweep')
  assert.deepEqual([lineOf(w, dirty)?.reason, lineOf(w, dirty)?.reason_at], [undefined, undefined])
})

test('sweep: an agent working in a checkout keeps it and is named on its line; a checkout with no line is adopted, a line with no checkout closed', async () => {
  const src = pushed('proj')
  const w = world()
  const a = await clone(w, src, 'a', 'feat/a')
  const b = await clone(w, src, 'b', 'feat/b')
  // b was made before the ledger: it has no line; a line names a checkout removed by hand.
  const root = join(dir, 'root')
  const kept = lines(w).filter(e => e.path !== b)
  const ghost: WorkspaceEntry = { v: 1, path: join(root, 'proj', 'ghost'), kind: 'clone', repo: '', branch: 'x', orchestrator: null, agent: null, created: new Date(0).toISOString() }
  writeFileSync(ledgerPath(root), ledgerText([...kept, ghost]))
  w.clock += 2 * HOUR
  w.cwds = lsofOf('/elsewhere')
  registry(w, [{ pid: 7, name: 'Agent: worker', cwd: join(a, 'sub') }], new Set([7]))
  // A dry run adopts nothing and closes nothing.
  const ledgerBefore = readFileSync(ledgerPath(root), 'utf8')
  const dry = await bare(w, 'sweep', '--dry-run')
  assert.ok(dry.out.includes(`would delete ${b}: no live orchestrator or agent`), dry.out)
  assert.equal(readFileSync(ledgerPath(root), 'utf8'), ledgerBefore)
  assert.deepEqual(archived(), [])
  const listed = await bare(w, 'ledger')
  assert.deepEqual(listed.out.split('\n').filter(l => l !== ''), [
    `${a} | ${join(dir, 'proj.git')} | main | orchestrator none | agent Agent: worker (live) | `,
    `${ghost.path} | - | x | orchestrator none | agent none | `,
    `${b} | no line: the next sweep adopts it`,
  ])
  const r = await bare(w, 'sweep')
  assert.equal(r.out.split('\n')[0], `kept ${a}: agent Agent: worker works in it`)
  assert.ok(existsSync(a))
  assert.equal(lineOf(w, a)?.agent, 'Agent: worker')
  // b is adopted, dated from its directory's birth: past its first hour on the clock, owned by no
  // one alive, clean and pushed, it goes.
  assert.ok(!existsSync(b))
  assert.deepEqual(archived().filter(x => x['path'] === b).map(x => [x['adopted'], x['orchestrator'], x['end']]), [[true, null, 'removed']])
  assert.deepEqual(archived().filter(x => x['path'] === ghost.path).map(x => x['end']), ['gone'])
  assert.ok(lineOf(w, ghost.path) === undefined)
  assert.equal((await bare(w, 'ledger', 'x')).err, 'workspace: ledger: usage: ledger\n')
})

test('sweep: an adoption never overwrites a line written since the ledger was read; a sibling sharing a prefix is no agent of it; a date that does not read keeps the grace', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const a = await clone(w, src, 'a', 'feat/a')
  const ab = await clone(w, src, 'ab', 'feat/ab')
  const root = join(dir, 'root')
  const made = lineOf(w, a)
  assert.equal(made?.orchestrator, 'Orch: Maker')
  // The sweep's reading of the ledger misses a's line (written after it), b's line is unreadable.
  writeFileSync(ledgerPath(root), ledgerText([{ ...(lineOf(w, ab) as WorkspaceEntry), created: 'not a date' }]))
  w.clock += 2 * HOUR
  w.cwds = lsofOf('/elsewhere')
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }, { pid: 8, name: 'Agent: next door', cwd: ab }], new Set([41, 8]))
  // a's line lands between the sweep's read and its adoption: the maker's line stands.
  const real = w.deps.run
  let once = false
  w.deps = { ...w.deps, run: async (argv, options) => {
    if (!once && argv.includes('symbolic-ref') && argv.includes(a)) {
      once = true
      writeFileSync(ledgerPath(root), ledgerText([...lines(w), made as WorkspaceEntry]))
    }
    return real(argv, options)
  } }
  const r = await bare(w, 'sweep')
  assert.equal(r.code, 0, r.err)
  assert.equal(lineOf(w, a)?.orchestrator, 'Orch: Maker', 'the adoption did not overwrite the maker')
  assert.ok(r.out.includes(`kept ${ab}: agent Agent: next door works in it`), r.out)
  assert.ok(!r.out.includes(`kept ${a}: agent`), 'ab is no subdirectory of a')
  assert.ok(existsSync(a) && existsSync(ab))
  // No agent in ab any more, its orchestrator gone: its date does not read, so the grace holds it.
  changeEntryOf(ab, e => ({ ...e, orchestrator: null }))
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const graced = await bare(w, 'sweep')
  assert.match(graced.out, new RegExp(`^kept ${ab}: pull requests unreadable`, 'm'))
  assert.ok(existsSync(ab))
  // The ledger names each owner live or gone, and the reason a checkout stays.
  changeEntryOf(a, e => ({ ...e, orchestrator: 'Orch: Gone', agent: 'Agent: past', reason: 'the tree is dirty' }))
  const listed = (await bare(w, 'ledger')).out.split('\n').find(l => l.startsWith(`${a} |`))
  assert.equal(listed, `${a} | ${join(dir, 'proj.git')} | main | orchestrator Orch: Gone (gone) | agent Agent: past (gone) | the tree is dirty`)
  changeEntryOf(a, e => ({ ...e, orchestrator: 'Orch: Maker' }))
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  assert.ok((await bare(w, 'ledger')).out.includes(`${a} | ${join(dir, 'proj.git')} | main | orchestrator Orch: Maker (live) | agent Agent: past (gone) |`))
})

test('keep: a checkout closed with --keep-checkout is never ended by the sweep once its orchestrator and agent are gone; only a delete ends it; every deletion names its maker', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const kept = await clone(w, src, 'kept', 'feat/kept')
  const lost = await clone(w, src, 'lost', 'feat/lost')
  // The mark is on the ledger line, dated; marking again changes nothing.
  const marked = await bare(w, 'keep', kept)
  assert.deepEqual([marked.code, marked.out], [0, `kept ${kept}\n`], marked.err)
  const at = lineOf(w, kept)?.kept
  assert.equal(at, new Date(w.clock).toISOString())
  w.clock += 1000
  await bare(w, 'keep', kept)
  assert.equal(lineOf(w, kept)?.kept, at)
  assert.equal(lineOf(w, lost)?.kept, undefined)
  // A checkout with no line is adopted, and marked.
  rmSync(ledgerPath(join(dir, 'root')))
  assert.equal((await bare(w, 'keep', kept)).code, 0)
  assert.equal(lineOf(w, kept)?.adopted, true)
  assert.ok(lineOf(w, kept)?.kept !== undefined)
  // Its maker is dead, its agent gone, its hour long past: the sweep ends what is not kept (the clone of
  // a dead predecessor that a sweep ended minutes after a `close --keep-checkout`) and leaves what is.
  registry(w, [], new Set())
  w.cwds = lsofOf('/elsewhere')
  w.clock += 3 * HOUR
  const swept = await bare(w, 'sweep')
  assert.equal(swept.code, 0, swept.err)
  assert.match(swept.out, new RegExp(`^kept ${kept}: kept since \\S+ by close --keep-checkout: only delete ends it$`, 'm'))
  assert.ok(existsSync(kept), 'a kept checkout stays')
  assert.ok(swept.out.includes(`deleted ${lost}`), swept.out)
  assert.ok(!existsSync(lost))
  assert.equal(lineOf(w, kept)?.reason, undefined, 'a kept checkout is owed no reason')
  // While its orchestrator lives the mark does not hold the checkout past its pull request: the hooks module
  // closes every finished agent with `--keep-checkout`, and the sweep still takes those once the pull request is over.
  const owned = await clone(w, src, 'owned', 'feat/owned')
  await bare(w, 'keep', owned)
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const alive = await bare(w, 'sweep', '--dry-run')
  assert.ok(!alive.out.includes(`kept ${owned}: kept since`), alive.out)
  registry(w, [], new Set())
  assert.equal((await bare(w, 'delete', owned)).code, 0)
  // A dry run says the same.
  assert.match((await bare(w, 'sweep', '--dry-run')).out, new RegExp(`^kept ${kept}: kept since`, 'm'))
  // Every deletion names what made it: the sweep, the close, a hand.
  const hand = await clone(w, src, 'hand', 'feat/hand')
  const closed = await clone(w, src, 'closed', 'feat/closed')
  assert.equal((await bare(w, 'delete', hand, '--by', 'close')).code, 0)
  assert.equal((await bare(w, 'delete', closed)).code, 0)
  assert.equal((await bare(w, 'delete', kept)).code, 0, 'a delete by hand ends a kept checkout')
  assert.deepEqual(archived().map(a => [a['path'], a['by']]), [[lost, 'sweep'], [owned, 'delete'], [hand, 'close'], [closed, 'delete'], [kept, 'delete']])
  // Refused: no such checkout, a path outside the root, no path, a maker the archive has no word for.
  assert.match((await bare(w, 'keep', join(dir, 'nowhere'))).err, /keep: no such checkout/)
  assert.match((await bare(w, 'keep', dir)).err, /keep: refusing a path outside/)
  assert.match((await bare(w, 'keep')).err, /keep: usage/)
  assert.match((await bare(w, 'delete', closed, '--by', 'me')).err, /--by names close, sweep or delete/)
  assert.equal(parseEntry(JSON.stringify({ v: 1, path: '/r/p/a', kind: 'clone', repo: '', branch: '', orchestrator: null, agent: null, created: '', kept: 3 })), null)
})

test('a clone with a pin open on it is kept by delete and by the sweep, whoever owns it; the pin is ended, then the clone at the next sweep', async () => {
  // The clone's directory sorts before its pin's: the sweep meets the clone first.
  const src = pushed('aproj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const root = join(dir, 'root')
  const c = await clone(w, src, 'c', 'feat/c')
  assert.equal((await bare(w, 'pin', c, 'p', 'feat/c')).code, 0)
  const p = join(root, 'c', 'p')
  assert.equal((await bare(w, 'delete', c)).err, `workspace: delete: a pin is open on it: ${p} (pass --discard to remove it anyway): ${c}\n`)
  assert.ok(existsSync(c) && existsSync(p))
  // Its owners gone, an agent still working in the pin: the pin stays, so does the clone, and the clone says why.
  w.clock += 2 * HOUR
  w.cwds = lsofOf('/elsewhere')
  registry(w, [{ pid: 51, name: 'Agent: reader', cwd: p }], new Set([51]))
  const held = await bare(w, 'sweep')
  assert.deepEqual(held.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [
    `kept ${c}: a pin is open on it: ${p} (no live orchestrator or agent)`,
    `kept ${p}: agent Agent: reader works in it`,
  ])
  assert.equal(lineOf(w, c)?.reason, `a pin is open on it: ${p}`)
  assert.ok(existsSync(c) && existsSync(p))
  // The reader gone: the pin goes, the clone it held follows at the next sweep.
  registry(w, [], new Set())
  const pinGone = await bare(w, 'sweep')
  assert.deepEqual(pinGone.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [
    `kept ${c}: a pin is open on it: ${p} (no live orchestrator or agent)`,
    `deleted ${p}`,
  ])
  const done = await bare(w, 'sweep')
  assert.deepEqual(done.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [`deleted ${c}`])
  assert.deepEqual(archived().map(a => [a['path'], a['end'], a['by']]), [[p, 'removed', 'sweep'], [c, 'removed', 'sweep']])
  assert.deepEqual(readdirSync(root).filter(n => !n.startsWith('.')), [], 'neither parent directory is left')
})

test('a pin whose clone is gone is ended whoever owns it: directory removed, line closed; what works in it keeps it', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const root = join(dir, 'root')
  const c = await clone(w, src, 'c', 'feat/c')
  const [p, q, r, h] = ['p', 'q', 'r', 'h'].map(n => join(root, 'c', n)) as [string, string, string, string]
  for (const n of ['p', 'q', 'r', 'h']) assert.equal((await bare(w, 'pin', c, n, 'feat/c')).code, 0)
  // What the sweep once did to a clone with pins open on it (and what a hand does still with --discard).
  assert.equal((await bare(w, 'delete', c, '--discard')).code, 0)
  assert.ok(lineOf(w, p) !== undefined)
  // The orchestrator lives: the clone the pins hang from is gone all the same.
  w.clock += 2 * HOUR
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }, { pid: 52, name: 'Agent: reader', cwd: q }], new Set([41, 52]))
  w.cwds = lsofOf(r)
  const files = (): string => readdirSync(join(root, 'c')).sort().join()
  const dry = await bare(w, 'sweep', '--dry-run')
  assert.deepEqual(dry.out.split('\n').filter(l => l !== '' && !l.startsWith('would delete ' + join(dir, 'host')) && !l.endsWith(': empty')), [
    `would delete ${h}: its clone is gone`,
    `would delete ${p}: its clone is gone`,
    `kept ${q}: agent Agent: reader works in it`,
    `kept ${r}: a live process has its working directory inside`,
  ])
  assert.equal(files(), 'h,p,q,r')
  const swept = await bare(w, 'sweep')
  assert.equal(swept.code, 0, swept.err)
  assert.deepEqual(swept.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [
    `deleted ${h}`,
    `deleted ${p}`,
    `kept ${q}: agent Agent: reader works in it`,
    `kept ${r}: a live process has its working directory inside`,
  ])
  assert.equal(files(), 'q,r')
  assert.deepEqual(archived().map(a => [a['path'], a['end'], a['by']]), [[c, 'discarded', 'delete'], [h, 'removed', 'sweep'], [p, 'removed', 'sweep']])
  assert.deepEqual(lines(w).map(e => e.path), [q, r])
  // Nothing works in them any more: the sweep ends both, and the parent goes with the last.
  registry(w, [], new Set())
  w.cwds = lsofOf('/elsewhere')
  const rest = await bare(w, 'sweep')
  assert.deepEqual(rest.out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`)), [`deleted ${q}`, `deleted ${r}`])
  assert.deepEqual(readdirSync(root).filter(n => !n.startsWith('.')), [])
  assert.deepEqual(archived().map(a => [a['end'], a['by']]), [['discarded', 'delete'], ['removed', 'sweep'], ['removed', 'sweep'], ['removed', 'sweep'], ['removed', 'sweep']])
})

test('a pin is taken as orphan only once its clone is shown removed by workspace.sh, past its first hour and with no live agent; a link out of the root is never taken', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const root = join(dir, 'root')
  // A clone moved, not removed: its pin reads as orphan to git, and nothing shows the clone gone.
  const moved = await clone(w, src, 'moved', 'feat/moved')
  assert.equal((await bare(w, 'pin', moved, 'a', 'feat/moved')).code, 0)
  renameSync(moved, `${moved}-away`)
  // A clone removed by workspace.sh, its pin young, then with a live agent by name.
  const gone = await clone(w, src, 'gone', 'feat/gone')
  assert.equal((await bare(w, 'pin', gone, 'b', 'feat/gone')).code, 0)
  assert.equal((await bare(w, 'delete', gone, '--discard')).code, 0)
  // A pin naming a clone no ledger line ever held.
  assert.equal((await bare(w, 'pin', src, 'c', 'main')).code, 0)
  const unknown = join(root, 'proj', 'c')
  writeFileSync(join(unknown, '.git'), `gitdir: ${join(dir, 'unmounted', 'clone', '.git', 'worktrees', 'c')}\n`)
  const a = join(root, 'moved', 'a')
  const b = join(root, 'gone', 'b')
  w.cwds = lsofOf('/elsewhere')
  // Within its first hour a pin is left alone, whatever it is.
  const first = await bare(w, 'sweep')
  assert.ok(first.out.includes(`kept ${b}: its clone is gone, kept within its first hour\n`), first.out)
  w.clock += 2 * HOUR
  changeEntryOf(b, e => ({ ...e, agent: 'Agent: elsewhere' }))
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }, { pid: 71, name: 'Agent: elsewhere', cwd: '/elsewhere' }], new Set([41, 71]))
  const held = (await bare(w, 'sweep')).out.split('\n')
  assert.ok(held.includes(`kept ${b}: its clone is gone, kept while its agent Agent: elsewhere lives`), held.join('\n'))
  assert.ok(held.some(l => l.startsWith(`kept ${a}: its source worktree entry is gone, but its clone ${moved} was not removed by workspace.sh`)), held.join('\n'))
  assert.ok(held.some(l => l.startsWith(`kept ${unknown}: its source worktree entry is gone, but its clone ${join(dir, 'unmounted', 'clone')} was not removed by workspace.sh`)), held.join('\n'))
  assert.ok(existsSync(a) && existsSync(b) && existsSync(unknown))
  // Its agent gone, the proven one goes; the others stay, and stay said.
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const done = (await bare(w, 'sweep')).out.split('\n')
  assert.ok(done.includes(`deleted ${b}`), done.join('\n'))
  assert.ok(existsSync(a) && existsSync(unknown))
  // A clone workspace.sh ended (the archive says discarded), its path taken again before the sweep: what is there now is no proof of anything.
  const reborn = await clone(w, src, 'reborn', 'feat/reborn')
  assert.equal((await bare(w, 'pin', reborn, 'd', 'feat/reborn')).code, 0)
  assert.equal((await bare(w, 'delete', reborn, '--discard')).code, 0)
  mkdirSync(reborn)
  const d = join(root, 'reborn', 'd')
  const again = (await bare(w, 'sweep')).out.split('\n')
  assert.ok(again.some(l => l.startsWith(`kept ${d}: its source worktree entry is gone, but its clone ${reborn} is still there or out of reach`)), again.join('\n'))
  assert.ok(existsSync(d))
  // A link to a directory outside the root, its `.git` naming a clone that workspace.sh removed: never taken, the target untouched.
  const outside = join(dir, 'outside')
  const lost = join(dir, 'lost-clone')
  mkdirSync(outside)
  writeFileSync(join(outside, '.git'), `gitdir: ${join(lost, '.git', 'worktrees', 'x')}\n`)
  writeFileSync(join(outside, 'precious.txt'), 'mine')
  appendFileSync(archivePath(root), `${JSON.stringify({ v: 1, path: lost, kind: 'clone', repo: '', branch: '', orchestrator: null, agent: null, created: '', closed: '', end: 'removed', by: 'sweep' })}\n`)
  symlinkSync(outside, join(root, 'proj', 'link'))
  const linked = await bare(w, 'sweep')
  assert.match(linked.out, new RegExp(`^kept ${outside}: its clone is gone, but it is a link or lies outside the root: left alone$`, 'm'))
  assert.ok(existsSync(join(outside, 'precious.txt')) && existsSync(join(root, 'proj', 'link')))
  assert.ok(!existsSync(join(root, '.trash')) || readdirSync(join(root, '.trash')).length === 0)
})

test('delete, close and sweep remove the parent directories they leave empty, never the root nor a directory that holds anything', async () => {
  const src = pushed('proj')
  const w = world()
  const root = join(dir, 'root')
  const names = (): string[] => readdirSync(root).filter(n => !n.startsWith('.')).sort()
  const a = await clone(w, src, 'a', 'feat/a')
  const b = await clone(w, src, 'b', 'feat/b')
  assert.equal((await bare(w, 'delete', a)).code, 0)
  assert.deepEqual(names(), ['proj'], 'a sibling is still there')
  assert.equal((await bare(w, 'delete', b, '--by', 'close')).code, 0)
  assert.deepEqual(names(), [], 'the last one takes its parent with it')
  assert.ok(existsSync(root) && existsSync(ledgerPath(root)), 'never the root')
  // A parent holding anything else stays: a loose file, a directory that is no checkout.
  const c = await clone(w, src, 'c', 'feat/c')
  writeFileSync(join(root, 'proj', 'notes.txt'), 'mine')
  assert.equal((await bare(w, 'delete', c)).code, 0)
  assert.deepEqual(readdirSync(join(root, 'proj')), ['notes.txt'])
  rmSync(join(root, 'proj'), { recursive: true })
  // The sweep takes the empty directories already there, and only those.
  mkdirSync(join(root, 'empty'))
  mkdirSync(join(root, 'finder'))
  writeFileSync(join(root, 'finder', '.DS_Store'), '')
  mkdirSync(join(root, 'full'))
  writeFileSync(join(root, 'full', 'x'), '')
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(dir, 'elsewhere'))
  symlinkSync(join(dir, 'elsewhere'), join(root, 'link'))
  // Within the hour an empty directory may be a `create` under way.
  assert.deepEqual((await bare(w, 'sweep')).out, '')
  w.clock += 2 * HOUR
  const dry = await bare(w, 'sweep', '--dry-run')
  assert.deepEqual(dry.out.split('\n').filter(l => l !== ''), [`would delete ${join(root, 'empty')}: empty`, `would delete ${join(root, 'finder')}: empty`])
  assert.deepEqual(names(), ['empty', 'finder', 'full', 'link'])
  const swept = await bare(w, 'sweep')
  assert.deepEqual(swept.out.split('\n').filter(l => l !== ''), [`deleted ${join(root, 'empty')}`, `deleted ${join(root, 'finder')}`])
  assert.deepEqual(names(), ['full', 'link'])
  assert.ok(existsSync(join(root, '.hidden')) && existsSync(join(dir, 'elsewhere')))
  // A checkout the sweep ends takes its parent too.
  const d = await clone(w, src, 'd', 'feat/d')
  w.clock += 2 * HOUR
  w.cwds = lsofOf('/elsewhere')
  registry(w, [], new Set())
  assert.match((await bare(w, 'sweep')).out, new RegExp(`^deleted ${d}$`, 'm'))
  assert.deepEqual(names(), ['full', 'link'])
  // A directory the sweep cannot remove is said on its line, not passed over.
  mkdirSync(join(root, 'stuck'))
  w.clock += 2 * HOUR
  chmodSync(root, 0o555)
  const stuck = await bare(w, 'sweep')
  chmodSync(root, 0o755)
  assert.ok(stuck.out.split('\n').includes(`kept ${join(root, 'stuck')}: empty, and it could not be removed`), stuck.out)
})

test('a checkout kept for lack of an owner is said again each day, with the date it began to stay; never more often', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const dirty = await clone(w, src, 'dirty', 'feat/dirty', 'dirty')
  registry(w, [], new Set())
  w.cwds = lsofOf('/elsewhere')
  w.clock += 2 * HOUR
  const first = await bare(w, 'sweep')
  const at = lineOf(w, dirty)?.reason_at
  assert.ok(first.err.includes(`workspace: ledger: ${dirty} stays: the tree is dirty (orchestrator Orch: Maker, agent none)\n`), first.err)
  w.clock += HOUR
  assert.ok(!(await bare(w, 'sweep')).err.includes('ledger:'), 'said once a day')
  w.clock += 24 * HOUR
  const again = await bare(w, 'sweep')
  assert.ok(again.err.includes(`workspace: ledger: ${dirty} still stays since ${at}: the tree is dirty (orchestrator Orch: Maker, agent none)\n`), again.err)
  assert.equal(lineOf(w, dirty)?.reason_at, at)
  assert.ok(!(await bare(w, 'sweep')).err.includes('ledger:'))
  // A dry run says nothing and writes nothing; a date that does not read is said and mended.
  w.clock += 24 * HOUR
  const before = readFileSync(ledgerPath(join(dir, 'root')), 'utf8')
  assert.ok(!(await bare(w, 'sweep', '--dry-run')).err.includes('ledger:'))
  assert.equal(readFileSync(ledgerPath(join(dir, 'root')), 'utf8'), before)
  changeEntryOf(dirty, e => ({ ...e, said: 'not a date' }))
  assert.ok((await bare(w, 'sweep')).err.includes('still stays since'))
  assert.equal(parseEntry(JSON.stringify({ v: 1, path: '/r/p/a', kind: 'clone', repo: '', branch: '', orchestrator: null, agent: null, created: '', said: 3 })), null)
  // A line from before `said` stands on its reason_at: two days old, it is said at once, then every 24 h to the millisecond.
  changeEntryOf(dirty, ({ said: _s, ...e }) => ({ ...e, reason_at: new Date(w.clock - 48 * HOUR).toISOString() }))
  assert.ok((await bare(w, 'sweep')).err.includes(`still stays since ${new Date(w.clock - 48 * HOUR).toISOString()}`))
  assert.equal(lineOf(w, dirty)?.said, new Date(w.clock).toISOString())
  w.clock += 24 * HOUR - 1
  assert.ok(!(await bare(w, 'sweep')).err.includes('ledger:'), 'not before 24 h')
  w.clock += 1
  assert.ok((await bare(w, 'sweep')).err.includes('still stays since'), 'at 24 h')
  // Its reason_at alone, no said: young at 23 h 59 min, due at 24 h.
  changeEntryOf(dirty, ({ said: _s, ...e }) => ({ ...e, reason_at: new Date(w.clock - 24 * HOUR + 1).toISOString() }))
  assert.ok(!(await bare(w, 'sweep')).err.includes('ledger:'))
  w.clock += 1
  assert.ok((await bare(w, 'sweep')).err.includes('still stays since'))
  // A checkout that turns owned again is owed no reason, and no date it was said.
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  await bare(w, 'sweep')
  assert.deepEqual([lineOf(w, dirty)?.reason, lineOf(w, dirty)?.reason_at, lineOf(w, dirty)?.said], [undefined, undefined, undefined])
})

// --- the resume window: a closed agent's checkout ends once it can no longer be resumed -----------

const MINUTE = 60 * 1000

/** A transcript of a session that ran in `checkout`, its last turn at `at`, in a projects folder of the host. */
function spoke(checkout: string, at: number, projects = join(dir, 'home', '.claude', 'projects'), session = 's-agent'): void {
  const folder = join(projects, encode(checkout))
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${session}.jsonl`)
  writeFileSync(file, '{}\n')
  utimesSync(file, new Date(at), new Date(at))
}

/** What a sweep says of the checkouts, its host directories and empty parents aside. */
const said = (out: string): string[] => out.split('\n').filter(l => l !== '' && !l.startsWith(`deleted ${join(dir, 'host')}`))

/** An orchestrator that stays alive, three hours after its checkouts were made. */
async function longLived(names: readonly (readonly [string, 'pushed' | 'unpushed' | 'dirty'])[], env: Record<string, string> = {}): Promise<{ w: World; src: string; made: string[] }> {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41', ...env })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const made: string[] = []
  for (const [name, how] of names) made.push(await clone(w, src, name, `feat/${name}`, how))
  w.clock += 3 * HOUR
  w.cwds = lsofOf('/elsewhere')
  return { w, src, made }
}

test('sweep: while its orchestrator lives, a checkout whose agent spoke last over an hour ago is pushed and removed; within the hour it stays for `spawn --resume`', async () => {
  const { w, made } = await longLived([['ahead', 'unpushed'], ['done', 'pushed'], ['fresh', 'pushed']])
  const [ahead, done, fresh] = made as [string, string, string]
  spoke(ahead, w.clock - 61 * MINUTE)
  spoke(done, w.clock - HOUR)
  spoke(fresh, w.clock - HOUR + 1000)
  const window = `kept ${fresh}: resume window: its agent spoke last 59 min ago, \`spawn --resume\` takes it until 60 min`
  const dry = await bare(w, 'sweep', '--dry-run')
  assert.deepEqual(said(dry.out), [
    `would delete ${ahead}: its agent gone past the resume window, after pushing feat/ahead`,
    `would delete ${done}: its agent gone past the resume window`,
    window,
  ], dry.err)
  assert.ok(existsSync(ahead) && existsSync(done))
  const tip = g(ahead, 'rev-parse', 'HEAD')
  const swept = await bare(w, 'sweep')
  assert.equal(swept.code, 0, swept.err)
  assert.deepEqual(said(swept.out), [`pushed feat/ahead of ${ahead}`, `deleted ${ahead}`, `deleted ${done}`, window])
  assert.equal(g(join(dir, 'proj.git'), 'rev-parse', 'refs/heads/feat/ahead'), tip)
  assert.ok(!existsSync(ahead) && !existsSync(done) && existsSync(fresh))
  assert.deepEqual(archived().map(a => [a['path'], a['end'], a['by']]), [[ahead, 'pushed and removed', 'sweep'], [done, 'removed', 'sweep']])
})

test('sweep: past the resume window every safety rule still holds, and the kept checkout says why', async () => {
  const { w, made } = await longLived([['dirty', 'dirty'], ['held', 'pushed'], ['local', 'unpushed'], ['moved', 'pushed'], ['stashed', 'pushed']])
  const [dirty, held, local, moved, stashed] = made as [string, string, string, string, string]
  g(local, 'remote', 'remove', 'origin')
  g(moved, 'commit', '-q', '--allow-empty', '-m', 'Past the pushed head')
  writeFileSync(join(stashed, 'README.md'), 'aside\n')
  g(stashed, 'stash', '-q')
  for (const c of made) spoke(c, w.clock - 2 * HOUR)
  w.cwds = lsofOf(join(held, 'sub'))
  const why = '(its agent gone past the resume window)'
  const swept = await bare(w, 'sweep')
  assert.deepEqual(said(swept.out), [
    `kept ${dirty}: the tree is dirty ${why}`,
    `kept ${held}: a live process has its working directory inside ${why}`,
    `kept ${local}: commits on no remote branch, and no origin to push them to ${why}`,
    `kept ${moved}: commits past origin/feat/moved, a branch the origin holds: only its agent moves it ${why}`,
    `kept ${stashed}: a stash is held ${why}`,
  ], swept.err)
  assert.ok(made.every(c => existsSync(c)))
  assert.equal(lineOf(w, dirty)?.reason, 'the tree is dirty')
  assert.ok(swept.err.includes(`workspace: ledger: ${dirty} stays: the tree is dirty (orchestrator Orch: Maker, agent none)\n`), swept.err)
  // A registry that cannot be read ends nothing.
  rmSync(join(dir, 'home', '.claude', 'sessions'), { recursive: true, force: true })
  assert.ok((await bare(w, 'sweep')).out.includes(`kept ${dirty}: the session registry cannot be read\n`))
})

test('sweep: a live agent keeps its checkout whatever its last turn; one no session ever ran in, and one marked kept, stay while their orchestrator lives', async () => {
  const { w, src, made } = await longLived([['here', 'pushed'], ['marked', 'pushed'], ['named', 'pushed'], ['never', 'pushed'], ['reused', 'pushed']])
  const [here, marked, named, never, reused] = made as [string, string, string, string, string]
  for (const c of [here, marked, named]) spoke(c, w.clock - 2 * HOUR)
  // A transcript older than the checkout is of an earlier one at the same path: no session ran in this one.
  spoke(reused, w.clock - 4 * HOUR)
  assert.equal((await bare(w, 'keep', marked)).code, 0)
  changeEntryOf(named, e => ({ ...e, agent: 'Agent: named' }))
  registry(w, [
    { pid: 41, name: 'Orch: Maker', cwd: src }, { pid: 7, name: 'Agent: here', cwd: here },
    { pid: 8, name: 'Agent: named', cwd: '/elsewhere' },
  ], new Set([41, 7, 8]))
  const swept = await bare(w, 'sweep')
  const lines_ = said(swept.out)
  assert.equal(lines_[0], `kept ${here}: agent Agent: here works in it`)
  for (const [k, c] of [marked, named, never, reused].entries()) assert.match(lines_[k + 1] ?? '', new RegExp(`^kept ${c}: pull requests unreadable`))
  assert.ok(made.every(c => existsSync(c)))
  // Their orchestrator gone too, the marked one is still the mark's to keep.
  registry(w, [], new Set())
  const gone = await bare(w, 'sweep')
  assert.match(gone.out, new RegExp(`^kept ${marked}: kept since \\S+ by close --keep-checkout: only delete ends it$`, 'm'))
  assert.ok(existsSync(marked) && !existsSync(here) && !existsSync(never) && !existsSync(reused))
})

test('sweep: the resume window holds a checkout whoever else is gone, its pull request over or within its first hour', async () => {
  const src = pushed('proj')
  const w = world({ CLAUDE_CODE_SESSION_ID: 's41' })
  registry(w, [{ pid: 41, name: 'Orch: Maker', cwd: src }], new Set([41]))
  const c = await clone(w, src, 'c', 'feat/c')
  w.cwds = lsofOf('/elsewhere')
  w.prs[join(dir, 'proj.git')] = ok(JSON.stringify([{ number: 1, headRefName: 'feat/c', headRefOid: g(c, 'rev-parse', 'HEAD'), state: 'MERGED' }]))
  w.clock += 10 * MINUTE
  spoke(c, w.clock)
  const young = await ws(w, 'sweep')
  assert.deepEqual(said(young.out), [`kept ${c}: resume window: its agent spoke last 0 min ago, \`spawn --resume\` takes it until 60 min`], young.err)
  registry(w, [], new Set())
  w.clock += 59 * MINUTE
  assert.match((await ws(w, 'sweep')).out, new RegExp(`^kept ${c}: resume window: its agent spoke last 59 min ago`, 'm'))
  w.clock += MINUTE
  assert.deepEqual(said((await ws(w, 'sweep', '--dry-run')).out), [`would delete ${c}: no live orchestrator or agent`])
})

test('sweep: the last turn is the newest the host keeps on either plan, read as the launcher reads it; the window follows ORCHESTRATOR_RESUME_WITHIN', async () => {
  const { w, made } = await longLived([['a', 'pushed']])
  const a = made[0] as string
  const dry = async (): Promise<string> => said((await bare(w, 'sweep', '--dry-run')).out)[0] ?? ''
  const gone = `would delete ${a}: its agent gone past the resume window`
  spoke(a, w.clock - 2 * HOUR)
  assert.equal(await dry(), gone)
  // A resume on the second plan, or under the caller's own configuration directory, spoke since.
  const bis = join(dir, 'home', '.claude-bis', 'projects') // the second plan's CLAUDE_CONFIG_DIR
  spoke(a, w.clock - 5 * MINUTE, bis, 's-bis')
  assert.match(await dry(), new RegExp(`^kept ${a}: resume window: its agent spoke last 5 min ago`))
  rmSync(bis, { recursive: true })
  w.deps = { ...w.deps, env: { ...w.deps.env, CLAUDE_CONFIG_DIR: join(dir, 'config') } }
  registry(w, [], new Set())
  mkdirSync(join(dir, 'config', 'sessions'), { recursive: true })
  spoke(a, w.clock - 7 * MINUTE, join(dir, 'config', 'projects'), 's-config')
  assert.match(await dry(), /resume window: its agent spoke last 7 min ago/)
  // The override of the projects folder is the only one read, and the window's is the launcher's.
  const only = join(dir, 'only')
  spoke(a, w.clock - 20 * MINUTE, only)
  w.deps = { ...w.deps, env: { ...w.deps.env, ORCHESTRATOR_PROJECTS_DIR: only, ORCHESTRATOR_RESUME_WITHIN: '600' } }
  assert.equal(await dry(), `would delete ${a}: no live orchestrator or agent`)
  w.deps = { ...w.deps, env: { ...w.deps.env, ORCHESTRATOR_RESUME_WITHIN: '1800' } }
  assert.match(await dry(), /resume window: its agent spoke last 20 min ago, `spawn --resume` takes it until 30 min$/)
  w.deps = { ...w.deps, env: { ...w.deps.env, ORCHESTRATOR_RESUME_WITHIN: 'an hour' } }
  assert.match(await dry(), /takes it until 60 min$/)
})

test('past the hour, a correction\'s checkout is made again from the pushed branch, and the resume brief prints from it', async () => {
  const { w, src, made } = await longLived([['fix', 'unpushed']])
  const old = made[0] as string
  const tip = g(old, 'rev-parse', 'HEAD')
  spoke(old, w.clock - 2 * HOUR)
  assert.equal((await bare(w, 'sweep')).code, 0)
  assert.ok(!existsSync(old))
  const again = await bare(w, 'create', src, 'fix', '--base', 'feat/fix')
  assert.deepEqual([again.code, again.out], [0, `${old}\n`], again.err)
  assert.deepEqual([g(old, 'rev-parse', '--abbrev-ref', 'HEAD'), g(old, 'rev-parse', 'HEAD')], ['feat/fix', tip])
  // The resume brief reads the new checkout, and its line spawns the replacement there.
  const record = join(dir, 'dispatch-record.jsonl')
  writeFileSync(record, `${JSON.stringify({ id: 1, label: 'FIX', state: 'open', tier: 'standard' })}\n`)
  const phaseBrief = join(dir, 'phase.md')
  writeFileSync(phaseBrief, '# phase\n')
  const out: string[] = []
  const code = brief(['rotation', '--record', record, '--row', '1', '--phase-brief', phaseBrief, '--worktree', old, '--orchestrator', 'Orch: Maker [a1b2c3]',
    '--tty', 'none', '--title', 'Agent: fix', '--out', join(dir, 'fix-r1.md')],
  { out: t => out.push(t), err: t => out.push(t) }, { env: w.deps.env, now: () => new Date(w.clock), git: (at, args) => g(at, ...args) })
  assert.equal(code, 0, out.join(''))
  assert.match(out.join(''), /^spawn: \S+iterm-agent\.sh spawn --dir /m)
  assert.ok(readFileSync(join(dir, 'fix-r1.md'), 'utf8').includes(tip.slice(0, 12)))
  // The earlier agent's transcript is older than this checkout: it waits for its agent.
  w.clock += 2 * HOUR
  assert.match((await bare(w, 'sweep')).out, new RegExp(`^kept ${old}: pull requests unreadable`, 'm'))
  assert.ok(existsSync(old))
})
