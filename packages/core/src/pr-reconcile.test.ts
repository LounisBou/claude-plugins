import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseReconcile, reconcileEdgePath, reconcilePath, RECONCILE_VERSION } from './pr-reconcile.ts'
import { prFilePath, prFileRepos, PR_FILE_VERSION } from './pr-file.ts'

const HEAD = 'a'.repeat(40)
const reading = {
  v: RECONCILE_VERSION, repo: 'acme/app', pr: 17, head: HEAD, base: 'main', draft: true, labels: ['Not Ready'],
  ci: { result: 'FAILURE', running: 0, failed: ['lint'], checks: [{ name: 'lint', bucket: 'fail' }] },
  missing: ['ci: FAILURE'], at: '2026-11-19T10:00:00Z', fingerprint: 'f',
}

describe('the reconciler\'s reading', () => {
  it('lies one file a pull request under the configuration directory, its repository lowercased, the edge marker beside', () => {
    assert.equal(reconcilePath('/cfg', 'Acme/App', 17), '/cfg/pr-reconcile/acme/app/17.json')
    assert.equal(reconcileEdgePath('/cfg'), '/cfg/pr-reconcile/.edge')
  })

  it('is read back whole, the gate\'s CI kept with its checks', () => {
    assert.deepEqual(parseReconcile(JSON.stringify(reading)), reading)
  })

  it('is no reading when it breaks the shape, another version or no JSON', () => {
    for (const broken of [
      { ...reading, v: 2 }, { ...reading, head: 'abc' }, { ...reading, pr: 0 }, { ...reading, missing: [1] },
      { ...reading, ci: { result: 'SUCCESS', failed: [] } }, { ...reading, ci: null }, { ...reading, draft: 'no' }, [reading],
    ]) assert.equal(parseReconcile(JSON.stringify(broken)), undefined)
    assert.equal(parseReconcile('{'), undefined)
  })
})

describe('the orchestrator\'s pull request file, as github reads it', () => {
  it('is prs.json under the state directory, its repositories those it names in shape', () => {
    assert.equal(prFilePath('/state'), '/state/prs.json')
    assert.deepEqual(prFileRepos(JSON.stringify({ v: PR_FILE_VERSION, repos: ['acme/app', 'x', 3, 'o/n;rm'], prs: [] })), ['acme/app'])
  })

  it('names no repository when it is another version, no object or no JSON', () => {
    for (const text of [JSON.stringify({ v: 2, repos: ['acme/app'] }), JSON.stringify({ v: 1, repos: 'acme/app' }), 'null', '{']) assert.deepEqual(prFileRepos(text), [])
  })
})
