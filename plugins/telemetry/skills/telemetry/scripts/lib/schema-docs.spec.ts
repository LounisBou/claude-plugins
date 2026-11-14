// The schema pages of the logs repository are generated from the declared kinds: one page per
// kind with its fields, units and writers, and an entry point; a kind added to the list joins the
// index with no other edit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMON_FIELDS, EVENT_SCHEMA, EVENTS, type KindSpec } from '../../../../hooks/schema.ts'
import { MANIFEST_FIELDS } from './manifest.ts'
import { INDEX_DIR, schemaFiles } from './schema-docs.ts'

const byPath = (files: { path: string; text: string }[]): Map<string, string> => new Map(files.map(f => [f.path, f.text]))

test('every declared kind has a page under the index, with each of its fields, units and writers', () => {
  const files = byPath(schemaFiles())
  for (const kind of EVENTS) {
    const page = files.get(`${INDEX_DIR}/schema/${kind}.md`)
    assert.ok(page !== undefined, `no page for ${kind}`)
    const spec: KindSpec = EVENT_SCHEMA[kind]
    for (const f of spec.fields) assert.ok(page.includes(`\`${f.name}\``), `${kind}: ${f.name}`)
    for (const f of spec.fields) if (f.unit !== undefined) assert.ok(page.includes(f.unit), `${kind}: unit of ${f.name}`)
    for (const writer of spec.writers) assert.ok(page.includes(writer), `${kind}: writer ${writer}`)
    for (const f of COMMON_FIELDS) assert.ok(page.includes(`\`${f.name}\``), `${kind}: common ${f.name}`)
  }
})

test('the machine-readable schema lists the kinds, their fields and the manifest\'s', () => {
  const schema = JSON.parse(byPath(schemaFiles()).get(`${INDEX_DIR}/schema.json`) ?? 'null') as {
    v: number
    common: { name: string }[]
    events: Record<string, { summary: string; writers: string[]; fields: { name: string; type: string; unit?: string }[] }>
    manifest: { name: string }[]
  }
  assert.equal(schema.v, 1)
  assert.deepEqual(Object.keys(schema.events), [...EVENTS])
  assert.deepEqual(schema.events['turn_end']?.fields.find(f => f.name === 'duration_ms'), { name: 'duration_ms', type: 'number', unit: 'ms', description: 'The turn\'s duration.' })
  assert.deepEqual(schema.common.map(f => f.name), COMMON_FIELDS.map(f => f.name))
  assert.deepEqual(schema.manifest.map(f => f.name), MANIFEST_FIELDS.map(f => f.name))
})

test('a kind added to the declared list joins the index, its page and the entry point, with no other edit', () => {
  const added: Record<string, KindSpec> = {
    ...EVENT_SCHEMA,
    audit_finding: { summary: 'A finding of an audit.', writers: ['the audit writer'], fields: [{ name: 'severity', type: 'string', description: 'How bad.' }] },
  }
  const files = byPath(schemaFiles(added))
  assert.match(files.get(`${INDEX_DIR}/schema/audit_finding.md`) ?? '', /`severity`/)
  assert.match(files.get(`${INDEX_DIR}/README.md`) ?? '', /audit_finding/)
  const schema = JSON.parse(files.get(`${INDEX_DIR}/schema.json`) ?? 'null') as { events: Record<string, unknown> }
  assert.ok('audit_finding' in schema.events)
})

test('the pages are the same text on every run, so an unchanged schema changes nothing in the repository', () => {
  assert.deepEqual(schemaFiles(), schemaFiles())
})

test('the entry point names where the days\' manifests and the day files are', () => {
  const readme = byPath(schemaFiles()).get(`${INDEX_DIR}/README.md`) ?? ''
  assert.ok(readme.includes('index/<machine>/<day>.json'))
  assert.ok(readme.includes('machines/<machine>/<day>.jsonl'))
})
