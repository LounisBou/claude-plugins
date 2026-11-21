import { expect, test } from 'claude-code/testing'
import type { Engine, Reply, TestOn } from 'claude-code/testing'
import { TOOL } from './register.ts'
import { METHOD_LINE } from './core.ts'
import { fieldsOf, listOf, type Events, type ToolSpec } from '../core/host.ts'
import { SPAWN_TIMEOUT_MS } from '../core/orchestration.ts'

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
  logged?: string[]                   // the lines the module logs
  exists?: string[]                   // the paths that exist, beside the files
  runs?: string[][]                   // every command line run
  node?: { exitCode: number; stdout: string; stderr: string }   // what a node script answers
}

// The repository, the settings and the files beneath the plugin, from memory.
// Every Bash or Edit call that reaches the bottom is recorded as ran.
async function world(on: TestOn, w: World = {}, specs: ToolSpec[] = []) {
  const ran: Events['tool.call'][] = []
  const writes: Record<string, string> = {}
  const files: Record<string, string> = { 'docs/features/demo/IMPLEMENTATION.md': FIXTURE, ...(w.files ?? {}) }
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => { specs.push(e); return { value: undefined } })
  on('settings.read', () => ({ value: { enabledPlugins: w.enabled ?? { 'superpowers@claude-plugins-official': true } } }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const no = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    w.runs?.push([...e.argv])
    if (e.argv[0] === 'mv') return ok()
    if (e.argv[0] === 'node') return { value: { isStdoutTruncated: false, isStderrTruncated: false, ...(w.node ?? { exitCode: 0, stdout: '', stderr: '' }) } }
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
  on('fs.read', (_$, e) => {
    const text = writes[rel(e.path)] ?? files[rel(e.path)]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('env.get', (_$, e) => ({ value: { HOME: '/home/op', ...w.env }[e.name] }))
  on('fs.exists', (_$, e) => ({ value: w.exists?.includes(String(e.path)) ?? false }))
  on('ui.log', (_$, e) => { w.logged?.push(String(e.text)); return { value: undefined } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$, e) => {
    writes[rel(e.path)] = e.text
    return { value: undefined }
  })
  on('tool.call', (_$, e) => { ran.push(e); return { result: 'ran' } })
  on('attribution.text', (_$, e) => ({ text: e.text }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ key: 'engine', children: ['the engine band'] })
  })
  return { ran, writes }
}

const start = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const skill = ($: Engine, name: string) => $.skill.prompt({ skill: `implement:${name}`, text: 'THE SKILL' })
const turnEnd = ($: Engine, isAborted: boolean) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const refused = (out: Reply) => typeof out.deny === 'string' && out.deny.length > 0

test('the state tool is registered in the tool list from the first turn', async ($, on) => {
  const specs: ToolSpec[] = []
  await world(on, {}, specs)
  await start($)
  expect(specs.map(s => s.name)).toContain('state')
  expect(specs.find(s => s.name === 'state')?.isDeferred).toBe(false)
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
  expect(text?.startsWith('Preflight: passed')).toBe(true)
  expect(text).toContain('docs docs/features/demo')
  expect(text).toContain('next phase 02 doing (milestone 9f31a0c)')
  expect(text?.endsWith('THE SKILL')).toBe(true)
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
  const got = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'get' })).result))
  expect(got.codename).toBe('demo')
  expect(got.guard).toBe('ok')
  expect(got.next.phase).toBe('02')
  const marked = await $.tool.call({ tool: TOOL, action: 'mark', phase: 2, status: 'done' })
  expect(JSON.parse(String(marked.result)).row).toEqual({ phase: '02', title: 'the core', status: 'done', milestone: 'fedcba9' })
  expect(writes['docs/features/demo/IMPLEMENTATION.md']).toContain('| 02 | the core | done | fedcba9 |')
  expect(writes['docs/features/demo/IMPLEMENTATION.md']).toContain('| 03 | the cycle | todo |  |')
})

test('the state tool follows --docs and skips the ignore guard', async ($, on) => {
  await world(on, { ignored: false, files: { '/elsewhere/IMPLEMENTATION.md': FIXTURE } })
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  const got = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'get', docs: '/elsewhere/' })).result))
  expect(got.docs).toBe('/elsewhere')
  expect(got.guard).toBe('artifacts path given, ignore guard skipped')
  expect(got.stateFile).toBe('present')
})

test('a permission rule that denies the state tool is honoured', async ($, on) => {
  const { writes } = await world(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'no state here' }))
  await start($)
  const out = await $.tool.call({ tool: TOOL, action: 'mark', phase: 2, status: 'done' })
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
  expect(ran.map(e => e['command'])).toEqual(commands)
})

test('a check lets every call through, a removal and a write included', async ($, on) => {
  const { ran } = await world(on)
  await start($)
  await skill($, 'check')
  const commands = ['rm -rf build', 'rmdir out', 'git add -A', 'git commit -m "x"', 'echo x > notes.md', 'cat f | sh']
  for (const command of commands) expect((await bash($, command)).result).toBe('ran')
  expect(ran.map(e => e['command'])).toEqual(commands)
})

test('the github tool\'s pull request writes and reads all run', async ($, on) => {
  await world(on)
  await start($)
  for (const name of ['phase', 'close']) {
    await skill($, name)
    for (const command of ['pr-create', 'pr-merge', 'pr-ready', 'pr-get']) {
      expect((await $.tool.call({ tool: 'mcp__github__gh', command })).result).toBe('ran')
    }
  }
})

test('the commit trailer is empty while a phase runs, the engine\'s otherwise', async ($, on) => {
  await world(on)
  await start($)
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('Co-Authored-By: x')
  await skill($, 'phase')
  expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })).text).toBe('')
})

test('a hook that cannot read its state refuses nothing', async ($, on) => {
  await world(on)
  on('state.get', () => ({ deny: 'no state' }))
  await start($)
  for (const command of ['ls', 'git push', 'git push --force origin main', 'git merge other', 'gh pr create --fill', 'gh pr merge 3']) {
    expect((await bash($, command)).result).toBe('ran')
  }
  for (const command of ['pr-create', 'pr-merge']) {
    expect((await $.tool.call({ tool: 'mcp__github__gh', command })).result).toBe('ran')
  }
  expect((await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })).result).toBe('ran')
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
  const ui = await $.ui.mount({ ...BAND_SITE })
  // The band's own node, so the texts of other components (the engine's band) stay out.
  const band = await ui.find({ type: 'Box', key: 'implement' })
  expect(band).toBeDefined()
  const pieces = (band?.children ?? []).map(c => ({ text: listOf(fieldsOf(c)?.['children']).join(''), props: fieldsOf(fieldsOf(c)?.['props']) ?? {} }))
  expect(pieces.map(t => t.text).join('')).toBe('implement:phase demo · phase 02/03 doing: the core · base 9f31a0c · head fedcba9')
  const piece = (text: string) => pieces.find(t => t.text.startsWith(text))!.props
  expect(piece('implement:phase demo')['bold']).toBe(true)
  expect(piece('doing')['color']).toBe('warning')
  expect(piece('head fedcba9')['dimColor']).toBe(true)
  await ui.unmount()
  await turnEnd($, true)
  const quiet = await $.ui.mount({ ...BAND_SITE })
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
function machine(on: TestOn, m: { system: string; record?: string; launcher?: boolean; spawn?: { exitCode: number; stdout: string; stderr: string }; branch?: string }) {
  const runs: string[][] & { launcherTimeout?: number | undefined } = []
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  on('env.get', (_$, e) => ({ value: { HOME: '/home/op' }[e.name] }))
  on('fs.read', (_$, e) => (e.path === '/home/op/.claude/plugins/installed_plugins.json' && m.record !== undefined ? { value: m.record } : { deny: 'ENOENT' }))
  on('fs.exists', (_$, e) => ({ value: m.launcher === true && e.path === LAUNCHER }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const args = e.argv.join(' ')
    if (args === 'git branch --show-current') return ok(m.branch ?? 'feat/demo')
    if (args === 'git rev-parse --show-toplevel') return ok('/work')
    if (args === 'uname -s') return ok(m.system)
    if (e.argv[0] === LAUNCHER) runs.launcherTimeout = e.init?.timeoutMs
    if (e.argv[0] === LAUNCHER) return { value: m.spawn ?? { exitCode: 0, stdout: 'spawned\n/dev/ttys004', stderr: '' } }
    return ok()
  })
  return runs
}

const review = ($: Engine) => $.command.run({ command: 'implement:review', args: '' })

test('on macOS with the orchestrator, the reviewer opens in iTerm through its launcher', async ($, on) => {
  const runs = machine(on, { system: 'Darwin', record: RECORD, launcher: true })
  const out = await review($)
  const spawn = runs.find(argv => argv[0] === LAUNCHER) ?? []
  expect(spawn.slice(0, 6)).toEqual([LAUNCHER, 'spawn', '--dir', '/work', '--title', 'Agent: review demo'])
  expect(spawn[7]).toContain('mcp__orchestrator__review')
  expect(spawn.slice(-2)).toEqual(['--keep-tool', 'mcp__orchestrator__review'])
  expect(String(out.text)).toContain('launched in iTerm on /dev/ttys004')
})

test('the launcher is given core\'s spawn deadline, above its worst case', async ($, on) => {
  const runs = machine(on, { system: 'Darwin', record: RECORD, launcher: true })
  await review($)
  expect(runs.launcherTimeout).toBe(SPAWN_TIMEOUT_MS)
})

test('a launcher that refuses is said as it stands, and nothing is launched another way', async ($, on) => {
  const runs = machine(on, { system: 'Darwin', record: RECORD, launcher: true, spawn: { exitCode: 2, stdout: '', stderr: 'no iTerm2 running' } })
  const out = await review($)
  expect(String(out.text)).toContain('The launcher refused the reviewer (exit 2): no iTerm2 running')
  expect(runs.some(argv => argv[0] === 'sh')).toBe(false)
})

test('elsewhere, or without the launcher, the reviewer runs headless with its report in a log', async ($, on) => {
  const runs = machine(on, { system: 'Linux', record: RECORD, launcher: true })
  const out = await review($)
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

test('the headless reviewer carries its session name, the one the review tool knows a review session by', async ($, on) => {
  const runs = machine(on, { system: 'Linux', record: RECORD, launcher: true })
  await review($)
  const headless = runs.find(argv => argv[0] === 'sh') ?? []
  expect(headless[2]).toContain('-n "$3"')
  expect(headless[6]).toBe('Agent: review demo')
})

test('a macOS without the orchestrator installed runs the reviewer headless too', async ($, on) => {
  const runs = machine(on, { system: 'Darwin' })
  await review($)
  expect(runs.some(argv => argv[0] === 'sh')).toBe(true)
})

test('outside a branch, nothing is launched', async ($, on) => {
  const runs = machine(on, { system: 'Linux', branch: '' })
  const out = await review($)
  expect(String(out.text)).toContain('needs a git repository on a branch')
  expect(runs.some(argv => argv[0] === 'sh')).toBe(false)
})

// ── The learning retrospective, started where a close ends ───────────────────

const LEARNING_ROOT = '/cache/learning/0.2.0'
const LEARNING_SCRIPT = `${LEARNING_ROOT}/skills/learning/scripts/retrospective.ts`
const WITH_LEARNING = {
  enabled: { 'superpowers@claude-plugins-official': true, 'learning@lounisbou': true },
  files: { '/home/op/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'learning@lounisbou': [{ installPath: LEARNING_ROOT }] } }) },
  exists: [LEARNING_SCRIPT],
}
const started = (runs: string[][]) => runs.filter(argv => argv[0] === 'node')

test('the turn that ran implement:close ends on the learning plugin\'s start command, once', async ($, on) => {
  const runs: string[][] = []
  const logged: string[] = []
  await world(on, { ...WITH_LEARNING, runs, logged, node: { exitCode: 0, stdout: 'learning retrospective: not started, 0 candidates wait and it starts at 3\n', stderr: '' } })
  await start($)
  await skill($, 'close')
  expect(started(runs)).toEqual([])
  await turnEnd($, false)
  expect(started(runs)).toEqual([['node', '--experimental-strip-types', '--no-warnings', LEARNING_SCRIPT, 'start', '--config', '/home/op/.claude']])
  expect(logged).toEqual(['implement: learning retrospective: not started, 0 candidates wait and it starts at 3'])
  await turnEnd($, false)
  expect(started(runs).length).toBe(1)
})

test('no other skill\'s turn, and no aborted close, starts the retrospective', async ($, on) => {
  const runs: string[][] = []
  await world(on, { ...WITH_LEARNING, runs })
  await start($)
  await skill($, 'phase')
  await turnEnd($, false)
  await skill($, 'close')
  await turnEnd($, true)
  await turnEnd($, false)
  expect(started(runs)).toEqual([])
})

test('with the learning plugin missing from the install record, a close starts nothing', async ($, on) => {
  const runs: string[][] = []
  const logged: string[] = []
  await world(on, { ...WITH_LEARNING, runs, logged, files: {} })
  await start($)
  await skill($, 'close')
  await turnEnd($, false)
  expect(started(runs)).toEqual([])
  expect(logged.length).toBe(1)
})

test('with the learning plugin disabled, or its script absent, a close starts nothing and ends as before', async ($, on) => {
  const runs: string[][] = []
  const w: World = { ...WITH_LEARNING, runs, enabled: { 'superpowers@claude-plugins-official': true, 'learning@lounisbou': false } }
  await world(on, w)
  await start($)
  for (const change of [{}, { enabled: WITH_LEARNING.enabled, exists: [] }]) {
    Object.assign(w, change)
    await skill($, 'close')
    await turnEnd($, false)
  }
  expect(started(runs)).toEqual([])
})

test('a start that fails is one line of the log, and the turn ends all the same', async ($, on) => {
  const logged: string[] = []
  await world(on, { ...WITH_LEARNING, logged, node: { exitCode: 1, stdout: '', stderr: 'learning retrospective: the session did not start (exit 127)\n' } })
  await start($)
  await skill($, 'close')
  await turnEnd($, false)
  expect(logged).toEqual(['implement: learning retrospective: the session did not start (exit 127)'])
})
