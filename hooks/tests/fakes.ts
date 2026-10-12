// hooks/tests/fakes.ts
// A fake `on` that records each hook with its matcher and .catch net, and a
// fake $ answering process runs, file reads and tool calls from tables. The
// hooks are called directly, so each test controls every seam they read.

export type Hook = { event: string; matcher?: Record<string, unknown>; handler: Function; net?: Function }

export function mount(register: (on: any) => void): Hook[] {
  const hooks: Hook[] = []
  const on = (event: string, a: any, b?: any) => {
    const hook: Hook = b === undefined ? { event, handler: a } : { event, matcher: a, handler: b }
    hooks.push(hook)
    return { catch: (net: Function) => { hook.net = net } }
  }
  register(on)
  return hooks
}

export function hook(hooks: Hook[], event: string, matcher?: Record<string, unknown>): Hook {
  const found = hooks.find(h => h.event === event && JSON.stringify(h.matcher ?? null) === JSON.stringify(matcher ?? null))
  if (!found) throw new Error(`no hook ${event} ${JSON.stringify(matcher)}`)
  return found
}

// next(e) as the chain beneath: records what it was handed and answers it.
export function nextOf(answer: (e: any) => any = e => e): { next: any; seen: any[] } {
  const seen: any[] = []
  const next: any = async (e: any) => {
    seen.push(e)
    return answer(e)
  }
  next.called = false
  return { next, seen }
}

export type FakeSetup = {
  runs?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  tool?: (input: any) => any
  home?: string
}

export function fakeDollar(setup: FakeSetup): { $: any; argvs: string[]; written: Record<string, string>; toolCalls: any[] } {
  const argvs: string[] = []
  const written: Record<string, string> = {}
  const toolCalls: any[] = []
  const files = { ...(setup.files ?? {}) }
  const $ = {
    plugin: { name: 'norms', root: '/plugin' },
    env: { get: async (name: string) => (name === 'HOME' ? setup.home ?? '/home/u' : undefined) },
    process: {
      run: async (argv: readonly string[]) => {
        const key = argv.join(' ')
        argvs.push(key)
        const r = setup.runs?.[key]
        if (!r) return { exitCode: 1, stdout: '', stderr: `unexpected run: ${key}` }
        return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
    },
    fs: {
      exists: async (p: string) => p in files || p in (setup.dirs ?? {}),
      read: async (p: string) => {
        if (!(p in files)) throw new Error(`missing ${p}`)
        return files[p]
      },
      write: async (p: string, text: string) => {
        written[p] = text
        files[p] = text
      },
      list: async (p: string) => (setup.dirs?.[p] ?? []).map(name => ({ name, kind: 'file' })),
      stat: async (p: string) => {
        if (p in (setup.dirs ?? {})) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        if (p in files) return { kind: 'file', size: files[p].length, mtimeMs: 0, isLink: false }
        throw new Error(`missing ${p}`)
      },
    },
    tool: {
      call: async (input: any) => {
        toolCalls.push(input)
        if (!setup.tool) throw new Error('no tool')
        return setup.tool(input)
      },
    },
  }
  return { $, argvs, written, toolCalls }
}

// The git answers of a feature branch two commits ahead of its base.
export const BASE = 'b'.repeat(40)
export const HEAD = 'a'.repeat(40)

export function gitRuns(changed: string[], tracked: string[], diffs: Record<string, string> = {}, baseArg?: string): FakeSetup['runs'] {
  const runs: FakeSetup['runs'] = {
    [`bash /plugin/scripts/resolve_base.sh${baseArg ? ' ' + baseArg : ''}`]: { stdout: BASE + '\n' },
    'git rev-parse HEAD': { stdout: HEAD + '\n' },
    'git rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
    [`git diff --name-only ${BASE}...HEAD`]: { stdout: changed.join('\n') + '\n' },
    'git ls-files': { stdout: tracked.join('\n') + '\n' },
    'git rev-parse --absolute-git-dir': { stdout: '/repo/.git\n' },
  }
  for (const [files, diff] of Object.entries(diffs)) {
    runs[`git diff ${BASE}...HEAD -- ${files}`] = { stdout: diff }
    runs[`git diff --stat ${BASE}...HEAD -- ${files}`] = { stdout: ` ${files} | 9 +++++\n` }
  }
  return runs
}
