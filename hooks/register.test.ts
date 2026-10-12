import { expect, test } from 'claude-code/testing'
import { TOOL } from './register.ts'

const FIXTURE = `**Codename**: demo
**Bump**: minor
**Base**: abc1234

| phase | title | status | milestone |
|---|---|---|---|
| 01 | the skeleton | done | 82525e4 |
| 02 | the core | doing | 9f31a0c |
| 03 | the cycle | todo |  |
`

type World = {
  enabled?: Record<string, unknown>
  branch?: string
  inside?: boolean
  ignored?: boolean
  files?: Record<string, string>
}

// The repository, the settings and the files beneath the plugin, from memory.
// Every Bash, Edit or Agent call that reaches the bottom is recorded as ran.
async function world(on: any, w: World = {}, specs: any[] = []) {
  const ran: any[] = []
  const writes: Record<string, string> = {}
  const files = { 'docs/features/demo/IMPLEMENTATION.md': FIXTURE, ...(w.files ?? {}) }
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$: any, e: any) => { specs.push(e); return { value: undefined } })
  on('settings.read', () => ({ value: { enabledPlugins: w.enabled ?? { 'superpowers@claude-plugins-official': true } } }))
  on('process.run', (_$: any, e: any) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const no = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args === 'rev-parse --is-inside-work-tree') return w.inside === false ? no : ok('true')
    if (args === 'branch --show-current') return ok(w.branch ?? 'feat/demo')
    if (args.startsWith('check-ignore')) return w.ignored === false ? no : ok()
    if (args === 'rev-parse --short HEAD') return ok('fedcba9')
    if (args === 'status --porcelain') return ok('')
    return no
  })
  // The engine hands a relative path over resolved against the working directory.
  const rel = (path: string) => {
    const at = path.indexOf('/docs/features/')
    return path.startsWith('/elsewhere/') || at < 0 ? path.replace(/^.*\/(\.implement\.json)$/, '$1') : path.slice(at + 1)
  }
  on('fs.read', (_$: any, e: any) => {
    const text = writes[rel(e.path)] ?? files[rel(e.path)]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_$: any, e: any) => { writes[rel(e.path)] = e.text; return { value: undefined } })
  on('tool.call', (_$: any, e: any) => { ran.push(e); return { result: 'ran' } })
  on('attribution.text', (_$: any, e: any) => ({ text: e.text }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ key: 'engine', children: ['the engine band'] })
  })
  return { ran, writes }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const skill = ($: any, name: string) => $.skill.prompt({ skill: `implement:${name}`, text: 'THE SKILL' })
const typed = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const turnEnd = ($: any, isAborted: boolean) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })
const refused = (out: any) => typeof out?.deny === 'string' && out.deny.length > 0

test('the state tool is registered in the tool list from the first turn', async ($, on) => {
  const specs: any[] = []
  await world(on, {}, specs)
  await start($)
  expect(specs.map(s => s.name)).toContain('state')
  expect(specs.find(s => s.name === 'state').isDeferred).toBe(false)
})

test('install and doctor answer from the merged settings without a model turn', async ($, on) => {
  await world(on, { enabled: { 'superpowers@claude-plugins-official': true } })
  await start($)
  expect((await $.command.run({ command: 'implement:doctor', args: '' })).text)
    .toBe('ready: superpowers@claude-plugins-official enabled, git repository on feat/demo')
  expect((await $.command.run({ command: 'implement:install', args: '' })).text).toContain('ready:')
})

test('doctor names a disabled dependency with its fix', async ($, on) => {
  await world(on, { enabled: { 'superpowers@claude-plugins-official': false } })
  await start($)
  const { text } = await $.command.run({ command: 'implement:doctor', args: '' })
  expect(text).toContain('error: required plugin not installed or not enabled: superpowers@claude-plugins-official')
  expect(text).toContain('fix:   /plugin install superpowers@claude-plugins-official')
})

test('a failed preflight replaces the skill text with the stop', async ($, on) => {
  await world(on, { inside: false })
  await start($)
  const { text } = await skill($, 'phase')
  expect(text).not.toContain('THE SKILL')
  expect(text).toContain('error: not a git repository with a current branch')
})

test('a passed preflight leads the skill text with the derived state', async ($, on) => {
  await world(on)
  await start($)
  const { text } = await skill($, 'phase')
  expect(text.startsWith('Preflight: passed')).toBe(true)
  expect(text).toContain('docs docs/features/demo')
  expect(text).toContain('next phase 02 doing (milestone 9f31a0c)')
  expect(text.endsWith('THE SKILL')).toBe(true)
  // feature and prepare read no state.
  expect((await skill($, 'prepare')).text).not.toContain('State,')
})

test('another plugin\'s skill passes through untouched', async ($, on) => {
  await world(on)
  await start($)
  expect((await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'B' })).text).toBe('B')
})

test('the state tool gets the state, and marks a row with the head', async ($, on) => {
  const { writes } = await world(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  const got = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'get' } as any)).result))
  expect(got.codename).toBe('demo')
  expect(got.guard).toBe('ok')
  expect(got.next.phase).toBe('02')
  const marked = await $.tool.call({ tool: TOOL, action: 'mark', phase: 2, status: 'done' } as any)
  expect(JSON.parse(String(marked.result)).row).toEqual({ phase: '02', title: 'the core', status: 'done', milestone: 'fedcba9' })
  expect(writes['docs/features/demo/IMPLEMENTATION.md']).toContain('| 02 | the core | done | fedcba9 |')
  expect(writes['docs/features/demo/IMPLEMENTATION.md']).toContain('| 03 | the cycle | todo |  |')
})

test('the state tool follows --docs and skips the ignore guard', async ($, on) => {
  await world(on, { ignored: false, files: { '/elsewhere/IMPLEMENTATION.md': FIXTURE } })
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  const got = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'get', docs: '/elsewhere/' } as any)).result))
  expect(got.docs).toBe('/elsewhere')
  expect(got.guard).toBe('artifacts path given, ignore guard skipped')
  expect(got.stateFile).toBe('present')
})

test('a permission rule that denies the state tool is honoured', async ($, on) => {
  const { writes } = await world(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'no state here' }))
  await start($)
  const out = await $.tool.call({ tool: TOOL, action: 'mark', phase: 2, status: 'done' } as any)
  expect(refused(out)).toBe(true)
  expect(Object.keys(writes)).toEqual([])
})

test('a phase run refuses a push and lets every other command through', async ($, on) => {
  const { ran } = await world(on)
  await start($)
  await skill($, 'phase')
  expect(refused(await bash($, 'git push origin feat/demo'))).toBe(true)
  expect((await bash($, 'git commit -m "never git push here"')).result).toBe('ran')
  expect((await bash($, 'bash tests/run-tests.sh')).result).toBe('ran')
  expect(ran.map(e => e.command)).toEqual(['git commit -m "never git push here"', 'bash tests/run-tests.sh'])
})

test('the github tool\'s pull request writes are refused, its reads are not', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'close')
  expect(refused(await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-create' } as any))).toBe(true)
  expect((await $.tool.call({ tool: 'mcp__github__gh', command: 'pr-get' } as any)).result).toBe('ran')
})

test('a phase dispatches Explore only', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'phase')
  expect(refused(await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'write it', description: 'x' } as any))).toBe(true)
  expect((await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', prompt: 'find it', description: 'x' } as any)).result).toBe('ran')
})

test('the guard stays armed across turns and releases on the user\'s words', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'phase')
  await turnEnd($, false)                     // stopped on a question
  await typed($, 'go on with the next phase')
  expect(refused(await bash($, 'git push'))).toBe(true)
  await typed($, 'good, push the branch now')
  expect((await bash($, 'git push')).result).toBe('ran')
})

test('an aborted turn releases the guard', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'phase')
  await turnEnd($, true)
  expect((await bash($, 'git push')).result).toBe('ran')
})

test('/implement:release-guard releases the guard without a model turn', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'close')
  const { text } = await $.command.run({ command: 'implement:release-guard', args: '' })
  expect(text).toContain('released')
  expect((await bash($, 'gh pr create --fill')).result).toBe('ran')
})

test('nothing is guarded before a skill, nor after feature took over', async ($, on) => {
  await world(on)
  await start($)
  expect((await bash($, 'git push')).result).toBe('ran')
  await skill($, 'phase')
  await skill($, 'feature')
  expect((await bash($, 'git push')).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'p', description: 'x' } as any)).result).toBe('ran')
})

test('a check refuses edits until its verdict, then the phase writes again', async ($, on) => {
  await world(on)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '| check | evidence | result |\n|---|---|---|\n| 4 gate | exit 0 | PASS |\n\nPASS\nDONE', toolUses: [], stopReason: 'end_turn', usage: {} }
  })
  await start($)
  await skill($, 'phase')
  await skill($, 'check')
  expect(refused(await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any))).toBe(true)
  expect(refused(await bash($, 'git add -A'))).toBe(true)
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any) as any
  for await (const _ of stream) { /* drained */ }
  await stream
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any)).result).toBe('ran')
  expect(refused(await bash($, 'git push'))).toBe(true)   // the phase is still armed
})

test('a check alone ends with its turn', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'check')
  expect(refused(await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as any))).toBe(true)
  await turnEnd($, false)
  expect((await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as any)).result).toBe('ran')
})

test('the commit trailer is empty while a phase runs, the engine\'s otherwise', async ($, on) => {
  await world(on)
  await start($)
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('Co-Authored-By: x')
  await skill($, 'phase')
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('')
})

test('a guard that cannot read its state refuses only an outward action', async ($, on) => {
  await world(on)
  on('state.get', () => ({ deny: 'no state' }))
  await start($)
  expect((await bash($, 'ls')).result).toBe('ran')
  expect(refused(await bash($, 'git push'))).toBe(true)
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any)).result).toBe('ran')
})

const BAND_SITE = {
  plugin: 'implement',
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

test('the band draws the phase run, and nothing outside one', async ($, on) => {
  await world(on)
  await start($)
  await skill($, 'phase')
  const ui = await $.ui.mount({ ...BAND_SITE } as any)
  expect(await ui.find({ type: 'Text', text: 'implement:phase demo · phase 02/03 doing: the core · base 9f31a0c · head fedcba9' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'implement:release-guard', args: '' })
  const quiet = await $.ui.mount({ ...BAND_SITE } as any)
  expect(await quiet.find({ type: 'Text', text: /implement:phase/ })).toBeUndefined()
  expect(await quiet.find({ type: 'Text', text: 'the engine band' })).toBeDefined()
  await quiet.unmount()
})
