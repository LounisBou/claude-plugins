import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compareVersions, parseManifest, readPlugins } from './lib/plugins.ts'
import { entryOf, render } from './marketplace.ts'
import { matrixOf, NO_SUITE, parseBlocking, parseShards, pullRequestCells, touchedPlugins } from './plugin-matrix.ts'
import { breaches, isPromptPath, loweredOutsideRelease, measure } from './prompts.ts'
import { raise, releasePlan } from './release.ts'
import { missingBumps, shippedChanges } from './version-bump.ts'

const MANIFEST = { name: 'alpha', version: '1.2.3', description: 'An alpha plugin.', author: { name: 'A', email: 'a@example.com' } }

function repoWith(manifests: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'plugins-'))
  for (const [dir, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, 'plugins', dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'plugins', dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  }
  return root
}

describe('manifests', () => {
  it('reads every plugin, sorted by directory', () => {
    const root = repoWith({ beta: { ...MANIFEST, name: 'beta' }, alpha: MANIFEST })
    assert.deepEqual(readPlugins(root).map(plugin => plugin.dir), ['alpha', 'beta'])
  })

  it('refuses a directory that does not carry the plugin name', () => {
    const root = repoWith({ other: MANIFEST })
    assert.throws(() => readPlugins(root), /must carry the plugin's name/)
  })

  it('refuses a version that is not MAJOR.MINOR.PATCH', () => {
    assert.throws(() => parseManifest({ ...MANIFEST, version: '1.2' }, 'alpha'), /MAJOR\.MINOR\.PATCH/)
  })

  it('refuses a missing description', () => {
    assert.throws(() => parseManifest({ ...MANIFEST, description: ' ' }, 'alpha'), /"description"/)
  })

  it('orders versions numerically, not as text', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })
})

describe('marketplace', () => {
  it('derives each entry from its manifest and points at its directory', () => {
    assert.deepEqual(entryOf({ dir: 'alpha', manifest: parseManifest(MANIFEST, 'alpha') }), {
      name: 'alpha', source: './plugins/alpha', description: 'An alpha plugin.', version: '1.2.3', author: { name: 'A' },
    })
  })

  it('keeps the authored fields and replaces only the list', () => {
    const text = render({ name: 'lounisbou', owner: { name: 'A' }, plugins: [{ name: 'stale' }] }, [])
    assert.deepEqual(JSON.parse(text), { name: 'lounisbou', owner: { name: 'A' }, plugins: [] })
  })
})

describe('version bump', () => {
  it('counts a shipped file and ignores tests and docs', () => {
    assert.deepEqual(
      shippedChanges(['plugins/alpha/hooks/a.ts', 'plugins/beta/tests/x.sh', 'plugins/beta/README.md', 'scripts/x.ts']),
      ['alpha'],
    )
  })

  it('reports a shipped change at an unchanged version', () => {
    assert.deepEqual(missingBumps(['alpha'], () => ({ base: '1.0.0', head: '1.0.0' })), ['alpha: ships a change at 1.0.0, not above 1.0.0'])
  })

  it('accepts a raised version and a plugin new in the change', () => {
    assert.deepEqual(missingBumps(['alpha', 'beta'], dir => (dir === 'alpha' ? { base: '1.0.0', head: '1.1.0' } : { base: null, head: '0.1.0' })), [])
  })
})

describe('plugin matrix', () => {
  it('runs every plugin on every platform and blocks only where listed', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['ubuntu-latest'] } }, ['alpha']))
    assert.deepEqual(matrix, [
      { plugin: 'alpha', os: 'ubuntu-latest', blocking: true },
      { plugin: 'alpha', os: 'macos-latest', blocking: false },
    ])
  })

  it('refuses a plugin without an entry, and an entry without a plugin', () => {
    assert.throws(() => parseBlocking({ blocking: {} }, ['alpha']), /no entry for plugin "alpha"/)
    assert.throws(() => parseBlocking({ blocking: { alpha: [], ghost: [] } }, ['alpha']), /"ghost" is not a plugin/)
  })

  it('refuses an unknown platform', () => {
    assert.throws(() => parseBlocking({ blocking: { alpha: ['windows-latest'] } }, ['alpha']), /unknown platform/)
  })

  it('tests the plugins a change touches, every one for a change outside plugins/, none for documentation', () => {
    const plugins = ['alpha', 'beta']
    assert.deepEqual(touchedPlugins(['plugins/beta/x.sh'], plugins), ['beta'])
    assert.deepEqual(touchedPlugins(['plugins/beta/x.sh', 'packages/core/src/a.ts'], plugins), plugins)
    assert.deepEqual(touchedPlugins(['docs/a.md', 'README.md', 'plugins/ghost/x'], plugins), [])
  })

  it('runs a pull request on Linux only', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['macos-latest'], beta: [] } }, ['alpha', 'beta']))
    assert.deepEqual(pullRequestCells(matrix, ['alpha']), [{ plugin: 'alpha', os: 'ubuntu-latest', blocking: false }])
  })

  it('splits a plugin into its parts on Linux alone, each part blocking as the platform does', () => {
    const blocking = parseBlocking({ blocking: { alpha: ['ubuntu-latest'], beta: [] } }, ['alpha', 'beta'])
    const shards = parseShards({ blocking: {}, shards: { alpha: 2 } }, ['alpha', 'beta'])
    assert.deepEqual(matrixOf(blocking, shards), [
      { plugin: 'alpha', os: 'ubuntu-latest', blocking: true, shard: 1 },
      { plugin: 'alpha', os: 'ubuntu-latest', blocking: true, shard: 2 },
      { plugin: 'alpha', os: 'macos-latest', blocking: false },
      { plugin: 'beta', os: 'ubuntu-latest', blocking: false },
      { plugin: 'beta', os: 'macos-latest', blocking: false },
    ])
  })

  it('runs every part of a split plugin in a pull request that touches it', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: [] } }, ['alpha']), new Map([['alpha', 3]]))
    assert.deepEqual(pullRequestCells(matrix, ['alpha']).map(cell => cell.shard), [1, 2, 3])
  })

  it('reads no part table as no split, and refuses a malformed one', () => {
    assert.equal(parseShards({ blocking: {} }, ['alpha']).size, 0)
    assert.throws(() => parseShards({ shards: [] }, ['alpha']), /must be \{ <plugin>/)
    assert.throws(() => parseShards({ shards: { ghost: 2 } }, ['alpha']), /"ghost" in "shards" is not a plugin/)
    assert.throws(() => parseShards({ shards: { alpha: 1 } }, ['alpha']), /needs two parts or more/)
    assert.throws(() => parseShards({ shards: { alpha: '2' } }, ['alpha']), /needs two parts or more/)
  })

  it('runs one cell without a suite for a pull request that touches no plugin, so that it passes', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: [] } }, ['alpha']))
    assert.deepEqual(pullRequestCells(matrix, []), [{ plugin: NO_SUITE, os: 'ubuntu-latest', blocking: true }])
  })
})

describe('release plan', () => {
  it('raises a version by its level', () => {
    assert.deepEqual([raise('1.2.3', 'patch'), raise('1.2.3', 'minor'), raise('1.2.3', 'major')], ['1.2.4', '1.3.0', '2.0.0'])
  })

  it('bumps the plugins whose shipped files changed since their release, patch unless told', () => {
    const versions = new Map([['alpha', '1.0.0'], ['beta', '1.0.0'], ['gamma', '1.0.0']])
    const changed: Record<string, string[]> = { alpha: ['plugins/alpha/skill.md'], beta: ['plugins/beta/tests/a.sh'], gamma: ['plugins/gamma/hooks/h.ts'] }
    const plan = releasePlan(versions, dir => changed[dir] ?? [], new Map([['gamma', 'minor' as const]]))
    assert.deepEqual(plan, [{ dir: 'alpha', from: '1.0.0', to: '1.0.1' }, { dir: 'gamma', from: '1.0.0', to: '1.1.0' }])
  })
})

describe('prompts', () => {
  const long = 'every agent reads its brief before it acts and never guesses the state of the branch.'

  it('counts only the files a model reads', () => {
    assert.ok(isPromptPath('skills/x/SKILL.md'))
    assert.ok(isPromptPath('commands/status.md'))
    assert.ok(!isPromptPath('README.md'))
    assert.ok(!isPromptPath('docs/design.md'))
    assert.ok(!isPromptPath('tests/fixture.md'))
    assert.ok(!isPromptPath('hooks/register.ts'))
    assert.ok(!isPromptPath('.pytest_cache/README.md'))
  })

  it('finds a sentence said in two files, and ignores short phrases', () => {
    const measured = measure([
      { plugin: 'a', path: 'a/x.md', text: `${long}\n\nStop and ask.` },
      { plugin: 'b', path: 'b/y.md', text: `**${long}**\n\nStop and ask.` },
    ])
    assert.equal(measured.duplicates.length, 1)
    assert.deepEqual(measured.duplicates[0]?.paths, ['a/x.md', 'b/y.md'])
  })

  it('sums the tokens of each plugin', () => {
    const measured = measure([
      { plugin: 'a', path: 'a/x.md', text: 'abcd' },
      { plugin: 'a', path: 'a/y.md', text: 'abcdefgh' },
    ])
    assert.equal(measured.tokens['a'], 3)
  })

  it('refuses a budget exceeded, a plugin without one and more duplicates than the ceiling', () => {
    const measured = { tokens: { a: 10, b: 1 }, duplicates: [{ sentence: 's', paths: ['x', 'y'] }] }
    assert.deepEqual(breaches(measured, { budgets: { a: 9 }, duplicates: 0 }), [
      'a: 10 prompt tokens, over its budget of 9',
      'b: no prompt budget in ci/prompts.json',
      '1 sentences said more than once, over the ceiling of 0',
    ])
    assert.deepEqual(breaches(measured, { budgets: { a: 10, b: 1 }, duplicates: 1 }), [])
  })

  it('refuses a budget or the duplicate ceiling lowered below its base, unless the change is a release', () => {
    const base = { budgets: { a: 10, b: 5 }, duplicates: 4 }
    assert.deepEqual(loweredOutsideRelease({ budgets: { a: 9, b: 5 }, duplicates: 3 }, base, false), [
      'a: budget lowered from 10 to 9, which only the release does',
      'duplicates: ceiling lowered from 4 to 3, which only the release does',
    ])
    assert.deepEqual(loweredOutsideRelease({ budgets: { a: 9, b: 4 }, duplicates: 3 }, base, true), [])
    assert.deepEqual(loweredOutsideRelease({ budgets: { a: 10, b: 5, c: 1 }, duplicates: 4 }, base, false), [])
  })
})
