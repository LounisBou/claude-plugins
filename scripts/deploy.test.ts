import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEPLOYS_DIR, greenCommit, isNew, KEEP_MS, MARKETPLACE, parseState, prunable, run, stamped, stampTree, statusLine, type Host, type State } from './deploy.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function runsOf(...runs: { sha: string; event?: string; conclusion?: string }[]): unknown {
  return { workflow_runs: runs.map(run => ({ head_sha: run.sha, event: run.event ?? 'push', conclusion: run.conclusion ?? 'success' })) }
}

function stateOf(history: string[], extra: Partial<State> = {}): State {
  return { version: 1, repo: 'acme/app', marketplace: MARKETPLACE, history: history.map((commit, at) => ({ commit, at: new Date(Date.UTC(2026, 0, 10 - at)).toISOString() })), skipped: [], pending: false, plugins: { alpha: '1.2.3' }, ...extra }
}

/** Writes the tree of a repository at a commit: the catalogue and one plugin. */
function treeAt(into: string, version = '1.2.3', name = MARKETPLACE): void {
  mkdirSync(join(into, '.claude-plugin'), { recursive: true })
  writeFileSync(join(into, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name, plugins: [] }))
  mkdirSync(join(into, 'plugins', 'alpha', '.claude-plugin'), { recursive: true })
  writeFileSync(join(into, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), `{\n  "name": "alpha",\n  "version": "${version}"\n}\n`)
  mkdirSync(join(into, 'plugins', 'notes'), { recursive: true })
}

interface Fake {
  readonly host: Host
  readonly calls: string[]
  green: string
  failUpdate: boolean
}

function fake(now = Date.UTC(2026, 0, 20)): Fake {
  const self: Fake = {
    calls: [],
    green: A,
    failUpdate: false,
    host: {
      api: path => {
        self.calls.push(`api ${path}`)
        return runsOf({ sha: self.green })
      },
      extract: (repo, commit, into) => {
        self.calls.push(`extract ${repo} ${commit.slice(0, 1)}`)
        treeAt(into)
      },
      repoint: dir => void self.calls.push(`repoint ${dir.slice(-1)}`),
      installed: () => [`alpha@${MARKETPLACE}`, 'other@elsewhere'],
      update: id => {
        if (self.failUpdate) throw new Error('update refused')
        self.calls.push(`update ${id}`)
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

  it('counts a push run only', () => {
    assert.equal(greenCommit(runsOf({ sha: A, event: 'schedule' }, { sha: B })), B)
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

  it('rewrites every manifest of the tree and nothing else in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-'))
    treeAt(root)
    assert.deepEqual(stampTree(root, B), { alpha: '1.2.3+bbbbbbb' })
    assert.equal(readFileSync(join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), 'utf8'), '{\n  "name": "alpha",\n  "version": "1.2.3+bbbbbbb"\n}\n')
  })
})

describe('the deploy', () => {
  it('extracts the green commit once, stamps it, points the marketplace at it and updates its plugins', () => {
    const box = sandbox()
    const { host, calls } = fake()
    assert.equal(deploy(box, host), 0)
    assert.match(calls[0] ?? '', /^api repos\/acme\/app\/actions\/workflows\/ci\.yml\/runs\?branch=main&status=success/)
    assert.deepEqual(calls.slice(1), ['extract acme/app a', 'repoint a', `update alpha@${MARKETPLACE}`])
    assert.equal(JSON.parse(readFileSync(join(box.root, A, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.2.3+aaaaaaa')
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

  it('refuses a tree whose catalogue is another marketplace', () => {
    const box = sandbox()
    const f = fake()
    const host: Host = { ...f.host, extract: (_repo, _commit, into) => treeAt(into, '1.0.0', 'elsewhere') }
    assert.equal(deploy(box, host), 1)
    assert.match(box.err.join('\n'), /not named lounisbou/)
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
    assert.deepEqual(f.calls.slice(1), ['repoint a', `update alpha@${MARKETPLACE}`])
    assert.equal(stateIn(box).pending, false)
  })

  it('refuses to run beside another deploy', () => {
    const box = sandbox()
    mkdirSync(box.root, { recursive: true })
    writeFileSync(join(box.root, 'installed.json.lock'), `${process.pid}\n`)
    assert.equal(deploy(box, fake().host), 1)
    assert.match(box.err.join('\n'), /stayed locked/)
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
    assert.deepEqual(f.calls, ['repoint a', `update alpha@${MARKETPLACE}`])
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

  it('refuses when nothing was installed before', () => {
    const box = sandbox()
    deploy(box, fake().host)
    assert.equal(deploy(box, fake().host, '--rollback'), 1)
    assert.match(box.err.join('\n'), /no earlier commit/)
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
    const late = fake(Date.now() + KEEP_MS)
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
    deploy(box, { ...fake().host, update: () => {} }, '--status')
    assert.match(box.out.at(-1) ?? '', /^nothing deployed under /)
    deploy(box, fake().host)
    deploy(box, fake().host, '--status', '--json')
    assert.equal(JSON.parse(box.out.at(-1) ?? '').history[0].commit, A)
    deploy(box, fake().host, '--status')
    assert.match(box.out.at(-1) ?? '', /^lounisbou aaaaaaa installed /)
  })

  it('refuses a state file of another shape', () => {
    assert.throws(() => parseState('{"version": 2}'), /not version 1/)
    assert.throws(() => parseState(JSON.stringify({ ...stateOf([A]), history: [] })), /no history/)
    assert.throws(() => parseState(JSON.stringify({ ...stateOf([A]), history: [{ commit: 'nope', at: '' }] })), /history entry/)
    assert.throws(() => parseState(JSON.stringify({ ...stateOf([A]), plugins: { alpha: 1 } })), /plugins/)
    assert.throws(() => parseState(JSON.stringify({ ...stateOf([A]), skipped: [1] })), /skipped/)
    assert.throws(() => parseState(JSON.stringify({ ...stateOf([A]), repo: 1 })), /repo/)
  })
})
