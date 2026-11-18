import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLauncherArgs } from '../../../core/launcher.ts'
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
    run: async argv => {
      ran.push([...argv])
      return { status: 0, stdout: '', stderr: '' }
    },
    warn: line => warned.push(line),
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

  it('says it, and launches nothing more, when no registered record holds the row open or two do', async () => {
    const none = deps({ [BRIEF]: PHASE, [REGISTRY]: '/r/a.jsonl\n', '/r/a.jsonl': `${JSON.stringify({ id: 355, state: 'closed' })}\nnot json\n` })
    await recordAgent(spawned('Agent: a'), none)
    assert.deepEqual(none.ran, [])
    assert.match(none.warned[0] ?? '', /Agent: a is on no row: no dispatch record this session registered holds row 355 open/)
    const two = deps({ [BRIEF]: PHASE, [REGISTRY]: '/r/a.jsonl\n/r/b.jsonl\n', '/r/a.jsonl': open(355), '/r/b.jsonl': open(355) })
    await recordAgent(spawned('Agent: a'), two)
    assert.deepEqual(two.ran, [])
    assert.match(two.warned[0] ?? '', /row 355 is open in \/r\/a\.jsonl, \/r\/b\.jsonl/)
    const anon = deps({ [BRIEF]: PHASE }, { env: { ORCHESTRATOR_STATE_DIR: STATE } })
    await recordAgent(spawned('Agent: a'), anon)
    assert.match(anon.warned[0] ?? '', /no dispatch record this session registered/)
  })

  it('says a refused write', async () => {
    const d = deps({ [BRIEF]: PHASE, [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) }, { run: async () => ({ status: 1, stdout: '', stderr: 'ERROR: owned by Orch: other\n' }) })
    await recordAgent(spawned('Agent: a'), d)
    assert.deepEqual(d.warned, ['spawn: warning: Agent: a was not put on row 355 of /b/record.jsonl: ERROR: owned by Orch: other'])
  })

  it('writes nothing for a launch with no brief, a title that is no agent\'s, a brief with no row, or another command', async () => {
    const files = { [BRIEF]: PHASE, '/b/review.md': '# review\nNo row here.\n', [REGISTRY]: '/b/record.jsonl\n', '/b/record.jsonl': open(355) }
    for (const request of [spawned('Agent: a', ''), spawned('Audit: a'), spawned('Agent: a', '/b/review.md'), spawned('Agent: a', '/b/missing.md'), parseLauncherArgs('close', ['--tty', '/dev/ttys1']), parseLauncherArgs('rotate', ['--old-tty', '/dev/ttys1'])]) {
      const d = deps(files)
      await recordAgent(request, d)
      assert.deepEqual([d.ran, d.warned], [[], []])
    }
  })
})
