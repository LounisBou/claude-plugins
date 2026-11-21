// Each contract between plugins, tested across its owner and its readers: what the owner
// writes, core's reader accepts (docs/contracts.md).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DECK_FILE, DECK_VERSION, deckSessions, parseDeck } from '../packages/core/src/deck.ts'
import { DECK_READER_CONTRACT, DECK_STALE_AFTER_MS } from '../packages/core/src/deck-reader.ts'
import { parseJournalEvent } from '../packages/core/src/learning.ts'
import { currentSessionName, NAMES_CONTRACT, parseSessionName, roleOf } from '../packages/core/src/names.ts'
import { DATA_ROOT_FILE, dataRootOf, gateTokensOf, measureFilePath, MEASURE_VERSION, ROUND_DIR, SPAWN_TIMEOUT_MS, type MeasureReading } from '../packages/core/src/orchestration.ts'
import { accepts, parsePrRecord } from '../packages/core/src/pr-record.ts'
import { parseQuota, quotaFilePath, QUOTA_CONTRACT, quotaLine } from '../packages/core/src/quota.ts'
import { CI_CHECK } from '../packages/core/src/readiness.ts'
import { parseRoundQuestion, ROUND_READER_CONTRACT } from '../packages/core/src/round-question.ts'
import { planAsked, planClaimed, planPane, planRelayed, planWithdrawal, type Fields, type Plan } from '../plugins/orchestrator/hooks/settle.ts'
import { DECK_REFRESH_MS } from '../plugins/orchestrator/hooks/deck.ts'
import { GOLDEN_DECK } from '../plugins/orchestrator/hooks/tests/golden-deck.ts'

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

  it('reads the tests record of the light CI, and takes it from no other producer', () => {
    const config = mkdtempSync(join(tmpdir(), 'records-tests-'))
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config }
    const write = (producer: string, result: string): string =>
      execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'Owner/Name', '--pr', '7', '--head', 'a'.repeat(40), '--producer', producer, '--session', 's', '--kind', 'tests', '--result', result, '--detail', 'npm test — exit 0 — 3s — 12 tests'],
        { env, encoding: 'utf8', stdio: 'pipe' }).trim()
    for (const result of ['pass', 'fail']) {
      const path = write('light-ci', result)
      const record = parsePrRecord(JSON.parse(readFileSync(path, 'utf8')))
      assert.ok(record && accepts(record) === (result === 'pass'), path)
      assert.deepEqual([record.kind, record.producer, record.result, record.repo, record.head], ['tests', 'light-ci', result, 'owner/name', 'a'.repeat(40)])
    }
    // Another producer: record.py refuses to write it, and core's reader accepts one written by hand no more.
    assert.throws(() => write('pr-review', 'pass'))
    const forged = parsePrRecord({ ...JSON.parse(readFileSync(write('light-ci', 'pass'), 'utf8')), producer: 'pr-review' })
    assert.ok(forged && !accepts(forged))
    rmSync(config, { recursive: true, force: true })
  })

  it('and github refuses what the contract refuses', () => {
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'review', '--result', 'waived'], { stdio: 'pipe' }))
    const none = ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--result', 'not-applicable']
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'review', '--detail', 'documentation only'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', [...none, '--kind', 'e2e'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync('python3', ['plugins/github/engine/record.py', '--repo', 'o/n', '--pr', '7', '--head', 'a'.repeat(40), '--producer', 'x', '--kind', 'norms', '--result', 'accepted'], { stdio: 'pipe' }))
  })
})

describe('deck.json: the orchestrator writes, core reads', () => {
  it('reads the deck the orchestrator writes, byte for byte, and lists its sessions', () => {
    const deck = parseDeck(GOLDEN_DECK)
    assert.ok(deck)
    assert.equal(deck.version, DECK_VERSION)
    assert.deepEqual(deckSessions(deck).map(session => session.key), ['sessions/s-coord', 'sessions/s-orch', 'sessions/s-agent', 'remote/Orch: far', 'sessions/s-loose'])
    assert.equal(deck.orchestrators[0]?.waiting?.kind, 'operator')
    assert.equal(deckSessions({ ...deck, coordinator: null }).length, 4)
  })

  it('reads no deck from a file caught mid-write, another version or a field of another shape', () => {
    const golden: Record<string, unknown> = JSON.parse(GOLDEN_DECK)
    assert.equal(parseDeck(GOLDEN_DECK.slice(0, 200)), null)
    assert.equal(parseDeck('[]'), null)
    assert.equal(parseDeck('null'), null)
    for (const over of [{ version: DECK_VERSION + 1 }, { orchestrators: [{ name: 'Orch: x' }] }, { round: { open: '1', urgent: 0, oldest_since: null } }, { sleeping: 'none' }, { coordinator: undefined }]) {
      assert.equal(parseDeck(JSON.stringify({ ...golden, ...over })), null, JSON.stringify(over))
    }
  })
})

describe('deck.json: the orchestrator writes, statusbar reads the open questions', () => {
  const show = (deck: string, name = 'Coord: machine'): string => {
    const state = mkdtempSync(join(tmpdir(), 'deck-state-'))
    writeFileSync(join(state, DECK_FILE), deck)
    const config = join(state, 'statusline-config.txt')
    writeFileSync(config, 'SHOW_DIRECTORY=0\nSHOW_BRANCH=0\nSHOW_PR=0\nSHOW_MODEL=0\nSHOW_SESSION_NAME=0\nSHOW_CONTEXT=0\nSHOW_USAGE=0\nSHOW_LINES_CHANGED=0\n')
    try {
      // The script's exit status follows its last line: 1 when the second line is empty, as here.
      return spawnSync('bash', ['plugins/statusbar/statusline/statusline.sh'], {
        input: JSON.stringify({ session_name: name }), encoding: 'utf8', env: { ...process.env, ORCHESTRATOR_STATE_DIR: state, STATUSBAR_CONFIG: config },
      }).stdout.replace(/\x1b\[[0-9;]*m/g, '').trim()
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  }

  it('shows the count of the round the orchestrator writes, while the file is fresh', () => {
    const fresh = (age: number): string => GOLDEN_DECK.replace('2026-10-28T14:00:00.000Z', new Date(Date.now() - age).toISOString())
    assert.equal(show(fresh(1_000)), '✋ 1 (1 urgent)')
    assert.equal(show(fresh(DECK_STALE_AFTER_MS + 60_000)), '✋ 1? (1 urgent)')
    assert.equal(show(GOLDEN_DECK), '✋ 1? (1 urgent)')
  })

  it('shows it to the sessions that handle the operator\'s questions only', () => {
    const fresh = GOLDEN_DECK.replace('2026-10-28T14:00:00.000Z', new Date().toISOString())
    assert.equal(show(fresh, 'Coord: machine'), '✋ 1 (1 urgent)')
    // An orchestrator and an auditor count the questions they asked, never the machine's total.
    assert.equal(show(fresh, 'Orch: Claude plugins'), '')
    assert.equal(show(fresh, 'Audit: method'), '')
    assert.equal(show(fresh, ''), '')
    assert.equal(show(fresh, 'Agent: statusbar'), '')
  })

  it('keeps its bound above the orchestrator\'s refresh, so a live file is never taken for a frozen one', () => {
    assert.ok(DECK_STALE_AFTER_MS >= 2 * DECK_REFRESH_MS)
  })

  it('reads the file name, the version and the bound from the data core writes', () => {
    const data: unknown = JSON.parse(readFileSync('plugins/statusbar/core/deck-reader.json', 'utf8'))
    assert.deepEqual(data, { $comment: (data as { $comment: string }).$comment, ...DECK_READER_CONTRACT })
  })
})

describe('quota files: statusbar writes, core reads', () => {
  const ACCOUNT = '97b96c6c-03c9-4e84-bd43-34a597fa667c'

  it('reads the file the status line keeps from the payload\'s rate limits, and says its line', () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-'))
    const config = join(root, '.claude-bis')
    const state = join(root, 'state')
    mkdirSync(config)
    mkdirSync(state)
    writeFileSync(join(config, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }))
    const reset = Math.floor(Date.now() / 1000) + 3600
    try {
      const run = spawnSync('bash', ['plugins/statusbar/statusline/statusline.sh'], {
        input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 41.6, resets_at: reset }, seven_day: { used_percentage: 7, resets_at: reset + 86400 } } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, ORCHESTRATOR_STATE_DIR: state },
      })
      assert.equal(run.status, 0)
      const quota = parseQuota(JSON.parse(readFileSync(quotaFilePath(state, ACCOUNT), 'utf8')))
      assert.ok(quota)
      assert.deepEqual([quota.account, quota.config, quota.five_hour, quota.seven_day], [ACCOUNT, config, { used_percentage: 41.6, resets_at: reset }, { used_percentage: 7, resets_at: reset + 86400 }])
      assert.match(quotaLine(quota, root, Date.now()), /^quota plan2 \| 5h 42% \| 7d 7% \| read \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the directory, the version and the refresh from the data core writes', () => {
    const data: unknown = JSON.parse(readFileSync('plugins/statusbar/core/quota.json', 'utf8'))
    assert.deepEqual(data, { $comment: (data as { $comment: string }).$comment, ...QUOTA_CONTRACT })
  })
})

describe('round entries: the orchestrator writes, statusbar counts the session\'s own open questions', () => {
  const SESSION = '60ed5626-9879-4041-892a-5db0ff0bad69'
  const NAME = 'Orch: demo'
  const choices = [{ letter: 'A', text: 'Ship it now' }, { letter: 'B', text: 'Wait for the review' }]
  // The object `ask` stores (question.ts `askedEntry`) and the entry the relay writes (round.ts `roundEntry`), open.
  const asked = (id: string, name: string, session: string, urgent = false): Record<string, unknown> => ({
    v: 2, id, sender: { session, name, role: 'orchestrator', machine: 'here' }, subject: 's', context: 'c', ask: 'Ship?', choices, recommended: 'B', why: 'w',
    blocks: 's', status: 'open', at: '2026-11-15T10:00:00.000Z', answer: null, seq: 1, ...(urgent ? { urgent: true } : {}),
  })
  const relayed = (id: string, name: string, session: string, kind: string): Record<string, unknown> => ({
    id, from: name, session, kind, since: '2026-11-15T10:00:00.000Z', blocks: null, question: 'words', choices, recommendation: 'A', status: 'open', at: '2026-11-15T10:00:01.000Z', answer: null,
  })
  const show = (entries: Record<string, unknown>[], name: string, session: string): string => {
    const state = mkdtempSync(join(tmpdir(), 'round-state-'))
    mkdirSync(join(state, ROUND_DIR))
    for (const entry of entries) writeFileSync(join(state, ROUND_DIR, `${String(entry['id'])}.json`), JSON.stringify(entry))
    const config = join(state, 'statusline-config.txt')
    writeFileSync(config, 'SHOW_DIRECTORY=0\nSHOW_BRANCH=0\nSHOW_PR=0\nSHOW_MODEL=0\nSHOW_SESSION_NAME=0\nSHOW_CONTEXT=0\nSHOW_USAGE=0\nSHOW_LINES_CHANGED=0\n')
    try {
      return spawnSync('bash', ['plugins/statusbar/statusline/statusline.sh'], {
        input: JSON.stringify({ session_name: name, session_id: session }), encoding: 'utf8', env: { ...process.env, ORCHESTRATOR_STATE_DIR: state, STATUSBAR_CONFIG: config },
      }).stdout.replace(/\x1b\[[0-9;]*m/g, '').trim()
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  }

  it('reads the directory and the words from the data core writes', () => {
    const data: unknown = JSON.parse(readFileSync('plugins/statusbar/core/round-reader.json', 'utf8'))
    assert.deepEqual(data, { $comment: (data as { $comment: string }).$comment, ...ROUND_READER_CONTRACT })
    assert.equal(ROUND_READER_CONTRACT.dir, ROUND_DIR)
  })

  it('counts, of the entries both writers store, the open questions to the operator that its session asked', () => {
    const entries = [
      asked('q-1', NAME, SESSION), asked('q-2', NAME, SESSION, true), asked('q-3', 'Orch: other', 'other-session', true),
      relayed('r-1', NAME, SESSION, 'operator'), relayed('r-2', NAME, SESSION, 'done'), relayed('r-3', 'Orch: other', 'other-session', 'operator'),
    ]
    // Its own reader and the shell's agree on whose they are.
    const mine = entries.filter(entry => parseRoundQuestion(entry)?.asker === NAME && parseRoundQuestion(entry)?.kind === 'operator')
    assert.equal(mine.length, 3)
    assert.equal(show(entries, NAME, SESSION), '✋ 3 (1 urgent)')
    assert.equal(show(entries, 'Orch: other', 'other-session'), '✋ 2 (1 urgent)')
    assert.equal(show(entries, NAME, 'a-successor'), '✋ 3 (1 urgent)')
    assert.equal(show(entries, 'Orch: renamed', SESSION), '✋ 3 (1 urgent)')
    assert.equal(show(entries, 'Orch: nobody', 'nobody'), '')
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

describe('spawn: the launcher waits, its callers allow it', () => {
  it('holds the callers\' deadline above the launcher\'s worst case, a refused spawn', () => {
    const source = readFileSync('plugins/orchestrator/skills/iterm-agents/scripts/iterm_agent.py', 'utf8')
    const seconds = (name: string): number => {
      const found = new RegExp(`os\\.environ\\.get\\("ORCHESTRATOR_${name}", "(\\d+)"\\)`).exec(source)
      assert.ok(found?.[1], name)
      return Number(found[1])
    }
    // The host's start, the transcript's wait, the screen read, and the tab's close (twice its wait on the process).
    const worst = seconds('SPAWN_TIMEOUT') + seconds('MODE_TIMEOUT') + seconds('PROBE_TIMEOUT') + 2 * seconds('CLOSE_TIMEOUT')
    assert.ok(SPAWN_TIMEOUT_MS >= (worst + 15) * 1000, `${SPAWN_TIMEOUT_MS} ms against a worst case of ${worst} s`)
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
    copyFileSync(LAUNCHER.replace('iterm_agent.py', 'conversation_tail.py'), join(scripts, 'conversation_tail.py'))
    copyFileSync('plugins/orchestrator/core/store.json', join(plugin, 'core', 'store.json'))
    copyFileSync('plugins/orchestrator/core/launcher.json', join(plugin, 'core', 'launcher.json'))
    copyFileSync('plugins/orchestrator/core/roots.json', join(plugin, 'core', 'roots.json'))
    const roles = { Lead: 'orchestrator', Desk: 'coordinator', Check: 'auditor', Hand: 'agent' }
    assert.deepEqual(Object.values(roles).sort(), Object.values(NAMES_CONTRACT.roles).sort())
    writeFileSync(join(plugin, 'core', 'names.json'), JSON.stringify({ ...NAMES_CONTRACT, roles, subject: '\\S{1,3}' }))
    assert.deepEqual(launcher(scripts, ['Lead: abc', 'Hand : ab', 'Desk: abcd', 'Orch: abc']), [
      ['orchestrator', true, 'Lead: abc'], ['agent', true, 'Hand: ab'], ['coordinator', false, 'Desk: abcd'], [null, false, 'Orch: abc'],
    ])
    rmSync(plugin, { recursive: true, force: true })
  })
})

describe('the data root: core owns the rule, the launcher, gate.py and statusline.sh read it as data', () => {
  // Each case: the data-root file's text or bytes (null: no file), and the data root every reader must give.
  const good = (dir: string): string => JSON.stringify({ version: 1, dir })
  const bytes = (before: string, byte: number, after: string): Buffer => Buffer.concat([Buffer.from(before), Buffer.from([byte]), Buffer.from(after)])
  const CASES: readonly [string | Buffer | null, string | null][] = [
    [null, null], ['{', null], ['null', null], ['[]', null], ['"x"', null], ['', null],
    [JSON.stringify({ version: 2, dir: '/tmp/d' }), null], [JSON.stringify({ version: '1', dir: '/tmp/d' }), null],
    [JSON.stringify({ version: true, dir: '/tmp/d' }), null], [JSON.stringify({ version: 1 }), null], [JSON.stringify({ version: 1, dir: 5 }), null],
    [good(''), null], [good('/'), null], [good('//'), null], [good('relative/dir'), null], [good('~/x'), null],
    [good('/a\nb'), null], [good('/a\n'), null], [good('/a\tb'), null], [good('/a\u007f'), null], [good('/a\u0000b'), null],
    [`${good('/tmp/x')} ${good('/tmp/y')}`, null],
    // What one JSON parser takes and another refuses: a byte-order mark, a literal no standard knows, a number
    // spelt loosely, a raw control character or an unknown escape in a string, bytes that are no UTF-8 (read
    // as U+FFFD by some, refused by others), an escaped lone surrogate, a nested value, a blank that is no
    // JSON blank.
    [`﻿${good('/tmp/x')}`, null],
    ['{"version": 1, "dir": "/tmp/x", "n": NaN}', null], ['{"version": 1, "dir": "/tmp/x", "n": -Infinity}', null],
    ['{"version": 01, "dir": "/tmp/x"}', null], ['{"version": +1, "dir": "/tmp/x"}', null], ['{"version": 1., "dir": "/tmp/x"}', null],
    ['{"version": 1, "dir": "/tmp/x", "n": "a\tb"}', null], ['{"version": 1, "dir": "/tmp/x", "n": "\\q"}', null],
    [bytes('{"version": 1, "dir": "/tmp/x", "n": "', 0xff, '"}'), null], [bytes('{"version": 1, "dir": "/tmp/', 0xff, '"}'), null],
    ['{"version": 1, "dir": "/tmp/x", "n": "�"}', null], ['{"version": 1, "dir": "/tmp/\\ud800"}', null],
    ['{"version": 1, "dir": "/tmp/x", "m": {"a": 1}}', null], [`\u000b${good('/tmp/x')}`, null], [` ${good('/tmp/x')}`, null],
    [good('/tmp/shared'), '/tmp/shared'], [good('/tmp/shared/'), '/tmp/shared'], [good('/tmp/a//'), '/tmp/a'],
    [good('//tmp/a'), '//tmp/a'], [good('/tmp/a b'), '/tmp/a b'], [good('/tmp/é/x'), '/tmp/é/x'],
    ['{"version": 1, "dir": "/tmp/\\u00e9"}', '/tmp/é'], ['{"version": 1, "dir": "\\/tmp\\/s"}', '/tmp/s'],
    ['{\n  "version": 1.0,\r\n\t"dir": "/tmp/k", "note": "x", "n": -1.5e3, "t": true, "z": null\n}\n', '/tmp/k'],
  ]

  it('gives the same data root from every reader, for every file', () => {
    const work = mkdtempSync(join(tmpdir(), 'data-root-'))
    const roots = CASES.map(([text], i) => {
      const root = join(work, `p${i}`)
      mkdirSync(root)
      if (text !== null) writeFileSync(join(root, DATA_ROOT_FILE), text)
      return root
    })
    const expected = CASES.map(([, dir], i) => dir ?? roots[i]!)
    const lines = (text: string): string[] => text.split('\n').slice(0, roots.length)
    const env = { ...process.env, HOME: work, CLAUDE_CONFIG_DIR: work, ORCHESTRATOR_STATE_DIR: work }
    const core = roots.map(root => dataRootOf(root, (() => { try { return readFileSync(join(root, DATA_ROOT_FILE), 'utf8') } catch { return undefined } })()))
    const launcher = execFileSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import iterm_agent as m; print("\\n".join(m.data_root_of(r) for r in sys.argv[2:]))',
      'plugins/orchestrator/skills/iterm-agents/scripts', ...roots], { env, encoding: 'utf8' })
    const gate = execFileSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; from bugs_bot.gate import _data_root; print("\\n".join(str(_data_root(Path(r))) for r in sys.argv[2:]))',
      'plugins/bugs-bot', ...roots], { env, encoding: 'utf8' })
    const statusline = execFileSync('bash', ['-c', 'here=$1; shift; eval "$(sed -n \'/^data_root() {/,/^}/p\' "$here/statusline.sh")"; for root; do data_root "$root"; done',
      '_', 'plugins/statusbar/statusline', ...roots], { env, encoding: 'utf8' })
    assert.deepEqual(core, expected)
    assert.deepEqual(lines(launcher), expected)
    assert.deepEqual(lines(gate), expected)
    assert.deepEqual(lines(statusline), expected)
    rmSync(work, { recursive: true, force: true })
  })
})

describe('readiness: the CI check GitHub requires is the workflow\'s aggregator job', () => {
  // The workflow's jobs, by id: each job's `name`, `needs` and `if`, read from its two-space block.
  const jobs = (text: string): Map<string, { name?: string; needs: string[]; when?: string }> => {
    const found = new Map<string, { name?: string; needs: string[]; when?: string }>()
    const block = text.slice(text.indexOf('\njobs:\n') + 7)
    let current: { name?: string; needs: string[]; when?: string } | undefined
    for (const line of block.split('\n')) {
      const id = /^ {2}([\w-]+):\s*$/.exec(line)
      if (id) found.set(id[1]!, current = { needs: [] })
      const field = /^ {4}(name|needs|if):\s*(.*)$/.exec(line)
      if (!current || !field) continue
      if (field[1] === 'name') current.name = field[2]!.trim()
      if (field[1] === 'if') current.when = field[2]!.trim()
      if (field[1] === 'needs') current.needs = field[2]!.replace(/[[\]]/g, '').split(',').map((n) => n.trim()).filter(Boolean)
    }
    return found
  }

  it('names the check core\'s contract gives, needs every other job, and runs whatever they ended', () => {
    const all = jobs(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const [id, aggregator] = [...all].find(([, job]) => job.name === CI_CHECK) ?? []
    assert.ok(id && aggregator, 'no job named ' + CI_CHECK)
    assert.deepEqual([...aggregator.needs].sort(), [...all.keys()].filter((other) => other !== id).sort())
    assert.equal(aggregator.when, 'always()')
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
    assert.equal(events.length, 15)
    assert.ok(events.every(event => event !== undefined))
    // Each of the eight writes is published as a dispatch event beside its step, link or escape.
    assert.deepEqual(events.map(event => event?.kind).sort(), [...Array(8).fill('dispatch'), 'escape', 'link', 'link', 'step', 'step', 'step', 'step'])
    rmSync(config, { recursive: true, force: true })
  })
})

describe('round questions: the orchestrator settles, core reads', () => {
  const SESSION = '60ed5626-9879-4041-892a-5db0ff0bad69'
  const AT = '2026-11-15T10:05:00.000Z'
  const choices = [{ letter: 'A', text: 'Ship it now' }, { letter: 'B', text: 'Wait for the review' }]
  // The object `ask` stores (question.ts `askedEntry`) and the entry the relay writes (round.ts `roundEntry`), open.
  const asked: Fields = {
    v: 2, id: 'q-60ed5626-987-mhz1abcd-0f3k', sender: { session: SESSION, name: 'Orch: demo [a1b2c3]', role: 'orchestrator', machine: 'here' },
    subject: 'the release', context: 'words', ask: 'Ship?', choices, recommended: 'B', why: 'words', blocks: 'the release', status: 'open', at: '2026-11-15T10:00:00.000Z', answer: null, seq: 1,
  }
  const relayed: Fields = {
    id: `${SESSION}-0badf00d`, from: 'Orch: demo [a1b2c3]', session: SESSION, kind: 'done', since: '2026-11-15T10:00:00.000Z', blocks: null, question: 'words',
    choices, recommendation: 'A', status: 'open', at: '2026-11-15T10:00:01.000Z', answer: null,
  }
  const asker = { session: SESSION, name: 'Orch: demo [a1b2c3]', role: 'orchestrator' }
  const coordinator = { session: 'c', name: 'Coord: machine', role: 'coordinator' }
  const written = (plan: Plan | { error: string } | null): unknown => {
    assert.ok(plan !== null && !('error' in plan), JSON.stringify(plan))
    return JSON.parse(JSON.stringify(plan.entry))
  }

  it('reads both open forms, and every close the settle plans write, with who settled it and the letter', () => {
    assert.deepEqual([parseRoundQuestion(asked)?.status, parseRoundQuestion(relayed)?.kind], ['open', 'done'])
    const closes: [unknown, string, string, boolean, string | null][] = [
      [written(planPane(asked, 'Ship it now', coordinator, AT)), 'answered', 'pane', false, 'A'],
      [written(planClaimed({ ...asked, claimed: { typed: 'b', at: AT } }, AT)), 'answered', 'tab', false, 'B'],
      [written(planAsked(asked, { id: String(asked['id']), outcome: 'answered-here', text: 'something else', author: null, work: null }, asker, AT)), 'answered', 'tab', false, null],
      [written(planAsked(asked, { id: String(asked['id']), outcome: 'answered-by-message', text: 'A', author: 'Coord: machine', work: null }, asker, AT)), 'answered', 'message', false, 'A'],
      [written(planAsked(asked, { id: String(asked['id']), outcome: 'withdrawn', text: 'moot', author: null, work: null }, coordinator, AT)), 'withdrawn', 'coordinator', true, null],
      [written(planWithdrawal(asked, 'its session ended', AT, false)), 'withdrawn', 'sender', true, null],
      [written(planWithdrawal(relayed, 'its session ended', AT, true)), 'closed', 'sender', true, null],
      [written(planRelayed(relayed, { id: String(relayed['id']), outcome: 'answered-here', text: 'A', author: null, work: null }, coordinator, AT, true)), 'closed', 'coordinator', false, 'A'],
      [written(planRelayed(relayed, { id: String(relayed['id']), outcome: 'withdrawn', text: 'merged meanwhile', author: null, work: null }, coordinator, AT, true)), 'closed', 'coordinator', true, null],
    ]
    for (const [entry, status, by, withdrawn, letter] of closes) {
      const read = parseRoundQuestion(entry)
      assert.deepEqual([read?.status, read?.session, read?.asker, read?.answer], [status, SESSION, 'Orch: demo [a1b2c3]', { at: AT, by, withdrawn, letter }], JSON.stringify(entry))
    }
  })
})
