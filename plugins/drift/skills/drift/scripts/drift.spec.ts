import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLAYWRIGHT_VERSION } from '../../../core/index.ts'
import { main, type Deps } from './drift.ts'

const FIXTURE = fileURLToPath(new URL('../../../tests/fixture', import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'drift-spec-'))
const REPO = join(ROOT, 'repo')
const HOME = join(ROOT, 'home')
const CONFIG = join(ROOT, 'config.json')
const sha: Record<string, string> = {}

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], { encoding: 'utf8' }).trim()

function commit(name: string, change: () => void): void {
  change()
  git('add', '-A')
  git('commit', '-q', '-m', name)
  sha[name] = git('rev-parse', 'HEAD')
}

before(() => {
  cpSync(FIXTURE, REPO, { recursive: true })
  git('init', '-q', '-b', 'main')
  commit('base', () => undefined)
  commit('module', () => writeFileSync(join(REPO, 'src/b.js'), 'export const b = () => 3\n'))
  git('checkout', '-q', sha['base'] ?? '')
  commit('salt', () => writeFileSync(join(REPO, 'salt.txt'), '1\n'))
  git('checkout', '-q', sha['base'] ?? '')
  commit('files', () => {
    rmSync(join(REPO, 'public/old.txt'))
    writeFileSync(join(REPO, 'public/new.txt'), 'brand new\n')
  })
  git('checkout', '-q', sha['base'] ?? '')
  commit('broken', () => writeFileSync(join(REPO, 'FAIL'), ''))
  for (const [name, file, text] of [['link-a', 'LINK', 'old.txt'], ['link-b', 'LINK', 'index.html'], ['fifo', 'FIFO', ''], ['no-install', 'FAIL_INSTALL', ''], ['stamped', 'STAMP', '']] as const) {
    git('checkout', '-q', sha['base'] ?? '')
    commit(name, () => writeFileSync(join(REPO, file), text))
  }
  commit('stamped-ci', () => writeFileSync(join(REPO, 'ci.yml'), 'on: push\n'))
  git('checkout', '-q', sha['base'] ?? '')
  commit('dotted', () => writeFileSync(join(REPO, 'DOTTED'), ''))
  commit('dotted-salt', () => writeFileSync(join(REPO, 'salt.txt'), '1\n'))
  git('checkout', '-q', 'main')
  git('remote', 'add', 'origin', 'git@github.com:acme/fixture.git')
  writeFileSync(CONFIG, JSON.stringify({ install: ['node', 'install.mjs'], build: ['node', 'build.mjs'], outDir: 'dist' }))
})

after(() => rmSync(ROOT, { recursive: true, force: true }))

interface Outcome {
  readonly code: number
  readonly out: string[]
  readonly err: string[]
  readonly dir: string
  readonly work: string
}

let runs = 0

async function drift(args: string[], extra: Partial<Deps> = {}): Promise<Outcome> {
  const out: string[] = []
  const err: string[] = []
  const work = join(ROOT, `tmp-${++runs}`)
  mkdirSync(work)
  const dir = join(ROOT, `out-${runs}`)
  const code = await main(['build', '--repo', REPO, '--out', dir, ...args], {
    tmp: work, home: HOME, env: {}, out: line => out.push(line), err: line => err.push(line), ...extra,
  })
  return { code, out, err, dir, work }
}

const refs = (base: string, head: string): string[] => ['--config', CONFIG, '--base', sha[base] ?? '', '--head', sha[head] ?? '']

test('the same ref twice reads identical, exit 0, the run directory on the last line', async () => {
  const { code, out, dir } = await drift(refs('base', 'base'))
  assert.equal(code, 0)
  assert.equal(out[0], 'drift: identical')
  assert.equal(out.at(-1), `out: ${dir}`)
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { verdict: string; files: unknown[] }
  assert.equal(report.verdict, 'identical')
  assert.deepEqual(report.files, [])
  assert.equal(readFileSync(join(dir, 'report.txt'), 'utf8'), `${out.slice(0, -1).join('\n')}\n`)
})

test('two refs differing by one module name it, 1 differ, exit 1, and the same refs give the same report', async () => {
  const first = await drift(refs('base', 'module'))
  assert.equal(first.code, 1)
  assert.equal(first.out[0], 'drift: 1 differ')
  assert.match(first.out[1] ?? '', /^changed assets\/index\.js raw 0 gzip (0|[-+]\d+)$/)
  assert.equal(first.out[2], '  source src/b.js')
  const second = await drift(refs('base', 'module'))
  assert.equal(readFileSync(join(second.dir, 'report.json'), 'utf8'), readFileSync(join(first.dir, 'report.json'), 'utf8'))
})

test('a hash-only rename reads identical, its references normalised', async () => {
  const { code, out } = await drift(refs('base', 'salt'))
  assert.equal(code, 0)
  assert.equal(out[0], 'drift: identical (hash references normalised in 3 files)')
})

test('the config\'s hash pattern is the one names are stripped by', async () => {
  assert.equal((await drift(refs('dotted', 'dotted-salt'))).code, 1)
  const dotted = join(ROOT, 'dotted.json')
  writeFileSync(dotted, JSON.stringify({ install: ['node', 'install.mjs'], build: ['node', 'build.mjs'], outDir: 'dist', hashPattern: String.raw`\.[0-9a-f]{8}(?=\.js(?:\.map)?$)` }))
  const { code, out } = await drift(['--config', dotted, '--base', sha['dotted'] ?? '', '--head', sha['dotted-salt'] ?? ''])
  assert.equal(code, 0)
  assert.equal(out[0], 'drift: identical (hash references normalised in 3 files)')
})

test('added and removed files are listed with their sizes', async () => {
  const { code, out } = await drift(refs('base', 'files'))
  assert.equal(code, 1)
  assert.deepEqual(out.slice(0, 3), ['drift: 2 differ', 'added new.txt raw +10 gzip +30', 'removed old.txt raw -4 gzip -24'])
})

test('a failing build is a tool error, exit 2, its log named, and no checkout left behind', async () => {
  const { code, err, dir, work } = await drift(refs('base', 'broken'))
  assert.equal(code, 2)
  assert.match(err.join('\n'), new RegExp(`head: build failed \\(exit 1\\); its log: ${join(dir, 'head.log').replace(/[.]/g, '\\.')}`))
  assert.match(readFileSync(join(dir, 'head.log'), 'utf8'), /build failed on purpose/)
  assert.deepEqual(readdirSync(work), [])
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
  assert.equal(git('status', '--porcelain'), '')
})

test('a symbolic link is compared by its target, and any other special file is a tool error', async () => {
  const changed = await drift(refs('link-a', 'link-b'))
  assert.equal(changed.code, 1)
  assert.deepEqual(changed.out.slice(0, 2), ['drift: 1 differ', 'changed latest raw +3 gzip +3'])
  assert.equal((await drift(refs('link-a', 'link-a'))).code, 0)
  const fifo = await drift(refs('base', 'fifo'))
  assert.equal(fifo.code, 2)
  assert.match(fifo.err.join('\n'), /pipe is neither a file, a directory nor a symbolic link/)
  assert.deepEqual(readdirSync(fifo.work), [])
})

test('the install runs before the build; its failure is a tool error, its log named', async () => {
  const noInstall = join(ROOT, 'no-install.json')
  writeFileSync(noInstall, JSON.stringify({ build: ['node', 'build.mjs'], outDir: 'dist' }))
  const skipped = await drift(['--config', noInstall, '--base', sha['base'] ?? '', '--head', sha['base'] ?? ''])
  assert.equal(skipped.code, 2)
  assert.match(skipped.err.join('\n'), /base: build failed \(exit 1\)/)
  assert.match(readFileSync(join(skipped.dir, 'base.log'), 'utf8'), /not installed/)
  const { code, err, dir, work } = await drift(refs('base', 'no-install'))
  assert.equal(code, 2)
  assert.match(err.join('\n'), new RegExp(`head: install failed \\(exit 1\\); its log: ${join(dir, 'head.log').replace(/[.]/g, '\\.')}`))
  assert.match(readFileSync(join(dir, 'head.log'), 'utf8'), /install failed on purpose/)
  assert.deepEqual(readdirSync(work), [])
})

test('the config\'s env reaches the install and the build of both sides', async () => {
  const stamped = await drift(refs('stamped', 'stamped-ci'))
  assert.equal(stamped.code, 1)
  assert.match(stamped.out[1] ?? '', /^changed release\.txt /)
  const fixed = join(ROOT, 'env.json')
  writeFileSync(fixed, JSON.stringify({ install: ['node', 'install.mjs'], build: ['node', 'build.mjs'], outDir: 'dist', env: { FIXTURE_RELEASE: 'r1' } }))
  const { code, out } = await drift(['--config', fixed, '--base', sha['stamped'] ?? '', '--head', sha['stamped-ci'] ?? ''])
  assert.equal(code, 0)
  assert.equal(out[0], 'drift: identical')
})

test('the default config is read from the home, named after the origin', async () => {
  const missing = await drift(['--base', sha['base'] ?? '', '--head', sha['base'] ?? ''])
  assert.equal(missing.code, 2)
  assert.match(missing.err.join('\n'), new RegExp(`no config at ${join(HOME, '.claude/drift/acme-fixture.json')}`))
  mkdirSync(join(HOME, '.claude', 'drift'), { recursive: true })
  cpSync(CONFIG, join(HOME, '.claude', 'drift', 'acme-fixture.json'))
  const found = await drift(['--base', sha['base'] ?? '', '--head', sha['base'] ?? ''])
  assert.equal(found.code, 0)
})

test('the default config is read from CLAUDE_CONFIG_DIR when it is set', async () => {
  const dir = join(ROOT, 'config-dir')
  const { code, err } = await drift(['--base', sha['base'] ?? '', '--head', sha['base'] ?? ''], { env: { CLAUDE_CONFIG_DIR: dir } })
  assert.equal(code, 2)
  assert.match(err.join('\n'), new RegExp(`no config at ${join(dir, 'drift/acme-fixture.json')}`))
})

test('what cannot start is a tool error: a bad ref, no repository, a bad call, a broken config, a missing outDir', async () => {
  const badRef = await drift(['--config', CONFIG, '--base', 'no-such-ref'])
  assert.equal(badRef.code, 2)
  assert.match(badRef.err.join('\n'), /base: no-such-ref is not a commit/)
  const notRepo = await main(['build', '--repo', HOME, '--config', CONFIG], { tmp: ROOT, home: HOME, env: {}, out: () => undefined, err: () => undefined })
  assert.equal(notRepo, 2)
  const errors: string[] = []
  assert.equal(await main([], { tmp: ROOT, home: HOME, env: {}, out: () => undefined, err: line => errors.push(line) }), 2)
  assert.match(errors.join('\n'), /^drift: usage: drift build/)
  writeFileSync(join(ROOT, 'bad.json'), '{')
  assert.equal((await drift(['--config', join(ROOT, 'bad.json')])).code, 2)
  writeFileSync(join(ROOT, 'nodir.json'), JSON.stringify({ build: ['node', '--version'], outDir: 'dist' }))
  const noDir = await drift(['--config', join(ROOT, 'nodir.json'), '--base', sha['base'] ?? '', '--head', sha['base'] ?? ''])
  assert.equal(noDir.code, 2)
  assert.match(noDir.err.join('\n'), /base: the build left no dist/)
  assert.deepEqual(readdirSync(noDir.work), [])
})

test('an aborted run stops its command, removes its checkout and exits 2', async () => {
  const slow = join(ROOT, 'slow.json')
  writeFileSync(slow, JSON.stringify({ build: ['node', '-e', 'setTimeout(() => undefined, 60000)'], outDir: 'dist' }))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  const started = Date.now()
  const { code, err, work } = await drift(['--config', slow, '--base', sha['base'] ?? '', '--head', sha['base'] ?? ''], { signal: controller.signal })
  assert.ok(Date.now() - started < 20000)
  assert.equal(code, 2)
  assert.match(err.join('\n'), /interrupted/)
  assert.deepEqual(readdirSync(work), [])
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
})

test('an aborted run stops the whole build, the processes it started included, before removing its checkout', async () => {
  const pidFile = join(ROOT, 'grandchild.pid')
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => undefined, 60000)`
  const slow = join(ROOT, 'slow-tree.json')
  writeFileSync(slow, JSON.stringify({ build: ['node', '-e', script], outDir: 'dist' }))
  const controller = new AbortController()
  const started = setInterval(() => {
    if (existsSync(pidFile)) controller.abort()
  }, 50)
  const { code, work } = await drift(['--config', slow, '--base', sha['base'] ?? '', '--head', sha['base'] ?? ''], { signal: controller.signal })
  clearInterval(started)
  assert.equal(code, 2)
  assert.deepEqual(readdirSync(work), [])
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let k = 0; k < 40 && alive(); k++) await new Promise(done => setTimeout(done, 50))
  const survived = alive()
  if (survived) process.kill(pid, 'SIGKILL')
  assert.equal(survived, false)
})

test('without --out the run directory is made under the scratchpad, else the temp directory', async () => {
  const pad = join(ROOT, 'claude-root', 'proj', 'sess', 'scratchpad')
  mkdirSync(pad, { recursive: true })
  const out: string[] = []
  const deps = { tmp: ROOT, home: HOME, env: { CLAUDE_CODE_SESSION_ID: 'sess' }, hostTmp: join(ROOT, 'claude-root'), out: (line: string) => out.push(line), err: () => undefined }
  assert.equal(await main(['build', '--repo', REPO, ...refs('base', 'base')], deps), 0)
  assert.match(out.at(-1) ?? '', new RegExp(`^out: ${pad}/drift-`))
  assert.ok(existsSync(join((out.at(-1) ?? '').slice(5), 'report.json')))
  out.length = 0
  assert.equal(await main(['build', '--repo', REPO, ...refs('base', 'base')], { ...deps, env: {} }), 0)
  assert.match(out.at(-1) ?? '', new RegExp(`^out: ${ROOT}/drift-`))
})

test('drift shots without the shared Playwright install exits 2, naming the command that installs it', async () => {
  const configDir = join(ROOT, 'no-playwright')
  const err: string[] = []
  const code = await main(['shots', '--repo', REPO, '--config', CONFIG], { tmp: ROOT, home: HOME, env: { CLAUDE_CONFIG_DIR: configDir }, out: () => undefined, err: line => err.push(line) })
  assert.equal(code, 2)
  assert.equal(err.join('\n'), `drift: Playwright ${PLAYWRIGHT_VERSION} is not installed in ${join(configDir, 'playwright', PLAYWRIGHT_VERSION)}: run /drift:install`)
})

test('drift install puts the pinned Playwright in the shared directory once, and says where and how big', async () => {
  const configDir = join(ROOT, 'playwright-home')
  const calls: string[][] = []
  const installRun = async (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<number> => {
    calls.push([...argv])
    if (argv[0] === 'npm') {
      mkdirSync(join(cwd, 'node_modules', '@playwright', 'test'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ version: PLAYWRIGHT_VERSION }))
    } else {
      mkdirSync(join(env['PLAYWRIGHT_BROWSERS_PATH'] ?? '', 'chromium_headless_shell-1'), { recursive: true })
      writeFileSync(join(env['PLAYWRIGHT_BROWSERS_PATH'] ?? '', 'chromium_headless_shell-1', 'chrome'), Buffer.alloc(3_000_000))
    }
    return 0
  }
  const out: string[] = []
  const deps = { tmp: ROOT, home: HOME, env: { CLAUDE_CONFIG_DIR: configDir }, out: (line: string) => out.push(line), err: () => undefined, installRun }
  const dir = join(configDir, 'playwright', PLAYWRIGHT_VERSION)
  assert.equal(await main(['install'], deps), 0)
  assert.equal(await main(['install'], deps), 0)
  assert.deepEqual(out, [`drift: Playwright ${PLAYWRIGHT_VERSION} installed in ${dir} (3 MB)`, `drift: Playwright ${PLAYWRIGHT_VERSION} already installed in ${dir} (3 MB)`])
  assert.equal(calls.length, 2)
  const err: string[] = []
  assert.equal(await main(['install', '--now'], { ...deps, err: line => err.push(line) }), 2)
  assert.match(err.join('\n'), /^drift: usage: drift build/)
})
