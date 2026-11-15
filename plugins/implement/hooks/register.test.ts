import { expect, test } from 'claude-code/testing'
import { TOOL } from './register.ts'
import { METHOD_LINE } from './core.ts'
import { parseJournalEvent } from '../core/learning.ts'

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
  env?: Record<string, string>       // the session's variables, beside HOME
  journalError?: string               // the journal's writes fail with this
  logged?: string[]                   // the lines the module logs
}

// The repository, the settings and the files beneath the plugin, from memory.
// Every Bash, Edit or Agent call that reaches the bottom is recorded as ran, and every line the
// module leaves in its journal is read back as an event.
async function world(on: any, w: World = {}, specs: any[] = []) {
  const ran: any[] = []
  const journal: any[] = []
  const writes: Record<string, string> = {}
  const files = { 'docs/features/demo/IMPLEMENTATION.md': FIXTURE, ...(w.files ?? {}) }
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$: any, e: any) => { specs.push(e); return { value: undefined } })
  on('settings.read', () => ({ value: { enabledPlugins: w.enabled ?? { 'superpowers@claude-plugins-official': true } } }))
  on('process.run', (_$: any, e: any) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const no = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'mv') return ok()
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
  on('env.get', (_$: any, e: any) => ({ value: { HOME: '/home/op', ...w.env }[e.name as string] }))
  on('ui.log', (_$: any, e: any) => { w.logged?.push(String(e.text)); return { value: undefined } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$: any, e: any) => {
    if (String(e.path).startsWith(JOURNAL) && w.journalError !== undefined) return { deny: w.journalError }
    if (String(e.path).startsWith(JOURNAL)) journal.push(JSON.parse(String(e.text)))
    else writes[rel(e.path)] = e.text
    return { value: undefined }
  })
  on('tool.call', (_$: any, e: any) => { ran.push(e); return { result: 'ran' } })
  on('attribution.text', (_$: any, e: any) => ({ text: e.text }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ key: 'engine', children: ['the engine band'] })
  })
  return { ran, writes, journal }
}

// What a line of the module's journal holds for an observed guard: its code, as the source and as
// the refusal it would have been.
const JOURNAL = '/home/op/.claude/implement/journal/'
const observedAs = (code: string) => ({
  kind: 'escape', source: { plugin: 'implement', code }, evidence: [{ type: 'refusal', code }], context: { session: 'sess-1' },
})

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const skill = ($: any, name: string) => $.skill.prompt({ skill: `implement:${name}`, text: 'THE SKILL' })
const typed = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const turnEnd = ($: any, isAborted: boolean) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })
const agent = ($: any, type: string) => $.tool.call({ tool: 'Agent', subagent_type: type, prompt: 'p', description: 'x' } as any)
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
    .toBe('ready: superpowers@claude-plugins-official enabled')
  expect((await $.command.run({ command: 'implement:install', args: '' })).text).toContain('ready:')
})

test('install and doctor pass outside a git repository, where a skill refuses', async ($, on) => {
  await world(on, { inside: false })
  await start($)
  for (const command of ['implement:install', 'implement:doctor']) {
    expect((await $.command.run({ command, args: '' })).text).toBe('ready: superpowers@claude-plugins-official enabled')
  }
  const { text } = await skill($, 'feature')
  expect(text).toContain('error: not a git repository with a current branch')
  expect(text).toContain('fix:   run this from inside a git repository, on a branch')
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

test('a phase run lets every outward command through', async ($, on) => {
  const { ran } = await world(on)
  await start($)
  await skill($, 'phase')
  const commands = ['git push origin feat/demo', 'git push --force origin main', 'git merge other', 'gh pr create --draft', 'gh pr merge 3',
    'git commit -m "never git push here"', 'bash tests/run-tests.sh']
  for (const command of commands) expect((await bash($, command)).result).toBe('ran')
  expect(ran.map(e => e.command)).toEqual(commands)
})

test('the github tool\'s pull request writes and reads all run', async ($, on) => {
  await world(on)
  await start($)
  for (const name of ['phase', 'close']) {
    await skill($, name)
    for (const command of ['pr-create', 'pr-merge', 'pr-ready', 'pr-get']) {
      expect((await $.tool.call({ tool: 'mcp__github__gh', command } as any)).result).toBe('ran')
    }
  }
})

test('a phase lets every subagent run, and the journal keeps one line for each that is not a search', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  await skill($, 'phase')
  expect((await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', prompt: 'find it', description: 'x' } as any)).result).toBe('ran')
  expect(journal).toEqual([])
  expect((await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'write it', description: 'x' } as any)).result).toBe('ran')
  expect(journal).toMatchObject([observedAs('implement.phase.subagent')])
})

test('an allowed subagent call reaches the host with its input unchanged', async ($, on) => {
  const { ran } = await world(on)
  await start($)
  await skill($, 'phase')
  const input = { tool: 'Agent', subagent_type: 'Explore', prompt: 'find it', description: 'x', run_in_background: true }
  expect((await $.tool.call({ ...input } as any)).result).toBe('ran')
  // The host stamps the call's id; every other field is the emitted input, nothing added or changed.
  const { tool_use_id, ...reached } = ran[0]
  expect(tool_use_id).toBeDefined()
  expect(reached).toEqual(input)
})

test('the observation stays armed across turns, asks nobody, and words change nothing', async ($, on) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    asked.push(e.questions[0].question)
    return { result: { questions: e.questions, answers: {} } }
  })
  const { journal } = await world(on)
  await start($)
  await skill($, 'phase')
  await turnEnd($, false)                     // stopped on a question
  await typed($, 'good, use a subagent now')
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect(asked).toEqual([])
  expect(journal.map(e => e.source.code)).toEqual(['implement.phase.subagent', 'implement.phase.subagent'])
})

test('in a session the orchestrator spawned, a subagent runs as anywhere, with no dialog and one line', async ($, on) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    asked.push(e.questions[0].question)
    return { result: { questions: e.questions, answers: {} } }
  })
  const { journal } = await world(on, { env: { ORCHESTRATOR_SPAWNED: '1' } })
  await start($)
  await skill($, 'phase')
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect(asked).toEqual([])
  expect(journal).toMatchObject([observedAs('implement.phase.subagent')])
})

test('an aborted turn releases the observation', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  await skill($, 'phase')
  await agent($, 'general-purpose')
  expect(journal.length).toBe(1)
  await turnEnd($, true)
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect(journal.length).toBe(1)
})

test('/implement:release-guard releases the observation without a model turn', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  await skill($, 'phase')
  await agent($, 'general-purpose')
  expect(journal.length).toBe(1)
  const { text } = await $.command.run({ command: 'implement:release-guard', args: '' })
  expect(text).toContain('released')
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect(journal.length).toBe(1)
})

test('the line is an event core reads, and holds neither the path, the command nor the text of the call', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  await skill($, 'check')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/secret-name.ts', old_string: 'a', new_string: 'hunter2' } as any)
  await bash($, 'echo hunter2 > /repo/secret-out.txt')
  expect(journal.length).toBe(2)
  for (const event of journal) expect(parseJournalEvent(event)).toEqual(event)
  expect(JSON.stringify(journal)).not.toMatch(/secret|hunter2|\/repo/)
})

test('a journal that cannot be written is one line in the log, and the call goes through', async ($, on) => {
  const logged: string[] = []
  const { ran } = await world(on, { journalError: 'disk full', logged })
  await start($)
  await skill($, 'check')
  const out: any = await bash($, 'cp a b')
  expect(out.result).toBe('ran')
  expect(ran.map(e => e.command)).toEqual(['cp a b'])
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('the journal could not be written or pruned')
  expect(logged[0]).toContain('disk full')
})

test('nothing is observed before a skill, nor after feature took over', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  await skill($, 'phase')
  await skill($, 'feature')
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect(journal).toEqual([])
})

test('a check lets an edit and a stage through, one line each, until its verdict, then the phase writes again', async ($, on) => {
  const { journal } = await world(on)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '| check | evidence | result |\n|---|---|---|\n| 4 gate | exit 0 | PASS |\n\nPASS\nDONE', toolUses: [], stopReason: 'end_turn', usage: {} }
  })
  await start($)
  await skill($, 'phase')
  await skill($, 'check')
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any)).result).toBe('ran')
  expect((await bash($, 'git add -A')).result).toBe('ran')
  expect(journal).toMatchObject([observedAs('implement.check.edit'), observedAs('implement.check.stage')])
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any) as any
  for await (const _ of stream) { /* drained */ }
  await stream
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any)).result).toBe('ran')
  expect(journal.length).toBe(2)
  await agent($, 'general-purpose')   // the phase is still armed
  expect(journal.map(e => e.source.code)).toEqual(['implement.check.edit', 'implement.check.stage', 'implement.phase.subagent'])
})

test('a check refuses a removal unrun and leaves no line; a phase lets it run', async ($, on) => {
  const { ran, journal } = await world(on)
  await start($)
  await skill($, 'phase')
  expect((await bash($, 'rm tmp.txt')).result).toBe('ran')
  await skill($, 'check')
  for (const command of ['rm src/a.ts', 'git add a && rmdir out']) {
    const out: any = await bash($, command)
    expect(refused(out)).toBe(true)
    expect(out.deny).toContain('implement:check removes nothing')
  }
  expect(ran.map(e => e.command)).toEqual(['rm tmp.txt'])
  expect(journal).toEqual([])
})

test('a shell line the reader cannot read is observed during a check, and runs once during a phase', async ($, on) => {
  const { ran, journal } = await world(on)
  await start($)
  await skill($, 'phase')
  const hidden = 'git {add,-A}{1..1001}'
  expect((await bash($, hidden)).result).toBe('ran')
  expect(ran.filter(e => e.command === hidden).length).toBe(1)
  expect(journal).toEqual([])
  await skill($, 'check')
  expect((await bash($, hidden)).result).toBe('ran')
  expect(ran.filter(e => e.command === hidden).length).toBe(2)
  expect(journal).toMatchObject([observedAs('implement.check.unreadable')])
})

test('a check alone ends with its turn', async ($, on) => {
  const { journal } = await world(on)
  await start($)
  await skill($, 'check')
  expect((await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as any)).result).toBe('ran')
  expect(journal).toMatchObject([observedAs('implement.check.edit')])
  await turnEnd($, false)
  expect((await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as any)).result).toBe('ran')
  expect(journal.length).toBe(1)
})

test('the commit trailer is empty while a phase runs, the engine\'s otherwise', async ($, on) => {
  await world(on)
  await start($)
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('Co-Authored-By: x')
  await skill($, 'phase')
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('')
})

test('a guard that cannot read its state refuses nothing', async ($, on) => {
  const { journal } = await world(on)
  on('state.get', () => ({ deny: 'no state' }))
  await start($)
  for (const command of ['ls', 'git push', 'git push --force origin main', 'git merge other', 'gh pr create --fill', 'gh pr merge 3']) {
    expect((await bash($, command)).result).toBe('ran')
  }
  for (const command of ['pr-create', 'pr-merge']) {
    expect((await $.tool.call({ tool: 'mcp__github__gh', command } as any)).result).toBe('ran')
  }
  expect((await agent($, 'general-purpose')).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as any)).result).toBe('ran')
  expect(journal).toEqual([])
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
  // The band's own node, so the texts of other components (the engine's band) stay out.
  const band = await ui.find({ type: 'Box', key: 'implement' })
  expect(band).toBeDefined()
  const pieces: any[] = band.children.map((c: any) => ({ text: c.children.join(''), props: c.props }))
  expect(pieces.map(t => t.text).join('')).toBe('implement:phase demo · phase 02/03 doing: the core · base 9f31a0c · head fedcba9')
  const piece = (text: string) => pieces.find(t => t.text.startsWith(text))!.props
  expect(piece('implement:phase demo').bold).toBe(true)
  expect(piece('doing').color).toBe('warning')
  expect(piece('head fedcba9').dimColor).toBe(true)
  await ui.unmount()
  await $.command.run({ command: 'implement:release-guard', args: '' })
  const quiet = await $.ui.mount({ ...BAND_SITE } as any)
  expect(await quiet.find({ type: 'Text', text: /implement:phase/ })).toBeUndefined()
  expect(await quiet.find({ type: 'Box', key: 'implement' })).toBeUndefined()
  expect(await quiet.find({ type: 'Text', text: 'the engine band' })).toBeDefined()
  await quiet.unmount()
})

test('a skill points at the method until the session loads it, then no more', async ($, on) => {
  await world(on)
  await start($)
  expect((await skill($, 'feature')).text).toContain(METHOD_LINE)
  expect((await $.skill.prompt({ skill: 'method:lifecycle', text: 'KERNEL' })).text).toBe('KERNEL')
  expect((await skill($, 'phase')).text).not.toContain(METHOD_LINE)
})

// ── /implement:review ────────────────────────────────────────────────────────

const RECORD = JSON.stringify({ plugins: { 'orchestrator@lounisbou': [{ installPath: '/cache/orchestrator/0.60.0' }] } })
const LAUNCHER = '/cache/orchestrator/0.60.0/skills/iterm-agents/scripts/iterm-agent.sh'

// A machine: its system, its install record, whether the launcher exists, what it answers.
function machine(on: any, m: { system: string; record?: string; launcher?: boolean; spawn?: { exitCode: number; stdout: string; stderr: string }; branch?: string }) {
  const runs: string[][] = []
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  on('env.get', (_$: any, e: any) => ({ value: { HOME: '/home/op' }[e.name as string] }))
  on('fs.read', (_$: any, e: any) => (e.path === '/home/op/.claude/plugins/installed_plugins.json' && m.record !== undefined ? { value: m.record } : { deny: 'ENOENT' }))
  on('fs.exists', (_$: any, e: any) => ({ value: m.launcher === true && e.path === LAUNCHER }))
  on('process.run', (_$: any, e: any) => {
    runs.push([...e.argv])
    const args = e.argv.join(' ')
    if (args === 'git branch --show-current') return ok(m.branch ?? 'feat/demo')
    if (args === 'git rev-parse --show-toplevel') return ok('/work')
    if (args === 'uname -s') return ok(m.system)
    if (e.argv[0] === LAUNCHER) return { value: m.spawn ?? { exitCode: 0, stdout: 'spawned\n/dev/ttys004', stderr: '' } }
    return ok()
  })
  return runs
}

const review = ($: any) => $.command.run({ command: 'implement:review', args: '' } as any)

test('on macOS with the orchestrator, the reviewer opens in iTerm through its launcher', async ($, on) => {
  const runs = machine(on, { system: 'Darwin', record: RECORD, launcher: true })
  const out: any = await review($)
  const spawn = runs.find(argv => argv[0] === LAUNCHER) ?? []
  expect(spawn.slice(0, 6)).toEqual([LAUNCHER, 'spawn', '--dir', '/work', '--title', 'Agent: review demo'])
  expect(spawn[7]).toContain('"review_only": true')
  expect(String(out.text)).toContain('launched in iTerm on /dev/ttys004')
})

test('a launcher that refuses is said as it stands, and nothing is launched another way', async ($, on) => {
  const runs = machine(on, { system: 'Darwin', record: RECORD, launcher: true, spawn: { exitCode: 2, stdout: '', stderr: 'no iTerm2 running' } })
  const out: any = await review($)
  expect(String(out.text)).toContain('The launcher refused the reviewer (exit 2): no iTerm2 running')
  expect(runs.some(argv => argv[0] === 'sh')).toBe(false)
})

test('elsewhere, or without the launcher, the reviewer runs headless with its report in a log', async ($, on) => {
  const runs = machine(on, { system: 'Linux', record: RECORD, launcher: true })
  const out: any = await review($)
  const headless = runs.find(argv => argv[0] === 'sh') ?? []
  expect(headless[2]).toContain('claude -p "$1" --permission-mode auto')
  expect(headless[5]).toBe('/work/.git/implement-review.log')
  expect(runs.some(argv => argv[0] === LAUNCHER)).toBe(false)
  expect(String(out.text)).toContain('launched headless')
})

test('the headless reviewer starts with Remote Control off', async ($, on) => {
  const runs = machine(on, { system: 'Linux', record: RECORD, launcher: true })
  await review($)
  const headless = runs.find(argv => argv[0] === 'sh') ?? []
  expect(headless[2]).toContain(`--settings '{"remoteControlAtStartup":false}'`)
})

test('a macOS without the orchestrator installed runs the reviewer headless too', async ($, on) => {
  const runs = machine(on, { system: 'Darwin' })
  await review($)
  expect(runs.some(argv => argv[0] === 'sh')).toBe(true)
})

test('outside a branch, nothing is launched', async ($, on) => {
  const runs = machine(on, { system: 'Linux', branch: '' })
  const out: any = await review($)
  expect(String(out.text)).toContain('needs a git repository on a branch')
  expect(runs.some(argv => argv[0] === 'sh')).toBe(false)
})
