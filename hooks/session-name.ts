// hooks/session-name.ts
// The pure half of the session's naming, ported from hooks/session_name.py: the
// parsers the walk feeds — the role of a name, the value of a custom-title
// entry, the name a flat ps listing was launched with, the host's own record of
// a live session — and the walk itself, running over injected plain reader
// thunks. The engine fences $ to the file that received it — never passed
// across an import, a noun of it never read as a value — so the reads stay in
// the files whose handlers hold $ (guards.ts, supervision.ts), each building
// the same thunks over its own $ while this file holds the walk's logic once.
const NAME_READABLE_MAX = 40

// The block the transcript walks read: dd's window, the unit the carry logic
// below counts in. Exported: the $-holding halves size their windows with it.
export const BLOCK = 65536

// How far back from its end a transcript is walked: the tail only. The host's
// record names a live session (hostRecordOf below), so the walk is the fallback
// of a host that keeps none, and a rename further back than this is not looked
// for — a walk to the start of a long transcript spawned hundreds of reads at
// every prompt and every stop.
export const TAIL_CAP = 32 * BLOCK

// The walk's reads, injected as plain function values, never $: `run` covers
// the process table (the self-tty seed, the tty's listing), `sizeOf` and
// `readBlock` the transcript's blocks — one BLOCK-sized window at `index`,
// counted from the file's start, as bytes: a character the window cuts in two
// is joined whole with its other half before any text is decoded. `readRecord`
// answers the host's record of a pid (`<config>/sessions/<pid>.json`), null
// when there is none; `hostNames` the basenames the host's binary goes by.
export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>
export type SizeOf = (path: string) => Promise<number>
export type ReadBlock = (path: string, index: number) => Promise<Uint8Array>
export type ReadRecord = (pid: string) => Promise<string | null>
export type HostNames = () => Promise<readonly string[]>

export function roleOf(name: string | null): 'orchestrator' | 'agent' | 'auditor' | 'coordinator' | null {
  if (!name) return null
  if (name.startsWith('Orch :')) return 'orchestrator'
  if (name.startsWith('Agent :')) return 'agent'
  if (name.startsWith('Audit :')) return 'auditor'
  if (name.startsWith('Coord :')) return 'coordinator'
  return null
}

export function isTitle(line: string): boolean {
  return /"type"\s*:\s*"custom-title"/.test(line)
}

// unquoted()'s rule (session_name.py:75-78): whitespace off, then the
// surrounding quotes — straight or curly, single or double — then whitespace
// again; what remains empty reads as null: a padded or quoted rename still
// names its role. Every reader of a stored name goes through it.
export function unquoted(raw: string): string | null {
  const name = raw.trim().replace(/^["'‘’“”]+/, '').replace(/["'‘’“”]+$/, '').trim()
  return name || null
}

export function titleOf(line: string): string | null {
  const m = line.match(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return null
  return unquoted(JSON.parse(`"${m[1]}"`) as string)
}

// The host's own record of a live session (<config>/sessions/<pid>.json): its
// id, its name as the rename stored it — unquoted, the rule above — and its
// status. Null for a text that is no such record.
export function hostRecordOf(text: string): { sessionId: string | null; name: string | null; status: 'idle' | 'busy' | null } | null {
  let record: { sessionId?: unknown; name?: unknown; status?: unknown }
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object') return null
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    name: typeof record.name === 'string' ? unquoted(record.name) : null,
    status: record.status === 'idle' || record.status === 'busy' ? record.status : null,
  }
}

// self_tty()'s parse: the parent and the controlling tty of one ps line,
// either of which may be absent or report none.
export function parentAndTty(out: string): { ppid: string; tty: string } {
  const [ppid = '', tty = ''] = out.trim().split(/\s+/)
  return { ppid, tty }
}

// session_name_on()'s parse (iterm_agent.py): the name a session was launched
// with, read from the FLAT command line ps prints — the quoting that made the
// name one argument is gone, and the launcher puts --name last precisely so
// the words after it run to the end of the line. Past the launcher's own bound
// (NAME_READABLE_MAX) what the table hands back is a launch line, not a name.
export function launchNameOf(command: string): string | null {
  const words = command.trim().split(/\s+/)
  const at = words.indexOf('--name')
  if (at < 0) return null
  const tail: string[] = []
  for (const word of words.slice(at + 1)) {
    if (word.startsWith('--')) break
    tail.push(word)
  }
  if (tail.length === 0) return null
  const joined = tail.join(' ')
  return joined.length <= NAME_READABLE_MAX ? joined : null
}

// The rows of `ps -o pid=,command=`: each process's pid and flat command line.
export function processRows(out: string): { pid: string; command: string }[] {
  const rows: { pid: string; command: string }[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)/.exec(line)
    if (m) rows.push({ pid: m[1], command: m[2] })
  }
  return rows
}

const basenameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

// The basenames a process of the host goes by: the name ORCHESTRATOR_HOST_CLI
// spells and, when that is a wrapper or a link, the binary it resolves to — the
// launcher's own rule, so a session typed as a bare name and one launched by its
// full path are the same host either way.
export function hostBasenames(host: string, resolved: string | null): string[] {
  const names = [basenameOf(host)]
  if (resolved && !names.includes(basenameOf(resolved))) names.push(basenameOf(resolved))
  return names.filter(Boolean)
}

// --- the walk itself ----------------------------------------------------------------------

// self_tty() ported (iterm_agent.py): the session's own tty, found by walking
// up the process table. The sandbox exposes no process global, so the walk is
// seeded by a shell child of this very session: its controlling tty is the
// session's tab, and its parent is the session's own process.
async function selfTty(run: Run): Promise<string | null> {
  let ask: readonly string[] = ['sh', '-c', 'ps -o ppid=,tty= -p $$']
  for (let i = 0; i < 12; i++) {
    let out = ''
    try {
      out = (await run(ask)).stdout ?? ''
    } catch {
      return null
    }
    if (!out) return null
    const { ppid, tty } = parentAndTty(out)
    if (tty && tty !== '??' && tty !== '-') return `/dev/${tty}`
    if (!/^\d+$/.test(ppid) || Number(ppid) <= 1) return null
    ask = ['ps', '-p', ppid, '-o', 'ppid=,tty=']
  }
  return null
}

export type HostProcess = { pid: string; command: string; record: ReturnType<typeof hostRecordOf> }

// The identity rule the launcher keeps too: a process on a tty is the host's
// session when its pid has a host record, or when its argv[0] goes by one of
// the host's basenames. A record outranks a name — a wrapper that execs the
// binary, a session typed as a bare name, and one launched by its full path
// are all recorded — and among recorded processes this session's own id wins.
// The basenames are asked for only when no record answers.
export async function hostOn(
  run: Run, readRecord: ReadRecord, hostNames: HostNames, tty: string, sessionId = '',
): Promise<HostProcess | null> {
  const out = (await run(['ps', '-t', tty.replace(/^\/dev\//, ''), '-o', 'pid=,command='])).stdout ?? ''
  const rows = processRows(out)
  const recorded: HostProcess[] = []
  for (const row of rows) {
    const record = hostRecordOf((await readRecord(row.pid)) ?? '')
    if (record) recorded.push({ ...row, record })
  }
  if (recorded.length > 0) return recorded.find(p => sessionId && p.record?.sessionId === sessionId) ?? recorded[0]
  const names = await hostNames()
  const named = rows.find(row => names.includes(basenameOf(row.command.split(/\s+/)[0] ?? '')))
  return named ? { ...named, record: null } : null
}

// A port of title_in() in hooks/session_name.py:51-72 — seek from the end in
// BLOCK-sized steps, carry the cut first line, answer the first line from the
// end that `matches` — but over bytes, and the tail only (TAIL_CAP). `complete`
// says the walk read everything it meant to: false when a read failed or the
// cap stopped it short of the file's start, so a caller can tell « nothing
// there » from « not read ».
export async function scanTail(
  sizeOf: SizeOf, readBlock: ReadBlock, path: string, matches: (line: string) => boolean, cap = TAIL_CAP,
): Promise<{ line: string | null; complete: boolean }> {
  if (!path) return { line: null, complete: true }
  const decoder = new TextDecoder()
  try {
    const size = await sizeOf(path)
    const last = Math.max(0, Math.ceil(size / BLOCK) - 1)
    const first = Math.max(0, last - Math.ceil(cap / BLOCK) + 1)
    let carry = new Uint8Array(0)
    for (let index = last; index >= first; index--) {
      const block = await readBlock(path, index)
      const chunk = new Uint8Array(block.length + carry.length)
      chunk.set(block)
      chunk.set(carry, block.length)
      // Unless this block starts the file, its first line is cut: its
      // beginning lives one block to the left, so it is carried there.
      const cut = index > 0 ? chunk.indexOf(0x0a) : -1
      carry = index > 0 ? (cut < 0 ? chunk : chunk.slice(0, cut)) : new Uint8Array(0)
      if (index > 0 && cut < 0) continue
      const lines = decoder.decode(chunk.slice(cut + 1)).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (matches(lines[i])) return { line: lines[i], complete: true }
      }
    }
    return { line: null, complete: first === 0 }
  } catch {
    return { line: null, complete: false }
  }
}

// title_in answers its first match from the end unconditionally: a rename to
// whitespace — or a value the host did not store as a string — reads back null
// here and the walk stops, unnamed; it does not resurrect the name before it.
export async function lastCustomTitle(sizeOf: SizeOf, readBlock: ReadBlock, path: string): Promise<string | null> {
  const { line } = await scanTail(sizeOf, readBlock, path, isTitle)
  return line === null ? null : titleOf(line)
}

// read_name() ported (session_name.py:81-92), on the identity rule: the tty
// first — a session with none (a headless run) is named by nobody — then the
// host process on it, named by its record, else by its launch name, else, for
// a host that keeps no record, by the transcript's last rename. `pid` is the
// host process's; `known` is false when a read failed or the bounded walk did
// not finish — the name is then unknown, never a session found unnamed, and a
// caller that keeps a name does not overwrite it with this null.
export async function walkName(
  run: Run, sizeOf: SizeOf, readBlock: ReadBlock, transcriptPath: string,
  readRecord: ReadRecord, hostNames: HostNames, sessionId = '',
): Promise<{ tty: string | null; name: string | null; pid: string | null; known: boolean }> {
  const tty = await selfTty(run)
  if (!tty) return { tty: null, name: null, pid: null, known: false }
  let host: HostProcess | null
  try {
    host = await hostOn(run, readRecord, hostNames, tty, sessionId)
  } catch {
    return { tty, name: null, pid: null, known: false }
  }
  const pid = host?.pid ?? null
  const named = host?.record?.name ?? (host ? launchNameOf(host.command) : null)
  if (named || host?.record) return { tty, name: named, pid, known: true }
  const { line, complete } = await scanTail(sizeOf, readBlock, transcriptPath, isTitle)
  return { tty, name: line === null ? null : titleOf(line), pid, known: line !== null || complete }
}

// One transcript window as the $-holding halves read it: dd's block, base64 on
// the way out so the bytes cross the process API intact — its stdout is text,
// and a character the window cuts would come back as two replacement marks.
export function blockArgv(path: string, index: number): string[] {
  return ['sh', '-c', 'dd if="$1" bs="$2" skip="$3" count=1 2>/dev/null | base64', 'sh', path, String(BLOCK), String(index)]
}

// base64's answer back to bytes; the line breaks a base64 may wrap at are skipped.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function bytesOfBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let bits = 0, value = 0, at = 0
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
      value &= (1 << bits) - 1
    }
  }
  return out.slice(0, at)
}
