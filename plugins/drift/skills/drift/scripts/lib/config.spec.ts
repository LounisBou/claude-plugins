import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_HASH_PATTERN, DriftError } from './compare.ts'
import { configPathOf, parseArgs, parseConfig, scratchpadOf, slugOf } from './config.ts'

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof DriftError && pattern.test(error.message)

test('a config names its commands as argument lists, its output directory and an optional hash pattern', () => {
  assert.deepEqual(parseConfig({ install: ['npm', 'ci'], build: ['npm', 'run', 'build'], outDir: 'dist' }, 'c.json'),
    { install: ['npm', 'ci'], build: ['npm', 'run', 'build'], outDir: 'dist', hashPattern: DEFAULT_HASH_PATTERN })
  assert.deepEqual(parseConfig({ build: ['make'], outDir: 'out/web/', hashPattern: '\\.[0-9a-f]{20}', shots: {} }, 'c.json'),
    { install: undefined, build: ['make'], outDir: 'out/web', hashPattern: '\\.[0-9a-f]{20}' })
})

test('a config may set environment variables for its install and build', () => {
  assert.deepEqual(parseConfig({ build: ['make'], outDir: 'out', env: { RELEASE: 'r1', EMPTY: '' } }, 'c.json').env, { RELEASE: 'r1', EMPTY: '' })
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', env: ['A=1'] }, 'c.json'), refused(/"env" must be an object of strings/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', env: { A: 1 } }, 'c.json'), refused(/"env"/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', env: { 'A=B': 'x' } }, 'c.json'), refused(/"env"/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', env: null }, 'c.json'), refused(/"env"/))
})

test('a config that cannot be run is refused with the file named', () => {
  assert.throws(() => parseConfig([], 'c.json'), refused(/^c\.json: expected an object/))
  assert.throws(() => parseConfig({ build: 'npm run build', outDir: 'dist' }, 'c.json'), refused(/"build" must be a non-empty list of strings/))
  assert.throws(() => parseConfig({ build: [], outDir: 'dist' }, 'c.json'), refused(/"build"/))
  assert.throws(() => parseConfig({ build: ['x'], install: [1], outDir: 'dist' }, 'c.json'), refused(/"install"/))
  assert.throws(() => parseConfig({ build: ['x'] }, 'c.json'), refused(/"outDir" must be a relative path inside the repository/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: '/abs' }, 'c.json'), refused(/"outDir"/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: '../up' }, 'c.json'), refused(/"outDir"/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: '.' }, 'c.json'), refused(/"outDir"/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', hashPattern: '(' }, 'c.json'), refused(/"hashPattern" is not a regular expression/))
  assert.throws(() => parseConfig({ build: ['x'], outDir: 'd', hashPattern: 3 }, 'c.json'), refused(/"hashPattern"/))
})

test('the owner and repository are read from every shape of origin URL', () => {
  assert.equal(slugOf('git@github.com:geonativefr/front-office.git'), 'geonativefr-front-office')
  assert.equal(slugOf('https://github.com/LounisBou/claude-plugins'), 'LounisBou-claude-plugins')
  assert.equal(slugOf('ssh://git@host:22/team/app.git/'), 'team-app')
  assert.equal(slugOf('/local/path/repo'), 'path-repo')
  assert.equal(slugOf('nothing'), undefined)
})

test('the default config lives under the home, by owner and repository', () => {
  assert.equal(configPathOf('/home/me', 'acme-web'), '/home/me/.claude/drift/acme-web.json')
})

test('the default config follows CLAUDE_CONFIG_DIR when it is set', () => {
  assert.equal(configPathOf('/home/me', 'acme-web', { CLAUDE_CONFIG_DIR: '/etc/claude' }), '/etc/claude/drift/acme-web.json')
  assert.equal(configPathOf('/home/me', 'acme-web', { CLAUDE_CONFIG_DIR: '' }), '/home/me/.claude/drift/acme-web.json')
})

test('the command line: defaults, every flag, and what is refused', () => {
  assert.deepEqual(parseArgs(['build']), { repo: '.', base: 'origin/main', head: 'HEAD', config: undefined, out: undefined })
  assert.deepEqual(parseArgs(['build', '--repo', 'r', '--base', 'b', '--head', 'h', '--config', 'c', '--out', 'o']), { repo: 'r', base: 'b', head: 'h', config: 'c', out: 'o' })
  assert.throws(() => parseArgs([]), refused(/^usage: drift build/))
  assert.throws(() => parseArgs(['shots']), refused(/^usage/))
  assert.throws(() => parseArgs(['build', '--base']), refused(/--base needs a value/))
  assert.throws(() => parseArgs(['build', '--nope', 'x']), refused(/unknown option --nope/))
  assert.throws(() => parseArgs(['build', '--head', '-x']), refused(/--head needs a value/))
})

test('the scratchpad is found by session id under the host temp directory, else nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-pad-'))
  try {
    mkdirSync(join(root, '-some-project', 'sess-1', 'scratchpad'), { recursive: true })
    assert.equal(scratchpadOf({ CLAUDE_CODE_SESSION_ID: 'sess-1' }, root), join(root, '-some-project', 'sess-1', 'scratchpad'))
    assert.equal(scratchpadOf({ CLAUDE_CODE_SESSION_ID: 'sess-2' }, root), undefined)
    assert.equal(scratchpadOf({ CLAUDE_CODE_SESSION_ID: '../x' }, root), undefined)
    assert.equal(scratchpadOf({}, root), undefined)
    assert.equal(scratchpadOf({ CLAUDE_CODE_SESSION_ID: 'sess-1' }, join(root, 'missing')), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
