import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  archiveOf, endedLines, isLedgerMarked, ledgerLineOf, ledgerLines, LEDGER_VERSION, parseLedgerLine, parsePrRef, prKey,
  statusText, unattended, unattendedLine, UNATTENDED_AFTER_MS, withArchived, withLine, withoutLines, type LedgerLine,
} from './pr-ledger.ts'

const AT = '2026-11-14T10:00:00Z'
const NOW = Date.parse('2026-11-14T11:00:00Z')

// A line of the ledger, `working` unless changed; a field changed to undefined is left out.
const line = (change: Record<string, unknown> = {}): LedgerLine => {
  const all: Record<string, unknown> = { v: LEDGER_VERSION, ledger: 'pr', repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: seven', since: AT, updated: AT, ...change }
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key]
  return all as unknown as LedgerLine
}

describe('the pull request ledger', () => {
  it('reads a line of each status, and refuses one that breaks its shape', () => {
    const working = line()
    const waiting = line({ status: 'waiting', on: 'CI', agent: undefined })
    const parked = line({ status: 'parked', ruling: 'later, 2026-11-14', agent: undefined })
    for (const kept of [working, waiting, parked]) assert.deepEqual(parseLedgerLine(JSON.parse(JSON.stringify(kept))), JSON.parse(JSON.stringify(kept)))
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { ledger: 'row' }, { repo: 'acme' }, { pr: 0 }, { pr: 1.5 }, { status: 'done' }, { since: 3 }, { updated: null },
      { status: 'working', agent: ' ' }, { status: 'waiting', agent: undefined, on: '' }, { status: 'parked', agent: undefined, ruling: '' },
    ]
    for (const change of broken) assert.equal(parseLedgerLine({ ...working, ...change }), undefined, JSON.stringify(change))
    for (const raw of [null, [], 'line', { id: 1, state: 'open' }]) assert.equal(parseLedgerLine(raw), undefined)
  })

  it('tells a ledger line from a dispatch row by its mark alone, even a broken one', () => {
    assert.equal(isLedgerMarked(line()), true)
    assert.equal(isLedgerMarked({ ledger: 'pr', v: 9 }), true)
    assert.equal(isLedgerMarked({ id: 3, state: 'open' }), false)
    assert.equal(isLedgerMarked(null), false)
  })

  it('reads the lines of a record beside its rows, the last line of a pull request standing', () => {
    const text = [
      JSON.stringify({ id: 1, state: 'open', label: 'a row' }),
      JSON.stringify(line()),
      'no json',
      JSON.stringify(line({ status: 'waiting', on: 'CI', agent: undefined, updated: '2026-11-14T10:30:00Z' })),
      JSON.stringify(line({ pr: 8 })),
    ].join('\n')
    assert.deepEqual(ledgerLines(text).map(l => [l.pr, l.status]), [[7, 'waiting'], [8, 'working']])
  })

  it('names a pull request as <owner/name>#<n>, and reads that name back', () => {
    assert.equal(prKey('acme/app', 7), 'acme/app#7')
    assert.deepEqual(parsePrRef('acme/app#7'), { repo: 'acme/app', pr: 7 })
    for (const bad of ['app#7', 'acme/app#', 'acme/app#0', 'acme/app#x', 'acme/../app#3']) assert.equal(parsePrRef(bad), undefined, bad)
  })

  it('builds a line, keeping its start while the status holds and starting it over when it changes', () => {
    const first = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: seven' }, new Date(AT))
    assert.deepEqual(first, line({ since: '2026-11-14T10:00:00Z', updated: '2026-11-14T10:00:00Z' }))
    const later = new Date('2026-11-14T10:20:00Z')
    const again = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: seven' }, later, first)
    assert.equal(again.since, first.since)
    // Setting the same status again is a fresh setting: the wait's age is read from `updated`.
    assert.equal(again.updated, '2026-11-14T10:20:00Z')
    const moved = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'waiting', on: 'the CI' }, later, first)
    assert.equal(moved.since, '2026-11-14T10:20:00Z')
    assert.equal(moved.agent, undefined)
    assert.equal(ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: other' }, later, first).since, '2026-11-14T10:20:00Z')
  })

  it('sets one line per pull request in a record, rows and other lines untouched, and takes lines out', () => {
    const row = JSON.stringify({ id: 1, state: 'open' })
    const text = `${row}\n${JSON.stringify(line())}\n${JSON.stringify(line({ pr: 8 }))}\n`
    const set = withLine(text, line({ status: 'parked', ruling: 'later', agent: undefined }))
    assert.deepEqual(set.split('\n').filter(Boolean).map(l => JSON.parse(l).status ?? 'row'), ['row', 'working', 'parked'])
    assert.equal(withLine('', line()), `${JSON.stringify(line())}\n`)
    const out = withoutLines(text, ['acme/app#7'])
    assert.equal(out, `${row}\n${JSON.stringify(line({ pr: 8 }))}\n`)
  })

  it('archives beside the record, each line stamped with its archiving', () => {
    assert.equal(archiveOf('/b/dispatch-record.jsonl'), '/b/dispatch-record.archive.jsonl')
    assert.equal(archiveOf('/b/record'), '/b/record.archive.jsonl')
    const archived = withArchived('{"old":1}', [line()], new Date('2026-11-14T12:00:00.500Z'))
    assert.deepEqual(archived.split('\n'), ['{"old":1}', JSON.stringify({ ...line(), archived: '2026-11-14T12:00:00Z' }), ''])
    assert.equal(withArchived('', [], new Date(AT)), '')
  })

  it('says each status in the operator\'s words', () => {
    assert.equal(statusText(line()), 'en cours (agent Agent: seven)')
    assert.equal(statusText(line({ status: 'waiting', on: 'la CI', agent: undefined })), 'attend la CI depuis 2026-11-14T10:00Z')
    assert.equal(statusText(line({ status: 'parked', ruling: 'plus tard', agent: undefined })), "en attente par l'opérateur")
  })
})

describe('an unattended pull request', () => {
  const open = (pr: number, createdAt: string | null = '2026-11-13T09:00:00Z') => ({ repo: 'acme/app', pr, createdAt })

  it('is an open pull request in no record, since it was opened', () => {
    assert.deepEqual(unattended({ open: [open(9)], lines: [], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 9, since: '2026-11-13T09:00:00Z' }])
  })

  it('is one whose agent no longer runs, since its line was last set', () => {
    assert.deepEqual(unattended({ open: [open(7)], lines: [line()], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 7, since: AT }])
    assert.deepEqual(unattended({ open: [open(7)], lines: [line()], live: new Set(['Agent: seven']), now: NOW }), [])
  })

  it('is one whose wait was not set again within the threshold', () => {
    const fresh = line({ status: 'waiting', on: 'CI', agent: undefined, updated: new Date(NOW - UNATTENDED_AFTER_MS).toISOString() })
    assert.deepEqual(unattended({ open: [open(7)], lines: [fresh], live: new Set(), now: NOW }), [])
    const stale = { ...fresh, updated: new Date(NOW - UNATTENDED_AFTER_MS - 1).toISOString() }
    assert.deepEqual(unattended({ open: [open(7)], lines: [stale], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 7, since: stale.updated }])
    const unreadable = { ...fresh, updated: 'soon' }
    assert.deepEqual(unattended({ open: [open(7)], lines: [unreadable], live: new Set(), now: NOW }).length, 1)
  })

  it('is never one the operator parked, nor one another orchestration records', () => {
    const parked = line({ status: 'parked', ruling: 'later', agent: undefined, updated: '2026-01-01T00:00:00Z' })
    assert.deepEqual(unattended({ open: [open(7)], lines: [parked], live: new Set(), now: NOW }), [])
    assert.deepEqual(unattended({ open: [open(9)], lines: [], live: new Set(), now: NOW, claimed: new Set(['acme/app#9']) }), [])
  })

  it('is said in one line, absent when there is none, and the repositories the forge did not answer are said unknown', () => {
    assert.equal(unattendedLine([], []), null)
    const list = [{ repo: 'acme/app', pr: 7, since: AT }, { repo: 'acme/app', pr: 9, since: null }]
    assert.equal(unattendedLine(list, []), 'PR délaissées : acme/app#7 (sans agent depuis 2026-11-14T10:00Z), acme/app#9 (sans agent depuis ?)')
    assert.equal(unattendedLine([], ['acme/lib']), 'PR délaissées : inconnues pour acme/lib (forge illisible)')
    assert.equal(unattendedLine(list.slice(0, 1), ['acme/lib', 'acme/web'], () => '11:00'),
      'PR délaissées : acme/app#7 (sans agent depuis 11:00) ; inconnues pour acme/lib, acme/web (forge illisible)')
  })

  it('ends the lines of the pull requests no longer open, in the repositories the forge answered for', () => {
    const lines = [line(), line({ pr: 8 }), line({ repo: 'acme/lib', pr: 3 })]
    const open = new Map([['acme/app', [8]]])
    assert.deepEqual(endedLines(lines, open).map(l => prKey(l.repo, l.pr)), ['acme/app#7'])
  })
})
