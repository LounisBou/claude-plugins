// Each event's shape, built from the hook inputs of the fixture: what is kept, and that no
// prompt, answer or tool output is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  agentClosed, agentSpawned, bashOf, checkOf, Collector, CUTS, cutFields, cutText, deciderOf, FLUSH_AT, firstTurn, LINE_MAX, mcpOf, orchestrationOf, projectOf, renamedTo, repositoryOf, roleOf,
  sessionEnd, sessionStart, sessionTitleOf, titleFromTranscriptHead, toolEvents, turnEnd, usageFacts,
} from '../../../../hooks/collect.ts'
import { redactValue } from './redact.ts'

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

test('session_start: the project is the repository when the session has one', () => {
  const event = sessionStart(AT, S, F('session.start'), { repository: 'LounisBou/claude-plugins' })
  assert.equal(event['project'], 'LounisBou/claude-plugins')
  assert.equal(event['cwd'], '/Users/me/dev/claude-plugins')
})

test('repositoryOf: owner/name from the remote, in its https and ssh forms; none from a path or nothing', () => {
  for (const remote of [
    'https://github.com/LounisBou/claude-plugins.git',
    'https://github.com/LounisBou/claude-plugins',
    'https://github.com/LounisBou/claude-plugins/',
    'https://user:token@github.com/LounisBou/claude-plugins.git',
    'git@github.com:LounisBou/claude-plugins.git',
    'git@github.com:LounisBou/claude-plugins',
    'ssh://git@github.com/LounisBou/claude-plugins.git',
    'ssh://git@github.com:22/LounisBou/claude-plugins.git',
  ]) assert.equal(repositoryOf(remote), 'LounisBou/claude-plugins', remote)
  assert.equal(repositoryOf('https://gitlab.example/group/sub/name.git'), 'sub/name')
  for (const remote of ['/srv/git/logs.git', '../logs.git', 'https://github.com/alone', '', null, undefined]) assert.equal(repositoryOf(remote), undefined, String(remote))
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
    outcome: 'refused', decided_by: 'plugin:github', duration_ms: 30, command: 'pr-merge', target: { pr: 12 },
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
  assert.equal(projectOf('/a/b/', 'o/n'), 'o/n')
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

const SHA = '0123456789abcdef0123456789abcdef01234567'
const gh = (command: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tool: 'mcp__github__gh', tool_use_id: 'toolu_01Gh', command, args, ...extra })
const targetOf = (input: unknown, result: unknown = F('result.ok')): unknown => toolEvents(AT, S, input, result, undefined, 1)[0]?.['target']

test('target: a github tool call names its repository, pull request and head from its arguments', () => {
  assert.deepEqual(targetOf(gh('pr-merge', { pr: 12, sha: SHA }, { repo: 'acme/thing' })), { repo: 'acme/thing', pr: 12, head: SHA.slice(0, 12) })
  assert.deepEqual(targetOf(gh('pr-status', { pr: '7', repo: 'acme/thing' })), { repo: 'acme/thing', pr: 7 })
  assert.deepEqual(targetOf(gh('pr-list', {})), undefined)
  assert.deepEqual(targetOf(gh('pr-merge', { pr: 'not-a-number', repo: 'no spaces/allowed here', sha: 'zz' })), undefined)
})

test('target: a github tool call that names nothing in its arguments is read from its result', () => {
  const gate = { result: JSON.stringify({ repo: 'acme/thing', pr: 12, head: SHA, state: 'open' }) }
  assert.deepEqual(targetOf(gh('pr-gate', {}), gate), { repo: 'acme/thing', pr: 12, head: SHA.slice(0, 12) })
  assert.deepEqual(targetOf(gh('pr-create', {}), { text: 'https://github.com/acme/thing/pull/30' }), { repo: 'acme/thing', pr: 30 })
  assert.deepEqual(targetOf(gh('pr-gate', { pr: 5 }), gate), { pr: 5 })
  assert.equal(targetOf(gh('pr-list', {}), { text: 'no pull request' }), undefined)
})

test('target: only a github call carries one', () => {
  assert.equal(targetOf({ tool: 'mcp__cloudflare__cf', command: 'zones', args: { pr: 3, repo: 'a/b' } }), undefined)
  assert.equal(targetOf(F('tool.call.skill')), undefined)
  assert.equal(targetOf(F('tool.call.bash')), undefined)
})

test('target: a Bash gh or git push line names what its arguments name plainly', () => {
  const bash = (command: string) => targetOf({ tool: 'Bash', tool_use_id: 'toolu_01B', command })
  assert.deepEqual(bash(`gh pr merge 12 -R acme/thing --match-head-commit ${SHA}`), { repo: 'acme/thing', pr: 12, head: SHA.slice(0, 12) })
  assert.deepEqual(bash('cd /w && gh pr view 40 --repo acme/thing'), { repo: 'acme/thing', pr: 40 })
  assert.deepEqual(bash('gh pr checks https://github.com/acme/thing/pull/9'), { repo: 'acme/thing', pr: 9 })
  assert.deepEqual(bash('git push https://github.com/acme/thing.git HEAD:feat/x'), { repo: 'acme/thing' })
  assert.deepEqual(bash('git -c a=b push git@github.com:acme/thing.git HEAD:feat/x'), { repo: 'acme/thing' })
  assert.equal(bash('git push -u origin feat/x'), undefined)
  assert.equal(bash('gh pr list'), undefined)
  assert.equal(bash('npm test -- 12 -R acme/thing'), undefined)
})

test('target: its values are redacted as any other', () => {
  const [event] = toolEvents(AT, S, gh('pr-merge', { pr: 1 }, { repo: 'zq9-env-value-1/thing' }), F('result.ok'), undefined, 1)
  assert.deepEqual(event?.['target'], { repo: 'zq9-env-value-1/thing', pr: 1 })
  const redacted = redactValue(event, new Map([['TOKEN', 'zq9-env-value-1']])).value as Record<string, unknown>
  assert.deepEqual(redacted['target'], { repo: '[REDACTED:env]/thing', pr: 1 })
})

test('title: the Collector stamps its events with the session\'s title and role once it knows them, never over a kind\'s own', () => {
  const c = new Collector()
  const before = firstTurn(AT, S, undefined, undefined)
  c.push(before)
  c.setTitle('Agent: actor')
  c.push(before, toolEvents(AT, S, F('tool.call.spawn'), F('result.ok'), undefined, 1)[1] as never)
  const lines = c.drain().trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual([lines[0]?.['title'], lines[0]?.['role']], [undefined, undefined])
  assert.deepEqual([lines[1]?.['title'], lines[1]?.['role']], ['Agent: actor', 'agent'])
  assert.deepEqual([lines[2]?.['title'], lines[2]?.['role']], ['Agent: telemetry', 'agent'])
  c.setTitle('Orch: billing')
  c.push(before)
  assert.deepEqual([JSON.parse(c.drain())['title'], c.title], ['Orch: billing', 'Orch: billing'])
})

test('title: read once from the transcript head, only while unknown', () => {
  const c = new Collector()
  assert.equal(c.wantsHeadRead(), true)
  assert.equal(c.wantsHeadRead(), false)
  const known = new Collector()
  known.setTitle('Coord: x')
  assert.equal(known.wantsHeadRead(), false)
})

test('title: the three sources', () => {
  assert.equal(sessionTitleOf({ cwd: '/w', session_title: 'Agent: x' }), 'Agent: x')
  assert.equal(sessionTitleOf({ cwd: '/w' }), undefined)
  assert.equal(sessionTitleOf({ session_title: '  ' }), undefined)
  const rename = { tool: 'mcp__orchestrator__rename_session', name: 'Orch : billing' }
  assert.equal(renamedTo(rename, F('result.ok'), undefined), 'Orch: billing')
  assert.equal(renamedTo(rename, F('result.failed'), undefined), undefined)
  assert.equal(renamedTo({ tool: 'mcp__orchestrator__other', name: 'x' }, F('result.ok'), undefined), undefined)
  assert.equal(renamedTo({ tool: 'Bash', name: 'x' }, F('result.ok'), undefined), undefined)
  const head = ['{"type":"last-prompt","sessionId":"s"}', '{"type":"custom-title","customTitle":"Agent: actor","sessionId":"s"}', '{"type":"custom-title","customTitle":"Agent: act'].join('\n')
  assert.equal(titleFromTranscriptHead(head), 'Agent: actor')
  assert.equal(titleFromTranscriptHead('{"type":"mode"}\nnot json'), undefined)
  assert.equal(titleFromTranscriptHead(''), undefined)
})

// ----- the corrective round: what a title, a target and a remote may and may not name -----

const closeLine = "/plugins/orchestrator/skills/iterm-agents/scripts/iterm-agent.sh close --title 'Agent: x'"
const bashCall = (command: string) => ({ tool: 'Bash', tool_use_id: 'toolu_01B', command })

test('title: a launched session\'s spawn and close take the role of the child\'s own title, not the actor\'s', () => {
  const c = new Collector()
  c.setTitle('Orch: billing')
  const spawn = toolEvents(AT, S, bashCall("iterm-agent.sh spawn --dir /w --title 'Review: x' --brief /b.md"), F('result.ok'), undefined, 1)[1]
  const close = toolEvents(AT, S, bashCall(closeLine), F('result.ok'), undefined, 1)[1]
  assert.equal(close?.['event'], 'agent_closed')
  c.push(spawn as never, close as never)
  const lines = c.drain().trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual([lines[0]?.['title'], lines[0]?.['role']], ['Review: x', 'reviewer'])
  assert.deepEqual([lines[1]?.['title'], lines[1]?.['role']], ['Agent: x', 'agent'])
})

test('title: it is cut like any free text', () => {
  assert.equal(CUTS['title'], 80)
  assert.equal((cutFields({ title: 'T'.repeat(500) }) as { title: string }).title.length, 81)
})

test('target: arguments that name a pr are the only source: the result is not read, nor mixed in', () => {
  const cited = { text: 'see https://github.com/other/z/pull/3' }
  assert.deepEqual(targetOf(gh('pr-status', { pr: 5 }), cited), { pr: 5 })
  assert.deepEqual(targetOf(gh('pr-status', { pr: 5, repo: 'acme/thing' }), cited), { repo: 'acme/thing', pr: 5 })
  assert.deepEqual(targetOf(gh('pr-status', {}), cited), { repo: 'other/z', pr: 3 })
  const gate5 = { result: JSON.stringify({ repo: 'acme/thing', pr: 5, head: SHA }) }
  assert.deepEqual(targetOf(gh('pr-gate', { pr: 5 }), gate5), { repo: 'acme/thing', pr: 5, head: SHA.slice(0, 12) })
  assert.deepEqual(targetOf(gh('pr-gate', { pr: 5 }), { result: JSON.stringify({ pr: 5, note: 'see https://github.com/other/z/pull/3' }) }), { pr: 5 })
  assert.deepEqual(targetOf(gh('pr-gate', { pr: 6 }), gate5), { pr: 6 })
})

test('target: without a pr in the arguments, one source gives repo and pr together; several pull URLs give nothing', () => {
  const list = { text: 'https://github.com/a/b/pull/1\nhttps://github.com/c/d/pull/2' }
  assert.equal(targetOf(gh('pr-list', {}), list), undefined)
  assert.deepEqual(targetOf(gh('pr-list', {}), { text: 'https://github.com/a/b/pull/1 and again https://github.com/a/b/pull/1' }), { repo: 'a/b', pr: 1 })
})

test('target: a number is a pr for a pr command only, and a leading # is dropped', () => {
  assert.equal(targetOf(gh('issue-view', { number: 7 })), undefined)
  assert.deepEqual(targetOf(gh('issue-view', { number: 7, repo: 'acme/thing' })), { repo: 'acme/thing' })
  assert.deepEqual(targetOf(gh('pr-get', { number: 7, repo: 'acme/thing' })), { repo: 'acme/thing', pr: 7 })
  assert.deepEqual(targetOf(gh('pr-status', { pr: '#12', repo: 'acme/thing' })), { repo: 'acme/thing', pr: 12 })
})

test('target: a github host is anchored: notgithub.com is no pull request nor remote', () => {
  assert.equal(targetOf(gh('pr-create', {}), { text: 'https://notgithub.com/acme/thing/pull/30' }), undefined)
  assert.equal(targetOf(bashCall('gh pr checks https://notgithub.com/acme/thing/pull/9')), undefined)
  assert.equal(targetOf(bashCall('git push https://notgithub.com/acme/thing.git HEAD:x')), undefined)
  assert.deepEqual(targetOf(bashCall('git push git@github.com:acme/thing.git HEAD:x')), { repo: 'acme/thing' })
  assert.deepEqual(targetOf(bashCall('gh pr checks https://www.github.com/acme/thing/pull/9')), { repo: 'acme/thing', pr: 9 })
})

test('target: a Bash gh takes a pull URL only as a standalone positional of a pr subcommand with no number and no repo flag', () => {
  assert.deepEqual(targetOf(bashCall('gh pr comment 12 --body "see https://github.com/x/y/pull/3"')), { pr: 12 })
  assert.equal(targetOf(bashCall('gh pr comment --body "see https://github.com/x/y/pull/3" 12')), undefined)
  assert.deepEqual(targetOf(bashCall('gh pr comment 12 -R a/b --body "see https://github.com/x/y/pull/3"')), { repo: 'a/b', pr: 12 })
  assert.deepEqual(targetOf(bashCall('gh pr merge 12 https://github.com/x/y/pull/3')), { pr: 12 })
  assert.equal(targetOf(bashCall('gh issue view https://github.com/x/y/pull/3')), undefined)
  assert.deepEqual(targetOf(bashCall('gh pr view https://github.com/x/y/pull/3')), { repo: 'x/y', pr: 3 })
  assert.deepEqual(targetOf(bashCall('gh pr view https://github.com/x/y/pull/3 -R a/b')), { repo: 'a/b' })
})

test('target: git push is the git subcommand, not any word', () => {
  assert.equal(targetOf(bashCall('git log --grep push https://github.com/a/b')), undefined)
  assert.equal(targetOf(bashCall('git commit -m push https://github.com/a/b')), undefined)
  assert.deepEqual(targetOf(bashCall('git -C /w push https://github.com/a/b HEAD:x')), { repo: 'a/b' })
})
