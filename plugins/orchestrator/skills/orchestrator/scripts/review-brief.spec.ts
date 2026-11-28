import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main, parseArgs, placeholdersOf, TEMPLATE, USAGE } from './review-brief.ts'
import { parseLensDescription } from '../../../core/lens.ts'
import { isRound, readingOf } from '../../../hooks/review-reading.ts'

let dir = ''
const savedMap = process.env['ORCHESTRATOR_MODELS_MAP']
test.beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-brief-')))
  // The operator's own tier map never reaches a test: a map of its own, bound by each test that needs one.
  process.env['ORCHESTRATOR_MODELS_MAP'] = join(dir, 'models.json')
})
test.afterEach(() => {
  if (savedMap === undefined) delete process.env['ORCHESTRATOR_MODELS_MAP']
  else process.env['ORCHESTRATOR_MODELS_MAP'] = savedMap
  rmSync(dir, { recursive: true, force: true })
})

const FIELDS = (): string[] => [
  '--out', join(dir, 'review-12.md'), '--repo', 'acme/app', '--pr', '12', '--title', 'a fix of the thing (row 9 THING)',
  '--spec', '/b/thing-brief.md', '--index', '/b/review-12-report.md', '--delivery-report', '/b/thing-report.md', '--branch', 'fix/thing', '--head', '0123456789abcdef0123456789abcdef01234567',
  '--worktree', '/w/review-12', '--orchestrator', 'Orch: acme [a1b2c3]', '--reason', 'it is one small hook fix',
]

function run(args: string[], template?: string): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  const code = main(args, { out: t => { out += t }, err: t => { err += t } }, template)
  return { code, out, err }
}

test('every field of the real template is filled: no placeholder is left, and the output names the file in one line', () => {
  const done = run(FIELDS())
  assert.equal(done.code, 0, done.err)
  assert.equal(done.out, `review brief: ${join(dir, 'review-12.md')}\n`)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.deepEqual(placeholdersOf(text), [])
  assert.match(text, /^# app — review: a fix of the thing \(row 9 THING\)\n/)
  assert.match(text, /1\. Spec: `\/b\/thing-brief\.md`/)
  assert.match(text, /pull request 12 \(the implementer's report, `\/b\/thing-report\.md`\), branch `fix\/thing`, head `0123456789abcdef0123456789abcdef01234567`, base `origin\/main`/)
  assert.match(text, /Working directory: `\/w\/review-12`/)
  assert.match(text, /session \*\*`Orch: acme \[a1b2c3\]`\*\*/)
  assert.match(text, /`<repo>#12 0123456789abcdef0123456789abcdef01234567 — <n> findings/)
  assert.match(text, /report: \/b\/review-12-report\.md`/)
  assert.match(text, /checklist in `[^`]*references\/screenshot-checklist\.md`/)
  assert.equal(existsSync(text.match(/checklist in `([^`]*)`/)?.[1] ?? ''), true)
})

test('no lens is a single reading: the list and the tier read none, the size says so', () => {
  assert.equal(run(FIELDS()).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /sized this round by the work, its volume, its scope and its criticality: a single reading by you, because it is one small hook fix\./)
  assert.match(text, /at the \*\*none\*\* tier/)
  assert.match(text, /\n\nnone\n\nThe norms check is no default lens/)
})

test('lenses are listed one a line at the tier given, with the scope text after them', () => {
  const done = run([...FIELDS(), '--lens', 'correctness', '--lens', 'silent failures', '--lens', 'tests', '--tier', 'deep', '--scope', 'Check: the refusal still holds.'])
  assert.equal(done.code, 0, done.err)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /criticality: 3 read-only lenses \(correctness, silent failures, tests\), because it is one small hook fix\./)
  assert.match(text, /at the \*\*deep\*\* tier/)
  assert.match(text, /\n\n- correctness\n- silent failures\n- tests\n\nCheck: the refusal still holds\.\n\nThe norms check is no default lens/)
  // The size the orchestrator gives is kept as it wrote it.
  assert.equal(run([...FIELDS(), '--lens', 'tests', '--size', 'one lens, tests only']).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /criticality: one lens, tests only, because/)
})

test('the other lens shapes: a scope with no lens, lenses with no scope, a size with no lens, a tier with no lens, and the state commands', () => {
  assert.equal(run([...FIELDS(), '--scope', 'Read the diff for the refusal.']).code, 0)
  let text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /\n\nnone\n\nRead the diff for the refusal\.\n\nThe norms check is no default lens/)
  assert.match(text, /at the \*\*none\*\* tier/)
  assert.equal(run([...FIELDS(), '--lens', 'tests']).code, 0)
  text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /at the \*\*standard\*\* tier/)
  assert.match(text, /\n\n- tests\n\nThe norms check is no default lens/)
  assert.equal(run([...FIELDS(), '--size', 'a reading by you and a second look']).code, 0)
  text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /criticality: a reading by you and a second look, because/)
  assert.match(text, /at the \*\*none\*\* tier/)
  assert.match(text, /\nnone\n?$/)
  assert.equal(run([...FIELDS(), '--tier', 'light']).code, 0)
  text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /at the \*\*none\*\* tier, `model: none`/)
  assert.match(text, /\n\nnone\n\nThe norms check is no default lens/)
  assert.match(text, /git fetch origin && git status -sb \| head -1 && git log --oneline -1/)
})

test('a flag whose value is missing never swallows the next flag; a blank lens, title or optional value is not taken for a value', () => {
  assert.match(run([...FIELDS(), '--scope', '--lens', 'tests']).err, /--scope needs a value/)
  assert.match(run([...FIELDS(), '--lens', '  ']).err, /--lens needs a name/)
  const blank = FIELDS(); blank[blank.indexOf('--title') + 1] = '  '
  assert.match(run(blank).err, /--title is required/)
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '# norms\n')
  assert.equal(run([...FIELDS(), '--worktree', dir, '--plan', '', '--norms', '', '--base', '']).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /2\. Plan: `\/b\/thing-brief\.md`/)
  assert.match(text, /3\. Project norms: `CONTRIBUTING\.md`/)
  assert.match(text, /base `origin\/main`/)
})

test('norms default to none when the checkout holds no CONTRIBUTING.md, and to CONTRIBUTING.md when it does', () => {
  assert.equal(run([...FIELDS(), '--worktree', dir]).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /3\. Project norms: `none`/)
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '# norms\n')
  assert.equal(run([...FIELDS(), '--worktree', dir]).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /3\. Project norms: `CONTRIBUTING\.md`/)
})

test('a brief that cannot be written is said in one line, never a stack', () => {
  const done = run(FIELDS().map((v, k, a) => (a[k - 1] === '--out' ? join(dir, 'absent', 'brief.md') : v)))
  assert.equal(done.code, 2)
  assert.match(done.err, /^review-brief: .*absent\/brief\.md cannot be written: /)
})

test('the optional fields and their defaults: plan is the spec, norms CONTRIBUTING.md, base origin/main, an envelope text fills its place', () => {
  assert.equal(run([...FIELDS(), '--plan', '/b/plan.md', '--norms', 'docs/conventions.md', '--base', 'origin/dev', '--envelope', '- No port is opened.']).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /2\. Plan: `\/b\/plan\.md`/)
  assert.match(text, /3\. Project norms: `docs\/conventions\.md`/)
  assert.match(text, /base `origin\/dev`/)
  assert.match(text, /\n- No port is opened\.\n?$/)
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '# norms\n')
  assert.equal(run([...FIELDS(), '--worktree', dir]).code, 0)
  const bare = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(bare, /2\. Plan: `\/b\/thing-brief\.md`/)
  assert.match(bare, /3\. Project norms: `CONTRIBUTING\.md`/)
})

test('a field missing or malformed is refused with its reason, and nothing is written', () => {
  const without = (flag: string): string[] => { const a = FIELDS(); const k = a.indexOf(flag); a.splice(k, 2); return a }
  for (const flag of ['--out', '--repo', '--pr', '--title', '--spec', '--index', '--delivery-report', '--branch', '--head', '--worktree', '--orchestrator', '--reason']) {
    const done = run(without(flag))
    assert.equal(done.code, 2, flag)
    assert.match(done.err, new RegExp(`${flag} is required`), flag)
  }
  assert.equal(existsSync(join(dir, 'review-12.md')), false)
  const set = (flag: string, value: string): string[] => { const a = FIELDS(); a[a.indexOf(flag) + 1] = value; return a }
  assert.match(run(set('--pr', 'twelve')).err, /--pr is the pull request number/)
  assert.match(run(set('--repo', 'app')).err, /--repo is owner\/name/)
  assert.match(run(set('--head', 'zzz')).err, /--head is a commit sha/)
  assert.match(run(set('--out', 'rel/brief.md')).err, /--out is an absolute path/)
  assert.match(run(set('--spec', 'rel.md')).err, /--spec is an absolute path/)
  assert.match(run([...FIELDS(), '--tier', 'huge']).err, /--tier is deep, standard or light/)
  assert.match(run([...FIELDS(), '--bogus', 'x']).err, /unknown argument: --bogus/)
  assert.match(run([...FIELDS(), '--lens']).err, /--lens needs a value/)
  assert.match(run([]).err, new RegExp(USAGE.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(existsSync(join(dir, 'review-12.md')), false)
})

test('--index is the path the review agent writes its index to: it fills the template, an absolute path is required, --report is refused naming --index', () => {
  assert.equal(run([...FIELDS(), '--index', '/b/new-index.md']).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /report: \/b\/new-index\.md`/)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /\*\*Your index\*\*, `\/b\/new-index\.md`, a new file/)
  const set = FIELDS(); set[set.indexOf('--index') + 1] = 'rel/index.md'
  assert.match(run(set).err, /--index is an absolute path/)
  rmSync(join(dir, 'review-12.md'))
  const renamed = FIELDS(); renamed[renamed.indexOf('--index')] = '--report'
  const done = run(renamed)
  assert.equal(done.code, 2)
  assert.match(done.err, /--report is no longer a flag: the review's index path is --index/)
  assert.match(done.err, /never the implementer's report/)
  assert.equal(existsSync(join(dir, 'review-12.md')), false)
})

test('--delivery-report names the implementer\'s report in the brief, for its E2E line, and is an absolute path', () => {
  assert.equal(run(FIELDS()).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /its E2E line, from the implementer's report \(`\/b\/thing-report\.md`\), never/)
  const set = FIELDS(); set[set.indexOf('--delivery-report') + 1] = 'rel/report.md'
  assert.match(run(set).err, /--delivery-report is an absolute path/)
})

test('an --index path that already exists is refused, naming it, and nothing is written; a new path is accepted', () => {
  const taken = join(dir, 'implementer-report.md')
  writeFileSync(taken, 'the implementer report')
  const args = FIELDS(); args[args.indexOf('--index') + 1] = taken
  const done = run(args)
  assert.equal(done.code, 2)
  assert.equal(done.err, `review-brief: --index ${taken} already exists: it must be a new file for the review's index, never the implementer's report or another file\n`)
  assert.equal(existsSync(join(dir, 'review-12.md')), false)
  assert.equal(readFileSync(taken, 'utf8'), 'the implementer report')
  args[args.indexOf('--index') + 1] = join(dir, 'review-12-index.md')
  assert.equal(run(args).code, 0)
  assert.equal(existsSync(join(dir, 'review-12-index.md')), false)
})

test('a placeholder the command does not know is refused, naming it: a template that grows a field breaks here, not in a live brief', () => {
  const done = run(FIELDS(), '# {{PROJECT}}\n\n{{NEW_FIELD}} and {{OTHER}}\n')
  assert.equal(done.code, 2)
  assert.match(done.err, /the template has fields this command does not fill: \{\{NEW_FIELD\}\}, \{\{OTHER\}\}/)
  assert.equal(existsSync(join(dir, 'review-12.md')), false)
})

test('the template of the plugin is the one read, and a template that cannot be read is said', () => {
  assert.equal(existsSync(TEMPLATE), true)
  const missing = join(dir, 'absent.md')
  assert.equal(existsSync(missing), false)
  const done = main(FIELDS(), { out: () => undefined, err: t => assert.match(t, /cannot be read/) }, undefined, missing)
  assert.equal(done, 2)
})

test('an existing brief of the same name is replaced: a round\'s brief is rewritten whole, never patched', () => {
  writeFileSync(join(dir, 'review-12.md'), 'old')
  assert.equal(run(FIELDS()).code, 0)
  assert.notEqual(readFileSync(join(dir, 'review-12.md'), 'utf8'), 'old')
})

test('parseArgs reads each flag once and the last one wins', () => {
  const parsed = parseArgs([...FIELDS(), '--reason', 'second'])
  assert.equal('error' in parsed, false)
  if (!('error' in parsed)) assert.equal(parsed.reason, 'second')
})

test('the readers\' tier and model are the diff\'s class: light for prose, deep for a guard, standard otherwise, and --tier overrides it', () => {
  writeFileSync(join(dir, 'models.json'), '{"light": "small-model", "standard": "mid-model", "deep": "big-model"}')
  const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]) }
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-q', '-b', 'main')
  writeFileSync(join(checkout, 'a.txt'), 'a')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-q', '-m', 'base')
  git(checkout, 'checkout', '-q', '-b', 'work')
  const brief = (extra: string[], name: string): string => {
    const args = [...FIELDS().map(value => value === '/w/review-12' ? checkout : value === join(dir, 'review-12.md') ? join(dir, name) : value), '--base', 'main', '--head', execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), '--lens', 'tests', ...extra]
    const done = run(args)
    assert.equal(done.code, 0, done.err)
    return readFileSync(join(dir, name), 'utf8')
  }
  mkdirSync(join(checkout, 'docs'))
  writeFileSync(join(checkout, 'docs', 'a.md'), 'a')
  git(checkout, 'add', '-f', '.')
  git(checkout, 'commit', '-q', '-m', 'docs')
  assert.match(brief([], 'prose.md'), /at the \*\*light\*\* tier, `model: small-model`/)
  writeFileSync(join(checkout, 'draft-guard.ts'), 'a')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-q', '-m', 'guard')
  assert.match(brief([], 'guard.md'), /at the \*\*deep\*\* tier, `model: big-model`/)
  assert.match(brief(['--tier', 'light'], 'forced.md'), /at the \*\*light\*\* tier, `model: small-model`/)
})

test('the model follows the tier from the map, is host-default when the tier is unbound, reads none with no lens, and a map that does not read is refused', () => {
  assert.equal(run([...FIELDS(), '--lens', 'tests']).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /at the \*\*standard\*\* tier, `model: host-default`/)
  rmSync(join(dir, 'review-12.md'))
  writeFileSync(join(dir, 'models.json'), '{"deep": "big-model/high"}')
  assert.equal(run([...FIELDS(), '--lens', 'tests', '--tier', 'deep']).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /`model: big-model`/)
  rmSync(join(dir, 'review-12.md'))
  assert.equal(run(FIELDS()).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /at the \*\*none\*\* tier, `model: none`/)
  rmSync(join(dir, 'review-12.md'))
  writeFileSync(join(dir, 'models.json'), 'not json')
  const refused = run([...FIELDS(), '--lens', 'tests'])
  assert.equal(refused.code, 2)
  assert.match(refused.err, /^review-brief: resolve-tier: .*does not read as a tier map/)
})

test('the readers\' description names their pull request and range as facts the module reads, the lens left to the session; none with no lens', () => {
  assert.equal(run([...FIELDS(), '--lens', 'silent failures', '--base', 'origin/main']).code, 0)
  const description = readFileSync(join(dir, 'review-12.md'), 'utf8').match(/with the description `([^`]*)`/)?.[1] ?? ''
  assert.equal(description, 'lens <lens> acme/app#12 origin/main..0123456789ab')
  assert.deepEqual(parseLensDescription(description.replace('<lens>', 'silent-failures')), { lens: 'silent-failures', repo: 'acme/app', pr: 12, base: 'origin/main', head: '0123456789ab' })
  rmSync(join(dir, 'review-12.md'))
  assert.equal(run(FIELDS()).code, 0)
  assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /with the description `none`/)
})

test('each lens\'s method is said in the brief: a toolkit angle by its agent, another generic, a missing toolkit generic with its agent named; none with no lens', () => {
  const saved = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'config')
  try {
    mkdirSync(join(dir, 'config', 'plugins'), { recursive: true })
    mkdirSync(join(dir, 'tk', 'agents'), { recursive: true })
    writeFileSync(join(dir, 'tk', 'agents', 'silent-failure-hunter.md'), '---\nname: silent-failure-hunter\n---\nHunt.\n')
    writeFileSync(join(dir, 'config', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'pr-review-toolkit@official': [{ installPath: join(dir, 'tk') }] } }))
    assert.equal(run([...FIELDS(), '--lens', 'silent failures', '--lens', 'correctness', '--lens', 'security', '--tier', 'deep']).code, 0)
    const prompt = join(dir, 'tk', 'agents', 'silent-failure-hunter.md')
    assert.equal(run([...FIELDS(), '--lens', 'silent failures', '--lens', 'correctness', '--lens', 'security', '--tier', 'deep']).code, 0)
    assert.ok(readFileSync(join(dir, 'review-12.md'), 'utf8').includes(`\nPut each toolkit reader's method file in its prompt: silent failures: pr-review-toolkit silent-failure-hunter, its prompt at ${prompt}, read first and answered in finding lines; correctness: generic, pr-review-toolkit code-reviewer not found; security: generic.\n`))
    rmSync(join(dir, 'review-12.md'))
    rmSync(join(dir, 'config', 'plugins', 'installed_plugins.json'))
    assert.equal(run([...FIELDS(), '--lens', 'tests']).code, 0)
    assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /\nPut each toolkit reader's method file in its prompt: tests: generic, pr-review-toolkit pr-test-analyzer not found\.\n/)
    rmSync(join(dir, 'review-12.md'))
    assert.equal(run(FIELDS()).code, 0)
    assert.match(readFileSync(join(dir, 'review-12.md'), 'utf8'), /\nPut each toolkit reader's method file in its prompt: none\.\n/)
  } finally {
    if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = saved
  }
})

test('the module reads the round off the real brief: its project, pull request and head, so the review session of a verdict is found (hooks/review-reading.ts)', () => {
  assert.equal(run(FIELDS()).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  const read = readingOf(text)
  assert.deepEqual(read, { project: 'app', pr: 12, head: '0123456789abcdef0123456789abcdef01234567' })
  assert.equal(isRound(read!, { repo: 'acme/app', pr: 12, head: '0123456789abcdef0123456789abcdef01234567' }), true)
  assert.equal(isRound(read!, { repo: 'acme/app', pr: 13, head: '0123456789abcdef0123456789abcdef01234567' }), false)
  assert.equal(readingOf(text.replace('You are the REVIEW agent', 'You are the implementer')), null)
})

/** A checkout on `work`, one commit past `main`: its package.json scripts, then one commit per subject, each writing its file. */
function checkoutOf(scripts: Record<string, string> | undefined, commits: ReadonlyArray<readonly [string, string]>): { path: string; base: string; head: string } {
  const path = mkdtempSync(join(dir, 'co-'))
  const git = (...args: string[]): string => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  if (scripts !== undefined) writeFileSync(join(path, 'package.json'), JSON.stringify({ scripts }))
  writeFileSync(join(path, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'chore: base')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'work')
  for (const [subject, file] of commits) {
    writeFileSync(join(path, file), subject)
    git('add', '.')
    git('commit', '-q', '-m', subject)
  }
  const head = git('rev-parse', 'HEAD')
  // The base moves on after the branch: drift compares against where the branch left it.
  git('checkout', '-q', 'main')
  writeFileSync(join(path, 'later.txt'), 'later')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: later on the base')
  return { path, base, head }
}

function briefOf(co: { path: string; head: string }): { text: string; err: string } {
  const args = FIELDS()
  args[args.indexOf('--worktree') + 1] = co.path
  args[args.indexOf('--head') + 1] = co.head
  const done = run([...args, '--base', 'main'])
  assert.equal(done.code, 0, done.err)
  return { text: readFileSync(join(dir, 'review-12.md'), 'utf8'), err: done.err }
}

const BUILD = { build: 'vite build' }
/* The step itself: a bare « drift » would also match a checkout path. */
const DRIFT_STEP = /drift:drift|drift\.sh/
const driftCommands = (text: string): string[] => [...text.matchAll(/^drift\.sh (\w+) /gm)].map(match => match[1] ?? '')

test('a refactor in a project with a build: the brief names drift build and shots, from the merge base to the head, one run directory each', () => {
  const co = checkoutOf(BUILD, [['refactor(ui): move the list', 'list.ts'], ['test: cover the move', 'list.spec.ts']])
  const { text } = briefOf(co)
  assert.deepEqual(driftCommands(text), ['build', 'shots'])
  for (const command of ['build', 'shots']) {
    assert.ok(text.includes(`\ndrift.sh ${command} --repo '${co.path}' --base ${co.base} --head ${co.head} --out <scratchpad>/drift-${command}\n`), command)
  }
  assert.match(text, /`drift:drift`/)
  assert.deepEqual(placeholdersOf(text), [])
})

test('a refactor that changes an SVG file adds drift svg', () => {
  assert.deepEqual(driftCommands(briefOf(checkoutOf(BUILD, [['refactor!: rename the icon', 'icon.SVG']])).text), ['build', 'shots', 'svg'])
})

test('a feature or a fix, with a refactor commit or without, names no drift step, and leaves no hole in the brief', () => {
  for (const commits of [
    [['feat: a new list', 'a.ts']],
    [['refactor: prepare', 'a.ts'], ['feat(ui): a new list', 'b.ts']],
    [['refactor: prepare', 'a.ts'], ['fix: the list', 'b.ts']],
    [['chore: bump', 'a.ts']],
  ] as const) {
    const { text, err } = briefOf(checkoutOf(BUILD, commits))
    assert.doesNotMatch(text, DRIFT_STEP, commits.map(([subject]) => subject).join(', '))
    assert.doesNotMatch(text, /\n\n\n/)
    assert.equal(err, '')
  }
})

test('a refactor in a project with no build names no drift step', () => {
  for (const scripts of [undefined, { test: 'node --test' }]) {
    assert.doesNotMatch(briefOf(checkoutOf(scripts, [['refactor: move it', 'a.ts']])).text, DRIFT_STEP)
  }
})

test('a project with a build whose package.json or commits cannot be read is said, never silently left without its drift step', () => {
  const broken = checkoutOf(BUILD, [['refactor: move it', 'a.ts']])
  writeFileSync(join(broken.path, 'package.json'), '{')
  assert.match(briefOf(broken).err, /^review-brief: no drift step: .*package\.json does not read/)
  rmSync(join(dir, 'review-12.md'))
  const unknown = checkoutOf(BUILD, [['refactor: move it', 'a.ts']])
  const done = briefOf({ path: unknown.path, head: '0123456789abcdef0123456789abcdef01234567' })
  assert.match(done.err, /^review-brief: no drift step: the commits of main\.\.0123456789abcdef0123456789abcdef01234567 cannot be read/)
  assert.doesNotMatch(done.text, DRIFT_STEP)
})
