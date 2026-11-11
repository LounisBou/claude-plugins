import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_HASH_PATTERN, DriftError } from './compare.ts'
import { configPathOf, parseArgs, parseConfig, parseShots, parseShotsArgs, scratchpadOf, slugOf } from './config.ts'

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

test('the shots command line: the build\'s defaults, a threshold between 0 and 1', () => {
  assert.deepEqual(parseShotsArgs(['shots']), { repo: '.', base: 'origin/main', head: 'HEAD', config: undefined, out: undefined, threshold: 0 })
  assert.deepEqual(parseShotsArgs(['shots', '--repo', 'r', '--base', 'b', '--head', 'h', '--config', 'c', '--out', 'o', '--threshold', '0.2']),
    { repo: 'r', base: 'b', head: 'h', config: 'c', out: 'o', threshold: 0.2 })
  for (const bad of ['1.5', '-1', 'x', '']) assert.throws(() => parseShotsArgs(['shots', '--threshold', bad]), refused(/--threshold (needs a value|must be a number between 0 and 1)/))
  assert.throws(() => parseShotsArgs(['shots', '--nope', 'x']), refused(/unknown option --nope/))
  assert.throws(() => parseShotsArgs(['build']), refused(/^usage/))
})

const SHOTS = { server: ['npm', 'run', 'dev'], port: 5179, routes: ['/', '/sites/12?tab=1'] }

test('a shots config: its server, port and routes, every default, the fixtures read beside the config', () => {
  assert.deepEqual(parseShots({ install: ['npm', 'ci'], env: { A: '1' }, shots: SHOTS }, '/cfg/c.json'), {
    install: ['npm', 'ci'],
    env: { A: '1' },
    server: ['npm', 'run', 'dev'],
    port: 5179,
    url: 'http://localhost:5179',
    startTimeoutMs: 120_000,
    timeoutMs: 30_000,
    routes: [{ path: '/', name: 'root' }, { path: '/sites/12?tab=1', name: 'sites-12-tab-1' }],
    viewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }],
    fixtures: undefined,
    api: [],
    allow: [],
    ignore: [],
    now: '2026-01-01T09:00:00.000Z',
    fullPage: true,
  })
  const full = parseShots({ shots: {
    ...SHOTS, url: 'http://127.0.0.1:5179/app/', startTimeout: 5, timeout: 9, viewports: [800, { width: 320, height: 600 }],
    routes: [{ path: '/login', waitFor: 'form' }], fixtures: 'fx', api: ['api.drift.test'], allow: ['cdn.example.com'],
    ignore: [{ selector: '.clock' }, { route: '/login', box: [0, 0, 10, 20] }], now: '2025-05-05T05:05:05Z', fullPage: false,
  } }, '/cfg/c.json')
  assert.deepEqual(full.routes, [{ path: '/login', name: 'login', waitFor: 'form' }])
  assert.deepEqual(full.viewports, [{ width: 800, height: 900 }, { width: 320, height: 600 }])
  assert.equal(full.url, 'http://127.0.0.1:5179/app')
  assert.equal(full.fixtures, '/cfg/fx')
  assert.deepEqual([full.startTimeoutMs, full.timeoutMs, full.now, full.fullPage], [5000, 9000, '2025-05-05T05:05:05.000Z', false])
  assert.deepEqual(full.ignore, [{ selector: '.clock' }, { route: '/login', box: [0, 0, 10, 20] }])
  assert.deepEqual(parseShots({ shots: { ...SHOTS, fixtures: '/abs/fx' } }, '/cfg/c.json').fixtures, '/abs/fx')
})

test('a shots config that cannot be run is refused with the field named', () => {
  const bad = (shots: unknown, pattern: RegExp): void => assert.throws(() => parseShots({ shots }, 'c.json'), refused(pattern))
  assert.throws(() => parseShots({}, 'c.json'), refused(/^c\.json: "shots" must be an object/))
  bad({ ...SHOTS, server: 'npm run dev' }, /"shots\.server" must be a non-empty list of strings/)
  bad({ ...SHOTS, port: 0 }, /"shots\.port" must be a port number/)
  bad({ ...SHOTS, port: 70000 }, /"shots\.port"/)
  bad({ ...SHOTS, routes: [] }, /"shots\.routes" must be a non-empty list of paths/)
  bad({ ...SHOTS, routes: ['login'] }, /"shots\.routes"/)
  bad({ ...SHOTS, routes: [{ path: '/a', waitFor: 3 }] }, /"shots\.routes"/)
  bad({ ...SHOTS, routes: ['/a-b', '/a/b'] }, /two routes named a-b/)
  bad({ ...SHOTS, viewports: [0] }, /"shots\.viewports"/)
  bad({ ...SHOTS, viewports: [{ width: 300 }] }, /"shots\.viewports"/)
  bad({ ...SHOTS, viewports: [300, { width: 300, height: 500 }] }, /two viewports of the same width/)
  bad({ ...SHOTS, url: 'ftp://x' }, /"shots\.url" must be an http\(s\) URL/)
  bad({ ...SHOTS, url: 'not a url' }, /"shots\.url"/)
  bad({ ...SHOTS, url: 'https://staging.example.com:5179' }, /"shots\.url" must be a URL of this machine \(localhost, 127\.0\.0\.1, \[::1\]\)/)
  bad({ ...SHOTS, url: 'http://10.0.0.2:5179' }, /"shots\.url" must be a URL of this machine/)
  bad({ ...SHOTS, url: 'http://localhost:5180' }, /"shots\.url" must be a URL on "shots\.port" \(5179\), not 5180/)
  bad({ ...SHOTS, url: 'http://localhost' }, /"shots\.url" must be a URL on "shots\.port" \(5179\), not 80/)
  assert.equal(parseShots({ shots: { ...SHOTS, url: 'http://[::1]:5179/' } }, 'c.json').url, 'http://[::1]:5179')
  assert.equal(parseShots({ shots: { ...SHOTS, port: 443, url: 'https://localhost' } }, 'c.json').url, 'https://localhost')
  bad({ ...SHOTS, fixtures: 3 }, /"shots\.fixtures" must be a directory path/)
  bad({ ...SHOTS, api: ['https://api.x'] }, /"shots\.api" must be a list of host names/)
  bad({ ...SHOTS, allow: 'x' }, /"shots\.allow"/)
  bad({ ...SHOTS, ignore: [{}] }, /"shots\.ignore"/)
  bad({ ...SHOTS, ignore: [{ box: [1, 2, 3] }] }, /"shots\.ignore"/)
  bad({ ...SHOTS, ignore: [{ selector: '.a', route: 'a' }] }, /"shots\.ignore"/)
  bad({ ...SHOTS, now: 'yesterday' }, /"shots\.now" must be a date/)
  bad({ ...SHOTS, timeout: -1 }, /"shots\.timeout" must be a positive number of seconds/)
  bad({ ...SHOTS, startTimeout: 'x' }, /"shots\.startTimeout"/)
  bad({ ...SHOTS, fullPage: 'yes' }, /"shots\.fullPage" must be true or false/)
  assert.throws(() => parseShots({ install: 'npm ci', shots: SHOTS }, 'c.json'), refused(/"install"/))
  assert.throws(() => parseShots({ env: [], shots: SHOTS }, 'c.json'), refused(/"env"/))
})
