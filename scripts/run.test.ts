// The scripts' `run` functions against real temporary repositories: the file and git paths
// the pure functions of scripts.test.ts do not reach.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, type TestContext } from 'node:test'
import { processIo, type Io } from './lib/io.ts'
import { compareVersions, isEntry, parseManifest } from './lib/plugins.ts'
import { render, run as marketplace } from './marketplace.ts'
import { run as matrix } from './plugin-matrix.ts'
import { parseCeilings, run as prompts } from './prompts.ts'
import { run as versionBump } from './version-bump.ts'
import { copyOf, MARK, run as core } from './core.ts'
import { dependenciesOf, escapingImports, run as deps, satisfies, undeclaredVariables } from './deps.ts'

interface Recorded extends Io {
  readonly lines: { out: string[]; err: string[] }
}

function recorder(env: Record<string, string> = {}): Recorded {
  const lines = { out: [] as string[], err: [] as string[] }
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line), env }
}

function manifest(name: string, version = '1.0.0'): string {
  return JSON.stringify({ name, version, description: `The ${name} plugin.`, author: { name: 'A' } })
}

/** A repository holding the given plugins, each with a manifest and one shipped file. */
function repo(plugins: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-'))
  for (const [name, version] of Object.entries(plugins)) {
    mkdirSync(join(root, 'plugins', name, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), manifest(name, version))
    writeFileSync(join(root, 'plugins', name, 'skill.md'), 'A short prompt.\n')
  }
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'm', plugins: [] }))
  mkdirSync(join(root, 'ci'))
  return root
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' })
}

describe('marketplace run', () => {
  it('rewrites a stale catalogue, then finds it current', () => {
    const root = repo({ alpha: '1.0.0' })
    const io = recorder()
    assert.equal(marketplace(root, [], io), 0)
    assert.deepEqual(io.lines.out, ['.claude-plugin/marketplace.json rewritten'])
    assert.equal(JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[0].source, './plugins/alpha')
    assert.equal(marketplace(root, ['--check'], recorder()), 0)
  })

  it('fails a check on a stale catalogue and writes nothing', () => {
    const root = repo({ alpha: '1.0.0' })
    const io = recorder()
    assert.equal(marketplace(root, ['--check'], io), 1)
    assert.match(io.lines.err[0] ?? '', /out of date/)
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins, [])
  })
})

describe('marketplace render', () => {
  it('refuses a catalogue that is not an object', () => {
    assert.throws(() => render([], []), /is not an object/)
  })
})

describe('version-bump run', () => {
  function committed(): string {
    const root = repo({ alpha: '1.0.0', beta: '2.0.0' })
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    git(root, 'checkout', '-q', '-b', 'change')
    return root
  }

  it('asks for its base', () => {
    const io = recorder()
    assert.equal(versionBump('.', [], io), 2)
    assert.deepEqual(io.lines.err, ['usage: version-bump <base-ref>'])
  })

  it('refuses a shipped change at the same version', () => {
    const root = committed()
    writeFileSync(join(root, 'plugins', 'alpha', 'skill.md'), 'Changed.\n')
    git(root, 'commit', '-q', '-am', 'change')
    const io = recorder()
    assert.equal(versionBump(root, ['main'], io), 1)
    assert.deepEqual(io.lines.err, ['alpha: ships a change at 1.0.0, not above 1.0.0'])
  })

  it('accepts the change once the version is raised, and a new plugin', () => {
    const root = committed()
    writeFileSync(join(root, 'plugins', 'alpha', 'skill.md'), 'Changed.\n')
    writeFileSync(join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), manifest('alpha', '1.1.0'))
    mkdirSync(join(root, 'plugins', 'gamma', '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'gamma', '.claude-plugin', 'plugin.json'), manifest('gamma'))
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'change')
    assert.equal(versionBump(root, ['main'], recorder()), 0)
  })
})

describe('plugin-matrix run', () => {
  it('prints the matrix and appends it to the GitHub output file', () => {
    const root = repo({ alpha: '1.0.0' })
    writeFileSync(join(root, 'ci', 'plugins.json'), JSON.stringify({ blocking: { alpha: ['macos-latest'] } }))
    const output = join(root, 'github-output')
    const io = recorder({ GITHUB_OUTPUT: output })
    assert.equal(matrix(root, [], io), 0)
    const line = '{"include":[{"plugin":"alpha","os":"ubuntu-latest","blocking":false},{"plugin":"alpha","os":"macos-latest","blocking":true}]}'
    assert.deepEqual(io.lines.out, [line])
    assert.equal(readFileSync(output, 'utf8'), `matrix=${line}\n`)
  })

  it('prints only, outside GitHub', () => {
    const root = repo({ alpha: '1.0.0' })
    writeFileSync(join(root, 'ci', 'plugins.json'), JSON.stringify({ blocking: { alpha: [] } }))
    assert.equal(matrix(root, [], recorder()), 0)
  })

  it('refuses a malformed table', () => {
    assert.throws(() => matrix(repoWithTable('[]'), [], recorder()), /expected \{ "blocking"/)
  })

  it('runs a pull request on Linux, for the plugins it changes', () => {
    const root = repo({ alpha: '1.0.0', beta: '1.0.0' })
    writeFileSync(join(root, 'ci', 'plugins.json'), JSON.stringify({ blocking: { alpha: ['ubuntu-latest', 'macos-latest'], beta: [] } }))
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    writeFileSync(join(root, 'plugins', 'alpha', 'skill.md'), 'Changed.\n')
    git(root, 'commit', '-q', '-am', 'change')
    const io = recorder()
    assert.equal(matrix(root, ['--pull-request', 'main~1'], io), 0)
    assert.deepEqual(io.lines.out, ['{"include":[{"plugin":"alpha","os":"ubuntu-latest","blocking":true}]}'])
    assert.throws(() => matrix(root, ['--pull-request'], recorder()), /needs the base ref/)
  })

  function repoWithTable(text: string): string {
    const root = repo({ alpha: '1.0.0' })
    writeFileSync(join(root, 'ci', 'plugins.json'), text)
    return root
  }
})

describe('prompts run', () => {
  const sentence = 'every agent reads its brief before it acts and never guesses the state of the branch.'

  function withPrompts(ceilings: unknown): string {
    const root = repo({ alpha: '1.0.0', beta: '1.0.0' })
    writeFileSync(join(root, 'plugins', 'alpha', 'skill.md'), `${sentence}\n`)
    mkdirSync(join(root, 'plugins', 'beta', 'docs'))
    writeFileSync(join(root, 'plugins', 'beta', 'skill.md'), `${sentence}\n`)
    writeFileSync(join(root, 'plugins', 'beta', 'docs', 'design.md'), `${sentence}\n`)
    writeFileSync(join(root, 'ci', 'prompts.json'), JSON.stringify(ceilings))
    return root
  }

  it('passes under its ceilings and names each sentence said twice', () => {
    const io = recorder()
    assert.equal(prompts(withPrompts({ budgets: { alpha: 100, beta: 100 }, duplicates: 1 }), [], io), 0)
    assert.equal(io.lines.err.length, 0)
    assert.match(io.lines.out[0] ?? '', /^said 2×: .* in plugins\/alpha\/skill\.md, plugins\/beta\/skill\.md$/)
  })

  it('fails over a ceiling and lowers nothing', () => {
    const root = withPrompts({ budgets: { alpha: 1, beta: 100 }, duplicates: 1 })
    const io = recorder()
    assert.equal(prompts(root, ['--lower'], io), 1)
    assert.match(io.lines.err[0] ?? '', /^alpha: \d+ prompt tokens, over its budget of 1$/)
    assert.equal(JSON.parse(readFileSync(join(root, 'ci', 'prompts.json'), 'utf8')).budgets.alpha, 1)
  })

  it('lowers the ceilings to the measure and keeps the authored fields', () => {
    const root = withPrompts({ $comment: 'kept', budgets: { alpha: 100, beta: 100 }, duplicates: 5 })
    assert.equal(prompts(root, ['--lower'], recorder()), 0)
    const written = JSON.parse(readFileSync(join(root, 'ci', 'prompts.json'), 'utf8'))
    assert.deepEqual(written, { $comment: 'kept', budgets: { alpha: 22, beta: 22 }, duplicates: 1 })
  })

  it('refuses malformed ceilings', () => {
    assert.throws(() => parseCeilings([]), /expected/)
    assert.throws(() => parseCeilings({ budgets: { alpha: 'many' }, duplicates: 0 }), /budget of "alpha" is not a number/)
  })
})

describe('plugins library', () => {
  it('keeps an author email, refuses an author that is not an object', () => {
    assert.deepEqual(parseManifest(JSON.parse(manifest('alpha')), 'alpha').author, { name: 'A' })
    assert.equal(parseManifest({ ...JSON.parse(manifest('alpha')), author: { name: 'A', email: 'a@example.com' } }, 'alpha').author.email, 'a@example.com')
    assert.throws(() => parseManifest({ ...JSON.parse(manifest('alpha')), author: 'A' }, 'alpha'), /"author" must be an object/)
    assert.throws(() => parseManifest('alpha', 'alpha'), /not an object/)
  })

  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions('2.0.0', '1.9.9') > 0)
    assert.ok(compareVersions('1.2.3', '1.2.4') < 0)
  })

  it('refuses to order a malformed version', () => {
    assert.throws(() => compareVersions('1.0', '1.0.0'), /MAJOR\.MINOR\.PATCH/)
  })

  it('knows the script node was started with', () => {
    const script = process.argv[1]
    assert.ok(script !== undefined && isEntry(pathToFileURL(script).href))
    assert.ok(!isEntry('file:///elsewhere.ts'))
    const argv = process.argv
    process.argv = argv.slice(0, 1)
    try {
      assert.ok(!isEntry('file:///elsewhere.ts'))
    } finally {
      process.argv = argv
    }
  })

  it('writes through the process streams', (t: TestContext) => {
    const log = t.mock.method(console, 'log', () => {})
    const error = t.mock.method(console, 'error', () => {})
    processIo.out('o')
    processIo.err('e')
    assert.deepEqual([log.mock.calls[0]?.arguments, error.mock.calls[0]?.arguments], [['o'], ['e']])
  })
})

describe('core copies', () => {
  function withCore(): string {
    const root = repo({ alpha: '1.0.0', beta: '1.0.0' })
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'core', 'src', 'a.ts'), 'export const A = 1\n')
    writeFileSync(join(root, 'packages', 'core', 'src', 'a.test.ts'), 'test\n')
    mkdirSync(join(root, 'plugins', 'alpha', 'core'))
    return root
  }

  it('copies the modules, marked, and leaves the tests out', () => {
    assert.deepEqual([...copyOf(new Map([['a.ts', 'x'], ['a.test.ts', 'y'], ['notes.md', 'z']]))], [['a.ts', `${MARK}x`]])
  })

  it('writes each contract other languages read as a marked JSON file', () => {
    const copy = copyOf(new Map(), { 'c.json': { version: 1 } })
    assert.deepEqual(JSON.parse(copy.get('c.json') ?? ''), { $comment: 'Generated from packages/core/src by `npm run core`: edit the source, never this copy.', version: 1 })
  })

  it('writes the copy into every plugin holding a core directory, then finds it current', () => {
    const root = withCore()
    const io = recorder()
    assert.equal(core(root, [], io), 0)
    assert.deepEqual(io.lines.out, ['plugins/alpha/core rewritten'])
    assert.equal(readFileSync(join(root, 'plugins', 'alpha', 'core', 'a.ts'), 'utf8'), `${MARK}export const A = 1\n`)
    assert.equal(core(root, ['--check'], recorder()), 0)
  })

  it('fails a check on a copy edited by hand', () => {
    const root = withCore()
    core(root, [], recorder())
    writeFileSync(join(root, 'plugins', 'alpha', 'core', 'a.ts'), 'edited\n')
    const io = recorder()
    assert.equal(core(root, ['--check'], io), 1)
    assert.match(io.lines.err[0] ?? '', /plugins\/alpha\/core differs/)
  })
})

describe('dependency lint', () => {
  const plain = (name: string, version: string, dependencies: unknown[] = []) =>
    JSON.stringify({ ...JSON.parse(manifest(name, version)), dependencies })

  function graphRepo(manifests: Record<string, string>): string {
    const root = repo(Object.fromEntries(Object.keys(manifests).map(name => [name, '1.0.0'])))
    for (const [name, text] of Object.entries(manifests)) writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), text)
    return root
  }

  it('reads both forms of a dependency and refuses any other', () => {
    assert.deepEqual(dependenciesOf({ dependencies: ['a@m', { name: 'b', marketplace: 'n', version: '>=1.0.0' }, { name: 'c', marketplace: 'n' }] }, 'x'), [
      { name: 'a', marketplace: 'm', range: undefined },
      { name: 'b', marketplace: 'n', range: '>=1.0.0' },
      { name: 'c', marketplace: 'n', range: undefined },
    ])
    assert.deepEqual(dependenciesOf({}, 'x'), [])
    assert.deepEqual(dependenciesOf({ dependencies: ['@'] }, 'x'), [{ name: '', marketplace: '', range: undefined }])
    assert.throws(() => dependenciesOf({ dependencies: 'a' }, 'x'), /must be a list/)
    assert.throws(() => dependenciesOf({ dependencies: [1] }, 'x'), /neither/)
  })

  it('reads a range with or without its patch, and an upper bound', () => {
    assert.equal(satisfies('0.98.0', '>=0.49'), true)
    assert.equal(satisfies('1.2.0', '>=1.0.0 <1.2.0'), false)
    assert.equal(satisfies('1.1.9', '>=1.0.0 <1.2'), true)
    assert.equal(satisfies('0.9.0', '>=1.0.0'), false)
    assert.equal(satisfies('1.0.0', '^1.0.0'), undefined)
  })

  it('passes a sound graph, and an outside dependency without a range', () => {
    const root = graphRepo({ base: plain('base', '1.2.0'), top: plain('top', '1.0.0', [{ name: 'base', marketplace: 'lounisbou', version: '>=1.0.0' }, 'tool@elsewhere']) })
    assert.equal(deps(root, [], recorder()), 0)
  })

  it('names each broken rule', () => {
    const root = graphRepo({
      a: plain('a', '1.0.0', ['b@lounisbou']),
      b: plain('b', '1.0.0', [{ name: 'a', marketplace: 'lounisbou', version: '>=2.0.0' }]),
      c: plain('c', '1.0.0', [{ name: 'ghost', marketplace: 'lounisbou', version: '>=1.0.0' }, { name: 'a', marketplace: 'lounisbou', version: '~1' }]),
    })
    const io = recorder()
    assert.equal(deps(root, [], io), 1)
    assert.deepEqual(io.lines.err, [
      'a: depends on b without a version range',
      'b: depends on a >=2.0.0, which its version 1.0.0 does not satisfy',
      'c: depends on ghost, which is not a plugin of this repository',
      'c: "~1" is not a version range (">=a.b.c" or ">=a.b.c <x.y.z")',
      'dependency cycle: a -> b -> a',
    ])
  })

  it('refuses an import that leaves its plugin, and keeps the ones inside it', () => {
    const root = repo({ alpha: '1.0.0' })
    mkdirSync(join(root, 'plugins', 'alpha', 'hooks'))
    writeFileSync(join(root, 'plugins', 'alpha', 'hooks', 'a.ts'), "import { x } from '../core/x.ts'\nimport type { Y } from '../../beta/y.ts'\nexport { z } from './z.ts'\nimport fs from 'node:fs'\n")
    assert.deepEqual(escapingImports(readFileSync(join(root, 'plugins', 'alpha', 'hooks', 'a.ts'), 'utf8'), join(root, 'plugins', 'alpha', 'hooks', 'a.ts'), join(root, 'plugins', 'alpha')), ['../../beta/y.ts'])
    const io = recorder()
    assert.equal(deps(root, [], io), 1)
    assert.deepEqual(io.lines.err, ['plugins/alpha/hooks/a.ts: imports ../../beta/y.ts, outside its plugin'])
  })
})

describe('shared environment variables', () => {
  it('lets a plugin read its own family, and another plugin only the declared names', () => {
    const source = "await $.env.get('ORCHESTRATOR_SPAWNED')\nawait $.env.get( \"ORCHESTRATOR_NEW\" )\nawait $.env.get('HOME')\nawait $.env.get('CLAUDE_GITHUB_X')"
    assert.deepEqual(undeclaredVariables(source, 'norms'), ['ORCHESTRATOR_NEW', 'CLAUDE_GITHUB_X'])
    assert.deepEqual(undeclaredVariables(source, 'orchestrator'), ['CLAUDE_GITHUB_X'])
  })
})
