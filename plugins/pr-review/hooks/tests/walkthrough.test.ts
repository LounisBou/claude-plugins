// hooks/tests/walkthrough.test.ts
// The band wired to the engine: a skill's start opens it, and an interrupted turn, the closing
// line or a /clear takes it down. No call is held while it stands.
import { expect, test } from 'claude-code/testing'
import type { Engine, TestOn } from 'claude-code/testing'
import { fieldsOf, listOf } from '../../core/host.ts'

const composer = { kind: 'composer' } as const

// The bottom of the chain for one test: a preflight that passes, a skill text,
// tools that answer "ran", and a turn that answers a fixed text.
function engine(on: TestOn, opts: { listed?: string[] } = {}) {
  const ran: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  on('tool.list', () => ({ value: (opts.listed ?? []).map((name) => ({ name })) }))
  on('tool.call', (_$, e) => {
    ran.push(e['tool'] + (e['tool'] === 'mcp__github__gh' ? ':' + e['command'] : ''))
    return { result: 'ran' }
  })
  on('prompt.submit', (_$, e) => e)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return ran
}

const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: composer })
const editCall = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b', replace_all: false } as const

// What the band follows ends with the walkthrough: an interrupted turn, the skill's closing line
// and a /clear all take it down, and nothing the user types does.
async function bandText($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 40 } })
  return String((await ui.find({ type: 'Text', text: 'pr-review ·' }))?.text ?? '')
}

test('a skill\'s start opens the band, the words the user types close nothing', async ($, on) => {
  engine(on)
  below(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'end review')
  expect(await bandText($)).toContain('pr-review · start-review')
})

test('an interrupted turn takes the band down', async ($, on) => {
  engine(on)
  below(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  expect(await bandText($)).toContain('start-review')
  await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't1', durationMs: 1 })
  expect(await bandText($)).toBe('')
})

test("the skill's closing line takes the band down", async ($, on) => {
  engine(on)
  below(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await $.turn.complete({ reason: 'answer', answer: 'x\n## Walkthrough complete\n', isAborted: false, turnId: 't1', durationMs: 1 })
  expect(await bandText($)).toBe('')
})

test('a /clear takes the band down', async ($, on) => {
  engine(on)
  below(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  expect(await bandText($)).toContain('process-comments')
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  expect(await bandText($)).toBe('')
})

test('a call is never held or refused while a walkthrough runs', async ($, on) => {
  const ran = engine(on, { listed: ['mcp__github__gh'] })
  await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  const calls = [editCall, { tool: 'Bash', command: 'git push --force origin main' }, { tool: 'mcp__github__gh', command: 'comment-delete' },
    { tool: 'mcp__github__gh', command: 'review-submit', args: { event: 'APPROVE' } }, { tool: 'mcp__github__gh', command: 'thread-resolve' }]
  for (const call of calls) expect((await $.tool.call(call)).deny).toBeUndefined()
  expect(ran).toEqual(['Edit', 'Bash', 'mcp__github__gh:comment-delete', 'mcp__github__gh:review-submit', 'mcp__github__gh:thread-resolve'])
})

// ── the band ─────────────────────────────────────────────────────────────────

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10 }

// What draws beneath the plugin: another plugin's band, kept under this one's line.
// (A Text keeps no key once drawn, so the tests find each line by its text.)
function below(on: TestOn) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ key: 'below', children: ['another band'] })
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band says a walkthrough holds the session and what it kept`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }, { name: 'comment-2.md' }, { name: 'commit-1.msg' }] }))
    await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-2.md', content: 'x' })
    const ui = await $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 40 } })
    const line = await ui.find({ type: 'Text', text: 'pr-review ·' })
    expect(String(line?.text ?? '')).toContain('pr-review · start-review · kept 2 · prepared commits 1')
    expect(await ui.find({ type: 'Text', text: 'another band' })).toBeTruthy()
  })

  test(`${surface}: no band while nothing holds the session`, async ($, on) => {
    engine(on)
    below(on)
    const ui = await $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 40 } })
    expect(await ui.findAll({ type: 'Text', text: 'pr-review ·' })).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'another band' })).toBeTruthy()
  })
}

// ── the band's colours ───────────────────────────────────────────────────────

async function mountBand($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 60, rows: 40 } })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band's head is bold, the count green, the commit yellow`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }, { name: 'comment-2.md' }, { name: 'commit-1.msg' }] }))
    await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-2.md', content: 'x' })
    const ui = await mountBand($, surface)
    const head = await ui.find({ type: 'Text', text: /^pr-review · start-review$/ })
    expect(head?.props['bold']).toBe(true)
    const kept = await ui.find({ type: 'Text', text: /^kept 2$/ })
    expect(kept?.props['color']).toBe('success')
    const prepared = await ui.find({ type: 'Text', text: /^prepared commits 1 \(say commit or drop\)$/ })
    expect(prepared?.props['color']).toBe('warning')
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props['dimColor']).toBeFalsy()
  })

  test(`${surface}: the process-comments band has no kept count`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }] }))
    await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-1.md', content: 'x' })
    const ui = await mountBand($, surface)
    // Its head is its only piece: the band's own line and the head draw the same words.
    expect((await ui.findAll({ type: 'Text', text: /^pr-review · process-comments$/ })).some(t => t.props['bold'] === true)).toBe(true)
    expect(await ui.findAll({ type: 'Text', text: 'kept' })).toEqual([])
  })

  test(`${surface}: the auto-fix-loop band has a bold head and a plain body`, async ($, on) => {
    engine(on)
    below(on)
    await $.skill.prompt({ skill: 'pr-review:auto-fix-loop', text: '' })
    await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start', test_command: 'npm test' })
    const ui = await mountBand($, surface)
    const head = await ui.find({ type: 'Text', text: /^pr-review · auto-fix-loop$/ })
    expect(head?.props['bold']).toBe(true)
    const body = await ui.find({ type: 'Text', text: /^0 fixes committed$/ })
    expect(body).toBeTruthy()
    expect(body?.props['color']).toBeUndefined()
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props['dimColor']).toBeFalsy()
  })
}
