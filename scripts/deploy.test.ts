import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { PLAYWRIGHT_VERSION } from '../packages/core/src/playwright.ts'
import { DEPLOYS_DIR, greenCommit, isNew, KEEP_MS, MARKETPLACE, parseState, prunable, run, sharingConfigs, stamped, stampTree, statusLine, versionsIn, type Host, type State } from './deploy.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const ALPHA = `alpha@${MARKETPLACE}`

function runsOf(...runs: { sha: string; event?: string; conclusion?: string; branch?: string }[]): unknown {
  return { workflow_runs: runs.map(run => ({ head_sha: run.sha, event: run.event ?? 'push', conclusion: run.conclusion ?? 'success', head_branch: run.branch ?? 'main' })) }
}

function stateOf(history: string[], extra: Partial<State> = {}): State {
  return { version: 1, repo: 'acme/app', marketplace: MARKETPLACE, history: history.map((commit, at) => ({ commit, at: new Date(Date.UTC(2026, 0, 10 - at)).toISOString() })), skipped: [], pending: false, plugins: { alpha: '1.2.3' }, ...extra }
}

/** The project the plugins are installed in at the project scope. */
const PROJECT = '/home/me'

/** Writes the tree of a repository at a commit: the catalogue and its plugins (alpha alone by default). */
function treeAt(into: string, version = '1.2.3', name = MARKETPLACE, plugins: readonly string[] = ['alpha']): void {
  mkdirSync(join(into, '.claude-plugin'), { recursive: true })
  writeFileSync(join(into, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name, plugins: [] }))
  for (const plugin of plugins) {
    mkdirSync(join(into, 'plugins', plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(join(into, 'plugins', plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin, nested: { version: '9.9.9' }, version }))
  }
  mkdirSync(join(into, 'plugins', 'notes'), { recursive: true })
}

interface Fake {
  readonly host: Host
  readonly calls: string[]
  green: string
  /** The update throws. */
  failUpdate: boolean
  /** The update exits 0 and changes nothing. */
  idleUpdate: boolean
  /** The update of this plugin alone throws. */
  failOn: string
  /** The installed tree's own `--status` fails. */
  failSmoke: boolean
  /** The configuration directories the marketplace was pointed in, in order. */
  readonly repointed: string[]
  /** The repoint in the configuration directory of this name throws. */
  failRepoint: string
  /** The plugins of the commits extracted. */
  tree: string[]
  /** The status bar's launcher of the commits extracted; none when undefined. */
  launcher: string | undefined
  /** The installed plugins of the marketplace, by id, with the version the host records. */
  readonly versions: Map<string, string>
  /** The same plugins installed at the project scope too, by id, with the version the host records. */
  readonly projectVersions: Map<string, string>
  /** The pids that no longer run. */
  readonly dead: Set<number>
  /** The install of this plugin alone throws. */
  failInstall: string
  /** The install step throws. */
  failStep: boolean
  /** What happens while the install step runs: another run, started meanwhile. */
  during: (() => void) | undefined
  /** The configuration directory each install step ran for, in order. */
  readonly steps: string[]
}

/** A host that installs as the real one does: an update takes the version of the directory pointed at. */
function fake(now = Date.UTC(2026, 0, 20)): Fake {
  let pointed = ''
  const self: Fake = {
    calls: [],
    green: A,
    failUpdate: false,
    idleUpdate: false,
    failOn: '',
    failSmoke: false,
    repointed: [],
    failRepoint: '',
    tree: ['alpha'],
    launcher: undefined,
    versions: new Map([[ALPHA, '1.2.3']]),
    projectVersions: new Map(),
    dead: new Set(),
    failInstall: '',
    failStep: false,
    during: undefined,
    steps: [],
    host: {
      api: path => {
        self.calls.push(`api ${path}`)
        return runsOf({ sha: self.green })
      },
      extract: (repo, commit, into) => {
        self.calls.push(`extract ${repo} ${commit.slice(0, 1)}`)
        treeAt(into, '1.2.3', MARKETPLACE, self.tree)
        if (self.launcher !== undefined) {
          mkdirSync(join(into, 'plugins', 'statusbar', 'statusline'), { recursive: true })
          writeFileSync(join(into, 'plugins', 'statusbar', 'statusline', 'launcher.sh'), self.launcher)
        }
      },
      smoke: dir => {
        if (self.failSmoke) throw new Error(`${dir}/scripts/deploy.ts --status: SyntaxError`)
      },
      repoint: (dir, config) => {
        if (basename(config) === self.failRepoint) throw new Error(`repoint of ${basename(config)} refused`)
        self.repointed.push(config)
        pointed = dir
        self.calls.push(`repoint ${dir.slice(-1)}`)
      },
      installed: () => [
        ...[...self.versions].map(([id, version]) => ({ id, version, scope: 'user' })),
        ...[...self.projectVersions].map(([id, version]) => ({ id, version, scope: 'project', projectPath: PROJECT })),
        { id: 'other@elsewhere', version: '0.0.1', scope: 'user' },
      ],
      // As the real host: without a scope, the entry of the project the scheduler runs in (the project's) is the one updated.
      update: (id, scope, projectPath) => {
        if (self.failUpdate) throw new Error('update refused')
        if (self.failOn === id) throw new Error(`update of ${id} refused`)
        const at = (scope as string | undefined) ?? (self.projectVersions.has(id) ? 'project' : 'user')
        if (at === 'project' && projectPath !== PROJECT) throw new Error('the project scope is updated from the project')
        self.calls.push(at === 'user' ? `update ${id}` : `update ${id} at ${at}`)
        if (!self.idleUpdate) (at === 'user' ? self.versions : self.projectVersions).set(id, versionsIn(pointed)[id.split('@')[0] ?? ''] ?? '')
      },
      installPlugin: id => {
        if (self.failInstall === id) throw new Error(`install of ${id} refused`)
        self.calls.push(`install ${id}`)
        self.versions.set(id, versionsIn(pointed)[id.split('@')[0] ?? ''] ?? '')
      },
      // As drift's: what it leaves is the pinned Playwright, whole, in the configuration directory.
      installStep: (script, config) => {
        self.calls.push(`step ${script.slice(script.indexOf('plugins'))}`)
        const meanwhile = self.during
        self.during = undefined
        meanwhile?.()
        if (self.failStep) throw new Error('npm ci failed')
        self.steps.push(config)
        playwrightAt(config, PLAYWRIGHT_VERSION)
        return `drift: Playwright ${PLAYWRIGHT_VERSION} installed\n`
      },
      alive: pid => !self.dead.has(pid),
      now: () => now,
    },
  }
  return self
}

function sandbox(): { env: Record<string, string>; root: string; out: string[]; err: string[] } {
  const config = mkdtempSync(join(tmpdir(), 'deploy-'))
  return { env: { CLAUDE_CONFIG_DIR: config }, root: join(config, DEPLOYS_DIR, MARKETPLACE), out: [], err: [] }
}

function deploy(box: ReturnType<typeof sandbox>, host: Host, ...args: string[]): number {
  return run(['--repo', 'acme/app', ...args], { env: box.env, out: line => box.out.push(line), err: line => box.err.push(line) }, host)
}

/** Writes the `settings.json` of the box's configuration directory, its `enabledPlugins` alone. */
function enable(box: { env: Record<string, string> }, enabledPlugins: Record<string, boolean>): void {
  writeFileSync(join(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json'), JSON.stringify({ enabledPlugins }))
}

/** A whole install of Playwright `version` in the configuration directory `config`, as core's installer leaves it. */
function playwrightAt(config: string, version: string): void {
  const dir = join(config, 'playwright', version)
  mkdirSync(join(dir, 'node_modules', '@playwright', 'test'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ version }))
  mkdirSync(join(dir, 'browsers', 'chromium_headless_shell-1'), { recursive: true })
  writeFileSync(join(dir, 'browsers', 'chromium_headless_shell-1', 'INSTALLATION_COMPLETE'), '')
  writeFileSync(join(dir, '.complete'), `${version}\n`)
}

function stateIn(box: ReturnType<typeof sandbox>): State {
  return parseState(readFileSync(join(box.root, 'installed.json'), 'utf8'))
}

describe('the green commit', () => {
  it('is the newest commit with a successful push run', () => {
    assert.equal(greenCommit(runsOf({ sha: A, conclusion: 'failure' }, { sha: B }, { sha: C })), B)
  })

  it('counts a push run of main only', () => {
    assert.equal(greenCommit(runsOf({ sha: A, event: 'schedule' }, { sha: B, branch: 'other' }, { sha: C })), C)
  })

  it('is the commit asked, when green', () => {
    const runs = runsOf({ sha: A }, { sha: B }, { sha: C, conclusion: 'failure' })
    assert.equal(greenCommit(runs, B), B)
    assert.equal(greenCommit(runs, C), null)
  })

  it('is none when no run succeeded', () => {
    assert.equal(greenCommit(runsOf({ sha: A, conclusion: 'cancelled' })), null)
  })

  it('refuses an answer without runs', () => {
    assert.throws(() => greenCommit({ message: 'Not Found' }), /workflow_runs/)
  })

  it('is deployed only when never installed and never rolled back from', () => {
    assert.equal(isNew(undefined, A), true)
    assert.equal(isNew(stateOf([A]), A), false)
    assert.equal(isNew(stateOf([B, A]), A), false)
    assert.equal(isNew(stateOf([B], { skipped: [C] }), C), false)
    assert.equal(isNew(stateOf([B]), C), true)
  })
})

describe('the stamp', () => {
  it('carries the commit as build metadata, replacing an earlier one', () => {
    assert.equal(stamped('1.2.3', A), '1.2.3+aaaaaaa')
    assert.equal(stamped('1.2.3+bbbbbbb', A), '1.2.3+aaaaaaa')
  })

  it('rewrites the version of every manifest of the tree, and no other field', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-'))
    treeAt(root)
    assert.deepEqual(stampTree(root, B), { alpha: '1.2.3+bbbbbbb' })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'alpha', nested: { version: '9.9.9' }, version: '1.2.3+bbbbbbb' })
  })

  it('refuses a manifest that leads out of the tree, or has no version', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify({ version: '1.0.0' }))
    const root = mkdtempSync(join(tmpdir(), 'tree-'))
    mkdirSync(join(root, 'plugins', 'beta'), { recursive: true })
    symlinkSync(outside, join(root, 'plugins', 'beta', '.claude-plugin'))
    assert.throws(() => stampTree(root, A), /leads out of the tree/)
    const bare = mkdtempSync(join(tmpdir(), 'tree-'))
    mkdirSync(join(bare, 'plugins', 'gamma', '.claude-plugin'), { recursive: true })
    writeFileSync(join(bare, 'plugins', 'gamma', '.claude-plugin', 'plugin.json'), '{}')
    assert.throws(() => versionsIn(bare), /no version/)
  })
})

/** A home with `.claude` (the plugins), `.claude-bis` and `.claude-ter` (links to them), `.claude-own` (plugins of its own) and `.other` (not a sibling). */
function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
  mkdirSync(join(root, '.claude', 'plugins'), { recursive: true })
  for (const name of ['.claude-bis', '.claude-ter']) {
    mkdirSync(join(root, name))
    symlinkSync(join(root, '.claude', 'plugins'), join(root, name, 'plugins'))
  }
  mkdirSync(join(root, '.claude-own', 'plugins'), { recursive: true })
  mkdirSync(join(root, '.claude-bare'))
  mkdirSync(join(root, '.other'))
  symlinkSync(join(root, '.claude', 'plugins'), join(root, '.other', 'plugins'))
  return root
}

describe('the configurations sharing the plugins', () => {
  it('are the config and each sibling whose plugins resolve to the same directory', () => {
    const root = home()
    assert.deepEqual(sharingConfigs(join(root, '.claude')), [join(root, '.claude'), join(root, '.claude-bis'), join(root, '.claude-ter')])
  })

  it('are the same, the owner first, whichever of them runs', () => {
    const root = home()
    const all = [join(root, '.claude'), join(root, '.claude-bis'), join(root, '.claude-ter')]
    assert.deepEqual(sharingConfigs(join(root, '.claude-bis')), all)
    assert.deepEqual(sharingConfigs(join(root, '.claude-ter')), all)
  })

  it('are the config alone when it has no plugins directory', () => {
    const root = home()
    assert.deepEqual(sharingConfigs(join(root, '.claude-bare')), [join(root, '.claude-bare')])
  })

  it('are reached by the deploy: the marketplace is pointed in each, the cron\'s own first, and a sibling with plugins of its own is left alone', () => {
    const root = home()
    const box = { env: { CLAUDE_CONFIG_DIR: join(root, '.claude') }, root: join(root, '.claude', DEPLOYS_DIR, MARKETPLACE), out: [] as string[], err: [] as string[] }
    const f = fake()
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.repointed.map(config => basename(config)), ['.claude', '.claude-bis', '.claude-ter'])
    assert.equal(f.calls.filter(call => call.startsWith('update')).length, 1)
  })

  it('are reached by a deploy run from a sibling: the owner is pointed first', () => {
    const root = home()
    const box = { env: { CLAUDE_CONFIG_DIR: join(root, '.claude-bis') }, root: join(root, '.claude-bis', DEPLOYS_DIR, MARKETPLACE), out: [] as string[], err: [] as string[] }
    const f = fake()
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.repointed.map(config => basename(config)), ['.claude', '.claude-bis', '.claude-ter'])
  })

  it('fail the run with the name of the one that cannot be pointed, the others still pointed', () => {
    const root = home()
    const box = { env: { CLAUDE_CONFIG_DIR: join(root, '.claude') }, root: join(root, '.claude', DEPLOYS_DIR, MARKETPLACE), out: [] as string[], err: [] as string[] }
    const f = fake()
    f.failRepoint = '.claude-bis'
    assert.equal(deploy(box, f.host), 1)
    assert.match(box.err.join('\n'), /\.claude-bis: repoint of \.claude-bis refused.*run npm run deploy again/)
    assert.deepEqual(f.repointed.map(config => basename(config)), ['.claude', '.claude-ter'])
    assert.equal(existsSync(join(box.root, 'current')), false)
  })
})

/** Installs the bar's launcher copy `text` in the configuration directory `config`, as its installer does. */
function installedLauncher(config: string, text: string): string {
  const path = join(config, 'statusbar', 'statusline.sh')
  mkdirSync(join(config, 'statusbar'), { recursive: true })
  writeFileSync(path, text, { mode: 0o755 })
  return path
}

describe('the status line launcher', () => {
  it('is replaced by the installed tree\'s where the bar is installed, mode 755, and the refresh is told once', () => {
    const box = sandbox()
    const config = box.env['CLAUDE_CONFIG_DIR'] ?? ''
    const copy = installedLauncher(config, 'old\n')
    writeFileSync(join(config, 'settings.json'), '{"statusLine":{}}')
    const f = fake()
    f.launcher = 'new\n'
    assert.equal(deploy(box, f.host), 0)
    assert.equal(readFileSync(copy, 'utf8'), 'new\n')
    assert.equal(statSync(copy).mode & 0o777, 0o755)
    assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), '{"statusLine":{}}')
    assert.deepEqual(box.out.filter(line => line.includes('launcher')), [`deploy: refreshed the status line launcher ${realpathSync(copy)}`])
  })

  it('is left alone in a configuration where the bar is not installed, and settings.json is never written', () => {
    const box = sandbox()
    const config = box.env['CLAUDE_CONFIG_DIR'] ?? ''
    writeFileSync(join(config, 'settings.json'), '{}')
    const f = fake()
    f.launcher = 'new\n'
    assert.equal(deploy(box, f.host), 0)
    assert.equal(existsSync(join(config, 'statusbar')), false)
    assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), '{}')
    assert.equal(box.out.some(line => line.includes('launcher')), false)
  })

  it('is written through a linked statusbar directory, to its target, which stays a link', () => {
    const root = home()
    const target = installedLauncher(join(root, '.claude'), 'old\n')
    symlinkSync(join(root, '.claude', 'statusbar'), join(root, '.claude-bis', 'statusbar'))
    const box = { env: { CLAUDE_CONFIG_DIR: join(root, '.claude-bis') }, root: join(root, '.claude-bis', DEPLOYS_DIR, MARKETPLACE), out: [] as string[], err: [] as string[] }
    const f = fake()
    f.launcher = 'new\n'
    assert.equal(deploy(box, f.host), 0)
    assert.equal(readFileSync(target, 'utf8'), 'new\n')
    assert.equal(lstatSync(join(root, '.claude-bis', 'statusbar')).isSymbolicLink(), true)
    assert.equal(box.out.filter(line => line.includes('launcher')).length, 1)
  })

  it('is not rewritten when it is the tree\'s already', () => {
    const box = sandbox()
    const copy = installedLauncher(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'same\n')
    const before = statSync(copy).ino
    const f = fake()
    f.launcher = 'same\n'
    assert.equal(deploy(box, f.host), 0)
    assert.equal(statSync(copy).ino, before)
    assert.equal(box.out.some(line => line.includes('launcher')), false)
  })

  it('is refreshed by a run that installs nothing, so a copy gone stale is mended at the next run', () => {
    const box = sandbox()
    const f = fake()
    f.launcher = 'new\n'
    deploy(box, f.host)
    const copy = installedLauncher(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'old\n')
    assert.equal(deploy(box, f.host), 0)
    assert.match(box.out.at(-2) ?? '', /is installed/)
    assert.equal(readFileSync(copy, 'utf8'), 'new\n')
  })

  it('is written to the target of a launcher that is itself a link, which stays a link', () => {
    const box = sandbox()
    const config = box.env['CLAUDE_CONFIG_DIR'] ?? ''
    const target = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'launcher.sh')
    writeFileSync(target, 'old\n')
    mkdirSync(join(config, 'statusbar'))
    symlinkSync(target, join(config, 'statusbar', 'statusline.sh'))
    const f = fake()
    f.launcher = 'new\n'
    assert.equal(deploy(box, f.host), 0)
    assert.equal(lstatSync(join(config, 'statusbar', 'statusline.sh')).isSymbolicLink(), true)
    assert.equal(readFileSync(target, 'utf8'), 'new\n')
  })

  it('is told on stderr, without failing the run, when it cannot be written', () => {
    const box = sandbox()
    const config = box.env['CLAUDE_CONFIG_DIR'] ?? ''
    mkdirSync(join(config, 'statusbar', 'statusline.sh'), { recursive: true })
    const f = fake()
    f.launcher = 'new\n'
    assert.equal(deploy(box, f.host), 0)
    assert.match(box.err.join('\n'), /status line launcher of .* was not refreshed/)
    assert.equal(stateIn(box).pending, false)
  })

  it('is left alone when the installed tree carries none', () => {
    const box = sandbox()
    const copy = installedLauncher(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'old\n')
    assert.equal(deploy(box, fake().host), 0)
    assert.equal(readFileSync(copy, 'utf8'), 'old\n')
    assert.deepEqual(box.err, [])
  })

  it('is refreshed even when a plugin update fails, and again by the run that finishes the update', () => {
    const box = sandbox()
    const copy = installedLauncher(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'old\n')
    const f = fake()
    f.launcher = 'new\n'
    f.failUpdate = true
    assert.equal(deploy(box, f.host), 1)
    assert.equal(readFileSync(copy, 'utf8'), 'new\n')
    writeFileSync(copy, 'old\n')
    f.failUpdate = false
    assert.equal(deploy(box, f.host), 0)
    assert.equal(stateIn(box).pending, false)
    assert.equal(readFileSync(copy, 'utf8'), 'new\n')
  })

  it('is the launcher of the commit rolled back to', () => {
    const box = sandbox()
    const copy = installedLauncher(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'old\n')
    const f = fake()
    f.launcher = 'first\n'
    deploy(box, f.host)
    f.green = B
    f.launcher = 'second\n'
    deploy(box, f.host)
    assert.equal(readFileSync(copy, 'utf8'), 'second\n')
    assert.equal(deploy(box, f.host, '--rollback'), 0)
    assert.equal(readFileSync(copy, 'utf8'), 'first\n')
  })
})

describe('the deploy', () => {
  it('extracts the green commit, stamps it, points the marketplace at it and updates its plugins', () => {
    const box = sandbox()
    const { host, calls } = fake()
    assert.equal(deploy(box, host), 0)
    assert.match(calls[0] ?? '', /^api repos\/acme\/app\/actions\/workflows\/ci\.yml\/runs\?branch=main&status=success/)
    assert.deepEqual(calls.slice(1), ['extract acme/app a', 'repoint a', `update ${ALPHA}`])
    assert.equal(versionsIn(join(box.root, A))['alpha'], '1.2.3+aaaaaaa')
    assert.equal(readlinkSync(join(box.root, 'current')), join(box.root, A))
    const state = stateIn(box)
    assert.deepEqual(state.history, [{ commit: A, at: '2026-01-20T00:00:00.000Z' }])
    assert.deepEqual(state.plugins, { alpha: '1.2.3+aaaaaaa' })
    assert.equal(state.pending, false)
  })

  it('does nothing when the green commit is installed', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.length, 1)
    assert.match(box.out.at(-1) ?? '', /aaaaaaa, the newest green commit, is installed/)
  })

  it('says so and changes nothing when no commit is green', () => {
    const box = sandbox()
    const host: Host = { ...fake().host, api: () => runsOf({ sha: A, conclusion: 'failure' }) }
    assert.equal(deploy(box, host), 0)
    assert.match(box.out.join('\n'), /no commit of main with a successful push run/)
    assert.equal(existsSync(join(box.root, 'installed.json')), false)
  })

  it('installs the commit asked, refuses one that is not green or not a full sha', () => {
    const box = sandbox()
    const f = fake()
    const host: Host = { ...f.host, api: () => runsOf({ sha: B }, { sha: A }) }
    assert.equal(deploy(box, host, '--commit', A), 0)
    assert.equal(stateIn(box).history[0]?.commit, A)
    assert.equal(deploy(box, host, '--commit', C), 1)
    assert.match(box.err.at(-1) ?? '', /has no successful push run on main/)
    assert.equal(deploy(box, host, '--commit', 'aaaaaaa'), 1)
    assert.match(box.err.at(-1) ?? '', /full commit sha/)
    assert.equal(deploy(box, host, '--commit'), 1)
    assert.match(box.err.at(-1) ?? '', /--commit needs a value/)
    assert.equal(run(['--repo', 'not a repo'], { env: box.env, out: () => {}, err: line => box.err.push(line) }, host), 1)
    assert.match(box.err.at(-1) ?? '', /owner\/name/)
  })

  it('installs a commit rolled back from when asked by name, and no longer skips it', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    deploy(box, f.host, '--rollback')
    assert.equal(deploy(box, f.host, '--commit', B), 0)
    assert.equal(stateIn(box).history[0]?.commit, B)
    assert.deepEqual(stateIn(box).skipped, [])
  })

  it('refuses a tree whose catalogue is another marketplace, and reuses the tree once extracted', () => {
    const box = sandbox()
    const f = fake()
    const host: Host = { ...f.host, extract: (repo, commit, into) => { f.host.extract(repo, commit, into); treeAt(into, '1.2.3', 'elsewhere') } }
    assert.equal(deploy(box, host), 1)
    assert.match(box.err.join('\n'), /not named lounisbou/)
    writeFileSync(join(box.root, A, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MARKETPLACE }))
    assert.equal(deploy(box, host), 0)
    assert.equal(f.calls.filter(call => call.startsWith('extract')).length, 1)
  })

  it('keeps the plugin updates pending when one fails, and finishes them on the next run', () => {
    const box = sandbox()
    const f = fake()
    f.failUpdate = true
    assert.equal(deploy(box, f.host), 1)
    assert.match(box.err.join('\n'), /update refused/)
    assert.equal(stateIn(box).pending, true)
    f.failUpdate = false
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.calls.slice(1), ['repoint a', `update ${ALPHA}`])
    assert.equal(stateIn(box).pending, false)
  })

  it('fails, updates pending, when the host says it updated but kept the old version', () => {
    const box = sandbox()
    const f = fake()
    f.idleUpdate = true
    assert.equal(deploy(box, f.host), 1)
    assert.match(box.err.join('\n'), /the host did not update alpha@lounisbou \(1\.2\.3\)/)
    assert.equal(stateIn(box).pending, true)
  })

  it('updates a plugin installed at the project scope too, each entry at its own scope', () => {
    const box = sandbox()
    const f = fake()
    f.projectVersions.set(ALPHA, '1.2.3')
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.calls.slice(1), ['extract acme/app a', 'repoint a', `update ${ALPHA}`, `update ${ALPHA} at project`])
    assert.equal(stateIn(box).pending, false)
  })

  it('names the entry at the project scope whose update fails', () => {
    const box = sandbox()
    const f = fake()
    f.projectVersions.set(ALPHA, '1.2.3')
    const host: Host = { ...f.host, update: (id, scope, projectPath) => { if (scope === 'project') throw new Error('refused'); f.host.update(id, scope, projectPath) } }
    assert.equal(deploy(box, host), 1)
    assert.match(box.err.join('\n'), /alpha@lounisbou at project \/home\/me: refused/)
    assert.equal(f.versions.get(ALPHA), '1.2.3+aaaaaaa')
  })

  it('names the entry the host left behind at its scope', () => {
    const box = sandbox()
    const f = fake()
    f.projectVersions.set(ALPHA, '1.2.3')
    const update = f.host.update
    const host: Host = { ...f.host, update: (id, scope, projectPath) => { if (scope === 'user') update(id, scope, projectPath) } }
    assert.equal(deploy(box, host), 1)
    assert.match(box.err.join('\n'), /the host did not update alpha@lounisbou \(1\.2\.3\) at project \/home\/me: run npm run deploy again/)
    assert.equal(stateIn(box).pending, true)
  })

  it('updates every plugin when one update fails, and names the failures', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta']
    f.versions.set('beta@lounisbou', '1.0.0')
    f.failOn = ALPHA
    assert.equal(deploy(box, f.host), 1)
    assert.ok(f.calls.includes('update beta@lounisbou'))
    assert.match(box.err.join('\n'), /update of alpha@lounisbou refused/)
    assert.equal(stateIn(box).pending, true)
  })

  it('leaves alone a plugin the commit no longer carries, and installs the others', () => {
    const box = sandbox()
    const f = fake()
    f.versions.set('gone@lounisbou', '0.9.0')
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.includes('update gone@lounisbou'), false)
    assert.match(box.err.join('\n'), /gone@lounisbou is not in aaaaaaa: left as installed/)
    assert.equal(stateIn(box).pending, false)
  })

  it('records the last failure in the state, prints it in the status, and clears it once a run succeeds', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    f.green = B
    f.failUpdate = true
    assert.equal(deploy(box, f.host), 1)
    assert.deepEqual(stateIn(box).lastError, { at: '2026-01-20T00:00:00.000Z', message: `${ALPHA}: update refused: run npm run deploy again` })
    deploy(box, f.host, '--status')
    assert.match(box.out.at(-1) ?? '', /; last failure 2026-01-20 \d\d:\d\d: alpha@lounisbou: update refused: run npm run deploy again$/)
    f.failUpdate = false
    assert.equal(deploy(box, f.host), 0)
    assert.equal(stateIn(box).lastError, undefined)
  })

  it('refuses a commit whose own deploy script does not run, and keeps the one installed', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    f.green = B
    f.failSmoke = true
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 1)
    assert.match(box.err.at(-1) ?? '', /bbbbbbb does not run: .*--status: SyntaxError/)
    assert.equal(f.calls.some(call => call.startsWith('repoint')), false)
    assert.equal(readlinkSync(join(box.root, 'current')), join(box.root, A))
    assert.equal(stateIn(box).history[0]?.commit, A)
    assert.equal(deploy(box, f.host, '--rollback'), 1)
  })

  it('takes over the lock of a run that died, whatever its age', () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'installed.json.lock'), '999999\n')
    const f = fake(Date.now())
    f.dead.add(999999)
    assert.equal(deploy(box, f.host), 0)
    assert.match(box.err.join('\n'), /removed the lock of a run that died/)
    assert.equal(stateIn(box).history[0]?.commit, A)
  })

  it('refuses, exit 1, to roll back while another deploy runs', () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'installed.json.lock'), `${process.pid}\n`)
    assert.equal(deploy(box, fake(Date.now()).host, '--rollback'), 1)
    assert.match(box.err.at(-1) ?? '', /another deploy is running: roll back once it ends/)
  })

  it('leaves a running deploy alone, and takes over the lock of one that died', () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'installed.json.lock'), `${process.pid}\n`)
    const f = fake(Date.now())
    assert.equal(deploy(box, f.host), 0)
    assert.match(box.out.at(-1) ?? '', /another deploy is running/)
    assert.equal(f.calls.length, 0)
    const late = fake(Date.now() + 7 * 3_600_000)
    assert.equal(deploy(box, late.host), 0)
    assert.equal(stateIn(box).history[0]?.commit, A)
  })

  it('removes what a run that died left half written', () => {
    const box = sandbox()
    mkdirSync(join(box.root, `${B}.tmp-1`), { recursive: true })
    symlinkSync(join(box.root, 'gone'), join(box.root, 'current.tmp-1'))
    assert.equal(deploy(box, fake().host), 0)
    assert.equal(existsSync(join(box.root, `${B}.tmp-1`)), false)
    assert.throws(() => readlinkSync(join(box.root, 'current.tmp-1')))
  })
})

const BETA = `beta@${MARKETPLACE}`
const GAMMA = `gamma@${MARKETPLACE}`
const DRIFT = `drift@${MARKETPLACE}`
const STEP = 'step plugins/drift/install.sh'

describe('the plugins enabled in settings.json', () => {
  it('are installed when absent, one line each; a disabled one and another marketplace\'s are not', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta', 'gamma']
    enable(box, { [ALPHA]: true, [BETA]: true, [GAMMA]: false, 'beta@elsewhere': true })
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.calls.filter(call => call.startsWith('install')), [`install ${BETA}`])
    assert.deepEqual(box.out.filter(line => line.includes(BETA)), [`deploy: installed ${BETA}, enabled in settings.json`])
    assert.equal(f.calls.filter(call => call === `update ${ALPHA}`).length, 1)
    assert.equal(stateIn(box).pending, false)
  })

  it('are installed by a run with no new commit, once settings.json names them', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta']
    deploy(box, f.host)
    enable(box, { [BETA]: true })
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.ok(f.calls.includes(`install ${BETA}`))
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.length, 1)
  })

  it('stay pending when an install fails, the others installed and updated, and are retried by the next run', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta', 'gamma']
    deploy(box, f.host)
    enable(box, { [BETA]: true, [GAMMA]: true })
    f.failInstall = BETA
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 1)
    assert.match(box.err.join('\n'), /beta@lounisbou: install of beta@lounisbou refused.*run npm run deploy again/)
    assert.ok(f.calls.includes(`install ${GAMMA}`))
    assert.ok(f.calls.includes(`update ${ALPHA}`))
    assert.equal(stateIn(box).pending, true)
    f.failInstall = ''
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.calls.filter(call => call.startsWith('install')), [`install ${BETA}`])
    assert.equal(stateIn(box).pending, false)
  })

  it('are left out when the installed commit does not carry them, and make no run install again', () => {
    const box = sandbox()
    const f = fake()
    enable(box, { [GAMMA]: true })
    assert.equal(deploy(box, f.host), 0)
    assert.match(box.err.join('\n'), /gamma@lounisbou is enabled and not in aaaaaaa: not installed/)
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.length, 1)
  })

  it('are installed at the user scope when only a project has them', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta']
    f.projectVersions.set(BETA, '1.2.3')
    enable(box, { [BETA]: true })
    assert.equal(deploy(box, f.host), 0)
    assert.ok(f.calls.includes(`install ${BETA}`))
  })

  it('do not hold the updates back when settings.json cannot be read, and the run says so', () => {
    const box = sandbox()
    writeFileSync(join(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json'), '<<<<<<< Updated upstream')
    const f = fake()
    assert.equal(deploy(box, f.host), 1)
    assert.ok(f.calls.includes(`update ${ALPHA}`))
    assert.match(box.err.join('\n'), /settings\.json/)
  })

  it('leave a new commit installed with nothing pending when settings.json cannot be read, and no later run installs it again', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    writeFileSync(join(box.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json'), '<<<<<<< Updated upstream')
    f.green = B
    assert.equal(deploy(box, f.host), 1)
    assert.equal(stateIn(box).history[0]?.commit, B)
    assert.equal(stateIn(box).pending, false)
    assert.match(stateIn(box).lastError?.message ?? '', /settings\.json is not JSON/)
    f.calls.length = 0
    assert.equal(deploy(box, f.host), 1)
    assert.equal(f.calls.length, 1)
  })

  it('are read as not installed when the install exits 0 and the host lists none: said, left pending, at every run', () => {
    const box = sandbox()
    const f = fake()
    f.tree = ['alpha', 'beta']
    enable(box, { [BETA]: true })
    const host: Host = { ...f.host, installPlugin: () => {} }
    for (const _run of [1, 2]) {
      box.err.length = 0
      assert.equal(deploy(box, host), 1)
      assert.match(box.err.join('\n'), /beta@lounisbou: the host did not install it.*run npm run deploy again/)
      assert.equal(stateIn(box).pending, true)
      assert.match(stateIn(box).lastError?.message ?? '', /did not install it/)
    }
    assert.equal(box.out.some(line => line.includes(`installed ${BETA}`)), false)
  })
})

describe('the install step', () => {
  /** A box whose settings enable drift, and a host whose commits carry it. */
  function withDrift(): { box: ReturnType<typeof sandbox>; f: Fake; config: string } {
    const box = sandbox()
    enable(box, { [DRIFT]: true })
    const f = fake()
    f.tree = ['alpha', 'drift']
    return { box, f, config: box.env['CLAUDE_CONFIG_DIR'] ?? '' }
  }

  it('runs after the install, from the installed tree, and its last line is logged', () => {
    const { box, f, config } = withDrift()
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.calls.filter(call => call.startsWith('install') || call === STEP), [`install ${DRIFT}`, STEP])
    assert.deepEqual(f.steps, [config])
    assert.ok(box.out.includes(`deploy: ${DRIFT} install step: drift: Playwright ${PLAYWRIGHT_VERSION} installed`))
  })

  it('runs once per pinned version: not again by later runs or commits, again when the pin is not installed', () => {
    const { box, f, config } = withDrift()
    deploy(box, f.host)
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    assert.equal(f.steps.length, 1)
    // A machine holding the previous pin only: what a raised pin finds.
    rmSync(join(config, 'playwright'), { recursive: true })
    playwrightAt(config, '1.0.0')
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.steps.length, 2)
  })

  it('does not run for a drift that settings.json does not enable', () => {
    const { box, f } = withDrift()
    enable(box, { [DRIFT]: false })
    f.versions.set(DRIFT, '1.2.3')
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.includes(STEP), false)
  })

  it('does not run while drift is not installed', () => {
    const { box, f } = withDrift()
    f.failInstall = DRIFT
    assert.equal(deploy(box, f.host), 1)
    assert.equal(f.calls.includes(STEP), false)
  })

  it('failing, leaves every plugin installed and updated, nothing pending, and is retried by the next run', () => {
    const { box, f } = withDrift()
    f.failStep = true
    assert.equal(deploy(box, f.host), 1)
    assert.ok(f.calls.includes(`update ${ALPHA}`))
    assert.equal(stateIn(box).pending, false)
    assert.match(box.err.join('\n'), /drift@lounisbou install step: npm ci failed/)
    assert.match(stateIn(box).lastError?.message ?? '', /drift@lounisbou install step: npm ci failed/)
    f.failStep = false
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.steps.length, 1)
    assert.equal(stateIn(box).lastError, undefined)
  })

  it('runs when another plugin\'s update fails, and both failures are recorded', () => {
    const { box, f } = withDrift()
    f.failOn = ALPHA
    f.failStep = true
    assert.equal(deploy(box, f.host), 1)
    assert.ok(f.calls.includes(STEP))
    assert.match(stateIn(box).lastError?.message ?? '', /update of alpha@lounisbou refused.*drift@lounisbou install step: npm ci failed/)
  })

  it('does not run for a drift the installed commit does not carry', () => {
    const { box, f } = withDrift()
    f.tree = ['alpha']
    f.versions.set(DRIFT, '1.2.3')
    assert.equal(deploy(box, f.host), 0)
    assert.equal(f.calls.includes(STEP), false)
  })

  it('is not run by a rollback, which exits 0, and the next run runs it without going back again', () => {
    const { box, f, config } = withDrift()
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    rmSync(join(config, 'playwright'), { recursive: true })
    f.failStep = true
    f.calls.length = 0
    assert.equal(deploy(box, f.host, '--rollback'), 0)
    assert.equal(f.calls.includes(STEP), false)
    f.failStep = false
    assert.equal(deploy(box, f.host), 0)
    assert.ok(f.calls.includes(STEP))
    assert.deepEqual(stateIn(box).history.map(entry => entry.commit), [A])
    assert.deepEqual(stateIn(box).skipped, [B])
  })

  it('holds no lock of the deploy: a rollback made while it runs is not refused', () => {
    const { box, f } = withDrift()
    enable(box, { [DRIFT]: false })
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    enable(box, { [DRIFT]: true })
    f.versions.set(DRIFT, '1.2.3+bbbbbbb')
    let rolledBack: number | undefined
    f.during = () => { rolledBack = deploy(box, f.host, '--rollback') }
    assert.equal(deploy(box, f.host), 0)
    assert.equal(rolledBack, 0)
    assert.equal(stateIn(box).history[0]?.commit, A)
  })

  it('lets a run made while it runs deploy a new commit, which starts no second one and keeps the last failure', () => {
    const { box, f } = withDrift()
    f.failStep = true
    deploy(box, f.host)
    let meanwhile: { code: number; steps: number; state: State } | undefined
    f.during = () => {
      f.green = B
      f.calls.length = 0
      const code = deploy(box, f.host)
      meanwhile = { code, steps: f.calls.filter(call => call === STEP).length, state: stateIn(box) }
    }
    assert.equal(deploy(box, f.host), 1)
    assert.equal(meanwhile?.code, 0)
    assert.equal(meanwhile?.state.history[0]?.commit, B)
    assert.equal(meanwhile?.steps, 0)
    assert.match(meanwhile?.state.lastError?.message ?? '', /drift@lounisbou install step: npm ci failed/)
    assert.ok(box.out.includes('deploy: an install step is running'))
    assert.match(stateIn(box).lastError?.message ?? '', /drift@lounisbou install step: npm ci failed/)
  })

  it('succeeding, keeps the failure another run recorded while it ran', () => {
    const { box, f } = withDrift()
    f.during = () => { deploy(box, f.host, '--rollback') }
    assert.equal(deploy(box, f.host), 0)
    assert.match(stateIn(box).lastError?.message ?? '', /no earlier commit/)
  })

  it('takes over the step lock of a run that died', () => {
    const { box, f } = withDrift()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'install-step.lock'), '999999\n')
    f.dead.add(999999)
    assert.equal(deploy(box, f.host), 0)
    assert.ok(f.calls.includes(STEP))
  })

  it('installs into the directory that owns the plugins, whichever configuration runs the deploy', () => {
    const root = home()
    const box = { env: { CLAUDE_CONFIG_DIR: join(root, '.claude-bis') }, root: join(root, '.claude-bis', DEPLOYS_DIR, MARKETPLACE), out: [] as string[], err: [] as string[] }
    enable(box, { [DRIFT]: true })
    const f = fake()
    f.tree = ['alpha', 'drift']
    assert.equal(deploy(box, f.host), 0)
    assert.deepEqual(f.steps, [join(root, '.claude')])
  })
})

describe('the rollback', () => {
  it('points back at the commit installed before and never deploys the one it left again', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    assert.deepEqual(stateIn(box).history.map(entry => entry.commit), [B, A])
    f.calls.length = 0
    assert.equal(deploy(box, f.host, '--rollback'), 0)
    assert.deepEqual(f.calls, ['repoint a', `update ${ALPHA}`])
    const state = stateIn(box)
    assert.deepEqual(state.history.map(entry => entry.commit), [A])
    assert.deepEqual(state.skipped, [B])
    assert.deepEqual(state.plugins, { alpha: '1.2.3+aaaaaaa' })
    assert.equal(readlinkSync(join(box.root, 'current')), join(box.root, A))
    f.calls.length = 0
    deploy(box, f.host)
    assert.equal(f.calls.length, 1)
    assert.match(box.out.at(-1) ?? '', /not deployed again/)
  })

  it('refuses when nothing was installed before, or its directory is gone', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    assert.equal(deploy(box, f.host, '--rollback'), 1)
    assert.match(box.err.join('\n'), /no earlier commit/)
    const pruned = sandbox()
    mkdirSync(pruned.root, { recursive: true })
    writeFileSync(join(pruned.root, 'installed.json'), JSON.stringify(stateOf([A, B])))
    assert.equal(deploy(pruned, f.host, '--rollback'), 1)
    assert.match(pruned.err.join('\n'), /no earlier commit/)
  })
})

describe('the directories kept', () => {
  it('keeps the installed commit, the one before and any extracted within the window', () => {
    const now = Date.UTC(2026, 0, 9) + KEEP_MS
    const old = now - KEEP_MS
    const dirs = [A, B, C, 'installed.json', 'current'].map(name => ({ name, at: old }))
    assert.deepEqual(prunable(stateOf([A, B, C]), dirs, now), [C])
    assert.deepEqual(prunable(stateOf([A, B]), [{ name: C, at: old + 1 }], now), [])
  })

  it('ages a commit installed before from when the next one replaced it, not from its extraction', () => {
    const replaced = Date.UTC(2026, 0, 9)
    const dirs = [{ name: C, at: replaced - 10 * KEEP_MS }]
    assert.deepEqual(prunable(stateOf([A, B, C]), dirs, replaced + KEEP_MS - 1), [])
    assert.deepEqual(prunable(stateOf([A, B, C]), dirs, replaced + KEEP_MS), [C])
  })

  it('removes a directory outside the history once its own time is old, and keeps one a rollback just left', () => {
    const now = Date.UTC(2026, 0, 9) + KEEP_MS
    assert.deepEqual(prunable(stateOf([A, B]), [{ name: C, at: now - KEEP_MS }], now), [C])
    assert.deepEqual(prunable(stateOf([A, B, C]), [{ name: C, at: now - 1 }], now), [])
  })

  it('records a refusal that exits 1 as the last failure', () => {
    const box = sandbox()
    const f = fake()
    deploy(box, f.host)
    assert.equal(deploy(box, f.host, '--rollback'), 1)
    assert.match(stateIn(box).lastError?.message ?? '', /no earlier commit/)
  })

  it('keeps a directory extracted long ago that running sessions may still read', () => {
    const box = sandbox()
    const day = 24 * 3_600_000
    deploy(box, fake(Date.UTC(2026, 0, 1)).host)
    const old = new Date(Date.UTC(2025, 11, 1))
    utimesSync(join(box.root, A), old, old)
    const second = fake(Date.UTC(2026, 0, 25))
    second.green = B
    deploy(box, second.host)
    const third = fake(Date.UTC(2026, 0, 25) + day)
    third.green = C
    deploy(box, third.host)
    assert.equal(existsSync(join(box.root, A)), true)
  })

  it('ages a commit left by a rollback from the rollback', () => {
    const box = sandbox()
    const at = Date.UTC(2026, 0, 1)
    deploy(box, fake(at).host)
    const second = fake(at)
    second.green = B
    deploy(box, second.host)
    const old = new Date(Date.UTC(2025, 11, 1))
    utimesSync(join(box.root, B), old, old)
    const back = fake(at + KEEP_MS)
    back.green = B
    assert.equal(deploy(box, back.host, '--rollback'), 0)
    const next = fake(at + KEEP_MS + 1)
    next.green = C
    deploy(box, next.host)
    assert.equal(existsSync(join(box.root, B)), true)
  })

  it('removes an old commit directory at the next deploy', () => {
    const box = sandbox()
    const f = fake(Date.UTC(2026, 0, 1))
    deploy(box, f.host)
    f.green = B
    deploy(box, f.host)
    const old = new Date(Date.UTC(2026, 0, 1))
    utimesSync(join(box.root, A), old, old)
    const late = fake(Date.UTC(2026, 0, 1) + KEEP_MS)
    late.green = C
    deploy(box, late.host)
    assert.equal(existsSync(join(box.root, A)), false)
    assert.equal(existsSync(join(box.root, B)), true)
    assert.equal(existsSync(join(box.root, C)), true)
  })
})

describe('the status', () => {
  it('names the installed commit, when, the one before and each version, in one line', () => {
    assert.equal(statusLine(stateOf([A, B]), 'UTC'), `${MARKETPLACE} aaaaaaa installed 2026-01-10 00:00, previous bbbbbbb: alpha 1.2.3`)
    assert.match(statusLine(stateOf([A], { pending: true }), 'UTC'), /^lounisbou aaaaaaa installed 2026-01-10 00:00 \(plugin updates pending: run npm run deploy\)/)
  })

  it('prints the state file, or says nothing is deployed', () => {
    const box = sandbox()
    deploy(box, fake().host, '--status')
    assert.match(box.out.at(-1) ?? '', /^nothing deployed under /)
    deploy(box, fake().host)
    deploy(box, fake().host, '--status', '--json')
    assert.equal(JSON.parse(box.out.at(-1) ?? '').history[0].commit, A)
    deploy(box, fake().host, '--status')
    assert.match(box.out.at(-1) ?? '', /^lounisbou aaaaaaa installed /)
  })

  it('says, in one line, that the state file is unreadable', () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'installed.json'), '{"version": 2}')
    assert.equal(deploy(box, fake().host, '--status'), 1)
    assert.match(box.err.at(-1) ?? '', /^deploy: installed\.json: not version 1/)
  })

  it('refuses a state file of another shape', () => {
    const base = stateOf([A])
    assert.throws(() => parseState('{"version": 2}'), /not version 1/)
    assert.throws(() => parseState(JSON.stringify({ ...base, history: [] })), /no history/)
    assert.throws(() => parseState(JSON.stringify({ ...base, history: [{ commit: 'nope', at: '' }] })), /history entry/)
    assert.throws(() => parseState(JSON.stringify({ ...base, plugins: { alpha: 1 } })), /plugins/)
    assert.throws(() => parseState(JSON.stringify({ ...base, skipped: ['abc'] })), /skipped/)
    assert.throws(() => parseState(JSON.stringify({ ...base, repo: 1 })), /repo/)
    assert.throws(() => parseState(JSON.stringify({ ...base, marketplace: 'elsewhere' })), /marketplace/)
    assert.throws(() => parseState(JSON.stringify({ ...base, pending: 'true' })), /pending/)
  })
})
