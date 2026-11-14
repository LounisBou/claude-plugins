// Each contract between plugins, tested across its owner and its readers: what the owner
// writes, core's reader accepts (docs/contracts.md).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { accepts, parsePrRecord } from '../packages/core/src/pr-record.ts'
import { gateTokensOf, measureFilePath, MEASURE_VERSION, type MeasureReading } from '../packages/core/src/orchestration.ts'

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

describe('the measure file: the orchestrator writes, bugs-bot reads', () => {
  it('finds the file core names and reads its figures', () => {
    const config = mkdtempSync(join(tmpdir(), 'measure-'))
    const path = measureFilePath(config, 'abc')
    const reading: MeasureReading = {
      version: MEASURE_VERSION, context_tokens: 810_000, context_window: 1_000_000, context_percent: 81, model: 'm', updated_at: 't',
      gate_tokens: gateTokensOf(1_000_000), start: { tokens: 1, at: 't', brief: null, brief_bytes: null },
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(reading)}\n`)
    const read = execFileSync('python3', ['-c', [
      'import json, sys',
      "sys.path.insert(0, 'plugins/bugs-bot')",
      'from bugs_bot.gate import measure, measure_path',
      'env = {"CLAUDE_CONFIG_DIR": sys.argv[1], "CLAUDE_CODE_SESSION_ID": "abc"}',
      'print(json.dumps({"path": str(measure_path(env)), "figures": measure(env)}))',
    ].join('\n'), config], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(read), { path, figures: [810_000, 1_000_000] })
  })
})
