import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capture, hookOf, hostOf } from './capture.ts'
import type { Host, On } from './host.ts'

type Mod = Host<'env' | 'ui'>

function register(on: On<Mod>): void {
  on('command.run', { command: 'demo' }, async ($, e) => ({ text: `${e.args} ${await $.env.get('HOME')}` }))
    .catch(async (_$, e, next) => next(e))
  on('session.start', async (_$, e, next) => next(e))
}

test('the hooks a module registers are kept in order, with their matchers and nets', async () => {
  const hooks = capture(register)
  assert.deepEqual(hooks.map(h => [h.event, h.matcher]), [['command.run', { command: 'demo' }], ['session.start', undefined]])
  const demo = hookOf(hooks, 'command.run', { command: 'demo' })
  const $ = hostOf({ env: { get: async () => '/home/u' } })
  assert.deepEqual(await demo.handler($, { command: 'demo', args: 'hi' }, async () => undefined), { text: 'hi /home/u' })
  assert.deepEqual(await demo.net?.($, { command: 'demo', args: 'x' }, async e => ({ through: e })), { through: { command: 'demo', args: 'x' } })
  assert.equal(hookOf(hooks, 'session.start').net, undefined)
})

test('a hook not registered is said, with its matcher', () => {
  assert.throws(() => hookOf(capture(register), 'command.run', { command: 'other' }), /no hook command.run \{"command":"other"\}/)
})

test('a registration without its hook is refused', () => {
  const broken = (on: On<Mod>) => { Reflect.apply(on, undefined, ['session.start', { tool: 'x' }]) }
  assert.throws(() => capture(broken), /session.start: a registration without its hook/)
})

test('a noun the test did not hand throws when called, and says which', () => {
  const $ = hostOf({ plugin: { root: '/p' } })
  assert.equal($.plugin.root, '/p')
  assert.throws(() => $.fs.read('/x'), /\$\.fs\.read is not part of this test/)
  assert.equal(hostOf().plugin.root, '/plugin')
})
