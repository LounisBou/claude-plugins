import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { lint } from './brief-lint.ts'
import { rowOfBrief } from './succession.ts'
import { citedSections, main, NOTES_CAP, parseArgs, previousReport, rotateLine, sectionOf, slug, TEMPLATES, tierOf, todoLines, type Deps } from './brief.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ORCH = 'Orch: belt [a1b2c3]'

function world(gitOut: Record<string, string> = {}) {
  const state = join(dir, 'state')
  const briefs = join(dir, 'briefs')
  const worktree = join(dir, 'ws')
  mkdirSync(join(state, 'todo'), { recursive: true })
  mkdirSync(briefs, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  const record = join(briefs, 'dispatch-record.jsonl')
  writeFileSync(record, [
    JSON.stringify({ id: 1, label: 'SCHEMA: tables', state: 'closed', tier: 'standard' }),
    JSON.stringify({ id: 2, label: 'API: routes', state: 'open', tier: 'standard', note: 'reuse the router' }),
    JSON.stringify({ id: 3, label: 'UI', state: 'open', tier: '', model: 'big', effort: 'high' }),
  ].join('\n') + '\n')
  const spec = join(dir, 'spec.md')
  writeFileSync(spec, '# Spec\n')
  writeFileSync(join(briefs, 'goals.md'), `# Goals\nspec: ${spec}\n`)
  const plan = join(dir, 'phase-02.md')
  writeFileSync(plan, '# Phase 2: the routes\n\nScope: routes.\n')
  const env = { ORCHESTRATOR_STATE_DIR: state, HOME: dir }
  const out: string[] = []
  const err: string[] = []
  const io = { out: (t: string) => { out.push(t) }, err: (t: string) => { err.push(t) } }
  const deps: Deps = { env, now: () => new Date('2026-11-15T12:00:00Z'), git: (_dir, args) => gitOut[args.join(' ')] }
  const run = (...argv: string[]) => main(argv, io, deps)
  const phase = (...extra: string[]) => run('phase', '--record', record, '--row', '2', '--plan', plan, '--worktree', worktree, '--branch', 'feat/routes',
    '--orchestrator', ORCH, '--out', join(briefs, 'routes.md'), '--repo', 'acme/app', ...extra)
  return { state, briefs, worktree, record, spec, plan, out, err, run, phase, text: () => out.join('') }
}

const lintOf = (text: string) => lint(text, { expected: [], shortNames: new Set(), exists: () => true })

// Seen 2026-11-15: a predecessor closed by the takeover never sent its successor's name, which the
// briefs made the only proof of a successor. The module now sends each agent of the chain the
// « [module] Your orchestrator is now … » line at the takeover's confirmation (hooks/tests/relay.test.ts),
// so no brief says how to tell a successor or how an orchestrator's message is addressed.
test('no agent brief teaches how to recognise an orchestrator\'s successor or its messages: the module names it', () => {
  const w = world({ 'rev-parse --short=12 origin/main': 'abc123def456' })
  assert.equal(w.phase(), 0)
  const phase = readFileSync(join(w.briefs, 'routes.md'), 'utf8')
  const templates = join(import.meta.dirname, '..', '..', '..', 'templates')
  const briefs = [['phase', phase], ...['review', 'comments', 'rotation'].map(kind => [kind, readFileSync(join(templates, `agent-${kind}-brief.md`), 'utf8')] as const)]
  for (const [what, text] of briefs) {
    assert.ok(!text.includes('carry its name alone') && !text.includes('carry the name alone'), `${what}: no rule on the name an orchestrator's messages carry`)
    assert.ok(!text.includes('lists no other session of that name'), `${what}: no rule on telling a successor`)
    assert.ok(!text.includes('Your orchestrator is now'), `${what}: the module's line is not described in a brief`)
  }
})

test('the row a takeover binds an agent to is read in the phase and rotation briefs as they are printed', () => {
  const w = world({ 'rev-parse --short=12 origin/main': 'abc123def456' })
  assert.equal(w.phase(), 0)
  assert.equal(rowOfBrief(readFileSync(join(w.briefs, 'routes.md'), 'utf8')), '2')
  assert.equal(rotation(w), 0)
  assert.equal(rowOfBrief(readFileSync(join(w.briefs, 'routes-r1.md'), 'utf8')), '2')
})

test('phase: the brief is printed from the row, the plan and the spec goals.md names, short, and passes its lint', () => {
  const w = world({ 'rev-parse --short=12 origin/main': 'abc123def456' })
  assert.equal(w.phase(), 0)
  const path = join(w.briefs, 'routes.md')
  assert.equal(w.text(), `phase brief: ${path}\nreport: ${join(w.briefs, 'report-routes.md')}\n`)
  const brief = readFileSync(path, 'utf8')
  assert.ok(brief.startsWith('# app — Phase 2: the routes\n'))
  for (const part of ['Mode: build\n', 'Row: 2 API: routes — note: reuse the router\n', `Spec: \`${w.spec}\`\n`, `Plan: \`${w.plan}\``, `Checkout: \`${w.worktree}\``,
    'Branch: `feat/routes`, from `origin/main`, which stood at abc123def456', 'Tier: standard\n', `Orchestrator: \`${ORCH}\``, `Report: ${join(w.briefs, 'report-routes.md')}\n`])
    assert.ok(brief.includes(part), `the brief holds ${part}`)
  assert.ok(!brief.includes('Scope from the orchestrator'))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief))
  assert.deepEqual(lintOf(brief), [])
  assert.ok(brief.length < 5000, `a short brief: ${brief.length} characters`)
})

test('phase: the scope, the mode, the base and the spec given replace what the state says', () => {
  const w = world()
  const spec = join(dir, 'other.md')
  writeFileSync(spec, 'x')
  assert.equal(w.phase('--scope', 'only the GET routes', '--mode', 'investigate', '--base', 'feat/schema', '--spec', spec, '--report', join(dir, 'r.md')), 0)
  const brief = readFileSync(join(w.briefs, 'routes.md'), 'utf8')
  for (const part of ['Mode: investigate\n', 'Scope from the orchestrator: only the GET routes\nCheckout:', 'from `feat/schema`, which stood at a head this command could not read', `Spec: \`${spec}\``, `Report: ${join(dir, 'r.md')}`])
    assert.ok(brief.includes(part), `the brief holds ${part}`)
})

test('phase: a row missing, closed, a plan or checkout absent, or no spec anywhere, is refused with its reason', () => {
  const w = world()
  const base = ['--plan', w.plan, '--worktree', w.worktree, '--branch', 'b', '--orchestrator', ORCH, '--out', join(w.briefs, 'x.md')]
  assert.equal(w.run('phase', '--record', w.record, '--row', '9', ...base), 2)
  assert.equal(w.run('phase', '--record', w.record, '--row', '1', ...base), 2)
  assert.equal(w.run('phase', '--record', join(dir, 'none.jsonl'), '--row', '2', ...base), 2)
  assert.equal(w.run('phase', '--record', w.record, '--row', '2', ...base.slice(2), '--plan', join(dir, 'none.md')), 2)
  assert.equal(w.run('phase', '--record', w.record, '--row', '2', '--plan', w.plan, '--worktree', join(dir, 'none'), ...base.slice(4)), 2)
  writeFileSync(join(w.briefs, 'goals.md'), '# Goals\n')
  assert.equal(w.run('phase', '--record', w.record, '--row', '2', ...base), 2)
  assert.deepEqual(w.err.map(line => line.replace(/ at \S+| in \S+| beside \S+/, '')), [
    'brief: phase: row 9 is not\n', 'brief: phase: row 1 is not open\n', 'brief: phase: no dispatch record\n', 'brief: phase: no plan file\n',
    'brief: phase: no checkout\n', 'brief: phase: --spec is required: no goals.md names one\n',
  ])
})

test('phase with --phase: the brief names the plan\'s section and the spec\'s sections it cites, by heading and lines, never the whole files', () => {
  const w = world({ 'rev-parse --short=12 origin/main': 'abc123def456' })
  writeFileSync(w.plan, '# Plan\n\n## P1 schema\n\nTables.\n\n## P2 routes\n\nBuild the routes of §3.2 and §4.\n\n### P2 tasks\n\n- [ ] GET\n\n## P3 pages\n\nPages, §5.\n')
  writeFileSync(w.spec, '# Spec\n\n## 3 API\n\n### 3.2 Routes\n\nThe routes.\n\n## 4. Errors\n\nCodes.\n\n## 5 Pages\n')
  assert.equal(w.phase('--phase', 'P2 routes'), 0)
  const brief = readFileSync(join(w.briefs, 'routes.md'), 'utf8')
  assert.ok(brief.startsWith('# app — P2 routes\n'))
  assert.ok(brief.includes(`Plan: \`${w.plan}\`, section « ## P2 routes », lines 7–13 — its scope`))
  assert.ok(brief.includes(`Spec: \`${w.spec}\`, section « ### 3.2 Routes », lines 5–7; section « ## 4. Errors », lines 9–11\n`))
  assert.ok(brief.includes('Read the plan\'s section and the spec\'s sections above, the repository'))
  assert.deepEqual(lintOf(brief), [])
  assert.equal(w.phase('--phase', 'P9'), 2)
  assert.match(w.err.join(''), /no heading of \S+ holds « P9 »/)
  // A section that cites nothing names the spec whole, to be read by the sections it names.
  writeFileSync(w.plan, '# Plan\n\n## P2 routes\n\nRoutes.\n')
  assert.equal(w.phase('--phase', 'P2'), 0)
  assert.ok(readFileSync(join(w.briefs, 'routes.md'), 'utf8').includes('Read the plan\'s section above, the spec by the sections it names, the repository'))
  assert.equal(sectionOf('no heading', 'x'), undefined)
  assert.deepEqual(citedSections('§7', '# none'), [])
})

/** The rotation of row 2: its checkout's git as given, the plan, the old agent's report. */
function rotation(w: ReturnType<typeof world>, ...extra: string[]): number {
  const phaseBrief = join(w.briefs, 'routes.md')
  writeFileSync(phaseBrief, '# brief\n')
  return w.run('rotation', '--record', w.record, '--row', '2', '--phase-brief', phaseBrief, '--worktree', w.worktree, '--orchestrator', ORCH,
    '--tty', '/dev/ttys012', '--title', 'Agent: api routes', '--out', join(w.briefs, 'routes-r1.md'), '--repo', 'acme/app', ...extra)
}

test('rotation: the resume brief is printed from the row and git, with the open items of the plan, and the rotate line is said', () => {
  const w = world({
    'rev-parse --abbrev-ref HEAD': 'feat/routes', 'rev-parse --short=12 origin/main': 'abc123def456', 'rev-parse --short=12 HEAD': 'fed321fed321',
    'log --oneline --no-decorate origin/main..HEAD': 'fed321f feat: GET routes\n1111111 feat: router', 'status --porcelain': 'M src/routes.ts',
  })
  writeFileSync(w.plan, '# Plan\n\n## P2 routes\n\n- [x] router\n- [ ] GET\n- [ ] POST\n\n## P3\n\n- [ ] pages\n')
  writeFileSync(w.record, readFileSync(w.record, 'utf8').replace('"note":"reuse the router"', '"note":"reuse the router","review":{"head":"fed321fed321","verdict":{"head":"fed321fed321aaaa","result":"fail","words":"two findings"}}'))
  const report = join(w.briefs, 'report-routes.md')
  writeFileSync(report, 'old report')
  assert.equal(rotation(w, '--plan', w.plan, '--phase', 'P2 routes', '--report', report, '--in-flight', 'POST handler half written, uncommitted', '--decisions', 'keep the router\'s error type'), 0)
  const path = join(w.briefs, 'routes-r1.md')
  assert.equal(w.text(), `rotation brief: ${path}\nreport: ${join(w.briefs, 'report-routes-r1.md')}\nrotate: ${rotateLine({ tty: '/dev/ttys012', worktree: w.worktree, title: 'Agent: api routes', out: path, orchestrator: ORCH })}\n`)
  assert.match(w.text(), /iterm-agent\.sh rotate --old-tty \/dev\/ttys012 --dir '[^']+' --title 'Agent: api routes' --brief '[^']+routes-r1\.md' --orchestrator 'Orch: belt \[a1b2c3\]' --right-of self\n$/)
  const brief = readFileSync(path, 'utf8')
  for (const part of ['# app — resume brief for row 2: API: routes\n', 'Branch: `feat/routes`, from `origin/main`, which stood at abc123def456 when this brief was printed; head fed321fed321.',
    'Landed since the base: \n  - fed321f feat: GET routes\n  - 1111111 feat: router\n', 'Uncommitted when printed: \n  - M src/routes.ts\n',
    'In flight, as the agent stood down said it: POST handler half written, uncommitted\n', 'Last gate: fail at fed321fed321 — two findings\n', `Last report of the agent replaced: \`${report}\`\n`,
    `The open items of \`${w.plan}\`, section « ## P2 routes », lines 3–7:\n  - GET\n  - POST\n\n`, 'keep the router\'s error type', 'Tier: standard\n', `**\`${ORCH}\`**`])
    assert.ok(brief.includes(part), `the brief holds ${part}`)
  assert.ok(!brief.includes('pages'))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief))
  assert.deepEqual(lintOf(brief), [])
})

test('rotation for an agent gone: nothing of its own, the brief says what git and the record hold', () => {
  const w = world()
  assert.equal(rotation(w), 0)
  const brief = readFileSync(join(w.briefs, 'routes-r1.md'), 'utf8')
  for (const part of ['Landed since the base: none\n', 'Uncommitted when printed: none\n', 'In flight, as the agent stood down said it: nothing said', 'Last gate: none recorded\n',
    'Last report of the agent replaced: none\n', 'the phase brief\'s plan, less what Landed lists.', 'none beyond the phase brief'])
    assert.ok(brief.includes(part), `the brief holds ${part}`)
  writeFileSync(w.plan, '# Phase 2\n\nRoutes.\n')
  assert.equal(rotation(w, '--plan', w.plan), 0)
  assert.ok(readFileSync(join(w.briefs, 'routes-r1.md'), 'utf8').includes(`\`${w.plan}\`, less what Landed lists.`))
  assert.equal(rotation(w, '--plan', join(dir, 'none.md')), 2)
  assert.equal(rotation(w, '--plan', w.plan, '--phase', 'P9'), 2)
  assert.equal(w.run('rotation', '--record', w.record, '--row', '2', '--phase-brief', join(dir, 'none.md'), '--worktree', w.worktree, '--orchestrator', ORCH, '--tty', 't', '--title', 'x', '--out', join(dir, 'o.md')), 2)
  assert.equal(w.run('rotation', '--record', w.record, '--row', '2', '--phase-brief', w.plan, '--worktree', join(dir, 'none'), '--orchestrator', ORCH, '--tty', 't', '--title', 'x', '--out', join(dir, 'o.md')), 2)
  assert.equal(w.run('rotation', '--record', w.record, '--row', '1', '--phase-brief', w.plan, '--worktree', w.worktree, '--orchestrator', ORCH, '--tty', 't', '--title', 'x', '--out', join(dir, 'o.md')), 2)
  assert.equal(rotateLine({ tty: 't', worktree: "/a b'c", title: 'T', out: '/o', orchestrator: 'O' }).split(' rotate ')[1], "--old-tty t --dir '/a b'\\''c' --title 'T' --brief '/o' --orchestrator 'O' --right-of self")
})

test('the command line: a flag unknown, a value missing, a relative path, a bad mode or row is refused', () => {
  assert.ok('error' in parseArgs([]))
  assert.ok('error' in parseArgs(['phase', '--nope', 'x']))
  assert.ok('error' in parseArgs(['phase', '--record']))
  assert.ok('error' in parseArgs(['coordinator-takeover', '--name', 'Coord: m']))
  assert.ok('error' in parseArgs(['auditor-takeover', '--name', 'a', '--tty', 't', '--report', 'rel.md', '--repository', '/r']))
  const phase = ['phase', '--record', '/r', '--plan', '/p', '--worktree', '/w', '--branch', 'b', '--orchestrator', 'o', '--out', '/o']
  assert.ok('error' in parseArgs([...phase, '--row', '2', '--mode', 'fix']))
  assert.ok('error' in parseArgs([...phase, '--row', 'two']))
  assert.deepEqual(parseArgs([...phase, '--row', '2']), { command: 'phase', fields: { record: '/r', plan: '/p', worktree: '/w', branch: 'b', orchestrator: 'o', out: '/o', row: '2' } })
})

test('the tier reads the row: its tier, else its model and effort, else the host default', () => {
  assert.equal(tierOf({ tier: 'deep' }), 'deep')
  assert.equal(tierOf({ tier: '', model: 'big', effort: 'high' }), 'model big, effort high')
  assert.equal(tierOf({ model: 'small' }), 'model small')
  assert.equal(tierOf({}), 'the host default')
})

test('audit: the brief names the previous report and starts at its date; the report is dated today', () => {
  const w = world()
  mkdirSync(join(w.briefs, 'audits'))
  writeFileSync(join(w.briefs, 'audits', '2026-10-01-cost.md'), 'old')
  writeFileSync(join(w.briefs, 'audits', '2026-11-02-cost.md'), 'newer')
  assert.equal(w.run('audit', '--subject', 'Cost of reviews', '--repository', w.worktree, '--briefs', w.briefs, '--kind', 'retrospective', '--words', 'what did it cost', '--question', 'Is the review worth it?'), 0)
  const path = join(w.briefs, 'audit-cost-of-reviews-brief.md')
  const report = join(w.briefs, 'audits', '2026-11-15-cost-of-reviews.md')
  assert.equal(w.text(), `audit brief: ${path}\nreport: ${report}\n`)
  const brief = readFileSync(path, 'utf8')
  for (const part of ['audit: Cost of reviews', 'Kind: retrospective', 'Question: Is the review worth it?', 'Established: nothing yet', 'since 2026-11-02:', `\`${join(w.briefs, 'audits', '2026-11-02-cost.md')}\``, `Write ${report} in`, TEMPLATES['auditor-takeover']])
    assert.ok(brief.includes(part), `the brief holds ${part}`)
  assert.deepEqual(lintOf(brief), [])
})

test('audit: with no previous report the start is the first commit, else --since', () => {
  const w = world({ 'rev-list --max-parents=0 HEAD': 'r00t', 'log -1 --format=%cs r00t': '2025-01-02' })
  assert.equal(previousReport(w.briefs), undefined)
  const args = ['audit', '--subject', 's', '--repository', w.worktree, '--briefs', w.briefs, '--kind', 'measure', '--words', 'w', '--question', 'q?']
  assert.equal(w.run(...args), 0)
  assert.ok(readFileSync(join(w.briefs, 'audit-s-brief.md'), 'utf8').includes('since 2025-01-02:'))
  assert.equal(w.run(...args, '--since', '2026-01-01'), 0)
  assert.ok(readFileSync(join(w.briefs, 'audit-s-brief.md'), 'utf8').includes('since 2026-01-01:'))
  assert.equal(slug('  !! '), 'audit')
})

test('auditor-takeover prints the succession from the report and the predecessor\'s to-do list', () => {
  const w = world()
  const report = join(w.briefs, 'audits', '2026-11-15-cost.md')
  writeFileSync(join(w.state, 'todo', 'Audit: cost.jsonl'), [
    JSON.stringify({ v: 1, id: 1, opened: 'x', label: 'second figure', state: 'open', verdict: '', words: 'measure the second week', said_at: '2026-11-15T10:00:00Z', from: 'Audit: cost' }),
    JSON.stringify({ v: 1, id: 2, opened: 'x', label: 'done one', state: 'closed', verdict: 'ok', words: 'w', said_at: 'x', from: 'Audit: cost' }),
  ].join('\n') + '\n')
  assert.equal(w.run('auditor-takeover', '--name', 'Audit: cost [a1b2c3]', '--tty', '/dev/ttys004', '--report', report, '--repository', w.worktree), 0)
  const text = w.text()
  assert.ok(text.includes('[1] second figure: « measure the second week » (2026-11-15T10:00:00Z)'))
  assert.ok(!text.includes('done one'))
  assert.match(text, /close --tty \/dev\/ttys004 --expect-title "Audit: cost"/)
  assert.ok(text.includes(`--report ${report} --repository ${w.worktree}`))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text))
})

test('coordinator-takeover prints the capped notes and the to-do list, or none', () => {
  const w = world()
  const run = () => { w.out.length = 0; assert.equal(w.run('coordinator-takeover', '--name', 'Coord: machine', '--tty', '/dev/ttys002'), 0); return w.text() }
  const empty = run()
  assert.match(empty, /characters of `[^`]+notes\.md`[^\n]*\n\nnone\n/)
  assert.ok(empty.includes('Your to-do list (his requests still open): none'))
  assert.match(empty, /close --tty \/dev\/ttys002 --expect-title "Coord:"/)
  mkdirSync(join(w.state, 'coordinator'))
  writeFileSync(join(w.state, 'coordinator', 'notes.md'), `announced: Orch: belt\n${'x'.repeat(NOTES_CAP * 2)}`)
  const noted = run()
  assert.ok(noted.includes('announced: Orch: belt'))
  assert.ok(!noted.includes('x'.repeat(NOTES_CAP)))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(noted))
  assert.equal(run(), noted, 'two runs on one state print the same takeover')
})

test('a template field this command does not fill, or a template missing, is refused', () => {
  const w = world()
  const extra = join(dir, 'extra.md')
  writeFileSync(extra, '{{NOPE}}')
  const io = { out: () => {}, err: (t: string) => { w.err.push(t) } }
  const deps: Deps = { env: { ORCHESTRATOR_STATE_DIR: w.state }, now: () => new Date(), git: () => undefined }
  const args = ['coordinator-takeover', '--name', 'Coord: m', '--tty', 't']
  assert.equal(main(args, io, deps, { ...TEMPLATES, 'coordinator-takeover': extra }), 2)
  assert.equal(main(args, io, deps, { ...TEMPLATES, 'coordinator-takeover': join(dir, 'gone.md') }), 2)
  assert.match(w.err.join(''), /does not fill: \{\{NOPE\}\}[\s\S]*cannot be read/)
})

test('to-do lines: none, or each open item with its words, its date and its deferral', () => {
  assert.equal(todoLines(undefined), 'none')
  const item = JSON.stringify({ v: 1, id: 4, opened: 'x', label: 'l', state: 'open', deferred: 'later', verdict: '', words: 'w', said_at: 'd', from: 'f' })
  assert.equal(todoLines(item), '\n  - [4] l: « w » (d) deferred: later')
})
