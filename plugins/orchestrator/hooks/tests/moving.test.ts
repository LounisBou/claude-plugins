// hooks/tests/moving.test.ts
// The module moves an orchestrator's files (moving.ts, over the protocol of move.ts): the two
// tools a supervising session calls, refused to anyone else; the sender that reads a briefs
// directory, hashes it, checks the checkouts and sends manifest, chunks and « sent »; the
// receiver that takes every marked delivery out of the chain before a model reads it, joins,
// checks, rewrites and writes each file, acknowledges it and asks again for what is missing;
// the sender's answers to « missing » and « done »; the probes; and the one case where a
// session the launcher opened may end itself.
import { expect, test } from 'claude-code/testing'
import { register as registerMoving } from '../moving.ts'
import { register as registerNaming, END_TOOL } from '../naming.ts'
import {
  MOVE_CHUNK_DEFAULT, MOVE_MISSING_ROUNDS, moveText, parseMoveMessage, chunkText, moveIdOf, arrivalOf, arrivedNotice,
  acknowledgedNotice, failedNotice, type MoveMessage,
} from '../move.ts'
import { logLineOf } from './fakes.ts'

// The homes are written in parts: the suite refuses a literal home path anywhere in the plugin.
const at = (...parts: string[]) => '/' + parts.join('/')
const HOME_A = at('Users', 'a')
const HOME_B = at('home', 'b')
// A machine's config directory, as its state directory's parent.
const configOf = (home: string) => `${home}/.claude/claude-orchestrator`.replace(/\/claude-orchestrator$/, '')
const ADDRESS_A = 'bridge:session_01SenderA'
const ADDRESS_B = 'bridge:session_02ReceiverB'
const LAUNCHER = '/plugins/orch-root/skills/iterm-agents/scripts/iterm-agent.sh'

// The fake machine's hash tool: not a real sha256, a deterministic 64-digit digest of the text
// (the module only compares what two machines' tools say).
function sha256(text: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round++) {
    let h = 0xcbf29ce484222325n ^ BigInt(round)
    for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn
    out += h.toString(16).padStart(16, '0')
  }
  return out.slice(0, 64)
}

type Repo = { dirty?: boolean; ahead?: number; noUpstream?: boolean; remote?: string; branch?: string; detached?: boolean; branchFails?: boolean }

type Options = {
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
function machine(options: Options) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const links = new Set<string>()
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
  let name = options.name === undefined ? 'Orch : belt' : options.name
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
        return { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 0, isLink: false }
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
    dollar, files, dirs, links, sent, submits, logged, writes, runs, registered, commands, home: options.home, config, faults,
    address: options.address,
    get name() { return name },
    // The session is renamed in the middle of a test.
    rename: (to: string | null) => { name = to },
    store: `${config}/claude-orchestrator/store`,
    briefs: `${config}/claude-orchestrator/briefs`,
    messages: () => sent.map(m => parseMoveMessage(m.text)),
  }
}
type Machine = ReturnType<typeof machine>

// A registration is keyed by its event, and a tool call by its tool too: the file serves two.
// Each handler's fallback (its .catch) is kept too, under « catch:<key> ».
function mounted(register: Function = registerMoving): Record<string, Function> {
  const handlers: Record<string, Function> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const tool = args.length === 3 ? String((args[1] as any).tool ?? '') : ''
    const key = tool ? `${args[0]}:${tool.replace('mcp__orchestrator__', '')}` : args[0]
    handlers[key] = args[args.length - 1] as Function
    return { catch: (fallback: Function) => { handlers[`catch:${key}`] = fallback } }
  })
  return handlers
}

const passOn = async (e: any) => ({ passed: e.text })
const envelope = (body: string, name: string, from: string) =>
  `<cross-session-message from="${from}" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`

// A message delivered to a machine, through its receive chain as the host runs it.
async function receive(handlers: Record<string, Function>, fx: Machine, text: string, from: Machine | { name: string; address: string }, kind = 'peer') {
  const origin = { kind, plugin: 'orchestrator' }
  const peer = 'dollar' in from ? { name: from.name ?? 'unnamed', address: from.address } : from
  return handlers['session.receive'](fx.dollar, { origin, text: envelope(text, peer.name ?? 'unnamed', peer.address) }, passOn)
}

// Every message each machine has sent and the other has not yet received, delivered in order,
// until neither has anything left to say.
async function settle(a: Machine, ha: Record<string, Function>, b: Machine, hb: Record<string, Function>, cap = 5000) {
  const cursor = { a: 0, b: 0 }
  for (let i = 0; i < cap; i++) {
    if (cursor.a < a.sent.length) {
      const m = a.sent[cursor.a++]
      await receive(hb, b, m.text, a)
    } else if (cursor.b < b.sent.length) {
      const m = b.sent[cursor.b++]
      await receive(ha, a, m.text, b)
    } else return
  }
  throw new Error('the two machines never fell silent')
}

const BRIEF_NAME = 'belt.md'
const BRIEF_TEXT = `# belt\nThe work is in ${HOME_A}/dev/app and the notes in ${HOME_A}/.claude/claude-orchestrator/briefs/belt/notes.txt.\n`
const NOTES_TEXT = 'notes: éé ok\n' + 'x'.repeat(4000) + '\n'

// A sender that holds a briefs directory: the brief and its notes, a sub-directory and a link
// that must not travel, and two checkouts that are clean and pushed.
function sender(over: Partial<Options> = {}): Machine {
  const fx = machine({
    home: HOME_A, address: ADDRESS_A, name: 'Orch : belt',
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

function receiver(over: Partial<Options> = {}): Machine {
  return machine({ home: HOME_B, address: ADDRESS_B, name: 'Orch : far', machine: 'mac-b', ...over })
}

function sendInput(fx: Machine, over: Record<string, unknown> = {}) {
  return {
    to: ADDRESS_B, name: 'Orch : belt', brief: `${fx.briefs}/belt/${BRIEF_NAME}`, dir: `${HOME_A}/dev/app`, model: 'a-model',
    effort: 'high', prs: ['acme/app#7 feat/belt'], checkouts: [`${HOME_A}/dev/app`, `${HOME_A}/dev/lib`],
    order: '2026-10-17T10:00Z: move belt to the other machine', ...over,
  }
}

const kinds = (fx: Machine) => fx.messages().map(m => m?.kind ?? 'unparsable')

// --- the tools ----------------------------------------------------------------------------

test('both tools are declared at every start, a session the launcher opened included', async () => {
  for (const spawned of [false, true]) {
    const h = mounted()
    const fx = sender({ spawned })
    const e = {}
    expect(await h['session.start'](fx.dollar, e, (x: unknown) => x)).toBe(e)
    expect(fx.registered.map((spec: any) => spec.name)).toEqual(['move_send', 'move_probe'])
    expect(fx.registered.every((spec: any) => spec.isDeferred === false)).toBe(true)
    const send = fx.registered.find((spec: any) => spec.name === 'move_send').inputSchema
    expect(Object.keys(send.properties)).toEqual(['to', 'name', 'brief', 'dir', 'model', 'effort', 'prs', 'checkouts', 'order', 'chunk'])
    expect(send.required).toEqual(['to', 'name', 'brief', 'dir', 'model', 'effort', 'prs', 'checkouts', 'order'])
    const probe = fx.registered.find((spec: any) => spec.name === 'move_probe').inputSchema
    expect(Object.keys(probe.properties)).toEqual(['to', 'sizes'])
    expect(probe.required).toEqual(['to', 'sizes'])
  }
})

test('the tools are refused from a subagent, and to a session named neither Orch nor Coord', async () => {
  const h = mounted()
  const fx = sender()
  for (const tool of ['move_send', 'move_probe']) {
    const input = tool === 'move_send' ? sendInput(fx) : { to: ADDRESS_B, sizes: [2048] }
    const refused = await h[`tool.call:${tool}`](fx.dollar, { ...input, agentId: 'a-1' })
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('main thread')
  }
  expect(fx.sent).toEqual([])
  for (const name of ['Agent : x', null, 'Audit : x']) {
    const other = sender({ name })
    for (const tool of ['move_send', 'move_probe']) {
      const input = tool === 'move_send' ? sendInput(other) : { to: ADDRESS_B, sizes: [2048] }
      const answer = await h[`tool.call:${tool}`](other.dollar, input)
      expect(answer.isError).toBe(true)
      expect(answer.result).toContain('Orch :')
    }
    expect(other.sent).toEqual([])
  }
  for (const name of ['Orch : x', 'Coord : x']) {
    const other = sender({ name })
    const sentOk = await h['tool.call:move_send'](other.dollar, sendInput(other, { name: 'Orch : belt' }))
    expect(sentOk.isError).toBeUndefined()
    const probed = await h['tool.call:move_probe'](other.dollar, { to: ADDRESS_B, sizes: [2048] })
    expect(probed.isError).toBeUndefined()
  }
})

// --- the send -----------------------------------------------------------------------------

test('move_send lists the regular files of the directory only, and hashes them with the process', async () => {
  const h = mounted()
  const fx = sender()
  // A process that answers a hash of its own: the manifest carries what the process said.
  const real = fx.dollar.process.run
  const said = 'f'.repeat(64)
  fx.dollar.process.run = async (argv: readonly string[]) => (argv[0] === 'shasum' ? { exitCode: 0, stdout: `${said}  ${argv[3]}\n`, stderr: '' } : real(argv))
  await h['tool.call:move_send'](fx.dollar, sendInput(fx))
  const manifest = fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  expect(manifest.kind).toBe('manifest')
  expect(manifest.files.map(f => f.name)).toEqual([BRIEF_NAME, 'notes.txt'])
  expect(manifest.files.every(f => f.sha256 === said)).toBe(true)
  expect(manifest.files[0].bytes).toBe(new TextEncoder().encode(BRIEF_TEXT).length)
  expect(manifest.files[1].chunks).toBe(chunkText(NOTES_TEXT, MOVE_CHUNK_DEFAULT).length)
  expect(manifest.origin).toEqual({ machine: 'mac-a', home: HOME_A, configDir: configOf(HOME_A) })
})

test('without shasum the hash comes from sha256sum', async () => {
  const h = mounted()
  const fx = sender({ noShasum: true })
  await h['tool.call:move_send'](fx.dollar, sendInput(fx))
  const manifest = fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  expect(manifest.files[0].sha256).toBe(sha256(BRIEF_TEXT))
  expect(fx.runs.some(run => run.startsWith('sha256sum '))).toBe(true)
  const neither = sender({ noShasum: true, noSha256sum: true })
  const refused = await h['tool.call:move_send'](neither.dollar, sendInput(neither))
  expect(refused.isError).toBe(true)
  expect(neither.sent).toEqual([])
})

test('the messages go to the peer in order: the manifest, every chunk, then « sent »', async () => {
  const h = mounted()
  const fx = sender()
  const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx, { chunk: 1000 }))
  expect(answer.isError).toBeUndefined()
  expect(fx.sent.every(m => m.to === ADDRESS_B)).toBe(true)
  const messages = fx.messages() as MoveMessage[]
  const manifest = messages[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const expected = ['manifest']
  manifest.files.forEach((f, file) => { for (let index = 0; index < f.chunks; index++) expected.push(`chunk ${file}:${index}`) })
  expected.push('sent')
  expect(messages.map(m => (m.kind === 'chunk' ? `chunk ${m.file}:${m.index}` : m.kind))).toEqual(expected)
  // The chunks rejoin to the files as they are.
  const joined = [BRIEF_TEXT, NOTES_TEXT].map((_, file) =>
    messages.filter((m): m is Extract<MoveMessage, { kind: 'chunk' }> => m.kind === 'chunk' && m.file === file).map(m => m.data).join(''))
  expect(joined).toEqual([BRIEF_TEXT, NOTES_TEXT])
  expect(manifest.record).toEqual({
    name: 'Orch : belt', brief: `${fx.briefs}/belt/${BRIEF_NAME}`, dir: `${HOME_A}/dev/app`, model: 'a-model', effort: 'high',
    prs: ['acme/app#7 feat/belt'], checkouts: [`${HOME_A}/dev/app`, `${HOME_A}/dev/lib`],
    git: { url: 'git@example.com:acme/app.git', branch: 'feat/belt' }, order: '2026-10-17T10:00Z: move belt to the other machine',
  })
  expect(manifest.move).toBe(moveIdOf(manifest.record, manifest.files))
})

test('the store keeps the move and the answer carries its id and its counts', async () => {
  const h = mounted()
  const fx = sender()
  const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx, { chunk: 1000 }))
  const manifest = fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const kept = JSON.parse(fx.files.get(`${fx.store}/moves/${manifest.move}.json`)!)
  expect(kept.to).toBe(ADDRESS_B)
  expect(kept.record).toEqual(manifest.record)
  expect(kept.files).toEqual(manifest.files)
  expect(kept.rounds).toBe(0)
  const chunks = manifest.files.reduce((sum, f) => sum + f.chunks, 0)
  const bytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0)
  expect(answer.result).toContain(manifest.move)
  expect(answer.result).toContain(`${manifest.files.length} files`)
  expect(answer.result).toContain(`${chunks} chunks`)
  expect(answer.result).toContain(`${bytes} bytes`)
})

test('a directory that is no checkout gives a record with no git', async () => {
  const h = mounted()
  const fx = sender()
  await h['tool.call:move_send'](fx.dollar, sendInput(fx, { dir: `${HOME_A}/dev/plain` }))
  expect((fx.messages()[0] as any).record.git).toBeNull()
})

test('a dirty or an unpushed checkout refuses the move before anything is sent', async () => {
  const h = mounted()
  const cases: [Repo, string][] = [
    [{ dirty: true }, 'uncommitted'], [{ ahead: 2 }, 'not pushed'], [{ noUpstream: true }, 'upstream'],
  ]
  for (const [repo, word] of cases) {
    const fx = sender({ repos: { [`${HOME_A}/dev/app`]: { remote: 'git@example.com:acme/app.git' }, [`${HOME_A}/dev/lib`]: repo } })
    const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx))
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain(`${HOME_A}/dev/lib`)
    expect(answer.result).toContain(word)
    expect(fx.sent).toEqual([])
    expect([...fx.files.keys()].some(p => p.includes('/moves/'))).toBe(false)
  }
  const missing = sender()
  const answer = await h['tool.call:move_send'](missing.dollar, sendInput(missing, { checkouts: [`${HOME_A}/dev/nowhere`] }))
  expect(answer.isError).toBe(true)
  expect(missing.sent).toEqual([])
})

test('a file over a cap, or too many files, refuses the move before anything is sent', async () => {
  const h = mounted()
  const big = sender()
  big.files.set(`${big.briefs}/belt/big.bin`, 'x'.repeat(4 * 1024 * 1024 + 1))
  const tooBig = await h['tool.call:move_send'](big.dollar, sendInput(big))
  expect(tooBig.isError).toBe(true)
  expect(tooBig.result).toContain('big.bin')
  expect(big.sent).toEqual([])
  const many = sender()
  for (let i = 0; i < 520; i++) many.files.set(`${many.briefs}/belt/f${i}.md`, 'x')
  const tooMany = await h['tool.call:move_send'](many.dollar, sendInput(many))
  expect(tooMany.isError).toBe(true)
  expect(tooMany.result).toContain('files')
  expect(many.sent).toEqual([])
  const odd = sender()
  odd.files.set(`${odd.briefs}/belt/two words.md`, 'x')
  const badName = await h['tool.call:move_send'](odd.dollar, sendInput(odd))
  expect(badName.isError).toBe(true)
  expect(odd.sent).toEqual([])
})

test('a brief that is not among the files, an empty directory and a bad field are refused whole', async () => {
  const h = mounted()
  const fx = sender()
  const cases: Record<string, unknown>[] = [
    { brief: `${fx.briefs}/belt/missing.md` }, { brief: `${fx.briefs}/empty/x.md` }, { brief: 'belt.md' },
    { name: 'Agent : belt' }, { model: '' }, { effort: 'fast' }, { order: '' }, { prs: 'acme/app#7' }, { checkouts: ['relative'] },
    { chunk: 0 }, { chunk: 1.5 }, { to: '' },
  ]
  for (const over of cases) {
    const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx, over))
    expect(answer.isError).toBe(true)
  }
  expect(fx.sent).toEqual([])
})

test('a send the peer cannot be reached for is an error, and the move is kept to be sent again', async () => {
  const h = mounted()
  const fx = sender({ unreachable: [ADDRESS_B] })
  const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx))
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('no such session')
  expect(fx.sent).toEqual([])
  expect([...fx.files.keys()].some(p => p.startsWith(`${fx.store}/moves/`) && p.endsWith('.json'))).toBe(true)
})

// --- the probes ---------------------------------------------------------------------------

test('move_probe sends one probe per size, each carrying that many data characters', async () => {
  const h = mounted()
  const fx = sender()
  const answer = await h['tool.call:move_probe'](fx.dollar, { to: ADDRESS_B, sizes: [2048, 8192, 32768] })
  expect(answer.isError).toBeUndefined()
  const probes = fx.messages() as Extract<MoveMessage, { kind: 'probe' }>[]
  expect(probes.map(p => [p.kind, p.size, p.data.length])).toEqual([['probe', 2048, 2048], ['probe', 8192, 8192], ['probe', 32768, 32768]])
  expect(fx.sent.every(m => m.to === ADDRESS_B)).toBe(true)
  for (const bad of [{ sizes: [] }, { sizes: [0] }, { sizes: [1.5] }, { sizes: ['9'] }, { sizes: 'x' }, { sizes: [2_000_000] }, { to: '' }]) {
    const refused = await h['tool.call:move_probe'](fx.dollar, { to: ADDRESS_B, sizes: [2048], ...bad })
    expect(refused.isError).toBe(true)
  }
  expect(fx.sent.length).toBe(3)
})

// --- the receiver -------------------------------------------------------------------------

const TARGET_B = { home: HOME_B, configDir: configOf(HOME_B) }
const BRIEF_ARRIVED = BRIEF_TEXT.split(HOME_A).join(HOME_B)

// What a sender sends for the fixture directory, captured: the messages in the order sent.
async function sentMessages(chunk = 1000): Promise<{ a: Machine; ha: Record<string, Function>; messages: MoveMessage[]; manifest: Extract<MoveMessage, { kind: 'manifest' }> }> {
  const ha = mounted()
  const a = sender()
  const answer = await ha['tool.call:move_send'](a.dollar, sendInput(a, { chunk }))
  expect(answer.isError).toBeUndefined()
  const messages = a.messages() as MoveMessage[]
  return { a, ha, messages, manifest: messages[0] as Extract<MoveMessage, { kind: 'manifest' }> }
}

const textOf = (message: MoveMessage) => moveText(message)

async function deliverAll(hb: Record<string, Function>, b: Machine, a: Machine, messages: MoveMessage[]) {
  const results = []
  for (const m of messages) results.push(await receive(hb, b, textOf(m), a))
  return results
}

const acksOf = (b: Machine) => b.messages().filter((m): m is Extract<MoveMessage, { kind: 'ack' }> => m?.kind === 'ack')
const briefsWritten = (b: Machine) => [...b.files.keys()].filter(p => p.startsWith(`${b.briefs}/`))

test('a marked delivery is consumed: no model reads it, and the files land rewritten in the briefs directory', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  const results = await deliverAll(hb, b, a, messages)
  expect(results.every(r => typeof r.consumed === 'string')).toBe(true)
  const arrival = arrivalOf(manifest, TARGET_B) as any
  expect(arrival.briefDir).toBe(`${b.briefs}/belt`)
  expect(b.files.get(arrival.brief)).toBe(BRIEF_ARRIVED)
  expect(b.files.get(`${arrival.briefDir}/notes.txt`)).toBe(NOTES_TEXT)
  expect(b.dirs.has(arrival.briefDir)).toBe(true)
  expect(acksOf(b).map(m => [m.file, m.ok, m.reason])).toEqual([[0, true, null], [1, true, null]])
  expect(b.sent.every(m => m.to === ADDRESS_A)).toBe(true)
})

test('chunks that arrive out of order are joined right', async () => {
  const { a, messages } = await sentMessages(500)
  const hb = mounted()
  const b = receiver()
  const [manifest, ...rest] = messages
  const chunks = rest.filter(m => m.kind === 'chunk').reverse()
  await deliverAll(hb, b, a, [manifest, ...chunks, ...rest.filter(m => m.kind === 'sent')])
  expect(b.files.get(`${b.briefs}/belt/notes.txt`)).toBe(NOTES_TEXT)
  expect(b.files.get(`${b.briefs}/belt/${BRIEF_NAME}`)).toBe(BRIEF_ARRIVED)
})

test('a sha256 mismatch acks not ok and writes nothing in the briefs directory', async () => {
  const { a, messages } = await sentMessages(500)
  const hb = mounted()
  const b = receiver()
  let flipped = false
  const tampered = messages.map(m => {
    if (m.kind !== 'chunk' || m.file !== 1 || flipped) return m
    flipped = true
    return { ...m, data: m.data.replace('x', 'y').replace('n', 'm') }
  })
  await deliverAll(hb, b, a, tampered)
  const acks = acksOf(b)
  expect(acks.find(m => m.file === 1)).toMatchObject({ ok: false })
  expect(acks.find(m => m.file === 1)!.reason).toContain('notes.txt')
  expect(briefsWritten(b).some(p => p.endsWith('/notes.txt'))).toBe(false)
  // The other file is unharmed, and the move is over, not ok.
  expect(b.files.get(`${b.briefs}/belt/${BRIEF_NAME}`)).toBe(BRIEF_ARRIVED)
  const done = b.messages().find(m => m?.kind === 'done') as any
  expect(done).toMatchObject({ ok: false, brief: null })
  expect(b.submits).toEqual([])
})

test('a target that exists with the same content is acked ok, with other content refused', async () => {
  const { a, messages } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  b.files.set(`${b.briefs}/belt/${BRIEF_NAME}`, BRIEF_ARRIVED)
  b.files.set(`${b.briefs}/belt/notes.txt`, 'other content, kept\n')
  await deliverAll(hb, b, a, messages)
  const acks = acksOf(b)
  expect(acks.find(m => m.file === 0)).toMatchObject({ ok: true })
  expect(acks.find(m => m.file === 1)).toMatchObject({ ok: false })
  expect(acks.find(m => m.file === 1)!.reason).toContain('notes.txt')
  expect(b.files.get(`${b.briefs}/belt/notes.txt`)).toBe('other content, kept\n')
  expect(b.writes.filter(p => p === `${b.briefs}/belt/${BRIEF_NAME}`)).toEqual([])
})

test('the same move sent twice is kept as it is: acknowledged again, nothing written twice', async () => {
  const { a, ha, messages, manifest } = await sentMessages()
  // The same arguments give the same move.
  const again = sender()
  const hs = mounted()
  await hs['tool.call:move_send'](again.dollar, sendInput(again, { chunk: 1000 }))
  expect((again.messages()[0] as any).move).toBe(manifest.move)
  const hb = mounted()
  const b = receiver()
  await deliverAll(hb, b, a, messages)
  const writes = [...b.writes]
  const acks = acksOf(b).length
  await deliverAll(hb, b, a, messages)
  expect(b.writes).toEqual(writes)
  expect(acksOf(b).length).toBeGreaterThan(acks)
  expect(b.messages().filter(m => m?.kind === 'done').length).toBeGreaterThanOrEqual(1)
  expect(b.submits.length).toBe(1)
  void ha
})

test('all files acknowledged: done ok carries the brief, and the receiver\'s model reads the arrival notice once', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  await deliverAll(hb, b, a, messages)
  const arrival = arrivalOf(manifest, TARGET_B) as any
  const done = b.messages().filter(m => m?.kind === 'done') as any[]
  expect(done[0]).toEqual({ kind: 'done', move: manifest.move, ok: true, brief: arrival.brief, reason: null })
  expect(b.submits).toEqual([{ text: arrivedNotice(manifest, arrival, 'Orch : belt', LAUNCHER) }])
  // The arrival the notice reports is the one written.
  expect(b.submits[0].text).toContain(arrival.brief)
})

test('a manifest the receiver refuses is answered done not ok, and nothing is written', async () => {
  const { a, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  const forged = { ...manifest, record: { ...manifest.record, order: 'another order' } }
  await receive(hb, b, textOf(forged), a)
  const done = b.messages()[0] as any
  expect(done).toMatchObject({ kind: 'done', move: manifest.move, ok: false, brief: null })
  expect(done.reason).toContain('move id')
  expect(b.writes).toEqual([])
  expect(b.submits).toEqual([])
})

test('a probe is answered with the length received', async () => {
  const hb = mounted()
  const b = receiver()
  const a = sender()
  const probe = { kind: 'probe', move: 'probe-0123456789ab', size: 3000, data: 'z'.repeat(3000) } as const
  const r = await receive(hb, b, textOf(probe), a)
  expect(typeof r.consumed).toBe('string')
  expect(b.messages()).toEqual([{ kind: 'probe-ack', move: probe.move, size: 3000, received: 3000 }])
  expect(b.sent[0].to).toBe(ADDRESS_A)
})

test('a marked message that is not the module\'s to act on is consumed and does nothing', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  const stranger = { name: 'Orch : intruder', address: 'bridge:session_03Stranger' }
  const chunk = messages.find(m => m.kind === 'chunk')!
  await receive(hb, b, textOf(manifest), a)
  const before = { writes: [...b.writes], sent: b.sent.length, submits: b.submits.length }
  const cases: [string, Machine | typeof stranger, Machine?][] = [
    ['a chunk from another session', stranger],
    ['a sent from another session', stranger],
    ['a chunk of a move it does not know', a],
    ['text that does not parse', a],
    ['a kind with an extra field', a],
  ]
  const texts = [
    textOf(chunk), textOf({ kind: 'sent', move: manifest.move }),
    textOf({ ...(chunk as any), move: 'other-0123456789ab' }),
    '[module-move] {"kind":', textOf({ ...(chunk as any), extra: 1 } as any),
  ]
  for (const [i, [, from]] of cases.entries()) {
    const r = await receive(hb, b, texts[i], from as any)
    expect(typeof r.consumed).toBe('string')
    expect(r.passed).toBeUndefined()
  }
  expect({ writes: b.writes, sent: b.sent.length, submits: b.submits.length }).toEqual({ writes: before.writes, sent: before.sent, submits: before.submits })
  expect(b.logged.length).toBeGreaterThanOrEqual(cases.length)
})

test('a session named neither Orch nor Coord consumes a marked message and does nothing with it', async () => {
  const { a, messages } = await sentMessages()
  const hb = mounted()
  const b = receiver({ name: 'Agent : x' })
  for (const m of messages) {
    const r = await receive(hb, b, textOf(m), a)
    expect(typeof r.consumed).toBe('string')
  }
  const probe = await receive(hb, b, textOf({ kind: 'probe', move: 'probe-0123456789ab', size: 5, data: 'zzzzz' }), a)
  expect(typeof probe.consumed).toBe('string')
  expect(b.writes).toEqual([])
  // Only the manifest and the « sent » are answered, each done not ok, to their sender.
  expect(b.messages().map(m => m?.kind === 'done' && !m.ok ? 'refused' : 'other')).toEqual(['refused', 'refused'])
  expect(b.sent.every(m => m.to === ADDRESS_A)).toBe(true)
  expect(b.submits).toEqual([])
})

test('an unmarked delivery, a person\'s prompt and a subagent\'s receive pass through untouched', async () => {
  const hb = mounted()
  const b = receiver()
  const a = sender()
  expect(await receive(hb, b, 'hello there', a)).toEqual({ passed: envelope('hello there', 'Orch : belt', ADDRESS_A) })
  const marked = textOf({ kind: 'sent', move: 'belt-0123456789ab' })
  const typed = await hb['session.receive'](b.dollar, { origin: { kind: 'user' }, text: marked }, passOn)
  expect(typed).toEqual({ passed: marked })
  const sub = await hb['session.receive'](b.dollar, { agentId: 'a-1', origin: { kind: 'peer' }, text: envelope(marked, 'Orch : belt', ADDRESS_A) }, passOn)
  expect(sub.passed).toBeDefined()
  expect(b.sent).toEqual([])
})

// --- the sender's side of the answers -----------------------------------------------------

const missingOfMessages = (b: Machine) => b.messages().filter((m): m is Extract<MoveMessage, { kind: 'missing' }> => m?.kind === 'missing')

test('« sent » with a chunk missing is answered missing, naming exactly it; the sender resends exactly it', async () => {
  const { a, ha, messages, manifest } = await sentMessages(500)
  const hb = mounted()
  const b = receiver()
  const lost = messages.findIndex(m => m.kind === 'chunk' && m.file === 1 && m.index === 2)
  expect(lost).toBeGreaterThan(0)
  await deliverAll(hb, b, a, messages.filter((_, i) => i !== lost))
  expect(missingOfMessages(b).map(m => m.chunks)).toEqual([[[1, 2]]])
  // The receiver has not acknowledged the file it lacks, and has not finished the move.
  expect(acksOf(b).map(m => m.file)).toEqual([0])
  expect(b.messages().some(m => m?.kind === 'done')).toBe(false)
  const before = a.sent.length
  await receive(ha, a, b.sent[b.sent.length - 1].text, b)
  const resent = a.messages().slice(before) as MoveMessage[]
  expect(resent.map(m => (m.kind === 'chunk' ? `chunk ${m.file}:${m.index}` : m.kind))).toEqual(['chunk 1:2', 'sent'])
  expect(a.sent.slice(before).every(m => m.to === ADDRESS_B)).toBe(true)
  // Delivered, the move completes and is acknowledged once on each side.
  await settle(a, ha, b, hb)
  expect(a.submits).toEqual([{ text: acknowledgedNotice(manifest.record, ADDRESS_B, (arrivalOf(manifest, TARGET_B) as any).brief) }])
  expect(b.submits.length).toBe(1)
})

test('past MOVE_MISSING_ROUNDS answers the sender gives up and its model reads the failure', async () => {
  const { a, ha, manifest } = await sentMessages(500)
  const missing = textOf({ kind: 'missing', move: manifest.move, chunks: [[1, 2]] })
  const peer = { name: 'Orch : far', address: ADDRESS_B }
  const before = a.sent.length
  for (let round = 1; round <= MOVE_MISSING_ROUNDS; round++) {
    await receive(ha, a, missing, peer)
    expect(a.sent.length).toBe(before + round * 2)
    expect(a.submits).toEqual([])
  }
  const kept = JSON.parse(a.files.get(`${a.store}/moves/${manifest.move}.json`)!)
  expect(kept.rounds).toBe(MOVE_MISSING_ROUNDS)
  await receive(ha, a, missing, peer)
  expect(a.sent.length).toBe(before + MOVE_MISSING_ROUNDS * 2)
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain(failedNotice(manifest.record, ADDRESS_B, '').split(': ')[0])
  expect(a.submits[0].text).toContain(`${MOVE_MISSING_ROUNDS} answers`)
  // Once failed, a later answer starts nothing.
  await receive(ha, a, missing, peer)
  expect(a.submits.length).toBe(1)
})

test('done ok gives the sender\'s model the acknowledgment once; done not ok, the failure', async () => {
  const { a, ha, manifest } = await sentMessages()
  const peer = { name: 'Orch : far', address: ADDRESS_B }
  const brief = `${HOME_B}/.claude/claude-orchestrator/briefs/belt/${BRIEF_NAME}`
  const ok = textOf({ kind: 'done', move: manifest.move, ok: true, brief, reason: null })
  await receive(ha, a, textOf({ kind: 'ack', move: manifest.move, file: 0, ok: true, reason: null }), peer)
  expect(a.submits).toEqual([])
  await receive(ha, a, ok, peer)
  await receive(ha, a, ok, peer)
  expect(a.submits).toEqual([{ text: acknowledgedNotice(manifest.record, ADDRESS_B, brief) }])
  const other = await sentMessages()
  await receive(other.ha, other.a, textOf({ kind: 'done', move: other.manifest.move, ok: false, brief: null, reason: 'a file stands there with other content' }), peer)
  expect(other.a.submits).toEqual([{ text: failedNotice(other.manifest.record, ADDRESS_B, 'a file stands there with other content') }])
})

test('an answer from a session that is not the move\'s peer, or for a move not sent, does nothing', async () => {
  const { a, ha, manifest } = await sentMessages()
  const stranger = { name: 'Orch : intruder', address: 'bridge:session_03Stranger' }
  const peer = { name: 'Orch : far', address: ADDRESS_B }
  const before = a.sent.length
  const texts = [
    textOf({ kind: 'done', move: manifest.move, ok: true, brief: `${HOME_B}/b.md`, reason: null }),
    textOf({ kind: 'missing', move: manifest.move, chunks: [[0, 0]] }),
  ]
  for (const t of texts) {
    const r = await receive(ha, a, t, stranger)
    expect(typeof r.consumed).toBe('string')
  }
  const unknown = await receive(ha, a, textOf({ kind: 'done', move: 'other-0123456789ab', ok: true, brief: `${HOME_B}/b.md`, reason: null }), peer)
  expect(typeof unknown.consumed).toBe('string')
  expect(a.sent.length).toBe(before)
  expect(a.submits).toEqual([])
  // A « missing » naming chunks outside the manifest resends nothing but « sent ».
  await receive(ha, a, textOf({ kind: 'missing', move: manifest.move, chunks: [[9, 9], [0, 99]] }), peer)
  expect(a.messages().slice(before).map(m => m?.kind)).toEqual(['sent'])
})

test('each probe answer is appended as one JSON line to the probes file, and only a probe sent is taken', async () => {
  const ha = mounted()
  const a = sender()
  await ha['tool.call:move_probe'](a.dollar, { to: ADDRESS_B, sizes: [2048, 8192] })
  const probes = a.messages() as Extract<MoveMessage, { kind: 'probe' }>[]
  const hb = mounted()
  const b = receiver()
  for (const p of probes) await receive(hb, b, textOf(p), a)
  expect(b.sent.length).toBe(2)
  for (const m of b.sent) await receive(ha, a, m.text, b)
  const lines = (a.files.get(`${a.store}/moves/probes.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(lines.map(l => [l.size, l.received, l.move])).toEqual([[2048, 2048, probes[0].move], [8192, 8192, probes[0].move]])
  expect(lines.every(l => typeof l.at === 'string' && l.from === ADDRESS_B)).toBe(true)
  // An answer from another session, or for a probe never sent, adds no line.
  await receive(ha, a, textOf({ kind: 'probe-ack', move: probes[0].move, size: 2048, received: 2048 }), { name: 'Orch : intruder', address: 'bridge:session_03Stranger' })
  await receive(ha, a, textOf({ kind: 'probe-ack', move: 'probe-ffffffffffff', size: 2048, received: 2048 }), b)
  expect((a.files.get(`${a.store}/moves/probes.jsonl`) ?? '').split('\n').filter(Boolean).length).toBe(2)
})

test('a whole move between two machines: the files land, each side\'s model reads one notice', async () => {
  const ha = mounted()
  const hb = mounted()
  const a = sender()
  const b = receiver()
  await ha['tool.call:move_send'](a.dollar, sendInput(a))
  await settle(a, ha, b, hb)
  const manifest = a.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const arrival = arrivalOf(manifest, TARGET_B) as any
  expect(b.files.get(arrival.brief)).toBe(BRIEF_ARRIVED)
  expect(b.submits).toEqual([{ text: arrivedNotice(manifest, arrival, 'Orch : belt', LAUNCHER) }])
  expect(a.submits).toEqual([{ text: acknowledgedNotice(manifest.record, ADDRESS_B, arrival.brief) }])
  expect(a.logged.length + b.logged.length).toBe(0)
})

// --- the end of a moved session ----------------------------------------------------------

const REFUSED_TODAY = 'this session was opened by the launcher; its successor closes its tab'

// A session the launcher opened, with the module and the naming mounted over one fake.
function launcherOpened(name = 'Orch : belt') {
  return { moving: mounted(), naming: mounted(registerNaming), fx: sender({ spawned: true, name }) }
}

async function moveAcknowledged(s: ReturnType<typeof launcherOpened>, over: { sentAs?: string; ok?: boolean } = {}) {
  await s.moving['tool.call:move_send'](s.fx.dollar, sendInput(s.fx, { name: over.sentAs ?? 'Orch : belt' }))
  const manifest = s.fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const done = over.ok === false
    ? { kind: 'done', move: manifest.move, ok: false, brief: null, reason: 'refused' } as const
    : { kind: 'done', move: manifest.move, ok: true, brief: `${HOME_B}/.claude/claude-orchestrator/briefs/belt/${BRIEF_NAME}`, reason: null } as const
  await receive(s.moving, s.fx, textOf(done), { name: 'Orch : far', address: ADDRESS_B })
}

test('a session the launcher opened is offered the end tool, not the rename tool', async () => {
  const s = launcherOpened()
  await s.naming['session.start'](s.fx.dollar, {}, (x: unknown) => x)
  expect(s.fx.registered.map((spec: any) => spec.name)).toEqual([END_TOOL])
  const plain = sender()
  await s.naming['session.start'](plain.dollar, {}, (x: unknown) => x)
  expect(plain.registered.map((spec: any) => spec.name)).toEqual(['rename_session', END_TOOL])
})

test('it ends after the done ok of a move under its own name, and only then', async () => {
  const end = (s: ReturnType<typeof launcherOpened>) => s.naming[`tool.call:${END_TOOL}`](s.fx.dollar, {})
  const none = launcherOpened()
  expect(await end(none)).toEqual({ result: REFUSED_TODAY, isError: true })
  // A move sent, not yet answered.
  await none.moving['tool.call:move_send'](none.fx.dollar, sendInput(none.fx))
  expect(await end(none)).toEqual({ result: REFUSED_TODAY, isError: true })
  const ok = launcherOpened()
  await moveAcknowledged(ok)
  expect(await end(ok)).toEqual({ result: 'This session ends when this turn ends.' })
  await ok.naming['turn.complete'](ok.fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(ok.fx.commands).toEqual([{ command: 'exit' }])
  // The move of another name does not count; nor does a done not ok.
  const other = launcherOpened('Orch : other')
  await moveAcknowledged(other, { sentAs: 'Orch : belt' })
  expect(await end(other)).toEqual({ result: REFUSED_TODAY, isError: true })
  const failed = launcherOpened()
  await moveAcknowledged(failed, { ok: false })
  expect(await end(failed)).toEqual({ result: REFUSED_TODAY, isError: true })
  // A subagent is still refused, and the rename stays refused to a launcher-opened session.
  expect((await ok.naming[`tool.call:${END_TOOL}`](ok.fx.dollar, { agentId: 'a-1' })).isError).toBe(true)
  expect((await ok.naming['tool.call:rename_session'](ok.fx.dollar, { name: 'Orch : x' })).isError).toBe(true)
})

// --- the name of the session --------------------------------------------------------------

test('a name that could not be read is not remembered: the message is dropped unanswered, the next one is judged afresh', async () => {
  const { a, messages } = await sentMessages()
  const hb = mounted()
  const b = receiver({ name: null })
  const first = await receive(hb, b, textOf(messages[0]), a)
  expect(typeof first.consumed).toBe('string')
  expect(b.sent).toEqual([])
  expect(b.writes).toEqual([])
  expect(b.logged.length).toBeGreaterThan(0)
  // The walk reads the name now: the same chain, within the memo's lifetime, judges it.
  b.rename('Orch : far')
  await deliverAll(hb, b, a, messages)
  expect(b.messages().some(m => m?.kind === 'done' && m.ok)).toBe(true)
  expect(b.submits.length).toBe(1)
})

test('the end is allowed on the name read afresh when the done arrives, not on the one remembered', async () => {
  const s = launcherOpened()
  await s.moving['tool.call:move_send'](s.fx.dollar, sendInput(s.fx))
  const manifest = s.fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const peer = { name: 'Orch : far', address: ADDRESS_B }
  // An answer first: the name is read and remembered as « Orch : belt ».
  await receive(s.moving, s.fx, textOf({ kind: 'ack', move: manifest.move, file: 0, ok: true, reason: null }), peer)
  s.fx.rename('Orch : other')
  const done = { kind: 'done', move: manifest.move, ok: true, brief: `${HOME_B}/.claude/claude-orchestrator/briefs/belt/${BRIEF_NAME}`, reason: null } as const
  await receive(s.moving, s.fx, textOf(done), peer)
  expect(s.fx.submits.length).toBe(1)
  expect(await s.naming[`tool.call:${END_TOOL}`](s.fx.dollar, {})).toEqual({ result: REFUSED_TODAY, isError: true })
})

// --- a refusal the receiver can attribute is answered -------------------------------------

const doneOf = (b: Machine) => b.messages().filter((m): m is Extract<MoveMessage, { kind: 'done' }> => m?.kind === 'done')

test('a session named another role answers the manifest and the « sent » done not ok, and drops a chunk', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver({ name: 'Agent : x' })
  await deliverAll(hb, b, a, messages)
  const answers = doneOf(b)
  expect(answers.map(m => [m.ok, m.brief, m.move])).toEqual([[false, null, manifest.move], [false, null, manifest.move]])
  expect(answers[0].reason).toContain('neither an orchestrator nor a coordinator')
  expect(b.sent.every(m => m.to === ADDRESS_A)).toBe(true)
  expect(b.writes).toEqual([])
  expect(b.submits).toEqual([])
})

test('the sender learns why a session named another role refused the move', async () => {
  const ha = mounted()
  const a = sender()
  await ha['tool.call:move_send'](a.dollar, sendInput(a))
  const hb = mounted()
  const b = receiver({ name: 'Agent : x' })
  await settle(a, ha, b, hb)
  expect(a.submits.length).toBe(1)
  expect(a.submits[0].text).toContain('neither an orchestrator nor a coordinator')
})

test('a manifest that cannot be stored is answered done not ok, and nothing is held', async () => {
  for (const fault of ['write', 'mkdir'] as const) {
    const { a, manifest } = await sentMessages()
    const hb = mounted()
    const b = receiver()
    if (fault === 'write') b.faults.writes.push('manifest.json')
    else b.faults.mkdir = true
    await receive(hb, b, textOf(manifest), a)
    const done = doneOf(b)
    expect(done.length).toBe(1)
    expect(done[0]).toMatchObject({ ok: false, brief: null, move: manifest.move })
    expect(done[0].reason).toContain('stored')
    expect(b.submits).toEqual([])
    // Nothing is held: a « sent » of the move is answered as unknown.
    b.faults.writes = []
    b.faults.mkdir = false
    await receive(hb, b, textOf({ kind: 'sent', move: manifest.move }), a)
    expect(doneOf(b)[1].reason).toContain('send it again')
  }
})

test('a manifest of a move held for another sender is answered done not ok, and the held move is kept', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  await receive(hb, b, textOf(manifest), a)
  const stranger = { name: 'Orch : intruder', address: 'bridge:session_03Stranger' }
  const writes = [...b.writes]
  await receive(hb, b, textOf(manifest), stranger)
  const answered = b.sent.filter(m => m.to === stranger.address).map(m => parseMoveMessage(m.text))
  expect(answered).toEqual([{ kind: 'done', move: manifest.move, ok: false, brief: null, reason: expect.stringContaining('another') }])
  expect(b.writes).toEqual(writes)
  // The move goes on with its own sender.
  await deliverAll(hb, b, a, messages.slice(1))
  expect(b.submits.length).toBe(1)
})

test('a « sent » for a move not held is answered done not ok; a chunk of one stays dropped', async () => {
  const { a, messages, manifest } = await sentMessages()
  const hb = mounted()
  const b = receiver()
  await receive(hb, b, textOf(messages.find(m => m.kind === 'chunk')!), a)
  expect(b.sent).toEqual([])
  expect(b.logged.length).toBeGreaterThan(0)
  await receive(hb, b, textOf({ kind: 'sent', move: manifest.move }), a)
  expect(b.messages()).toEqual([{ kind: 'done', move: manifest.move, ok: false, brief: null, reason: 'no manifest held for this move; send it again' }])
  expect(b.sent[0].to).toBe(ADDRESS_A)
  // A message that does not parse stays dropped too.
  await receive(hb, b, '[module-move] {"kind":', a)
  expect(b.sent.length).toBe(1)
})

// --- the sender pins the receiver's address -----------------------------------------------

test('a reply matched by name is accepted while the move holds no address; the first one pins its address', async () => {
  const ha = mounted()
  const a = sender()
  await ha['tool.call:move_send'](a.dollar, sendInput(a, { to: 'Orch : far' }))
  const manifest = a.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const real = { name: 'Orch : far', address: ADDRESS_B }
  const twin = { name: 'Orch : far', address: 'bridge:session_04Twin' }
  const done = textOf({ kind: 'done', move: manifest.move, ok: true, brief: `${HOME_B}/b.md`, reason: null })
  await receive(ha, a, textOf({ kind: 'ack', move: manifest.move, file: 0, ok: true, reason: null }), real)
  expect(JSON.parse(a.files.get(`${a.store}/moves/${manifest.move}.json`)!).peer).toBe(ADDRESS_B)
  // The same name from another address no longer counts.
  const before = a.sent.length
  const dropped = await receive(ha, a, done, twin)
  expect(typeof dropped.consumed).toBe('string')
  expect(a.submits).toEqual([])
  expect(a.sent.length).toBe(before)
  // The pinned address goes on being heard, and ends the move.
  await receive(ha, a, done, real)
  expect(a.submits.length).toBe(1)
})

test('a missing answered from another address than the pinned one resends nothing', async () => {
  const ha = mounted()
  const a = sender()
  await ha['tool.call:move_send'](a.dollar, sendInput(a, { to: 'Orch : far' }))
  const manifest = a.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  const missing = textOf({ kind: 'missing', move: manifest.move, chunks: [[0, 0]] })
  await receive(ha, a, missing, { name: 'Orch : far', address: ADDRESS_B })
  const before = a.sent.length
  await receive(ha, a, missing, { name: 'Orch : far', address: 'bridge:session_04Twin' })
  expect(a.sent.length).toBe(before)
  expect(JSON.parse(a.files.get(`${a.store}/moves/${manifest.move}.json`)!).rounds).toBe(1)
})

test('the answers of a probe are pinned to the address of the first, too', async () => {
  const ha = mounted()
  const a = sender()
  await ha['tool.call:move_probe'](a.dollar, { to: 'Orch : far', sizes: [2048, 8192] })
  const move = (a.messages()[0] as Extract<MoveMessage, { kind: 'probe' }>).move
  const ack = (size: number) => textOf({ kind: 'probe-ack', move, size, received: size })
  await receive(ha, a, ack(2048), { name: 'Orch : far', address: ADDRESS_B })
  await receive(ha, a, ack(8192), { name: 'Orch : far', address: 'bridge:session_04Twin' })
  const lines = () => (a.files.get(`${a.store}/moves/probes.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(lines().map(l => [l.size, l.from])).toEqual([[2048, ADDRESS_B]])
  await receive(ha, a, ack(8192), { name: 'Orch : far', address: ADDRESS_B })
  expect(lines().map(l => l.size)).toEqual([2048, 8192])
})

// --- the receive fallback -----------------------------------------------------------------

test('the receive fallback consumes a move-marked delivery only; anything else goes to the next handler', async () => {
  const hb = mounted()
  const b = receiver()
  const fallback = hb['catch:session.receive']
  const failing = Object.assign(async (e: any) => ({ passed: e.text }), { error: { kind: 'failure', message: 'the hook did not finish' } })
  const plain = envelope('a note from a peer', 'Orch : belt', ADDRESS_A)
  expect(await fallback(b.dollar, { origin: { kind: 'peer' }, text: plain }, failing)).toEqual({ passed: plain })
  const marked = envelope(textOf({ kind: 'sent', move: 'belt-0123456789ab' }), 'Orch : belt', ADDRESS_A)
  const consumed = await fallback(b.dollar, { origin: { kind: 'peer' }, text: marked }, failing)
  expect(typeof consumed.consumed).toBe('string')
  expect(consumed.passed).toBeUndefined()
  expect(await fallback(b.dollar, { origin: { kind: 'user' }, text: 'typed by a person' }, failing)).toEqual({ passed: 'typed by a person' })
  expect(await fallback(b.dollar, { origin: { kind: 'peer' } }, failing)).toEqual({ passed: undefined })
  expect(b.logged.length).toBe(4)
})

// --- every failure after the call reaches the sender's model, once ------------------------

const RESUME = 'call move_send again with the same arguments to resume it'

test('a resend after « missing » that stops ends the move: one notice with the cause and how to resume', async () => {
  for (const fault of ['throws', 'undelivered'] as const) {
    const { a, ha, manifest } = await sentMessages(500)
    const peer = { name: 'Orch : far', address: ADDRESS_B }
    const missing = textOf({ kind: 'missing', move: manifest.move, chunks: [[1, 2]] })
    if (fault === 'throws') a.faults.sendThrowsAfter = a.sent.length
    else a.faults.unreachable.push(ADDRESS_B)
    await receive(ha, a, missing, peer)
    expect(a.submits.length).toBe(1)
    expect(a.submits[0].text).toContain(RESUME)
    expect(a.submits[0].text).toContain(fault === 'throws' ? 'the bridge dropped' : 'no such session')
    expect(JSON.parse(a.files.get(`${a.store}/moves/${manifest.move}.json`)!).done).toEqual({ ok: false })
    // Once: a later answer starts nothing.
    await receive(ha, a, missing, peer)
    expect(a.submits.length).toBe(1)
  }
})

test('a send that throws midway through move_send answers the same text as an undelivered one', async () => {
  const h = mounted()
  const fx = sender()
  fx.faults.sendThrowsAfter = 2
  const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx, { chunk: 1000 }))
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('not fully sent')
  expect(answer.result).toContain(RESUME)
  expect(answer.result).toContain('the bridge dropped')
  expect(answer.result).not.toContain('could not be sent')
  // Called again with the same arguments, the same move goes through.
  fx.faults.sendThrowsAfter = null
  const again = await h['tool.call:move_send'](fx.dollar, sendInput(fx, { chunk: 1000 }))
  expect(again.isError).toBeUndefined()
  expect(kinds(fx).filter(k => k === 'manifest').length).toBe(2)
})

test('a store write that fails when the move is answered is logged, and the notice is still submitted', async () => {
  const peer = { name: 'Orch : far', address: ADDRESS_B }
  const ok = launcherOpened()
  await ok.moving['tool.call:move_send'](ok.fx.dollar, sendInput(ok.fx))
  const manifest = ok.fx.messages()[0] as Extract<MoveMessage, { kind: 'manifest' }>
  ok.fx.faults.writes.push('.json')
  const brief = `${HOME_B}/.claude/claude-orchestrator/briefs/belt/${BRIEF_NAME}`
  await receive(ok.moving, ok.fx, textOf({ kind: 'done', move: manifest.move, ok: true, brief, reason: null }), peer)
  expect(ok.fx.submits).toEqual([{ text: acknowledgedNotice(manifest.record, ADDRESS_B, brief) }])
  expect(ok.fx.logged.length).toBeGreaterThan(0)
  expect(await ok.naming[`tool.call:${END_TOOL}`](ok.fx.dollar, {})).toEqual({ result: 'This session ends when this turn ends.' })
  const failed = await sentMessages()
  failed.a.faults.writes.push('.json')
  await receive(failed.ha, failed.a, textOf({ kind: 'done', move: failed.manifest.move, ok: false, brief: null, reason: 'refused' }), peer)
  expect(failed.a.submits).toEqual([{ text: failedNotice(failed.manifest.record, ADDRESS_B, 'refused') }])
  expect(failed.a.logged.length).toBeGreaterThan(0)
})

// --- a checkout whose remote or branch cannot be read refuses the move --------------------

test('a working directory inside a git work tree whose remote or branch cannot be read refuses the move', async () => {
  const h = mounted()
  const cases: [string, Repo, string][] = [
    ['no origin remote', {}, 'origin'],
    ['a detached HEAD', { remote: 'git@example.com:acme/app.git', detached: true }, 'branch'],
    ['git failing on the branch', { remote: 'git@example.com:acme/app.git', branchFails: true }, 'branch'],
  ]
  for (const [, repo, word] of cases) {
    const fx = sender({ repos: { [`${HOME_A}/dev/app`]: repo, [`${HOME_A}/dev/lib`]: {} } })
    const answer = await h['tool.call:move_send'](fx.dollar, sendInput(fx))
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain(`${HOME_A}/dev/app`)
    expect(answer.result).toContain(word)
    expect(fx.sent).toEqual([])
    expect([...fx.files.keys()].some(p => p.includes('/moves/'))).toBe(false)
  }
  // A directory outside any work tree still gives no git, and the move goes.
  const plain = sender()
  const sentOk = await h['tool.call:move_send'](plain.dollar, sendInput(plain, { dir: `${HOME_A}/dev/plain` }))
  expect(sentOk.isError).toBeUndefined()
})

// --- what a file holds never passes its announced size ------------------------------------

const heldChunks = (b: Machine) => [...b.files.keys()].filter(p => /\/c-\d+-\d+$/.test(p))

test('a chunk that would pass the announced size of its file is dropped with a log line and nothing written', async () => {
  const { a, messages, manifest } = await sentMessages(500)
  const hb = mounted()
  const b = receiver()
  await receive(hb, b, textOf(manifest), a)
  const notes = manifest.files[1]
  const chunk = (index: number, data: string): MoveMessage => ({ kind: 'chunk', move: manifest.move, file: 1, index, data })
  const first = messages.find(m => m.kind === 'chunk' && m.file === 1 && m.index === 0) as Extract<MoveMessage, { kind: 'chunk' }>
  // One chunk alone over the size.
  await receive(hb, b, textOf(chunk(0, 'x'.repeat(notes.bytes + 1))), a)
  expect(heldChunks(b)).toEqual([])
  expect(b.logged.length).toBe(1)
  // The announced size is held to, the chunks together: a chunk that tips it over is dropped.
  await receive(hb, b, textOf(chunk(0, first.data)), a)
  await receive(hb, b, textOf(chunk(1, 'y'.repeat(notes.bytes - first.data.length + 1))), a)
  expect(heldChunks(b)).toEqual([`${b.store}/moves/${manifest.move}/c-1-0`])
  expect(b.logged.length).toBe(2)
  // What was dropped poisoned nothing: the genuine chunks complete the file.
  await deliverAll(hb, b, a, messages.slice(1))
  expect(b.files.get(`${b.briefs}/belt/notes.txt`)).toBe(NOTES_TEXT)
  expect(b.submits.length).toBe(1)
})

test('after a reload the lengths held are rebuilt from the chunk files', async () => {
  const { a, manifest } = await sentMessages(500)
  const b = receiver()
  const before = mounted()
  await receive(before, b, textOf(manifest), a)
  const notes = manifest.files[1]
  const chunk = (index: number, data: string): MoveMessage => ({ kind: 'chunk', move: manifest.move, file: 1, index, data })
  await receive(before, b, textOf(chunk(0, 'x'.repeat(notes.bytes - 10))), a)
  const after = mounted()
  await receive(after, b, textOf(chunk(1, 'y'.repeat(11))), a)
  expect(heldChunks(b)).toEqual([`${b.store}/moves/${manifest.move}/c-1-0`])
  await receive(after, b, textOf(chunk(1, 'y'.repeat(10))), a)
  expect(heldChunks(b).length).toBe(2)
})

// --- a reload in the middle of a move -----------------------------------------------------

test('the module reloads in the middle of a move: the held move is read back, the rest is received, one arrival notice', async () => {
  const { a, messages, manifest } = await sentMessages(500)
  const b = receiver()
  const half = Math.floor(messages.length / 2)
  const before = mounted()
  await deliverAll(before, b, a, messages.slice(0, half))
  expect(b.submits).toEqual([])
  // A fresh module on the same machine: its memory is empty, the store is not.
  const after = mounted()
  await deliverAll(after, b, a, messages.slice(half))
  const arrival = arrivalOf(manifest, TARGET_B) as any
  expect(b.files.get(arrival.brief)).toBe(BRIEF_ARRIVED)
  expect(b.files.get(`${arrival.briefDir}/notes.txt`)).toBe(NOTES_TEXT)
  expect(b.submits).toEqual([{ text: arrivedNotice(manifest, arrival, 'Orch : belt', LAUNCHER) }])
  expect(doneOf(b).length).toBeGreaterThan(0)
  expect(doneOf(b).every(m => m.ok)).toBe(true)
  expect(b.logged).toEqual([])
  // A reload after the arrival notice does not notify again when the move is sent once more.
  const later = mounted()
  await deliverAll(later, b, a, messages)
  expect(b.submits.length).toBe(1)
})
