import { expect, test } from 'claude-code/testing'
import { parsePlan, planExcuses, planInput, planPath, planText, relaxed } from './check-plan.ts'

const plan = (e2e: string, norms: string, review?: string) => {
  const checks = planInput({ e2e, norms, review })
  if (typeof checks === 'string') throw new Error(checks)
  return { v: 1, repo: 'acme/thing', pr: 12, ...checks, at: '2026-11-14T09:00:00Z' }
}

test('a plan gives each need, and a reason for any need but required', () => {
  expect(planInput({ e2e: 'Screenshots: a colour', norms: 'required: kept', review: 'one-pass: a typo' })).toEqual({
    e2e: { need: 'screenshots', reason: 'a colour' }, norms: { need: 'required', reason: '' }, review: { need: 'one-pass', reason: 'a typo' },
  })
  expect(planInput({})).toEqual({ e2e: { need: 'none', reason: 'not in the plan' }, norms: { need: 'none', reason: 'not in the plan' }, review: { need: 'full', reason: '' } })
  expect(planInput({ review: 'one-pass' })).toBe('review one-pass gives its reason: "one-pass: <why>"')
  expect(planInput({ e2e: 'none', norms: 'required' })).toBe('e2e none gives its reason: "none: <why>"')
  expect(planInput({ e2e: 'required', norms: 'screenshots: x' })).toContain('norms is one of required, none')
  expect(planInput({ e2e: 'none: ' + 'x'.repeat(501), norms: 'required' })).toContain('at most 500')
  expect(planInput(null)).toBe('a plan is an object')
  expect(planInput({ e2e: 3 })).toContain('e2e is one of')
})

test('a plan file parses back, and one of another shape is none', () => {
  const written = plan('none: docs only', 'required')
  expect(parsePlan(JSON.parse(JSON.stringify(written)))).toEqual(written)
  for (const bad of [null, [], { ...written, v: 2 }, { ...written, repo: '../x' }, { ...written, pr: 0 }, { ...written, e2e: { need: 'none', reason: '' } }, { ...written, norms: undefined }]) {
    expect(parsePlan(bad)).toBeUndefined()
  }
})

test('only a required check made not required is a relaxation', () => {
  const before = plan('required', 'none: small')
  expect(relaxed(undefined, plan('none: x', 'none: y'))).toEqual([])
  expect(relaxed(before, plan('screenshots: x', 'none: y'))).toEqual(['e2e'])
  expect(relaxed(before, plan('required', 'required'))).toEqual([])
  expect(relaxed(before, plan('required', 'none: y', 'one-pass: small'))).toEqual([])
})

test('the plan excuses the kinds it does not require, with its date and reason', () => {
  expect(planExcuses(undefined)).toEqual({})
  expect(planExcuses(plan('required', 'required'))).toEqual({ required: ['e2e', 'norms'] })
  expect(planExcuses(plan('none: docs', 'none: tiny'))).toEqual({ required: [], e2e: 'check plan, 2026-11-14: docs', norms: 'check plan, 2026-11-14: tiny' })
  expect(planExcuses(plan('screenshots: colour', 'required')).e2e).toBe('check plan, 2026-11-14: desktop and mobile screenshots in its place, colour')
})

test('the plan file sits under the data directory by repository and number, and its text lists each check', () => {
  expect(planPath('/data', 'Acme/Thing', 12)).toBe('/data/check-plans/acme/thing/12.json')
  expect(() => planPath('/data', '../x', 1)).toThrow()
  expect(planText(plan('none: docs', 'required'))).toContain('- e2e: none — docs\n- norms: required\n- review: full\n')
})

test('only an explicit required requires: a check left out of a plan is not required, norms or E2E', () => {
  const omitted = plan(undefined as any, undefined as any)
  expect(omitted.e2e.need).toBe('none')
  expect(omitted.norms.need).toBe('none')
  expect(planExcuses(omitted).required).toEqual([])
  expect(planExcuses(plan('required', 'required')).required).toEqual(['e2e', 'norms'])
})

test('the lock covers a required E2E and required norms, never the review depth', () => {
  const before = plan('required', 'required', 'full')
  expect(relaxed(before, plan('none: docs', 'none: tiny', 'one-pass: small'))).toEqual(['e2e', 'norms'])
  expect(relaxed(before, plan('required', 'required', 'one-pass: small'))).toEqual([])
  expect(planText(plan('required', 'required')).endsWith('\n\nThe ready gate requires the E2E and norms checks marked required; only the operator\'s waiver lifts one.')).toBe(true)
})
