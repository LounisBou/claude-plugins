// hooks/tests/walkthrough.test.ts
// The guards wired to the engine: a skill's start opens its rules, the user's
// prompt grants, the deny reaches the model in the tool's place, and every
// release (end review, an interrupted turn, the closing line, /clear) lifts them.
import { expect, test } from 'claude-code/testing'
import { observedAs, watchJournal } from './journal.ts'

const composer = { kind: 'composer' } as const

// The bottom of the chain for one test: a preflight that passes, a skill text,
// tools that answer "ran", and a turn that answers a fixed text.
function engine(on: any, opts: { listed?: string[] } = {}) {
  const ran: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  on('tool.list', () => ({ value: (opts.listed ?? []).map((name) => ({ name })) }))
  on('tool.call', (_$: any, e: any) => {
    ran.push(e.tool + (e.tool === 'mcp__github__gh' ? ':' + e.command : ''))
    return { result: 'ran' }
  })
  on('prompt.submit', (_$: any, e: any) => e)
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  return ran
}

const say = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: composer })
const editCall = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b', replace_all: false } as const

test('with no walkthrough running, an edit goes through', async ($, on) => {
  const ran = engine(on)
  const out: any = await $.tool.call(editCall)
  expect(out.deny).toBeUndefined()
  expect(ran).toContain('Edit')
})

test('start-review lets an edit through before fix and notes it once; after fix it notes nothing', async ($, on) => {
  const ran = engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'makes sense')
  const let_through: any = await $.tool.call(editCall)
  expect(let_through.deny).toBeUndefined()
  expect(ran).toContain('Edit')
  expect(journal().length).toBe(1)
  expect(journal()[0]).toMatchObject(observedAs('pr-review.edit.ungranted'))
  await say($, 'fix')
  await $.tool.call(editCall)
  expect(journal().length).toBe(1)
})

test('the words typed before the skill started grant nothing: the edit is noted', async ($, on) => {
  const ran = engine(on)
  const journal = watchJournal(on)
  await say($, '/pr-review:start-review and fix everything')
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  const out: any = await $.tool.call(editCall)
  expect(out.deny).toBeUndefined()
  expect(ran).toContain('Edit')
  expect(journal().map((e) => e.source.code)).toEqual(['pr-review.edit.ungranted'])
})

test('a prompt the user did not type takes back the last grant: the edit is noted again', async ($, on) => {
  const ran = engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'fix')
  await $.tool.call(editCall)
  expect(journal()).toEqual([])
  await $.prompt.submit({ text: 'a background task finished', wait: false, origin: { kind: 'task-notification' } })
  const out: any = await $.tool.call(editCall)
  expect(out.deny).toBeUndefined()
  expect(ran).toEqual(['Edit', 'Edit'])
  expect(journal().map((e) => e.source.code)).toEqual(['pr-review.edit.ungranted'])
})

test('start-review: a pr-comment before post now goes through and is noted once', async ($, on) => {
  const ran = engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'post')
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 3, body: 'x' } } as any)
  expect(journal().map((e) => e.source.code)).toEqual(['pr-review.publish.ungranted'])
  await say($, 'post now')
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 3, body: 'x' } } as any)
  expect(ran).toEqual(['mcp__github__gh:pr-comment', 'mcp__github__gh:pr-comment'])
  expect(journal().length).toBe(1)
})

test('start-review: a deleted comment is refused whatever the user said but post now', async ($, on) => {
  const ran = engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'yes')
  const refused: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'comment-delete', args: { node_id: 'C' } } as any)
  expect(String(refused.deny ?? refused.text)).toContain('comment-delete')
  expect(ran).toEqual([])
  expect(journal()).toEqual([])
})

test('process-comments: a plain git push goes through and is noted; a forced push asks the user, only their Allow lets it through', async ($, on) => {
  const replies = ['Deny', 'Allow']
  const asked: string[] = []
  // The host's question reaches the chain as an AskUserQuestion call, answered before the engine.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: replies.shift() } } }
  })
  const ran = engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  // « push » in the user's words grants nothing: a plain push goes through, and is noted.
  await say($, 'push')
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as any)
  expect(ran).toEqual(['Bash'])
  expect(asked).toEqual([])
  expect(journal().map((e) => e.source.code)).toEqual(['pr-review.push.ungranted'])
  // A forced push is the user's to allow.
  const refused: any = await $.tool.call({ tool: 'Bash', command: 'git push --force origin HEAD' } as any)
  expect(String(refused.deny ?? refused.text)).toContain('unless the user allows it when asked')
  expect(ran).toEqual(['Bash'])
  await $.tool.call({ tool: 'Bash', command: 'git push --force origin HEAD' } as any)
  expect(ran).toEqual(['Bash', 'Bash'])
  expect(asked.length).toBe(2)
  expect(journal().length).toBe(1)
})

test('end review lifts the rules at once', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'end review')
  await $.tool.call(editCall)
  expect(ran).toEqual(['Edit'])
})

test('an interrupted turn lifts the rules', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'next')
  await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't1', durationMs: 1 } as any)
  await $.tool.call(editCall)
  expect(ran).toEqual(['Edit'])
})

test("the skill's closing line lifts the rules", async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await $.turn.complete({ reason: 'answer', answer: 'x\n## Walkthrough complete\n', isAborted: false, turnId: 't1', durationMs: 1 } as any)
  await $.tool.call(editCall)
  expect(ran).toEqual(['Edit'])
})

test('a /clear lifts the rules', async ($, on) => {
  const ran = engine(on)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as any)
  await $.tool.call(editCall)
  expect(ran).toEqual(['Edit'])
})

test('auto-fix-loop replaces a walkthrough and edits freely', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await $.skill.prompt({ skill: 'pr-review:auto-fix-loop', text: '' })
  await $.tool.call(editCall)
  expect(ran).toEqual(['Edit'])
})

test('the resolver route goes through while the github tool is listed, and is noted', async ($, on) => {
  const ran = engine(on, { listed: ['mcp__github__gh'] })
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  const out: any = await $.tool.call({ tool: 'Bash', command: 'python3 "/p/scripts/resolve_github.py"' } as any)
  expect(out.deny).toBeUndefined()
  expect(ran).toEqual(['Bash'])
  expect(journal()).toMatchObject([observedAs('pr-review.resolver-route.listed')])
})

test('the resolver route stays open where the github tool is not listed', async ($, on) => {
  const ran = engine(on, { listed: [] })
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await $.tool.call({ tool: 'Bash', command: 'python3 "/p/scripts/resolve_github.py"' } as any)
  expect(ran).toEqual(['Bash'])
})

// ── the band ─────────────────────────────────────────────────────────────────

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10 } as any

// What draws beneath the plugin: another plugin's band, kept under this one's line.
// (A Text keeps no key once drawn, so the tests find each line by its text.)
function below(on: any) {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ key: 'below', children: ['another band'] })
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band says a walkthrough holds the session, and how to end it`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }, { name: 'comment-2.md' }, { name: 'commit-1.msg' }] }))
    await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-2.md', content: 'x' } as any)
    const ui: any = await $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 40 } } as any)
    const line = await ui.find({ type: 'Text', text: 'pr-review ·' })
    expect(String(line?.text ?? '')).toContain('pr-review · start-review · kept 2 · prepared commits 1')
    expect(String(line?.text ?? '')).toContain('"end review"')
    expect(await ui.find({ type: 'Text', text: 'another band' })).toBeTruthy()
  })

  test(`${surface}: no band while nothing holds the session`, async ($, on) => {
    engine(on)
    below(on)
    const ui: any = await $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 40 } } as any)
    expect(await ui.findAll({ type: 'Text', text: 'pr-review ·' })).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'another band' })).toBeTruthy()
  })
}

// ── the band's colours ───────────────────────────────────────────────────────

async function mountBand($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'pr-review', surface, component: 'AbovePrompt', props: BAND, viewport: { columns: 60, rows: 40 } } as any)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band's head is bold, the count green, the commit yellow, the rest plain`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }, { name: 'comment-2.md' }, { name: 'commit-1.msg' }] }))
    await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-2.md', content: 'x' } as any)
    const ui: any = await mountBand($, surface)
    const head: any = await ui.find({ type: 'Text', text: /^pr-review · start-review$/ })
    expect(head?.props.bold).toBe(true)
    const kept: any = await ui.find({ type: 'Text', text: /^kept 2$/ })
    expect(kept?.props.color).toBe('success')
    const prepared: any = await ui.find({ type: 'Text', text: /^prepared commits 1 \(say commit or drop\)$/ })
    expect(prepared?.props.color).toBe('warning')
    const lift: any = await ui.find({ type: 'Text', text: /^"end review" to lift$/ })
    expect(lift).toBeTruthy()
    expect(lift.props.color).toBeUndefined()
    expect(lift.props.dimColor).toBeFalsy()
    expect(await ui.findAll({ type: 'Text', text: 'lifts its rules' })).toEqual([])
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props.dimColor).toBeFalsy()
  })

  test(`${surface}: the process-comments band has no kept count`, async ($, on) => {
    engine(on)
    below(on)
    on('fs.list', () => ({ value: [{ name: 'comment-1.md' }] }))
    await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-pr-review-4/comment-1.md', content: 'x' } as any)
    const ui: any = await mountBand($, surface)
    expect(((await ui.find({ type: 'Text', text: /^pr-review · process-comments$/ })) as any)?.props.bold).toBe(true)
    expect(await ui.findAll({ type: 'Text', text: 'kept' })).toEqual([])
    expect(await ui.find({ type: 'Text', text: /^"end review" to lift$/ })).toBeTruthy()
  })

  test(`${surface}: the auto-fix-loop band has a bold head and a plain body`, async ($, on) => {
    engine(on)
    below(on)
    await $.skill.prompt({ skill: 'pr-review:auto-fix-loop', text: '' })
    await $.tool.call({ tool: 'mcp__pr-review__loop', action: 'start', test_command: 'npm test' } as any)
    const ui: any = await mountBand($, surface)
    const head: any = await ui.find({ type: 'Text', text: /^pr-review · auto-fix-loop$/ })
    expect(head?.props.bold).toBe(true)
    const body: any = await ui.find({ type: 'Text', text: /^0 fixes committed$/ })
    expect(body).toBeTruthy()
    expect(body.props.color).toBeUndefined()
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props.dimColor).toBeFalsy()
  })
}
