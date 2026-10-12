// The `bugs` tool: the CLI's arguments as a list, no shell between; the
// operator's grant of the shell form honoured; `gate --measure` measured from the
// session's own figures, the measure file left as the fallback.
import { expect, test } from 'claude-code/testing'
import { mount } from './fakes.ts'
import { READS, TOOL, TOOL_COMMANDS } from '../core.ts'

const ALLOW = { decision: 'allow' }
const shellGrant = { [TOOL]: { decision: 'ask' }, Bash: ALLOW }

async function begin($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
}

test('session.start registers the tool, schema listed from the start, wait not among its commands', async ($, on) => {
  const { registered } = mount(on)
  await begin($)
  const spec = registered.find(r => r.name === 'bugs')
  expect(spec.isDeferred).toBe(false)
  expect(spec.inputSchema.properties.command.enum).toEqual(TOOL_COMMANDS)
  expect(TOOL_COMMANDS).not.toContain('wait')
  expect(TOOL_COMMANDS).not.toContain('pull')
})

test('a text with quotes and apostrophes reaches the CLI as one argument, intact', async ($, on) => {
  const { runs } = mount(on, { verdicts: shellGrant, run: () => ({ exitCode: 0, stdout: 'replied 1\n', stderr: '' }) })
  await begin($)
  const text = "C'est « réglé » : relance l'appli, puis dis-moi \"si ça va\" $HOME `x`"
  const out = await $.tool.call({ tool: TOOL, command: 'reply', args: ['20261002-101112-45', text, '--mention', '--awaits'] })
  expect(out.isError).toBe(false)
  expect(out.result).toBe('replied 1')
  expect(runs.length).toBe(1)
  expect(runs[0].argv[0]).toBe('python3')
  expect(runs[0].argv[1].endsWith('/bin/bugs-bot')).toBe(true)
  expect(runs[0].argv.slice(2)).toEqual(['reply', '20261002-101112-45', text, '--mention', '--awaits'])
})

test('an exit other than 0 is said with its code, the CLI\'s line kept', async ($, on) => {
  mount(on, { verdicts: shellGrant, run: () => ({ exitCode: 2, stdout: 'deployed=unknown: the launcher\'s word decides\n', stderr: '' }) })
  await begin($)
  const out = await $.tool.call({ tool: TOOL, command: 'deployed', args: ['abc1234'] })
  expect(out.isError).toBe(true)
  expect(out.result).toBe("deployed=unknown: the launcher's word decides\nexit=2")
})

test('a command outside the list, or arguments that are not strings, are refused unrun', async ($, on) => {
  const { runs } = mount(on, { verdicts: shellGrant })
  await begin($)
  const pull = await $.tool.call({ tool: TOOL, command: 'pull', args: ['--watch'] })
  expect(pull.isError).toBe(true)
  const bad = await $.tool.call({ tool: TOOL, command: 'show', args: [1] })
  expect(bad.isError).toBe(true)
  expect(runs.length).toBe(0)
})

test('a rule on the tool decides first: a deny refuses, whatever the shell grant', async ($, on) => {
  const { runs } = mount(on, { verdicts: { [TOOL]: { decision: 'deny', reason: 'no posting today' }, Bash: ALLOW } })
  await begin($)
  const out = await $.tool.call({ tool: TOOL, command: 'reply', args: ['1', 'hi'] })
  expect(out.deny).toBe('no posting today')
  expect(runs.length).toBe(0)
})

test('a shell deny rule refuses the same command through the tool', async ($, on) => {
  const { runs } = mount(on, { verdicts: { [TOOL]: { decision: 'ask' }, Bash: { decision: 'deny', reason: 'no bugs-bot here' } } })
  await begin($)
  const out = await $.tool.call({ tool: TOOL, command: 'show', args: ['1'] })
  expect(out.deny).toBe('no bugs-bot here')
  expect(runs.length).toBe(0)
})

test('without any grant a read passes and a write is put to the person, refused when nobody can answer', async ($, on) => {
  const { runs } = mount(on, { verdicts: { [TOOL]: { decision: 'ask' }, Bash: { decision: 'ask' } } })
  await begin($)
  const read = await $.tool.call({ tool: TOOL, command: 'show', args: ['1'] })
  expect(read.isError).toBe(false)
  const write = await $.tool.call({ tool: TOOL, command: 'reply', args: ['1', 'hi'] })
  expect(String(write.deny)).toContain('needs permission')
  expect(runs.length).toBe(1)
  expect(READS.has('reply')).toBe(false)
})

test('gate --measure takes the session\'s own figures, never the measure file', async ($, on) => {
  const { runs } = mount(on, { verdicts: shellGrant, usage: { tokens: 312_000, window: 1_000_000 } })
  await begin($)
  await $.tool.call({ tool: TOOL, command: 'gate', args: ['--measure'] })
  expect(runs[0].argv.slice(2)).toEqual(['gate', '--tokens', '312000', '--window', '1000000'])
})

test('gate --measure before any answer keeps --measure: the CLI reads the measure file', async ($, on) => {
  const { runs } = mount(on, { verdicts: shellGrant, usage: { window: 1_000_000 } })
  await begin($)
  await $.tool.call({ tool: TOOL, command: 'gate', args: ['--measure'] })
  expect(runs[0].argv.slice(2)).toEqual(['gate', '--measure'])
})

test('gate --measure with no usage at all keeps --measure', async ($, on) => {
  const { runs } = mount(on, { verdicts: shellGrant, usage: null })
  await begin($)
  await $.tool.call({ tool: TOOL, command: 'gate', args: ['--measure'] })
  expect(runs[0].argv.slice(2)).toEqual(['gate', '--measure'])
})

test('a child that cannot run is an error result, not a skipped hook', async ($, on) => {
  mount(on, { verdicts: shellGrant, run: () => { throw new Error('python3: not found') } })
  await begin($)
  const out = await $.tool.call({ tool: TOOL, command: 'list', args: [] })
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('could not run')
})
