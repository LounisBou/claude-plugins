import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expandUser, main, rulingOf, section, specAim, specGoals, summaryLine, tokens, type Assessment } from './goals.ts'
import { collapse, escape, GoalsFault, goalsTable, parseGoals, renderGoals, splitRow } from './lib/goals-file.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'goals-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const SPEC = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'goals', 'spec.md')
const AIM = 'every build measured against what its spec set out to reach'

/** One command line: `<code>|<stdout>|<stderr>`. */
function cli(...argv: string[]): string {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, { out: t => out.push(t), err: t => err.push(t) }, { HOME: dir })
  return `${code}|${out.join('')}|${err.join('')}`
}

function repo(): { path: string; sha: string } {
  const path = join(dir, 'repo')
  mkdirSync(path)
  execFileSync('git', ['-C', path, 'init', '-q'])
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'])
  writeFileSync(join(path, 'table.json'), '{}')
  return { path, sha: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
}

test('the file: rows split on unescaped pipes, written back escaped, a fault naming the file', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b')
  assert.equal(escape(' a | b '), 'a \\| b')
  assert.deepEqual(splitRow('| G1 | open | a \\| b | | x |'), ['G1', 'open', 'a | b', '', 'x'])
  assert.deepEqual(splitRow('G1 | x \\|'), ['G1', 'x |'])
  const text = 'spec: none\nrepo: /r\naim: an aim\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | open | a \\| b | p | |\n'
  const file = parseGoals(text, 'g.md')
  assert.deepEqual(file, { head: { spec: 'none', repo: '/r', aim: 'an aim' }, rows: [{ id: 'G1', status: 'open', goal: 'a | b', plan: 'p', evidence: '' }] })
  assert.deepEqual(parseGoals(renderGoals(file), 'g.md'), file)
  assert.equal(goalsTable([]), '| id | status | goal (verbatim from the spec) | plan | evidence or ruling |\n|---|---|---|---|---|')
  assert.throws(() => parseGoals('spec: none\n| G1 | open |\n', 'g.md'), new GoalsFault('g.md: a row does not have five cells: | G1 | open |'))
  assert.throws(() => parseGoals('repo: x\n', 'g.md'), new GoalsFault('g.md: no spec: line'))
})

test('the spec: its Goals items, continued lines joined, and the first paragraph of its Why', () => {
  const spec = '# S\n\n## Why\n\nThe first   paragraph\nof it.\n\nsecond\n\n## Goals\n\n1. one\n   continued\n2) two\n\nprose\n3. three\n\n## Other\n4. four\n'
  assert.deepEqual(specGoals(spec), ['one continued', 'two', 'three'])
  assert.equal(specAim(spec), 'The first paragraph of it.')
  assert.equal(specGoals('## Goals\n\nnone numbered\n'), null)
  assert.equal(specGoals('# Nothing\n'), null)
  assert.equal(specAim('# Nothing\n'), '')
  assert.deepEqual(section('## a.b\nx\n## ab\ny\n', 'a.b'), ['x'])
  assert.equal(expandUser('~/x', { HOME: '/h' }), '/h/x')
  assert.equal(expandUser('a/~', { HOME: '/h' }), 'a/~')
  assert.deepEqual(tokens(' a ; ;b '), ['a', 'b'])
  assert.equal(rulingOf('operator: « his words »'), 'his words')
  assert.equal(rulingOf('dropped'), '')
})

test('the usage, an unknown command, and a file that is not there', () => {
  assert.match(cli(), /^1\|\|ERROR: usage: goals\.sh \{init\|status\|line\|unplanned\|plan\|met\|rule-out\|defer\|reopen\|check\}/)
  assert.match(cli('bogus', 'g.md'), /^1\|\|ERROR: usage/)
  const absent = join(dir, 'g.md')
  assert.equal(cli('status', absent), `1||ERROR: no goals file at ${absent}: dispatch-record.sh goals <record> init --spec <path>|none\n`)
  assert.match(cli('check', absent), /^2\|\|ERROR: cannot read .*: No such file or directory\n$/)
  assert.match(cli('check', absent, '--json'), /^2\|\{"ok":false,"error":"cannot read .*"\}\n\|$/)
  assert.equal(cli('check', absent, '--bad'), '1||ERROR: check: unknown argument --bad\n')
  mkdirSync(join(dir, 'd.md'))
  assert.match(cli('check', join(dir, 'd.md')), /^2\|\|ERROR: cannot read .*: Is a directory\n$/)
})

test('init from a spec: the goals verbatim, the aim checked, an old file archived on --replace', () => {
  const { path } = repo()
  const g = join(dir, 'b', 'goals.md')
  assert.equal(cli('init', g), '1||ERROR: init: --spec <path> or --spec none is required\n')
  assert.equal(cli('init', g, '--spec'), '1||ERROR: --spec needs a value\n')
  assert.equal(cli('init', g, '--spec', SPEC, '--bogus'), '1||ERROR: unknown argument --bogus\n')
  assert.equal(cli('init', g, '--spec', SPEC, 'G1'), '1||ERROR: unknown argument G1\n')
  assert.equal(cli('init', g, '--spec', SPEC, '--constructor', 'x'), '1||ERROR: unknown argument --constructor\n')
  assert.match(cli('init', g, '--spec', join(dir, 'none.md')), /ERROR: init: cannot read the spec/)
  assert.match(cli('init', g, '--spec', SPEC, '--goal', 'x'), /--goal is only for a spec with no Goals list/)
  assert.match(cli('init', g, '--spec', SPEC, '--aim', 'not in it'), /the aim is not the spec's text: copy it verbatim/)
  writeFileSync(join(dir, 'bare.md'), '# Bare\n\n## Why\n\nA reason.\n')
  assert.match(cli('init', g, '--spec', join(dir, 'bare.md')), /has no numbered list under « ## Goals »/)
  assert.equal(cli('init', g, '--spec', join(dir, 'bare.md'), '--goal', '  '), '1||ERROR: init: a goal is empty\n')
  assert.equal(cli('init', g, '--spec', SPEC, '--aim', AIM, '--repo', path), `0|goals: 5 goal(s) written to ${g}\n|`)
  const text = readFileSync(g, 'utf8')
  assert.match(text, /^# Goals\nspec: .*spec\.md\nrepo: .*repo\naim: every build measured/)
  assert.match(text, /\| G4 \| open \| \*\*Generalisation\*\*: .* per language \\\| project kind\. \| {2}\| {2}\|/)
  assert.match(cli('init', g, '--spec', 'none'), /already holds the goals of spec .*spec\.md: give --replace/)
  assert.equal(cli('init', g, '--spec', 'none', '--replace'), `0|goals: the previous file is kept as ${join(dir, 'b', 'goals-spec.md')}\ngoals: 0 goal(s) written to ${g}\n|`)
  assert.equal(cli('init', g, '--spec', 'none', '--replace', '--goal', 'a'), `0|goals: the previous file is kept as ${join(dir, 'b', 'goals-none.md')}\ngoals: 1 goal(s) written to ${g}\n|`)
  writeFileSync(g, 'no spec here\n')
  assert.match(cli('init', g, '--spec', join(dir, 'bare.md'), '--goal', 'b', '--replace'), /previous file is kept as .*goals-none\.md\ngoals: 1 goal/)
  assert.match(readFileSync(g, 'utf8'), /^aim: A reason\.$/m)
})

test('the grammar: met needs evidence on disk, a ruling his words, and check reads it all', () => {
  const { path, sha } = repo()
  const g = join(dir, 'goals.md')
  cli('init', g, '--spec', SPEC, '--aim', AIM, '--repo', path)
  assert.equal(cli('line', g), '0|goals met=0/5 ruled_out=0 open=G1,G2,G3,G4,G5 unplanned=G1,G2,G3,G4,G5\n|')
  assert.equal(cli('plan', g), '1||ERROR: plan: a goal id is required\n')
  assert.equal(cli('plan', g, 'G1', '--phase', ' '), '1||ERROR: plan: --phase <text> is required\n')
  assert.equal(cli('plan', g, 'G9', '--phase', 'x'), '1||ERROR: no goal G9 (goals: G1, G2, G3, G4, G5)\n')
  assert.equal(cli('plan', g, 'G1', '--phase', 'Phase   1'), '0||')
  assert.equal(cli('unplanned', g), '0|G2\nG3\nG4\nG5\n|')
  assert.equal(cli('met', g, 'G2'), '1||ERROR: met: --evidence <path|commit:<sha>> is required\n')
  assert.equal(cli('met', g, 'G2', '--evidence', 'pr:#1'), '1||ERROR: met: G2 not recorded: no path or commit\n')
  assert.equal(cli('met', g, 'G2', '--evidence', 'nowhere'), '1||ERROR: met: G2 not recorded: nowhere does not exist\n')
  assert.equal(cli('met', g, 'G2', '--evidence', 'commit:zz'), '1||ERROR: met: G2 not recorded: commit:zz is no commit sha\n')
  assert.equal(cli('met', g, 'G2', '--evidence', 'commit:0123456789abcdef'), `1||ERROR: met: G2 not recorded: commit:0123456789abcdef does not resolve in ${path}\n`)
  assert.equal(cli('met', g, 'G2', '--evidence', 'table.json', '--evidence', 'pr:#3; run:x'), '0||')
  assert.equal(cli('met', g, 'G3', '--evidence', `commit:${sha.slice(0, 10)}`), '0||')
  assert.equal(cli('met', g, 'G5', '--evidence', '~/repo'), '0||')
  assert.equal(cli('rule-out', g, 'G4'), '1||ERROR: rule-out: --ruling needs the operator\'s own words, verbatim and not empty\n')
  assert.equal(cli('rule-out', g, 'G4', '--ruling', '« »'), '1||ERROR: rule-out: --ruling needs the operator\'s own words, verbatim and not empty\n')
  assert.equal(cli('rule-out', g, 'G4', '--ruling', 'operator: « not   now »'), '0||')
  assert.equal(cli('defer', g, 'G4', '--ruling', 'later'), '1||ERROR: defer: G4 is ruled-out, not open\n')
  assert.equal(cli('defer', g, 'G1', '--ruling', '« same »'), '0||')
  assert.equal(cli('check', g), '1|deferred: G1\ngoals met=3/5 ruled_out=1 open=none unplanned=none deferred=G1\n|')
  assert.equal(cli('reopen', g), '1||ERROR: reopen: a goal id is required\n')
  assert.equal(cli('reopen', g, 'G1'), '0||')
  assert.equal(cli('rule-out', g, 'G1', '--ruling', '"his words"'), '0||')
  assert.equal(cli('check', g), '0|goals met=3/5 ruled_out=2 open=none unplanned=none\n|')
  const answer = cli('check', g, '--json')
  const json = JSON.parse(answer.slice(2, -1)) as Assessment
  assert.deepEqual(Object.keys(json), ['ok', 'open', 'deferred', 'unplanned', 'faults', 'notes', 'rows', 'met', 'ruled_out', 'aim', 'spec', 'table'])
  assert.equal(json.ok, true)
  const status = cli('status', g)
  assert.match(status, /^0\|aim: every build .*\nspec: .*spec\.md\n\| id \| status/)
  assert.match(status, /\| G1 \| ruled-out \| .* \| Phase 1 \| operator: « his words » \|\n/)
  assert.match(status, /\| G4 \| ruled-out \| .* \| {2}\| operator: « not now » \|\n/)
})

test('check: every fault of a hand-edited file, and a spec that moved', () => {
  const g = join(dir, 'goals.md')
  const spec = join(dir, 'spec.md')
  writeFileSync(spec, readFileSync(SPEC, 'utf8'))
  const rows = '| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | weird | x | | |\n| G2 | ruled-out | y | | dropped |\n| G3 | met | z | | pr:#1 |\n| G4 | deferred | w | | |\n| G5 | | v | | |\n'
  writeFileSync(g, `spec: ${spec}\naim: not the spec's aim\n\n${rows}`)
  assert.equal(cli('check', g),
    '1|deferred: G4\nfault: G1 has no status of open, met, ruled-out or deferred: weird\nfault: G2 ruled out without the operator\'s words\n'
    + 'fault: G3 met without evidence on disk: no path or commit\nfault: G4 deferred without the operator\'s words\n'
    + 'fault: G5 has no status of open, met, ruled-out or deferred: empty\nfault: G1 is not the spec\'s text\nfault: G2 is not the spec\'s text\n'
    + 'fault: G3 is not the spec\'s text\nfault: G4 is not the spec\'s text\nfault: G5 is not the spec\'s text\nfault: the aim is not the spec\'s text\n'
    + 'goals met=1/5 ruled_out=1 open=none unplanned=none deferred=G4\n|')
  writeFileSync(g, `spec: ${spec}\n\n| G1 | open | ${'The unit of choice is a **pair** `<alias>/<effort>`: a family alias and an effort level.'} | | |\n`)
  assert.match(cli('check', g), /^1\|open: G1\nfault: 1 rows, the spec's Goals list 5\ngoals met=0\/1/)
  rmSync(spec)
  assert.match(cli('status', g), /note: the spec .*spec\.md cannot be read: its goals were not matched\n/)
  writeFileSync(g, 'spec: none\n| G1 | open |\n')
  assert.match(cli('status', g), /^1\|\|ERROR: .*a row does not have five cells/)
  assert.match(cli('plan', g, 'G1', '--phase', 'p'), /^1\|\|ERROR: .*a row does not have five cells/)
  assert.ok(existsSync(g))
})
