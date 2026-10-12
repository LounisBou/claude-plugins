// hooks/tests/walkthrough.test.ts
// The guards wired to the engine: a skill's start opens its rules, the user's
// prompt grants, the deny reaches the model in the tool's place, and every
// release (end review, an interrupted turn, the closing line, /clear) lifts them.
import { expect, test } from 'claude-code/testing'

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

test('start-review refuses an edit until the user says fix, then lets it through', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'makes sense')
  const refused: any = await $.tool.call(editCall)
  expect(String(refused.deny ?? refused.text)).toContain('"fix"')
  expect(ran).not.toContain('Edit')
  await say($, 'fix')
  const done: any = await $.tool.call(editCall)
  expect(done.deny).toBeUndefined()
  expect(ran).toContain('Edit')
})

test('the words typed before the skill started grant nothing', async ($, on) => {
  const ran = engine(on)
  await say($, '/pr-review:start-review and fix everything')
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  const refused: any = await $.tool.call(editCall)
  expect(String(refused.deny ?? refused.text)).toContain('"fix"')
  expect(ran).not.toContain('Edit')
})

test('a prompt the user did not type takes back the last grant', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'fix')
  await $.prompt.submit({ text: 'a background task finished', wait: false, origin: { kind: 'task-notification' } })
  const refused: any = await $.tool.call(editCall)
  expect(String(refused.deny ?? refused.text)).toContain('"fix"')
  expect(ran).not.toContain('Edit')
})

test('start-review: pr-comment waits for post now', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await say($, 'post')
  const refused: any = await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 3, body: 'x' } } as any)
  expect(String(refused.deny ?? refused.text)).toContain('"post now"')
  await say($, 'post now')
  await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-comment', args: { pr: 3, body: 'x' } } as any)
  expect(ran).toEqual(['mcp__github__gh:pr-comment'])
})

test('process-comments: git push is refused, the word push lifts it', async ($, on) => {
  const ran = engine(on)
  await $.skill.prompt({ skill: 'pr-review:process-comments', text: '' })
  await say($, '1')
  const refused: any = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as any)
  expect(String(refused.deny ?? refused.text)).toContain('"push"')
  await say($, 'push')
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as any)
  expect(ran).toEqual(['Bash'])
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

test('the resolver route is refused while the github tool is listed', async ($, on) => {
  const ran = engine(on, { listed: ['mcp__github__gh'] })
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  const refused: any = await $.tool.call({ tool: 'Bash', command: 'python3 "/p/scripts/resolve_github.py"' } as any)
  expect(String(refused.deny ?? refused.text)).toContain('mcp__github__gh')
  expect(ran).toEqual([])
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
