// hooks/tests/scaffold.test.ts
import { expect, test } from 'claude-code/testing'
import { capture } from '../../core/capture.ts'
import { register } from '../register.ts'

test('the module chain loads and mounts session.start among its handlers', () => {
  const mounted = capture(register)
  for (const hook of mounted) if (typeof hook.handler !== 'function') throw new Error(`no handler mounted for ${hook.event}`)
  expect(mounted.map(hook => hook.event)).toContain('session.start')
})
