import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compareVersions, parseManifest, readPlugins } from './lib/plugins.ts'
import { entryOf, render } from './marketplace.ts'
import { isRelease, mainCells, mainTouched, matrixOf, nightlyCells, NO_SUITE, parseBlocking, parseShards, pullRequestCells, run as runMatrix, touchedPlugins } from './plugin-matrix.ts'
import { breaches, grown, isPromptPath, loweredOutsideRelease, measure } from './prompts.ts'
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

  it('runs a change of core on the plugins that carry a copy of it, and no other', () => {
    const plugins = ['alpha', 'beta', 'gamma']
    assert.deepEqual(touchedPlugins(['packages/core/src/a.ts'], plugins, ['alpha', 'gamma']), ['alpha', 'gamma'])
    assert.deepEqual(touchedPlugins(['packages/core/src/a.ts', 'plugins/beta/x.sh'], plugins, ['alpha']), ['alpha', 'beta'])
  })

  it('runs no suite for a change of the repository tooling, its CI or its package files', () => {
    const paths = ['scripts/plugin-matrix.ts', 'ci/plugins.json', '.github/workflows/ci.yml', 'package.json', 'package-lock.json']
    for (const path of paths) assert.deepEqual(touchedPlugins([path], ['alpha', 'beta'], ['alpha']), [], path)
  })

  it('runs no suite for a plugin README, and the plugin for any other file of it', () => {
    assert.deepEqual(touchedPlugins(['plugins/alpha/README.md'], ['alpha', 'beta']), [])
    assert.deepEqual(touchedPlugins(['plugins/alpha/README.md', 'plugins/alpha/skill.md'], ['alpha', 'beta']), ['alpha'])
    assert.deepEqual(touchedPlugins(['plugins/alpha/docs/README.md'], ['alpha', 'beta']), ['alpha'])
  })

  it('runs every plugin for a file no rule above names', () => {
    assert.deepEqual(touchedPlugins(['evals/outcome/a.json'], ['alpha', 'beta'], ['alpha']), ['alpha', 'beta'])
  })

  it('takes a pull request that changes a plugin manifest for the release', () => {
    assert.equal(isRelease(['plugins/alpha/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']), true)
    assert.equal(isRelease(['plugins/alpha/skill.md', 'ci/prompts.json', '.claude-plugin/marketplace.json']), false)
  })

  it('runs the release on every plugin and both platforms, where a pull request runs Linux alone', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['ubuntu-latest'], beta: ['macos-latest'] } }, ['alpha', 'beta']))
    assert.deepEqual(pullRequestCells(matrix, [], true), matrix)
    assert.deepEqual(pullRequestCells(matrix, ['alpha'], true), matrix)
  })

  it('runs every plugin on Linux for a push to main, and on macOS for the night', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['ubuntu-latest'], beta: ['macos-latest'] } }, ['alpha', 'beta']), new Map([['alpha', 2]]))
    assert.deepEqual(mainCells(matrix).map(cell => `${cell.plugin} ${cell.os} ${cell.shard ?? ''}`), ['alpha ubuntu-latest 1', 'alpha ubuntu-latest 2', 'beta ubuntu-latest '])
    assert.deepEqual(nightlyCells(matrix).map(cell => `${cell.plugin} ${cell.os} ${cell.blocking}`), ['alpha macos-latest false', 'beta macos-latest true'])
  })

  it('leaves a release-only plugin out of a pull request unless the pull request changes it', () => {
    const plugins = ['alpha', 'drift']
    const only = ['drift']
    assert.deepEqual(touchedPlugins(['packages/core/src/a.ts'], plugins, plugins, only), ['alpha'])
    assert.deepEqual(touchedPlugins(['evals/outcome/a.json'], plugins, plugins, only), ['alpha'])
    assert.deepEqual(touchedPlugins(['plugins/drift/x.sh'], plugins, plugins, only), ['drift'])
    assert.deepEqual(touchedPlugins(['plugins/drift/x.sh', 'evals/outcome/a.json'], plugins, plugins, only), ['alpha', 'drift'])
  })

  it('leaves a release-only plugin out of a push to main, and keeps it in the night', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['ubuntu-latest'], drift: ['ubuntu-latest'] } }, ['alpha', 'drift']))
    assert.deepEqual(mainCells(matrix, ['drift']).map(cell => cell.plugin), ['alpha'])
    assert.deepEqual(nightlyCells(matrix).map(cell => cell.plugin), ['alpha', 'drift'])
  })

  it('runs one cell without a suite for a pull request that touches no plugin, so that it passes', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: [] } }, ['alpha']))
    assert.deepEqual(pullRequestCells(matrix, []), [{ plugin: NO_SUITE, os: 'ubuntu-latest', blocking: true }])
  })

  it('runs on a push to main the plugins the merge touches, every plugin for core or ci/, none for documentation', () => {
    const plugins = ['alpha', 'beta', 'gamma']
    assert.deepEqual(mainTouched(['plugins/beta/x.sh'], plugins), ['beta'])
    assert.deepEqual(mainTouched(['plugins/beta/x.sh', 'plugins/alpha/y.sh', 'docs/a.md'], plugins), ['alpha', 'beta'])
    assert.deepEqual(mainTouched(['packages/core/src/a.ts'], plugins), plugins)
    assert.deepEqual(mainTouched(['plugins/beta/x.sh', 'ci/plugins.json'], plugins), plugins)
    assert.deepEqual(mainTouched(['docs/a.md', 'scripts/plugin-matrix.ts', '.github/workflows/ci.yml'], plugins), [])
  })

  it('cuts a push to main to the touched plugins, to the cell without a suite when none is left', () => {
    const matrix = matrixOf(parseBlocking({ blocking: { alpha: ['ubuntu-latest'], beta: [], drift: [] } }, ['alpha', 'beta', 'drift']), new Map([['alpha', 2]]))
    const keys = (touched: readonly string[]): string[] => mainCells(matrix, ['drift'], touched).map(cell => `${cell.plugin} ${cell.os} ${cell.shard ?? ''}`)
    assert.deepEqual(keys(['alpha']), ['alpha ubuntu-latest 1', 'alpha ubuntu-latest 2'])
    assert.deepEqual(keys(['beta']), ['beta ubuntu-latest '])
    assert.deepEqual(keys([]), [`${NO_SUITE} ubuntu-latest `])
    assert.deepEqual(keys(['drift']), [`${NO_SUITE} ubuntu-latest `])
  })
})

describe('plugin matrix of a push to main', () => {
  const git = (root: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.excludesFile=/dev/null', ...args], { cwd: root, stdio: 'ignore' })
  }
  const write = (root: string, path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  /** A repository of three plugins (two carry core) whose main holds a merge of a branch that changes `paths`. */
  function mergeOf(paths: readonly string[]): string {
    const root = repoWith({ alpha: MANIFEST, beta: { ...MANIFEST, name: 'beta' }, gamma: { ...MANIFEST, name: 'gamma' } })
    write(root, 'ci/plugins.json', JSON.stringify({ blocking: { alpha: ['ubuntu-latest'], beta: ['ubuntu-latest'], gamma: ['ubuntu-latest'] } }))
    write(root, 'plugins/alpha/core/a.ts', 'a')
    write(root, 'plugins/beta/core/a.ts', 'a')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    git(root, 'checkout', '-q', '-b', 'topic')
    for (const path of paths) write(root, path, 'changed')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'topic')
    git(root, 'checkout', '-q', 'main')
    write(root, 'unrelated.txt', 'main moved')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'main moved')
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'topic')
    return root
  }

  function cellsOf(root: string, mode: string, env: Record<string, string> = {}): string[] {
    const lines: string[] = []
    assert.equal(runMatrix(root, [mode], { out: line => lines.push(line), err: () => undefined, env }), 0)
    const parsed: { include: { plugin: string, os: string }[] } = JSON.parse(lines[0] ?? '{}')
    return parsed.include.map(cell => `${cell.plugin} ${cell.os}`)
  }

  it('runs one plugin when the merge touches only it, whatever else main carried before', () => {
    assert.deepEqual(cellsOf(mergeOf(['plugins/gamma/x.sh']), '--main'), ['gamma ubuntu-latest'])
  })

  it('runs every plugin when the merge touches core', () => {
    assert.deepEqual(cellsOf(mergeOf(['packages/core/src/a.ts']), '--main'), ['alpha ubuntu-latest', 'beta ubuntu-latest', 'gamma ubuntu-latest'])
  })

  it('runs every plugin when the merge touches ci/', () => {
    assert.deepEqual(cellsOf(mergeOf(['ci/prompts.json']), '--main'), ['alpha ubuntu-latest', 'beta ubuntu-latest', 'gamma ubuntu-latest'])
  })

  it('runs the cell without a suite when the merge touches documentation only', () => {
    assert.deepEqual(cellsOf(mergeOf(['docs/a.md']), '--main'), [`${NO_SUITE} ubuntu-latest`])
  })

  it('runs every plugin when the merge cannot be read, and says so', () => {
    const root = repoWith({ alpha: MANIFEST })
    write(root, 'ci/plugins.json', JSON.stringify({ blocking: { alpha: ['ubuntu-latest'] } }))
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'first')
    const errors: string[] = []
    const lines: string[] = []
    assert.equal(runMatrix(root, ['--main'], { out: line => lines.push(line), err: line => errors.push(line), env: {} }), 0)
    assert.match(lines[0] ?? '', /"plugin":"alpha"/)
    assert.match(errors.join('\n'), /every plugin/)
  })

  it('leaves out of a push to main the touched cells a pull request already passed, down to the cell without a suite', () => {
    const root = mergeOf(['plugins/gamma/x.sh', 'plugins/beta/x.sh'])
    assert.deepEqual(cellsOf(root, '--main', { TESTED_CELLS: JSON.stringify(['gamma|ubuntu-latest|']) }), ['beta ubuntu-latest'])
    assert.deepEqual(cellsOf(root, '--main', { TESTED_CELLS: JSON.stringify(['gamma|ubuntu-latest|', 'beta|ubuntu-latest|']) }), [`${NO_SUITE} ubuntu-latest`])
  })

  it('keeps the whole macOS matrix for the night, whatever the last merge touched', () => {
    assert.deepEqual(cellsOf(mergeOf(['plugins/gamma/x.sh']), '--nightly'), ['alpha macos-latest', 'beta macos-latest', 'gamma macos-latest'])
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

  it('refuses a plugin whose prompt tokens rose against its base, and lets a fall, an equal and a new plugin pass', () => {
    assert.deepEqual(grown({ a: 11, b: 5, c: 3, d: 9 }, { a: 10, b: 5, c: 4 }), ['a: prompt tokens rose from 10 to 11 against the base, and a pull request raises none'])
    assert.deepEqual(grown({ a: 10, b: 4 }, { a: 10, b: 5 }), [])
  })
})
