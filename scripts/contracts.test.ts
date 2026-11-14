// Each contract between plugins, tested across its owner and its readers: what the owner
// writes, core's reader accepts (docs/contracts.md).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseJournalEvent } from '../packages/core/src/learning.ts'
import { accepts, parsePrRecord } from '../packages/core/src/pr-record.ts'

describe('pull request records: github writes, core reads', () => {
  it('reads every record github engine writes', () => {
    const config = mkdtempSync(join(tmpdir(), 'records-'))
    const write = (...args: string[]): string =>
      execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'Owner/Name', '--pr', '7', '--head', 'A'.repeat(40), '--producer', 'pr-review', '--session', 's', ...args],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' }).trim()
    for (const path of [
      write('--kind', 'review', '--result', 'pass'), write('--kind', 'e2e', '--result', 'waived', '--detail', 'operator, 2026-11-08'),
      write('--kind', 'e2e', '--result', 'not-applicable', '--detail', 'documentation only'),
      write('--kind', 'review', '--result', 'accepted', '--detail', 'over review.x.json: nits only'),
    ]) {
      const record = parsePrRecord(JSON.parse(readFileSync(path, 'utf8')))
      assert.ok(record && accepts(record), path)
      assert.equal(record.repo, 'owner/name')
      assert.equal(record.head, 'a'.repeat(40))
    }
  })

  it('and github refuses what the contract refuses', () => {
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'review', '--result', 'waived'], { stdio: 'pipe' }))
    const none = ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--result', 'not-applicable']
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'review', '--detail', 'documentation only'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'e2e'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'norms', '--result', 'accepted'], { stdio: 'pipe' }))
  })
})

describe('learning events: the orchestrator\'s scripts write, core reads', () => {
  it('reads every event the dispatch record writes through its own entry point, into the configuration directory\'s journal', () => {
    const config = mkdtempSync(join(tmpdir(), 'journal-'))
    const record = join(config, 'claude-orchestrator', 'briefs', 'p', 'dispatch.jsonl')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: config, CLAUDE_CODE_SESSION_ID: 'orch-1' }
    const run = (...args: string[]): string => execFileSync('plugins/orchestrator/skills/orchestrator/scripts/dispatch-record.sh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    run('goals', record, 'init', '--spec', 'none')
    const id = run('open', record, '--class', 'feature', '--tier', 'deep').trim()
    run('review', record, id, '--head', 'a'.repeat(40))
    run('round', record, id)
    run('fixed', record, id, '--head', 'b'.repeat(7))
    run('surface', record, id, '--ui', 'acme/thing#12')
    run('escaped', record, id)
    run('close', record, id, '--verdict', 'thing#12 merged')
    const dir = join(config, 'orchestrator', 'journal')
    const events = readdirSync(dir).map(name => parseJournalEvent(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    assert.equal(events.length, 7)
    assert.ok(events.every(event => event !== undefined))
    assert.deepEqual(events.map(event => event?.kind).sort(), ['escape', 'link', 'link', 'step', 'step', 'step', 'step'])
    rmSync(config, { recursive: true, force: true })
  })
})
