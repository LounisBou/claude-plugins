import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deckOpen, fallOf, fill, main, notInstalled, ownersOf, parseArgs, projectOf, projectSheet, roundOpen, TEMPLATE, todoStray, type Artifacts } from './succession.ts'

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

/** A machine whose state holds open what an orchestration in flight holds, and no succession brief anywhere. */
function world(over: { rows?: string; deck?: object; round?: object[]; todo?: string; goals?: string | null; prs?: Record<string, string> } = {}) {
  const state = join(dir, 'state')
  const briefs = join(dir, 'briefs', 'belt')
  mkdirSync(join(state, 'round'), { recursive: true })
  mkdirSync(join(state, 'todo'), { recursive: true })
  mkdirSync(briefs, { recursive: true })
  const record = join(briefs, 'dispatch-record.jsonl')
  writeFileSync(record, over.rows ?? [
    JSON.stringify({ id: 1, label: 'SCHEMA: tables', state: 'closed' }),
    JSON.stringify({ id: 2, label: 'API: routes', state: 'open' }),
    JSON.stringify({ id: 3, label: 'UI: pages', state: 'open', deferred: 'ruling 4' }),
    JSON.stringify({ id: 4, label: 'DOCS: guide', state: 'open', blocker: 'row 1 closed', note: 'start from the old guide' }),
    JSON.stringify({ id: 5, label: 'PERF: cache', state: 'open', blocker: 'PR acme/app#12 merged' }),
    JSON.stringify({ id: 6, label: 'LINT: rules', state: 'open', blocker: 'row 2 closed' }),
    ledger('acme/app', 12, 'Agent: pr'),
  ].join('\n') + '\n')
  writeFileSync(`${record}.owner`, `${NAME}\n`)
  writeFileSync(join(briefs, 'rulings.md'), '# Rulings\n\n- 2026-11-14T09:00:00Z « Keep it short. » — every brief. [standing]\n- 2026-11-14T09:30:00Z « Merge it. » — row 1. [done: acme/app#11]\n- 2026-11-14T09:40:00Z « The docs first. » — row 4. [for: row 4]\n')
  rmSync(join(briefs, 'goals.md'), { force: true })
  if (over.goals !== null) writeFileSync(join(briefs, 'goals.md'), over.goals ?? '# Goals\nspec: /specs/belt.md\nrepo: /w\naim: a belt that holds\n\n| id | status | goal | plan | evidence |\n|---|---|---|---|---|\n| G1 | met | tables | phase 1 | pr:acme/app#11 |\n| G2 | open | routes | phase 2 | |\n')
  writeFileSync(join(state, 'deck.json'), JSON.stringify(over.deck ?? {
    version: 3,
    orchestrators: [
      { name: NAME, machine: null, prs: ['acme/other#99'], agents: [{ name: 'Agent: api' }] },
      { name: 'Orch: other', machine: null, prs: ['acme/site#7'], agents: [{ name: 'Agent: site' }] },
    ],
  }))
  for (const entry of over.round ?? [
    { id: 'q-2', session: SESSION, from: NAME, kind: 'operator', status: 'open', question: '**Question 1 of 1**\nWhich schema?' },
    { id: 'q-1', session: SESSION, from: NAME, kind: 'operator', status: 'answered', question: 'Done?' },
    { id: 'q-3', session: 'other', from: 'Orch: other', kind: 'operator', status: 'open', question: 'Not ours' },
  ]) writeFileSync(join(state, 'round', `${(entry as { id: string }).id}.json`), JSON.stringify(entry))
  writeFileSync(join(state, 'todo', `${NAME}.jsonl`), over.todo ?? [todo(1, [2, 4]), todo(2, [1]), todo(3, [9]), todo(4, [1], 'closed'), todo(5, undefined)].join('\n') + '\n')
  const env = { ORCHESTRATOR_STATE_DIR: state, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }
  const out: string[] = []
  const err: string[] = []
  const io = { out: (t: string) => { out.push(t) }, err: (t: string) => { err.push(t) } }
  const prs = over.prs ?? { 'acme/app#12': 'MERGED' }
  const run = (...argv: string[]) => main(['takeover', record, '--mode', 'build', ...argv], env, io, { cwd: dir, now: () => NOW, prState: (repo, pr) => prs[`${repo}#${pr}`] })
  return { state, briefs, record, out, err, run, text: () => out.join('') }
}

test('takeover prints the fixed instructions filled from the state, and writes no brief', () => {
  const w = world()
  assert.equal(w.run('--tty', '/dev/ttys009'), 0)
  const text = w.text()
  assert.ok(text.startsWith('# Orchestrator succession brief — belt\n\nMode: build\n'))
  assert.ok(text.includes('You are the SUCCESSOR ORCHESTRATOR of `Orch: belt`.'))
  assert.ok(text.includes('nothing more unless it lists open or deferred goals: then, in'))
  assert.ok(text.includes(`dispatch-record.sh goals ${w.record} status | grep -v '| met |'`))
  assert.ok(text.includes(`grep -v '\\[for: ' ${join(w.briefs, 'rulings.md')}\``))
  assert.match(text, /iterm-agents\/scripts\/iterm-agent\.sh close --tty \/dev\/ttys009 --expect-title "Orch: belt"/)
  assert.ok(text.includes('`workspace.sh list belt`'))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'every placeholder filled')
  // Nothing about it is written beside the record: the brief is the output, never a file.
  assert.deepEqual(['succession-brief.md', 'state.md'].filter(f => existsSync(join(w.briefs, f))), [])
})

test('the Live state: the open rows at level 1, their owners by agent, ruling or blocker, the ledger, the agents, the questions', () => {
  const w = world()
  assert.equal(w.run(), 0)
  const text = w.text()
  assert.match(text, /- Rows open \(id, label, what remains\): open=2 label=API: routes; deferred=3 label=UI: pages ruling=ruling 4; open=4 label=DOCS: guide blocker=row 1 closed note=start from the old guide; open=5 label=PERF: cache blocker=PR acme\/app#12 merged; open=6 label=LINT: rules blocker=row 2 closed\n/)
  assert.match(text, /- Row owners: 2 api; 3 ruling; 4 READY NOT STARTED; 5 READY NOT STARTED; 6 blocked: row 2 closed\n/)
  assert.match(text, /- Pull requests open \(number, head, where each stands\): acme\/app#12 en cours \(agent Agent: pr\)\n/)
  assert.match(text, /- Agents running \(name and reference, brief path\): Agent: api\n/)
  assert.ok(text.includes('[q-2] **Question 1 of 1**\nWhich schema?'))
  assert.ok(!text.includes('q-1') && !text.includes('q-3') && !text.includes('acme/site#7') && !text.includes('Agent: site'))
  assert.match(w.err.join(''), /^takeover: chars=[0-9]+ rulings_read=[0-9]+ rows=5 ready=2 prs=1 agents=1 questions=1 todo_stray=2 pruned=rulings:1,round:0\n$/)
})

test('takeover moves a ruling for rows the dispatch record closed, and keeps one for a row still open', () => {
  const w = world()
  const rulings = join(w.briefs, 'rulings.md')
  writeFileSync(rulings, [
    '- 2026-11-12T10:00:00Z « A » → the schema. [for: row 1]',
    '- 2026-11-12T11:00:00Z « B » → the api. [for: rows 1, 2]', '',
  ].join('\n'))
  assert.equal(w.run(), 0)
  assert.match(w.err.join(''), / pruned=rulings:1,round:0\n$/)
  assert.ok(readFileSync(rulings, 'utf8').includes('the api') && !readFileSync(rulings, 'utf8').includes('the schema'))
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
  assert.match(w.err.join(''), / pruned=rulings:1,round:2\n$/)
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'q-answered.json')))
  assert.ok(existsSync(join(w.state, 'round', 'archive', 'withdrawn', 'q-withdrawn.json')))
  assert.ok(existsSync(join(w.state, 'round', 'q-open.json')))
})

test('takeover says a supersession it keeps', () => {
  const w = world()
  const rulings = join(w.briefs, 'rulings.md')
  writeFileSync(rulings, '- 2026-11-12T16:00:00Z « C » → x. [superseded: 2026-12-01T00:00:00Z]\n')
  assert.equal(w.run(), 0)
  assert.ok(w.err.includes(`succession: ${rulings}: ruling 2026-11-12T16:00:00Z kept: superseded by 2026-12-01T00:00:00Z, which no ruling of the file or its archive opens on\n`))
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
})

test('the rulings carried out move to the archive before the print; the ones for an open row stay, out of what is read', () => {
  const w = world()
  assert.equal(w.run(), 0)
  const rulings = readFileSync(join(w.briefs, 'rulings.md'), 'utf8')
  assert.ok(!rulings.includes('Merge it.') && rulings.includes('The docs first.'))
  assert.match(readFileSync(join(w.briefs, 'rulings-archive.md'), 'utf8'), /« Merge it\. »/)
})

test('the name is the record\'s owner unless given; a record without one, or none at all, is refused', () => {
  const w = world()
  rmSync(`${w.record}.owner`)
  assert.equal(w.run(), 2)
  assert.match(w.err.at(-1) ?? '', /names no orchestration: pass --name/)
  assert.equal(w.run('--name', NAME), 0)
  assert.equal(main(['takeover', join(dir, 'none.jsonl'), '--mode', 'build'], {}, { out: () => {}, err: t => { w.err.push(t) } }, { cwd: dir, now: () => NOW }), 2)
  assert.match(w.err.at(-1) ?? '', /no dispatch record at/)
})

test('the command line: takeover, a record and the mode, flags checked', () => {
  assert.deepEqual(parseArgs(['takeover', 'r.jsonl', '--mode', 'investigate', '--tty', '/dev/ttys1'], '/w'), { record: '/w/r.jsonl', mode: 'investigate', tty: '/dev/ttys1', name: '', session: '', worktree: '/w' })
  assert.match((parseArgs(['live', 'b.md'], '/w') as { error: string }).error, /^usage:/)
  assert.match((parseArgs(['takeover'], '/w') as { error: string }).error, /^usage:/)
  assert.match((parseArgs(['takeover', 'r', '--mode', 'other'], '/w') as { error: string }).error, /--mode build\|investigate is required/)
  assert.match((parseArgs(['takeover', 'r', '--mode'], '/w') as { error: string }).error, /--mode needs a value/)
  assert.match((parseArgs(['takeover', 'r', '--next', 'x'], '/w') as { error: string }).error, /unknown argument: --next/)
  const w = world()
  assert.equal(main(['takeover', w.record], {}, { out: () => {}, err: t => { w.err.push(t) } }, { cwd: dir, now: () => NOW }), 2)
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

test('ownersOf names each open row\'s live agent by its label word, a deferred row\'s ruling, its fallen or standing blocker, and flags a row with none recorded', () => {
  const rows = [
    { id: '1', line: '', label: 'TAKEOVERLEAN: a takeover reads less', blocker: 'none' },
    { id: '2', line: '', label: 'QREDESIGN PR4: remove the old path' },
    { id: '3', line: '', label: 'AUDIT: nobody works it' },
    { id: '4', line: '', label: 'LATER: parked', ruling: 'ruling 9', blocker: 'none' },
    { id: '5', line: '', label: 'A: one letter names nothing' },
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

test('todoStray reads the open items only, each row they name once against the record', () => {
  const rows = [{ id: 1, state: 'closed' }, { id: 2, state: 'open' }]
  assert.deepEqual(todoStray([todo(1, [1, 2, 3]), todo(2, [1], 'closed'), 'torn line'].join('\n'), rows), ['to-do 1 → row 1 closed', 'to-do 1 → row 3 missing'])
  assert.deepEqual(todoStray('', rows), [])
})

test('the deck and the round are read as data: a remote orchestrator, a malformed file, none', () => {
  assert.deepEqual(deckOpen(undefined, NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen('not json', NAME), { prs: [], agents: [] })
  assert.deepEqual(deckOpen(JSON.stringify({ orchestrators: [{ name: NAME, machine: 'mini', prs: ['a#1'] }] }), NAME), { prs: [], agents: [] })
  assert.deepEqual(roundOpen([undefined, { id: 'a', from: NAME, kind: 'operator', status: 'open' }], NAME, SESSION), [{ id: 'a', text: '' }])
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
  assert.equal(main(['takeover', w.record, '--mode', 'build', '--worktree', i.repo], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, now: () => new Date(i.merged.getTime() + 3_600_000), prState: () => undefined }), 0)
  assert.ok(out.join('').startsWith('# Orchestrator succession brief — acme/belt\n'))
  assert.match(out.join(''), /- Row owners: 1 blocked: release installed\n/)
  assert.match(out.join(''), /; installed: 1 merged PRs not installed, oldest 1 h\n/)
  const tip = execFileSync('git', ['-C', i.repo, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
  writeFileSync(join(i.env['CLAUDE_CONFIG_DIR'] ?? '', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'orchestrator@acme': [{ gitCommitSha: tip }] } }))
  out.length = 0
  assert.equal(main(['takeover', w.record, '--mode', 'build', '--worktree', i.repo], env, { out: t => { out.push(t) }, err: () => {} }, { cwd: dir, now: () => NOW, prState: () => undefined }), 0)
  assert.match(out.join(''), /- Row owners: 1 READY NOT STARTED\n/)
})
