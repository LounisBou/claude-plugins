import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalsFileOf, ownerFileOf, recordFiles, recordNamedIn } from './record-paths.ts'

test('the brief names its record on its « Dispatch record » line, between backticks', () => {
  assert.equal(recordNamedIn('# x\n- Dispatch record (routing): `/w/briefs/a/record.jsonl`, read first.\n'), '/w/briefs/a/record.jsonl')
  assert.equal(recordNamedIn('- Dispatch record: `{{DISPATCH_RECORD}}`\n'), '')
  assert.equal(recordNamedIn('no such line'), '')
})

test('the owner and the goals stand beside the record', () => {
  assert.equal(ownerFileOf('/w/r.jsonl'), '/w/r.jsonl.owner')
  assert.equal(goalsFileOf('/w/a/r.jsonl'), '/w/a/goals.md')
  assert.equal(goalsFileOf('r.jsonl'), './goals.md')
  assert.deepEqual(recordFiles('/w/r.jsonl'), ['/w/r.jsonl', '/w/r.jsonl.owner', '/w/goals.md'])
})
