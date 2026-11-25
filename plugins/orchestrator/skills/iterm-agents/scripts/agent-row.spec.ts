import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseLauncherArgs } from '../../../core/launcher.ts'
import { ledgerLines, unattended, type LedgerLine } from '../../../core/pr-ledger.ts'
import { main as reviewBrief } from '../../orchestrator/scripts/review-brief.ts'
import { run } from '../../orchestrator/scripts/lib/process.ts'
import { recordAgent, type RowDeps } from './agent-row.ts'

const STATE = '/s/claude-orchestrator'
const REGISTRY = `${STATE}/records/sess-1`
const BRIEF = '/b/phase-brief.md'
const PHASE = '# p — t\n\nYou are the implementer of row 355 of the dispatch record.\n\nRow: 355 ROWAGENT: x\n'
const open = (id: number): string => `${JSON.stringify({ id, state: 'open', label: 'X' })}\n`

const deps = (files: Record<string, string>, over: Partial<RowDeps> = {}): RowDeps & { warned: string[]; ran: string[][] } => {
  const warned: string[] = []
  const ran: string[][] = []
  return {
    env: { CLAUDE_CODE_SESSION_ID: 'sess-1', ORCHESTRATOR_STATE_DIR: STATE }, warned, ran, script: '/x/dispatch-record.sh',
    read: path => files[path] ?? null,
    list: dir => Object.keys(files).filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map(path => path.slice(dir.length + 1)),
    run: async argv => {
      ran.push([...argv])
      return { status: 0, stdout: '', stderr: '' }
    },
    warn: line => warned.push(line),
    log: async () => undefined,
    ...over,
  }
}

const spawned = (title: string, brief = BRIEF) => ({ ...parseLauncherArgs('spawn', ['--dir', '/w', '--title', title]), options: { title, start_brief: brief } })

describe('an agent put on its row by the launcher', () => {
  it('writes its name on the row its brief names, in the record beside the brief', async () => {
    const d = deps({ [BRIEF]: PHASE, [REGISTRY]: '/other/record.jsonl\n/b/record.jsonl\n', '/other/record.jsonl': open(355), '/b/record.jsonl': open(355) })
    await recordAgent(spawned('Agent: row knows'), d)
    assert.deepEqual(d.ran, [['bash', '/x/dispatch-record.sh', 'agent', '/b/record.jsonl', '355', 'Agent: row knows']])
    assert.deepEqual(d.warned, [])
  })

  it('takes the one record that holds the row open when none sits beside the brief', async () => {
    const d = deps({ [BRIEF]: PHASE, [REGISTRY]: '/r/a.jsonl\n/r/b.jsonl\n', '/r/a.jsonl': open(7), '/r/b.jsonl': open(355) })
    await recordAgent(spawned('Agent: a'), d)
    assert.deepEqual(d.ran.map(argv => argv[3]), ['/r/b.jsonl'])
  })

  it('puts a rotation\'s replacement on the row: the rotation brief names it', async () => {
    const d = deps({ [BRIEF]: '# p — resume brief for row 355: t\n', [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) })
    const rotation = { ...parseLauncherArgs('rotate', ['--old-tty', '/dev/ttys1']), rest: spawned('Agent: row knows 2') }
    await recordAgent(rotation, d)
    assert.deepEqual(d.ran, [['bash', '/x/dispatch-record.sh', 'agent', '/b/record.jsonl', '355', 'Agent: row knows 2']])
  })

  it('finds the record beside the brief for a successor that registered none', async () => {
    const d = deps({ [BRIEF]: PHASE, '/b/dispatch-record.jsonl': open(355), '/b/dispatch-record.archive.jsonl': open(355), '/b/notes.md': open(355) })
    await recordAgent(spawned('Agent: a'), d)
    assert.deepEqual(d.ran, [['bash', '/x/dispatch-record.sh', 'agent', '/b/dispatch-record.jsonl', '355', 'Agent: a']])
    assert.deepEqual(d.warned, [])
  })

  it('says it, and launches nothing more, when no registered record holds the row open or two do', async () => {
    const none = deps({ [BRIEF]: PHASE, [REGISTRY]: '/r/a.jsonl\n', '/r/a.jsonl': `${JSON.stringify({ id: 355, state: 'closed' })}\nnot json\n` })
    await recordAgent(spawned('Agent: a'), none)
    assert.deepEqual(none.ran, [])
    assert.match(none.warned[0] ?? '', /Agent: a is on no row: no dispatch record this session registered or beside its brief holds row 355 open/)
    const two = deps({ [BRIEF]: PHASE, [REGISTRY]: '/r/a.jsonl\n/r/b.jsonl\n', '/r/a.jsonl': open(355), '/r/b.jsonl': open(355) })
    await recordAgent(spawned('Agent: a'), two)
    assert.deepEqual(two.ran, [])
    assert.match(two.warned[0] ?? '', /row 355 is open in \/r\/a\.jsonl, \/r\/b\.jsonl/)
    const anon = deps({ [BRIEF]: PHASE }, { env: { ORCHESTRATOR_STATE_DIR: STATE } })
    await recordAgent(spawned('Agent: a'), anon)
    assert.match(anon.warned[0] ?? '', /no dispatch record this session registered or beside its brief/)
  })

  it('says a refused write', async () => {
    const d = deps({ [BRIEF]: PHASE, [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) }, { run: async () => ({ status: 1, stdout: '', stderr: 'ERROR: owned by Orch: other\n' }) })
    await recordAgent(spawned('Agent: a'), d)
    assert.deepEqual(d.warned, ['spawn: warning: Agent: a was not put on row 355 of /b/record.jsonl: ERROR: owned by Orch: other'])
  })

  it('leaves the launch alone when the write itself fails to run', async () => {
    const d = deps({ [BRIEF]: PHASE, [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) }, { run: async () => ({ status: null, stdout: '', stderr: '' }) })
    await recordAgent(spawned('Agent: a'), d)
    assert.match(d.warned[0] ?? '', /Agent: a was not put on row 355 of \/b\/record\.jsonl/)
  })

  it('says an unreadable brief, and writes nothing', async () => {
    const d = deps({ [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) })
    await recordAgent(spawned('Agent: a', '/b/missing.md'), d)
    assert.deepEqual(d.ran, [])
    assert.match(d.warned[0] ?? '', /Agent: a is on no row: its brief \/b\/missing\.md cannot be read/)
  })

  it('writes nothing for a launch with no brief, a title that is no agent\'s, a brief with no row, or another command', async () => {
    const files = { [BRIEF]: PHASE, '/b/review.md': '# review\nNo row here.\n', [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) }
    for (const request of [spawned('Agent: a', ''), spawned('Audit: a'), spawned('Agent: a', '/b/review.md'), parseLauncherArgs('close', ['--tty', '/dev/ttys1']), parseLauncherArgs('rotate', ['--old-tty', '/dev/ttys1'])]) {
      const d = deps(files)
      await recordAgent(request, d)
      assert.deepEqual([d.ran, d.warned], [[], []])
    }
  })
})

// The rows and the ledger lines on real files, written by the real dispatch-record.sh: what the spawn leaves in the record.
describe('an agent attached to its pull request\'s ledger line by the launcher', () => {
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'orchestrator', 'scripts', 'dispatch-record.sh')
  const AT = '2026-11-25T14:52:11Z'
  const HOUR_LATER = Date.parse(AT) + 60 * 60 * 1000
  let dir = ''
  let record = ''
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-row-')))
    record = join(dir, 'record.jsonl')
    mkdirSync(join(dir, 'state', 'records'), { recursive: true })
    mkdirSync(join(dir, 'briefs'), { recursive: true })
    writeFileSync(join(dir, 'state', 'records', 'sess-1'), `${record}\n`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const row = (id: number, agent?: string): string => JSON.stringify({ id, state: 'open', label: 'X', ...(agent === undefined ? {} : { agent }) })
  const line = (pr: number, status: string, over: Record<string, unknown>, repo = 'acme/app'): string =>
    JSON.stringify({ v: 1, ledger: 'pr', repo, pr, status, ...over, since: AT, updated: AT })
  const lineOf = (pr: number): LedgerLine | undefined => ledgerLines(readFileSync(record, 'utf8')).find(found => found.pr === pr)
  const rotationBrief = (id: number): string => {
    const path = join(dir, 'briefs', `${id}-r3.md`)
    writeFileSync(path, `# app — resume brief for row ${id}: t\n`)
    return path
  }
  const real = (logged: string[], warned: string[]): RowDeps => ({
    env: { HOME: dir, CLAUDE_CODE_SESSION_ID: 'sess-1', ORCHESTRATOR_STATE_DIR: join(dir, 'state') }, script: SCRIPT,
    read: path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    list: path => readdirSync(path),
    run: (argv, options) => run(argv, { ...options, env: { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_CODE_SESSION_ID: 'sess-1', ORCHESTRATOR_STATE_DIR: join(dir, 'state') } }),
    warn: said => warned.push(said),
    log: async said => { logged.push(said) },
  })
  const anomalies = (live: readonly string[], prs: readonly number[]): number[] =>
    unattended({ open: prs.map(pr => ({ repo: 'acme/app', pr })), lines: ledgerLines(readFileSync(record, 'utf8')), live: new Set(live), now: HOUR_LATER }).map(found => found.pr)

  it('attaches a rotation\'s replacement to the line of the agent it replaces, which the line keeps among those that worked it', async () => {
    writeFileSync(record, `${row(76, 'Agent: radio')}\n${line(86, 'waiting', { on: 'a free agent slot', worked: ['Agent: radio'] })}\n`)
    const logged: string[] = []
    const warned: string[] = []
    await recordAgent(spawned('Agent: radio fix', rotationBrief(76)), real(logged, warned))
    assert.deepEqual([lineOf(86)?.status, lineOf(86)?.agent, lineOf(86)?.worked], ['working', 'Agent: radio fix', ['Agent: radio']])
    assert.deepEqual(logged, [`acme/app#86 attached to Agent: radio fix, spawned for row 76 of ${record}`])
    assert.deepEqual(warned, [])
  })

  it('attaches a fresh agent spawned under the same name to a line gone to a wait: no anomaly once the wait is stale', async () => {
    writeFileSync(record, `${row(76, 'Agent: radio')}\n${line(86, 'waiting', { on: 'CI red, rotate at the next slot', worked: ['Agent: radio'] })}\n`)
    assert.deepEqual(anomalies(['Agent: radio'], [86]), [86])
    await recordAgent(spawned('Agent: radio', rotationBrief(76)), real([], []))
    assert.deepEqual([lineOf(86)?.status, lineOf(86)?.agent], ['working', 'Agent: radio'])
    assert.deepEqual(anomalies(['Agent: radio'], [86]), [])
  })

  it('attaches a review session to the line its brief reads, the implementer kept on it', async () => {
    const brief = join(dir, 'briefs', 'review-86.md')
    const head = '0123456789abcdef0123456789abcdef01234567'
    process.env['ORCHESTRATOR_MODELS_MAP'] = join(dir, 'models.json')
    const code = reviewBrief(['--out', brief, '--repo', 'acme/app', '--pr', '86', '--title', 'the radio', '--spec', '/b/spec.md', '--index', join(dir, 'index.md'),
      '--delivery-report', '/b/report.md', '--branch', 'build/radio', '--head', head, '--worktree', '/w/review', '--orchestrator', 'Orch: acme', '--reason', 'one fix'],
    { out: () => undefined, err: () => undefined })
    delete process.env['ORCHESTRATOR_MODELS_MAP']
    assert.equal(code, 0)
    writeFileSync(record, `${row(76, 'Agent: radio')}\n${line(86, 'working', { agent: 'Agent: radio' })}\n${line(86, 'working', { agent: 'Agent: other' }, 'acme/lib')}\n`)
    const logged: string[] = []
    await recordAgent(spawned('Agent: review pr86', brief), real(logged, []))
    const lines = ledgerLines(readFileSync(record, 'utf8'))
    assert.deepEqual(lines.map(found => [found.repo, found.agent, found.earlier]), [['acme/lib', 'Agent: other', undefined], ['acme/app', 'Agent: review pr86', ['Agent: radio']]])
    assert.deepEqual(logged, [`acme/app#86 attached to Agent: review pr86, spawned for its review in ${record}`])
    // The review session puts itself on no row.
    assert.match(readFileSync(record, 'utf8'), /"id":76,"state":"open","label":"X","agent":"Agent: radio"/)
  })

  it('leaves a line no agent of the row ever worked, which stays an anomaly, and a line the operator parked', async () => {
    const before = [line(87, 'waiting', { on: 'the CI' }), line(88, 'parked', { ruling: 'later, 2026-11-25', worked: ['Agent: radio'] })]
    writeFileSync(record, `${row(76, 'Agent: radio')}\n${before.join('\n')}\n`)
    const logged: string[] = []
    await recordAgent(spawned('Agent: radio', rotationBrief(76)), real(logged, []))
    assert.deepEqual(readFileSync(record, 'utf8').split('\n').filter(said => said.includes('"ledger"')), before)
    assert.deepEqual(logged, [])
    assert.deepEqual(anomalies(['Agent: radio'], [87]), [87])
  })

  it('leaves the pull requests of a row\'s former agent that holds another open row: they are that row\'s', async () => {
    const before = line(86, 'working', { agent: 'Agent: radio' })
    writeFileSync(record, `${row(76, 'Agent: radio')}\n${row(77, 'Agent: radio')}\n${before}\n`)
    const follow = join(dir, 'briefs', '77.md')
    writeFileSync(follow, 'Row: 77 FOLLOW: up\n')
    await recordAgent(spawned('Agent: follow up', follow), real([], []))
    assert.equal(readFileSync(record, 'utf8').split('\n').find(said => said.includes('"ledger"')), before)
  })

  it('says a line it could not attach', async () => {
    const files = { [BRIEF]: '# p — resume brief for row 355: t\n', [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': `${row(355, 'Agent: a')}\n${line(86, 'waiting', { on: 'x', worked: ['Agent: a'] })}\n` }
    const logged: string[] = []
    const d = deps(files, { run: async argv => ({ status: argv[2] === 'pr' ? 1 : 0, stdout: '', stderr: 'ERROR: could not update\n' }), log: async said => { logged.push(said) } })
    await recordAgent(spawned('Agent: a'), d)
    assert.deepEqual(d.warned, ['spawn: warning: Agent: a was not attached to acme/app#86 of /b/record.jsonl: ERROR: could not update'])
    assert.deepEqual(logged, [])
  })
})
