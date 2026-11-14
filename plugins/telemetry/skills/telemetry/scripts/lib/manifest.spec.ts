// A day's manifest: its sessions with role and model, the pull requests, branches and dispatch rows
// the events carry, and a pointer to each transcript (never its content).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, MANIFEST_FIELDS, type Manifest } from './manifest.ts'

const A = '60ed5626-9879-4041-892a-5db0ff0bad69'
const B = '70ed5626-9879-4041-892a-5db0ff0bad69'
const ev = (ts: string, event: string, session: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ts: `2026-11-13T${ts}Z`, event, session, ...extra })
const bash = (ts: string, session: string, line: string): string => ev(ts, 'tool_call', session, { tool: 'Bash', bash: { line } })

function manifestOf(lines: string[], transcript: (session: string) => string | undefined = () => undefined): Manifest {
  return buildManifest({ day: '2026-11-13', machine: 'box', text: `${lines.join('\n')}\n`, transcript })
}

test('a session carries its role, models, title, project, cost, span and the pointer to its transcript', () => {
  const m = manifestOf([
    ev('10:00:00', 'session_start', A, { model: 'claude-opus-5-5', project: 'billing', cwd: '/w/billing', spawned: false }),
    ev('10:00:30', 'turn_end', A, { model: 'claude-opus-5-5', cost_usd: 0.5 }),
    ev('10:05:00', 'turn_end', A, { model: 'claude-sonnet-5-5', cost_usd: 1.25 }),
    ev('10:06:00', 'session_end', A, { reason: 'other', turns: 2, cost_usd: 1.5, title: 'Orch: billing', role: 'orchestrator', effort: 'medium', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }),
    ev('11:00:00', 'session_start', B, { model: 'claude-haiku-5-5', spawned: true }),
  ], session => (session === A ? `projects/-w/${A}.jsonl` : undefined))
  assert.equal(m.sessions.length, 2)
  assert.deepEqual(m.sessions[0], {
    session: A, role: 'orchestrator', title: 'Orch: billing', project: 'billing', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], effort: 'medium',
    spawned: false, first: '2026-11-13T10:00:00Z', last: '2026-11-13T10:06:00Z', events: 4, turns: 2, cost_usd: 1.5, ended: true,
    transcript: `projects/-w/${A}.jsonl`,
  })
  assert.deepEqual(m.sessions[1], {
    session: B, role: 'agent', title: null, project: null, models: ['claude-haiku-5-5'], effort: null,
    spawned: true, first: '2026-11-13T11:00:00Z', last: '2026-11-13T11:00:00Z', events: 1, turns: null, cost_usd: null, ended: false, transcript: null,
  })
})

test('a session\'s role is unknown, not guessed, when neither its end nor its spawn says it', () => {
  const m = manifestOf([ev('10:00:00', 'session_start', A, { model: 'm' })])
  assert.equal(m.sessions[0]?.role, null)
})

test('the event counts, the day and the machine head the manifest, and a line that is no event is left out', () => {
  const m = manifestOf([ev('10:00:00', 'session_start', A), ev('10:00:01', 'turn_end', A), ev('10:00:02', 'turn_end', A), 'not json', '{"v":1}'])
  assert.equal(m.v, 1)
  assert.equal(m.day, '2026-11-13')
  assert.equal(m.machine, 'box')
  assert.equal(m.file, 'machines/box/2026-11-13.jsonl')
  assert.equal(m.lines, 5)
  assert.deepEqual(m.events, { session_start: 1, turn_end: 2 })
})

test('pull requests come from gh command lines and PR URLs, with their repository when the line gives it', () => {
  const m = manifestOf([
    bash('10:00:00', A, 'gh pr view 181 -R owner/repo'),
    bash('10:00:01', A, 'gh pr checks 12 --watch'),
    bash('10:00:02', A, 'gh pr view 181 --repo owner/repo'),
    bash('10:00:03', A, 'gh pr create --draft --title x'),
    bash('10:00:04', B, 'curl https://github.com/owner/other/pull/7'),
    bash('10:00:05', B, 'echo gh pr view 99'),
  ])
  assert.deepEqual(m.pull_requests, [
    { repo: null, number: 12 },
    { repo: 'owner/other', number: 7 },
    { repo: 'owner/repo', number: 181 },
  ])
})

test('branches come from checkout, switch and push command lines; main is not one', () => {
  const m = manifestOf([
    bash('10:00:00', A, 'git checkout -b feat/telemetry-export-index origin/main'),
    bash('10:00:01', A, 'git switch -c fix/other'),
    bash('10:00:02', A, 'git push -u origin feat/telemetry-export-index'),
    bash('10:00:03', A, 'git push origin main'),
    bash('10:00:04', A, 'git checkout main'),
    bash('10:00:05', A, 'git push -u origin "feat/quoted'),
  ])
  assert.deepEqual(m.branches, ['feat/telemetry-export-index', 'fix/other'])
})

test('dispatch rows group by record: the rows touched and the writes by subcommand', () => {
  const m = manifestOf([
    ev('10:00:00', 'dispatch', A, { sub: 'open', record: 'claude-plugins.md', row: 'tel-export' }),
    ev('10:00:01', 'dispatch', A, { sub: 'review', record: 'claude-plugins.md', row: 'tel-export' }),
    ev('10:00:02', 'dispatch', A, { sub: 'open', record: 'claude-plugins.md', row: 'other' }),
    ev('10:00:03', 'dispatch', A, { sub: 'cost', record: 'infra.md' }),
  ])
  assert.deepEqual(m.dispatch, [
    { record: 'claude-plugins.md', rows: ['other', 'tel-export'], subs: { open: 2, review: 1 } },
    { record: 'infra.md', rows: [], subs: { cost: 1 } },
  ])
})

test('the github tool\'s commands are counted, for the merges and readiness checks the PR numbers do not name', () => {
  const m = manifestOf([
    ev('10:00:00', 'tool_call', A, { tool: 'mcp__github__gh', mcp_server: 'github', command: 'pr-gate' }),
    ev('10:00:01', 'tool_call', A, { tool: 'mcp__github__gh', mcp_server: 'github', command: 'pr-gate' }),
    ev('10:00:02', 'tool_call', A, { tool: 'mcp__github__gh', mcp_server: 'github', command: 'pr-merge' }),
    ev('10:00:03', 'tool_call', A, { tool: 'mcp__other__x', mcp_server: 'other', command: 'pr-gate' }),
  ])
  assert.deepEqual(m.github_commands, { 'pr-gate': 2, 'pr-merge': 1 })
})

test('the manifest holds no transcript content: only the declared fields', () => {
  const m = manifestOf([ev('10:00:00', 'session_start', A)])
  const declared = MANIFEST_FIELDS.map(f => f.name).sort()
  assert.deepEqual(Object.keys(m).sort(), declared)
})
