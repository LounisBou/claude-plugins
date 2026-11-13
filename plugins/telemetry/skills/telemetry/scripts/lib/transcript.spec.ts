// What a transcript gives after the fact, from a fixture: no message text survives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize, summarizeFile, transcriptOf } from './transcript.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const FIXTURE = fileURLToPath(new URL(`../../../../tests/fixtures/${S}.jsonl`, import.meta.url))

test('summary: last title and role, last effort, models, token totals once per message, tools, errors and refusals', () => {
  const summary = summarizeFile(FIXTURE)
  assert.deepEqual(summary, {
    title: 'Orch: billing', role: 'orchestrator', effort: 'medium', models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    cwd: '/w/claude-plugins', started: '2026-11-13T19:30:00.000Z', ended: '2026-11-13T19:32:00.000Z', first_turn_ms: 4500,
    totals: { in: 15, out: 150, cache_read: 3000, cache_write: 500 }, tools: { Bash: 2, mcp__github__gh: 1 }, errors: 1,
    refusals: { auto_mode: 1, 'plugin:github': 1 },
  })
  assert.ok(!JSON.stringify(summary).includes('never kept'))
})

test('summary: an empty transcript, and an untitled spawned session', () => {
  assert.deepEqual(summarize(''), { role: 'other', models: [], totals: { in: 0, out: 0, cache_read: 0, cache_write: 0 }, tools: {}, errors: 0, refusals: {} })
  assert.equal(summarize('{"type":"user","timestamp":"2026-11-13T19:30:00.000Z"}', true).role, 'agent')
})

test('transcriptOf: found under any project, absent elsewhere', () => {
  const config = mkdtempSync(join(tmpdir(), 'telemetry-'))
  try {
    assert.equal(transcriptOf(config, S), undefined)
    mkdirSync(join(config, 'projects', '-a'), { recursive: true })
    mkdirSync(join(config, 'projects', '-b'), { recursive: true })
    cpSync(FIXTURE, join(config, 'projects', '-b', `${S}.jsonl`))
    assert.equal(transcriptOf(config, S), join(config, 'projects', '-b', `${S}.jsonl`))
    assert.equal(transcriptOf(config, '00000000-0000-0000-0000-000000000000'), undefined)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
})
