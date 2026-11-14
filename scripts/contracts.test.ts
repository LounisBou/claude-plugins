// Each contract between plugins, tested across its owner and its readers: what the owner
// writes, core's reader accepts (docs/contracts.md).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { parseJournalEvent } from '../packages/core/src/learning.ts'
import { currentSessionName, NAMES_CONTRACT, parseSessionName, roleOf } from '../packages/core/src/names.ts'
import { accepts, parsePrRecord } from '../packages/core/src/pr-record.ts'
import { gateTokensOf, measureFilePath, MEASURE_VERSION, type MeasureReading } from '../packages/core/src/orchestration.ts'

describe('pull request records: github writes, core reads', () => {
  it('reads every record github engine writes', () => {
    const config = mkdtempSync(join(tmpdir(), 'records-'))
    const write = (...args: string[]): string =>
      execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'Owner/Name', '--pr', '7', '--head', 'A'.repeat(40), '--producer', 'pr-review', '--session', 's', ...args],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' }).trim()
    for (const path of [
      write('--kind', 'review', '--result', 'pass'), write('--kind', 'e2e', '--result', 'waived', '--detail', 'operator, 2026-11-08'),
      write('--kind', 'e2e', '--result', 'not-applicable', '--detail', 'documentation only'),
      write('--kind', 'review', '--result', 'accepted', '--detail', 'over review.x.json: nits only'),
    ]) {
      const record = parsePrRecord(JSON.parse(readFileSync(path, 'utf8')))
      assert.ok(record && accepts(record), path)
      assert.equal(record.repo, 'owner/name')
      assert.equal(record.head, 'a'.repeat(40))
    }
  })

  it('and github refuses what the contract refuses', () => {
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'review', '--result', 'waived'], { stdio: 'pipe' }))
    const none = ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--result', 'not-applicable']
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'review', '--detail', 'documentation only'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'e2e'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'norms', '--result', 'accepted'], { stdio: 'pipe' }))
  })
})

describe('the measure file: the orchestrator writes, bugs-bot reads', () => {
  it('finds the file core names and reads its figures', () => {
    const config = mkdtempSync(join(tmpdir(), 'measure-'))
    const path = measureFilePath(config, 'abc')
    const reading: MeasureReading = {
      version: MEASURE_VERSION, context_tokens: 810_000, context_window: 1_000_000, context_percent: 81, model: 'm', updated_at: 't',
      gate_tokens: gateTokensOf(1_000_000), start: { tokens: 1, at: 't', brief: null, brief_bytes: null },
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(reading)}\n`)
    const read = execFileSync('python3', ['-c', [
      'import json, sys',
      "sys.path.insert(0, 'plugins/bugs-bot')",
      'from bugs_bot.gate import measure, measure_path',
      'env = {"CLAUDE_CONFIG_DIR": sys.argv[1], "CLAUDE_CODE_SESSION_ID": "abc"}',
      'print(json.dumps({"path": str(measure_path(env)), "figures": measure(env)}))',
    ].join('\n'), config], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(read), { path, figures: [810_000, 1_000_000] })
  })
})

describe('session names: core owns the shape, the launcher reads it', () => {
  const LAUNCHER = 'plugins/orchestrator/skills/iterm-agents/scripts/iterm_agent.py'
  // What the launcher answers of each name: the role its prefix names, whether the name has the
  // whole shape once written the current way, and that current spelling.
  const READ = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import iterm_agent as ia',
    'roles = ia.NAMES["roles"]',
    'shape = ia.name_shape(*ia.ROLE_WORDS)',
    'def read(name):',
    '    found = ia.ROLE_PREFIX.match(name)',
    '    return [roles[found.group(1)] if found else None, shape.match(ia.current_name(name)) is not None, ia.current_name(name)]',
    'print(json.dumps([read(name) for name in json.loads(sys.argv[2])]))',
  ].join('\n')
  const launcher = (dir: string, names: readonly string[]): unknown =>
    JSON.parse(execFileSync('python3', ['-I', '-c', READ, dir, JSON.stringify(names)], { encoding: 'utf8' }))

  it('reads every name as core reads it', () => {
    const names = [
      'Orch: billing', 'Coord: main', 'Audit: 1712', 'Agent: P3 cache', 'Orch : billing', 'Agent : x',
      `Orch: ${'a'.repeat(25)}`, `Orch: ${'a'.repeat(26)}`, `Agent: ${'é'.repeat(25)}`, 'Orch:x', 'Orch: ', 'Orch:  x',
      'Orch: x ', 'Orch  : x', 'Orchestra : x', ' Orch: x', 'a plain session', '', 'Coord : ops [abc123]',
    ]
    const core = names.map(name => [roleOf(name), parseSessionName(currentSessionName(name)) !== null, currentSessionName(name)])
    assert.deepEqual(launcher(LAUNCHER.replace(/\/[^/]+$/, ''), names), core)
  })

  it('takes the roles and the subject from core\'s data, not from a copy of its own', () => {
    const plugin = mkdtempSync(join(tmpdir(), 'names-'))
    const scripts = join(plugin, 'skills', 'iterm-agents', 'scripts')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(join(plugin, 'core'))
    copyFileSync(LAUNCHER, join(scripts, 'iterm_agent.py'))
    copyFileSync('plugins/orchestrator/core/store.json', join(plugin, 'core', 'store.json'))
    const roles = { Lead: 'orchestrator', Desk: 'coordinator', Check: 'auditor', Hand: 'agent' }
    assert.deepEqual(Object.values(roles).sort(), Object.values(NAMES_CONTRACT.roles).sort())
    writeFileSync(join(plugin, 'core', 'names.json'), JSON.stringify({ ...NAMES_CONTRACT, roles, subject: '\\S{1,3}' }))
    assert.deepEqual(launcher(scripts, ['Lead: abc', 'Hand : ab', 'Desk: abcd', 'Orch: abc']), [
      ['orchestrator', true, 'Lead: abc'], ['agent', true, 'Hand: ab'], ['coordinator', false, 'Desk: abcd'], [null, false, 'Orch: abc'],
    ])
    rmSync(plugin, { recursive: true, force: true })
  })
})

describe('learning events: the orchestrator\'s scripts write, core reads', () => {
  it('reads every event the dispatch record writes through its own entry point, into the configuration directory\'s journal', () => {
    const config = mkdtempSync(join(tmpdir(), 'journal-'))
    const record = join(config, 'claude-orchestrator', 'briefs', 'p', 'dispatch.jsonl')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: config, CLAUDE_CODE_SESSION_ID: 'orch-1' }
    const run = (...args: string[]): string => execFileSync('plugins/orchestrator/skills/orchestrator/scripts/dispatch-record.sh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    run('goals', record, 'init', '--spec', 'none')
    const id = run('open', record, '--class', 'feature', '--tier', 'deep').trim()
    run('review', record, id, '--head', 'a'.repeat(40))
    run('round', record, id)
    run('fixed', record, id, '--head', 'b'.repeat(7))
    run('surface', record, id, '--ui', 'acme/thing#12')
    run('escaped', record, id)
    run('close', record, id, '--verdict', 'thing#12 merged')
    const dir = join(config, 'orchestrator', 'journal')
    const events = readdirSync(dir).map(name => parseJournalEvent(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    assert.equal(events.length, 7)
    assert.ok(events.every(event => event !== undefined))
    assert.deepEqual(events.map(event => event?.kind).sort(), ['escape', 'link', 'link', 'step', 'step', 'step', 'step'])
    rmSync(config, { recursive: true, force: true })
  })
})
