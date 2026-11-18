// hooks/tests/state.test.ts
// What closes the band, and which scratch directory it counts in: two pure readings.
import { expect, test } from 'claude-code/testing'
import { endsWalkthrough } from '../state.ts'
import { scratchDirOf } from '../walkthrough.ts'

test('start-review ends on its closing heading only, and a translated heading ends nothing', () => {
  expect(endsWalkthrough('start-review', 'done\n## Walkthrough complete\n')).toBe(true)
  expect(endsWalkthrough('start-review', '## Walkthrough complete and more')).toBe(false)
  expect(endsWalkthrough('start-review', '## Revue terminée\n')).toBe(false)
  expect(endsWalkthrough('start-review', 'All PR comments have been addressed.')).toBe(false)
})

test('process-comments ends on its closing line, and not on the other skill\'s heading', () => {
  expect(endsWalkthrough('process-comments', 'All PR comments have been addressed.')).toBe(true)
  expect(endsWalkthrough('process-comments', '## Walkthrough complete\n')).toBe(false)
  expect(endsWalkthrough('process-comments', 'Tous les commentaires ont été traités.')).toBe(false)
})

test('auto-fix-loop never ends a walkthrough', () => {
  expect(endsWalkthrough('auto-fix-loop', '## Walkthrough complete\nAll PR comments have been addressed.')).toBe(false)
})

test('the scratch directory is the pull request\'s own, under /tmp or /private/tmp, and a path that climbs is none', () => {
  expect(scratchDirOf('/tmp/claude-pr-review-12/comment-1.md')).toBe('/tmp/claude-pr-review-12')
  expect(scratchDirOf('/private/tmp/claude-pr-review-12/comment-1.md')).toBe('/private/tmp/claude-pr-review-12')
  expect(scratchDirOf('/tmp/claude-pr-review-12/../x/a.md')).toBeUndefined()
  expect(scratchDirOf('/tmp/claude-pr-review-12/sub/../../etc/a')).toBeUndefined()
  expect(scratchDirOf('/tmp/claude-pr-review-x/a.md')).toBeUndefined()
  expect(scratchDirOf('/var/tmp/claude-pr-review-12/a.md')).toBeUndefined()
  expect(scratchDirOf('/repo/src/a.ts')).toBeUndefined()
})
