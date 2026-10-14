// /bugs-bot:start without a model turn: the seven steps of commands/start.md in
// order, the orchestrator's launcher from the host's record, and the markdown as
// the fallback whenever a step before the spawn cannot be read.
import { expect, test } from 'claude-code/testing'
import { mount, ROOT_LISTING, type Reply } from './fakes.ts'

const ORCH = '/home/op/.claude/plugins/cache/lounisbou/orchestrator/0.49.1-2afa38391c2b'
const SCRIPT = `${ORCH}/skills/iterm-agents/scripts/iterm-agent.sh`
const PROJECT = JSON.stringify({ project: 'demo', agent_title: 'Bugs : demo', chat_id: 1, deploy_url: 'https://demo.example' })

function files(version = '0.49.1'): Record<string, string> {
  return {
    '/repo/.bugs-bot.json': PROJECT,
    [`${ORCH}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'orchestrator', version }),
    [SCRIPT]: '#!/bin/bash',
  }
}

const ok = (stdout = ''): Reply => ({ exitCode: 0, stdout, stderr: '' })

// The machine's children: the CLI and the launcher, by their second word.
function machine(overrides: Record<string, Reply> = {}, list = ['w1/t1 | /dev/ttys001 | orch | Orch : demo | self', 'w1/t2 | /dev/ttys009 | Bugs : demo | Bugs : demo']) {
  let lists = 0
  return (argv: string[]): Reply => {
    const verb = argv[0] === SCRIPT ? argv[1] : argv[2]
    if (verb in overrides) return overrides[verb]
    if (verb === 'plugin-path') return ok(`${ORCH}\n`)
    if (verb === 'agent-prompt') return ok('/home/op/.bugs-bot/demo/agent/startup-prompt.txt\n')
    if (verb === 'spawn') return ok('spawned\n/dev/ttys009\n')
    if (verb === 'list') return ok((lists++ === 0 ? list : ['w1/t1 | /dev/ttys001 | orch | Orch : demo | self', 'w1/t2 | /dev/ttys009 | Bugs : demo | Bugs : demo']).join('\n'))
    if (verb === 'verify') return ok('running: claude on /dev/ttys009\n')
    if (verb === 'move') return ok('')
    return { exitCode: 2, stdout: '', stderr: `unexpected ${argv.join(' ')}` }
  }
}

const verbs = (runs: { argv: string[] }[]) => runs.map(r => (r.argv[0] === SCRIPT ? r.argv[1] : r.argv[2]))

async function begin($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
}

test('it runs the seven steps and spawns the resident agent right of the launcher', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine() })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(verbs(runs)).toEqual(['plugin-path', 'agent-prompt', 'spawn', 'list', 'verify'])
  expect(runs[1].argv.slice(2)).toEqual(['agent-prompt', '--launcher', 'Orch : demo [a1b2c3]'])
  expect(runs[2].argv).toEqual([SCRIPT, 'spawn', '--dir', '/repo', '--title', 'Bugs : demo', '--prompt-file',
    '/home/op/.bugs-bot/demo/agent/startup-prompt.txt', '--right-of', 'self', '--resident'])
  expect(runs[2].timeoutMs).toBeGreaterThanOrEqual(60_000)
  expect(out.text).toContain('Spawned « Bugs : demo » on /dev/ttys009, launched by Orch : demo [a1b2c3].')
  expect(out.text).toContain('It sits right of this session.')
  expect(out.text).toContain('Verified')
})

test('the CLI that runs is this plugin\'s own, through the chosen interpreter', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine(), env: { BUGS_BOT_PYTHON: '/opt/py311/bin/python3' } })
  await begin($)
  await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(runs[0].argv[0]).toBe('/opt/py311/bin/python3')
  expect(runs[0].argv[1].endsWith('/bin/bugs-bot')).toBe(true)
  expect(runs[0].argv.slice(2)).toEqual(['plugin-path', 'orchestrator'])
})

test('without BUGS_BOT_PYTHON, the interpreter bin/setup remembered in the bugs home runs the CLI', async ($, on) => {
  const remembered = '/home/op/.local/share/uv/python/cpython-3.12/bin/python3.12'
  const { runs } = mount(on, { files: { ...files(), '/srv/bugs/python': `${remembered}\n` }, run: machine(), env: { BUGS_BOT_HOME: '/srv/bugs' } })
  await begin($)
  await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(runs[0].argv[0]).toBe(remembered)
})

test('a tab spawned elsewhere is moved right of the launcher, and listed again', async ($, on) => {
  const { runs } = mount(on, {
    files: files(),
    run: machine({}, ['w1/t1 | /dev/ttys001 | orch | Orch : demo | self', 'w1/t2 | /dev/ttys004 | Agent : x | Agent : x', 'w1/t3 | /dev/ttys009 | Bugs : demo | Bugs : demo']),
  })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(verbs(runs)).toEqual(['plugin-path', 'agent-prompt', 'spawn', 'list', 'move', 'list', 'verify'])
  expect(runs[4].argv).toEqual([SCRIPT, 'move', '--tty', '/dev/ttys009', '--right-of', 'self'])
  expect(out.text).toContain('Moved right of this session.')
})

test('without a project file it says so and runs nothing', async ($, on) => {
  const { runs } = mount(on, { files: {}, run: machine() })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('/bugs-bot:init')
  expect(runs.length).toBe(0)
})

test('the project file of a parent directory is found, as the CLI finds it', async ($, on) => {
  const { runs } = mount(on, { cwd: '/repo/src/deep', files: files(), run: machine() })
  await begin($)
  await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(runs[2].argv.slice(2, 4)).toEqual(['--dir', '/repo'])
})

test('no orchestrator installed: it says so and spawns nothing', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine({ 'plugin-path': { exitCode: 1, stdout: '', stderr: 'bugs-bot: no installed orchestrator plugin found' } }) })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('orchestrator plugin is not installed')
  expect(verbs(runs)).toEqual(['plugin-path'])
})

test('an orchestrator older than 0.46.1 is refused, its tagged version read from the manifest', async ($, on) => {
  const { runs } = mount(on, { files: files('0.45.9'), run: machine() })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('claude plugin update orchestrator@lounisbou')
  expect(out.text).toContain('Nothing was spawned')
  expect(verbs(runs)).toEqual(['plugin-path'])
})

test('a live agent of the project is refused: yours already, or another launcher\'s', async ($, on) => {
  const listing = ROOT_LISTING + '\n  Bugs : demo [778899]  ·  interactive  ·  idle  ·  started 2h ago'
  const f = { ...files(), '/home/op/.bugs-bot/demo/state.json': JSON.stringify({ agent: { launcher: 'Orch : demo [a1b2c3]' } }) }
  const { runs } = mount(on, { files: f, run: machine(), listing })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('already runs (Bugs : demo [778899]): it is yours already')
  expect(verbs(runs)).toEqual(['plugin-path'])
})

test('a live agent another launcher started names that launcher', async ($, on) => {
  const listing = ROOT_LISTING + '\n  Bugs : demo [778899]  ·  interactive  ·  idle  ·  started 2h ago'
  const f = { ...files(), '/home/op/.bugs-bot/demo/state.json': JSON.stringify({ agent: { launcher: 'Orch : other [0f0f0f]' } }) }
  mount(on, { files: f, run: machine(), listing })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('it belongs to Orch : other [0f0f0f]')
})

test('ListAgents unavailable: the markdown command runs instead, nothing spawned', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine(), listing: null })
  on('command.run', { command: 'bugs-bot:start' }, () => ({ text: 'MARKDOWN' }))
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toBe('MARKDOWN')
  expect(verbs(runs)).toEqual(['plugin-path'])
})

test('a ListAgents answer without its first line: the markdown command runs instead', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine(), listing: 'Peer sessions (0):' })
  on('command.run', { command: 'bugs-bot:start' }, () => ({ text: 'MARKDOWN' }))
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toBe('MARKDOWN')
  expect(verbs(runs)).not.toContain('spawn')
})

test('a refused spawn is said as it stands, never retried another way', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine({ spawn: { exitCode: 1, stdout: '', stderr: 'refused: the title is taken' } }) })
  on('command.run', { command: 'bugs-bot:start' }, () => ({ text: 'MARKDOWN' }))
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('refused the spawn (exit 1): refused: the title is taken')
  expect(verbs(runs).filter(v => v === 'spawn').length).toBe(1)
})

test('a failed agent-prompt stops before the spawn', async ($, on) => {
  const { runs } = mount(on, { files: files(), run: machine({ 'agent-prompt': { exitCode: 1, stdout: '', stderr: "bugs-bot: not a session name: 'x'" } }) })
  await begin($)
  const out = await $.command.run({ command: 'bugs-bot:start', args: '' })
  expect(out.text).toContain('agent-prompt failed')
  expect(verbs(runs)).toEqual(['plugin-path', 'agent-prompt'])
})
