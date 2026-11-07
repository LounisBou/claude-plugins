import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compareVersions, parseManifest, readPlugins } from './lib/plugins.ts'
import { entryOf, render } from './marketplace.ts'
import { matrixOf, parseBlocking } from './plugin-matrix.ts'
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
})
