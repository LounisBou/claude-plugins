// hooks/tests/commands.test.ts
// The commands answered without a model turn. Each handler answers the whole
// run; its net lets the markdown body run where the handler failed, and a
// request for the config command goes on to that body, which reads it.
import { expect, test } from 'claude-code/testing'
import { scriptText, settingsText, RESTART } from '../commands.ts'
import { markdown, ROOT, world } from './fakes.ts'

test('a command of another plugin goes through untouched', async ($, on) => {
  const fx = world(on)
  expect((await $.command.run({ command: 'other:install', args: '' })).text).toBe(markdown('other:install', ''))
  expect(fx.ran).toEqual([])
})

test('install runs the plugin script and answers its output with the restart line', async ($, on) => {
  const fx = world(on, { run: { exitCode: 0, stdout: 'installed\n', stderr: '' } })
  const answer = await $.command.run({ command: 'statusbar:install', args: '' })
  expect(fx.ran).toEqual([['bash', `${ROOT}/install.sh`]])
  expect(answer.text).toBe(`installed\n\n${RESTART}`)
})

test('uninstall runs its script; a failing script is still an answer that says so', async ($, on) => {
  const fx = world(on, { run: { exitCode: 1, stdout: '', stderr: 'jq is required\n' } })
  const answer = await $.command.run({ command: 'statusbar:uninstall', args: '' })
  expect(fx.ran).toEqual([['bash', `${ROOT}/uninstall.sh`]])
  expect(answer.text).toContain('jq is required')
  expect(answer.text).toContain('exit 1')
  expect(scriptText({ exitCode: 0, stdout: 'ok\n', stderr: '' }, '')).toBe('ok')
})

test('config with no request shows the settings, a missing key as shown', async ($, on) => {
  world(on, { files: { '/home/u/.claude/statusline-config.txt': 'SHOW_PR=0\n' } })
  const answer = await $.command.run({ command: 'statusbar:config', args: '  ' })
  expect(answer.text).toMatch(/SHOW_PR +hidden/)
  expect(answer.text).toMatch(/SHOW_MODEL +shown/)
  expect(settingsText('', '/p')).toContain('SHOW_DIRECTORY')
})

test('config with a request goes on to the markdown body, which reads it', async ($, on) => {
  world(on)
  const e = { command: 'statusbar:config', args: 'hide the PR' }
  expect((await $.command.run(e)).text).toBe(markdown(e.command, e.args))
})

test('every net lets the markdown command run where its handler failed', async ($, on) => {
  world(on, { failRun: 'boom' })
  for (const command of ['statusbar:install', 'statusbar:uninstall']) {
    const e = { command, args: '' }
    expect((await $.command.run(e)).text).toBe(markdown(e.command, e.args))
  }
})
