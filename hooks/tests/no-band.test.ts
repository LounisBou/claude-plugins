// hooks/tests/no-band.test.ts
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'

test('the module draws nothing above the prompt: no render handler is registered for it', () => {
  const matchers: { event: string; matcher: object | undefined }[] = []
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    matchers.push({ event: args[0], matcher: args.length === 3 ? args[1] : undefined })
    return { catch: () => undefined }
  })
  const renders = matchers.filter(entry => entry.event === 'ui.render')
  expect(renders.length).toBeGreaterThan(0)
  expect(renders.filter(entry => JSON.stringify(entry.matcher ?? {}).includes('AbovePrompt'))).toEqual([])
})
