// hooks/tests/row-owner.test.ts
// Who an open row's `agent` field names (row-owner.ts) and the rows a merge wake lists with it (ledger.ts).
import { expect, test } from 'claude-code/testing'
import { waitingRows } from '../ledger.ts'
import { isAgent } from '../row-owner.ts'

test('a row\'s agent field names an agent by its name alone: its reference and its case apart', () => {
  expect(isAgent('Agent: row knows', 'Agent: row knows')).toBe(true)
  expect(isAgent('Agent: Row Knows [a1b2c3]', 'Agent: row knows')).toBe(true)
  expect(isAgent('Agent: row knows', 'Agent: ROW KNOWS [d4e5f6]')).toBe(true)
  expect(isAgent('Agent: row knows', 'row knows')).toBe(true)
  expect(isAgent('Agent: row knows', 'Agent: row knows 2')).toBe(false)
  expect(isAgent('Agent: row knows', 'Agent: ')).toBe(false)
  expect(isAgent(undefined, 'Agent: row knows')).toBe(false)
  expect(isAgent(7, 'Agent: row knows')).toBe(false)
})

test('the rows waiting on a merge carry the agent their field names, none for a blank or an absent field', () => {
  const waiting = (id: number, extra: Record<string, unknown>): string => JSON.stringify({ id, state: 'open', label: `r${id}`, blocker: 'PR acme/app#17 merged', ...extra })
  const text = [waiting(1, { agent: 'Agent: a' }), waiting(2, { agent: '   ' }), waiting(3, {}), waiting(4, { agent: 7 })].join('\n') + '\n'
  expect(waitingRows(text, { repo: 'acme/app', pr: 17 })).toEqual([
    { id: 1, label: 'r1', agent: 'Agent: a' },
    { id: 2, label: 'r2', agent: null },
    { id: 3, label: 'r3', agent: null },
    { id: 4, label: 'r4', agent: null },
  ])
})
