import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  archiveOf, endedLines, isLedgerMarked, ledgerLineOf, ledgerLines, LEDGER_VERSION, parseLedgerLine, parsePrRef, prKey,
  blockerFallen, readyRows, readyRowsLine, statusText, unattended, unattendedLine, UNATTENDED_AFTER_MS, untilOf, withArchived, withLine, withoutLines, type LedgerLine,
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

  describe('a ready row nobody is on', () => {
    // A dispatch row, open and ready unless changed; a field changed to undefined is left out.
    const rowText = (change: Record<string, unknown> = {}): string => {
      const all: Record<string, unknown> = { id: 12, state: 'open', label: 'TOKENDRIFT: the context fills', blocker: 'none', ...change }
      for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key]
      return `${JSON.stringify(all)}\n`
    }
    const ready = (text: string, over: { lines?: LedgerLine[]; live?: string[] } = {}) =>
      readyRows({ texts: [text], lines: over.lines ?? [], live: new Set(over.live ?? []) })

    it('is named with its id and keyword when its blocker is none and no agent, no pull request holds it', () => {
      assert.deepEqual(ready(rowText()), [{ id: 12, keyword: 'TOKENDRIFT' }])
      assert.deepEqual(ready(rowText() + rowText({ id: 13, label: 'GATEFIX: a gate' })).map(r => r.id), [12, 13])
    })

    it('is not named while a live agent is on it, by its subject or by the row note', () => {
      assert.deepEqual(ready(rowText(), { live: ['Agent: tokendrift'] }), [])
      assert.deepEqual(ready(rowText({ note: 'Agent: drift-2, dispatched' }), { live: ['Agent: drift-2'] }), [])
      assert.deepEqual(ready(rowText(), { live: ['Agent: gatefix'] }).length, 1)
      assert.deepEqual(ready(rowText(), { live: ['Orch: tokendrift'] }).length, 1)
      // A whole word of the subject holds it, a piece of a word does not.
      assert.deepEqual(ready(rowText({ label: 'FIX: a thing' }), { live: ['Agent: prefix-bug'] }).length, 1)
      assert.deepEqual(ready(rowText({ label: 'FIX: a thing' }), { live: ['Agent: fix-2 [a1b2c3]'] }), [])
    })

    it('is not named while an open pull request holds it, by its agent or by the row note', () => {
      assert.deepEqual(ready(rowText(), { lines: [line({ agent: 'Agent: tokendrift' })] }), [])
      assert.deepEqual(ready(rowText({ note: 'claude-plugins#7 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }), [])
      assert.deepEqual(ready(rowText({ note: 'other-claude-plugins#7 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }).length, 1)
      assert.deepEqual(ready(rowText({ note: 'claude-plugins#71 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }).length, 1)
      assert.deepEqual(ready(rowText(), { lines: [line({ agent: 'Agent: other' })] }).length, 1)
    })

    it('is not named with a blocker, a deferral that has no date, a closed state, or no blocker said', () => {
      for (const change of [{ blocker: 'row 4 closed' }, { blocker: undefined }, { deferred: 'later, 2026-11-14' }, { state: 'closed' }]) {
        assert.deepEqual(ready(rowText(change)), [], JSON.stringify(change))
      }
      assert.deepEqual(ready(rowText({ deferred: ' ' })).length, 1)
    })

    it('a deferred row comes back on its until date, not before, flagged as deferred; any other blocker is no date', () => {
      const MOMENT = Date.parse('2026-11-28T08:00:00Z')
      const deferredAt = (blocker: string | undefined, now: number) =>
        readyRows({ texts: [rowText({ deferred: 'later, 2026-11-15', blocker })], lines: [], live: new Set(), now })
      assert.deepEqual(deferredAt('until 2026-11-28T08:00:00Z', MOMENT - 1), [], 'one second before')
      assert.deepEqual(deferredAt('until 2026-11-28T08:00:00Z', MOMENT), [{ id: 12, keyword: 'TOKENDRIFT', deferred: true }], 'at the date')
      assert.deepEqual(deferredAt('none', MOMENT), [])
      assert.deepEqual(deferredAt('measure dashboard p95 under 300 ms', MOMENT), [])
      assert.deepEqual(deferredAt(undefined, MOMENT), [])
    })

    it('a due deferred row is held by a live agent or an open pull request as any row is, and comes after the ready rows beside it', () => {
      const MOMENT = Date.parse('2026-11-28T08:00:00Z')
      const due = rowText({ deferred: 'later', blocker: 'until 2026-11-28T08:00:00Z' })
      const at = (text: string, over: { lines?: LedgerLine[]; live?: string[] } = {}) =>
        readyRows({ texts: [text], lines: over.lines ?? [], live: new Set(over.live ?? []), now: MOMENT })
      assert.deepEqual(at(due, { live: ['Agent: tokendrift'] }), [])
      assert.deepEqual(at(due, { lines: [line({ agent: 'Agent: tokendrift' })] }), [])
      const both = at(rowText({ id: 13, label: 'GATEFIX: a gate' }) + due)
      assert.deepEqual(both.map(r => [r.id, r.deferred === true]), [[13, false], [12, true]])
      assert.equal(readyRowsLine(both)?.split('\n').length, 2)
    })

    it('names a row with no keyword as such, and only its note can hold it', () => {
      assert.equal(readyRowsLine(ready(rowText({ label: undefined }))), 'Lignes prêtes sans agent : 12 no keyword')
      assert.equal(readyRowsLine(ready(rowText({ label: ': no word' }), { live: ['Agent: tokendrift'] })), 'Lignes prêtes sans agent : 12 no keyword')
      assert.deepEqual(ready(rowText({ label: undefined, note: 'Agent: tokendrift' }), { live: ['Agent: tokendrift [a1b2c3]'] }), [])
    })

    it('reads the rows of every record', () => {
      const rows = readyRows({ texts: [rowText(), rowText({ id: 3, label: 'OTHERWORK: x' })], lines: [], live: new Set() })
      assert.deepEqual(rows.map(r => r.id), [12, 3])
    })

    it('a moment blocker is named once its until time has passed, and not before; a measure is never named', () => {
      const MOMENT = Date.parse('2026-11-15T11:00:00Z')
      const at = (blocker: string, now: number) => readyRows({ texts: [rowText({ blocker })], lines: [], live: new Set(), now }).length
      assert.equal(at('until 2026-11-15T11:00:00Z', MOMENT - 1), 0, 'one second before')
      assert.equal(at('until 2026-11-15T11:00:00Z', MOMENT), 1, 'at the instant')
      assert.equal(at('until 2026-11-15T11:00:00Z', MOMENT + 3_600_000), 1, 'after')
      assert.equal(at('measure dashboard p95 under 300 ms', MOMENT + 3_600_000), 0, 'a measure never falls by itself')
      assert.equal(at('until 2026-02-30T00:00:00Z', MOMENT + 3_600_000), 0, 'a time that does not exist is no moment')
      assert.equal(at('PR acme/app#7 merged', MOMENT + 3_600_000), 0, 'an artifact form is the takeover\'s to check')
    })

    it('blockerFallen: none always; until by the clock; measure and the artifact forms never on the clock', () => {
      const MOMENT = Date.parse('2026-11-15T11:00:00Z')
      assert.equal(blockerFallen('none', 0), true)
      assert.equal(blockerFallen('until 2026-11-15T11:00:00Z', MOMENT), true)
      assert.equal(blockerFallen('until 2026-11-15T11:00:00Z', MOMENT - 1), false)
      assert.equal(blockerFallen('measure 3 runs', Number.MAX_SAFE_INTEGER), false)
      assert.equal(blockerFallen('row 4 closed', Number.MAX_SAFE_INTEGER), false)
      assert.equal(blockerFallen(undefined, Number.MAX_SAFE_INTEGER), false)
    })

    it('reads the clock itself when no now is given: an until in the past is ready, one in the future is not', () => {
      assert.equal(readyRows({ texts: [rowText({ blocker: 'until 2000-01-01T00:00:00Z' })], lines: [], live: new Set() }).length, 1)
      assert.equal(readyRows({ texts: [rowText({ blocker: 'until 2999-01-01T00:00:00Z' })], lines: [], live: new Set() }).length, 0)
    })

    it('untilOf reads the one form, to the second with Z, and nothing else', () => {
      assert.equal(untilOf('until 2026-11-15T11:00:00Z'), Date.parse('2026-11-15T11:00:00Z'))
      for (const bad of ['until 2026-11-15T11:00Z', 'until 2026-11-15T11:00:00.000Z', 'until 2026-11-15T11:00:00+01:00', 'until 2026-02-30T00:00:00Z', 'until soon', 'none']) {
        assert.equal(untilOf(bad), undefined, bad)
      }
    })

    it('leaves out the ledger lines, broken lines and rows with no number', () => {
      assert.deepEqual(ready(`${JSON.stringify(line())}\nnot json\n[]\n${rowText({ id: 'r-1' })}`), [])
    })

    it('is said in one line, absent when there is none', () => {
      assert.equal(readyRowsLine([]), null)
      assert.equal(readyRowsLine([{ id: 12, keyword: 'TOKENDRIFT' }, { id: 13, keyword: 'GATEFIX' }]), 'Lignes prêtes sans agent : 12 TOKENDRIFT, 13 GATEFIX')
    })

    it('puts the deferred rows whose date has come to the operator as a question, on a line of their own', () => {
      const due = { id: 14, keyword: 'LEARNING', deferred: true as const }
      assert.equal(readyRowsLine([due]), "Lignes différées à leur date de réexamen : 14 LEARNING — à demander à l'opérateur : relancer ou abandonner")
      assert.equal(
        readyRowsLine([{ id: 12, keyword: 'TOKENDRIFT' }, due]),
        "Lignes prêtes sans agent : 12 TOKENDRIFT\nLignes différées à leur date de réexamen : 14 LEARNING — à demander à l'opérateur : relancer ou abandonner",
      )
    })
  })
})
