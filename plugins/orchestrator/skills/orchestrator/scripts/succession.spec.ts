import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { deckOpen, FIELDS, namedIn, generationOf, main, missingItems, NOTES_MAX, NOTE_CHARS, notesOf, parseArgs, roundOpen } from './succession.ts'
import { parseJournalEvent } from '../../../core/learning.ts'

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'orchestrator-succession-brief.md')

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'succession-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NAME = 'Orch: belt'
const SESSION = 's-orch'

/** A machine whose state holds open what an orchestration in flight holds. */
function world(over: { rows?: string; deck?: object; round?: object[] } = {}) {
  const state = join(dir, 'state')
  mkdirSync(join(state, 'round'), { recursive: true })
  const record = join(dir, 'dispatch.jsonl')
  writeFileSync(record, over.rows ?? [
    JSON.stringify({ id: 1, label: 'schema', state: 'closed' }),
    JSON.stringify({ id: 2, label: 'api', state: 'open' }),
    JSON.stringify({ id: 3, label: 'ui', state: 'open', deferred: 'ruling 4' }),
  ].join('\n') + '\n')
  writeFileSync(join(state, 'deck.json'), JSON.stringify(over.deck ?? {
    version: 3,
    orchestrators: [
      { name: NAME, machine: null, prs: ['acme/app#12', 'acme/app#14'], agents: [{ name: 'Agent: api' }] },
      { name: 'Orch: other', machine: null, prs: ['acme/site#7'], agents: [{ name: 'Agent: site' }] },
    ],
  }))
  for (const entry of over.round ?? [
    { id: 'q-2', session: SESSION, from: NAME, kind: 'operator', status: 'open', question: '**Question 1 of 1**\nWhich schema?' },
    { id: 'q-1', session: SESSION, from: NAME, kind: 'operator', status: 'answered', question: 'Done?' },
    { id: 'q-3', session: 'other', from: 'Orch: other', kind: 'operator', status: 'open', question: 'Not ours' },
  ]) writeFileSync(join(state, 'round', `${(entry as { id: string }).id}.json`), JSON.stringify(entry))
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, readFileSync(TEMPLATE, 'utf8').replaceAll('{{PROJECT}}', 'belt'))
  const env = { ORCHESTRATOR_STATE_DIR: state, HOME: dir }
  const out: string[] = []
  const err: string[] = []
  const io = { out: (t: string) => { out.push(t) }, err: (t: string) => { err.push(t) } }
  const run = (...argv: string[]) => main([argv[0] ?? '', brief, '--name', NAME, '--session', SESSION, '--record', record, ...argv.slice(1)], env, io)
  return { state, record, brief, out, err, run, read: () => readFileSync(brief, 'utf8') }
}

test('live writes every open item of the state into the brief, and nothing of another orchestrator', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'review #12'), 0)
  const brief = w.read()
  assert.match(brief, /- Rows open \(id, label, what remains\): open=2 label=api; deferred=3 label=ui ruling=ruling 4\n/)
  assert.match(brief, /- Pull requests open \(number, head, where each stands\): acme\/app#12; acme\/app#14\n/)
  assert.match(brief, /- Agents running \(name and reference, brief path\): Agent: api\n/)
  assert.ok(brief.includes('[q-2] **Question 1 of 1**\nWhich schema?'))
  assert.ok(!brief.includes('q-1') && !brief.includes('q-3') && !brief.includes('acme/site#7') && !brief.includes('Agent: site'))
  assert.match(brief, /- The next step: review #12\n/)
  assert.match(brief, /<!-- generation: 1 -->/)
  assert.ok(!brief.includes('{{LIVE_'))
  // The rest of the template stands.
  assert.ok(brief.includes('# Expected result'))
  assert.ok(brief.includes('## Standing context'))
  assert.match(w.out.join(''), /^generation=1 chars=\d+ rows=2 prs=2 agents=1 questions=1 notes=0 pruned=rulings:0,state:0,round:0 takeover_chars=(\d+)->\1\n$/)
  assert.equal(w.run('check'), 0)
})

test('check refuses a brief that misses an open item, naming each one', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'x'), 0)
  // The state moves on after the generation: a new pull request, a new question.
  const deck = JSON.parse(readFileSync(join(w.state, 'deck.json'), 'utf8'))
  deck.orchestrators[0].prs.push('acme/app#15')
  writeFileSync(join(w.state, 'deck.json'), JSON.stringify(deck))
  writeFileSync(join(w.state, 'round', 'q-9.json'), JSON.stringify({ id: 'q-9', session: SESSION, kind: 'operator', status: 'open', question: 'New?' }))
  assert.equal(w.run('check'), 1)
  assert.deepEqual(w.err, [
    'succession: the brief misses pull request acme/app#15: run succession.sh live\n',
    'succession: the brief misses question q-9: run succession.sh live\n',
  ])
})

test('check refuses a hand-written Live state that drops a running agent or a row', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'x'), 0)
  writeFileSync(w.brief, w.read().replace('Agent: api', 'none').replace('open=2 label=api; ', ''))
  assert.equal(w.run('check'), 1)
  assert.deepEqual(w.err, [
    'succession: the brief misses dispatch row 2: run succession.sh live\n',
    'succession: the brief misses agent Agent: api: run succession.sh live\n',
  ])
})

test('a note lives one generation: promoted or dropped at the next, each said', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'x', '--note', 'the operator prefers small PRs', '--note', 'CI flakes on macOS'), 0)
  assert.deepEqual(notesOf(w.read()), [
    { generation: 1, text: 'the operator prefers small PRs' },
    { generation: 1, text: 'CI flakes on macOS' },
  ])
  const ruling = join(dir, 'rulings.md')
  writeFileSync(ruling, 'small PRs\n')
  w.err.length = 0
  assert.equal(w.run('live', '--next', 'y', '--promote', `1=${ruling}`, '--note', 'a third'), 0)
  assert.deepEqual(w.err, [
    `succession: note 1 of generation 1 promoted to ${ruling}\n`,
    'succession: note 2 of generation 1 dropped: CI flakes on macOS\n',
  ])
  const brief = w.read()
  assert.equal(generationOf(brief), 2)
  assert.deepEqual(notesOf(brief), [{ generation: 2, text: 'a third' }])
  assert.equal((brief.match(/<!-- generation:/g) ?? []).length, 1)
  assert.equal((brief.match(/^- The next step:/gm) ?? []).length, 1)
})

test('the notes are capped in number and length, and a promotion names an artifact that exists', () => {
  const w = world()
  const many = Array.from({ length: NOTES_MAX + 1 }, (_, i) => ['--note', `n${i}`]).flat()
  assert.equal(w.run('live', '--next', 'x', ...many), 2)
  assert.equal(w.run('live', '--next', 'x', '--note', 'x'.repeat(NOTE_CHARS + 1)), 2)
  assert.equal(w.run('live', '--next', 'x', '--note', 'kept'), 0)
  assert.equal(w.run('live', '--next', 'x', '--promote', `1=${join(dir, 'nowhere.md')}`), 2)
  assert.equal(w.run('live', '--next', 'x', '--promote', '2=/'), 2)
  assert.equal(generationOf(w.read()), 1)
})

test('a brief that is no succession brief, or without its Live state, is refused', () => {
  const w = world()
  writeFileSync(w.brief, '# Some brief\n')
  assert.equal(w.run('live', '--next', 'x'), 2)
  writeFileSync(w.brief, '# Orchestrator succession brief — belt\n\nNo state here.\n')
  assert.equal(w.run('live', '--next', 'x'), 2)
  assert.match(w.err.at(-1) ?? '', /no « Live state » section/)
})

test('the command line: two commands, the next step required to generate, flags checked', () => {
  assert.ok('error' in parseArgs([]) && 'error' in parseArgs(['x', 'b']) && 'error' in parseArgs(['live']))
  assert.match(String((parseArgs(['live', 'b', '--name', 'n', '--session', 's', '--record', 'r']) as { error: string }).error), /--next is required/)
  assert.match(String((parseArgs(['check', 'b', '--bogus', 'x']) as { error: string }).error), /unknown argument/)
  assert.match(String((parseArgs(['check', 'b', '--name']) as { error: string }).error), /needs a value/)
  assert.match(String((parseArgs(['live', 'b', '--promote', 'x']) as { error: string }).error), /<n>=<path>/)
  assert.match(String((parseArgs(['live', 'b', '--name', 'n', '--session', 's', '--record', 'r', '--next', 'x', '--note', ' ']) as { error: string }).error), /empty/)
})

test('the deck and the round are read as data: a remote orchestrator, a malformed file, none', () => {
  assert.deepEqual(deckOpen(undefined, NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen('not json', NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen(JSON.stringify({ orchestrators: [{ name: NAME, machine: 'mini', prs: ['a#1'] }] }), NAME), { prs: [], agents: [] })
  assert.deepEqual(roundOpen([undefined, { id: 'a', from: NAME, kind: 'operator', status: 'open' }], NAME, SESSION), [{ id: 'a', text: '' }])
  assert.deepEqual(missingItems('no live state', { rows: [], prs: [], agents: [], questions: [] }), [])
  assert.ok(FIELDS.notes.startsWith('- Notes'))
})

test('the name and the dispatch record are read from the brief when not given', () => {
  const w = world()
  writeFileSync(w.brief, w.read().replaceAll('{{PREDECESSOR_NAME_PATTERN}}', NAME).replaceAll('{{DISPATCH_RECORD}}', w.record))
  assert.deepEqual(namedIn(w.read()), { name: NAME, record: w.record })
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir }
  const io = { out: (t: string) => { w.out.push(t) }, err: (t: string) => { w.err.push(t) } }
  assert.equal(main(['live', w.brief, '--next', 'x'], env, io), 0)
  assert.equal(main(['check', w.brief], env, io), 0)
  assert.match(w.out.join(''), /complete: 2 rows, 2 pull requests, 1 agents, 1 questions/)
  // A template still unfilled names neither: the call says which to pass.
  writeFileSync(w.brief, readFileSync(TEMPLATE, 'utf8'))
  assert.equal(main(['check', w.brief], env, io), 2)
  assert.match(w.err.at(-1) ?? '', /names no predecessor/)
  writeFileSync(w.brief, readFileSync(TEMPLATE, 'utf8').replaceAll('{{PREDECESSOR_NAME_PATTERN}}', NAME))
  assert.equal(main(['check', w.brief], env, io), 2)
  assert.match(w.err.at(-1) ?? '', /Dispatch record/)
})

test('live prunes the rulings and state files the brief names, archives beside them, and measures the takeover', () => {
  const w = world()
  const rulings = join(dir, 'rulings.md')
  const state = join(dir, 'state.md')
  writeFileSync(rulings, [
    '# Standing rulings — Orch: belt', '',
    '- 2026-11-08T00:00:00Z « Réponds-moi en français. » — the operator in French. [standing]',
    '- 2026-11-09T10:00:00Z « Merge #12 » → merge acme/app#12. [done: acme/app#12]',
    '- 2026-11-10T06:41:14Z « A » → port into next. [superseded: 2026-11-10T06:55:24Z]',
    '- 2026-11-10T06:55:24Z « A » → rebuild on home instead.',
    '- 2026-11-11T09:00:00Z « C » → one correction of acme/app#14. [for: acme/app#14]', '',
  ].join('\n'))
  writeFileSync(state, [
    '# State — Orch: belt', '', '## Live',
    '- 2026-11-13T09:00:00Z [aa] morning journal, finished.',
    '- 2026-11-13T21:08:23Z LIVE SUMMARY [bb] what is live.',
    '- Merged: #141.', '',
  ].join('\n'))
  writeFileSync(w.brief, w.read().replaceAll('{{RULINGS_FILE}}', rulings).replaceAll('{{STATE_FILE}}', state))
  const before = readFileSync(rulings, 'utf8').length + readFileSync(state, 'utf8').length
  // check reads, it never prunes: the Live state is not generated yet, so it refuses.
  assert.equal(w.run('check'), 1)
  assert.equal(readFileSync(rulings, 'utf8').length + readFileSync(state, 'utf8').length, before)
  assert.equal(w.run('live', '--next', 'x'), 0)
  // A takeover reads the rulings but the one for acme/app#14, which stays in the file.
  const kept = readFileSync(rulings, 'utf8')
  assert.ok(kept.includes('[for: acme/app#14]'))
  const after = kept.length - '- 2026-11-11T09:00:00Z « C » → one correction of acme/app#14. [for: acme/app#14]\n'.length + readFileSync(state, 'utf8').length
  const brief = w.read().length
  assert.match(w.out.at(-1) ?? '', new RegExp(`^generation=1 chars=${brief} .* pruned=rulings:2,state:1,round:0 takeover_chars=${brief + before}->${brief + after}\\n$`))
  assert.ok(!readFileSync(rulings, 'utf8').includes('Merge #12') && readFileSync(rulings, 'utf8').includes('[standing]'))
  assert.match(readFileSync(join(dir, 'rulings-archive.md'), 'utf8'), /Merge #12[\s\S]*port into next/)
  assert.match(readFileSync(join(dir, 'state-archive.md'), 'utf8'), /morning journal/)
  assert.ok(!readFileSync(state, 'utf8').includes('morning journal'))
})

test('live archives the round\'s entries settled over a day ago, and counts them in its pruned field', () => {
  const old = '2026-11-01T10:00:00Z'
  const settled = { from: NAME, session: SESSION, kind: 'operator', since: old, question: 'Q?' }
  const w = world({ round: [
    { id: 'q-open', ...settled, status: 'open', answer: null },
    { id: 'q-answered', ...settled, status: 'answered', answer: { text: 'A', by: 'pane', at: old } },
    { id: 'q-withdrawn', ...settled, status: 'withdrawn', answer: { text: 'moot', by: 'sender', at: old } },
  ] })
  assert.equal(w.run('live', '--next', 'x'), 0)
  assert.match(w.out.at(-1) ?? '', / pruned=rulings:0,state:0,round:2 takeover_chars=/)
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'q-answered.json')))
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'withdrawn', 'q-withdrawn.json')))
  assert.ok(existsSync(join(w.state, 'round', 'q-open.json')))
})

test('live prunes nothing the brief does not name, and says a supersession it keeps', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'x'), 0)
  assert.match(w.out.at(-1) ?? '', / pruned=rulings:0,state:0,round:0 takeover_chars=\d+->\d+\n$/)
  const rulings = join(dir, 'r.md')
  writeFileSync(rulings, '- 2026-11-12T16:00:00Z « C » → x. [superseded: 2026-12-01T00:00:00Z]\n')
  writeFileSync(w.brief, w.read().replaceAll('{{RULINGS_FILE}}', rulings))
  assert.equal(w.run('live', '--next', 'x'), 0)
  assert.ok(w.err.includes(`succession: ${rulings}: ruling 2026-11-12T16:00:00Z kept: superseded by 2026-12-01T00:00:00Z, which no ruling of the file or its archive opens on\n`))
})

test('a check that finds the brief lost part of the state is a method failure in the journal: how much was lost, the pull requests among it', () => {
  const w = world()
  assert.equal(w.run('live', '--next', 'x'), 0)
  const deck = JSON.parse(readFileSync(join(w.state, 'deck.json'), 'utf8'))
  deck.orchestrators[0].prs.push('acme/app#15')
  writeFileSync(join(w.state, 'deck.json'), JSON.stringify(deck))
  writeFileSync(join(w.state, 'round', 'q-9.json'), JSON.stringify({ id: 'q-9', session: SESSION, kind: 'operator', status: 'open', question: 'New?' }))
  const events: Record<string, unknown>[] = []
  const named = ['--name', NAME, '--session', SESSION, '--record', w.record]
  const journal = (event: object) => { events.push(event as Record<string, unknown>) }
  const io = { out: (t: string) => { w.out.push(t) }, err: (t: string) => { w.err.push(t) } }
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir, CLAUDE_CODE_SESSION_ID: 'orch-2' }
  assert.equal(main(['check', w.brief, ...named], env, io, () => new Date('2026-11-14T10:00:00.250Z'), journal), 1)
  assert.equal(events.length, 1)
  assert.deepEqual([events[0]?.['kind'], events[0]?.['at'], events[0]?.['fact'], events[0]?.['evidence']], [
    'failure', '2026-11-14T10:00:00Z', { failure: 'succession-lost-state', count: 2, prs: ['acme/app#15'] }, [{ type: 'record', path: 'brief.md' }],
  ])
  assert.ok(parseJournalEvent(events[0]))
  assert.ok(!JSON.stringify(events).includes('New?'))
  events.length = 0
  assert.equal(main(['live', w.brief, ...named, '--next', 'x'], env, io, () => new Date(), journal), 0)
  assert.equal(main(['check', w.brief, ...named], env, io, () => new Date(), journal), 0)
  assert.deepEqual(events, [])
})
