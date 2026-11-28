import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSE_GATE_CONTRACT, gateAskPath, gateHerePath, gateKey, gateStatePath, parseGateAsk, parseGateState } from './close-gate.ts'

test('a session id names its gate files under the store, sanitised', () => {
  assert.equal(gateKey('a/b c'), 'a_b_c')
  assert.equal(gateAskPath('/m/store/', 's-1'), '/m/store/close-gate/s-1.ask')
  assert.equal(gateStatePath('/m/store', 's-1'), '/m/store/close-gate/s-1.state')
  assert.equal(gateHerePath('/m/store', 's-1'), '/m/store/close-gate/s-1.here')
  assert.equal(CLOSE_GATE_CONTRACT.quiet_ms, 180_000)
  assert.equal(CLOSE_GATE_CONTRACT.notice_ms, 60_000)
})

test('an ask is read of its version alone, with an id, a time and its command', () => {
  const ask = { v: 1, sid: 's', at: '2026-11-28T11:47:30.000Z', by: 'takeover' }
  assert.deepEqual(parseGateAsk(JSON.stringify(ask)), ask)
  assert.equal(parseGateAsk(JSON.stringify({ ...ask, v: 2 })), null)
  assert.equal(parseGateAsk(JSON.stringify({ ...ask, at: 'soon' })), null)
  assert.equal(parseGateAsk(JSON.stringify({ ...ask, sid: '' })), null)
  assert.equal(parseGateAsk('{'), null)
  assert.equal(parseGateAsk('[]'), null)
})

test('a state is read of its version alone, its phase one of three, its times times', () => {
  const state = { v: 1, sid: 's', ask_at: '2026-11-28T11:47:30.000Z', phase: 'notice', notice_at: '2026-11-28T11:50:30.000Z', why: 'shown', seen_at: '2026-11-28T11:50:35.000Z' }
  assert.deepEqual(parseGateState(JSON.stringify(state)), state)
  assert.deepEqual(parseGateState(JSON.stringify({ ...state, notice_at: null })), { ...state, notice_at: null })
  assert.equal(parseGateState(JSON.stringify({ ...state, phase: 'closed' })), null)
  assert.equal(parseGateState(JSON.stringify({ ...state, notice_at: 'later' })), null)
  assert.equal(parseGateState(JSON.stringify({ ...state, seen_at: 3 })), null)
  assert.equal(parseGateState(JSON.stringify({ ...state, v: 0 })), null)
  assert.equal(parseGateState('nope'), null)
})
