import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEPLOYS_DIR, greenCommit, isNew, KEEP_MS, MARKETPLACE, parseState, prunable, run, stamped, stampTree, statusLine, versionsIn, type Host, type State } from './deploy.ts'

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

/** Writes the tree of a repository at a commit: the catalogue and one plugin. */
function treeAt(into: string, version = '1.2.3', name = MARKETPLACE): void {
  mkdirSync(join(into, '.claude-plugin'), { recursive: true })
  writeFileSync(join(into, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name, plugins: [] }))
  mkdirSync(join(into, 'plugins', 'alpha', '.claude-plugin'), { recursive: true })
  writeFileSync(join(into, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', nested: { version: '9.9.9' }, version }))
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
}

/** A host that installs as the real one does: an update takes the version of the directory pointed at. */
function fake(now = Date.UTC(2026, 0, 20)): Fake {
  let pointed = ''
  let version = '1.2.3'
  const self: Fake = {
    calls: [],
    green: A,
    failUpdate: false,
    idleUpdate: false,
    host: {
      api: path => {
        self.calls.push(`api ${path}`)
        return runsOf({ sha: self.green })
      },
      extract: (repo, commit, into) => {
        self.calls.push(`extract ${repo} ${commit.slice(0, 1)}`)
        treeAt(into)
      },
      repoint: dir => {
        pointed = dir
        self.calls.push(`repoint ${dir.slice(-1)}`)
      },
      installed: () => [{ id: ALPHA, version }, { id: 'other@elsewhere', version: '0.0.1' }],
      update: id => {
        if (self.failUpdate) throw new Error('update refused')
        self.calls.push(`update ${id}`)
        if (!self.idleUpdate) version = versionsIn(pointed)['alpha'] ?? ''
      },
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
    const now = Date.UTC(2026, 0, 10)
    const old = now - KEEP_MS
    const dirs = [A, B, C, 'installed.json', 'current'].map(name => ({ name, at: old }))
    assert.deepEqual(prunable(stateOf([A, B, C]), dirs, now), [C])
    assert.deepEqual(prunable(stateOf([A, B, C]), [{ name: C, at: old + 1 }], now), [])
  })

  it('removes an old commit directory at the next deploy', () => {
    const box = sandbox()
    const f = fake()
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
