import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run, type Ran, type Run, type RunOptions } from './lib/process.ts'
import type { FilePr } from '../../../hooks/pr-file-format.ts'
import {
  ancestors, branchFacts, copyable, copyFiles, copyList, encode, leavesRepository, main, manifestPath, neverCopied, parseCwds,
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
    assert.equal((await ws(w, 'pin', src, 'round-9', 'nope')).err, 'workspace: pin: the source does not know nope\n')
    assert.equal((await ws(w, 'pin', src, 'round-1', 'main')).err, `workspace: pin: already exists, delete it first: ${p}\n`)
    assert.equal((await ws(w, 'pin', src, 'bad/name', 'main')).code, 1)
    const d = await ws(w, 'delete', p)
    assert.deepEqual([d.code, d.out], [0, `deleted ${p}\n`], d.err)
    assert.ok(!g(src, 'worktree', 'list').includes('round-1'))
  } finally {
    delete process.env['XDG_CONFIG_HOME']
  }
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
