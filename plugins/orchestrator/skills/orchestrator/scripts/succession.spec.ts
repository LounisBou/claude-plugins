import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentLine, answerMeaning, briefOf, closeVerb, HOME_STEP, STAY_TURN, movesHome, deckOpen, fallOf, fill, liveAgents, main, notInstalled, objectiveOf, oneLine, openRows, ownersOf, parseArgs, parseList, projectOf, projectSheet, roundOpen, roundSettled, rowLines, rowOfBrief, TEMPLATE, todoStray, toApply, type Artifacts, type ListedRow } from './succession.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'succession-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NAME = 'Orch: belt'
const SESSION = 's-orch'
const NOW = new Date('2026-11-15T10:00:00Z')

/** A pull request ledger line of the dispatch record: the pull request, with the agent on it. */
const ledger = (repo: string, pr: number, agent: string): string =>
  JSON.stringify({ v: 1, ledger: 'pr', repo, pr, status: 'working', agent, since: '2026-11-14T09:00:00Z', updated: '2026-11-14T09:00:00Z' })

const todo = (id: number, rows: number[] | undefined, state = 'open'): string =>
  JSON.stringify({ v: 1, id, opened: '2026-11-14T09:00:00Z', label: `item ${id}`, state, verdict: '', words: `words ${id}`, said_at: '2026-11-14T09:00:00Z', from: NAME, ...(rows ? { rows } : {}) })

/** A deck session, and a deck of orchestrators, whole as core's parser reads them. */
const session = (name: string, repo: string | null = null) => ({
  key: name, name, tty: null, tmux: null, repo, context: { percent: 1, tokens: 1, window: 1, past_gate: false }, waiting: null, updated_at: '2026-11-14T09:00:00.000Z', usage: null,
})
const orchestrator = (name: string, repo: string | null, prs: string[] = [], agents: string[] = [], machine: string | null = null) =>
  ({ ...session(name, repo), machine, prs, agents: agents.map(agent => session(agent)) })
function deckOf(orchestrators: object[]): object {
  const period = { from: '2026-11-13T23:00:00.000Z', tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0 }
  return {
    version: 3, generated_at: '2026-11-14T09:00:00.000Z', machine: 'mbp', coordinator: null, orchestrators, unattached_agents: [], sleeping: [],
    round: { open: 0, urgent: 0, oldest_since: null }, usage_totals: { day: period, week: period, at: '2026-11-14T09:00:00.000Z' },
    usage_basis: { currency: 'USD', prices: 'api-list-equivalent', timezone: 'Europe/Paris' },
  }
}

/** A machine whose state holds open what an orchestration in flight holds, and no succession brief anywhere. */
function world(over: { rows?: string; deck?: object; round?: object[]; todo?: string; goals?: string | null; prs?: Record<string, string>; windows?: Record<string, number>; listed?: ListedRow[]; movesHome?: boolean } = {}) {
  const journaled: unknown[] = []
  const state = join(dir, 'state')
  const briefs = join(dir, 'briefs', 'belt')
  mkdirSync(join(state, 'round'), { recursive: true })
  mkdirSync(join(state, 'todo'), { recursive: true })
  mkdirSync(briefs, { recursive: true })
  const record = join(briefs, 'dispatch-record.jsonl')
  writeFileSync(record, over.rows ?? [
    JSON.stringify({ id: 1, label: 'SCHEMA: tables', state: 'closed' }),
    JSON.stringify({ id: 2, label: 'API: routes', state: 'open', note: 'Dispatched: Agent: api' }),
    JSON.stringify({ id: 3, label: 'UI: pages', state: 'open', deferred: 'ruling 4' }),
    JSON.stringify({ id: 4, label: 'DOCS: guide', state: 'open', blocker: 'row 1 closed', note: 'start from the old guide' }),
    JSON.stringify({ id: 5, label: 'PERF: cache', state: 'open', blocker: 'PR acme/app#12 merged' }),
    JSON.stringify({ id: 6, label: 'LINT: rules', state: 'open', blocker: 'row 2 closed' }),
    ledger('acme/app', 12, 'Agent: pr'),
  ].join('\n') + '\n')
  writeFileSync(`${record}.owner`, `${NAME}\n`)
  rmSync(join(briefs, 'goals.md'), { force: true })
  if (over.goals !== null) writeFileSync(join(briefs, 'goals.md'), over.goals ?? '# Goals\nspec: /specs/belt.md\nrepo: /w\naim: a belt that holds\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | met | tables | phase 1 | pr:acme/app#11 |\n| G2 | open | routes | phase 2 | |\n')
  writeFileSync(join(state, 'deck.json'), JSON.stringify(over.deck ?? deckOf([
    orchestrator(NAME, null, ['acme/other#99'], ['Agent: api']),
    orchestrator('Orch: other', null, ['acme/site#7'], ['Agent: site']),
  ])))
  for (const entry of over.round ?? [
    { id: 'q-2', session: SESSION, from: NAME, kind: 'operator', status: 'open', question: '**Question 1 of 1**\nWhich schema?' },
    { id: 'q-1', session: SESSION, from: NAME, kind: 'operator', status: 'answered', question: 'Done?', answer: { text: 'yes', by: 'tab' } },
    { id: 'q-3', session: 'other', from: 'Orch: other', kind: 'operator', status: 'open', question: 'Not ours' },
  ]) writeFileSync(join(state, 'round', `${(entry as { id: string }).id}.json`), JSON.stringify(entry))
  writeFileSync(join(state, 'todo', `${NAME}.jsonl`), over.todo ?? [todo(1, [2, 4]), todo(2, [1]), todo(3, [9]), todo(4, [1], 'closed'), todo(5, undefined)].join('\n') + '\n')
  const env = { ORCHESTRATOR_STATE_DIR: state, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }
  const out: string[] = []
  const err: string[] = []
  const io = { out: (t: string) => { out.push(t) }, err: (t: string) => { err.push(t) } }
  const prs = over.prs ?? { 'acme/app#12': 'MERGED' }
  const run = (...argv: string[]) => main(['takeover', record, '--mode', 'build', ...argv], env, io, { cwd: dir, now: () => NOW, prState: (repo, pr) => prs[`${repo}#${pr}`], paneWindow: tty => over.windows?.[tty], list: () => over.listed, journal: event => { journaled.push(event) }, movesHome: over.movesHome ?? false })
  return { state, briefs, record, out, err, run, journaled, text: () => out.join('') }
}

test('takeover prints the fixed instructions filled from the state, and writes no brief', () => {
  const w = world()
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  const text = w.text()
  assert.ok(text.startsWith('# Orchestrator succession brief — belt\n\nMode: build\n'))
  assert.ok(text.includes('You are the SUCCESSOR ORCHESTRATOR of `Orch: belt`.'))
  assert.ok(text.includes(`State directory: \`${w.state}\``))
  assert.match(text, /iterm-agents\/scripts\/iterm-agent\.sh close --tty \/dev\/ttys009 --expect-title "Orch: belt"/)
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'every placeholder filled')
  // Nothing about it is written beside the record: the brief is the output, never a file.
  assert.deepEqual(['succession-brief.md', 'state.md'].filter(f => existsSync(join(w.briefs, f))), [])
})

test('a takeover from the state alone: a state file, an earlier succession brief or a handover note left anywhere around the record changes nothing of the print', () => {
  const w = world()
  assert.equal(w.run(), 0)
  const alone = w.text()
  // What the state holds is all of it: the open rows, their owners, the pull requests, the agents, the open question.
  for (const part of ['open=2 label=API: routes', '2 api; ', 'acme/app#12 en cours (agent Agent: pr)', 'Agent: api', '[q-2] **Question 1 of 1**\nWhich schema?'])
    assert.ok(alone.includes(part), `the print holds ${part}`)
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(alone), 'every placeholder filled')
  // What a handover would leave, in the shape of what it would be read for, saying what the state does not. The
  // record, the goals and the owner file are the state itself and stay as they are.
  const lie = '- Rows open (id, label, what remains): open=99 label=GHOST\n- Row owners: 99 ghost\n- Agents running (name and reference, brief path): Agent: ghost\n'
  const note = `## Live state\n\n${lie}\n{"id":99,"label":"GHOST","state":"open"}\n[q-99] **Question 1 of 1**\nIs this read?\n`
  const names = ['state.md', 'state-archive.md', 'succession-brief.md', 'succession-brief.prev.md', 'handover.md', 'HANDOVER.md', 'notes.md', 'dispatch-record.jsonl.handover', 'dispatch-record.jsonl.state']
  for (const dirOf of [w.briefs, w.state, join(w.state, 'round'), join(w.state, 'todo'), dir])
    for (const f of names) writeFileSync(join(dirOf, f), note)
  w.out.length = 0
  assert.equal(w.run(), 0)
  assert.equal(w.text(), alone)
  assert.ok(!/GHOST|ghost|open=99|Is this read/.test(w.text()))
})

test('an orchestrator closed with no handover is taken up from the state alone: no brief, no note, and the print carries all the successor needs', () => {
  // The fixture is the state an orchestrator leaves when its tab is closed mid-work: the record, its
  // owner, goals, the deck, the round and the to-do list; no succession brief, no handover note anywhere.
  const w = world()
  assert.deepEqual(['succession-brief.md', 'handover.md', 'notes.md', 'state.md'].filter(f => existsSync(join(w.briefs, f)) || existsSync(join(w.state, f))), [])
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  const text = w.text()
  const needs: Record<string, string> = {
    'its mode': 'Mode: build\n',
    'whom it succeeds': 'SUCCESSOR ORCHESTRATOR of `Orch: belt`',
    'the predecessor\'s close': 'close --tty /dev/ttys009 --expect-title "Orch: belt"',
    'the open rows': 'open=4 label=DOCS: guide blocker=row 1 closed note=start from the old guide',
    'who owns each row': '- Row owners: 2 api; 3 ruling; 4 READY NOT STARTED; 5 READY NOT STARTED; 6 blocked: row 2 closed',
    'the pull requests': 'acme/app#12 en cours (agent Agent: pr)',
    'the live agents': '- Agents running (name and reference, brief path): Agent: api',
    'the open question, verbatim': '[q-2] **Question 1 of 1**\nWhich schema?',
    'the stray to-do items': 'to-do 2 → row 1 closed; to-do 3 → row 9 missing',
    'the project sheet': 'objective a belt that holds; spec /specs/belt.md; goals met=1/2 open=G2 (plan: phase 2)',
    'the state directory': `State directory: \`${w.state}\``,
    'the first dispatch': 'every open row with no agent that the phase rules allow',
  }
  for (const [need, part] of Object.entries(needs)) assert.ok(text.includes(part), `the print carries ${need}: ${part}`)
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'every placeholder filled')
  // The successor reads no reference to take over, and re-reads nothing the print already read live.
  assert.ok(!/references\/succession-successor\.md|pr-status|rev-parse/.test(text))
})

test('the close printed is the one command that fits the predecessor\'s place: takeover for window 0 of a home session, close for a tab', () => {
  const home = world({ windows: { '/dev/ttys009': 0 } })
  assert.equal(home.run('--tty', '/dev/ttys009'), 0)
  assert.match(home.text(), /iterm-agent\.sh takeover --tty \/dev\/ttys009 --expect-title "Orch: belt"/)
  assert.ok(!/ close --tty/.test(home.text()))
  const other = world({ windows: { '/dev/ttys009': 2 } })
  assert.equal(other.run('--tty', '/dev/ttys009'), 0)
  assert.match(other.text(), /iterm-agent\.sh close --tty \/dev\/ttys009/)
  assert.ok(!/ takeover --tty/.test(other.text()))
  assert.equal(closeVerb('none', () => 0).verb, 'close')
})

test('a takeover in a plain tab ends on the move into the home session; one in a home session dispatches in the same turn, nothing else waking it', () => {
  const plain = world({ movesHome: true })
  assert.equal(plain.run('--tty', '/dev/ttys009'), 0)
  assert.ok(plain.text().includes(`END THE TURN.${HOME_STEP}\n`))
  assert.match(plain.text(), /Its end turns this tab into your home session/)
  const home = world({ windows: { '/dev/ttys009': 0 }, movesHome: false })
  assert.equal(home.run('--tty', '/dev/ttys009'), 0)
  assert.ok(home.text().includes(`${STAY_TURN}\n4. Dispatch every open row`))
  assert.ok(plain.text().includes('\n4. Your next turn dispatches every open row'))
  assert.ok(plain.text().includes('the announcement; the turn ended.'))
  assert.ok(home.text().includes('the announcement; the open rows dispatched, or the wait declared.'))
  for (const print of [plain.text(), home.text()]) assert.ok(!/\{\{[A-Z_]+\}\}/.test(print))
  assert.ok(!home.text().includes('home session, as the orchestrator start command does'))
  // Read from where the session runs: a tmux pane, or any system but macOS, never moves.
  assert.equal(movesHome({ TMUX: '/tmp/tmux-501/orch-x,1,0' }, 'darwin'), false)
  assert.equal(movesHome({}, 'linux'), false)
  assert.equal(movesHome({ ORCHESTRATOR_TMUX: '/nonexistent/tmux' }, 'darwin'), false)
  assert.equal(movesHome({ ORCHESTRATOR_TMUX: 'true' }, 'darwin'), true)
})

test('two takeovers on one state print the same text', () => {
  const w = world()
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  const first = w.text()
  w.out.length = 0
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  assert.equal(w.text(), first)
})

test('the Live state: the open rows at level 1, their owners by agent, ruling or blocker, the ledger, the agents, the questions', () => {
  const w = world()
  assert.equal(w.run(), 0)
  const text = w.text()
  assert.match(text, /- Rows open \(id, label, what remains\): open=2 label=API: routes note=Dispatched: Agent: api; deferred=3 label=UI: pages ruling=ruling 4; open=4 label=DOCS: guide blocker=row 1 closed note=start from the old guide; open=5 label=PERF: cache blocker=PR acme\/app#12 merged; open=6 label=LINT: rules blocker=row 2 closed\n/)
  assert.match(text, /- Row owners: 2 api; 3 ruling; 4 READY NOT STARTED; 5 READY NOT STARTED; 6 blocked: row 2 closed\n/)
  assert.match(text, /- Pull requests open \(number, head, where each stands\): acme\/app#12 en cours \(agent Agent: pr\)\n/)
  assert.match(text, /- Agents running \(name and reference, brief path\): Agent: api\n/)
  assert.ok(text.includes('[q-2] **Question 1 of 1**\nWhich schema?'))
  assert.ok(!text.includes('q-1') && !text.includes('q-3') && !text.includes('acme/site#7') && !text.includes('Agent: site'))
  assert.match(w.err.join(''), /^takeover: chars=[0-9]+ rows=5 ready=2 prs=1 agents=1 questions=1 todo_stray=2 pruned=round:0\n$/)
})

test('takeover archives the round\'s entries settled over a day ago, and counts them in its pruned field', () => {
  const old = '2026-11-01T10:00:00Z'
  const settled = { from: NAME, session: SESSION, kind: 'operator', since: old, question: 'Q?' }
  const w = world({ round: [
    { id: 'q-open', ...settled, status: 'open', answer: null },
    { id: 'q-answered', ...settled, status: 'answered', answer: { text: 'A', by: 'pane', at: old } },
    { id: 'q-withdrawn', ...settled, status: 'withdrawn', answer: { text: 'moot', by: 'sender', at: old } },
  ] })
  assert.equal(w.run(), 0)
  assert.match(w.err.join(''), / pruned=round:2\n$/)
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'q-answered.json')))
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'withdrawn', 'q-withdrawn.json')))
  assert.ok(existsSync(join(w.state, 'round', 'q-open.json')))
})

test('the owner file read in the house shape: a name with its reference still finds its open questions', () => {
  const w = world()
  writeFileSync(`${w.record}.owner`, `${NAME} [a1b2c3]\n`)
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  assert.ok(w.text().includes('[q-2] **Question 1 of 1**\nWhich schema?'))
  assert.ok(w.text().includes('--expect-title "Orch: belt"'))
})

test('the project sheet lists the open goals only: a goal ruled out or deferred is neither open nor met', () => {
  const w = world({ goals: '# Goals\nspec: /s.md\naim: x\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | met | a | p1 | |\n| G2 | ruled-out | b | p2 | |\n| G3 | open | c | p3 | |\n' })
  assert.equal(w.run(), 0)
  assert.match(w.text(), /- Project: objective x; spec \/s\.md; goals met=1\/3 open=G3 \(plan: p3\)\n/)
})

test('a deferred goal shows on the Project line beside open=none, so the table is read for it', () => {
  const w = world({ goals: '# Goals\nspec: /s.md\naim: x\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | met | a | p1 | |\n| G2 | deferred | b | p2 | his words |\n| G3 | deferred | c | p3 | his words |\n' })
  assert.equal(w.run(), 0)
  assert.match(w.text(), /- Project: objective x; spec \/s\.md; goals met=1\/3 open=none deferred=G2,G3\n/)
})

test('an open to-do item pointing to a closed or missing row is flagged; one pointing to an open row, a closed item or an item with no row is not', () => {
  const w = world()
  assert.equal(w.run(), 0)
  assert.match(w.text(), /- To-do items whose row is closed or missing: to-do 2 → row 1 closed; to-do 3 → row 9 missing\n/)
  const v = world({ todo: todo(1, [2]) + '\n' })
  assert.equal(v.run(), 0)
  assert.match(v.text(), /- To-do items whose row is closed or missing: none\n/)
})

test('the project sheet reads the objective, the spec goals.md names, the open goals with their plan', () => {
  const w = world()
  assert.equal(w.run(), 0)
  assert.match(w.text(), /- Project: objective a belt that holds; spec \/specs\/belt\.md; goals met=1\/2 open=G2 \(plan: phase 2\)\n/)
  const v = world({ goals: null })
  assert.equal(v.run(), 0)
  assert.match(v.text(), /- Project: no goals\.md beside the record\n/)
  assert.equal(projectSheet('# Goals\nspec: none\naim:\n', '3 merged PRs not installed, oldest 2 h'), 'objective none; spec none; goals met=0/0 open=none; installed: 3 merged PRs not installed, oldest 2 h')
  assert.equal(projectSheet('# Goals\naim: x\n', ''), 'goals unread: goals.md: no spec: line')
  assert.equal(projectSheet('spec: none\n| G1 | open | a \\| b | | |\n', ''), 'objective none; spec none; goals met=0/1 open=G1 (plan: none)')
})

test('the name is the record\'s owner unless given; a record without one, or none at all, is refused', () => {
  const w = world()
  rmSync(`${w.record}.owner`)
  assert.equal(w.run(), 2)
  assert.match(w.err.at(-1) ?? '', /names no orchestration: pass --name/)
  assert.equal(w.run('--name', NAME), 0)
  assert.equal(main(['takeover', join(dir, 'none.jsonl'), '--mode', 'build'], {}, { out: () => {}, err: t => { w.err.push(t) } }, { cwd: dir, list: () => undefined, now: () => NOW }), 2)
  assert.match(w.err.at(-1) ?? '', /no dispatch record at/)
})

test('the command line: takeover, a record and the mode, flags checked', () => {
  assert.deepEqual(parseArgs(['takeover', 'r.jsonl', '--mode', 'investigate', '--tty', '/dev/ttys1'], '/w'), { record: '/w/r.jsonl', mode: 'investigate', tty: '/dev/ttys1', name: '', session: '', worktree: '/w' })
  assert.match((parseArgs(['live', 'b.md'], '/w') as { error: string }).error, /^usage:/)
  assert.match((parseArgs(['takeover'], '/w') as { error: string }).error, /^usage:/)
  const fromPlugin = '/Users/x/.claude/deploys/lounisbou/' + 'a'.repeat(40) + '/plugins/orchestrator/skills/orchestrator'
  assert.match((parseArgs(['takeover', 'r.jsonl', '--mode', 'build'], fromPlugin) as { error: string }).error, /from the project's directory/)
  assert.match((parseArgs(['takeover', 'r.jsonl', '--mode', 'build'], '/Users/x/.claude/plugins/cache/lounisbou/orchestrator/1.0.0') as { error: string }).error, /from the project's directory/)
  assert.equal((parseArgs(['takeover', 'r.jsonl', '--mode', 'build', '--worktree', '/w'], fromPlugin) as { worktree: string }).worktree, '/w')
  assert.match((parseArgs(['takeover', 'r', '--mode', 'other'], '/w') as { error: string }).error, /--mode build\|investigate is required/)
  assert.match((parseArgs(['takeover', 'r', '--mode'], '/w') as { error: string }).error, /--mode needs a value/)
  assert.match((parseArgs(['takeover', 'r', '--next', 'x'], '/w') as { error: string }).error, /unknown argument: --next/)
  const w = world()
  assert.equal(main(['takeover', w.record], {}, { out: () => {}, err: t => { w.err.push(t) } }, { cwd: dir, list: () => undefined, now: () => NOW }), 2)
})

test('a blocker is checked on its artifact: a row closed, a pull request merged, the release installed; what cannot be read says so', () => {
  const facts = (over: Partial<Artifacts> = {}): Artifacts => ({
    rows: [{ id: 1, state: 'closed' }, { id: 2, state: 'open' }], prState: () => undefined, installed: () => '', ...over,
  })
  assert.equal(fallOf('none', facts()), 'fallen')
  assert.equal(fallOf('row 1 closed', facts()), 'fallen')
  assert.equal(fallOf('row 2 closed', facts()), 'standing')
  assert.equal(fallOf('row 3 closed', facts()), 'unread')
  assert.equal(fallOf('PR acme/app#1 merged', facts({ prState: () => 'MERGED' })), 'fallen')
  assert.equal(fallOf('PR acme/app#1 merged', facts({ prState: () => 'OPEN' })), 'standing')
  assert.equal(fallOf('PR acme/app#1 merged', facts()), 'unread')
  assert.equal(fallOf('release installed', facts({ installed: () => '0 merged PRs not installed' })), 'fallen')
  assert.equal(fallOf('release installed', facts({ installed: () => '2 merged PRs not installed, oldest 3 h' })), 'standing')
  assert.equal(fallOf('release installed', facts()), 'unread')
  assert.equal(fallOf('after lunch', facts()), 'unread')
})

test('a moment blocker falls once its until time has passed, a measure stands and never falls by itself', () => {
  const MOMENT = Date.parse('2026-11-15T11:00:00Z')
  const facts = (now: number): Artifacts => ({ rows: [], prState: () => undefined, installed: () => '', now })
  assert.equal(fallOf('until 2026-11-15T11:00:00Z', facts(MOMENT - 1)), 'standing')
  assert.equal(fallOf('until 2026-11-15T11:00:00Z', facts(MOMENT)), 'fallen')
  assert.equal(fallOf('until 2026-11-15T11:00:00Z', facts(MOMENT + 86_400_000)), 'fallen')
  assert.equal(fallOf('measure dashboard p95 under 300 ms', facts(MOMENT + 86_400_000)), 'standing')
  assert.equal(fallOf('until 2026-02-30T00:00:00Z', facts(MOMENT + 86_400_000)), 'unread')
})

test('ownersOf: a row whose until has passed reads READY NOT STARTED, a row on a measure reads blocked', () => {
  const MOMENT = Date.parse('2026-11-15T11:00:00Z')
  const rows = [
    { id: '1', line: '', label: 'WAKE: at eleven', blocker: 'until 2026-11-15T11:00:00Z' },
    { id: '2', line: '', label: 'SPEED: p95', blocker: 'measure p95 under 300 ms' },
  ]
  const at = (now: number) => (blocker: string) => fallOf(blocker, { rows: [], prState: () => undefined, installed: () => '', now })
  assert.deepEqual(ownersOf({ rows, prs: [], agents: [], questions: [] }, at(MOMENT - 1)), ['1 blocked: until 2026-11-15T11:00:00Z', '2 blocked: measure p95 under 300 ms'])
  assert.deepEqual(ownersOf({ rows, prs: [], agents: [], questions: [] }, at(MOMENT)), ['1 READY NOT STARTED', '2 blocked: measure p95 under 300 ms'])
})

test('ownersOf names each open row\'s live agent as its note names it, a deferred row\'s ruling, its fallen or standing blocker, and flags a row with none recorded', () => {
  const rows = [
    { id: '1', line: '', label: 'TAKEOVERLEAN: a takeover reads less', blocker: 'none', note: 'Dispatched: Agent: takeoverlean (ttys004)' },
    { id: '2', line: '', label: 'QREDESIGN PR4: remove the old path', note: 'Dispatched to Agent: qredesign-removal-2, then rotated' },
    { id: '3', line: '', label: 'AUDIT: nobody works it' },
    { id: '4', line: '', label: 'LATER: parked', ruling: 'ruling 9', blocker: 'none' },
    { id: '5', line: '', label: 'AB: its label word is an agent\'s name, which owns nothing' },
    { id: '6', line: '', label: 'READY: nobody on it', blocker: 'none' },
    { id: '7', line: '', label: 'WAIT: on a pull request', blocker: 'PR acme/app#3 merged' },
    { id: '8', line: '', label: 'GONE: its forge is unreachable', blocker: 'PR acme/app#4 merged' },
  ]
  const agents = ['Agent: takeoverlean', 'Agent: qredesign-removal-2', 'Agent: ab']
  const fall = (blocker: string) => (blocker === 'none' ? 'fallen' : blocker.includes('#3') ? 'standing' : 'unread') as 'fallen' | 'standing' | 'unread'
  assert.deepEqual(ownersOf({ rows, prs: [], agents, questions: [] }, fall), [
    '1 takeoverlean', '2 qredesign-removal-2', '3 NO OWNER', '4 ruling', '5 NO OWNER', '6 READY NOT STARTED', '7 blocked: PR acme/app#3 merged', '8 blocker unread: PR acme/app#4 merged',
  ])
  assert.deepEqual(ownersOf({ rows: [rows[5] ?? { id: '', line: '' }], prs: [], agents: [], questions: [] }), ['6 blocker unread: none'])
})

test('ownersOf reads the agent a row was dispatched to from its note: a live agent holds its row whatever its label, a shared label word gives no row to another agent', () => {
  // The takeover of 2026-11-15: two rows worked by live agents read READY NOT STARTED, and a third went to the wrong agent.
  const rows = [
    { id: '35', line: '', label: 'geo-git-flow: bloc d\'état après chaque étape', blocker: 'row 49 closed', note: 'Dispatched 2026-11-15T11:40Z: Agent: ggf P17 status block (ttys004, deep), branch feat/step-status-block' },
    { id: '51', line: '', label: 'P10 staging mobile builds (Android preview)', blocker: 'row 49 closed', note: 'Dispatched 2026-11-15T11:40Z: Agent: ggf P10 Android preview (ttys002, standard)' },
    { id: '57', line: '', label: 'ggf: systemdRestarts switched to per-unit restarts', blocker: 'row 56 closed' },
    { id: '58', line: '', label: 'ggf: P1 cleanup', blocker: 'none', note: 'Dispatched: Agent: ggf P1 (ttys009), stood down' },
  ]
  const agents = ['Agent: ggf P17 status block', 'Agent: ggf P10 Android preview', 'Agent: ggf P1x']
  const fallen = () => 'fallen' as const
  assert.deepEqual(ownersOf({ rows, prs: [], agents, questions: [] }, fallen), [
    '35 ggf P17 status block', '51 ggf P10 Android preview', '57 READY NOT STARTED', '58 DISPATCHED, NO LIVE AGENT',
  ])
  // A name is matched whole: « ggf P1 » in a note is not « ggf P17 status block », nor the reverse.
  assert.deepEqual(ownersOf({ rows: [rows[3] ?? { id: '', line: '' }], prs: [], agents: ['Agent: ggf P17 status block'], questions: [] }, fallen), ['58 DISPATCHED, NO LIVE AGENT'])
  assert.deepEqual(ownersOf({ rows: [rows[0] ?? { id: '', line: '' }], prs: [], agents: ['Agent: ggf P1'], questions: [] }, fallen), ['35 DISPATCHED, NO LIVE AGENT'])
})

test('todoStray reads the open items only, each row they name once against the record', () => {
  const rows = [{ id: 1, state: 'closed' }, { id: 2, state: 'open' }]
  assert.deepEqual(todoStray([todo(1, [1, 2, 3]), todo(2, [1], 'closed'), 'torn line'].join('\n'), rows), ['to-do 1 → row 1 closed', 'to-do 1 → row 3 missing'])
  assert.deepEqual(todoStray('', rows), [])
})

test('the deck and the round are read as data: a remote orchestrator, a malformed file, none', () => {
  assert.deepEqual(deckOpen(undefined, NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen('not json', NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen(JSON.stringify(deckOf([orchestrator(NAME, null, ['a#1'], [], 'mini')])), NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen(JSON.stringify(deckOf([orchestrator(NAME, 'acme/app', ['a#1'], ['Agent: api'])])), NAME), { prs: ['a#1'], agents: [{ name: 'Agent: api', tty: null }], repo: 'acme/app' })
  assert.deepEqual(deckOpen(JSON.stringify({ ...deckOf([orchestrator(NAME, null)]), version: 2 }), NAME), { prs: [], agents: [] })
  assert.deepEqual(roundOpen([undefined, { id: 'a', from: NAME, kind: 'operator', status: 'open' }], NAME, SESSION), [{ id: 'a', text: '' }])
})

/** A deck orchestrator on a tty. */
const seated = (name: string, tty: string, agents: string[]) => ({ ...orchestrator(name, null, [], agents), tty })
/** A row of the launcher's `list`. */
const row = (tty: string, name: string, self = false): ListedRow => ({ tty, name, self })

test('two orchestrators of one name during a handover: the deck row on the predecessor\'s tty is read, the successor\'s is not', () => {
  const deck = JSON.stringify(deckOf([seated(NAME, '/dev/ttys009', []), seated(NAME, '/dev/ttys005', ['Agent: p10', 'Agent: p17'])]))
  assert.deepEqual(deckOpen(deck, NAME, '/dev/ttys005').agents.map(a => a.name), ['Agent: p10', 'Agent: p17'])
  assert.deepEqual(deckOpen(deck, NAME, 'ttys005').agents.map(a => a.name), ['Agent: p10', 'Agent: p17'])
  // No tty given, or none of the deck's: every orchestrator of the name counts, never the first alone.
  assert.deepEqual(deckOpen(deck, NAME).agents.map(a => a.name), ['Agent: p10', 'Agent: p17'])
  assert.deepEqual(deckOpen(deck, NAME, '/dev/ttys099').agents.map(a => a.name), ['Agent: p10', 'Agent: p17'])
})

test('an agent spawned since the deck\'s last write is printed from the launcher\'s chain and list, with its tty and brief, and the miss is journaled', () => {
  const w = world({
    deck: deckOf([seated(NAME, '/dev/ttys009', []), seated(NAME, '/dev/ttys005', ['Agent: api'])]),
    listed: [row('/dev/ttys005', NAME), row('/dev/ttys009', NAME, true), row('/dev/ttys004', 'Agent: api'), row('/dev/ttys006', 'Agent: per-unit restarts'), row('/dev/ttys007', 'Agent: someone else')],
  })
  mkdirSync(join(w.state, 'chains'), { recursive: true })
  // The predecessor launched the fresh agent after the successor's spawn took its chain.
  writeFileSync(join(w.state, 'chains', 'ttys005.jsonl'), '{"tab_id": "t6", "tty": "/dev/ttys006", "owner": "s-old"}\n{"tab_id": "t8", "tty": "/dev/ttys008", "owner": "s-old"}\n')
  writeFileSync(join(w.state, 'chains', 'ttys009.jsonl'), '{"tab_id": "t4", "tty": "/dev/ttys004", "owner": "s-new"}\n')
  mkdirSync(join(w.state, 'prompts'), { recursive: true })
  writeFileSync(join(w.state, 'prompts', 'launch-Agent--per-unit-restarts-1700000000000.sh'), "#!/bin/sh\nexport ORCHESTRATOR_BRIEF='/b/old.md' && run\n")
  writeFileSync(join(w.state, 'prompts', 'launch-Agent--per-unit-restarts-1700000009000.sh'), '#!/bin/sh\ncd /w && export ORCHESTRATOR_BRIEF=/b/rows/57-brief.md && run\n')
  assert.equal(w.run('--tty', '/dev/ttys005'), 0)
  assert.match(w.text(), /- Agents running \(name and reference, brief path\): Agent: api \(ttys004\); Agent: per-unit restarts \(ttys006, brief \/b\/rows\/57-brief\.md\)\n/)
  // An agent of another orchestrator and a chained tty no session runs on stay out.
  assert.ok(!w.text().includes('someone else') && !w.text().includes('ttys008'))
  assert.match(w.err.join(''), / agents=2 agents_disagree=1 /)
  assert.equal(w.journaled.length, 1)
  assert.deepEqual((w.journaled[0] as { fact: unknown }).fact, { failure: 'succession-lost-state', count: 1, prs: [] })
})

test('rowOfBrief reads the row a brief was printed for: a phase brief\'s, a rotation brief\'s; none from free text', () => {
  assert.equal(rowOfBrief('# belt — API\n\nYou are the implementer of row 259 of the dispatch record. You implement.\n\nMode: build\nRow: 259 API: routes\n'), '259')
  assert.equal(rowOfBrief('# belt — resume brief for row 262: the stop gate\n\nYou are the ROTATION agent.\n'), '262')
  assert.equal(rowOfBrief('Mode: build\nRow: 264 LINT: rules — note: after row 2\n'), '264')
  assert.equal(rowOfBrief('Agent: takeoversense works row 265, see the note.\n'), undefined)
  assert.equal(rowOfBrief(undefined), undefined)
})

test('ownersOf binds a live agent to the row its brief was printed for, never to a row whose note merely names it', () => {
  // The takeover of 2026-11-15: 259 read READY NOT STARTED, 262 and 264 NO OWNER, and 265, whose note
  // named takeoversense, went to it.
  const rows = [
    { id: '259', line: '', label: 'TAKEOVERSENSE: the takeover reads', blocker: 'none' },
    { id: '262', line: '', label: 'UNHOLD: the stop gate' },
    { id: '264', line: '', label: 'ARCHIVESORT: the archive' },
    { id: '265', line: '', label: 'TAKEOVERPROMPT: the takeover defects', blocker: 'none', note: 'seen in takeoversense\'s session' },
  ]
  const seats = [
    { name: 'Agent: takeoversense', tty: null, row: '259' },
    { name: 'Agent: unhold', tty: null, row: '262' },
    { name: 'Agent: archivesort', tty: null, row: '264' },
  ]
  assert.deepEqual(ownersOf({ rows, prs: [], agents: seats.map(seat => seat.name), seats, questions: [] }, () => 'fallen'), [
    '259 takeoversense', '262 unhold', '264 archivesort', '265 READY NOT STARTED',
  ])
})

test('the takeover reads each agent\'s row in the brief its launch named', () => {
  const w = world({
    rows: [
      JSON.stringify({ id: 259, label: 'TAKEOVERSENSE: the takeover reads', state: 'open', blocker: 'none' }),
      JSON.stringify({ id: 264, label: 'ARCHIVESORT: the archive', state: 'open' }),
      JSON.stringify({ id: 265, label: 'TAKEOVERPROMPT: the takeover defects', state: 'open', blocker: 'none', note: 'seen in takeoversense\'s session' }),
    ].join('\n') + '\n',
    deck: deckOf([orchestrator(NAME, null, [], ['Agent: takeoversense', 'Agent: archivesort'])]),
  })
  mkdirSync(join(w.state, 'prompts'), { recursive: true })
  writeFileSync(join(w.briefs, 'takeoversense-brief.md'), '# belt — TAKEOVERSENSE\n\nYou are the implementer of row 259 of the dispatch record.\n')
  writeFileSync(join(w.briefs, 'archivesort-rotation.md'), '# belt — resume brief for row 264: the archive\n')
  writeFileSync(join(w.state, 'prompts', 'launch-Agent--takeoversense-1700000000000.sh'), `#!/bin/sh\nexport ORCHESTRATOR_BRIEF='${join(w.briefs, 'takeoversense-brief.md')}' && run\n`)
  writeFileSync(join(w.state, 'prompts', 'launch-Agent--archivesort-1700000000000.sh'), `#!/bin/sh\nexport ORCHESTRATOR_BRIEF='${join(w.briefs, 'archivesort-rotation.md')}' && run\n`)
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  assert.match(w.text(), /- Row owners: 259 takeoversense; 264 archivesort; 265 READY NOT STARTED\n/)
})

test('the deck and the launcher agreeing journal nothing; no list leaves the deck as it is', () => {
  const agree = world({ listed: [row('/dev/ttys004', 'Agent: api')] })
  assert.equal(agree.run('--tty', '/dev/ttys009'), 0)
  assert.equal(agree.journaled.length, 0)
  assert.match(agree.err.join(''), / agents_disagree=0 /)
  const unread = world()
  assert.equal(unread.run('--tty', '/dev/ttys009'), 0)
  assert.ok(!unread.err.join('').includes('agents_disagree'))
  assert.equal(unread.journaled.length, 0)
  // A deck agent the list does not show counts as a miss, and stays printed: the successor reads its pull request.
  assert.deepEqual(liveAgents([{ name: 'Agent: gone', tty: null }], [], []), { agents: [{ name: 'Agent: gone', tty: null }], disagree: 1 })
})

test('the launcher\'s list rows: the name, else the title without its glyph, and the caller\'s own row', () => {
  const text = 'w1/t1 | /dev/ttys009 | ✳ Orch: belt | Orch: belt | self\nw1/t2 | /dev/ttys004 | ◑ api work | (host default) | hidden\norphan: /dev/ttys004 (w1/t2) is an agent of the orchestrator on /dev/ttys001, which has ended\n'
  assert.deepEqual(parseList(text), [row('/dev/ttys009', 'Orch: belt', true), row('/dev/ttys004', 'api work')])
  assert.equal(agentLine({ name: 'Agent: a', tty: null }), 'Agent: a')
  assert.equal(agentLine({ name: 'Agent: a', tty: '/dev/ttys004', brief: '/b.md' }), 'Agent: a (ttys004, brief /b.md)')
  assert.equal(briefOf(join(dir, 'nowhere'), 'Agent: a'), undefined)
  mkdirSync(join(dir, 'prompts'))
  writeFileSync(join(dir, 'prompts', 'launch-Agent--a-12.sh'), '#!/bin/sh\nrun\n')
  assert.equal(briefOf(dir, 'Agent: a'), undefined)
})

test('the open questions asked with ask are printed as their block made from their fields, and no settled one', () => {
  const asked = (id: string, status: string, sender: object) => ({
    v: 2, id, sender, status, subject: 'merge order', context: 'Two pull requests touch one file.', ask: 'Which first?',
    choices: [{ letter: 'A', text: 'acme/app#1' }, { letter: 'B', text: 'acme/app#2' }], recommended: 'A', why: 'no rebase',
  })
  const open = roundOpen([
    asked('q-1', 'open', { session: SESSION, name: 'Orch: other' }), asked('q-2', 'open', { session: 'x', name: NAME }),
    asked('q-3', 'answered', { session: SESSION, name: NAME }), asked('q-4', 'open', { session: 'x', name: 'Orch: other' }),
  ], NAME, SESSION)
  assert.deepEqual(open.map(q => q.id), ['q-1', 'q-2'])
  assert.equal(open[0]?.text, [
    '_Subject_ : merge order', '_Context_ : Two pull requests touch one file.', '_Question_ : Which first?',
    '_Choices_ :', '- **A** : acme/app#1', '- **B** : acme/app#2', '_Recommendation_ : A — no rebase',
  ].join('\n'))
})

/** An object `ask` stored, as the round holds it, whatever its status. */
const storedAsk = (id: string, status: 'open' | 'answered' | 'withdrawn', over: Record<string, unknown> = {}) => ({
  v: 2, id, sender: { session: SESSION, name: NAME, role: 'orchestrator', machine: 'mbp' }, subject: 'merge order', context: 'Two pull requests touch one file.', ask: 'Which first?',
  choices: [{ letter: 'A', text: 'acme/app#1' }, { letter: 'B', text: 'acme/app#2' }], recommended: 'A', why: 'no rebase', blocks: 'row 2',
  status, at: '2026-11-15T08:00:00.000Z', seq: 1,
  answer: status === 'open' ? null : { text: status === 'answered' ? 'B' : 'the sender\'s session ended', by: status === 'answered' ? 'tab' : 'sender', at: '2026-11-15T09:00:00.000Z', settler: NAME },
  ...over,
})
const texts = (...entries: object[]): string[] => entries.map(entry => JSON.stringify(entry))

test('a successor asks again only what its predecessor never had answered: each status of the round, and each key', () => {
  const none = { answered: [], reask: [] }
  // Open: the question moved to the successor stays where it is, listed by roundOpen and not again.
  assert.deepEqual(roundSettled(texts(storedAsk('q-1', 'open')), [], NAME, SESSION), none)
  // Answered: applied with its answer, never asked again.
  const answered = roundSettled(texts(storedAsk('q-2', 'answered')), [], NAME, SESSION)
  assert.deepEqual(answered, { answered: [{ id: 'q-2', label: 'merge order', text: '_Subject_ : merge order\n_Context_ : Two pull requests touch one file.\n_Question_ : Which first?\n_Choices_ :\n- **A** : acme/app#1\n- **B** : acme/app#2\n_Recommendation_ : A — no rebase', said: 'B' }], reask: [] })
  // Withdrawn alone: asked again, once, with the reason it was withdrawn for.
  const withdrawn = roundSettled(texts(storedAsk('q-3', 'withdrawn')), [], NAME, SESSION)
  assert.deepEqual(withdrawn.reask.map(q => [q.id, q.said]), [['q-3', 'the sender\'s session ended']])
  assert.deepEqual(withdrawn.answered, [])
  // Withdrawn while an open entry with its key exists, under any session: not asked again.
  assert.deepEqual(roundSettled(texts(storedAsk('q-3', 'withdrawn'), storedAsk('q-4', 'open', { sender: { session: 'other', name: NAME, role: 'orchestrator', machine: 'mbp' } })), [], NAME, SESSION).reask, [])
  // Withdrawn after the operator answered the same question, in the round or its archive: not asked again.
  assert.deepEqual(roundSettled(texts(storedAsk('q-3', 'withdrawn'), storedAsk('q-5', 'answered')), [], NAME, SESSION).reask, [])
  assert.deepEqual(roundSettled(texts(storedAsk('q-3', 'withdrawn')), texts(storedAsk('q-6', 'answered')), NAME, SESSION).reask, [])
  // The same question withdrawn twice: the newest alone is asked again, once.
  assert.deepEqual(roundSettled(texts(storedAsk('q-7', 'withdrawn'), storedAsk('q-8', 'withdrawn', { answer: { text: 'ended', by: 'sender', at: '2026-11-15T09:30:00.000Z', settler: NAME } })), [], NAME, SESSION).reask.map(q => q.id), ['q-8'])
  // A different question is its own key.
  assert.deepEqual(roundSettled(texts(storedAsk('q-3', 'withdrawn'), storedAsk('q-9', 'open', { ask: 'Which later?' })), [], NAME, SESSION).reask.map(q => q.id), ['q-3'])
  // Another orchestration's entries, and what is no entry, are none of its business.
  assert.deepEqual(roundSettled([...texts(storedAsk('q-3', 'withdrawn', { sender: { session: 'x', name: 'Orch: other', role: 'orchestrator', machine: 'mbp' } }), storedAsk('q-2', 'answered', { sender: { session: 'x', name: 'Orch: other', role: 'orchestrator', machine: 'mbp' } })), 'not json', undefined as unknown as string], [], NAME, SESSION), none)
})

test('a withdrawal made in the asker\'s tab is the operator\'s answer, with the words he typed; a relay entry closed with a withdrawal is a withdrawal; another asker\'s newer withdrawal silences nobody', () => {
  const tab = storedAsk('q-1', 'withdrawn', { answer: { text: 'answered in the sender\'s own tab', by: 'tab', at: '2026-11-15T09:00:00.000Z', settler: NAME, typed: 'B please' } })
  const typed = roundSettled(texts(tab), [], NAME, SESSION)
  assert.deepEqual([typed.answered.map(q => q.said), typed.reask], [['B please'], []])
  const untyped = roundSettled(texts({ ...tab, answer: { ...tab.answer, typed: undefined } }), [], NAME, SESSION)
  assert.deepEqual(untyped.answered.map(q => q.said), ['answered in the sender\'s own tab'])
  // What a coordinator shown the entry leaves when the operator answers in the asker's tab: closed, a withdrawn-looking text, his words in `typed`.
  const closed = (id: string, text: string, by: string, typed?: string) => ({ id, session: SESSION, from: NAME, kind: 'operator', status: 'closed', question: `${id}?`, answer: { text, by, at: '2026-11-15T09:00:00Z', ...(typed === undefined ? {} : { typed }) } })
  const relayed = roundSettled(texts(
    closed('r-1', 'withdrawn: answered in the sender\'s own tab', 'tab', 'the second'), closed('r-2', 'B', 'tab'), closed('r-3', 'withdrawn: settled meanwhile', 'sender'),
    closed('r-4', 'withdrawn: answered in the sender\'s own tab', 'tab'),
  ), [], NAME, SESSION)
  assert.deepEqual([relayed.reask.map(q => q.id), relayed.answered.map(q => [q.id, q.said])], [['r-3'], [['r-1', 'the second'], ['r-2', 'B'], ['r-4', 'answered in the sender\'s own tab']]])
  const stranger = storedAsk('q-9', 'withdrawn', { sender: { session: 'x', name: 'Agent: belt', role: 'agent', machine: 'mbp' }, answer: { text: 'ended', by: 'sender', at: '2026-11-15T10:30:00.000Z', settler: 'x' } })
  assert.deepEqual(roundSettled(texts(storedAsk('q-8', 'withdrawn'), stranger), [], NAME, SESSION).reask.map(q => q.id), ['q-8'])
  assert.equal(roundSettled(texts(storedAsk('q-8', 'withdrawn', { answer: { text: '', by: 'sender', at: '2026-11-15T09:00:00.000Z', settler: NAME } })), [], NAME, SESSION).reask[0]?.said, '')
})

test('an entry `ask` stored malformed is ignored, and a consent asked keys the question apart', () => {
  const none = { answered: [], reask: [] }
  assert.deepEqual(roundSettled(texts(storedAsk('q-1', 'withdrawn', { choices: [{ letter: 'A' }] }), storedAsk('q-2', 'withdrawn', { why: 3 }), storedAsk('q-3', 'withdrawn', { sender: 'x' }), storedAsk('q-4', 'withdrawn', { consent: { kind: 'nope' } })), [], NAME, SESSION), none)
  const consent = { kind: 'auto-merge', repo: 'acme/app' }
  const asked = roundSettled(texts(storedAsk('q-5', 'withdrawn', { consent }), storedAsk('q-6', 'open')), [], NAME, SESSION)
  assert.deepEqual(asked.reask.map(q => q.id), ['q-5'])
})

test('the relay\'s entries follow the same rule: answered or closed is applied, a withdrawn one asked again unless its question is open or answered', () => {
  const relayed = (id: string, status: string, question = 'Which schema?') => ({ id, session: SESSION, from: NAME, kind: 'operator', status, question, answer: status === 'open' ? null : { text: status === 'withdrawn' ? 'moot' : 'the second' } })
  const settled = roundSettled(texts(relayed('r-1', 'answered'), relayed('r-2', 'closed', 'Done?'), relayed('r-3', 'withdrawn', 'Later?')), [], NAME, SESSION)
  assert.deepEqual(settled.answered.map(q => [q.id, q.label, q.said]), [['r-1', 'Which schema?', 'the second'], ['r-2', 'Done?', 'the second']])
  assert.deepEqual(settled.reask.map(q => [q.id, q.text, q.said]), [['r-3', 'Later?', 'moot']])
  assert.deepEqual(roundSettled(texts(relayed('r-3', 'withdrawn', 'Later?'), relayed('r-4', 'open', 'Later?')), [], NAME, SESSION).reask, [])
})

test('the takeover prints the answers to apply and the withdrawn questions to ask again, and none once an open entry holds the key', () => {
  const asked = (id: string, status: 'open' | 'answered' | 'withdrawn', over: Record<string, unknown> = {}) => storedAsk(id, status, over)
  const pending = { answer: { text: 'B', by: 'coordinator', at: '2026-11-15T09:00:00.000Z', settler: 'Coord: general' } }
  const w = world({ round: [asked('q-a', 'answered', pending), asked('q-w', 'withdrawn', { ask: 'Which later?' }), asked('q-o', 'open', { ask: 'Which third?' }), asked('q-v', 'withdrawn', { ask: 'Which third?' })] })
  assert.equal(w.run(), 0)
  const text = w.text()
  assert.ok(text.includes('[q-a] merge order: B\n'))
  assert.ok(text.includes('[q-w] the sender\'s session ended\n_Subject_ : merge order\n_Context_ : Two pull requests touch one file.\n_Question_ : Which later?'))
  assert.ok(text.includes('[q-o] _Subject_ : merge order'))
  assert.ok(!text.includes('[q-v]') && !text.includes('[q-a] _Subject_') && !text.includes('[q-a] the sender'))
})

test('the archive is read for the keys: a question answered a day ago, or withdrawn since, still holds its key', () => {
  const w = world({ round: [storedAsk('q-w', 'withdrawn', { ask: 'Which later?' }), storedAsk('q-x', 'withdrawn', { ask: 'Which third?' })] })
  mkdirSync(join(w.state, 'round', 'archive', 'withdrawn'), { recursive: true })
  writeFileSync(join(w.state, 'round', 'archive', 'q-old.json'), JSON.stringify(storedAsk('q-old', 'answered', { ask: 'Which later?' })))
  writeFileSync(join(w.state, 'round', 'archive', 'withdrawn', 'q-older.json'), JSON.stringify(storedAsk('q-older', 'withdrawn', { ask: 'Which third?', at: '2026-11-14T09:30:00.000Z' })))
  assert.equal(w.run(), 0)
  assert.ok(!w.text().includes('[q-w]'))
  assert.ok(w.text().includes('[q-x]'))
})

test('an entry is its orchestration\'s by the name alone or by the session alone, the relay\'s too; the newest relay withdrawal of a question speaks for the others', () => {
  const sender = (session: string, name: string) => ({ session, name, role: 'orchestrator', machine: 'mbp' })
  const byName = roundSettled(texts(storedAsk('q-1', 'withdrawn', { sender: sender('gone', NAME) })), [], NAME, '')
  const bySession = roundSettled(texts(storedAsk('q-2', 'withdrawn', { sender: sender(SESSION, 'Orch: renamed') })), [], NAME, SESSION)
  assert.deepEqual([byName.reask.map(q => q.id), bySession.reask.map(q => q.id)], [['q-1'], ['q-2']])
  assert.deepEqual(roundSettled(texts(storedAsk('q-3', 'withdrawn', { sender: sender('x', 'Orch: other') })), [], NAME, SESSION).reask, [])
  assert.deepEqual(roundSettled(texts(storedAsk('q-4', 'withdrawn', { sender: sender('x', 'Orch: renamed') })), [], NAME, '').reask, [])
  const relayed = (id: string, since: string, over: Record<string, unknown> = {}) => ({ id, kind: 'operator', status: 'withdrawn', question: 'Later?', since, answer: { text: 'moot' }, from: 'Orch: renamed', session: SESSION, ...over })
  assert.deepEqual(roundSettled(texts(relayed('r-1', '2026-11-15T08:00:00Z'), relayed('r-2', '2026-11-15T09:00:00Z')), [], NAME, SESSION).reask.map(q => q.id), ['r-2'])
  assert.deepEqual(roundSettled(texts(relayed('r-3', '2026-11-15T08:00:00Z', { from: NAME, session: 'gone' })), [], NAME, '').reask.map(q => q.id), ['r-3'])
  assert.deepEqual(roundSettled(texts(relayed('r-4', '2026-11-15T08:00:00Z', { from: 'Orch: other', session: 'x' })), [], NAME, SESSION).reask, [])
})

test('with nothing to apply in the round, the takeover prints no answered section and says none of the withdrawn', () => {
  const empty = world({ round: [] })
  assert.equal(empty.run(), 0)
  assert.ok(!empty.text().includes('Questions the operator answered'))
  assert.match(empty.text(), /^- Questions withdrawn[^\n]*: none$/m)
})

test('the successor\'s prompt names no script directory of the predecessor: it runs the takeover from its own copy of the plugin, which the takeover prints as the one every script is in', () => {
  // The succession of 2026-11-15 loaded the new skill and ran every script of the predecessor's copy, 116 commits older.
  const succeed = readFileSync(join(import.meta.dirname, '..', '..', '..', 'commands', 'succeed.md'), 'utf8')
  const prompt = /--prompt '([^']*)'/.exec(succeed)?.[1] ?? ''
  assert.ok(prompt.includes('succession.sh takeover <dispatch record> --mode <your mode> --tty <your tty>'), prompt)
  assert.ok(prompt.includes('from your working directory (do not cd), run <the base directory that skill load printed>/scripts/succession.sh'), prompt)
  assert.ok(!/<scripts>|CLAUDE_PLUGIN_ROOT|\/skills\/orchestrator\/scripts/.test(prompt), prompt)
  const w = world()
  assert.equal(w.run(), 0)
  assert.ok(w.text().includes(`Every script below is in \`${import.meta.dirname}\`, the copy this takeover ran from.`))
})

test('fill leaves a placeholder it has no value for; the template is the plugin\'s fixed text', () => {
  assert.equal(fill('{{A}} {{B}}', { A: 'a' }), 'a {{B}}')
  assert.ok(readFileSync(TEMPLATE, 'utf8').startsWith('# Orchestrator succession brief — {{PROJECT}}'))
})

/** A repository whose main merged a pull request touching the plugin, and the install record of the commit before it. */
function installedWorld(): { repo: string; env: Record<string, string>; merged: Date } {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'plugins', 'orchestrator'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-14T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-14T10:00:00Z' } }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'plugins', 'orchestrator', 'a'), 'a')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const sha = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'feat')
  writeFileSync(join(repo, 'plugins', 'orchestrator', 'b'), 'b')
  git('add', '-A')
  git('commit', '-q', '-m', 'feature')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'feat')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('remote', 'add', 'origin', 'git@github.com:acme/belt.git')
  const config = join(dir, 'config')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'orchestrator@acme': [{ gitCommitSha: sha }] } }))
  return { repo, env: { CLAUDE_CONFIG_DIR: config, HOME: dir }, merged: new Date('2026-11-14T10:00:00Z') }
}

test('notInstalled counts the merged pull requests touching the plugin since the installed commit, and says nothing it cannot read', () => {
  const w = installedWorld()
  assert.equal(notInstalled(w.repo, w.env, new Date(w.merged.getTime() + 5 * 3_600_000)), '1 merged PRs not installed, oldest 5 h')
  assert.equal(notInstalled('none', w.env, w.merged), '', 'no worktree')
  assert.equal(notInstalled(w.repo, { ...w.env, CLAUDE_CONFIG_DIR: join(dir, 'nowhere') }, w.merged), '', 'no install record')
  writeFileSync(join(w.env['CLAUDE_CONFIG_DIR'] ?? '', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'orchestrator@acme': [{ gitCommitSha: 'a'.repeat(40) }] } }))
  assert.equal(notInstalled(w.repo, w.env, w.merged), '', 'a commit the repository does not hold')
})

test('notInstalled counts two merged pull requests and reads the age of the older one', () => {
  const w = installedWorld()
  const base = (JSON.parse(readFileSync(join(w.env['CLAUDE_CONFIG_DIR'] ?? '', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { gitCommitSha: string }[]> }).plugins['orchestrator@acme']?.[0]?.gitCommitSha ?? ''
  const older = '2026-11-14T06:00:00Z'
  const git = (...args: string[]) => execFileSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: older, GIT_AUTHOR_DATE: older } }).trim()
  git('checkout', '-q', '-b', 'older', base)
  writeFileSync(join(w.repo, 'plugins', 'orchestrator', 'c'), 'c')
  git('add', '-A')
  git('commit', '-q', '-m', 'older feature')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #0', 'older')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  // The newer merge is at 10:00, the older one at 06:00: the age is taken from the older, read at 15:00.
  assert.equal(notInstalled(w.repo, w.env, new Date(w.merged.getTime() + 5 * 3_600_000)), '2 merged PRs not installed, oldest 9 h')
})

test('a takeover in a worktree names its project by origin, prints the not-installed line, and reads a release blocker by it', () => {
  const i = installedWorld()
  assert.equal(projectOf(i.repo, '/x/y/r.jsonl'), 'acme/belt')
  assert.equal(projectOf(join(dir, 'nowhere'), '/x/y/r.jsonl'), 'y')
  const w = world({ rows: JSON.stringify({ id: 1, label: 'SHIP: it', state: 'open', blocker: 'release installed' }) + '\n', todo: '' })
  const out: string[] = []
  const env = { ...i.env, ORCHESTRATOR_STATE_DIR: w.state }
  assert.equal(main(['takeover', w.record, '--mode', 'build', '--worktree', i.repo], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => new Date(i.merged.getTime() + 3_600_000), prState: () => undefined }), 0)
  assert.ok(out.join('').startsWith('# Orchestrator succession brief — acme/belt\n'))
  assert.match(out.join(''), /- Row owners: 1 blocked: release installed\n/)
  assert.match(out.join(''), /; installed: 1 merged PRs not installed, oldest 1 h\n/)
  const tip = execFileSync('git', ['-C', i.repo, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
  writeFileSync(join(i.env['CLAUDE_CONFIG_DIR'] ?? '', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'orchestrator@acme': [{ gitCommitSha: tip }] } }))
  out.length = 0
  assert.equal(main(['takeover', w.record, '--mode', 'build', '--worktree', i.repo], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => NOW, prState: () => undefined }), 0)
  assert.match(out.join(''), /- Row owners: 1 READY NOT STARTED\n/)
})

/** The record of an orchestration that predates `dispatch-record.sh pr`: its open row names no pull request, only the heads its review recorded; the ledger is empty and the owner file names no orchestration. */
function flowWorld() {
  const head = 'b'.repeat(40)
  const fixed = 'c'.repeat(40)
  const rows = [
    JSON.stringify({ id: 41, label: 'review flow#30 P14 tokens', state: 'closed' }),
    JSON.stringify({ id: 42, label: 'ggf P15 infra sync prod: pre-flight', state: 'open', verdict: '', review: { head, norms: 'tool', at: '2026-11-03T16:03:31Z', fixed: { head: fixed, at: '2026-11-03T16:37:39Z' } }, surface: { kind: 'none', pr: '', reason: '', at: '2026-11-03T16:03:31Z' } }),
    JSON.stringify({ id: 46, label: 'ggf P16 release in conflict with main', state: 'open', verdict: '' }),
  ].join('\n') + '\n'
  const deck = deckOf([orchestrator('Orch: flow', 'acme/flow')])
  const w = world({ rows, deck, round: [], todo: '' })
  writeFileSync(`${w.record}.owner`, '')
  const config = join(dir, 'config')
  mkdirSync(join(config, 'sessions'), { recursive: true })
  writeFileSync(join(config, 'sessions', '7.json'), '{"sessionId":"s-flow","name":"Orch: flow [a1b2c3]","updatedAt":9}')
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 's-flow' }
  const forge: Record<string, { repo: string; pr: number; head: string }[]> = {
    'acme/flow': [{ repo: 'acme/flow', pr: 31, head: fixed }, { repo: 'acme/flow', pr: 40, head: 'd'.repeat(40) }],
  }
  const asked: string[] = []
  const takeover = (openPrs?: (repo: string) => { repo: string; pr: number; head: string }[] | undefined) => {
    w.out.length = 0
    const code = main(['takeover', w.record, '--mode', 'build'], env, { out: t => { w.out.push(t) }, err: t => { w.err.push(t) } }, {
      cwd: dir, list: () => undefined, now: () => NOW, prState: () => undefined, openPrs: openPrs ?? (repo => { asked.push(repo); return forge[repo] ?? [] }),
    })
    return { code, text: w.text() }
  }
  return { w, takeover, asked, record: w.record, env }
}

test('a record that names no pull request on its row: the open pull request it holds is found by the head its review recorded, and its row is owned', () => {
  const f = flowWorld()
  const { code, text } = f.takeover()
  assert.equal(code, 0)
  assert.match(text, /- Pull requests open \(number, head, where each stands\): acme\/flow#31 open, no agent\n/)
  assert.match(text, /- Row owners: 42 acme\/flow#31 open, no agent; 46 NO OWNER\n/)
  assert.deepEqual(f.asked, ['acme/flow'])
  assert.match(f.w.err.join(''), /takeover: .* prs=1 /)
})

test('an owner file that names no orchestration falls back to the session\'s own orchestration, the reference left off; the command line still wins', () => {
  const f = flowWorld()
  const { code, text } = f.takeover()
  assert.equal(code, 0)
  assert.ok(text.includes('You are the SUCCESSOR ORCHESTRATOR of `Orch: flow`.'))
  writeFileSync(`${f.record}.owner`, 'a hand-written note\n')
  assert.ok(f.takeover().text.includes('of `Orch: flow`.'))
  f.w.out.length = 0
  assert.equal(main(['takeover', f.record, '--mode', 'build', '--name', 'Orch: other'], f.env, { out: t => { f.w.out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => NOW, prState: () => undefined, openPrs: () => [] }), 0)
  assert.ok(f.w.text().includes('of `Orch: other`.') && !f.w.text().includes('of `Orch: flow`.'))
})

test('a short repository name two known repositories share names no pull request, and a head matches by its prefix in either direction, never under seven characters', () => {
  const full = 'e'.repeat(40)
  const rows = [
    JSON.stringify({ id: 1, label: 'AMBIG flow#5 two flows', state: 'open' }),
    JSON.stringify({ id: 2, label: 'SHORT: recorded abbreviated', state: 'open', review: { head: full.slice(0, 9) } }),
    JSON.stringify({ id: 3, label: 'LONG: recorded longer than the forge', state: 'open', review: { head: 'f'.repeat(40) } }),
    JSON.stringify({ id: 4, label: 'TINY: too short to tell', state: 'open', review: { head: 'ddd' } }),
    JSON.stringify({ id: 5, label: 'SURFACE: named there', state: 'open', surface: { kind: 'x', pr: 'acme/flow#6' } }),
    JSON.stringify({ id: 6, label: 'AGENT: api has it', state: 'open', note: 'Dispatched: Agent: agent', surface: { kind: 'x', pr: 'acme/flow#6' } }),
  ].join('\n') + '\n'
  const deck = deckOf([orchestrator(NAME, 'acme/flow', [], ['Agent: agent'])])
  const w = world({ rows, deck, round: [], todo: '' })
  writeFileSync(join(w.briefs, 'second.jsonl'), '')
  writeFileSync(w.record, `${readFileSync(w.record, 'utf8')}${ledger('beta/flow', 8, 'Agent: other')}\n`)
  const forge: Record<string, { repo: string; pr: number; head: string }[]> = {
    'acme/flow': [{ repo: 'acme/flow', pr: 5, head: '1'.repeat(40) }, { repo: 'acme/flow', pr: 6, head: '2'.repeat(40) }, { repo: 'acme/flow', pr: 7, head: full }, { repo: 'acme/flow', pr: 9, head: 'f'.repeat(12) }, { repo: 'acme/flow', pr: 10, head: 'ddd0000' }],
    'beta/flow': [],
  }
  const out: string[] = []
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }
  assert.equal(main(['takeover', w.record, '--mode', 'build'], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => NOW, prState: () => undefined, openPrs: repo => forge[repo] }), 0)
  assert.match(out.join(''), /- Row owners: 1 NO OWNER; 2 acme\/flow#7 open, no agent; 3 acme\/flow#9 open, no agent; 4 NO OWNER; 5 acme\/flow#6 open, no agent; 6 agent\n/)
})

test('a row\'s pull request named in its label by a short or a full repository, and the ledger\'s word on it; a repository the forge cannot read is said', () => {
  const rows = [
    JSON.stringify({ id: 1, label: 'FIX flow#30 tokens', state: 'open' }),
    JSON.stringify({ id: 2, label: 'LATER acme/site#7 footer', state: 'open' }),
    JSON.stringify({ id: 3, label: 'NOTE other#9 not a known repository', state: 'open' }),
    ledger('acme/flow', 30, 'Agent: tokens'),
  ].join('\n') + '\n'
  const deck = deckOf([orchestrator(NAME, 'acme/flow')])
  const w = world({ rows, deck, round: [], todo: '' })
  const out: string[] = []
  const forge = (repo: string) => (repo === 'acme/flow' ? [{ repo, pr: 30, head: 'a'.repeat(40) }] : undefined)
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }
  assert.equal(main(['takeover', w.record, '--mode', 'build'], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => NOW, prState: () => undefined, openPrs: forge }), 0)
  const text = out.join('')
  assert.match(text, /- Row owners: 1 acme\/flow#30 en cours \(agent Agent: tokens\); 2 NO OWNER; 3 NO OWNER\n/)
  assert.match(text, /- Pull requests open \(number, head, where each stands\): acme\/flow#30 en cours \(agent Agent: tokens\); acme\/site open pull requests unread\n/)
})

test('a blocker still standing keeps its word over an open pull request the row names, and a ledger line for a pull request the forge no longer lists owns nothing', () => {
  const rows = [
    JSON.stringify({ id: 1, label: 'DOCS: after flow#30', state: 'open', blocker: 'PR acme/flow#30 merged' }),
    JSON.stringify({ id: 2, label: 'FIX acme/flow#31 merged since', state: 'open' }),
    ledger('acme/flow', 31, 'Agent: gone'),
  ].join('\n') + '\n'
  const deck = deckOf([orchestrator(NAME, 'acme/flow')])
  const w = world({ rows, deck, round: [], todo: '', prs: { 'acme/flow#30': 'OPEN' } })
  const out: string[] = []
  const env = { ORCHESTRATOR_STATE_DIR: w.state, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }
  assert.equal(main(['takeover', w.record, '--mode', 'build'], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, list: () => undefined, now: () => NOW, prState: () => 'OPEN', openPrs: () => [{ repo: 'acme/flow', pr: 30, head: 'a'.repeat(40) }] }), 0)
  assert.match(out.join(''), /- Row owners: 1 blocked: PR acme\/flow#30 merged; 2 NO OWNER\n/)
})

test('an owner file that names none says on stderr that the session\'s own name stands in', () => {
  const f = flowWorld()
  f.takeover()
  assert.ok(f.w.err.some(line => line.includes('names no orchestration, using this session\'s: Orch: flow')))
})

// The takeover carries the meaning of what he said, never his words: they stay in the round and the to-do list, named by id.

test('an answer its asker already received is not printed; one still to apply is one line under its round id, its letter or first sentence', () => {
  const answer = (text: string, by: string, over: Record<string, unknown> = {}) => ({ answer: { text, by, at: '2026-11-15T09:00:00.000Z', settler: 'Coord: general' }, ...over })
  const asked = (id: string, subject: string, over: Record<string, unknown>) => storedAsk(id, 'answered', { subject, ...over })
  const w = world({ round: [
    asked('q-tab', 'typed in the tab', answer('A', 'tab')),
    asked('q-sent', 'delivered answer', answer('B', 'coordinator', { delivery: { state: 'delivered', at: '2026-11-15T09:01:00.000Z', attempts: 1 } })),
    asked('q-late', 'pending answer', answer('C — his words: « a very long justification of the choice, given at length »', 'coordinator', { delivery: { state: 'pending', at: '2026-11-15T09:01:00.000Z', attempts: 1 } })),
    asked('q-said', 'free answer', answer('Yes, apply it everywhere. Then drop the old guard and tell me when it is done.', 'coordinator')),
  ] })
  assert.equal(w.run(), 0)
  const text = w.text()
  assert.ok(text.includes('[q-late] pending answer: C\n'))
  assert.ok(text.includes('[q-said] free answer: Yes, apply it everywhere.\n'))
  assert.ok(!text.includes('q-tab') && !text.includes('q-sent') && !text.includes('very long justification') && !text.includes('drop the old guard'))
  const entries = [...texts(asked('q-1', 'x', answer('A', 'tab')), asked('q-2', 'y', answer('B', 'coordinator'))), 'not json']
  assert.deepEqual(toApply(roundSettled(entries, [], NAME, SESSION).answered, entries).map(q => q.id), ['q-2'])
})

test('an answer is its letter when it opens on one, else its first sentence cut short, without a quotation of his', () => {
  assert.equal(answerMeaning('B'), 'B')
  assert.equal(answerMeaning('B — his words: « Non, à tout de suite »'), 'B')
  assert.equal(answerMeaning('Accorder (A)'), 'Accorder (A)')
  assert.equal(answerMeaning('Oui, j\'accorde 1.0 ce soir. Le reste attend.'), 'Oui, j\'accorde 1.0 ce soir.')
  // A free sentence opening on one capital word is no choice; a dash inside it keeps its condition.
  assert.equal(answerMeaning('I think we should wait for the review.'), 'I think we should wait for the review.')
  assert.equal(answerMeaning('A few of them are fine. Others not.'), 'A few of them are fine.')
  assert.equal(answerMeaning('Oui — mais plus tard'), 'Oui — mais plus tard')
  assert.equal(answerMeaning('e.g. foo. Bar'), 'e.g. foo.')
  assert.equal(answerMeaning('C.'), 'C')
  assert.equal(answerMeaning('« only a quote »'), '')
  assert.ok(answerMeaning('x'.repeat(400)).length <= 120)
})

test('a row\'s ruling and note are one line, his quotation replaced by the id of the round entry or to-do item that holds it', () => {
  const holders = [{ id: 'q-9', text: 'Q5 à Q8 reprises quand la télémétrie atteint 14 jours' }, { id: 'to-do 15', text: 'the context at a session\'s birth becomes a drift signal' }]
  assert.equal(oneLine('ruled « Q5 à Q8,  reprises quand la télémétrie » (estimated 11-28)', holders), 'ruled « … » (estimated 11-28)')
  assert.equal(oneLine('ruled « Q5 à Q8 reprises quand la télémétrie »\nthen wait', holders), 'ruled [words: q-9] then wait')
  assert.equal(oneLine('see « the Context at a session\'s birth » now', holders), 'see [words: to-do 15] now')
  assert.equal(oneLine('see « … » and « ok »', holders), 'see « … » and « … »')
  assert.equal(oneLine('plain note', holders), 'plain note')
  assert.ok(oneLine('word '.repeat(100), holders).length <= 200)
  // A cut never lands inside the id token.
  assert.ok(!oneLine(`${'w'.repeat(190)} « Q5 à Q8 reprises quand la télémétrie »`, holders).includes('[words:'))
  assert.ok(oneLine(`${'w'.repeat(150)} « Q5 à Q8 reprises quand la télémétrie »`, holders).endsWith('[words: q-9]'))
  const rows = openRows([{ id: 7, label: 'X: y', state: 'open', deferred: 'ruling « Q5 à Q8 reprises quand la télémétrie »', note: 'Dispatched: Agent: api « Q5 à Q8 reprises quand la télémétrie »' }], holders)
  assert.match(rows[0]?.line ?? '', /^deferred=7 label=X: y ruling=ruling \[words: q-9\] note=Dispatched: Agent: api \[words: q-9\]$/)
  // What owners are read from stays whole: the printed line is the only one shortened.
  assert.equal(rows[0]?.note, 'Dispatched: Agent: api « Q5 à Q8 reprises quand la télémétrie »')
  assert.equal(rows[0]?.ruling, 'ruling « Q5 à Q8 reprises quand la télémétrie »')
})

test('in the takeover a row\'s quotation of his words names the round entry that holds them', () => {
  const said = 'Je veux le brief de reprise léger, pas de garde sur sa taille'
  const w = world({
    rows: [JSON.stringify({ id: 1, label: 'LIGHT: brief', state: 'open', blocker: 'none', note: `his C: « ${said} »` })].join('\n') + '\n',
    round: [storedAsk('q-held', 'answered', { answer: { text: said, by: 'tab', at: '2026-11-15T09:00:00.000Z', settler: NAME } })],
  })
  assert.equal(w.run(), 0)
  assert.ok(w.text().includes('note=his C: [words: q-held]'))
  assert.ok(!w.text().includes('pas de garde'))
})

test('a note several rows share is printed once, naming the rows; a note one row holds stays on its row', () => {
  const row = (id: number, note: string) => ({ id, label: `R${id}: x`, state: 'open', note })
  const lines = rowLines(openRows([row(1, 'after the report (row 9)'), row(2, 'own note'), row(3, 'after the report (row 9)'), row(4, 'after the  report (row 9)')]))
  assert.deepEqual(lines, ['open=1 label=R1: x', 'open=2 label=R2: x note=own note', 'open=3 label=R3: x', 'open=4 label=R4: x', 'note of rows 1, 3, 4: after the report (row 9)'])
  // Notes that differ only past the cap, or only in their unresolved quotations, are not one note.
  const long = rowLines(openRows([row(1, `${'x'.repeat(250)}A`), row(2, `${'x'.repeat(250)}B`), row(3, 'see « one »'), row(4, 'see « two »'), row(5, '  ')]))
  assert.ok(long.every(line => !line.startsWith('note of rows')))
  assert.ok(long[4] === 'open=5 label=R5: x')
  const w = world({ rows: [row(1, 'shared-ruling-text'), row(2, 'shared-ruling-text'), row(3, 'other')].map(r => JSON.stringify(r)).join('\n') + '\n' })
  assert.equal(w.run(), 0)
  assert.equal(w.text().split('shared-ruling-text').length - 1, 1)
  assert.ok(w.text().includes('note of rows 1, 2: shared-ruling-text'))
  assert.deepEqual(ownersOf({ rows: openRows([row(1, 'Agent: api'), row(2, 'Agent: api')]), prs: [], agents: ['Agent: api'], questions: [] }), ['1 api', '2 api'])
})

test('the project line prints the objective\'s first sentence and the goals count, without the history behind it', () => {
  assert.equal(objectiveOf('the belt 1.0 declared on 2026-11-15 if its figures are in target (his ruling of 2026-11-15T07:00Z). An early reading leaves time to act. The drift goals G1-G5 are archived.'), 'the belt 1.0 declared on 2026-11-15 if its figures are in target (his ruling of 2026-11-15T07:00Z)')
  assert.equal(objectiveOf('a belt that holds.'), 'a belt that holds')
  assert.equal(objectiveOf(''), '')
  const w = world({ goals: '# Goals\nspec: /s.md\naim: ship the belt. It was first planned in March. G1-G5 are in the archive.\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | met | a | p1 | |\n| G2 | open | b | p2 | |\n' })
  assert.equal(w.run(), 0)
  assert.match(w.text(), /- Project: objective ship the belt; spec \/s\.md; goals met=1\/2 open=G2 \(plan: p2\)\n/)
})

test('fill leaves a line out whose optional placeholder is empty, and keeps it filled otherwise', () => {
  assert.equal(fill('a\n- list: {{X?}}\nb\n', { X: '' }), 'a\nb\n')
  assert.equal(fill('a\n- list: {{X?}}\nb\n', {}), 'a\nb\n')
  assert.equal(fill('a\n- list: {{X?}}\nb\n', { X: 'x' }), 'a\n- list: x\nb\n')
  assert.equal(fill('a {{Y}}', { Y: '' }), 'a ')
})

test('a quotation a to-do item holds is named by its item through the takeover; answers all applied leave no answered section', () => {
  const said = 'Je veux que le contexte à la naissance devienne un signal de dérive'
  const item = { ...JSON.parse(todo(15, [1])), words: said }
  const w = world({
    rows: JSON.stringify({ id: 1, label: 'DRIFT: signal', state: 'open', blocker: 'none', note: `to-do words « ${said} »` }) + '\n',
    todo: JSON.stringify(item) + '\n',
    round: [storedAsk('q-1', 'answered'), storedAsk('q-2', 'answered', { answer: { text: 'A', by: 'tab', at: '2026-11-15T09:00:00.000Z', settler: NAME } })],
  })
  assert.equal(w.run(), 0)
  assert.ok(w.text().includes('note=to-do words [words: to-do 15]'))
  assert.ok(!w.text().includes('naissance') && !w.text().includes('Questions the operator answered'))
})
