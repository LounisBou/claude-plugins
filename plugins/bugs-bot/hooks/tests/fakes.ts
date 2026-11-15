// hooks/tests/fakes.ts
// What the engine tests share: a machine of files, children and verdicts beneath
// the module, registered once per test through `on`.
import type { TestOn } from 'claude-code/testing'
import type { Events, ToolSpec } from '../../core/host.ts'
import { parseLearningEvent, type LearningEvent } from '../../core/learning.ts'

export const ROOT_LISTING = [
  'This session is Orch: demo [a1b2c3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).',
  '',
  'Peer sessions (1):',
  '  Agent: other work [d4e5f6]  ·  interactive  ·  busy  ·  started 1h ago',
].join('\n')

export type Run = { argv: string[]; cwd?: string | undefined; timeoutMs?: number | undefined }
export type Reply = { exitCode: number; stdout: string; stderr: string }

export type Machine = {
  cwd?: string
  env?: Record<string, string | undefined>
  files?: Record<string, string>
  real?: Record<string, string>
  run?: (argv: string[]) => Reply
  listing?: string | null
  verdicts?: Record<string, { decision: string; rule?: unknown; reason?: string }>
  usage?: { tokens?: number; window: number } | null
  shell?: (e: Events['tool.call']) => unknown
  // The session's directory cannot be read: the guard throws, and its net judges.
  cwdFails?: boolean
  // Every file write fails with this message.
  writeFails?: string
}

// Where the fake host keeps the module's journal: its home, then the plugin's directory.
export const JOURNAL_DIR = '/home/op/.claude/bugs-bot/journal/'

export function mount(on: TestOn, m: Machine = {}): { runs: Run[]; asked: string[]; registered: ToolSpec[]; journal: LearningEvent[]; logs: string[] } {
  const runs: Run[] = []
  const journal: LearningEvent[] = []
  const logs: string[] = []
  const asked: string[] = []
  const registered: ToolSpec[] = []
  const files = m.files ?? {}
  on('session.start', () => ({ cwd: m.cwd ?? '/repo' }))
  on('tool.register', (_$, e) => {
    registered.push(e)
    return { value: { tool: `mcp__bugs-bot__${e.name}` } }
  })
  on('session.cwd', () => {
    if (m.cwdFails) throw new Error('no cwd')
    return { value: m.cwd ?? '/repo' }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('env.get', (_$, e) => ({ value: { HOME: '/home/op', ...(m.env ?? {}) }[e.name] }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.stat', (_$, e) => {
    const real = (m.real ?? {})[e.path] ?? e.path
    return { value: { kind: 'file', size: 1, mtimeMs: 0, realPath: real } }
  })
  // The journal's files are its events, read back by a test; its commands (the lock, the rename) succeed and are no run of a test.
  on('fs.write', (_$, e) => {
    if (m.writeFails) throw new Error(m.writeFails)
    const event = String(e.path).startsWith(JOURNAL_DIR) ? parseLearningEvent(JSON.parse(String(e.text))) : undefined
    if (event !== undefined) journal.push(event)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.log', (_$, e) => { logs.push(String(e.text)); return { value: undefined } })
  on('process.run', (_$, e) => {
    if (e.argv.some((arg: string) => String(arg).includes(JOURNAL_DIR))) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    return { value: (m.run ?? (() => ({ exitCode: 0, stdout: '', stderr: '' })))([...e.argv]) }
  })
  on('tool.call', { tool: 'ListAgents' }, () => {
    if (m.listing === null) throw new Error('ListAgents unavailable')
    return { result: m.listing ?? ROOT_LISTING, text: m.listing ?? ROOT_LISTING }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => (m.shell ? m.shell(e) : { result: 'ran' }))
  on('tool.call', { tool: ['Read', 'Grep'] }, () => ({ result: 'read' }))
  // A tool a test names no verdict for is granted: the host denies a call its check would put to a person, and no one answers here.
  on('tool.check', (_$, e) => (m.verdicts ?? {})[e.tool] ?? { decision: 'allow' })
  on('session.usage', () => {
    if (m.usage === null) throw new Error('no usage')
    return { value: { startedAt: 0, context: m.usage ?? { window: 1_000_000 }, rateLimits: [] } }
  })
  return { runs, asked, registered, journal, logs }
}
