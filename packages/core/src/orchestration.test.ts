import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GATE_PERCENT, GATE_TOKENS, gateTokensOf, LAUNCHER, launcherOf, MEASURE_VERSION, measureFilePath, moduleDirOf, ORCHESTRATION_CONTRACT,
  parseMeasure, peersOf, selfOf, spawnArgv, tripGate,
} from './orchestration.ts'

const LISTING = [
  'This session is Orch: demo [a1b2c3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).',
  '',
  'Peer sessions (2):',
  '  Agent: other work [d4e5f6]  ·  interactive  ·  busy  ·  started 1h ago',
  '  Coord: machine [0a1b2c]',
].join('\n')

describe('the context gate', () => {
  it('is the smaller of the token gate and the percentage of the window', () => {
    assert.equal(gateTokensOf(1_000_000), GATE_TOKENS)
    assert.equal(gateTokensOf(200_000), 200_000 * GATE_PERCENT / 100)
    assert.equal(gateTokensOf(2_000_000), GATE_TOKENS)
    assert.equal(gateTokensOf(1_000_000, { gateTokens: 250_000 }), 250_000)
    assert.equal(gateTokensOf(200_000, { gate: 50 }), 100_000)
    assert.equal(gateTokensOf(1_500_000, { gateTokens: 900_000 }), 900_000)
    assert.equal(gateTokensOf(1_000_001, { gateTokens: 900_000 }), 800_000)
  })

  it('trips at the percentage, or at the token count on a known window', () => {
    assert.deepEqual(tripGate(80, 160_000, 200_000), { tripped: true, words: '80% (gate 80%)' })
    assert.deepEqual(tripGate(30, 300_000, 1_000_000), { tripped: true, words: '300,000 tokens (gate 300,000 on a 1M window)' })
    assert.deepEqual(tripGate(30, 300_000, 1_500_000, { gateTokens: 250_000 }), { tripped: true, words: '300,000 tokens (gate 250,000 on a 1,500,000 window)' })
    assert.deepEqual(tripGate(29, 299_999, 1_000_000), { tripped: false, words: '' })
    assert.deepEqual(tripGate(null, 400_000, null), { tripped: false, words: '' })
    assert.deepEqual(tripGate(50, null, null, { gate: 50 }), { tripped: true, words: '50% (gate 50%)' })
  })
})

describe('the measure file', () => {
  it('lies under the module directory, named by the session', () => {
    assert.equal(measureFilePath('/c', 'abc'), '/c/claude-orchestrator/measure/abc.json')
    assert.equal(measureFilePath('/c', 'abc', '/m'), '/m/measure/abc.json')
    assert.equal(measureFilePath('/c', 'abc', ''), '/c/claude-orchestrator/measure/abc.json')
    assert.equal(moduleDirOf('/c', null), '/c/claude-orchestrator')
  })

  it('reads a line with the three figures, the gate it carries kept', () => {
    const line = JSON.stringify({ version: MEASURE_VERSION, context_tokens: 10, context_window: 200_000, context_percent: 1, model: 'm', updated_at: 't', gate_tokens: 160_000 })
    assert.deepEqual(parseMeasure(line), JSON.parse(line))
    const unversioned = { context_tokens: 10, context_window: 200_000, context_percent: 1, model: 'm', updated_at: 't' }
    assert.deepEqual(parseMeasure(JSON.stringify(unversioned)), unversioned)
  })

  it('reads a partial, empty, figureless or foreign line as unmeasured', () => {
    assert.equal(parseMeasure(''), null)
    assert.equal(parseMeasure('{"context_tokens": 1'), null)
    assert.equal(parseMeasure('[]'), null)
    assert.equal(parseMeasure('null'), null)
    assert.equal(parseMeasure(JSON.stringify({ context_tokens: 1, context_window: 2 })), null)
    assert.equal(parseMeasure(JSON.stringify({ version: 2, context_tokens: 1, context_window: 2, context_percent: 3 })), null)
  })

  it('drops a gate that is no number rather than the reading', () => {
    const reading = parseMeasure(JSON.stringify({ context_tokens: 1, context_window: 2, context_percent: 3, gate_tokens: 'x' }))
    assert.ok(reading)
    assert.equal('gate_tokens' in reading, false)
  })
})

describe('the launcher', () => {
  it('is the script under the orchestrator install', () => {
    assert.equal(launcherOf('/install/'), `/install/${LAUNCHER}`)
    assert.equal(launcherOf('/install'), `/install/${LAUNCHER}`)
  })

  it('spawns with its arguments in one order', () => {
    assert.deepEqual(spawnArgv(launcherOf('/o'), { dir: '/repo', title: 'Agent: x', prompt: 'go' }),
      [`/o/${LAUNCHER}`, 'spawn', '--dir', '/repo', '--title', 'Agent: x', '--prompt', 'go'])
    assert.deepEqual(spawnArgv(launcherOf('/o'), { dir: '/repo', title: 'Bugs: x', promptFile: '/p.md', rightOf: 'self', resident: true }),
      [`/o/${LAUNCHER}`, 'spawn', '--dir', '/repo', '--title', 'Bugs: x', '--prompt-file', '/p.md', '--right-of', 'self', '--resident'])
  })
})

describe('the ListAgents text', () => {
  it('names the caller on its first line', () => {
    assert.deepEqual(selfOf(LISTING), { name: 'Orch: demo', ref: 'a1b2c3', full: 'Orch: demo [a1b2c3]' })
    assert.deepEqual(selfOf('This session is Orch: x [abc]'), { name: 'Orch: x', ref: 'abc', full: 'Orch: x [abc]' })
    assert.equal(selfOf('Peer sessions (0):'), null)
  })

  it('lists the peers, one indented row each', () => {
    assert.deepEqual(peersOf(LISTING).map(p => p.full), ['Agent: other work [d4e5f6]', 'Coord: machine [0a1b2c]'])
    assert.deepEqual(peersOf('This session is Orch: x [abc]'), [])
  })
})

describe('the data other languages read', () => {
  it('states the measure file and the gate once', () => {
    assert.deepEqual(ORCHESTRATION_CONTRACT, {
      version: 1,
      measure: { module_dir: 'claude-orchestrator', dir: 'measure', version: MEASURE_VERSION },
      gate: { percent: GATE_PERCENT, tokens: GATE_TOKENS },
      launcher: LAUNCHER,
    })
  })
})
