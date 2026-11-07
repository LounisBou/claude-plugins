// hooks/tests/scaffold.test.ts
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'

test('the module chain loads and mounts session.start among its handlers', () => {
  const mounted: string[] = []
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const handler = args[args.length - 1]
    if (typeof handler !== 'function') throw new Error(`no handler mounted for ${args[0]}`)
    mounted.push(args[0])
    // The engine's on returns a registration taking one .catch; the fake
    // accepts it and drops it.
    return { catch: () => undefined }
  })
  expect(mounted).toContain('session.start')
})
