// hooks/tests/commands.test.ts
// The commands answered without a model turn. Each handler answers the whole
// run; its net lets the markdown body run where the handler failed, and a
// request for the config command goes on to that body, which reads it.
import { expect, test } from 'claude-code/testing'
import { register, scriptText, settingsText, RESTART } from '../commands.ts'
import { mount, fakeDollar, fakeNext } from './fakes.ts'

const by = (command: string) => mount(register).find(r => (r.matcher as any)?.command === command)!

test('the module hooks the three command spellings and nothing else', () => {
  expect(mount(register).map(r => [r.event, r.matcher])).toEqual([
    ['command.run', { command: 'claude-statusbar:install' }],
    ['command.run', { command: 'claude-statusbar:uninstall' }],
    ['command.run', { command: 'claude-statusbar:config' }],
  ])
})

test('install runs the plugin script and answers its output with the restart line', async () => {
  const fx = fakeDollar({ run: { exitCode: 0, stdout: 'installed\n', stderr: '' } })
  const answer = await by('claude-statusbar:install').handler(fx.dollar, { command: 'claude-statusbar:install', args: '' })
  expect(fx.ran).toEqual([['bash', '/plugins/sb/install.sh']])
  expect(answer).toEqual({ text: `installed\n\n${RESTART}` })
})

test('uninstall runs its script; a failing script is still an answer that says so', async () => {
  const fx = fakeDollar({ run: { exitCode: 1, stdout: '', stderr: 'jq is required\n' } })
  const answer = await by('claude-statusbar:uninstall').handler(fx.dollar, { command: 'claude-statusbar:uninstall', args: '' })
  expect(fx.ran).toEqual([['bash', '/plugins/sb/uninstall.sh']])
  expect(answer.text).toContain('jq is required')
  expect(answer.text).toContain('exit 1')
  expect(scriptText({ exitCode: 0, stdout: 'ok\n', stderr: '' }, '')).toBe('ok')
})

test('config with no request shows the settings, a missing key as shown', async () => {
  const fx = fakeDollar({ files: { '/home/u/.claude/statusline-config.txt': 'SHOW_PR=0\n' } })
  const answer = await by('claude-statusbar:config').handler(fx.dollar, { command: 'claude-statusbar:config', args: '  ' }, fakeNext())
  expect(answer.text).toMatch(/SHOW_PR +hidden/)
  expect(answer.text).toMatch(/SHOW_MODEL +shown/)
  expect(settingsText('', '/p')).toContain('SHOW_DIRECTORY')
})

test('config with a request goes on to the markdown body, which reads it', async () => {
  const fx = fakeDollar()
  const e = { command: 'claude-statusbar:config', args: 'hide the PR' }
  expect(await by('claude-statusbar:config').handler(fx.dollar, e, fakeNext())).toEqual({ passed: e })
})

test('every net lets the markdown command run where its handler failed', async () => {
  const fx = fakeDollar()
  for (const command of ['claude-statusbar:install', 'claude-statusbar:uninstall', 'claude-statusbar:config']) {
    const e = { command, args: '' }
    expect(await by(command).net(fx.dollar, e, fakeNext('boom'))).toEqual({ passed: e })
  }
})
