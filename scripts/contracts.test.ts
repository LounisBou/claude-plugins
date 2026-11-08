// Each contract between plugins, tested across its owner and its readers: what the owner
// writes, core's reader accepts (docs/contracts.md).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parsePrRecord } from '../packages/core/src/pr-record.ts'

describe('pull request records: github writes, core reads', () => {
  it('reads every record github engine writes', () => {
    const config = mkdtempSync(join(tmpdir(), 'records-'))
    const write = (...args: string[]): string =>
      execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'Owner/Name', '--pr', '7', '--head', 'A'.repeat(40), '--producer', 'pr-review', '--session', 's', ...args],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' }).trim()
    for (const path of [write('--kind', 'review', '--result', 'pass'), write('--kind', 'e2e', '--result', 'waived', '--detail', 'operator, 2026-11-08')]) {
      const record = parsePrRecord(JSON.parse(readFileSync(path, 'utf8')))
      assert.ok(record, path)
      assert.equal(record.repo, 'owner/name')
      assert.equal(record.head, 'a'.repeat(40))
    }
  })

  it('and github refuses what the contract refuses', () => {
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'review', '--result', 'waived'], { stdio: 'pipe' }))
  })
})
