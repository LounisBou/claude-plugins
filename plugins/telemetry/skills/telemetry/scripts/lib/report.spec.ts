// The weekly report on fixtures: a scratch configuration directory holding day files, the
// orchestrator's record registry, round and measure files, and a stand-in for `gh`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseOptions, report, type Gh, type ReportInput } from './report.ts'

const WEEK = '2026-11-08'
const NOW = Date.parse('2026-11-14T12:00:00Z')
const S = (n: number): string => `0000000${n}-0000-0000-0000-000000000000`
const ev = (ts: string, event: string, session: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, ts, event, session, ...fields })

interface Files {
  events?: Record<string, unknown>[]
  round?: Record<string, unknown>[]
  measure?: Record<string, unknown>
  archive?: Record<string, unknown>[]
  record?: string[]
}

function scratch(files: Files, work: (config: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-report-'))
  const config = join(dir, 'config')
  const put = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  try {
    const byDay = new Map<string, string[]>()
    for (const e of files.events ?? []) byDay.set(String(e['ts']).slice(0, 10), [...(byDay.get(String(e['ts']).slice(0, 10)) ?? []), JSON.stringify(e)])
    for (const [day, lines] of byDay) put(join(config, 'telemetry', 'events', `${day}.jsonl`), `${lines.join('\n')}\n`)
    const module = join(config, 'claude-orchestrator')
    ;(files.round ?? []).forEach((r, i) => put(join(module, 'round', `${i}.json`), JSON.stringify(r)))
    ;(files.archive ?? []).forEach((r, i) => put(join(module, 'round', 'archive', `${i}.json`), JSON.stringify(r)))
    for (const [id, m] of Object.entries(files.measure ?? {})) put(join(module, 'measure', `${id}.json`), JSON.stringify(m))
    if (files.record !== undefined) {
      put(join(dir, 'record.jsonl'), `${files.record.join('\n')}\n`)
      put(join(module, 'records', S(1)), `${join(dir, 'record.jsonl')}\n${join(dir, 'gone.jsonl')}\n`)
    }
    work(config, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const merged = (rows: [number, string, string][]): string => JSON.stringify(rows.map(([number, createdAt, mergedAt]) => ({ number, createdAt, mergedAt })))
const ghFor = (answers: { prs?: Record<string, string>; runs?: Record<string, string> }): Gh => args => {
  const repo = args[3] ?? ''
  const answer = (args[0] === 'pr' ? answers.prs : answers.runs)?.[repo]
  return answer === undefined ? { status: 1, stdout: '', stderr: `no access to ${repo}\nmore` } : { status: 0, stdout: answer, stderr: '' }
}

function lines(config: string, over: Partial<ReportInput> = {}): string[] {
  return report({ config, env: {}, now: NOW, week: WEEK, tools: ['acme/tool'], cwd: '/nowhere', gh: ghFor({}), repositoryAt: () => undefined, ...over })
}
const find = (out: string[], start: string): string => out.find(l => l.startsWith(start)) ?? `missing ${start}`

test('an empty store prints every figure it cannot compute as n/a with its reason', () => {
  scratch({}, config => {
    const out = lines(config)
    assert.equal(out[0], 'weekly report 2026-11-08 → 2026-11-14 (Europe/Paris), tool: acme/tool')
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(find(out, `${n} `), /: n\/a — /)
    assert.match(find(out, '9 '), /n\/a — acme\/tool: gh run list acme\/tool failed: no access to acme\/tool$/)
    assert.match(find(out, '  acme/tool: '), /n\/a — gh pr list acme\/tool failed: no access/)
    assert.equal(out.filter(l => l.startsWith('20')).length, 7)
  })
})

test('the week defaults to the seven Paris days ending today, and a Paris day is not a UTC day', () => {
  scratch({ events: [ev('2026-11-14T23:30:00Z', 'question', S(1), { source: 'ask_user' }), ev('2026-11-14T22:30:00Z', 'question', S(1), { source: 'ask_user' })] }, config => {
    const out = lines(config, { week: undefined, now: Date.parse('2026-11-14T23:30:00Z') })
    assert.match(out[0] ?? '', /^weekly report 2026-11-09 → 2026-11-15 /)
    assert.match(find(out, '2026-11-14'), /^2026-11-14 +1 /)
    assert.match(find(out, '2026-11-15'), /^2026-11-15 +1 /)
  })
})

test('a session\'s cost in the week is its cumulative cost at the week\'s end less what came before it', () => {
  const events = [
    ev('2026-11-07T10:00:00Z', 'turn_end', S(1), { cost_usd: 5, project: 'acme/app' }),
    ev('2026-11-09T10:00:00Z', 'turn_end', S(1), { cost_usd: 6.5 }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(1), { cost_usd: 8 }),
    ev('2026-11-16T10:00:00Z', 'turn_end', S(1), { cost_usd: 99 }),
    ev('2026-11-09T11:00:00Z', 'session_start', S(1), { project: 'acme/app' }),
    ev('2026-11-10T10:00:00Z', 'session_start', S(2), { project: 'acme/tool' }),
    ev('2026-11-10T11:00:00Z', 'session_end', S(2), { cost_usd: 2, totals: { in: 1, out: 1, cache_read: 98, cache_write: 0 } }),
    ev('2026-11-10T11:00:00Z', 'session_summary', S(3), { cwd: '/w/a', totals: { in: 0, out: 0, cache_read: 100, cache_write: 0 } }),
  ]
  scratch({ events }, config => {
    const out = lines(config, { repositoryAt: dir => (dir === '/w/a' ? 'acme/app' : undefined) })
    assert.match(find(out, 'spend'), /^spend \(cost known for 2 of 3 sessions;/)
    assert.equal(find(out, '  cost '), '  cost    tool 40 %, product 60 %, unattributed 0 %')
    assert.equal(find(out, '  tokens '), '  tokens  tool 50 %, product 50 %, unattributed 0 %')
    assert.equal(find(out, '  cap '), "  cap     tool 40 % of the week's spend (range 40–40 %: 0 % unattributed), cost known for 2 of 3 sessions: above the 20 % cap (suspended)")
    assert.match(find(out, '  acme/app '), /^ {2}acme\/app +product +\$3\.00 +0k$/)
    assert.match(find(out, '  acme/tool '), /^ {2}acme\/tool +tool +\$2\.00 +0k$/)
  })
})

test('a session whose directory names no repository, or that has none, is unattributed, never product', () => {
  const events = [ev('2026-11-10T11:00:00Z', 'session_summary', S(1), { cwd: '/w/gone', totals: { in: 0, out: 0, cache_read: 50, cache_write: 0 } }), ev('2026-11-10T11:00:00Z', 'session_summary', S(2), { totals: { in: 0, out: 0, cache_read: 50, cache_write: 0 } })]
  scratch({ events }, config => {
    const out = lines(config)
    assert.equal(find(out, '  tokens '), '  tokens  tool 0 %, product 0 %, unattributed 100 %')
    assert.match(find(out, '  unattributed'), /^ {2}unattributed +unattributed /)
    assert.equal(find(out, '  cap '), '  cap     n/a — no cost known in the week')
  })
})

test('a merged pull request lists its delay and the cost of the sessions that name only that one; the rest is counted apart', () => {
  const events = [
    ev('2026-11-10T09:00:00Z', 'tool_call', S(1), { target: { repo: 'acme/tool', pr: 7 }, project: 'acme/tool' }),
    ev('2026-11-10T10:00:00Z', 'tool_call', S(1), { target: { repo: 'acme/tool', pr: 7 } }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(1), { cost_usd: 1.25 }),
    ev('2026-11-10T09:00:00Z', 'tool_call', S(2), { target: { repo: 'acme/tool', pr: 7 }, project: 'acme/tool' }),
    ev('2026-11-10T09:30:00Z', 'tool_call', S(2), { target: { repo: 'acme/tool', pr: 8 } }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(2), { cost_usd: 4 }),
    ev('2026-11-16T09:00:00Z', 'tool_call', S(3), { target: { repo: 'acme/tool', pr: 9 } }),
  ]
  const prs = merged([[7, '2026-11-10T09:00:00Z', '2026-11-10T09:22:00Z'], [8, '2026-11-09T08:00:00Z', '2026-11-09T12:30:00Z'], [9, '2026-11-01T08:00:00Z', '2026-11-02T08:00:00Z']])
  scratch({ events }, config => {
    const out = lines(config, { gh: ghFor({ prs: { 'acme/tool': prs }, runs: { 'acme/tool': '[]' } }) })
    assert.deepEqual(out.filter(l => l.startsWith('  acme/tool#')), ['  acme/tool#7    22 min  $1.25', '  acme/tool#8     4.5 h  cost n/a'])
    assert.equal(find(out, '  cost of sessions that name'), '  cost of sessions that name no pull request or several: $4.00')
    assert.match(find(out, '6 '), /pull request median 2\.4 h over 2/)
  })
})

test('with no call naming its pull request, the per-pull-request cost says it is n/a', () => {
  scratch({ events: [ev('2026-11-10T10:00:00Z', 'turn_end', S(1), { cost_usd: 1 })] }, config => {
    assert.match(find(lines(config), '  cost of sessions that name'), /\$1\.00 \(no tool call of the week names its pull request: the per-pull-request cost is n\/a\)$/)
  })
})

test('questions come from the round files and their archive and the operator-asked ones; refusals from the live calls, else from the summary of a session that has none', () => {
  const asked = (since: string, blocks: string, kind = 'operator'): Record<string, unknown> => ({ kind, since, blocks })
  const events = [
    ev('2026-11-10T10:00:00Z', 'question', S(1), { source: 'ask_user' }),
    ev('2026-11-10T10:00:00Z', 'question', S(1), { source: 'round' }),
    ev('2026-11-10T10:00:00Z', 'tool_call', S(1), { outcome: 'refused', decided_by: 'plugin:github' }),
    ev('2026-11-10T10:00:01Z', 'tool_call', S(1), { outcome: 'refused', decided_by: 'auto_mode' }),
    ev('2026-11-10T10:00:02Z', 'tool_call', S(1), { outcome: 'ok' }),
    ev('2026-11-11T10:00:00Z', 'tool_call', S(2), { outcome: 'refused', decided_by: 'hook' }),
    ev('2026-11-11T12:00:00Z', 'session_summary', S(2), { refusals: { 'plugin:github': 2, user: 3 } }),
    ev('2026-11-11T12:00:00Z', 'session_summary', S(4), { refusals: { 'plugin:github': 2, user: 3 } }),
  ]
  const round = [asked('2026-11-10T08:00:00Z', 'a'), asked('2026-11-11T08:00:00Z', 'a'), asked('2026-11-11T09:00:00Z', 'b'), asked('2026-11-11T09:00:00Z', 'c', 'done'), asked('2026-11-01T09:00:00Z', 'b')]
  scratch({ events, round, archive: [asked('2026-11-10T08:30:00Z', 'd')] }, config => {
    const out = lines(config)
    assert.equal(find(out, '2026-11-10'), '2026-11-10          3         2                    1')
    assert.equal(find(out, '2026-11-11'), '2026-11-11          2         6                    3')
    assert.match(find(out, '7 '), /^7 a question reaches him once: 1 of 4 questions repeat an earlier one's blocks line/)
  })
})

test('context height by role, an orchestrator\'s life and first turn, and the line delay from the dispatch records', () => {
  const turn = (ts: string, session: string, context: number): Record<string, unknown> => ev(ts, 'turn_end', session, { context_tokens: context })
  const events = [
    ev('2026-11-10T08:00:00Z', 'session_start', S(1), { role: 'orchestrator' }),
    turn('2026-11-10T08:01:00Z', S(1), 80_000),
    turn('2026-11-10T08:02:00Z', S(1), 250_000),
    ev('2026-11-10T09:00:00Z', 'session_end', S(1), { duration_ms: 3_600_000, role: 'orchestrator' }),
    ev('2026-11-10T08:00:00Z', 'session_start', S(2), { role: 'agent' }),
    turn('2026-11-10T08:01:00Z', S(2), 40_000),
    turn('2026-11-10T08:01:00Z', S(9), 41_000),
    ev('2026-11-11T12:00:00Z', 'session_summary', S(3), { role: 'orchestrator', started: '2026-11-11T08:00:00Z', ended: '2026-11-11T13:00:00Z' }),
    ev('2026-11-12T12:00:00Z', 'session_summary', S(4), { role: 'orchestrator', started: 'not a time', ended: '2026-11-11T13:00:00Z' }),
    ev('2026-11-12T12:00:00Z', 'session_summary', S(5), { role: 'orchestrator' }),
  ]
  const measure = { [S(3)]: { version: 1, context_tokens: 1, context_window: 2, context_percent: 3, model: 'm', updated_at: '2026-11-11T13:00:00Z', start: { tokens: 50_000, at: '2026-11-11T08:00:00Z', brief: null, brief_bytes: null } }, [S(6)]: { nothing: true } }
  const record = [
    JSON.stringify({ id: 1, opened: '2026-11-10T08:00:00Z', closed: '2026-11-10T09:00:00Z', state: 'closed' }),
    JSON.stringify({ id: 2, opened: '2026-11-10T08:00:00Z', closed: '2026-11-10T11:00:00Z', state: 'closed' }),
    JSON.stringify({ id: 3, opened: '2026-11-10T08:00:00Z', state: 'open' }),
    JSON.stringify({ ledger: 'pr', repo: 'acme/app', pr: 1 }),
    'not json',
  ]
  scratch({ events, measure, record }, config => {
    const out = lines(config)
    assert.equal(find(out, '3 '), '3 context height: 1 of 4 turns above 200k (25 %), peak 250k; orchestrator 1/2, agent 0/1, other 0/1')
    assert.equal(find(out, '4 '), '4 life of an orchestrator session: median 3.0 h over 2 orchestrator sessions (target ≥ 2.0 h)')
    assert.equal(find(out, '5 '), '5 first turn of a new session: median 65k over 2 orchestrator sessions (target ≤ 60k)')
    assert.match(find(out, '6 '), /line median 2\.0 h over 2 \(target ≤ 60 min\)$/)
  })
})

test('main\'s runs of the week are counted green and red, those of other days and of other states left out', () => {
  const runs = JSON.stringify([
    { conclusion: 'success', createdAt: '2026-11-09T10:00:00Z' },
    { conclusion: 'failure', createdAt: '2026-11-10T10:00:00Z' },
    { conclusion: 'success', createdAt: '2026-11-11T10:00:00Z' },
    { conclusion: '', createdAt: '2026-11-11T11:00:00Z' },
    { conclusion: 'failure', createdAt: '2026-11-01T10:00:00Z' },
  ])
  scratch({}, config => {
    assert.equal(find(lines(config, { gh: ghFor({ runs: { 'acme/tool': runs } }) }), '9 '), '9 main green: 2 green, 1 red runs on main (target 0 red)')
    assert.match(find(lines(config, { gh: () => ({ status: 0, stdout: '{}', stderr: '' }) }), '9 '), /n\/a — acme\/tool: gh answered something else than a list/)
    assert.match(find(lines(config, { gh: () => ({ status: 0, stdout: 'nope', stderr: '' }) }), '9 '), /n\/a — acme\/tool: gh answered no JSON/)
  })
})

test('without --tool the tool is the repository of the working directory; with none, the figures that need one say so', () => {
  scratch({}, config => {
    assert.match(lines(config, { tools: [], repositoryAt: dir => (dir === '/here' ? 'acme/here' : undefined), cwd: '/here', gh: ghFor({}) })[0] ?? '', /tool: acme\/here$/)
    const none = lines(config, { tools: [] })
    assert.match(none[0] ?? '', /tool: n\/a — not run in a repository and no --tool$/)
    assert.equal(find(none, '9 '), '9 main green: n/a — no tool repository')
  })
})

test('the cap line says within at or under 20 %, above it, n/a with no tool, never OVER, and a tool match ignores case', () => {
  const at = (tool: number, product: number): Record<string, unknown>[] => [
    ev('2026-11-10T11:00:00Z', 'session_end', S(1), { cost_usd: tool, project: 'acme/tool' }),
    ev('2026-11-10T11:00:00Z', 'session_end', S(2), { cost_usd: product, project: 'acme/app' }),
  ]
  const cap = (events: Record<string, unknown>[], over: Partial<ReportInput> = {}): string => {
    let line = ''
    scratch({ events }, config => { line = find(lines(config, over), '  cap ') })
    return line
  }
  assert.equal(cap(at(1, 4)), "  cap     tool 20 % of the week's spend (range 20–20 %: 0 % unattributed), cost known for 2 of 2 sessions: within the 20 % cap (suspended)")
  assert.equal(cap(at(1, 3)), "  cap     tool 25 % of the week's spend (range 25–25 %: 0 % unattributed), cost known for 2 of 2 sessions: above the 20 % cap (suspended)")
  assert.equal(cap(at(1, 3), { tools: ['Acme/Tool'] }), cap(at(1, 3)))
  assert.doesNotMatch(cap(at(1, 3)), /OVER/i)
  assert.equal(cap(at(1, 3), { tools: [] }), '  cap     n/a — no tool repository')
})

test('a pull request\'s cost sums its single-PR sessions; a session with no cost leaves it n/a; a merge after midnight Paris is the next day\'s', () => {
  const named = (n: number, project: string, pr: number, cost?: number): Record<string, unknown>[] => [
    ev('2026-11-10T09:00:00Z', 'tool_call', S(n), { target: { repo: 'acme/tool', pr }, project }),
    ...(cost === undefined ? [] : [ev('2026-11-10T10:00:00Z', 'turn_end', S(n), { cost_usd: cost })]),
    ev('2026-11-10T10:00:00Z', 'session_summary', S(n), { totals: { in: 1 } }),
  ]
  const events = [...named(1, 'acme/tool', 7, 1), ...named(2, 'acme/tool', 7, 2.5), ...named(3, 'acme/tool', 8)]
  const prs = merged([[7, '2026-11-10T09:00:00Z', '2026-11-10T09:10:00Z'], [8, '2026-11-10T09:00:00Z', '2026-11-10T09:10:00Z'], [9, '2026-11-14T22:00:00Z', '2026-11-14T23:30:00Z']])
  scratch({ events }, config => {
    const out = lines(config, { gh: ghFor({ prs: { 'acme/tool': prs } }) })
    assert.deepEqual(out.filter(l => l.startsWith('  acme/tool#')), ['  acme/tool#7    10 min  $3.50', '  acme/tool#8    10 min  cost n/a'])
    assert.match(find(out, 'spend'), /cost known for 2 of 3 sessions/)
  })
})

test('gh is asked for the week\'s merged pull requests and main\'s runs, and a listing that reaches its limit is n/a, a partial one said', () => {
  scratch({ events: [ev('2026-11-10T11:00:00Z', 'session_end', S(1), { project: 'acme/app', cost_usd: 1 })] }, config => {
    const asked: string[][] = []
    const full = JSON.stringify(Array.from({ length: 500 }, () => ({ conclusion: 'success', createdAt: '2026-11-10T10:00:00Z' })))
    const gh: Gh = args => {
      asked.push([...args])
      return args[0] === 'run' ? { status: 0, stdout: full, stderr: '' } : args[3] === 'acme/app' ? { status: 1, stdout: '', stderr: 'denied' } : { status: 0, stdout: merged([[1, '2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z']]), stderr: '' }
    }
    const out = lines(config, { gh })
    assert.deepEqual(asked.find(a => a[0] === 'pr' && a[3] === 'acme/tool'), ['pr', 'list', '-R', 'acme/tool', '--state', 'merged', '--search', 'merged:>=2026-11-07', '--json', 'number,createdAt,mergedAt', '--limit', '1000'])
    assert.deepEqual(asked.find(a => a[0] === 'run'), ['run', 'list', '-R', 'acme/tool', '--branch', 'main', '--created', '>=2026-11-07', '--json', 'conclusion,createdAt', '--limit', '500'])
    assert.match(find(out, '9 '), /n\/a — acme\/tool: the listing reached its limit of 500/)
    assert.match(find(out, '6 '), /median 60 min over 1, 1 repository listing\(s\) n\/a/)
  })
})

test('a session seen before the week with no cost before it has an unknown cost, not all of it; a first turn counts only for a session that began in the week', () => {
  const events = [
    ev('2026-11-05T10:00:00Z', 'tool_call', S(1), { project: 'acme/app' }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(1), { cost_usd: 9, context_tokens: 70_000 }),
    ev('2026-11-10T11:00:00Z', 'session_summary', S(1), { totals: { in: 5 } }),
    ev('2026-11-10T09:00:00Z', 'session_start', S(2), { role: 'orchestrator' }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(2), { context_tokens: 30_000 }),
    ev('2026-11-10T10:00:00Z', 'turn_end', S(3), { context_tokens: 40_000, role: 'orchestrator' }),
  ]
  const measure = { [S(2)]: { version: 1, context_tokens: 1, context_window: 2, context_percent: 3, model: 'm', updated_at: '2026-11-10T13:00:00Z', start: { tokens: 90_000, at: '2026-11-10T09:00:00Z', brief: null, brief_bytes: null } } }
  scratch({ events }, config => {
    const out = lines(config)
    assert.match(find(out, 'spend'), /cost known for 0 of 1 sessions/)
    assert.equal(find(out, '5 '), '5 first turn of a new session: median 30k over 1 orchestrator sessions (target ≤ 60k)')
  })
  scratch({ events, measure }, config => {
    assert.equal(find(lines(config), '5 '), '5 first turn of a new session: median 90k over 1 orchestrator sessions (target ≤ 60k)')
  })
})

test('lines the report cannot read are counted in its heading, and a refused week is never accepted', () => {
  scratch({ events: [ev('2026-11-10T10:00:00Z', 'question', S(1), { source: 'ask_user' })] }, config => {
    writeFileSync(join(config, 'telemetry', 'events', '2026-11-10.jsonl'), `${JSON.stringify(ev('2026-11-10T10:00:00Z', 'question', S(1), { source: 'ask_user' }))}\nnot json\n\n`)
    mkdirSync(join(config, 'claude-orchestrator', 'round'), { recursive: true })
    writeFileSync(join(config, 'claude-orchestrator', 'round', 'torn.json'), '{')
    writeFileSync(join(config, 'claude-orchestrator', 'round', 'emptied.json'), '')
    assert.match(lines(config)[0] ?? '', / \(2 unreadable event lines or files left out\)$/)
      })
  for (const week of ['2026-13-45', '2026-02-30', 'monday']) assert.match(String(parseOptions(['--week', week])), /expected --week/)
})

test('options: a week, tools, and what is refused', () => {
  assert.deepEqual(parseOptions([]), { week: undefined, tools: [] })
  assert.deepEqual(parseOptions(['--week', '2026-11-08', '--tool', 'a/b', '--tool', 'c/d']), { week: '2026-11-08', tools: ['a/b', 'c/d'] })
  assert.equal(parseOptions(['--week', 'monday']), '--week monday: expected --week <YYYY-MM-DD> or --tool <owner/name>')
  assert.equal(parseOptions(['--tool']), '--tool: expected --week <YYYY-MM-DD> or --tool <owner/name>')
  assert.equal(parseOptions(['--tool', 'nobody']), '--tool nobody: expected --week <YYYY-MM-DD> or --tool <owner/name>')
})

const ended = (day: string, session: string, cost: number, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  ev(`${day}T11:00:00Z`, 'session_end', session, { cost_usd: cost, totals: { in: 1, out: 0, cache_read: 0, cache_write: 0 }, ...fields })

test('a session whose directory is gone is attributed by the checkouts around it, and the sessions left unattributed are counted with why', () => {
  const events = [
    ended('2026-11-10', S(1), 2, { cwd: '/w/tool/main' }),
    ended('2026-11-10', S(2), 3, { cwd: '/w/tool/gone-worktree' }),
    ended('2026-11-10', S(3), 4, { cwd: '/w/tool/main/deep/gone' }),
    ended('2026-11-10', S(4), 1, { cwd: '/v/one' }),
    ended('2026-11-10', S(5), 1, { cwd: '/v/two' }),
    ended('2026-11-10', S(6), 5, { cwd: '/v/gone' }),
    ended('2026-11-10', S(7), 6, { cwd: '/z/gone' }),
    ended('2026-11-10', S(8), 7),
  ]
  const repositories: Record<string, string> = { '/w/tool/main': 'acme/tool', '/v/one': 'acme/app', '/v/two': 'acme/other' }
  scratch({ events }, config => {
    const out = lines(config, { repositoryAt: dir => repositories[dir] })
    assert.match(find(out, '  acme/tool '), /^ {2}acme\/tool +tool +\$9\.00 /)
    assert.match(find(out, '  unattributed '), /^ {2}unattributed +unattributed +\$18\.00 /)
    assert.equal(find(out, '  attribution:'), '  attribution: 2 by the ancestry of a gone directory; 3 left unattributed (1 directory gone, no known checkout around it; 1 directory gone, the checkouts around it name several repositories; 1 no directory and no project)')
    assert.equal(find(out, '  cap '), "  cap     tool 31 % of the week's spend (range 31–93 %: 62 % unattributed), cost known for 8 of 8 sessions: above the 20 % cap (suspended)")
  })
})

test('with every session attributed, no attribution line is printed', () => {
  scratch({ events: [ended('2026-11-10', S(1), 2, { project: 'acme/tool' })] }, config => {
    assert.equal(find(lines(config), '  attribution:'), 'missing   attribution:')
  })
})

test('the cap line prints the range and the coverage, and is never a verdict of OVER', () => {
  const events = [ended('2026-11-10', S(1), 5, { project: 'acme/tool' }), ended('2026-11-10', S(2), 4, { project: 'acme/app' }), ended('2026-11-10', S(3), 1, { cwd: '/z/gone' }), ended('2026-11-10', S(4), 0, { project: 'acme/app', cost_usd: undefined })]
  scratch({ events }, config => {
    const cap = find(lines(config), '  cap ')
    assert.equal(cap, "  cap     tool 50 % of the week's spend (range 50–60 %: 10 % unattributed), cost known for 3 of 4 sessions: above the 20 % cap (suspended)")
    assert.doesNotMatch(cap, /OVER/i)
  })
  const between = [ended('2026-11-10', S(1), 1, { project: 'acme/tool' }), ended('2026-11-10', S(2), 6, { project: 'acme/app' }), ended('2026-11-10', S(3), 3, { cwd: '/z/gone' })]
  scratch({ events: between }, config => {
    assert.equal(find(lines(config), '  cap '), "  cap     tool 10 % of the week's spend (range 10–40 %: 30 % unattributed), cost known for 3 of 3 sessions: the range straddles the 20 % cap (suspended)")
  })
  const under = [ended('2026-11-10', S(1), 1, { project: 'acme/tool' }), ended('2026-11-10', S(2), 8, { project: 'acme/app' }), ended('2026-11-10', S(3), 1, { cwd: '/z/gone' })]
  scratch({ events: under }, config => {
    assert.equal(find(lines(config), '  cap '), "  cap     tool 10 % of the week's spend (range 10–20 %: 10 % unattributed), cost known for 3 of 3 sessions: within the 20 % cap (suspended)")
  })
})

test('a resumed session whose cumulative cost restarted lower is summed from its per-turn costs, or n/a when a turn has none', () => {
  const turn = (ts: string, session: string, cost: number, turnCost?: number): Record<string, unknown> => ev(ts, 'turn_end', session, { cost_usd: cost, project: 'acme/app', ...(turnCost === undefined ? {} : { turn_cost_usd: turnCost }) })
  const events = [
    turn('2026-11-07T10:00:00Z', S(1), 10, 10),
    turn('2026-11-09T10:00:00Z', S(1), 1, 1),
    turn('2026-11-10T10:00:00Z', S(1), 3, 2),
    turn('2026-11-07T10:00:00Z', S(2), 10),
    turn('2026-11-09T10:00:00Z', S(2), 1),
    // Written out of order within a day, not a restart: the later line holds the higher cost.
    turn('2026-11-09T10:05:00Z', S(3), 5, 5),
    turn('2026-11-09T10:00:00Z', S(3), 4, 4),
    turn('2026-11-06T10:00:00Z', S(4), 2, 2),
    turn('2026-11-09T10:00:00Z', S(4), 6, 4),
  ]
  scratch({ events }, config => {
    const out = lines(config)
    assert.match(find(out, 'spend'), /cost known for 3 of 4 sessions/)
    assert.equal(find(out, '  restarted:'), '  restarted: 2 resumed sessions whose cumulative cost restarted lower: 1 summed from their per-turn costs, 1 n/a')
    // S(1) 3 (1 + 2, not 0 nor the excess), S(3) 5 (cumulative, no restart), S(4) 4: the three known; S(2) is n/a.
    assert.match(find(out, '  acme/app '), /^ {2}acme\/app +product +\$12\.00 /)
  })
})
