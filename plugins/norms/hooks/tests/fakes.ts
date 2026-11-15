// hooks/tests/fakes.ts
// The module's hooks, each with its matcher and .catch net (core's capture), and a
// fake $ answering process runs, file reads and tool calls from tables. The
// hooks are called directly, so each test controls every seam they read.
import { capture, hookOf, hooksOn, hostOf, type Captured } from '../../core/capture.ts'
import type { Host, Noun, On } from '../../core/host.ts'

// The host a hook under test is handed: every noun, those a test does not set throwing.
export type World = Host<Noun>
export type Hook = Captured<World>
// A tool's input, as a fake tool reads it.
export type Call = { readonly tool: string } & Readonly<Record<string, unknown>>

export function mount(register: (on: On<World>) => void): Hook[] {
  return capture(register)
}

export { hookOf as hook, hooksOn }

// The first hook on the Skill tool whose skill matcher takes `skill`.
export function skillHookOf(hooks: Hook[], skill: string) {
  const found = hooksOn(hooks, 'tool.call').find(h => h.matcher?.['tool'] === 'Skill' && h.matcher['skill'] instanceof RegExp && h.matcher['skill'].test(skill))
  if (!found) throw new Error(`no Skill hook for ${skill}`)
  return found
}

// next(e) as the chain beneath: records what it was handed and answers it.
export function nextOf(answer: (e: unknown) => unknown = e => e): { next: ((e: unknown) => Promise<unknown>) & { called: boolean }; seen: unknown[] } {
  const seen: unknown[] = []
  const next = Object.assign(async (e: unknown) => {
    seen.push(e)
    return answer(e)
  }, { called: false })
  return { next, seen }
}

// Where the fake host keeps the module's journal: its home, then the plugin's directory.
export const JOURNAL_DIR = '/home/u/.claude/norms/journal/'

export type FakeSetup = {
  runs?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  tool?: (input: Call) => unknown
  home?: string
  env?: Record<string, string>
  // The host's $.state for the session, seeded by `plugin/key`; stateFails makes every set throw.
  state?: Record<string, unknown>
  stateFails?: string
  // The session's project root, as $.session.root() answers it.
  root?: string
  // The session's directory: a run there is keyed by its argv alone, and a relative path is read
  // from it. Default /repo, the top directory gitRuns answers.
  cwd?: string
}

// An absolute path without `.` and `..` steps.
export function normalize(path: string): string {
  const parts: string[] = []
  for (const step of path.split('/')) {
    if (step === '' || step === '.') continue
    if (step === '..') parts.pop()
    else parts.push(step)
  }
  return '/' + parts.join('/')
}

export function fakeDollar(setup: FakeSetup): {
  $: World; argvs: string[]; written: Record<string, string>; toolCalls: Call[]; state: Map<string, unknown>; logs: string[]
} {
  const argvs: string[] = []
  const written: Record<string, string> = {}
  const toolCalls: Call[] = []
  const cwd = setup.cwd ?? '/repo'
  const abs = (p: string) => normalize(p.startsWith('/') ? p : `${cwd}/${p}`)
  const keyed = <T>(table: Record<string, T> = {}) => Object.fromEntries(Object.entries(table).map(([p, v]) => [abs(p), v]))
  const files: Record<string, string> = keyed(setup.files)
  const dirs: Record<string, string[]> = keyed(setup.dirs)
  const state = new Map<string, unknown>(Object.entries(setup.state ?? {}))
  const logs: string[] = []
  const $ = hostOf({
    plugin: { root: '/plugin' },
    env: { get: async (name: string) => (name === 'HOME' ? setup.home ?? '/home/u' : setup.env?.[name]) },
    process: {
      // A run in another directory than the session's is keyed `(<dir>) <argv>`.
      run: async (argv: readonly string[], init?: { cwd?: string }) => {
        // The journal's own commands (its lock, its rename, its removals) succeed and are no run of a test.
        if (argv.some(arg => arg.startsWith(JOURNAL_DIR))) return { exitCode: 0, stdout: '', stderr: '' }
        const key = (init?.cwd && init.cwd !== cwd ? `(${init.cwd}) ` : '') + argv.join(' ')
        argvs.push(key)
        const r = setup.runs?.[key]
        if (!r) return { exitCode: 1, stdout: '', stderr: `unexpected run: ${key}` }
        return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
    },
    fs: {
      exists: async (p: string) => abs(p) in files || abs(p) in dirs,
      read: async (p: string) => {
        const text = files[abs(p)]
        if (text === undefined) throw new Error(`missing ${p}`)
        return text
      },
      write: async (p: string, text: string) => {
        // A journal file is read back through watchJournal, not as a file a test's subject wrote.
        if (p.startsWith(JOURNAL_DIR)) return
        written[p] = text
        files[abs(p)] = text
      },
      list: async (p: string) => (dirs[abs(p)] ?? []).map(name => ({ name, kind: 'file' as const, size: 0, isLink: false })),
      stat: async (p: string) => {
        if (abs(p) in dirs) return { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
        if (abs(p) in files) return { kind: 'file' as const, size: files[abs(p)]?.length ?? 0, mtimeMs: 0, isLink: false }
        throw new Error(`missing ${p}`)
      },
    },
    state: {
      get: async (ref: { plugin: string; key: string }) => ({ value: state.get(`${ref.plugin}/${ref.key}`), version: 0 }),
      set: async (ref: { plugin: string; key: string }, value: unknown) => {
        if (setup.stateFails) throw new Error(setup.stateFails)
        state.set(`${ref.plugin}/${ref.key}`, value)
        return { isSet: true, version: 1 }
      },
    },
    session: { root: async () => setup.root ?? '/work', id: async () => 'sess-1' },
    clock: { sleep: async () => undefined },
    ui: { log: (text: string) => { logs.push(text) } },
    tool: {
      call: async (input: Call) => {
        toolCalls.push(input)
        if (!setup.tool) throw new Error('no tool')
        return setup.tool(input)
      },
    },
  })
  return { $, argvs, written, toolCalls, state, logs }
}

// The git answers of a feature branch two commits ahead of its base.
export const BASE = 'b'.repeat(40)
export const HEAD = 'a'.repeat(40)

export function gitRuns(changed: string[], tracked: string[], diffs: Record<string, string> = {}, baseArg?: string): NonNullable<FakeSetup['runs']> {
  const runs: NonNullable<FakeSetup['runs']> = {
    [`bash /plugin/scripts/resolve_base.sh${baseArg ? ' ' + baseArg : ''}`]: { stdout: BASE + '\n' },
    'git rev-parse HEAD': { stdout: HEAD + '\n' },
    'git rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
    [`git diff --name-only ${BASE}...HEAD`]: { stdout: changed.join('\n') + '\n' },
    'git ls-files': { stdout: tracked.join('\n') + '\n' },
    'git rev-parse --absolute-git-dir': { stdout: '/repo/.git\n' },
    'git rev-parse --show-toplevel': { stdout: '/repo\n' },
    'git remote get-url origin': { stdout: 'git@github.com:Owner/Repo.git\n' },
  }
  for (const [files, diff] of Object.entries(diffs)) {
    runs[`git diff ${BASE}...HEAD -- ${files}`] = { stdout: diff }
    runs[`git diff --stat ${BASE}...HEAD -- ${files}`] = { stdout: ` ${files} | 9 +++++\n` }
  }
  return runs
}
