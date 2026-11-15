import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalsFileOf, ownerFileOf } from './record-paths.ts'

test('the owner and the goals stand beside the record', () => {
  assert.equal(ownerFileOf('/w/r.jsonl'), '/w/r.jsonl.owner')
  assert.equal(goalsFileOf('/w/a/r.jsonl'), '/w/a/goals.md')
  assert.equal(goalsFileOf('r.jsonl'), './goals.md')
})
