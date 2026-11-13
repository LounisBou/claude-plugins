import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answersChoice, consentAnswer, consentDir, consentRecordOf, consentPath, parseConsentRecord, parseConsentSubject, quotesConsent } from './consent-record.ts'
import { kindFor, producersOf } from './pr-record.ts'

const RECORD = {
  v: 1, subject: { kind: 'e2e-waiver', repo: 'Owner/name', pr: 7 }, entry: 's1-abc',
  question: 'Waive E2E on name#7?', answer: 'yes, no E2E for this one, 2026-11-08', by: 'pane', at: '2026-11-08T00:00:00Z',
}

describe('consent records', () => {
  it('reads a record that keeps the contract', () => {
    assert.deepEqual(parseConsentRecord(RECORD), RECORD)
    for (const by of ['pane', 'coordinator', 'tab']) assert.equal(parseConsentRecord({ ...RECORD, by })?.by, by)
    assert.deepEqual(parseConsentSubject({ kind: 'auto-merge', repo: 'o/n' }), { kind: 'auto-merge', repo: 'o/n' })
  })

  it('refuses a record or a subject that breaks any field of it', () => {
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { subject: null }, { subject: { kind: 'e2e-waiver', repo: 'o/n' } }, { subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 0 } },
      { subject: { kind: 'auto-merge', repo: 'o/n', pr: 3 } }, { subject: { kind: 'merge', repo: 'o/n' } }, { subject: { kind: 'auto-merge', repo: 'o/..' } },
      { entry: '../x' }, { entry: 3 }, { question: 3 }, { answer: 'x'.repeat(20_001) }, { by: 'elsewhere' }, { at: 0 },
    ]
    for (const change of broken) assert.equal(parseConsentRecord({ ...RECORD, ...change }), undefined, JSON.stringify(change))
    for (const raw of [null, [], 'record']) assert.equal(parseConsentRecord(raw), undefined)
    assert.equal(parseConsentSubject([]), undefined)
  })

  it('files a record under its repository, the repository as GitHub compares it', () => {
    const record = parseConsentRecord(RECORD)!
    assert.equal(consentDir('/c', 'Owner/Name'), '/c/consents/owner/name')
    assert.equal(consentPath('/c', record), '/c/consents/owner/name/s1-abc.json')
  })

  it('takes a pressed choice for its text, and any other answer whole', () => {
    const choices = [{ letter: 'A', text: ' waive it on name#7 ' }, { letter: 'B', text: 'run it' }]
    assert.equal(consentAnswer('a : waive it on name#7', choices), 'waive it on name#7')
    assert.equal(consentAnswer('C', choices), '')
    assert.equal(consentAnswer('  go without it  ', choices), 'go without it')
  })

  it('lets a quote rest on the record of its own subject only, its answer held whole', () => {
    const record = parseConsentRecord(RECORD)!
    const subject = { kind: 'e2e-waiver', repo: 'owner/NAME', pr: 7 } as const
    assert.ok(quotesConsent(record, subject, 'operator:  yes, no E2E\nfor this one, 2026-11-08'))
    assert.ok(!quotesConsent(record, { ...subject, pr: 8 }, RECORD.answer))
    assert.ok(!quotesConsent(record, { kind: 'auto-merge', repo: 'owner/name' }, RECORD.answer))
    assert.ok(!quotesConsent(record, { ...subject, repo: 'other/name' }, RECORD.answer))
    assert.ok(!quotesConsent(record, subject, 'yes, no E2E'))
    const short = parseConsentRecord({ ...RECORD, answer: 'yes' })!
    assert.ok(!quotesConsent(short, subject, 'yes'))
    const merge = parseConsentRecord({ ...RECORD, subject: { kind: 'auto-merge', repo: 'owner/name' }, answer: 'auto-merge name, yes' })!
    assert.ok(quotesConsent(merge, { kind: 'auto-merge', repo: 'OWNER/name' }, 'auto-merge name, yes'))
  })

  it('reads an E2E exemption of a repository, which names no pull request and carries no other subject', () => {
    assert.deepEqual(parseConsentSubject({ kind: 'e2e-exemption', repo: 'o/n' }), { kind: 'e2e-exemption', repo: 'o/n' })
    assert.equal(parseConsentSubject({ kind: 'e2e-exemption', repo: 'o/n', pr: 3 }), undefined)
    const words = 'no E2E on this repository, 2026-11-13'
    const exemption = parseConsentRecord({ ...RECORD, subject: { kind: 'e2e-exemption', repo: 'owner/name' }, answer: words })!
    assert.ok(quotesConsent(exemption, { kind: 'e2e-exemption', repo: 'OWNER/name' }, words))
    assert.ok(!quotesConsent(exemption, { kind: 'auto-merge', repo: 'owner/name' }, words))
    assert.ok(!quotesConsent(exemption, { kind: 'e2e-waiver', repo: 'owner/name', pr: 7 }, words))
  })
})

describe('a consent record of a round answer', () => {
  const fields = {
    subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 3 }, entry: 's-1', question: 'Waive E2E?', answer: 'A : waive it, docs only',
    choices: [{ letter: 'A', text: 'waive it, docs only' }], by: 'pane' as const, at: '2026-11-08T00:00:00Z',
  }

  it('holds the answer as a quote must hold it', () => {
    assert.equal(consentRecordOf(fields)?.answer, 'waive it, docs only')
  })

  it('is none when there is nothing to quote, or the subject or the id breaks the contract', () => {
    assert.equal(consentRecordOf({ ...fields, answer: 'B' }), undefined)
    assert.equal(consentRecordOf({ ...fields, subject: { kind: 'e2e-waiver', repo: 'o/n' } }), undefined)
    assert.equal(consentRecordOf({ ...fields, entry: '../x' }), undefined)
  })
})

describe('words typed in the sender\'s own tab', () => {
  const choices = [{ letter: 'A', text: 'waive it, docs only' }, { letter: 'B', text: 'run the E2E' }]
  const [waive, run] = choices

  it('answers a choice by its letter alone, its letter set apart from nothing or its exact text, or its exact text alone', () => {
    for (const typed of ['A', ' a ', 'a)', 'A.', 'a) waive it, docs only', 'A — waive it,  docs only', 'A—waive it, docs only', 'a - WAIVE IT, docs only', 'waive it, docs only', '  WAIVE it,\n docs only ']) {
      assert.deepEqual(answersChoice(typed, choices), waive, typed)
    }
    for (const typed of ['b', 'B : run the e2e', 'RUN THE E2E']) assert.deepEqual(answersChoice(typed, choices), run, typed)
  })

  it('is no answer when it is anything else', () => {
    for (const typed of [
      '', 'C', 'C)', 'yes', 'go on with phase 2',
      'do not waive it, docs only', 'I say WAIVE IT, docs only, thanks', 'ok: waive it, docs only',
      'B waive it, docs only', 'B : waive it, docs only', 'A run the E2E', 'A - but not yet', 'A, but check the diff first', 'A go', 'a) yes',
    ]) assert.equal(answersChoice(typed, choices), undefined, typed)
    assert.equal(answersChoice('anything', []), undefined)
  })

  it('is no answer when a short choice text sits inside an unrelated prompt', () => {
    const short = [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }]
    assert.deepEqual(answersChoice('Yes', short), short[0])
    for (const typed of ['yes, and then rebase the branch on main', 'no idea, go on', 'B yes']) assert.equal(answersChoice(typed, short), undefined, typed)
  })

  it('files a record by the tab, a letter resolved to its text', () => {
    const fields = { subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 3 }, entry: 's-1', question: 'Waive E2E?', choices, by: 'tab' as const, at: '2026-11-10T00:00:00Z' }
    assert.equal(consentRecordOf({ ...fields, answer: 'A' })?.by, 'tab')
    assert.equal(consentRecordOf({ ...fields, answer: 'A' })?.answer, 'waive it, docs only')
  })
})

describe('record producers', () => {
  it('gives each kind its declared producer, and any other caller the open kind', () => {
    assert.equal(kindFor('pr-review'), 'review')
    assert.equal(kindFor('norms'), 'norms')
    assert.equal(kindFor('engine'), 'e2e')
    assert.equal(kindFor('orchestrator'), 'review')
    assert.deepEqual(producersOf('review').map(p => p.plugin), ['pr-review', 'orchestrator'])
    assert.deepEqual(producersOf('e2e'), [])
  })
})
