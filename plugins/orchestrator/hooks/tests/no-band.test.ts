// hooks/tests/no-band.test.ts
import { expect, test } from 'claude-code/testing'
import { capture, hooksOn } from '../../core/capture.ts'
import { register } from '../register.ts'

test('the module draws nothing above the prompt: no render handler is registered for it', () => {
  const renders = hooksOn(capture(register), 'ui.render')
  expect(renders.length).toBeGreaterThan(0)
  expect(renders.filter(entry => JSON.stringify(entry.matcher ?? {}).includes('AbovePrompt'))).toEqual([])
})
