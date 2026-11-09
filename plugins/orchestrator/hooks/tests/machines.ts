// hooks/tests/machines.ts
// Two machines for the move's tests (moving.ts over move.ts): each a complete fake $ over an
// in-memory file map — its files, its process table as far as the name walk reads it, the hash
// tools, the git of its checkouts, core's store commands (the lock, the rename, the removal) and
// the messages it sends — and the transport between them, played by the test.
import { register as registerMoving } from '../moving.ts'
import { parseMoveMessage } from '../move.ts'
import { lockRun, logLineOf } from './fakes.ts'

// The homes are written in parts: the suite refuses a literal home path anywhere in the plugin.
export const at = (...parts: string[]) => '/' + parts.join('/')
export const HOME_A = at('Users', 'a')
export const HOME_B = at('home', 'b')
// A machine's config directory, as its state directory's parent.
export const configOf = (home: string) => `${home}/.claude/claude-orchestrator`.replace(/\/claude-orchestrator$/, '')
export const ADDRESS_A = 'bridge:session_01SenderA'
export const ADDRESS_B = 'bridge:session_02ReceiverB'
export const LAUNCHER = '/plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh'

// The fake machine's hash tool: not a real sha256, a deterministic 64-digit digest of the text
// (the module only compares what two machines' tools say).
export function sha256(text: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round++) {
    let h = 0xcbf29ce484222325n ^ BigInt(round)
    for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn
    out += h.toString(16).padStart(16, '0')
  }
  return out.slice(0, 64)
}

export type Repo = { tracked?: string[]; dirty?: boolean; ahead?: number; noUpstream?: boolean; remote?: string; branch?: string; detached?: boolean; branchFails?: boolean }

export type Options = {
  home: string
  name?: string | null              // the session's own name, as the process table spells it
  address: string
  machine?: string
  spawned?: boolean
  noShasum?: boolean
  noSha256sum?: boolean
  repos?: Record<string, Repo>
  // Addresses a send cannot reach; every other send is delivered.
  unreachable?: string[]
}

// A complete fake $ over an in-memory file map: the machine's files, its process table as far as
// the name walk reads it, the hash tools, the git of its checkouts, and the messages it sends.
export function machine(options: Options) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const links = new Set<string>()
  // The modification time of a path, when a test sets one: every other file reads as written at
  // the epoch, so a lock or a temporary file the test leaves reads as left by a dead writer.
  const mtimes = new Map<string, number>()
  const sent: { to: string; text: string }[] = []
  const submits: { text: string }[] = []
  const logged: string[] = []
  const writes: string[] = []
  const runs: string[] = []
  const registered: any[] = []
  const commands: any[] = []
  const config = configOf(options.home)
  const env: Record<string, string | undefined> = {
    HOME: options.home, ORCHESTRATOR_HOST_CLI: 'hostcli', ORCHESTRATOR_SPAWNED: options.spawned ? '1' : undefined,
  }
  let name = options.name === undefined ? 'Orch: belt' : options.name
  // Faults a test switches on in the middle of a move: writes whose path holds one of the strings
  // fail, a directory cannot be made, a send throws once that many have gone, an address stops answering.
  const faults: { writes: string[]; mkdir: boolean; sendThrowsAfter: number | null; unreachable: string[] } = { writes: [], mkdir: false, sendThrowsAfter: null, unreachable: [] }
  const dollar: any = {
    session: {
      id: async () => 's-one',
      send: async (args: { to: string; text: string }) => {
        if (options.unreachable?.includes(args.to) || faults.unreachable.includes(args.to)) return { isDelivered: false, reason: 'no such session' }
        if (faults.sendThrowsAfter !== null && sent.length >= faults.sendThrowsAfter) throw new Error('the bridge dropped')
        sent.push(args)
        return { isDelivered: true }
      },
    },
    env: { get: async (key: string) => env[key] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    command: { run: (input: any) => { commands.push(input); return Promise.resolve({ text: '' }) } },
    tool: { register: async (spec: any) => { registered.push(spec); return {} } },
    prompt: { submit: (input: { text: string }) => { submits.push(input); return Promise.resolve({ text: input.text }) } },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => {
        if (faults.writes.some(part => p.includes(part))) throw new Error(`EIO: ${p}`)
        writes.push(p)
        files.set(p, text)
      },
      exists: async (p: string) => files.has(p) || dirs.has(p),
      stat: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: mtimes.get(p) ?? 0, isLink: false }
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const p of [...files.keys(), ...dirs]) {
          if (!p.startsWith(`${dir}/`)) continue
          const rest = p.slice(dir.length + 1)
          if (rest) names.add(rest.split('/')[0])
        }
        return [...names].map(entry => {
          const path = `${dir}/${entry}`
          const text = files.get(path)
          if (text !== undefined) return { name: entry, kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 0, isLink: links.has(path) }
          return { name: entry, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        })
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) { logged.push(line); return { exitCode: 0, stdout: '', stderr: '' } }
        runs.push(argv.join(' '))
        const locked = lockRun(argv, files)
        if (locked) return locked
        const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
        const fail = (code = 1) => ({ exitCode: code, stdout: '', stderr: 'failed' })
        if (argv[0] === 'sh' && argv[1] === '-c' && String(argv[2]).startsWith('ps -o ppid=')) return ok('123 ttys001\n')
        if (argv[0] === 'sh' && argv[1] === '-c' && String(argv[2]).startsWith('command -v')) return fail()
        if (argv[0] === 'sh' && argv[1] === '-c' && String(argv[2]).startsWith('printf')) {
          files.set(argv[5], (files.get(argv[5]) ?? '') + argv[4] + '\n')
          writes.push(argv[5])
          return ok()
        }
        if (argv[0] === 'ps' && argv[1] === '-t') return ok(name ? `  501 hostcli --name ${name}\n` : '  501 hostcli\n')
        if (argv[0] === 'hostname') return ok(`${options.machine ?? 'mac-a'}.local\n`)
        if (argv[0] === 'shasum' || argv[0] === 'sha256sum') {
          if (argv[0] === 'shasum' && options.noShasum) throw new Error('shasum: not found')
          if (argv[0] === 'sha256sum' && options.noSha256sum) throw new Error('sha256sum: not found')
          const path = argv[argv.length - 1]
          return files.has(path) ? ok(`${sha256(files.get(path)!)}  ${path}\n`) : fail()
        }
        if (argv[0] === 'mkdir') {
          if (faults.mkdir) return fail()
          dirs.add(argv[2])
          return ok()
        }
        if (argv[0] === 'mv') {
          if (!files.has(argv[2])) return fail()
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          writes.push(argv[3])
          return ok()
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return ok()
        }
        if (argv[0] === 'git' && argv[1] === '-C') {
          const repo = options.repos?.[argv[2]]
          if (!repo) return fail(128)
          const verb = argv.slice(3).join(' ')
          if (verb.startsWith('ls-files --error-unmatch -- ')) return repo.tracked?.includes(argv[argv.length - 1]) ? ok(`${argv[argv.length - 1]}\n`) : fail(1)
          if (verb === 'status --porcelain') return ok(repo.dirty ? ' M belt.md\n' : '')
          if (verb === 'rev-list @{u}..HEAD') return repo.noUpstream ? fail(128) : ok('abc1234\n'.repeat(repo.ahead ?? 0))
          if (verb === 'remote get-url origin') return repo.remote ? ok(`${repo.remote}\n`) : fail(2)
          if (verb === 'rev-parse --is-inside-work-tree') return ok('true\n')
          if (verb === 'rev-parse --abbrev-ref HEAD') return repo.branchFails ? fail(128) : ok(`${repo.detached ? 'HEAD' : repo.branch ?? 'main'}\n`)
        }
        return fail()
      },
    },
  }
  return {
    dollar, files, dirs, links, mtimes, sent, submits, logged, writes, runs, registered, commands, home: options.home, config, faults,
    address: options.address,
    get name() { return name },
    // The session is renamed in the middle of a test.
    rename: (to: string | null) => { name = to },
    store: `${config}/claude-orchestrator/store`,
    briefs: `${config}/claude-orchestrator/briefs`,
    messages: () => sent.map(m => parseMoveMessage(m.text)),
  }
}
export type Machine = ReturnType<typeof machine>

// A registration is keyed by its event, and a tool call by its tool too: the file serves two.
// Each handler's fallback (its .catch) is kept too, under « catch:<key> ».
export function mounted(register: Function = registerMoving): Record<string, Function> {
  const handlers: Record<string, Function> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const tool = args.length === 3 ? String((args[1] as any).tool ?? '') : ''
    const key = tool ? `${args[0]}:${tool.replace('mcp__orchestrator__', '')}` : args[0]
    handlers[key] = args[args.length - 1] as Function
    return { catch: (fallback: Function) => { handlers[`catch:${key}`] = fallback } }
  })
  return handlers
}

export const passOn = async (e: any) => ({ passed: e.text })
export const envelope = (body: string, name: string, from: string) =>
  `<cross-session-message from="${from}" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`

// A message delivered to a machine, through its receive chain as the host runs it.
export async function receive(handlers: Record<string, Function>, fx: Machine, text: string, from: Machine | { name: string; address: string }, kind = 'peer') {
  const origin = { kind, plugin: 'orchestrator' }
  const peer = 'dollar' in from ? { name: from.name ?? 'unnamed', address: from.address } : from
  return handlers['session.receive'](fx.dollar, { origin, text: envelope(text, peer.name ?? 'unnamed', peer.address) }, passOn)
}

// Every message each machine has sent and the other has not yet received, delivered in order,
// until neither has anything left to say. The wire decides what each message becomes on its way:
// the texts delivered in its place — none for a message lost, two for one delivered twice, another
// text for one forged. By default every message arrives once, as it was sent.
export type Wire = (text: string, from: 'a' | 'b') => string[]
export async function settle(a: Machine, ha: Record<string, Function>, b: Machine, hb: Record<string, Function>, wire: Wire = text => [text], cap = 5000) {
  const cursor = { a: 0, b: 0 }
  for (let i = 0; i < cap; i++) {
    if (cursor.a < a.sent.length) {
      const m = a.sent[cursor.a++]
      for (const text of wire(m.text, 'a')) await receive(hb, b, text, a)
    } else if (cursor.b < b.sent.length) {
      const m = b.sent[cursor.b++]
      for (const text of wire(m.text, 'b')) await receive(ha, a, text, b)
    } else return
  }
  throw new Error('the two machines never fell silent')
}

export const BRIEF_NAME = 'belt.md'
export const BRIEF_TEXT = `# belt\nThe work is in ${HOME_A}/dev/app and the notes in ${HOME_A}/.claude/claude-orchestrator/briefs/belt/notes.txt.\n`
export const NOTES_TEXT = 'notes: éé ok\n' + 'x'.repeat(4000) + '\n'

// A sender that holds a briefs directory: the brief and its notes, a sub-directory and a link
// that must not travel, and two checkouts that are clean and pushed.
export function sender(over: Partial<Options> = {}): Machine {
  const fx = machine({
    home: HOME_A, address: ADDRESS_A, name: 'Orch: belt',
    repos: {
      [`${HOME_A}/dev/app`]: { remote: 'git@example.com:acme/app.git', branch: 'feat/belt' },
      [`${HOME_A}/dev/lib`]: {},
    },
    ...over,
  })
  const dir = `${fx.briefs}/belt`
  fx.files.set(`${dir}/${BRIEF_NAME}`, BRIEF_TEXT)
  fx.files.set(`${dir}/notes.txt`, NOTES_TEXT)
  fx.files.set(`${dir}/linked.md`, 'a link')
  fx.links.add(`${dir}/linked.md`)
  fx.files.set(`${dir}/old/inner.md`, 'in a sub-directory')
  return fx
}

export function receiver(over: Partial<Options> = {}): Machine {
  return machine({ home: HOME_B, address: ADDRESS_B, name: 'Orch: far', machine: 'mac-b', ...over })
}

export function sendInput(fx: Machine, over: Record<string, unknown> = {}) {
  return {
    to: ADDRESS_B, name: 'Orch: belt', brief: `${fx.briefs}/belt/${BRIEF_NAME}`, dir: `${HOME_A}/dev/app`, model: 'a-model',
    effort: 'high', prs: ['acme/app#7 feat/belt'], checkouts: [`${HOME_A}/dev/app`, `${HOME_A}/dev/lib`],
    order: '2026-10-17T10:00Z: move belt to the other machine', ...over,
  }
}

export const kinds = (fx: Machine) => fx.messages().map(m => m?.kind ?? 'unparsable')
