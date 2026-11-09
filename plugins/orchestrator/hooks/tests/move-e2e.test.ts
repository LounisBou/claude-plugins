// hooks/tests/move-e2e.test.ts
// A move from end to end between two machines (machines.ts): two homes, each its own module, its
// own store and its own model, and between them a transport the test plays — one that loses a
// chunk, one that delivers every message twice, and one that forges a manifest. Whatever the wire
// does, the files land whole, checked and rewritten through core's store, or nothing lands and the
// sender's model reads why; no lock and no temporary file is left on either machine.
import { expect, test } from 'claude-code/testing'
import { moveIdOf, moveText, parseMoveMessage, type MoveMessage } from '../move.ts'
import {
  HOME_A, HOME_B, BRIEF_NAME, BRIEF_TEXT, NOTES_TEXT, mounted, sender, receiver, sendInput, settle,
  type Machine, type Wire,
} from './machines.ts'

// Two machines, each with its module mounted, and the move sent from the first.
async function sent(input: Record<string, unknown> = {}) {
  const a = sender()
  const b = receiver()
  const ha = mounted()
  const hb = mounted()
  const answer = await ha['tool.call:move_send'](a.dollar, sendInput(a, input))
  return { a, b, ha, hb, answer }
}

const kind = (text: string) => parseMoveMessage(text)?.kind ?? 'unparsable'

// What the store left behind on a machine: every lock, every temporary file.
const leftovers = (fx: Machine) => [...fx.files.keys()].filter(p => p.endsWith('.lock') || p.includes('.tmp-'))

// The briefs directory a move lands in on the receiver, and the files it holds there.
const landed = (b: Machine) => `${b.briefs}/belt`
const filesIn = (fx: Machine, dir: string) => [...fx.files.keys()].filter(p => p.startsWith(`${dir}/`)).sort()

// The source's files as they stood before the move.
const sourceFiles = (a: Machine) => new Map([...a.files].filter(([p]) => p.startsWith(`${a.briefs}/belt/`)))

test('a chunk lost on the wire is asked for again, and the files land whole on the other home', async () => {
  const { a, b, ha, hb, answer } = await sent()
  expect(answer.isError).toBeUndefined()
  // A temporary file a writer killed on the receiver left where the move lands.
  b.files.set(`${landed(b)}/${BRIEF_NAME}.tmp-dead-writer`, 'half a file')
  const before = sourceFiles(a)
  let lost = 0
  const wire: Wire = (text, from) => {
    const m = parseMoveMessage(text)
    if (from === 'a' && m?.kind === 'chunk' && m.file === 1 && m.index === 1 && lost === 0) {
      lost += 1
      return []
    }
    return [text]
  }
  await settle(a, ha, b, hb, wire)
  expect(lost).toBe(1)
  // The receiver asked for exactly the chunk lost, once.
  const missing = b.sent.map(m => parseMoveMessage(m.text)).filter((m): m is Extract<MoveMessage, { kind: 'missing' }> => m?.kind === 'missing')
  expect(missing.map(m => m.chunks)).toEqual([[[1, 1]]])
  // Every file landed, its origin's paths rewritten into the receiver's.
  expect(filesIn(b, landed(b))).toEqual([`${landed(b)}/${BRIEF_NAME}`, `${landed(b)}/notes.txt`])
  expect(b.files.get(`${landed(b)}/${BRIEF_NAME}`)).toBe(BRIEF_TEXT.replaceAll(HOME_A, HOME_B))
  expect(b.files.get(`${landed(b)}/notes.txt`)).toBe(NOTES_TEXT)
  // Each side's model read one notice: the arrival here, the acknowledgment there.
  expect(b.submits.length).toBe(1)
  expect(b.submits[0].text).toContain(`brief: ${landed(b)}/${BRIEF_NAME}`)
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain('acknowledged')
  // No lock, no temporary and no chunk outlives the move, on either machine.
  expect(leftovers(a)).toEqual([])
  expect(leftovers(b)).toEqual([])
  expect([...b.files.keys()].filter(p => /\/c-\d+-\d+$/.test(p))).toEqual([])
  // Acknowledged, the source holds no more of what it sent; what never travelled (a link, a
  // sub-directory) is left where it was.
  expect([...sourceFiles(a).keys()].sort()).toEqual([`${a.briefs}/belt/linked.md`, `${a.briefs}/belt/old/inner.md`])
  expect(before.has(`${a.briefs}/belt/${BRIEF_NAME}`)).toBe(true)
})

test('the source is cleaned only after the acknowledgment, and keeps a file changed since it was sent', async () => {
  const { a, b, ha, hb } = await sent()
  const notes = `${a.briefs}/belt/notes.txt`
  // Everything but the receiver's « done » crosses: the source keeps every file.
  await settle(a, ha, b, hb, (text, from) => (from === 'b' && kind(text) === 'done' ? [] : [text]))
  expect(a.files.has(`${a.briefs}/belt/${BRIEF_NAME}`)).toBe(true)
  expect(a.files.has(notes)).toBe(true)
  // The notes change on the source; the « done » is answered again at the next « sent ».
  a.files.set(notes, 'written after the send\n')
  await hb['session.receive'](b.dollar, { origin: { kind: 'peer', plugin: 'orchestrator' }, text: `<cross-session-message from="${a.address}" from-name="Orch: belt" from-mode="prompting">\n${moveText({ kind: 'sent', move: (parseMoveMessage(a.sent[0].text) as Extract<MoveMessage, { kind: 'manifest' }>).move })}\n</cross-session-message>` }, async (e: any) => e)
  await settle(a, ha, b, hb)
  expect(a.files.has(`${a.briefs}/belt/${BRIEF_NAME}`)).toBe(false)
  expect(a.files.get(notes)).toBe('written after the send\n')
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain('1 of its files here removed')
  expect(a.submits[0].text).toContain(notes)
})

test('a coordinator that moved an orchestrator it keeps asleep is given the command that removes its record', async () => {
  const { a, b, ha, hb } = await sent()
  a.files.set(`${a.config}/claude-orchestrator/sleeping.json`, JSON.stringify([{ name: 'Orch: belt', brief: `${a.briefs}/belt/${BRIEF_NAME}` }]))
  await settle(a, ha, b, hb)
  expect(a.submits[0].text).toContain('coordinator.sh wake-done --name "Orch: belt"')
  const other = await sent()
  await settle(other.a, other.ha, other.b, other.hb)
  expect(other.a.submits[0].text).not.toContain('wake-done')
})

test('every message delivered twice lands each file once and tells each model once', async () => {
  const { a, b, ha, hb } = await sent()
  await settle(a, ha, b, hb, text => [text, text])
  for (const name of [BRIEF_NAME, 'notes.txt']) {
    expect(b.writes.filter(p => p === `${landed(b)}/${name}`).length).toBe(1)
  }
  expect(b.files.get(`${landed(b)}/${BRIEF_NAME}`)).toBe(BRIEF_TEXT.replaceAll(HOME_A, HOME_B))
  expect(b.sent.map(m => kind(m.text))).not.toContain('missing')
  expect(b.submits.length).toBe(1)
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain('acknowledged')
  expect(leftovers(a)).toEqual([])
  expect(leftovers(b)).toEqual([])
})

test('a working directory outside the origin home is refused on arrival: nothing lands, the sender reads why', async () => {
  const { a, b, ha, hb, answer } = await sent({ dir: '/srv/app' })
  expect(answer.isError).toBeUndefined()
  const before = sourceFiles(a)
  await settle(a, ha, b, hb)
  expect(filesIn(b, b.briefs)).toEqual([])
  expect(b.submits).toEqual([])
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain('not strictly under')
  expect(sourceFiles(a)).toEqual(before)
  expect(leftovers(b)).toEqual([])
})

// The wire rewrites the manifest's record and gives it the id `id` answers for it: its own id
// kept, a forger who did not recompute it; recomputed, one who did.
function forging(change: (record: Extract<MoveMessage, { kind: 'manifest' }>['record']) => void, recompute: boolean): Wire {
  return (text, from) => {
    const m = parseMoveMessage(text)
    if (from !== 'a' || m?.kind !== 'manifest') return [text]
    change(m.record)
    return [moveText({ ...m, move: recompute ? moveIdOf(m.record, m.files) : m.move })]
  }
}

test('a forged manifest is refused on arrival: a move id its record does not give, a path that climbs out of the home', async () => {
  const cases: [string, Wire][] = [
    ['is not the one its record and files give', forging(record => { record.order = 'a forged order' }, false)],
    ["climbs with '..'", forging(record => { record.dir = `${HOME_A}/dev/../../../etc` }, true)],
    ["climbs with '..'", forging(record => { record.checkouts = [`${HOME_A}/../root/app`] }, true)],
  ]
  for (const [reason, wire] of cases) {
    const { a, b, ha, hb } = await sent()
    await settle(a, ha, b, hb, wire)
    expect(filesIn(b, b.briefs)).toEqual([])
    expect(b.submits).toEqual([])
    // The manifest's refusal names the forged id, which the sender never sent: its model reads the
    // refusal of « sent », for a move the receiver holds no manifest of.
    const refusals = b.sent.map(m => parseMoveMessage(m.text)).filter(m => m?.kind === 'done' && !m.ok)
    expect(refusals.some(m => m?.kind === 'done' && String(m.reason).includes(reason))).toBe(true)
    expect(a.submits.length).toBe(1)
    expect(a.submits[0].text).toContain('was not moved')
    expect(leftovers(b)).toEqual([])
  }
})

// The sender's brief names its dispatch record, kept at `record` with its owner and its goals.
function recordKept(a: Machine, record: string): void {
  const brief = `${a.briefs}/belt/${BRIEF_NAME}`
  a.files.set(brief, `${a.files.get(brief)}- Dispatch record (this build's routing corrections): \`${record}\`, read before routing.\n`)
  a.files.set(record, `{"id":1,"record":"${record}"}\n`)
  a.files.set(`${record}.owner`, 'Orch: belt\n')
  a.files.set(`${record.slice(0, record.lastIndexOf('/'))}/goals.md`, '# goals\n- [ ] the move works\n')
}

test('a dispatch record kept outside the briefs directory travels with it and lands at its path on the other home', async () => {
  const a = sender()
  const b = receiver()
  const ha = mounted()
  const hb = mounted()
  const record = `${HOME_A}/notes/app/record.jsonl`
  recordKept(a, record)
  expect((await ha['tool.call:move_send'](a.dollar, sendInput(a))).isError).toBeUndefined()
  await settle(a, ha, b, hb)
  const there = `${HOME_B}/notes/app`
  expect(b.files.get(`${there}/record.jsonl`)).toBe(`{"id":1,"record":"${there}/record.jsonl"}\n`)
  expect(b.files.get(`${there}/record.jsonl.owner`)).toBe('Orch: belt\n')
  expect(b.files.get(`${there}/goals.md`)).toBe('# goals\n- [ ] the move works\n')
  // The brief there names the record where it landed.
  expect(b.files.get(`${landed(b)}/${BRIEF_NAME}`)).toContain(`\`${there}/record.jsonl\``)
  expect(b.submits.length).toBe(1)
  expect(b.submits[0].text).toContain(`${there}/record.jsonl`)
  expect(a.submits[0].text).toContain('acknowledged')
  expect(leftovers(b)).toEqual([])
})

test('a dispatch record in a checkout travels by git when git tracks it, and refuses the move when it does not', async () => {
  const tracked = sender({ repos: { [`${HOME_A}/dev/app`]: { remote: 'git@example.com:acme/app.git', branch: 'feat/belt', tracked: [`${HOME_A}/dev/app/ops/record.jsonl`, `${HOME_A}/dev/app/ops/record.jsonl.owner`, `${HOME_A}/dev/app/ops/goals.md`] }, [`${HOME_A}/dev/lib`]: {} } })
  recordKept(tracked, `${HOME_A}/dev/app/ops/record.jsonl`)
  const ha = mounted()
  expect((await ha['tool.call:move_send'](tracked.dollar, sendInput(tracked))).isError).toBeUndefined()
  const manifest = parseMoveMessage(tracked.sent[0].text) as Extract<MoveMessage, { kind: 'manifest' }>
  expect(manifest.files.every(f => f.at === undefined)).toBe(true)
  const untracked = sender()
  recordKept(untracked, `${HOME_A}/dev/app/ops/record.jsonl`)
  const refused = await ha['tool.call:move_send'](untracked.dollar, sendInput(untracked))
  expect(refused.isError).toBe(true)
  expect(refused.result).toContain('git does not track it')
  expect(untracked.sent).toEqual([])
})
