import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { appendEventOver, randomPart, type JournalIo } from './journal.ts'
import { appendEvent } from './journal-sync.ts'
import { JOURNAL_MAX_EVENTS, journalFileOf, learningEvent, parseJournalEvent } from './learning.ts'

const NOW = '2026-11-14T10:15:00Z'
const scratch = () => mkdtempSync(join(tmpdir(), 'journal-'))

function eventAt(at: string, random = randomPart()) {
  const event = learningEvent({ at, random, kind: 'refusal', source: { plugin: 'orchestrator', code: 'orchestrator.kill.refused' }, trust: 'computed' })
  assert.ok(event)
  return event
}

// The I/O a hooks module hands in, played by this machine's own processes.
function realIo(): JournalIo & { runs: string[][] } {
  const runs: string[][] = []
  let count = 0
  return {
    runs,
    write: async (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    read: async path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    list: async dir => (existsSync(dir) ? readdirSync(dir) : []),
    run: async argv => {
      runs.push([...argv])
      const ran = spawnSync(argv[0] ?? 'false', argv.slice(1), { encoding: 'utf8' })
      return { exitCode: ran.status ?? 1, stderr: ran.stderr }
    },
    mtimeMs: async () => undefined,
    sleep: async () => undefined,
    now: () => Date.parse(NOW),
    tag: () => `t${++count}`,
  }
}

const secondsAgo = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString().replace('.000Z', 'Z')
const aged = (days: number) => secondsAgo(days * 86_400)

for (const [label, append] of [
  ['over a hooks module\'s I/O', async (dir: string, event: { id: string; at: string }, prune: boolean) => appendEventOver(realIo(), dir, event, NOW, prune)],
  ['from a script', async (dir: string, event: { id: string; at: string }) => appendEvent(dir, event, NOW)],
] as const) {
  describe(`a journal written ${label}`, () => {
    it('holds one file per event, named by its identifier, read back whole by core\'s reader', async () => {
      const dir = join(scratch(), 'orchestrator', 'journal')
      const event = eventAt(NOW)
      await append(dir, event, true)
      assert.deepEqual(readdirSync(dir), [journalFileOf(event.id)])
      assert.deepEqual(parseJournalEvent(JSON.parse(readFileSync(join(dir, journalFileOf(event.id)), 'utf8'))), event)
    })

    it('is pruned of what is past the retention, and of no file it did not write', async () => {
      const dir = join(scratch(), 'journal')
      mkdirSync(dir, { recursive: true })
      const old = eventAt(aged(181))
      writeFileSync(join(dir, journalFileOf(old.id)), JSON.stringify(old))
      writeFileSync(join(dir, 'notes.txt'), 'kept')
      const event = eventAt(NOW)
      await append(dir, event, true)
      assert.deepEqual(readdirSync(dir).sort(), [journalFileOf(event.id), 'notes.txt'].sort())
    })
  })
}

describe('a hooks module\'s journal', () => {
  it('lists nothing when asked not to prune', async () => {
    const io = realIo()
    const dir = join(scratch(), 'journal')
    await appendEventOver(io, dir, eventAt(NOW), NOW, false)
    assert.ok(io.runs.every(argv => argv[0] === 'mv'), JSON.stringify(io.runs))
  })

  it('keeps the count past which the oldest go', async () => {
    const io = realIo()
    const dir = join(scratch(), 'journal')
    mkdirSync(dir, { recursive: true })
    const names = Array.from({ length: JOURNAL_MAX_EVENTS }, (_, i) => journalFileOf(eventAt(secondsAgo(864_000 - i), i.toString(16).padStart(8, '0')).id))
    for (const name of names) writeFileSync(join(dir, name), '{}')
    await appendEventOver(io, dir, eventAt(NOW), NOW, true)
    assert.equal(readdirSync(dir).length, JOURNAL_MAX_EVENTS)
    assert.ok(!readdirSync(dir).includes(names[0]!))
  })

  it('draws a random part of eight lowercase hex digits', () => {
    assert.match(randomPart(), /^[0-9a-f]{8}$/)
  })
})
