// The pure readings /bugs-bot:start stands on: ListAgents, the launcher's list,
// the orchestrator's version.
import { expect, test } from 'claude-code/testing'
import { isAgentRow, measuredGateArgs, peersOf, selfOf, sitsRightOfSelf, versionAtLeast } from '../core.ts'
import { ROOT_LISTING } from './fakes.ts'

test('ListAgents: the caller from its first line, the peers from their rows', () => {
  expect(selfOf(ROOT_LISTING)).toEqual({ name: 'Orch : demo', ref: 'a1b2c3', full: 'Orch : demo [a1b2c3]' })
  expect(peersOf(ROOT_LISTING).map(p => p.full)).toEqual(['Agent : other work [d4e5f6]'])
  expect(selfOf('Peer sessions (0):')).toBe(null)
})

test('the agent\'s row: its title, case and spacing aside, or followed by more words', () => {
  expect(isAgentRow('Bugs : demo', 'Bugs : demo')).toBe(true)
  expect(isAgentRow('bugs :  DEMO', 'Bugs : demo')).toBe(true)
  expect(isAgentRow('Bugs : demo 2', 'Bugs : demo')).toBe(true)
  expect(isAgentRow('Bugs : demonstration', 'Bugs : demo')).toBe(false)
  expect(isAgentRow('Agent : other', 'Bugs : demo')).toBe(false)
})

test('a tagged orchestrator version is read by its release, never by the directory\'s sort', () => {
  expect(versionAtLeast('0.49.1-2afa38391c2b', '0.46.1')).toBe(true)
  expect(versionAtLeast('0.46.1', '0.46.1')).toBe(true)
  expect(versionAtLeast('0.46.0', '0.46.1')).toBe(false)
  expect(versionAtLeast('0.100.0', '0.46.1')).toBe(true)
  expect(versionAtLeast('', '0.46.1')).toBe(false)
})

test('right of self: the next tab of the same window', () => {
  const rows = ['w1/t2 | /dev/ttys001 | a | A | self', 'w1/t3 | /dev/ttys009 | b | B', 'w2/t3 | /dev/ttys010 | c | C'].join('\n')
  expect(sitsRightOfSelf(rows, '/dev/ttys009')).toBe(true)
  expect(sitsRightOfSelf(rows, '/dev/ttys010')).toBe(false)
  expect(sitsRightOfSelf('w1/t1 | /dev/ttys009 | b | B', '/dev/ttys009')).toBe(false)
})

test('the gate\'s arguments: --measure replaced by the figures, kept without them', () => {
  expect(measuredGateArgs(['--measure', '--project', 'demo'], 5, 200_000)).toEqual(['--project', 'demo', '--tokens', '5', '--window', '200000'])
  expect(measuredGateArgs(['--measure'], undefined, 200_000)).toBe(null)
  expect(measuredGateArgs(['--set', '2'], 5, 200_000)).toBe(null)
})
