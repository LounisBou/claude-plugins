import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main, parseArgs, placeholdersOf, TEMPLATE, USAGE } from './review-brief.ts'

let dir = ''
test.beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-brief-'))) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const FIELDS = (): string[] => [
  '--out', join(dir, 'review-12.md'), '--repo', 'acme/app', '--pr', '12', '--title', 'a fix of the thing (row 9 THING)',
  '--spec', '/b/thing-brief.md', '--index', '/b/review-12-report.md', '--branch', 'fix/thing', '--head', '0123456789abcdef0123456789abcdef01234567',
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
  assert.match(text, /pull request 12 \(the self-review lines of the implementer's report first\), branch `fix\/thing`, head `0123456789abcdef0123456789abcdef01234567`, base `origin\/main`/)
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
  assert.match(run([...FIELDS(), '--tier', 'deep']).err, /--tier goes with --lens/)
  assert.match(text, /git fetch origin && git status -sb \| head -1 && git log --oneline -1/)
})

test('a flag whose value is missing never swallows the next flag; a blank lens, title or optional value is not taken for a value', () => {
  assert.match(run([...FIELDS(), '--scope', '--lens', 'tests']).err, /--scope needs a value/)
  assert.match(run([...FIELDS(), '--lens', '  ']).err, /--lens needs a name/)
  const blank = FIELDS(); blank[blank.indexOf('--title') + 1] = '  '
  assert.match(run(blank).err, /--title is required/)
  assert.equal(run([...FIELDS(), '--plan', '', '--norms', '', '--base', '']).code, 0)
  const text = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(text, /2\. Plan: `\/b\/thing-brief\.md`/)
  assert.match(text, /3\. Project norms: `CONTRIBUTING\.md`/)
  assert.match(text, /base `origin\/main`/)
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
  assert.equal(run(FIELDS()).code, 0)
  const bare = readFileSync(join(dir, 'review-12.md'), 'utf8')
  assert.match(bare, /2\. Plan: `\/b\/thing-brief\.md`/)
  assert.match(bare, /3\. Project norms: `CONTRIBUTING\.md`/)
})

test('a field missing or malformed is refused with its reason, and nothing is written', () => {
  const without = (flag: string): string[] => { const a = FIELDS(); const k = a.indexOf(flag); a.splice(k, 2); return a }
  for (const flag of ['--out', '--repo', '--pr', '--title', '--spec', '--index', '--branch', '--head', '--worktree', '--orchestrator', '--reason']) {
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
