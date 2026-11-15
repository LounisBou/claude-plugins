import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { lint, main, openQuestions, SUCCESSION_LIMIT, USAGE, type Context } from './brief-lint.ts'

const context = (over: Partial<Context> = {}): Context => ({ expected: [], shortNames: new Set(), exists: () => true, ...over })
const texts = (text: string, over: Partial<Context> = {}): string[] => lint(text, context(over)).map(f => `${f.line}: ${f.text}`)

const IMPLEMENTER = '# p\n\nYou are the implementer for this phase.\n\n1. Spec: `/s.md`\n\nYour orchestrator is `p [a1b2c3]`.\n'
const SUCCESSION = '# Orchestrator succession brief\n\nMode: build\n\n## Live state\n\n- The operator\'s open questions: none\n- Project: p\n'

test('a complete implementer brief and a complete succession brief have no finding', () => {
  assert.deepEqual(texts(IMPLEMENTER), [])
  assert.deepEqual(texts(SUCCESSION), [])
  assert.deepEqual(texts(''), [])
})

test('a placeholder is a finding, but the mode quoted in a closed code span', () => {
  assert.deepEqual(texts('a\nBranch: {{BRANCH}} {{X_1}}\n'), ['2: unfilled placeholder {{BRANCH}}', '2: unfilled placeholder {{X_1}}'])
  assert.deepEqual(texts('The line `Mode: {{MODE}}` is filled.\n'), [])
  assert.deepEqual(texts('Mode: {{MODE}}\n'), ['1: unfilled placeholder {{MODE}}'])
  assert.deepEqual(texts('`Mode: {{MODE}}` and {{MODE}}\n'), ['1: unfilled placeholder {{MODE}}'])
  assert.deepEqual(texts('a ` stray {{MODE}}\n'), ['1: unfilled placeholder {{MODE}}'])
  assert.deepEqual(texts('`{{BRANCH}}`\n'), ['1: unfilled placeholder {{BRANCH}}'])
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

test('an implementer brief names its orchestrator', () => {
  assert.deepEqual(texts('# p\n\nYou are the implementer for this phase.\n'), ['1: no orchestrator address: name the exact ListAgents name and reference'])
})

test('a second session reference is a finding, but in a succession brief; the class is read at the start of a line', () => {
  assert.deepEqual(texts('# r\nYou are the REVIEW agent.\n`a [a1b2c3]` `b [d4e5f6]` `a [a1b2c3]`\n'), [
    '1: more than one session reference ([a1b2c3] [d4e5f6] ): one address, no example beside it',
  ])
  assert.deepEqual(texts(`${SUCCESSION}- a [a1b2c3]\n- b [d4e5f6]\n`), [])
  assert.deepEqual(texts('# memo\nThe brief said "You are the implementer for this phase." inline.\n'), [])
})

test('the open-questions field: its value, and the brief without it', () => {
  assert.deepEqual(openQuestions(['a', '- Project: p']), { value: undefined, rest: 'a\n- Project: p\n', line: 0 })
  assert.deepEqual(openQuestions(['a', "- The operator's open questions: one", '  two', '- Project: p', "- The operator's open questions: x"]), {
    value: ' one\n  two', rest: "a\n- The operator's open questions:\n- Project: p\n- The operator's open questions: x\n", line: 2,
  })
  assert.deepEqual(openQuestions(["- The operator's open questions", 'q', '# next']), { value: 'q', rest: "- The operator's open questions\n# next\n", line: 1 })
})

test('a Live state carries the open questions, filled or none', () => {
  const live = (field: string): string => `# b\n\n## Live state\n\n${field}- Project: p\n`
  assert.deepEqual(texts(live('')), ['1: Live state has no open-questions field: add "The operator\'s open questions", each verbatim, or none'])
  assert.deepEqual(texts(live("- The operator's open questions: \n")), ['5: the open-questions field is empty: write each question verbatim, or none after reading the round'])
  assert.deepEqual(texts(live('- The operator’s open questions, verbatim: `x`\n  {{LIVE_OPEN_QUESTIONS}}\n').replace('`x`', '')).filter(t => t.startsWith('5: the open-questions field is still its placeholder')).length, 1)
  assert.deepEqual(texts(live("- The operator's open questions:\n  Question 1 of 2\n  why?\n")), [])
  assert.deepEqual(texts("- The operator's open questions:\n"), [])
})

test('a succession brief is capped once the open-questions value is set apart, in characters', () => {
  const pad = (n: number): string => `${'é'.repeat(n - 1)}\n`
  const big = `${SUCCESSION.replace(': none', `: ${'q'.repeat(4000)}`)}`
  assert.deepEqual(texts(big + pad(SUCCESSION_LIMIT - [...SUCCESSION].length + ' none'.length)), [])
  const over = big + pad(SUCCESSION_LIMIT - [...SUCCESSION].length + ' none'.length + 1)
  assert.deepEqual(texts(over), [
    `1: succession brief is ${[...over].length} characters, over the limit of 9000 once the open-questions value is set apart (9001): keep Live state to what is live and the rest as pointers`,
  ])
  assert.deepEqual(texts(`# other\n${'x'.repeat(20000)}`), [])
})

test('a succession brief carries its mode on a line of its own', () => {
  const finding = '1: succession brief carries no `Mode: build` or `Mode: investigate` line: add it on a line of its own, the mode of the orchestrator that writes it'
  assert.deepEqual(texts(SUCCESSION.replace('Mode: build', 'The mode is build.')), [finding])
  assert.deepEqual(texts(SUCCESSION.replace('Mode: build', 'Mode: other')), [finding])
  assert.deepEqual(texts(SUCCESSION.replace('Mode: build', 'Mode: investigate  ')), [])
  assert.deepEqual(texts(SUCCESSION.replace('Mode: build', 'Mode: {{MODE}}')), ['3: unfilled placeholder {{MODE}}'])
})

test('a brief whose reader confirms the takeover to its predecessor carries the close', () => {
  const hand = '# by hand\nSend « Takeover confirmed » to your predecessor.\n'
  assert.equal(texts(hand).length, 1)
  assert.match(texts(hand)[0] ?? '', /^1: succession brief without the predecessor's close: .*instantiate the template/)
  assert.deepEqual(texts(`${hand}Then close --tty ttys001 --expect-title T.\n`), [])
  assert.equal(texts(`${hand}Then close --tty ttys001.\n`).length, 1)
  assert.deepEqual(texts('# audit\nReport « takeover confirmed » to the session handed over from.\n'), [])
})

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
