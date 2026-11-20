import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  archiveOf, endedLines, isLedgerMarked, ledgerLineOf, ledgerLines, LEDGER_EARLIER_KEPT, LEDGER_VERSION, parseLedgerLine, parsePrRef, prKey,
  blockerFallen, isFreshWait, readyRows, readyRowsLine, statusText, subjectOf, atWord, unattended, unattendedLine, unattendedPaneLines, unattendedParts, UNATTENDED_AFTER_MS, waitsOnOperator, untilOf, withArchived, withLine, withoutEarlier, withoutLines, type LedgerLine,
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

  it('keeps every agent put to work on it before, the newest first, each once, and none past a wait or a parking', () => {
    const first = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: author' }, new Date(AT))
    assert.equal(first.earlier, undefined)
    const review = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: review r1' }, new Date(AT), first)
    assert.deepEqual(review.earlier, ['Agent: author'])
    const fix = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: fix' }, new Date(AT), review)
    assert.deepEqual(fix.earlier, ['Agent: review r1', 'Agent: author'])
    // The author put back on it leaves the list it was in; the same agent again changes nothing.
    assert.deepEqual(ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: author' }, new Date(AT), fix).earlier, ['Agent: fix', 'Agent: review r1'])
    assert.deepEqual(ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: 'Agent: fix' }, new Date(AT), fix).earlier, fix.earlier)
    assert.equal(ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'waiting', on: 'CI' }, new Date(AT), fix).earlier, undefined)
    // Bounded: the oldest fall off.
    let held = first
    for (let n = 0; n < 12; n++) held = ledgerLineOf({ repo: 'acme/app', pr: 7, status: 'working', agent: `Agent: ${n}` }, new Date(AT), held)
    assert.equal(held.earlier?.length, LEDGER_EARLIER_KEPT)
    // Read back from the record; a list that breaks its shape is dropped, the line kept.
    assert.deepEqual(parseLedgerLine(JSON.parse(JSON.stringify(fix))), JSON.parse(JSON.stringify(fix)))
    assert.deepEqual(parseLedgerLine({ ...fix, earlier: 'Agent: author' })?.earlier, undefined)
    assert.deepEqual(parseLedgerLine({ ...fix, earlier: ['Agent: author', ' ', 3] })?.earlier, ['Agent: author'])
  })

  it('an agent the orchestrator puts to work on a pull request leaves the earlier list of every other line: it no longer works there', () => {
    const row = JSON.stringify({ id: 1, state: 'open' })
    const other = line({ pr: 8, agent: 'Agent: review r1', earlier: ['Agent: author', 'Agent: fix'] })
    const alone = line({ pr: 9, agent: 'Agent: review r2', earlier: ['Agent: author'] })
    const text = `${row}\n${JSON.stringify(other)}\n${JSON.stringify(alone)}\n`
    const set = withoutEarlier(text, 'Agent: author')
    const lines = set.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map(l => [l['pr'] ?? 'row', l['earlier']]), [['row', undefined], [8, ['Agent: fix']], [9, undefined]])
    // The line keeps its place, its times and its other fields, read or not.
    assert.deepEqual(lines[1], { ...JSON.parse(JSON.stringify(other)), earlier: ['Agent: fix'] })
    const extra = `${JSON.stringify({ ...other, note: 'kept' })}\n`
    assert.equal((JSON.parse(withoutEarlier(extra, 'Agent: author').trim()) as Record<string, unknown>)['note'], 'kept')
    // An agent in no list, and a record with no line, are left as they were; writing a line prunes nobody.
    assert.equal(withoutEarlier(text, 'Agent: nobody'), text)
    assert.equal(withoutEarlier(`${row}\nnot json\n`, 'Agent: author'), `${row}\nnot json\n`)
    assert.equal(withLine(text, line({ agent: 'Agent: author' })), `${text}${JSON.stringify(line({ agent: 'Agent: author' }))}\n`)
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
  const open = (pr: number, labels?: string[]) => ({ repo: 'acme/app', pr, ...(labels === undefined ? {} : { labels }) })

  it('is never an open pull request no line holds: it is nobody\'s, drawn under no orchestration', () => {
    assert.deepEqual(unattended({ open: [open(9)], lines: [], live: new Set(), now: NOW }), [])
    // Of three open, the two the lines name.
    const lines = [line({ pr: 4 }), line({ pr: 5 })]
    assert.deepEqual(unattended({ open: [open(4), open(5), open(6)], lines, live: new Set(), now: NOW }).map(u => u.pr), [4, 5])
  })

  it('is one whose agent no longer runs, since its line was last set', () => {
    assert.deepEqual(unattended({ open: [open(7)], lines: [line()], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 7, since: AT }])
    assert.deepEqual(unattended({ open: [open(7)], lines: [line()], live: new Set(['Agent: seven']), now: NOW }), [])
  })

  it('is never one an agent put to work on it before still runs, though the agent named last is gone', () => {
    // An implementer still running, a reviewer put on its line then closed.
    const reviewed = line({ agent: 'Agent: review r1', earlier: ['Agent: author'] })
    assert.deepEqual(unattended({ open: [open(7)], lines: [reviewed], live: new Set(['Agent: author']), now: NOW }), [])
    assert.deepEqual(unattended({ open: [open(7)], lines: [reviewed], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 7, since: AT }])
  })

  it('is one whose wait was not set again within the threshold', () => {
    const fresh = line({ status: 'waiting', on: 'CI', agent: undefined, updated: new Date(NOW - UNATTENDED_AFTER_MS).toISOString() })
    assert.deepEqual(unattended({ open: [open(7)], lines: [fresh], live: new Set(), now: NOW }), [])
    const stale = { ...fresh, updated: new Date(NOW - UNATTENDED_AFTER_MS - 1).toISOString() }
    assert.deepEqual(unattended({ open: [open(7)], lines: [stale], live: new Set(), now: NOW }), [{ repo: 'acme/app', pr: 7, since: stale.updated }])
    const unreadable = { ...fresh, updated: 'soon' }
    assert.deepEqual(unattended({ open: [open(7)], lines: [unreadable], live: new Set(), now: NOW }).length, 1)
  })

  it('is never one the operator parked', () => {
    const parked = line({ status: 'parked', ruling: 'later', agent: undefined, updated: '2026-01-01T00:00:00Z' })
    assert.deepEqual(unattended({ open: [open(7)], lines: [parked], live: new Set(), now: NOW }), [])
  })

  it('is said on the anomaly line, absent when there is none, and the repositories the forge did not answer are said unknown', () => {
    assert.equal(unattendedLine([], []), null)
    const list = [{ repo: 'acme/app', pr: 7, since: AT }, { repo: 'acme/app', pr: 9, since: null }]
    assert.equal(unattendedLine(list, []), 'En anomalie : acme/app#7 (sans agent depuis 2026-11-14T10:00Z), acme/app#9 (sans agent depuis ?)')
    assert.equal(unattendedLine([], ['acme/lib']), 'En anomalie : inconnues pour acme/lib (forge illisible)')
    assert.equal(unattendedLine(list.slice(0, 1), ['acme/lib', 'acme/web'], () => '11:00'),
      'En anomalie : acme/app#7 (sans agent depuis 11:00) ; inconnues pour acme/lib, acme/web (forge illisible)')
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

    it('is named with its id, keyword and subject when its blocker is none and no agent, no pull request holds it', () => {
      assert.deepEqual(ready(rowText()), [{ id: 12, keyword: 'TOKENDRIFT', subject: 'the context fills' }])
      assert.deepEqual(ready(rowText() + rowText({ id: 13, label: 'GATEFIX: a gate' })).map(r => r.id), [12, 13])
    })

    it('is not named while a live agent is on its row, whatever its title shares with the label', () => {
      const held = rowText({ agent: 'Agent: row knows its agent' })
      assert.deepEqual(ready(held, { live: ['Agent: row knows its agent'] }), [])
      assert.deepEqual(ready(held, { live: ['Agent: row knows its agent [a1b2c3]'] }), [])
      assert.deepEqual(ready(held, { live: ['Agent: ROW knows its agent'] }), [])
      assert.deepEqual(ready(held, { live: ['Agent: gatefix', 'Orch: row knows its agent'] }).length, 1)
    })

    it('is named once its agent has ended: the live set frees the row', () => {
      assert.deepEqual(ready(rowText({ agent: 'Agent: row knows its agent' }), { live: [] }).map(r => r.id), [12])
    })

    it('a rotation moves the row to the new agent: only the one the row names holds it', () => {
      const before = rowText({ agent: 'Agent: first' })
      const after = rowText({ agent: 'Agent: second' })
      assert.deepEqual(ready(before, { live: ['Agent: first'] }), [])
      assert.deepEqual(ready(after, { live: ['Agent: first'] }).length, 1)
      assert.deepEqual(ready(after, { live: ['Agent: second'] }), [])
    })

    it('guesses no agent: a title with the label\'s word, or a note naming one, holds nothing', () => {
      assert.deepEqual(ready(rowText(), { live: ['Agent: tokendrift'] }).length, 1)
      assert.deepEqual(ready(rowText({ note: 'Held by Agent: drift-2, dispatched' }), { live: ['Agent: drift-2'] }).length, 1)
      assert.deepEqual(ready(rowText({ note: 'Dispatched: Agent: drift-2' }), { live: ['Agent: drift-2'] }).length, 1)
    })

    it('is not named while an open pull request holds it, by its agent (the row\'s) or by the row note', () => {
      const own = rowText({ agent: 'Agent: tokendrift' })
      assert.deepEqual(ready(own, { lines: [line({ agent: 'Agent: tokendrift [a1b2c3]' })] }), [])
      assert.deepEqual(ready(rowText({ note: 'claude-plugins#7 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }), [])
      assert.deepEqual(ready(rowText({ note: 'other-claude-plugins#7 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }).length, 1)
      assert.deepEqual(ready(rowText({ note: 'claude-plugins#71 draft' }), { lines: [line({ repo: 'acme/claude-plugins', agent: 'Agent: x' })] }).length, 1)
      assert.deepEqual(ready(own, { lines: [line({ agent: 'Agent: other' })] }).length, 1)
      // A title of the label's word on the pull request holds nothing; an agent put on the pull request before the last one holds it.
      assert.deepEqual(ready(rowText(), { lines: [line({ agent: 'Agent: tokendrift' })] }).length, 1)
      assert.deepEqual(ready(own, { lines: [line({ agent: 'Agent: review r1', earlier: ['Agent: tokendrift'] })] }), [])
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
      assert.deepEqual(deferredAt('until 2026-11-28T08:00:00Z', MOMENT), [{ id: 12, keyword: 'TOKENDRIFT', subject: 'the context fills', deferred: true }], 'at the date')
      assert.deepEqual(deferredAt('none', MOMENT), [])
      assert.deepEqual(deferredAt('measure dashboard p95 under 300 ms', MOMENT), [])
      assert.deepEqual(deferredAt(undefined, MOMENT), [])
    })

    it('a due deferred row is held by a live agent or an open pull request as any row is, and comes after the ready rows beside it', () => {
      const MOMENT = Date.parse('2026-11-28T08:00:00Z')
      const due = rowText({ deferred: 'later', blocker: 'until 2026-11-28T08:00:00Z', agent: 'Agent: tokendrift' })
      const at = (text: string, over: { lines?: LedgerLine[]; live?: string[] } = {}) =>
        readyRows({ texts: [text], lines: over.lines ?? [], live: new Set(over.live ?? []), now: MOMENT })
      assert.deepEqual(at(due, { live: ['Agent: tokendrift'] }), [])
      assert.deepEqual(at(due, { lines: [line({ agent: 'Agent: tokendrift' })] }), [])
      const both = at(rowText({ id: 13, label: 'GATEFIX: a gate' }) + due)
      assert.deepEqual(both.map(r => [r.id, r.deferred === true]), [[13, false], [12, true]])
      assert.equal(readyRowsLine(both)?.split('\n').length, 2)
    })

    it('names a row with no keyword as such, and only its agent can hold it', () => {
      assert.equal(readyRowsLine(ready(rowText({ label: undefined }))), 'Sujets prêts sans agent : no keyword (ligne 12)')
      assert.equal(readyRowsLine(ready(rowText({ label: ': no word' }), { live: ['Agent: tokendrift'] })), 'Sujets prêts sans agent : no word (ligne 12)')
      assert.deepEqual(ready(rowText({ label: undefined, agent: 'Agent: tokendrift' }), { live: ['Agent: tokendrift [a1b2c3]'] }), [])
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

    it('is said in one line, each row led by its subject with its id after it, absent when there is none', () => {
      assert.equal(readyRowsLine([]), null)
      assert.equal(
        readyRowsLine([{ id: 12, keyword: 'TOKENDRIFT', subject: 'the context fills, then drifts' }, { id: 13, keyword: 'GATEFIX', subject: 'a gate' }]),
        'Sujets prêts sans agent : the context fills, then drifts (ligne 12) ; a gate (ligne 13)',
      )
    })

    it('names a row whose label has no subject by its keyword', () => {
      assert.equal(readyRowsLine([{ id: 12, keyword: 'TOKENDRIFT', subject: '' }]), 'Sujets prêts sans agent : TOKENDRIFT (ligne 12)')
      assert.equal(readyRowsLine(ready(rowText({ label: 'TOKENDRIFT' }))), 'Sujets prêts sans agent : TOKENDRIFT (ligne 12)')
    })

    it('puts the deferred rows whose date has come to the operator as a question, on a line of their own', () => {
      const due = { id: 14, keyword: 'LEARNING', subject: 'answer the learning questions', deferred: true as const }
      assert.equal(readyRowsLine([due]), "Sujets différés à leur date de réexamen : answer the learning questions (ligne 14) — à demander à l'opérateur : relancer ou abandonner")
      assert.equal(
        readyRowsLine([{ id: 12, keyword: 'TOKENDRIFT', subject: 'the context fills' }, due]),
        "Sujets prêts sans agent : the context fills (ligne 12)\nSujets différés à leur date de réexamen : answer the learning questions (ligne 14) — à demander à l'opérateur : relancer ou abandonner",
      )
    })

    it('says a label in plain words: past its keyword, up to where its detail starts, cut at a word', () => {
      assert.equal(subjectOf('SUBJECTS: every orchestrator names subjects to the operator, never rows: the rule in the rulebook'), 'every orchestrator names subjects to the operator, never rows')
      assert.equal(subjectOf('PANEE2E: pane-e2e.sh fails 5 checks on main (round-listed.json not written)'), 'pane-e2e.sh fails 5 checks on main')
      assert.equal(subjectOf('LEARNING: Q1 A, Q2 A; Q4-11 held'), 'Q1 A, Q2 A')
      assert.equal(subjectOf('FINISHLINE: the goal row — release 3.1 installed (here and there)'), 'the goal row — release 3.1 installed')
      assert.equal(subjectOf('M7 SOURCE: no pull request grows the prompts; measured'), 'no pull request grows the prompts')
      assert.equal(subjectOf('RELEASE 2026-11-18: release pull request for the plugins changed (since 3.1)'), 'release pull request for the plugins changed')
      assert.equal(subjectOf('3-bis C: correction round on the gate'), 'correction round on the gate')
      assert.equal(subjectOf('Add the retry knob'), 'Add the retry knob')
      assert.equal(subjectOf('  TOKENDRIFT:   the   context  fills  '), 'the context fills')
      assert.equal(subjectOf('TOKENDRIFT'), 'TOKENDRIFT')
      assert.equal(subjectOf('TOKENDRIFT:'), '')
      assert.equal(subjectOf(''), '')
      assert.equal(subjectOf('FIX: see https://x.com/a for the trace'), 'see https://x.com/a for the trace')
      assert.equal(subjectOf('DEPLOY: at 10:00 tonight: then the rest'), 'at 10:00 tonight')
      assert.equal(subjectOf('https://x.com/a broken'), 'https://x.com/a broken')
      assert.equal(subjectOf('(WIP) the thing'), '(WIP) the thing')
      assert.equal(subjectOf('FIX: C-- and v1.2.'), 'C-- and v1.2.')
      assert.equal(subjectOf('KEY: the end —  '), 'the end')
      assert.equal(Array.from(subjectOf(`LONG: ${'😀'.repeat(120)}`)).length, 91, 'cut at a character, never inside one')
      assert.equal(atWord('a  goal\n spread ,  '), 'a goal spread')
      assert.equal(atWord('one two three', 8), 'one two…')
      const long = subjectOf(`LONG: ${'word '.repeat(40)}`)
      assert.ok(long.length <= 91 && long.endsWith('word…'), long)
    })
  })
})

describe('what waits on the operator, and what is in anomaly', () => {
  const open = (pr: number, labels: string[] = ['Not Ready']) => ({ repo: 'acme/app', pr, labels })
  // Each pull request has its line, an agent that no longer runs on it unless the test gives its own.
  const read = (input: { open: ReturnType<typeof open>[]; lines?: LedgerLine[]; live?: string[]; autoMerge?: string[] }) =>
    unattended({ open: input.open, lines: input.lines ?? input.open.map(o => line({ pr: o.pr, agent: 'Agent: gone' })), live: new Set(input.live ?? []), now: NOW,
      ...(input.autoMerge === undefined ? {} : { autoMerge: new Set(input.autoMerge) }) })

  it('puts a Ready pull request with no agent on the operator', () => {
    assert.deepEqual(read({ open: [open(9, ['Ready'])] }), [{ repo: 'acme/app', pr: 9, since: AT, waits: { why: 'ready' } }])
    // A Ready pull request whose agent no longer runs is no abandoned one: it waits on his merge.
    assert.deepEqual(read({ open: [open(7, ['Ready'])], lines: [line()] }), [{ repo: 'acme/app', pr: 7, since: AT, waits: { why: 'ready' } }])
    // The label is read whatever its case.
    assert.equal(read({ open: [open(9, ['ready'])] })[0]?.waits?.why, 'ready')
  })

  it('leaves a Ready pull request off the operator\'s line only where the auto-merge list names its repository', () => {
    // Named: it is the orchestrator's to merge.
    assert.deepEqual(read({ open: [open(9, ['Ready'])], autoMerge: ['acme/app'] }), [])
    assert.deepEqual(read({ open: [{ repo: 'Acme/App', pr: 9, labels: ['Ready'] }], lines: [line({ pr: 9, repo: 'Acme/App', agent: 'Agent: gone' })], autoMerge: ['acme/app'] }), [])
    // Not named (another repository, an empty list, no list): it stays his, as before.
    for (const autoMerge of [['acme/other'], [], undefined]) {
      assert.deepEqual(read({ open: [open(9, ['Ready'])], ...(autoMerge === undefined ? {} : { autoMerge }) }), [{ repo: 'acme/app', pr: 9, since: AT, waits: { why: 'ready' } }])
    }
    // The list changes nothing else: his pause and a Not Ready pull request are told as they were.
    const rest = read({ open: [open(8, ['On Hold']), open(9, ['Not Ready'])], autoMerge: ['acme/app'] })
    assert.deepEqual(rest.map(u => [u.pr, u.waits?.why]), [[8, 'hold'], [9, undefined]])
  })

  it('says Not Ready, a label that only looks like Ready, to be in anomaly', () => {
    for (const labels of [['Not Ready'], [], ['Readyish', 'bug']]) assert.equal(read({ open: [open(9, labels)] })[0]?.waits, undefined, labels.join())
    assert.equal(read({ open: [open(9, ['Not Ready'])] }).length, 1)
  })

  it('puts an On Hold pull request on the operator as his own pause', () => {
    assert.deepEqual(read({ open: [open(9, ['On Hold'])] }), [{ repo: 'acme/app', pr: 9, since: AT, waits: { why: 'hold' } }])
    assert.equal(read({ open: [open(9, ['Not Ready', 'on hold'])] })[0]?.waits?.why, 'hold')
    // His pause is said even when Ready is there too.
    assert.equal(read({ open: [open(9, ['Ready', 'On Hold'])] })[0]?.waits?.why, 'hold')
  })

  it('puts on the operator a pull request whose line waits on him, even set a moment ago', () => {
    const fresh = line({ status: 'waiting', on: "le merge de l'opérateur", agent: undefined, since: AT, updated: new Date(NOW - 1000).toISOString() })
    assert.deepEqual(read({ open: [open(7)], lines: [fresh] }), [{ repo: 'acme/app', pr: 7, since: AT, waits: { why: 'record', on: "le merge de l'opérateur" } }])
    const stale = { ...fresh, updated: new Date(NOW - UNATTENDED_AFTER_MS - 1).toISOString() }
    assert.equal(read({ open: [open(7)], lines: [stale] })[0]?.waits?.why, 'record')
    // A wait on something else is attended while fresh, in anomaly once stale, whatever its labels say of Not Ready.
    const ci = line({ status: 'waiting', on: 'la CI', agent: undefined, updated: new Date(NOW - 1000).toISOString() })
    assert.deepEqual(read({ open: [open(7)], lines: [ci] }), [])
    assert.equal(read({ open: [open(7)], lines: [{ ...ci, updated: stale.updated }] })[0]?.waits, undefined)
  })

  it('leaves out what an agent holds or the operator parked, whatever the label', () => {
    assert.deepEqual(read({ open: [open(7, ['Ready'])], lines: [line()], live: ['Agent: seven'] }), [])
    assert.deepEqual(read({ open: [open(7, ['Ready'])], lines: [line({ status: 'parked', ruling: 'later', agent: undefined })] }), [])
    // An open pull request no line holds is nobody\'s, Ready or not.
    assert.deepEqual(read({ open: [open(9, ['Ready'])], lines: [] }), [])
  })

  it('leaves out a Ready or On Hold pull request while a wait on something else is fresh, an agent being on it in all but name', () => {
    const ci = line({ status: 'waiting', on: 'la CI', agent: undefined, updated: new Date(NOW - 1000).toISOString() })
    for (const labels of [['Ready'], ['On Hold']]) assert.deepEqual(read({ open: [open(7, labels)], lines: [ci] }), [], labels.join())
    assert.equal(read({ open: [open(7, ['Ready'])], lines: [{ ...ci, updated: new Date(NOW - UNATTENDED_AFTER_MS - 1).toISOString() }] })[0]?.waits?.why, 'ready')
  })

  it('reads who a wait is on: the operator by his names, never another party', () => {
    for (const on of ['operator', "l'opérateur", 'ton merge', 'toi', 'his merge', 'the operator\'s ruling']) assert.equal(waitsOnOperator(on), true, on)
    for (const on of ['la CI', 'review', 'the merge queue', 'Tonic', 'bonton', undefined]) assert.equal(waitsOnOperator(on), false, String(on))
    assert.equal(isFreshWait(line({ status: 'waiting', on: 'x', agent: undefined, updated: new Date(NOW).toISOString() }), NOW), true)
    assert.equal(isFreshWait(line(), NOW), false)
  })

  it('says a pull request the forge reads in conflict to be in anomaly, whatever it waits on; mergeable and unknown count nothing', () => {
    const state = (pr: number, mergeable: string, labels: string[] = ['Not Ready']) => ({ ...open(pr, labels), mergeable })
    for (const labels of [['Not Ready'], ['Ready'], ['On Hold']]) {
      assert.deepEqual(read({ open: [state(9, 'CONFLICTING', labels)] }), [{ repo: 'acme/app', pr: 9, since: AT, conflict: true }], labels.join())
    }
    assert.equal(unattendedLine(read({ open: [state(9, 'CONFLICTING', ['Ready'])] }), []), 'En anomalie : acme/app#9 (en conflit)')
    assert.equal(read({ open: [state(9, 'MERGEABLE', ['Ready'])] })[0]?.waits?.why, 'ready')
    assert.equal(read({ open: [state(9, 'UNKNOWN', ['Ready'])] })[0]?.waits?.why, 'ready')
    assert.equal(read({ open: [state(9, 'UNKNOWN')] })[0]?.conflict, undefined)
    // An agent on it, or the operator's parking, still leaves it out.
    assert.deepEqual(read({ open: [state(7, 'CONFLICTING')], lines: [line()], live: ['Agent: seven'] }), [])
    assert.deepEqual(read({ open: [state(7, 'CONFLICTING')], lines: [] }), [])
  })

  it('says what waits on him on one line and the anomalies on another, an empty one left out', () => {
    const list = [
      { repo: 'acme/app', pr: 4, since: AT, waits: { why: 'ready' as const } },
      { repo: 'acme/app', pr: 5, since: AT, waits: { why: 'hold' as const } },
      { repo: 'acme/app', pr: 6, since: AT, waits: { why: 'record' as const, on: 'ton merge' } },
      { repo: 'acme/app', pr: 7, since: AT },
    ]
    assert.equal(unattendedLine(list, ['acme/lib']), [
      'Attend ton geste : acme/app#4 (Ready), acme/app#5 (en pause), acme/app#6 (attend ton merge depuis 2026-11-14T10:00Z)',
      'En anomalie : acme/app#7 (sans agent depuis 2026-11-14T10:00Z) ; inconnues pour acme/lib (forge illisible)',
    ].join('\n'))
    // A newline in a wait's words never breaks the line.
    assert.equal(unattendedLine([{ repo: 'acme/app', pr: 6, since: AT, waits: { why: 'record', on: 'ton merge\nEn anomalie : x' } }], []),
      'Attend ton geste : acme/app#6 (attend ton merge En anomalie : x depuis 2026-11-14T10:00Z)')
    assert.deepEqual(unattendedParts(list.slice(0, 2), []).map(part => part.anomaly), [false])
    assert.equal(unattendedLine(list.slice(0, 2), []), 'Attend ton geste : acme/app#4 (Ready), acme/app#5 (en pause)')
    assert.deepEqual(unattendedParts(list.slice(3), []).map(part => part.anomaly), [true])
  })

  it('groups the reading by state for the pane: Ready and En pause on one line each, Attend and Sans agent one pull request to a line with its time, the repository without its owner', () => {
    const list = [
      { repo: 'acme/app', pr: 4, since: AT, waits: { why: 'ready' as const } },
      { repo: 'acme/lib', pr: 5, since: AT, waits: { why: 'ready' as const } },
      { repo: 'acme/app', pr: 6, since: AT, waits: { why: 'hold' as const } },
      { repo: 'acme/app', pr: 7, since: AT, waits: { why: 'record' as const, on: 'ton merge\nde  la  PR' } },
      { repo: 'acme/app', pr: 8, since: AT, waits: { why: 'record' as const } },
      { repo: 'acme/app', pr: 9, since: AT },
      { repo: 'acme/app', pr: 10, since: AT },
      { repo: 'acme/app', pr: 11, since: AT, conflict: true as const },
      { repo: 'acme/app', pr: 12, since: AT, conflict: true as const },
    ]
    assert.deepEqual(unattendedPaneLines(list, ['acme/web'], () => '11:00'), [
      { anomaly: false, label: 'Ready', text: 'app#4 · lib#5', wraps: true },
      { anomaly: false, label: 'En pause', text: 'app#6', wraps: true },
      { anomaly: false, label: 'Attend', text: 'app#7', wraps: false, on: 'ton merge de la PR', time: '11:00' },
      { anomaly: false, label: '', text: 'app#8', wraps: false, on: '?', time: '11:00' },
      { anomaly: true, label: 'En conflit', text: 'app#11 · app#12', wraps: true },
      { anomaly: true, label: 'Sans agent', text: 'app#9', wraps: false, time: '11:00' },
      { anomaly: true, label: '', text: 'app#10', wraps: false, time: '11:00' },
      { anomaly: true, label: 'Inconnues', text: 'acme/web (forge illisible)', wraps: true },
    ])
    assert.deepEqual(unattendedPaneLines(list.slice(0, 1), []).map(l => l.label), ['Ready'])
    assert.deepEqual(unattendedPaneLines([], ['acme/lib']).map(l => l.label), ['Inconnues'])
    assert.deepEqual(unattendedPaneLines([], []), [])
  })
})
