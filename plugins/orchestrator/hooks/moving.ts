// hooks/moving.ts
// The module moves an orchestrator's files to another machine (the protocol is move.ts's, pure).
// Two tools a supervising session calls: move_send reads the directory of a brief, hashes its
// files, checks that every checkout is clean and pushed, and sends the manifest, the chunks and
// « sent » to a peer; move_probe sends probes of growing sizes to measure the largest message
// that crosses. The receiving half takes every marked delivery out of the chain before a model
// reads it, keeps it under the store, writes each file that arrived whole and checked, and
// answers; the sending half reads the answers. Only two texts ever reach a model: the arrival
// notice, on the receiver, and the notice of the outcome, on the sender.
import { moduleDirOf } from './module-log.ts'
import { launcherOf } from '../core/orchestration.ts'
import { roleOf, walkName, hostBasenames, blockArgv, bytesOfBase64, type ReadRecord, type HostNames } from './session-name.ts'
import { withDeadline, isDegradedPass } from './stop-gate.ts'
import { machineLabel, deliveryOf, isPeerOrigin, type Delivery } from './remote-row.ts'
import {
  MOVE_CHUNK_DEFAULT, MOVE_TEXT_CAP, MOVE_FILE_CAP, MOVE_MISSING_ROUNDS,
  acknowledgedNotice, failedNotice, moveText, isMoveMarked, parseMoveMessage, chunkText, moveIdOf, checkManifestFiles, rewritePaths, arrivalOf, arrivalPairs, missingOf, arrivedNotice,
  type Arrival, type Cleaned, type ManifestFile, type MoveMessage, type MoveRecord,
} from './move.ts'
import { messageOf, type Events, type Host, type On } from './host.ts'
import { recordFiles, recordNamedIn } from '../skills/orchestrator/scripts/lib/record-paths.ts'
import { removeArgv, staleTemporaries, temporaryOf, withLockOver, writeAtomicOver } from '../core/store-io.ts'
import { configDir, logLine, storeIo, uniqueTag, writeAtomic } from './module-io.ts'

export const SEND_TOOL = 'move_send'
export const PROBE_TOOL = 'move_probe'

// The refusal a subagent's call gets: a move is the main thread's.
const MAIN_THREAD_ONLY = "only the session's main thread moves an orchestrator"

// A move is an orchestrator's or a coordinator's to make.
const ROLE_ONLY = 'a move is sent by a session named "Orch: <subject>" or "Coord: <subject>"'

// The largest chunk a call may ask for, so a marked line stays far under the receiver's cap even
// when every character of its data is escaped.
const CHUNK_MAX = Math.floor(MOVE_TEXT_CAP / 8)

// The most probes one call sends, and the longest address it takes.
const PROBES_CAP = 16
const ADDRESS_CAP = 200

// How long the name walk of this file may take.
const NAME_WALK_MS = 3000

// The bound on one process this file starts.
const RUN_MS = 20000
const GIT_MS = 15000

// The names of the sessions that ended a move acknowledged: naming.ts reads whether this
// session may end itself. Set at every mount, so a reload forgets it.
let movedAndAcknowledged = new Set<string>()

// Whether a move this session sent, under its own name, was acknowledged whole by the receiver:
// the one case where a session the launcher opened may end itself.
export function endsAfterMove(): boolean {
  return movedAndAcknowledged.size > 0
}

// The nouns the move holds.
type Dollar = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'tool' | 'prompt' | 'clock'>

export function register(on: On<Dollar>): void {
  movedAndAcknowledged = new Set<string>()
  // What the receiving half holds of each move, loaded from the store the first time a message
  // names it; and the chain each move's messages run down one at a time, since two chunks
  // handled at once could both find a file complete.
  const held = new Map<string, Held>()
  const chains = new Map<string, Promise<unknown>>()
  const receiving: Receiving = { held, chains, name: null, probes: new Map() }

  on('session.start', {}, async ($, e, next) => {
    try {
      await $.tool.register({
        name: SEND_TOOL,
        isDeferred: false,
        description: "Sends an orchestrator's files to another session, module to module: the files of the directory of its brief, in chunks, with their hashes; the receiver's module writes them and answers. Refused unless every checkout is clean and pushed. Calling it again with the same arguments resumes the same move.",
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: "The receiving session's address or name" },
            name: { type: 'string', description: 'The moved orchestrator\'s name, "Orch: <subject>", with no reference' },
            brief: { type: 'string', description: 'Absolute path of its brief, on this machine; the files beside it travel' },
            dir: { type: 'string', description: 'Absolute path of its working directory, on this machine' },
            model: { type: 'string', description: 'The model it runs on, as `iterm-agent.sh pair` reads it' },
            effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'The effort it runs at, as `iterm-agent.sh pair` reads it' },
            prs: { type: 'array', items: { type: 'string' }, description: 'Its pull requests, one line each' },
            checkouts: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of its checkouts on this machine; each must be clean and pushed' },
            order: { type: 'string', description: "The operator's order, verbatim and dated" },
            chunk: { type: 'integer', description: `Data characters per chunk, ${MOVE_CHUNK_DEFAULT} by default` },
          },
          required: ['to', 'name', 'brief', 'dir', 'model', 'effort', 'prs', 'checkouts', 'order'],
        },
      })
      await $.tool.register({
        name: PROBE_TOOL,
        isDeferred: false,
        description: 'Sends one probe per size to another session; its module answers each with the length it received, and the answers are appended to the store\'s probes file. Measures the largest message that crosses.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: "The receiving session's address or name" },
            sizes: { type: 'array', items: { type: 'integer' }, description: 'Data characters of each probe' },
          },
          required: ['to', 'sizes'],
        },
      })
    } catch (err) {
      // A start never fails on a tool: the session runs without the move.
      await logLine($, 'moving', `move tools not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'moving', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A peer's delivery, read before it is queued. A marked move message is consumed whatever its
  // fate: it is the module's own, never a message for a model, and what it cannot act on is
  // dropped with one line in the log. Anything else passes through untouched.
  on('session.receive', {}, async ($, e, next) => {
    if (e.agentId || !isPeerOrigin(e.origin) || typeof e.text !== 'string') return next(e)
    const delivery = deliveryOf(e.text)
    if (!isMoveMarked(delivery.body)) return next(e)
    try {
      await take($, receiving, delivery)
    } catch (err) {
      await logLine($, 'moving', `move: ${messageOf(err)}`)
    }
    return { consumed: 'orchestrator: a move message, handled by the module' }
  }).catch(async ($, e, next) => {
    await logLine($, 'moving', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    // Only a move message is the module's to consume; a delivery it never looked at goes on.
    if (typeof e.text === 'string' && isMoveMarked(deliveryOf(e.text).body)) return { consumed: 'orchestrator: a move message, refused' }
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${SEND_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: MAIN_THREAD_ONLY, isError: true }
    const refused = await roleRefusal($)
    if (refused) return { result: refused, isError: true }
    return sendMove($, e)
  }).catch(async ($, e, next) => {
    await logLine($, 'moving', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the move could not be sent', isError: true }
  })

  on('tool.call', { tool: `mcp__orchestrator__${PROBE_TOOL}` }, async ($, e) => {
    if (e.agentId) return { result: MAIN_THREAD_ONLY, isError: true }
    const refused = await roleRefusal($)
    if (refused) return { result: refused, isError: true }
    return sendProbes($, e, receiving)
  }).catch(async ($, e, next) => {
    await logLine($, 'moving', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the probes could not be sent', isError: true }
  })
}

// --- paths -------------------------------------------------------------------------------

async function movesDir($: Dollar): Promise<string> {
  return `${moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store/moves`
}

// --- the session's own name --------------------------------------------------------------

// The session's name, read the way the other halves read it (a walk over the process table and
// the host's own record), under a bound; null when it is unknown. Each file spells its own
// readers: $ never crosses an import.
async function nameOf($: Dollar): Promise<string | null> {
  const until = Date.now() + NAME_WALK_MS
  const left = () => Math.max(1, until - Date.now())
  const config = await configDir($)
  const sessionId = String(await $.session.id())
  const readRecord: ReadRecord = async (pid: string) => {
    try {
      return String(await $.fs.read(`${config}/sessions/${pid}.json`))
    } catch {
      return null
    }
  }
  const hostNames: HostNames = async () => {
    const host = (await $.env.get('ORCHESTRATOR_HOST_CLI')) ?? 'claude'
    let resolved: string | null = null
    try {
      const found = await $.process.run(['sh', '-c', 'command -v -- "$1"', 'sh', host], { timeoutMs: left() })
      const path = found.exitCode === 0 ? String(found.stdout ?? '').trim() : ''
      if (path.startsWith('/')) resolved = (await $.fs.stat(path, { resolve: true })).realPath ?? path
    } catch { /* unresolved: the spelled name alone */ }
    return hostBasenames(host, resolved)
  }
  try {
    // Each step checks the signal first: past the deadline the walk starts nothing more.
    const transcript = await transcriptPathOf($, sessionId)
    const walked = await withDeadline(signal => walkName(
      (argv: readonly string[]) => (signal.throwIfAborted(), $.process.run(argv, { timeoutMs: left() })),
      async (path: string) => (signal.throwIfAborted(), (await $.fs.stat(path)).size),
      async (path: string, index: number) => {
        signal.throwIfAborted()
        const { exitCode, stdout } = await $.process.run(blockArgv(path, index), { timeoutMs: left() })
        if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${path}`)
        return bytesOfBase64(String(stdout ?? ''))
      },
      transcript,
      readRecord,
      hostNames,
      sessionId,
    ), NAME_WALK_MS)
    return isDegradedPass(walked) || !walked.known ? null : walked.name
  } catch {
    return null
  }
}

// The transcript, found by session id under the projects directory: the fallback of a host that
// keeps no record of its sessions. A miss is '', and the walk then names nothing from it.
async function transcriptPathOf($: Dollar, sessionId: string): Promise<string> {
  try {
    const projects = `${await configDir($)}/projects`
    for (const entry of await $.fs.list(projects)) {
      if (entry.kind !== 'dir') continue
      const candidate = `${projects}/${entry.name}/${sessionId}.jsonl`
      if (await $.fs.exists(candidate)) return candidate
    }
  } catch { /* no projects directory: no transcript to name */ }
  return ''
}

// Why this session may not send a move, or null when it may: only an orchestrator or a
// coordinator moves one.
async function roleRefusal($: Dollar): Promise<string | null> {
  const role = roleOf(await nameOf($))
  return role === 'orchestrator' || role === 'coordinator' ? null : ROLE_ONLY
}

// --- the send ----------------------------------------------------------------------------

type Failure = { result: string; isError: true }
const failure = (result: string): Failure => ({ result, isError: true })

type SendInput = { to: string; record: MoveRecord; chunk: number }

// What the sender's model is told to do when a move stopped midway.
const RESUME = 'call move_send again with the same arguments to resume it'

// The effort is never empty: an opened orchestrator carries its model with its effort, and
// the sender reads both with `iterm-agent.sh pair` rather than declaring a default.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// The call's arguments as a record, or the reason they are refused. What the protocol bounds
// (the name's shape, the paths, the order's length) is judged once the manifest is built.
function inputOf(e: Events['tool.call']): SendInput | string {
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string')
  const { to, name, brief, dir, model, effort, prs, checkouts, order } = e
  if (!text(to) || to.length > ADDRESS_CAP || /[\u0000-\u001f\u007f]/.test(to)) return 'to: the receiving session\'s address or name is required'
  if (!text(name)) return 'name: required'
  if (!text(brief) || !brief.startsWith('/') || brief.endsWith('/')) return 'brief: an absolute path of a file is required'
  if (!text(dir) || !dir.startsWith('/')) return 'dir: an absolute path is required'
  if (!text(model)) return 'model: required'
  if (!isEffort(effort)) return `effort: one of ${EFFORTS.map(v => `"${v}"`).join(', ')}`
  if (!list(prs)) return 'prs: a list of strings is required'
  if (!list(checkouts) || !checkouts.every(c => c.startsWith('/'))) return 'checkouts: a list of absolute paths is required'
  if (!text(order)) return 'order: the operator\'s order is required'
  const chunk = e['chunk'] === undefined ? MOVE_CHUNK_DEFAULT : e['chunk']
  if (typeof chunk !== 'number' || !Number.isInteger(chunk) || chunk < 1 || chunk > CHUNK_MAX) return `chunk: a whole number from 1 to ${CHUNK_MAX}`
  const record: MoveRecord = { name, brief, dir, model, effort, prs, checkouts, git: null, order }
  return { to, record, chunk }
}

const isEffort = (v: unknown): v is MoveRecord['effort'] => typeof v === 'string' && EFFORTS.includes(v)

async function run($: Dollar, argv: string[], timeoutMs = RUN_MS): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const out = await $.process.run(argv, { timeoutMs })
    return out ? { exitCode: out.exitCode, stdout: String(out.stdout ?? '') } : null
  } catch {
    return null
  }
}

// The sha256 of a file, by the machine's own tool: shasum, else sha256sum.
async function sha256Of($: Dollar, path: string): Promise<string | null> {
  for (const argv of [['shasum', '-a', '256', path], ['sha256sum', path]]) {
    const out = await run($, argv)
    const hash = out?.exitCode === 0 ? /^[0-9a-f]{64}/.exec(out.stdout.trim())?.[0] : undefined
    if (hash) return hash
  }
  return null
}

// A checkout that cannot be left behind: uncommitted work, commits not pushed, or no upstream
// to say whether they are. Code travels by git, so the move waits for it.
async function checkoutRefusal($: Dollar, path: string): Promise<string | null> {
  const status = await run($, ['git', '-C', path, 'status', '--porcelain'], GIT_MS)
  if (!status || status.exitCode !== 0) return `${path}: not a git checkout`
  if (status.stdout.trim() !== '') return `${path}: uncommitted changes, commit and push them first`
  const ahead = await run($, ['git', '-C', path, 'rev-list', '@{u}..HEAD'], GIT_MS)
  if (!ahead || ahead.exitCode !== 0) return `${path}: no upstream branch to tell whether it is pushed`
  if (ahead.stdout.trim() !== '') return `${path}: commits not pushed yet`
  return null
}

// The remote and the branch of the working directory: null when it is no git work tree; when it
// is one, they are read or the move is refused, since the receiver rebuilds the code from them.
async function gitOf($: Dollar, dir: string): Promise<{ git: { url: string; branch: string } | null } | { refused: string }> {
  const inside = await run($, ['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'], GIT_MS)
  if (!inside) return { refused: `${dir}: git did not answer, so it cannot be told whether it is a checkout` }
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { git: null }
  const url = await run($, ['git', '-C', dir, 'remote', 'get-url', 'origin'], GIT_MS)
  if (!url || url.exitCode !== 0 || !url.stdout.trim()) return { refused: `${dir}: its origin remote cannot be read` }
  const branch = await run($, ['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_MS)
  const name = branch && branch.exitCode === 0 ? branch.stdout.trim() : ''
  if (!name || name === 'HEAD') return { refused: `${dir}: its branch cannot be read (git failed or HEAD is detached)` }
  return { git: { url: url.stdout.trim(), branch: name } }
}

type Manifest = Extract<MoveMessage, { kind: 'manifest' }>

// The files of the dispatch record the brief names that live outside its directory — the record,
// its owner, its goals — each that exists as a regular file, to travel with the brief. One that
// lies in the working directory or a checkout is git's to carry: it must be tracked there, or the
// move is refused, since nothing else would bring it to the other machine.
async function placedFiles(
  $: Dollar, record: MoveRecord, dir: string, inDir: readonly string[],
): Promise<{ files: { name: string; kind: string; size: number; at: string }[] } | { refused: string }> {
  let brief: string
  try {
    brief = String(await $.fs.read(record.brief))
  } catch {
    return { files: [] }
  }
  const named = recordNamedIn(brief)
  if (!named.startsWith('/')) return { files: [] }
  const files: { name: string; kind: string; size: number; at: string }[] = []
  for (const path of recordFiles(named)) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (path === `${dir}/${name}` && inDir.includes(name)) continue
    let size: number
    try {
      const stat = await $.fs.stat(path)
      if (stat.kind !== 'file') continue
      size = stat.size
    } catch {
      continue
    }
    const checkout = [record.dir, ...record.checkouts].find(c => path.startsWith(`${c.replace(/\/+$/, '')}/`))
    if (checkout !== undefined) {
      const tracked = await run($, ['git', '-C', checkout, 'ls-files', '--error-unmatch', '--', path], GIT_MS)
      if (tracked?.exitCode === 0) continue
      return { refused: `the dispatch record's file ${path} lies in ${checkout} and git does not track it: move the record beside the brief, and its line in the brief with it` }
    }
    files.push({ name, kind: 'file', size, at: path })
  }
  return { files }
}

// The reason a record is refused by the protocol's own shapes, found by taking the git field
// away and then judging the rest, so the reason names what is wrong.
function recordRefusal(manifest: Manifest): string | null {
  if (parseMoveMessage(moveText(manifest))) return null
  if (manifest.record.git && parseMoveMessage(moveText({ ...manifest, record: { ...manifest.record, git: null } }))) {
    return `the remote ${manifest.record.git.url} (branch ${manifest.record.git.branch}) is not an address the protocol carries`
  }
  return 'a field is out of shape: the name ("Orch: <subject>", no reference), the model, the effort, the pull requests, the paths or the order'
}

async function sendMove($: Dollar, e: Events['tool.call']): Promise<{ result: string; isError?: true }> {
  const input = inputOf(e)
  if (typeof input === 'string') return failure(input)
  const { to, record, chunk } = input
  for (const path of record.checkouts) {
    const refusal = await checkoutRefusal($, path)
    if (refusal) return failure(`move refused, nothing sent: ${refusal}`)
  }
  const dir = record.brief.slice(0, record.brief.lastIndexOf('/')) || '/'
  const briefName = record.brief.slice(record.brief.lastIndexOf('/') + 1)
  let listed: { name: string; kind: string; size: number; isLink?: boolean }[]
  try {
    listed = await $.fs.list(dir)
  } catch (err) {
    return failure(`move refused, nothing sent: the directory ${dir} cannot be read (${messageOf(err)})`)
  }
  const regular = listed.filter(entry => entry.kind === 'file' && !entry.isLink).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  // The caps first, on the sizes the listing gives, before a byte is read.
  const sketch: ManifestFile[] = regular.map(entry => ({ name: entry.name, bytes: entry.size, sha256: '0'.repeat(64), chunks: 1 }))
  const capped = checkManifestFiles(sketch)
  if (capped) return failure(`move refused, nothing sent: ${capped}`)
  if (!regular.some(entry => entry.name === briefName)) return failure(`move refused, nothing sent: the brief ${briefName} is not a regular file of ${dir}`)
  const placed = await placedFiles($, record, dir, regular.map(entry => entry.name))
  if ('refused' in placed) return failure(`move refused, nothing sent: ${placed.refused}`)
  const files: ManifestFile[] = []
  for (const entry of [...regular.map(e => ({ ...e, at: undefined as string | undefined })), ...placed.files]) {
    const path = entry.at ?? `${dir}/${entry.name}`
    let text: string
    try {
      text = String(await $.fs.read(path))
    } catch (err) {
      return failure(`move refused, nothing sent: ${entry.name} cannot be read (${messageOf(err)})`)
    }
    const bytes = new TextEncoder().encode(text).length
    if (bytes !== entry.size || bytes > MOVE_FILE_CAP) return failure(`move refused, nothing sent: ${entry.name} is not plain text`)
    const hash = await sha256Of($, path)
    if (!hash) return failure(`move refused, nothing sent: neither shasum nor sha256sum answered for ${entry.name}`)
    const chunks = chunkText(text, chunk).length
    files.push(entry.at === undefined ? { name: entry.name, bytes, sha256: hash, chunks } : { name: entry.name, bytes, sha256: hash, chunks, at: entry.at })
  }
  const git = await gitOf($, record.dir)
  if ('refused' in git) return failure(`move refused, nothing sent: ${git.refused}`)
  record.git = git.git
  const move = moveIdOf(record, files)
  const manifest: Manifest = {
    kind: 'manifest', move,
    origin: { machine: machineLabel(String((await run($, ['hostname', '-s'], 2000))?.stdout ?? '')), home: String(await $.env.get('HOME')), configDir: await configDir($) },
    record, files,
  }
  const refusal = checkManifestFiles(files) ?? recordRefusal(manifest)
  if (refusal) return failure(`move refused, nothing sent: ${refusal}`)
  await keepSend($, { move, to, chunk, record, files, rounds: 0 })
  const failed = await sendAll($, to, move, manifest, record, files, chunk, null)
  if (failed) return failure(`move ${move} not fully sent: ${failed}; ${RESUME}`)
  const chunks = files.reduce((sum, f) => sum + f.chunks, 0)
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
  return { result: `move ${move} sent to ${to}: ${files.length} files, ${chunks} chunks, ${bytes} bytes. The receiving module answers by itself; a notice reaches this session when the move is over.` }
}

// What the sender keeps of a move (store/moves/<move>.json): the record, the files, the address,
// the receiver's own address once a reply gave it, and the rounds of « missing » answered.
export type SentMove = { move: string; to: string; peer?: string; chunk: number; record: MoveRecord; files: ManifestFile[]; rounds: number; done?: { ok: boolean } }

async function keepSend($: Dollar, sent: SentMove): Promise<void> {
  const dir = await movesDir($)
  await run($, ['mkdir', '-p', dir], 5000)
  const io = storeIo($)
  const path = `${dir}/${sent.move}.json`
  await withLockOver(io, path, () => writeAtomicOver(io, path, JSON.stringify(sent) + '\n'))
}

// The sender's record of a move read again and changed under its lock: `change` is handed the
// record as the store holds it now and answers the record to write, or null to leave it. The
// answer is what the store holds afterwards, null when it holds no such move.
async function changeSent($: Dollar, move: string, change: (s: SentMove) => SentMove | null): Promise<SentMove | null> {
  const io = storeIo($)
  const path = `${await movesDir($)}/${move}.json`
  return withLockOver(io, path, async () => {
    const now = parseSent(await io.read(path), move)
    if (!now) return null
    const next = change(now)
    if (!next) return now
    await writeAtomicOver(io, path, JSON.stringify(next) + '\n')
    return next
  })
}

// Sends the manifest (when given), then the chunks (all of them, or the pairs asked for), then
// « sent ». Returns why it stopped, or null when everything went.
async function sendAll(
  $: Dollar, to: string, move: string, manifest: Manifest | null, record: MoveRecord, files: ManifestFile[], chunk: number, only: [number, number][] | null,
): Promise<string | null> {
  const dir = record.brief.slice(0, record.brief.lastIndexOf('/')) || '/'
  const deliver = async (message: MoveMessage): Promise<string | null> => {
    try {
      const sent = await $.session.send({ to, text: moveText(message) })
      return sent?.isDelivered ? null : `not delivered to ${to}: ${sent?.reason ?? 'no answer'}`
    } catch (err) {
      return `not delivered to ${to}: ${messageOf(err)}`
    }
  }
  if (manifest) {
    const stopped = await deliver(manifest)
    if (stopped) return stopped
  }
  const wanted = (file: number, index: number) => only === null || only.some(([f, i]) => f === file && i === index)
  for (const [file, f] of files.entries()) {
    if (only !== null && !only.some(([n]) => n === file)) continue
    let pieces: string[]
    try {
      pieces = chunkText(String(await $.fs.read(f.at ?? `${dir}/${f.name}`)), chunk)
    } catch (err) {
      return `${f.name} cannot be read again (${messageOf(err)})`
    }
    if (pieces.length !== f.chunks) return `${f.name} changed since it was announced`
    for (const [index, data] of pieces.entries()) {
      if (!wanted(file, index)) continue
      const stopped = await deliver({ kind: 'chunk', move, file, index, data })
      if (stopped) return stopped
    }
  }
  return deliver({ kind: 'sent', move })
}

// --- the probes --------------------------------------------------------------------------

async function sendProbes($: Dollar, e: Events['tool.call'], receiving: Receiving): Promise<{ result: string; isError?: true }> {
  const to = e['to']
  if (typeof to !== 'string' || to.length === 0 || to.length > ADDRESS_CAP || /[\u0000-\u001f\u007f]/.test(to)) {
    return failure('to: the receiving session\'s address or name is required')
  }
  const sizes = e['sizes']
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > PROBES_CAP
    || !sizes.every(size => Number.isInteger(size) && size >= 1 && size <= MOVE_TEXT_CAP)) {
    return failure(`sizes: one to ${PROBES_CAP} whole numbers from 1 to ${MOVE_TEXT_CAP}`)
  }
  const move = `probe-${Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0')}`
  const sent: number[] = []
  receiving.probes.set(move, { to, peer: null })
  for (const size of sizes as number[]) {
    const delivered = await $.session.send({ to, text: moveText({ kind: 'probe', move, size, data: 'x'.repeat(size) }) })
    if (!delivered?.isDelivered) {
      return failure(`probe ${size} not delivered to ${to}: ${delivered?.reason ?? 'no answer'}; sent before it: ${sent.join(', ') || 'none'}`)
    }
    sent.push(size)
  }
  return { result: `probes ${move} sent to ${to}: ${sent.join(', ')}. Each answer is appended to ${await movesDir($)}/probes.jsonl by the module.` }
}

// --- the receiver ------------------------------------------------------------------------

// A move this session receives, as the store keeps it (store/moves/<move>/): the sender's
// address and name, the manifest, the arrival it gives on this machine, the chunks held (one
// file each) and the acknowledgment of each file.
type Held = {
  from: string
  fromName: string
  manifest: Manifest
  arrival: Arrival
  have: Set<string>
  // The characters held for each chunk, and for each file all its chunks together: what a file
  // holds never passes its announced size.
  lengths: Map<string, number>
  size: number[]
  acks: ({ ok: boolean; reason: string | null } | undefined)[]
  notified: boolean
}

// The module's memory of this session: the moves it receives, the chain each move's messages
// run down, its name as last read, and the probes it sent (the move id of each, and to whom).
type Receiving = {
  held: Map<string, Held>
  chains: Map<string, Promise<unknown>>
  name: { value: string; at: number } | null
  probes: Map<string, { to: string; peer: string | null }>
}

// The session's name is read once in a while, not for every chunk of a file.
const NAME_MEMO_MS = 30000

// A name read is kept; a walk that read nothing is not, so the next message tries again.
async function memoName($: Dollar, receiving: Receiving): Promise<string | null> {
  const now = Date.now()
  if (receiving.name && now - receiving.name.at <= NAME_MEMO_MS) return receiving.name.value
  const read = await nameOf($)
  receiving.name = read === null ? null : { value: read, at: now }
  return read
}

// The sender's address and name are text a peer chose: one line, bounded, before a log keeps them.
const cleanText = (v: string | null) => String(v ?? 'unknown').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 120)

// One line of the log for a message dropped, never the message itself.
async function drop($: Dollar, why: string, delivery: Delivery): Promise<void> {
  await logLine($, 'moving', `move: a marked message was dropped (${why}) from ${cleanText(delivery.from)} ${cleanText(delivery.fromName)}, ${delivery.body.length} characters`)
}

// A refusal the sender can be told: the sender has no timer, so « done » not ok is the answer
// that ends its wait. The log keeps one line, as for a drop.
async function refuse($: Dollar, why: string, move: string, delivery: Delivery): Promise<void> {
  await logLine($, 'moving', `move: a marked message was refused and answered (${why}) from ${cleanText(delivery.from)} ${cleanText(delivery.fromName)}, ${delivery.body.length} characters`)
  await reply($, delivery.from!, { kind: 'done', move, ok: false, brief: null, reason: reasonText(why) })
}

async function take($: Dollar, receiving: Receiving, delivery: Delivery): Promise<void> {
  const message = parseMoveMessage(delivery.body)
  if (!message) return drop($, 'it does not parse', delivery)
  const name = await memoName($, receiving)
  if (name === null) return drop($, "this session's name could not be read", delivery)
  const role = roleOf(name)
  if (!delivery.from) return drop($, 'the sender has no address', delivery)
  if (role !== 'orchestrator' && role !== 'coordinator') {
    // The name was read: the sender can be told. A chunk or a probe is not answered one by one.
    const why = 'this session is neither an orchestrator nor a coordinator'
    return message.kind === 'manifest' || message.kind === 'sent' ? refuse($, why, message.move, delivery) : drop($, why, delivery)
  }
  // The messages of one move run one at a time.
  const before = receiving.chains.get(message.move) ?? Promise.resolve()
  const turn = before.catch(() => undefined).then(() => route($, receiving, message, delivery.from!, delivery))
  receiving.chains.set(message.move, turn)
  try {
    await turn
  } finally {
    if (receiving.chains.get(message.move) === turn) receiving.chains.delete(message.move)
  }
}

async function route($: Dollar, receiving: Receiving, message: MoveMessage, from: string, delivery: Delivery): Promise<void> {
  switch (message.kind) {
    case 'probe':
      return reply($, from, { kind: 'probe-ack', move: message.move, size: message.size, received: message.data.length })
    case 'manifest':
      return receiveManifest($, receiving, message, from, delivery)
    case 'chunk':
    case 'sent': {
      const h = await heldOf($, receiving, message.move)
      if (!h) {
        if (message.kind === 'sent') return refuse($, 'no manifest held for this move; send it again', message.move, delivery)
        return drop($, 'a move this session does not know', delivery)
      }
      if (h.from !== from) return drop($, "it is not from the move's sender", delivery)
      return message.kind === 'chunk' ? receiveChunk($, h, message) : receiveSent($, h)
    }
    case 'ack':
    case 'missing':
    case 'done': {
      const s = await sentOf($, message.move)
      if (!s) return drop($, 'a move this session did not send', delivery)
      if (!isPeer(s.to, s.peer, delivery)) return drop($, "it is not from the move's receiver", delivery)
      if (s.done) return
      if (!s.peer) {
        // The first reply matched by name gives the address every later one must come from.
        s.peer = from
        await changeSent($, s.move, now => (now.peer ? null : { ...now, peer: from }))
          .catch(err => logLine($, 'moving', `move ${s.move}: the receiver's address could not be kept: ${messageOf(err)}`))
      }
      if (message.kind === 'missing') return answerMissing($, s, message)
      if (message.kind === 'done') return answerDone($, s, message)
      return
    }
    case 'probe-ack': {
      const probe = receiving.probes.get(message.move)
      if (probe === undefined) return drop($, 'a probe this session did not send', delivery)
      if (!isPeer(probe.to, probe.peer ?? undefined, delivery)) return drop($, "it is not from the probe's receiver", delivery)
      probe.peer ??= from
      return appendProbe($, message, from)
    }
  }
}

// Whether a delivery comes from the session a move was addressed to: its address or its name
// while no address is pinned, then that address alone — a name is text any session can claim.
function isPeer(to: string, pinned: string | undefined, delivery: Delivery): boolean {
  if (pinned) return delivery.from === pinned
  return delivery.from === to || delivery.fromName === to
}

async function reply($: Dollar, to: string, message: MoveMessage): Promise<void> {
  const sent = await $.session.send({ to, text: moveText(message) })
  if (!sent?.isDelivered) await logLine($, 'moving', `move: ${message.kind} not delivered to ${to.slice(0, 120)}: ${String(sent?.reason ?? 'no answer').slice(0, 200)}`)
}

// A reason as the protocol carries one: one line, never empty, bounded.
function reasonText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || 'refused'
}

async function targetOf($: Dollar): Promise<{ home: string; configDir: string }> {
  return { home: String(await $.env.get('HOME') ?? ''), configDir: await configDir($) }
}

async function receiveManifest($: Dollar, receiving: Receiving, manifest: Manifest, from: string, delivery: Delivery): Promise<void> {
  const known = await heldOf($, receiving, manifest.move)
  if (known) {
    if (known.from !== from) return refuse($, 'a move with this id is already held for another session', manifest.move, delivery)
    // The same move sent again: what is held stays; a file that failed is asked for afresh.
    const stale: string[] = []
    for (const [file, ack] of known.acks.entries()) {
      if (!ack || ack.ok) continue
      known.acks[file] = undefined
      for (let index = 0; index < (manifest.files[file]?.chunks ?? 0); index++) {
        forget(known, file, index)
        stale.push(`${await movesDir($)}/${manifest.move}/c-${file}-${index}`)
      }
      stale.push(`${await movesDir($)}/${manifest.move}/ack-${file}.json`)
    }
    if (stale.length > 0) await run($, ['rm', '-f', ...stale], 5000)
    return
  }
  const arrival = arrivalOf(manifest, await targetOf($))
  if ('refused' in arrival) {
    return reply($, from, { kind: 'done', move: manifest.move, ok: false, brief: null, reason: reasonText(arrival.refused) })
  }
  const dir = `${await movesDir($)}/${manifest.move}`
  const fromName = delivery.fromName ?? ''
  try {
    const made = await run($, ['mkdir', '-p', dir], 5000)
    if (!made || made.exitCode !== 0) throw new Error('the directory cannot be made')
    await writeAtomic($, `${dir}/manifest.json`, JSON.stringify({ from, fromName, manifest }) + '\n')
  } catch (err) {
    return refuse($, `the manifest could not be stored here (${messageOf(err)})`, manifest.move, delivery)
  }
  receiving.held.set(manifest.move, {
    from, fromName, manifest, arrival, have: new Set(), lengths: new Map(), size: manifest.files.map(() => 0),
    acks: manifest.files.map(() => undefined), notified: false,
  })
}

// The move as held in memory, else read back from the store (a reload forgets the memory, not
// the files); null when this session knows no such move.
async function heldOf($: Dollar, receiving: Receiving, move: string): Promise<Held | null> {
  const known = receiving.held.get(move)
  if (known) return known
  const dir = `${await movesDir($)}/${move}`
  let parsed: unknown
  try {
    parsed = JSON.parse(String(await $.fs.read(`${dir}/manifest.json`)))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const kept: { from?: unknown; fromName?: unknown; manifest?: unknown } = parsed
  const manifest = typeof kept.manifest === 'object' && kept.manifest ? parseMoveMessage(moveText(kept.manifest as MoveMessage)) : null
  if (!manifest || manifest.kind !== 'manifest' || manifest.move !== move || typeof kept.from !== 'string') return null
  const arrival = arrivalOf(manifest, await targetOf($))
  if ('refused' in arrival) return null
  const h: Held = {
    from: kept.from, fromName: typeof kept.fromName === 'string' ? kept.fromName : '', manifest, arrival,
    have: new Set(), lengths: new Map(), size: manifest.files.map(() => 0), acks: manifest.files.map(() => undefined), notified: false,
  }
  await sweep($, dir)
  const entries: { name: string }[] = await $.fs.list(dir).catch(() => [])
  for (const { name } of entries) {
    const chunk = /^c-(\d+)-(\d+)$/.exec(name)
    if (chunk) {
      // What a chunk file holds is counted again: the bound on a file outlives the memory.
      const [file, index] = [Number(chunk[1]), Number(chunk[2])]
      if (file < manifest.files.length && index < (manifest.files[file]?.chunks ?? 0)) {
        try {
          remember(h, file, index, String(await $.fs.read(`${dir}/${name}`)).length)
        } catch { /* an unreadable chunk is asked for again */ }
      }
    }
    const ack = /^ack-(\d+)\.json$/.exec(name)
    if (ack && Number(ack[1]) < h.acks.length) {
      try {
        const a: unknown = JSON.parse(String(await $.fs.read(`${dir}/${name}`)))
        const { ok, reason } = (a ?? {}) as { ok?: unknown; reason?: unknown }
        if (typeof ok === 'boolean') h.acks[Number(ack[1])] = { ok, reason: typeof reason === 'string' ? reason : null }
      } catch { /* an unreadable acknowledgment is asked for again */ }
    }
    if (name === 'notified') h.notified = true
  }
  receiving.held.set(move, h)
  return h
}

async function receiveChunk($: Dollar, h: Held, chunk: Extract<MoveMessage, { kind: 'chunk' }>): Promise<void> {
  const f = h.manifest.files[chunk.file]
  if (!f || chunk.index >= f.chunks) return logLine($, 'moving', `move: a chunk out of the manifest's range (${chunk.file}:${chunk.index})`)
  if (h.acks[chunk.file]) {
    // Held and answered already: nothing is written; the last chunk of the file asks for its acknowledgment again.
    if (chunk.index === f.chunks - 1) await sendAck($, h, chunk.file)
    return
  }
  const key = `${chunk.file}:${chunk.index}`
  if (!h.have.has(key)) {
    if ((h.size[chunk.file] ?? 0) + chunk.data.length > f.bytes) {
      return logLine($, 'moving', `move: a chunk would pass the announced size of its file (${chunk.file}:${chunk.index}, ${f.bytes} bytes announced), dropped`)
    }
    await writeAtomic($, `${await movesDir($)}/${h.manifest.move}/c-${chunk.file}-${chunk.index}`, chunk.data)
    remember(h, chunk.file, chunk.index, chunk.data.length)
  }
  for (let index = 0; index < f.chunks; index++) if (!h.have.has(`${chunk.file}:${index}`)) return
  await processFile($, h, chunk.file)
}

// A chunk held, and the characters it adds to its file; and the reverse.
function remember(h: Held, file: number, index: number, length: number): void {
  const key = `${file}:${index}`
  if (h.have.has(key)) return
  h.have.add(key)
  h.lengths.set(key, length)
  h.size[file] = (h.size[file] ?? 0) + length
}

function forget(h: Held, file: number, index: number): void {
  const key = `${file}:${index}`
  h.have.delete(key)
  h.size[file] = (h.size[file] ?? 0) - (h.lengths.get(key) ?? 0)
  h.lengths.delete(key)
}

async function sendAck($: Dollar, h: Held, file: number): Promise<void> {
  const ack = h.acks[file]
  if (!ack) return
  await reply($, h.from, { kind: 'ack', move: h.manifest.move, file, ok: ack.ok, reason: ack.ok ? null : reasonText(ack.reason ?? '') })
}

// A file whose chunks are all in: joined, staged, its hash checked, its origin's paths
// rewritten, written in the briefs directory unless a file already stands there with other
// content. The outcome is acknowledged either way.
async function processFile($: Dollar, h: Held, file: number): Promise<void> {
  const f = h.manifest.files[file]
  if (!f) return
  const dir = `${await movesDir($)}/${h.manifest.move}`
  let outcome: { ok: boolean; reason: string | null }
  try {
    const pieces: string[] = []
    for (let index = 0; index < f.chunks; index++) pieces.push(String(await $.fs.read(`${dir}/c-${file}-${index}`)))
    const text = pieces.join('')
    // The joined file is hashed from a temporary of the store's own shape, so a process killed
    // before it is removed leaves what the next sweep removes.
    const staging = temporaryOf(`${dir}/staging-${file}`, uniqueTag())
    let hash: string | null
    try {
      await $.fs.write(staging, text)
      hash = await sha256Of($, staging)
    } finally {
      await run($, removeArgv(staging), 5000)
    }
    if (new TextEncoder().encode(text).length !== f.bytes) {
      outcome = { ok: false, reason: `${f.name}: ${new TextEncoder().encode(text).length} bytes arrived, ${f.bytes} announced` }
    } else if (hash !== f.sha256) {
      outcome = { ok: false, reason: `${f.name}: its sha256 does not match the one announced` }
    } else {
      const target = await targetOf($)
      const rewritten = rewritePaths(text, arrivalPairs(h.manifest, h.arrival, target))
      outcome = await land($, h.arrival.places[file] ?? `${h.arrival.briefDir}/${f.name}`, f.name, rewritten)
    }
  } catch (err) {
    outcome = { ok: false, reason: `${f.name}: ${messageOf(err)}` }
  }
  h.acks[file] = outcome
  await writeAtomic($, `${dir}/ack-${file}.json`, JSON.stringify(outcome) + '\n')
  // A file landed needs its chunks no more: its acknowledgment answers every later chunk of it.
  if (outcome.ok) await run($, removeArgv(...Array.from({ length: f.chunks }, (_, index) => `${dir}/c-${file}-${index}`)), 5000)
  await sendAck($, h, file)
  if (h.acks.every(Boolean)) await finish($, h)
}

// A file written where it lands, under that path's lock, unless a file already stands there:
// the same content is the same file landed before, any other is refused and left alone.
async function land($: Dollar, path: string, label: string, text: string): Promise<{ ok: boolean; reason: string | null }> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const made = await run($, ['mkdir', '-p', dir], 5000)
  if (!made || made.exitCode !== 0) return { ok: false, reason: `${label}: the directory ${dir} cannot be made` }
  await sweep($, dir)
  const io = storeIo($)
  return withLockOver(io, path, async () => {
    const there = await io.read(path)
    if (there !== undefined) return there === text ? { ok: true, reason: null } : { ok: false, reason: `${label}: a file with other content already stands at ${path}` }
    await writeAtomicOver(io, path, text)
    return { ok: true, reason: null }
  })
}

// Every file answered: « done », and, when all arrived whole, the arrival notice the
// receiver's model reads, once.
async function finish($: Dollar, h: Held): Promise<void> {
  const failed = h.acks.find(ack => ack && !ack.ok)
  if (failed) {
    return reply($, h.from, { kind: 'done', move: h.manifest.move, ok: false, brief: null, reason: reasonText(failed.reason ?? '') })
  }
  await reply($, h.from, { kind: 'done', move: h.manifest.move, ok: true, brief: h.arrival.brief, reason: null })
  if (h.notified) return
  h.notified = true
  await writeAtomic($, `${await movesDir($)}/${h.manifest.move}/notified`, '1\n')
  const launcher = launcherOf($.plugin.root)
  $.prompt.submit({ text: arrivedNotice(h.manifest, h.arrival, h.fromName || 'a session with no name', launcher) })
    .catch((err: unknown) => logLine($, 'moving', `move: the arrival notice was not submitted: ${String((err as Error)?.message ?? err)}`))
}

// « Sent »: what is still missing is asked for, chunk by chunk; with nothing missing the move
// is answered again as it stands (the answer may have been lost), without a second notice.
async function receiveSent($: Dollar, h: Held): Promise<void> {
  const missing = missingOf(h.manifest.files, h.have, h.acks.map(Boolean))
  if (missing.length > 0) return reply($, h.from, { kind: 'missing', move: h.manifest.move, chunks: missing })
  if (h.acks.every(Boolean)) await finish($, h)
}

// --- the sender's answers ----------------------------------------------------------------

// The move as the sender kept it, or null when this session sent no such move.
async function sentOf($: Dollar, move: string): Promise<SentMove | null> {
  return parseSent(await $.fs.read(`${await movesDir($)}/${move}.json`).then(String, () => undefined), move)
}

function parseSent(text: string | undefined, move: string): SentMove | null {
  if (text === undefined) return null
  try {
    const kept: unknown = JSON.parse(text)
    if (!kept || typeof kept !== 'object') return null
    const k = kept as Record<string, unknown>
    const ok = k['move'] === move && typeof k['to'] === 'string' && Number.isInteger(k['chunk']) && Number.isInteger(k['rounds'])
      && k['record'] && Array.isArray(k['files']) && (k['peer'] === undefined || typeof k['peer'] === 'string')
    return ok ? kept as SentMove : null
  } catch {
    return null
  }
}

// « Missing »: the chunks named are sent again, then « sent » once more, at most
// MOVE_MISSING_ROUNDS answers per move; the answer after that ends the move as failed.
async function answerMissing($: Dollar, s: SentMove, message: Extract<MoveMessage, { kind: 'missing' }>): Promise<void> {
  let stopped: string | null
  try {
    // The round is counted under the record's lock, read afresh: two answers never share one.
    let over = false
    const counted = await changeSent($, s.move, now => {
      over = now.rounds >= MOVE_MISSING_ROUNDS || now.done !== undefined
      return over ? null : { ...now, rounds: now.rounds + 1 }
    })
    if (!counted || counted.done) return
    if (over) return conclude($, s, `the receiver still misses chunks after ${MOVE_MISSING_ROUNDS} answers`)
    s.rounds = counted.rounds
    const asked = message.chunks.filter(([file, index]) => s.files[file] !== undefined && index < s.files[file].chunks)
    stopped = await sendAll($, s.to, s.move, null, s.record, s.files, s.chunk, asked)
  } catch (err) {
    stopped = messageOf(err)
  }
  // Nothing else will tell the sender's model: the move ends here, and the send resumes it.
  if (stopped) return conclude($, s, `the chunks asked for again were not all sent (${stopped}); ${RESUME}`)
}

// « Done »: the move is over, once. Acknowledged whole, the sender's model reads where the
// brief now is, and a session that moved itself may end; otherwise it reads why not.
async function answerDone($: Dollar, s: SentMove, message: Extract<MoveMessage, { kind: 'done' }>): Promise<void> {
  if (!message.ok) return conclude($, s, message.reason ?? 'refused')
  s.done = { ok: true }
  await keepKnown($, s)
  // The name is read afresh, not from the memo: the end is allowed on what the session is called now.
  if (await nameOf($) === s.record.name) movedAndAcknowledged.add(s.record.name)
  const cleaned = await cleanSource($, s)
  const wakeDone = await sleepsHere($, s.record.name)
    ? `${$.plugin.root}/skills/coordinator/scripts/coordinator.sh wake-done --name "${s.record.name}"` : null
  $.prompt.submit({ text: acknowledgedNotice(s.record, s.to, message.brief ?? '', cleaned, wakeDone) })
    .catch((err: unknown) => logLine($, 'moving', `move ${s.move}: the notice was not submitted: ${String((err as Error)?.message ?? err)}`))
}

// The source cleaned once the receiver acknowledged every file: each file sent is removed while it
// still holds what was sent, so a file changed since is kept and named; the brief's directory goes
// when nothing else is left in it. Never before the acknowledgment: until then the source is the
// only whole copy.
async function cleanSource($: Dollar, s: SentMove): Promise<Cleaned> {
  const dir = s.record.brief.slice(0, s.record.brief.lastIndexOf('/')) || '/'
  const cleaned: Cleaned = { removed: 0, kept: [] }
  for (const f of s.files) {
    const path = f.at ?? `${dir}/${f.name}`
    if (!(await $.fs.exists(path).catch(() => true))) continue
    if (await sha256Of($, path) !== f.sha256) {
      cleaned.kept.push(path)
      continue
    }
    const out = await run($, removeArgv(path), 5000)
    if (out?.exitCode === 0) cleaned.removed += 1
    else cleaned.kept.push(path)
  }
  await run($, ['rmdir', '--', dir], 5000)
  return cleaned
}

// Whether this machine's coordinator keeps an orchestrator of that name asleep (coordinator.sh's
// sleeping.json): its record is the coordinator's to remove, under its own lock.
async function sleepsHere($: Dollar, name: string): Promise<boolean> {
  const state = (await $.env.get('ORCHESTRATOR_STATE_DIR')) ?? `${await configDir($)}/claude-orchestrator`
  try {
    const all: unknown = JSON.parse(String(await $.fs.read(`${state}/sleeping.json`)))
    return Array.isArray(all) && all.some(one => typeof one === 'object' && one !== null && (one as Record<string, unknown>)['name'] === name)
  } catch {
    return false
  }
}

// The record kept again where the notice must go out whatever the store says: a write that fails
// is logged.
async function keepKnown($: Dollar, s: SentMove): Promise<void> {
  await changeSent($, s.move, now => ({ ...now, done: s.done! }))
    .catch(err => logLine($, 'moving', `move ${s.move}: the record could not be kept: ${messageOf(err)}`))
}

async function conclude($: Dollar, s: SentMove, reason: string): Promise<void> {
  s.done = { ok: false }
  await keepKnown($, s)
  $.prompt.submit({ text: failedNotice(s.record, s.to, reason) })
    .catch((err: unknown) => logLine($, 'moving', `move ${s.move}: the notice was not submitted: ${String((err as Error)?.message ?? err)}`))
}

// One probe answer, one JSON line: when, which probe, the size sent, the length received, and
// who answered.
async function appendProbe($: Dollar, message: Extract<MoveMessage, { kind: 'probe-ack' }>, from: string): Promise<void> {
  const dir = await movesDir($)
  const line = JSON.stringify({ at: new Date().toISOString(), move: message.move, size: message.size, received: message.received, from })
  await run($, ['mkdir', '-p', dir], 5000)
  const out = await run($, ['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', line, `${dir}/probes.jsonl`], 5000)
  if (!out || out.exitCode !== 0) await logLine($, 'moving', `move: a probe answer could not be appended to ${dir}/probes.jsonl`)
}

// --- the store ---------------------------------------------------------------------------

// The temporary files a writer killed between its write and its rename left in `dir`.
async function sweep($: Dollar, dir: string): Promise<void> {
  const entries = await $.fs.list(dir).catch(() => [])
  const stale = staleTemporaries(dir, entries, Date.now())
  if (stale.length > 0) await run($, removeArgv(...stale), 5000)
}
