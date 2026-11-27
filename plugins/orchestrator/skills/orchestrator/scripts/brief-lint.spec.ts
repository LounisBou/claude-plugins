import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CHANGED_SHOWN, changedLine, lint, main, USAGE, type Context } from './brief-lint.ts'

const context = (over: Partial<Context> = {}): Context => ({ expected: [], shortNames: new Set(), exists: () => true, ...over })
const texts = (text: string, over: Partial<Context> = {}): string[] => lint(text, context(over)).map(f => `${f.line}: ${f.text}`)

const IMPLEMENTER = '# p\n\nYou are the implementer for this phase.\n\n1. Spec: `/s.md`\n\nYour orchestrator is `p [a1b2c3]`.\n'

test('a complete implementer brief has no finding', () => {
  assert.deepEqual(texts(IMPLEMENTER), [])
  assert.deepEqual(texts(''), [])
})

test('a placeholder is a finding, quoted in a code span or not', () => {
  assert.deepEqual(texts('a\nBranch: {{BRANCH}} {{X_1}}\n'), ['2: unfilled placeholder {{BRANCH}}', '2: unfilled placeholder {{X_1}}'])
  assert.deepEqual(texts('`{{BRANCH}}`\n'), ['1: unfilled placeholder {{BRANCH}}'])
  assert.deepEqual(texts('The line `Mode: {{MODE}}` is filled.\n'), ['1: unfilled placeholder {{MODE}}'])
})

test('an upper-case variable reference is a finding, in both spellings', () => {
  const tail = ": the agent's shell carries none of your environment; write the resolved value"
  assert.deepEqual(texts('run ${CLAUDE_PLUGIN_ROOT}/x then $HOME and ${A:-b c}\n'), [
    `1: unexpanded variable \${CLAUDE_PLUGIN_ROOT}${tail}`, `1: unexpanded variable $HOME${tail}`, `1: unexpanded variable \${A:-b c}${tail}`,
  ])
  assert.deepEqual(texts('$n $AB ${lower} costs $5\n'), [])
})

test('a backticked absolute path exists, is expected, or is a slash command', () => {
  const over = { exists: (p: string) => p === '/there', expected: ['/report.md'], shortNames: new Set(['orchestrator-status']) }
  assert.deepEqual(texts('`/there` `/report.md` `/nowhere/spec.md` `relative/x`\n', over), ['1: path does not exist: /nowhere/spec.md'])
  assert.deepEqual(texts('`/orchestrator:status` `/implement:phase 3` `/orchestrator-status` `/orchestrator-status now`\n', over), [])
  assert.deepEqual(texts('`/nowhere/at:x/spec.md`\n`/orchestrator-x/y`\n`/`\n', over), [
    '1: path does not exist: /nowhere/at:x/spec.md', '2: path does not exist: /orchestrator-x/y',
  ])
})

test('a review brief\'s index is a file the review writes: it lints clean while every other missing path is flagged', () => {
  const over = { exists: (p: string) => p === '/there' }
  const review = (index: string, spec: string): string => `1. Spec: \`${spec}\`\n\n2. **Your index**, \`${index}\`, a new file that is yours alone (never the implementer's report): one line per finding.\n`
  assert.deepEqual(texts(review('/b/review-index.md', '/there'), over), [])
  assert.deepEqual(texts(review('/b/review-index.md', '/nowhere/spec.md'), over), ['1: path does not exist: /nowhere/spec.md'])
  // Only the line of §4 that names the index is excused; the same path elsewhere is still a missing file.
  assert.deepEqual(texts('`/b/review-index.md`\n', over), ['1: path does not exist: /b/review-index.md'])
  assert.deepEqual(texts(`${review('/b/review-index.md', '/there')}Read \`/b/review-index.md\`.\n`, over), ['4: path does not exist: /b/review-index.md'])
})

test('an implementer brief names one orchestrator and a spec field', () => {
  assert.deepEqual(texts('# p\n\nYou are the implementer for this phase.\n'), [
    '1: no orchestrator address: name the exact ListAgents name and reference',
    '1: no spec field: name the design this phase builds on a line of its own, `Spec: <path>`, or `Spec: none`',
  ])
  assert.deepEqual(texts(IMPLEMENTER.replace('1. Spec: `/s.md`', '- Spec: none')), [])
  assert.deepEqual(texts(IMPLEMENTER.replace('1. Spec: `/s.md`', 'Spec:')).length, 1)
  assert.deepEqual(texts(IMPLEMENTER.replace('1. Spec: `/s.md`', 'The Spec: is elsewhere')).length, 1)
})

test('a second session reference is a finding; the class is read at the start of a line', () => {
  assert.deepEqual(texts('# r\nYou are the REVIEW agent.\n`a [a1b2c3]` `b [d4e5f6]` `a [a1b2c3]`\n'), [
    '1: more than one session reference ([a1b2c3] [d4e5f6] ): one address, no example beside it',
  ])
  assert.deepEqual(texts('# memo\nThe brief said "You are the implementer for this phase." inline.\n'), [])
})

test('a brief whose reader confirms the takeover to its predecessor carries the close', () => {
  const hand = '# by hand\nSend « Takeover confirmed » to your predecessor.\n'
  assert.equal(texts(hand).length, 1)
  assert.match(texts(hand)[0] ?? '', /^1: succession brief without the predecessor's close: .*instantiate the template/)
  assert.deepEqual(texts(`${hand}Then close --tty ttys001 --expect-title T.\n`), [])
  assert.equal(texts(`${hand}Then close --tty ttys001.\n`).length, 1)
  assert.deepEqual(texts('# audit\nReport « takeover confirmed » to the session handed over from.\n'), [])
})

// The succession briefs still written are the coordinator's and the auditor's: filled, each lints
// clean, and each is refused once its close of the predecessor is dropped, whatever else it holds.
const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates')
for (const name of ['coordinator-succession-brief.md', 'auditor-succession-brief.md']) {
  test(`the ${name.replace('.md', '')} template, filled, carries the predecessor's close the lint holds it to`, () => {
    const filled = readFileSync(join(TEMPLATES, name), 'utf8').replace(/\{\{[A-Z_]+\}\}/g, 'x')
    assert.deepEqual(texts(filled), [])
    const open = filled.split('\n').filter(line => !line.includes('--expect-title')).join('\n')
    assert.equal(open.length < filled.length, true)
    assert.match(texts(open).join('\n'), /^1: succession brief without the predecessor's close: /)
  })
}

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-lint-')) })
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function cli(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, { io: { out: t => out.push(t), err: t => err.push(t) }, root: join(dir, 'root') })
  return { code, out: out.join(''), err: err.join('') }
}

test('the command: findings on stdout, the count on stderr, exit 1; none, exit 0', () => {
  mkdirSync(join(dir, 'root'))
  writeFileSync(join(dir, 'root', 'short-names.tsv'), 'orchestrator-status\tstatus\n')
  const good = join(dir, 'good.md')
  writeFileSync(good, `# memo\n\`${dir}\` \`/orchestrator-status\` \`${dir}/report.md\`\n`)
  assert.deepEqual(cli(good, '--expect-created', `${dir}/report.md`), { code: 0, out: `brief-lint: ${good}: 0 findings\n`, err: '' })
  assert.deepEqual(cli(good), { code: 1, out: `${good}:2: path does not exist: ${dir}/report.md\n`, err: `brief-lint: ${good}: 1 finding(s)\n` })
})

test('the command without short-names.tsv reads a short name as a path', () => {
  const brief = join(dir, 'b.md')
  writeFileSync(brief, '`/orchestrator-status`\n')
  assert.equal(cli(brief).out, `${brief}:1: path does not exist: /orchestrator-status\n`)
})

test('the command line: one brief, a path after --expect-created, a file', () => {
  assert.deepEqual(cli(), { code: 1, out: '', err: `${USAGE}\n` })
  assert.deepEqual(cli('a', 'b'), { code: 1, out: '', err: `brief-lint: one brief at a time (${USAGE})\n` })
  assert.deepEqual(cli('a', '--expect-created'), { code: 1, out: '', err: `brief-lint: --expect-created needs a path (${USAGE})\n` })
  assert.deepEqual(cli(join(dir, 'absent.md')), { code: 1, out: '', err: `brief-lint: not a file: ${join(dir, 'absent.md')}\n` })
  assert.equal(cli(dir).err, `brief-lint: not a file: ${dir}\n`)
})

test('a brief that names its checkout and its base head gets the files the base changed since, as information, never a finding', () => {
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.ts'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  const printed = git('rev-parse', '--short=12', 'HEAD')
  writeFileSync(join(repo, 'a.ts'), 'a2\n')
  writeFileSync(join(repo, 'b.ts'), 'b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'two')
  const brief = join(dir, 'b.md')
  writeFileSync(brief, `# p\nCheckout: \`${repo}\`\nBranch: \`feat/x\`, from \`main\`, which stood at ${printed} when this brief was printed.\n`)
  assert.deepEqual(cli(brief), { code: 0, out: `brief-lint: ${brief}: 2 file(s) changed on main since ${printed}: a.ts, b.ts\nbrief-lint: ${brief}: 0 findings\n`, err: '' })
  // Git that cannot tell, a brief that names no head: nothing said.
  writeFileSync(brief, `# p\nCheckout: \`${repo}\`\nBranch: \`feat/x\`, from \`gone\`, which stood at ${printed} when this brief was printed.\n`)
  assert.equal(cli(brief).out, `brief-lint: ${brief}: 0 findings\n`)
  const text = 'Checkout: `/w`\nfrom `origin/main`, which stood at abc1234 when'
  assert.equal(changedLine('Checkout: `/w`\n', () => []), undefined)
  assert.equal(changedLine(text, () => []), 'nothing changed on origin/main since abc1234')
  const many = Array.from({ length: CHANGED_SHOWN + 2 }, (_, i) => `f${i}`)
  assert.match(changedLine(text, () => many) ?? '', new RegExp(`^${CHANGED_SHOWN + 2} file\\(s\\) changed on origin/main since abc1234: f0, .*f${CHANGED_SHOWN - 1}, and 2 more$`))
})
