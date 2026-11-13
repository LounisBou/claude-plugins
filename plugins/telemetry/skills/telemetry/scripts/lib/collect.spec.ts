// Each event's shape, built from the hook inputs of the fixture: what is kept, and that no
// prompt, answer or tool output is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  agentClosed, agentSpawned, bashOf, checkOf, Collector, cutFields, cutText, deciderOf, FLUSH_AT, firstTurn, LINE_MAX, mcpOf, orchestrationOf, projectOf, roleOf,
  sessionEnd, sessionStart, toolEvents, turnEnd, usageFacts,
} from '../../../../hooks/collect.ts'

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../tests/fixtures/hook-inputs.json', import.meta.url)), 'utf8')) as Record<string, unknown>
const F = (name: string): unknown => fixture[name]
const AT = Date.parse('2026-11-13T20:00:00.000Z')
const S = '60ed5626-9879-4041-892a-5db0ff0bad69'
const HEAD = { v: 1, ts: '2026-11-13T20:00:00.000Z', session: S }

test('session_start: directory, project, model, surface, launch latency', () => {
  const usage = usageFacts(F('usage'))
  assert.deepEqual(sessionStart(AT, S, F('session.start'), { model: 'claude-opus-5-5', startedAt: AT - 1500, spawned: true }), {
    ...HEAD, event: 'session_start', cwd: '/Users/me/dev/claude-plugins', project: 'claude-plugins', model: 'claude-opus-5-5',
    interactive: true, surface: 'terminal', spawned: true, startup_ms: 1500,
  })
  assert.deepEqual(usage, { contextTokens: 42000, window: 1000000, costUsd: 1.25, startedAt: 1794600000000 })
})

test('first_turn: time since the start and since the launch', () => {
  assert.deepEqual(firstTurn(AT, S, AT - 300_000, AT - 310_000), { ...HEAD, event: 'first_turn', since_start_ms: 300_000, since_launch_ms: 310_000 })
  assert.deepEqual(firstTurn(AT, S, undefined, undefined), { ...HEAD, event: 'first_turn' })
})

test('turn_end: duration, tokens, context and cost; never the answer', () => {
  const event = turnEnd(AT, S, F('turn.complete'), usageFacts(F('usage')))
  assert.deepEqual(event, {
    ...HEAD, event: 'turn_end', turn: 'turn-1', reason: 'answer', duration_ms: 5400, model: 'claude-opus-5-5',
    tokens: { in: 12, out: 340, cache_read: 30000, cache_write: 1200 }, context_tokens: 42000, window: 1000000, cost_usd: 1.25,
  })
  const refused = turnEnd(AT, S, F('turn.complete.refused'), {})
  assert.equal(refused['refusal'], 'cyber')
  assert.ok(!JSON.stringify(refused).includes('never kept'))
  const child = turnEnd(AT, S, F('turn.complete.child'), usageFacts(F('usage')))
  assert.equal(child['agent'], 'a1b2c3')
  assert.equal(child['context_tokens'], undefined)
})

test('session_end: reason, duration, turns, cost, context', () => {
  assert.deepEqual(sessionEnd(AT, S, F('session.end'), { ...usageFacts(F('usage')), startedAt: AT - 60_000, turns: 4 }), {
    ...HEAD, event: 'session_end', reason: 'prompt_input_exit', duration_ms: 60_000, turns: 4, cost_usd: 1.25, context_tokens: 42000, window: 1000000,
  })
})

test('tool_call: a Bash call keeps its command names and its line, never its output', () => {
  const [event, ...rest] = toolEvents(AT, S, F('tool.call.bash'), F('result.ok'), undefined, 812)
  assert.deepEqual(event, {
    ...HEAD, event: 'tool_call', tool: 'Bash', tool_use_id: 'toolu_01Bash', outcome: 'ok', duration_ms: 812,
    bash: { head: 'cd', heads: ['cd', 'npm', 'tail'], line: "cd /tmp/x && npm test -- --grep 'a b' | tail -5" },
  })
  assert.deepEqual(rest, [])
  assert.equal(bashOf('x'.repeat(LINE_MAX + 10)).line.length, LINE_MAX + 10)
})

test('cuts: by field at any depth, after the redaction, never inside a mark', () => {
  assert.equal(cutText('abcdef', 6), 'abcdef')
  assert.equal(cutText('abcdef', 3), 'abc…')
  assert.equal(cutText('ab [REDACTED:env] cd', 8), 'ab …')
  assert.equal(cutText('[REDACTED:env] cd', 15), '[REDACTED:env] …')
  assert.deepEqual(cutFields({ bash: { line: 'x'.repeat(LINE_MAX + 1) }, headers: ['a'.repeat(20)], note: 'n'.repeat(500), n: 1 }), {
    bash: { line: `${'x'.repeat(LINE_MAX)}…` }, headers: [`${'a'.repeat(12)}…`], note: 'n'.repeat(500), n: 1,
  })
})

test('tool_call: an MCP call names its server, tool and command; refused by a plugin', () => {
  const [event] = toolEvents(AT, S, F('tool.call.mcp'), F('result.plugin-deny'), undefined, 30)
  assert.deepEqual(event, {
    ...HEAD, event: 'tool_call', tool: 'mcp__github__gh', mcp_server: 'github', mcp_tool: 'gh', tool_use_id: 'toolu_01Mcp',
    outcome: 'refused', decided_by: 'plugin:github', duration_ms: 30, command: 'pr-merge',
  })
})

test('tool_call: who refused — auto mode, the user, a rule, a hook, a plugin above; an error is no refusal', () => {
  const by = (result: string, check?: unknown) => toolEvents(AT, S, F('tool.call.bash'), F(result), checkOf(check), 1)[0]
  assert.equal(by('result.auto-mode')?.['decided_by'], 'auto_mode')
  assert.equal(by('result.user', F('tool.check.ask'))?.['decided_by'], 'user')
  assert.deepEqual(by('result.user', F('tool.check.ask'))?.['check'], { decision: 'ask', hook: 'PreToolUse' })
  assert.equal(by('result.deny')?.['decided_by'], 'plugin')
  assert.deepEqual([by('result.failed')?.['outcome'], by('result.failed')?.['decided_by']], ['error', undefined])
  assert.equal(checkOf(F('tool.check.allow')), undefined)
  assert.equal(deciderOf('Permission to use Bash with command x has been denied.', checkOf(F('tool.check.deny'))), 'rule')
  assert.equal(deciderOf('Permission to use Bash with command x has been denied.', undefined), 'user')
  assert.equal(deciderOf('Permission for this command was denied by a built-in Claude Code safety check', undefined), 'safety')
  assert.equal(deciderOf('<tool_use_error>Blocked: sleep 5 followed by: echo ok</tool_use_error>', undefined), 'hook')
  assert.equal(deciderOf('anything', { decision: 'deny', rule: 'Bash(rm:*)' }), 'rule')
  assert.equal(deciderOf('anything', { decision: 'deny', hook: 'PreToolUse' }), 'hook')
  assert.equal(deciderOf('anything', { decision: 'deny', plugin: 'norms' }), 'plugin:norms')
  assert.equal(deciderOf('anything', { decision: 'deny' }), 'policy')
})

test('question: an AskUserQuestion keeps headers, option counts and the letters chosen, never the texts', () => {
  const events = toolEvents(AT, S, F('tool.call.ask'), F('result.ask'), undefined, 45_000)
  assert.deepEqual(events[1], {
    ...HEAD, event: 'question', source: 'ask_user', count: 3, headers: ['Store', 'Parts', 'Else'], options: [2, 3, 2],
    multi: [false, true, false], chosen: ['B', 'AC', 'other'], wait_ms: 45_000,
  })
  assert.ok(!JSON.stringify(events).includes('Which store'))
  const unanswered = toolEvents(AT, S, F('tool.call.ask'), F('result.user'), undefined, 1)[1]
  assert.deepEqual(unanswered?.['chosen'], ['-', '-', '-'])
})

test('question: a round question declared to the operator', () => {
  const events = toolEvents(AT, S, F('tool.call.round'), F('result.ok'), undefined, 2)
  assert.deepEqual(events[1], { ...HEAD, event: 'question', source: 'round', kind: 'operator', urgent: true })
  assert.ok(!JSON.stringify(events).includes('never kept'))
})

test('agent_spawned and agent_closed: a session launched and closed through the launcher', () => {
  const spawn = toolEvents(AT, S, F('tool.call.spawn'), F('result.ok'), undefined, 9000)[1]
  assert.deepEqual(spawn, { ...HEAD, event: 'agent_spawned', kind: 'session', title: 'Agent: telemetry', role: 'agent', tier: 'deep' })
  const close = toolEvents(AT, S, F('tool.call.close'), F('result.ok'), undefined, 10)[1]
  assert.deepEqual(close, { ...HEAD, event: 'agent_closed', kind: 'session', title: 'Agent: telemetry' })
  assert.equal(toolEvents(AT, S, F('tool.call.spawn'), F('result.failed'), undefined, 1).length, 1)
  assert.deepEqual(orchestrationOf('iterm-agent.sh spawn --auditor --title x')[0]?.fields['role'], 'auditor')
  assert.deepEqual(orchestrationOf('iterm-agent.sh spawn --coordinator-successor')[0]?.fields['role'], 'coordinator')
  assert.deepEqual(orchestrationOf('iterm-agent.sh list'), [])
})

test('dispatch: the record\'s writes, with the row, the pair and the verdict', () => {
  const events = toolEvents(AT, S, F('tool.call.dispatch'), F('result.ok'), undefined, 10).slice(1)
  assert.deepEqual(events, [
    { ...HEAD, event: 'dispatch', sub: 'open', record: 'record.jsonl', class: 'plugin', model: 'sonnet', effort: 'high' },
    { ...HEAD, event: 'dispatch', sub: 'close', record: 'record.jsonl', row: '68', verdict: 'merged' },
  ])
  assert.deepEqual(orchestrationOf('dispatch-record.sh summary /r'), [])
})

test('tool_call: a skill names itself', () => {
  assert.equal(toolEvents(AT, S, F('tool.call.skill'), F('result.ok'), undefined, 1)[0]?.['skill'], 'method:lifecycle')
})

test('agent_spawned and agent_closed: a subagent, its type and model, its first run', () => {
  const spawn = agentSpawned(AT, S, F('agent.spawn'), F('agent.spawn.result'))
  assert.deepEqual(spawn, {
    ...HEAD, event: 'agent_spawned', kind: 'subagent', child: 'a1b2c3', subagent_type: 'Explore', model: 'claude-haiku-5-5',
    requested_model: 'haiku', background: false, provider: 'engine', description: 'Explore the store',
  })
  assert.deepEqual(agentClosed(AT, S, 'a1b2c3', AT - 2000, F('turn.complete.child')), {
    ...HEAD, event: 'agent_closed', kind: 'subagent', child: 'a1b2c3', duration_ms: 2000, reason: 'answer',
  })
})

test('roles from titles; projects from directories; MCP names', () => {
  assert.deepEqual(
    ['Orch: billing', 'Coord: machine', 'Agent: x', 'Audit: y', 'Review telemetry', 'scratch', undefined].map(t => roleOf(t)),
    ['orchestrator', 'coordinator', 'agent', 'auditor', 'reviewer', 'other', 'other'],
  )
  assert.equal(roleOf(undefined, true), 'agent')
  assert.equal(projectOf('/a/b/'), 'b')
  assert.equal(projectOf(undefined), undefined)
  assert.equal(mcpOf('Bash'), undefined)
  assert.deepEqual(mcpOf('mcp__plugin-authoring__scan_secrets'), { server: 'plugin-authoring', name: 'scan_secrets' })
})

test('Collector: buffers until drained, flags the flush threshold, pairs checks and spawns once', () => {
  const c = new Collector()
  assert.equal(c.drain(), '')
  const e = firstTurn(AT, S, undefined, undefined)
  assert.equal(c.push(...Array.from({ length: FLUSH_AT - 1 }, () => e)), false)
  assert.equal(c.push(e), true)
  assert.equal(c.size, FLUSH_AT)
  assert.equal(c.drain().split('\n').length, FLUSH_AT + 1)
  assert.equal(c.size, 0)
  c.noteCheck('t1', { decision: 'deny' })
  c.noteCheck(undefined, { decision: 'deny' })
  c.noteCheck('t2', undefined)
  assert.deepEqual(c.takeCheck('t1'), { decision: 'deny' })
  assert.equal(c.takeCheck('t1'), undefined)
  assert.equal(c.takeCheck(undefined), undefined)
  c.spawned('a', 5)
  c.spawned(undefined, 6)
  assert.equal(c.closing('a'), 5)
  assert.equal(c.closing('a'), undefined)
  assert.equal(c.closing(undefined), undefined)
})
