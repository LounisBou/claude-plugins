// hooks/tests/fakes.ts
// What the engine tests share: a machine of files, children and verdicts beneath
// the module, registered once per test through `on`.

export const ROOT_LISTING = [
  'This session is Orch : demo [a1b2c3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).',
  '',
  'Peer sessions (1):',
  '  Agent : other work [d4e5f6]  ·  interactive  ·  busy  ·  started 1h ago',
].join('\n')

export type Run = { argv: string[]; cwd?: string; timeoutMs?: number }
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
  shell?: (e: any) => any
}

export function mount(on: any, m: Machine = {}): { runs: Run[]; asked: string[]; registered: any[] } {
  const runs: Run[] = []
  const asked: string[] = []
  const registered: any[] = []
  const files = m.files ?? {}
  on('session.start', () => ({ cwd: m.cwd ?? '/repo' }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: { tool: `mcp__bugs-bot__${e.name}` } }
  })
  on('session.cwd', () => ({ value: m.cwd ?? '/repo' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('env.get', (_$: any, e: any) => ({ value: { HOME: '/home/op', ...(m.env ?? {}) }[e.name] }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.stat', (_$: any, e: any) => {
    const real = (m.real ?? {})[e.path] ?? e.path
    return { value: { kind: 'file', size: 1, mtimeMs: 0, realPath: real } }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    return { value: (m.run ?? (() => ({ exitCode: 0, stdout: '', stderr: '' })))([...e.argv]) }
  })
  on('tool.call', { tool: 'ListAgents' }, () => {
    if (m.listing === null) throw new Error('ListAgents unavailable')
    return { result: m.listing ?? ROOT_LISTING, text: m.listing ?? ROOT_LISTING }
  })
  on('tool.call', { tool: 'Bash' }, (_$: any, e: any) => (m.shell ? m.shell(e) : { result: 'ran' }))
  on('tool.call', { tool: ['Read', 'Grep'] }, () => ({ result: 'read' }))
  on('tool.check', (_$: any, e: any) => (m.verdicts ?? {})[e.tool] ?? { decision: 'ask' })
  on('session.usage', () => {
    if (m.usage === null) throw new Error('no usage')
    return { value: { startedAt: 0, context: m.usage ?? { window: 1_000_000 }, rateLimits: [] } }
  })
  return { runs, asked, registered }
}

// A module's hooks captured without the engine, for what a test cannot raise
// through it (a prompt the person typed at the terminal).
export function capture(register: (on: any) => void) {
  const hooks: { event: string; matcher: any; handler: Function }[] = []
  register((event: string, a: any, b?: any) => {
    const hook = { event, matcher: b ? a : undefined, handler: b ?? a }
    hooks.push(hook)
    return { catch() {} }
  })
  return (event: string, tool?: string) =>
    hooks.find(h => h.event === event && (tool === undefined || [h.matcher?.tool].flat().includes(tool)))!.handler
}
