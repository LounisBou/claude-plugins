import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { BARE, headLines, lastDeployOf, median, owned, parseBirth, periods, readBirths, remainder, report, run, type Birth } from './birth.ts'

const attachment = (value: Record<string, unknown>): string => JSON.stringify({ type: 'attachment', attachment: value })
const call = (at: string, input: number, read: number, write: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } }, ...extra })

const born = (at: string, role: Birth['role'], tokens: number, instructions = 0, shares: Record<string, number> = {}): Birth =>
  ({ session: at, at, role, tokens, parts: { instructions, skills: 0, agents: 0, mcp: 0, deferred: 0, hooks: 0 }, shares })

describe('birth of a session', () => {
  const est = (text: string): number => Math.ceil(text.length / 4)
  const skillLines = [`- orchestrator:status: ${'s'.repeat(40)}`, `- coordinator: ${'c'.repeat(20)}`, `- norms:check: ${'n'.repeat(20)}`]
  const agentLines = ['- norms:diff: ' + 'a'.repeat(30), '- Explore: ' + 'e'.repeat(10)]
  const mcpBlock = '## github\n' + 'g'.repeat(30)
  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle: 'Agent: birth' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Orch: later' }),
    attachment({ type: 'skill_listing', content: skillLines.join('\n') }),
    attachment({ type: 'agent_listing_delta', addedLines: agentLines }),
    attachment({ type: 'mcp_instructions_delta', addedBlocks: [mcpBlock] }),
    attachment({ type: 'deferred_tools_delta', addedLines: ['x'.repeat(8)] }),
    attachment({ type: 'hook_additional_context', content: ['h'.repeat(16)] }),
    attachment({ type: 'instructions', files: [{ content: 'i'.repeat(40) }, 'junk', { content: 'j'.repeat(4) }] }),
    attachment({ type: 'date', date: 'x' }),
    JSON.stringify({ type: 'attachment', attachment: 'text' }),
    call('2026-11-16T10:00:00Z', 5, 5, 5, { isSidechain: true }),
    call('2026-11-16T10:00:01Z', 0, 0, 0),
    JSON.stringify({ type: 'assistant', message: 'no usage' }),
    call('2026-11-16T10:00:02Z', 2, 1000, 500),
    call('2026-11-16T10:00:03Z', 9, 9, 9),
  ]

  it('reads the first model call of the session\'s own loop, its title and what its attachments weigh', () => {
    const birth = parseBirth('s1', lines)
    assert.ok(birth)
    assert.equal(birth.session, 's1')
    assert.equal(birth.at, '2026-11-16T10:00:02Z')
    assert.equal(birth.role, 'agent')
    assert.equal(birth.tokens, 1502)
    assert.deepEqual(birth.parts, { instructions: est('i'.repeat(40)) + est('j'.repeat(4)), skills: est(skillLines[0]!) + est(skillLines[1]!) + est(skillLines[2]!), agents: est(agentLines[0]!) + est(agentLines[1]!), mcp: est(mcpBlock), deferred: 2, hooks: 4 })
    assert.equal(birth.shares['orchestrator'], est(skillLines[0]!))
    assert.equal(birth.shares['norms'], est(skillLines[2]!) + est(agentLines[0]!))
    assert.equal(birth.shares['github'], est(mcpBlock))
    assert.equal(birth.shares[BARE], est(skillLines[1]!) + est(agentLines[1]!))
    assert.equal(owned(birth), est(skillLines[0]!) + est(skillLines[2]!) + est(agentLines[0]!) + est(mcpBlock))
    assert.equal(remainder(birth), 1502 - Object.values(birth.parts).reduce((sum, tokens) => sum + tokens, 0))
  })

  it('refuses a transcript with a line before the first call that is not a JSON object, rather than report a later call', () => {
    assert.throws(() => parseBirth('s6', ['{"type":', call('2026-11-16T10:00:00Z', 1, 2, 3)]), /s6: a line before the first model call is not JSON/)
    assert.throws(() => parseBirth('s7', ['[]', call('2026-11-16T10:00:00Z', 1, 2, 3)]), /not an object/)
    assert.equal(parseBirth('s8', [call('2026-11-16T10:00:00Z', 1, 2, 3), '{"type":'])?.tokens, 6)
  })

  it('gives a session of no known title the role plain, and nothing for a session that never called the model', () => {
    assert.equal(parseBirth('s2', [call('2026-11-16T10:00:00Z', 1, 2, 3)])?.role, 'plain')
    assert.equal(parseBirth('s3', [JSON.stringify({ type: 'custom-title', customTitle: 'a name' }), call('2026-11-16T10:00:00Z', 1, 2, 3)])?.role, 'plain')
    for (const [title, role] of [['Orch: x', 'orchestrator'], ['Coord: x', 'coordinator'], ['Audit: x', 'auditor'], [`Agent: ${'long '.repeat(10)}`, 'agent']] as const) {
      assert.equal(parseBirth('s5', [JSON.stringify({ type: 'custom-title', customTitle: title }), call('2026-11-16T10:00:00Z', 1, 2, 3)])?.role, role, title)
    }
    assert.equal(parseBirth('s4', [attachment({ type: 'skill_listing', content: '- a: b' })]), undefined)
  })
})

describe('reading transcripts', () => {
  const put = (root: string, path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }

  it('yields every line of a file longer than one chunk, the last one without a newline', () => {
    const root = mkdtempSync(join(tmpdir(), 'birth-'))
    const long = Array.from({ length: 3000 }, (_, i) => `${i}:${'x'.repeat(60)}`)
    put(root, 'long.jsonl', long.join('\n'))
    assert.deepEqual([...headLines(join(root, 'long.jsonl'))], long)
    const accents = ['é'.repeat(40000), 'x'.repeat(5), '🙂'.repeat(10000), 'last']
    put(root, 'accents.jsonl', accents.join('\n'))
    assert.deepEqual([...headLines(join(root, 'accents.jsonl'))], accents)
    put(root, 'empty.jsonl', '')
    assert.deepEqual([...headLines(join(root, 'empty.jsonl'))], [])
  })

  it('reads each session of each project, in time order, and leaves a subagent\'s transcript and any other file alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'birth-'))
    put(root, 'p1/b.jsonl', call('2026-11-16T11:00:00Z', 1, 1, 1))
    put(root, 'p1/a.jsonl', call('2026-11-16T10:00:00Z', 1, 1, 2))
    put(root, 'p1/a/subagents/c.jsonl', call('2026-11-16T09:00:00Z', 1, 1, 1))
    put(root, 'p1/notes.txt', 'x')
    put(root, 'p2/none.jsonl', JSON.stringify({ type: 'user' }))
    put(root, 'loose.jsonl', call('2026-11-16T08:00:00Z', 1, 1, 1))
    const read = readBirths(root)
    assert.deepEqual(read.births.map(birth => [birth.session, birth.tokens]), [['a', 4], ['b', 3]])
    assert.equal(read.withoutCall, 1)
    assert.equal(read.unreadable, 0)
    put(root, 'p2/broken.jsonl', 'not json\n' + call('2026-11-16T12:00:00Z', 1, 1, 1))
    assert.equal(readBirths(root).unreadable, 1)
  })
})

describe('periods and medians', () => {
  it('takes the median of an odd, an even and an empty list', () => {
    assert.equal(median([5, 1, 3]), 3)
    assert.equal(median([1, 2, 3, 10]), 3)
    assert.equal(median([]), undefined)
  })

  it('keeps the oldest sessions of each role before the record, those up to the cut, and those after it', () => {
    const births = [
      born('2026-10-01T00:00:00Z', 'agent', 10), born('2026-10-02T00:00:00Z', 'agent', 20), born('2026-10-03T00:00:00Z', 'agent', 30),
      born('2026-10-01T00:00:00Z', 'orchestrator', 40),
      born('2026-11-15T00:00:00Z', 'agent', 50), born('2026-11-16T00:00:00Z', 'agent', 60), born('2026-11-16T12:00:00Z', 'agent', 70),
    ]
    const out = periods(births, '2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z', 2)
    assert.deepEqual(out.baseline.map(birth => birth.tokens), [10, 40, 20])
    assert.deepEqual(out.before.map(birth => birth.tokens), [50])
    assert.deepEqual(out.after.map(birth => birth.tokens), [60, 70])
  })

  it('orders instants, not strings: a time with milliseconds comes before the same second without them', () => {
    const out = periods([born('2026-11-16T10:00:00.500Z', 'agent', 1), born('2026-11-16T10:00:00Z', 'agent', 2)], '2026-11-16T00:00:00Z', '2026-11-16T10:00:00.250Z', 30)
    assert.deepEqual(out.before.map(birth => birth.tokens), [2])
    assert.deepEqual(out.after.map(birth => birth.tokens), [1])
  })

  it('finds the last deploy that changed a plugin, and none when no deploy did', () => {
    const history = [{ commit: 'c3', at: '2026-11-16T03:00:00Z' }, { commit: 'c1', at: '2026-11-16T01:00:00Z' }, { commit: 'c2', at: '2026-11-16T02:00:00Z' }]
    const changed = (plugin: string, from: string, to: string) => plugin === 'a' && from === 'c1' && to === 'c2'
    assert.deepEqual(lastDeployOf('a', history, changed), { commit: 'c2', at: '2026-11-16T02:00:00Z' })
    assert.equal(lastDeployOf('b', history, changed), undefined)
  })
})

describe('the report', () => {
  it('sets each period against the others, per role, part and owner, and by day', () => {
    const groups = periods([
      born('2026-10-01T00:00:00Z', 'agent', 900, 100, { norms: 50, [BARE]: 10, silent: 0 }),
      born('2026-11-15T10:00:00Z', 'agent', 800, 100, { norms: 40 }),
      born('2026-11-16T10:00:00Z', 'agent', 700, 200, { norms: 30 }),
      born('2026-11-16T11:00:00Z', 'plain', 600, 0),
    ], '2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z', 30)
    const text = report(groups, '2026-11-16T00:00:00Z', 'the catalogue').join('\n')
    assert.match(text, /^Last deploy of the catalogue: 2026-11-16T00:00:00Z/)
    assert.match(text, /\| agent \| 900 \(1\) \| 800 \(1\) \| 700 \(1\) \|/)
    assert.match(text, /\| plain \| — \| — \| 600 \(1\) \|/)
    assert.match(text, /\| agent \| 800 \(1\) \| 700 \(1\) \| 500 \(1\) \|/)
    assert.match(text, /\| norms \| 50 \(1\) \| 40 \(1\) \| 15 \(2\) \|/)
    assert.match(text, /\| 2026-11-16 \| 2 \| 550 \| 15 \|/)
    assert.match(text, /\| host prompt, tool schemas, first prompt \| 800 \(1\) \| 700 \(1\) \| 550 \(2\) \|/)
    assert.match(text, /\| norms \|[^\n]*\n\| \(no plugin\) \| 10 \(1\) \| 0 \(1\) \| 0 \(2\) \|\n/)
    assert.ok(!/\| silent \|/.test(text))
    assert.match(text, /\| instructions \| 100 \(1\) \| 100 \(1\) \| 100 \(2\) \|/)
  })
})

describe('npm run birth', () => {
  const root = mkdtempSync(join(tmpdir(), 'birth-run-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q')
  mkdirSync(join(root, 'plugins', 'a'), { recursive: true })
  mkdirSync(join(root, 'plugins', 'b'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'a', 'f'), '1')
  writeFileSync(join(root, 'plugins', 'b', 'f'), '1')
  mkdirSync(join(root, 'plugins', 'c'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'c', 'f'), '1')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  const one = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'plugins', 'a', 'f'), '2')
  git('commit', '-q', '-a', '-m', 'two')
  const two = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'plugins', 'b', 'f'), '2')
  git('commit', '-q', '-a', '-m', 'three')
  const three = git('rev-parse', 'HEAD')

  const state = join(root, 'installed.json')
  writeFileSync(state, JSON.stringify({ version: 1, repo: 'o/r', marketplace: 'lounisbou', history: [{ commit: three, at: '2026-11-16T12:00:00Z' }, { commit: two, at: '2026-11-16T09:00:00Z' }, { commit: one, at: '2026-11-16T06:00:00Z' }], skipped: [], pending: false, plugins: {} }))
  const projects = join(root, 'projects')
  mkdirSync(join(projects, 'p'), { recursive: true })
  const session = (name: string, at: string, tokens: number) => writeFileSync(join(projects, 'p', `${name}.jsonl`), [JSON.stringify({ type: 'custom-title', customTitle: 'Agent: x' }), call(at, tokens, 0, 0)].join('\n'))
  session('old', '2026-11-01T00:00:00Z', 900)
  session('mid', '2026-11-16T07:00:00Z', 800)
  session('new', '2026-11-16T10:00:00Z', 700)
  session('last', '2026-11-16T13:00:00Z', 600)

  const exec = (args: string[], changed?: (plugin: string, from: string, to: string) => boolean) => {
    const out: string[] = []
    const err: string[] = []
    const io = { out: (l: string) => { out.push(l) }, err: (l: string) => { err.push(l) }, env: {} }
    const all = ['--projects', projects, '--state', state, ...args]
    const code = changed === undefined ? run(root, all, io) : run(root, all, io, changed)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('measures since the last deploy of the catalogue', () => {
    const { code, out } = exec([])
    assert.equal(code, 0)
    assert.match(out, /Last deploy of the catalogue: 2026-11-16T12:00:00Z/)
    assert.match(out, /\| agent \| 900 \(1\) \| 750 \(2\) \| 600 \(1\) \|/)
  })

  it('measures since the last deploy that changed one plugin, asking git which one', () => {
    assert.match(exec(['--plugin', 'a']).out, /Last deploy of a: 2026-11-16T09:00:00Z[^]*\| agent \| 900 \(1\) \| 800 \(1\) \| 650 \(2\) \|/)
    assert.match(exec(['--plugin', 'b']).out, /Last deploy of b: 2026-11-16T12:00:00Z/)
    const unchanged = exec(['--plugin', 'c']).out
    assert.match(unchanged, /No deploy of c changed it since the first record/)
    assert.match(unchanged, /Last deploy of c: 2026-11-16T06:00:00Z/)
    const missing = exec(['--plugin', 'nonexistent'])
    assert.equal(missing.code, 1)
    assert.match(missing.err, /--plugin: no plugins\/nonexistent/)
  })

  it('reports a plugin\'s deploy through the comparison it is given, and git\'s failure on a commit it does not know', () => {
    assert.match(exec(['--plugin', 'a'], () => false).out, /Last deploy of a: 2026-11-16T06:00:00Z/)
    writeFileSync(join(root, 'state-unknown.json'), JSON.stringify({ version: 1, repo: 'o/r', marketplace: 'lounisbou', history: [{ commit: 'f'.repeat(40), at: '2026-11-16T12:00:00Z' }, { commit: 'e'.repeat(40), at: '2026-11-16T09:00:00Z' }], skipped: [], pending: false, plugins: {} }))
    const result = exec(['--state', join(root, 'state-unknown.json'), '--plugin', 'a'])
    assert.equal(result.code, 1)
    assert.match(result.err, /^birth: git cannot compare eeeeeeee and ffffffff/)
  })

  it('refuses a baseline that is not a whole number, and a deploy record it cannot read', () => {
    assert.equal(exec(['--baseline', '0']).code, 1)
    assert.match(exec(['--baseline', 'x']).err, /--baseline/)
    assert.equal(exec(['--baseline', '1e1']).code, 1)
    assert.match(exec([]).out, /Sessions: 4 read, 0 without a model call, 0 unreadable/)
    assert.match(exec(['--baseline', '1']).out, /\| agent \| 900 \(1\)/)
    const missing = exec(['--state', join(root, 'absent.json')])
    assert.equal(missing.code, 1)
    assert.match(missing.err, /^birth: /)
  })
})
