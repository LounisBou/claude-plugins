// hooks/guards.ts
// The guards in-process, and the walks they walk. The context gate,
// hooks/context-gate.sh ported: on every prompt of a session the
// orchestration named, the fill the gauge measured, said to the model past the
// gate — never a line the user must relay. The kill guard beside it, on every
// Bash call of a session the launcher spawned: every kill by name or pattern
// refused, since a session kills only what it started, by pid. A forced push is
// the forge's to refuse (github's `/github:protect`), never a reading of the
// command's text here. And
// the stop gate, hooks/stop_gate.py ported: a stop is held until something
// will wake the orchestrator — a busy agent's idle notice, the answer to a
// declared block, the end of a watched pull request's checks. The shell
// originals are gone with the cutover — these ports are the pipeline now.
//
// The engine fences $ to the file that received it — never passed across an
// import, a noun of it never read as a value — so the transcript block reader
// lives here, next to the handlers that hold $, while the name walk's logic
// stays pure in session-name.ts (readName below delegates to it over this
// file's own readers) and the stop gate's decisions in stop-gate.ts.
import {
  roleOf, walkName, hostOn, scanTail, hostBasenames, blockArgv, bytesOfBase64,
  type ReadRecord, type HostNames,
} from './session-name.ts'
import { tripGate, parseMeasure, measureFilePath } from './gauge-core.ts'
import { takeDrift } from './gauge.ts'
import { isEnding } from './naming.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'
import { operatorWaitRefusal, asksTheOperator, QUESTION_BY_MESSAGE } from './one-question.ts'
import { detectPatternKills } from './pattern-kills.ts'
import {
  refuse, withDeadline, isDegradedPass, type DegradedPass,
  listing, chainEntries, chainOwner, ownAgents, hostStatusOf, pullRequestOf, openRows, deferredRows, deferredIds, projectCheckouts,
  headsPath, readHeads, writeHeads, parseCiWatchLog, watchNumberOf, watchedNumbers,
  checkWake, checkWakeDone, checkCi, isSuccessorSpawn, processTable, ownBackground, hostTasks, logTell,
  noticeFrom, awaitingAny, goalsPaths, parseGoalsCheck, endsOnHandOver, type GoalsReading,
  orchestrationOf, ownerOf, isOwnRecord, recordsWithOpenRows,
} from './stop-gate.ts'
import { machineLine } from '../core/method.ts'
import { moduleDirOf } from './module-log.ts'
import { launcherOf } from '../core/orchestration.ts'
import { pendingQuestion, unansweredRefusal, ownWaitOpen, type WaitRead } from './unanswered-question.ts'
import { parseRoundEntry, parseWaitRecord, waitKey, coordinatorAddress, sendToCoordinator, REFERENCED } from './supervision.ts'
import type { RoundEntry } from './round.ts'
import { MODE_DIALOG_DENY, WAITED_ON_DIALOG_DENY, asksTheMode } from './mode-dialog.ts'
import { unnamedReport } from './relay.ts'
import { shorten } from '../core/verdict.ts'
import { MODELS_DENY, namesTheMap, typedByOperator, mapPaths, editsTheMap, bashWritesTheMap } from './models-guard.ts'
import { configDir, gateEnv, logLine, stateDir } from './module-io.ts'

export function roleLine(role: string, root = ''): string {
  // Verbatim from hooks/context-gate.sh:57-63 — the four role answers. The
  // auditor's brief and the coordinator's skill are spelled from a root the
  // handler reads: a session's cwd is its own project, so a path relative to the
  // plugin's checkout names a file the model cannot open.
  switch (role) {
    case 'orchestrator': return 'Succeed at the next quiet boundary — run /orchestrator-succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.'
    case 'agent': return 'Finish the unit in progress, end your turn on your status line, and stop; no new phase is dispatched to you.'
    case 'auditor': return `Report not written, or nothing the operator gave you after it: write the one report with what you have read, and stop. Work he gave you after the report still in hand: succeed — ${auditorBrief(root)}; tell him before you hand over.`
    case 'coordinator': return `With no relay in flight, succeed as ${pluginFile(root, 'skills/coordination/SKILL.md')} « Your context » says, then tell the operator.`
    default: return ''
  }
}

// The auditor's succession brief, openable from any cwd: the shell gate spelled
// the checkout's absolute root for the same reason. The root the host sets for
// the plugin is threaded in from the handler that reads it; without one the
// spelling stays relative — the one exposure the cutover leaves standing, this
// module the only gate to carry it.
function auditorBrief(root: string): string {
  return pluginFile(root, 'templates/auditor-succession-brief.md')
}

// A file of the plugin as a role line names it: under the root when one is known.
function pluginFile(root: string, path: string): string {
  return root ? `${root.replace(/\/+$/, '')}/${path}` : path
}

export function gateAnnouncement(gate: { tripped: boolean; words: string }, role: string, root = '', set: readonly string[] = []): string {
  if (!gate.tripped) return ''
  return `CONTEXT GATE: this session is at ${gate.words}.${setLine(set)} ${roleLine(role, root)}`
}

// A threshold the session's environment set is the gate, however low: a session
// shown a figure off the default rule, with nothing saying where it came from,
// reads it as a fault and declines to rotate (seen live at a 1,000-token test
// gate). The variables that set it are named, and the figure is said binding.
function setLine(set: readonly string[]): string {
  return set.length === 0 ? '' : ` This threshold is set by ${set.join(' and ')} in this session's environment: it is binding, not a fault.`
}

// The thresholds the environment set, by the names it set them under.
function setNames(env: { gate?: number; gateTokens?: number }): string[] {
  const names: string[] = []
  if (env.gate !== undefined) names.push(`ORCHESTRATOR_CONTEXT_GATE=${env.gate}`)
  if (env.gateTokens !== undefined) names.push(`ORCHESTRATOR_CONTEXT_GATE_TOKENS=${env.gateTokens}`)
  return names
}

// The kill decision: nothing in a session the launcher did not mark (its build command
// exports the marker), and in a marked one every kill by name or pattern refused — pkill, killall, a
// kill whose pids come from a substitution other than `cat <file>` or from a lister
// through xargs, a kill of every process or of a process group. A session kills only
// what it started, by the pid it recorded in a file (`cmd & echo $! > <file>`, then
// `kill $(cat <file>)`; a shell variable does not outlive a Bash call, a file does). A
// kill by pattern reaches other sessions' processes (their dev servers, the sleep of
// their wait loops).
export function killDecision(spawned: string | null | undefined, command: string): { deny: string } | null {
  if (!spawned) return null                        // the operator's own sessions: untouched
  const kills = detectPatternKills(command)
  if (kills.length === 0) return null
  return { deny: `kill refused: this session was spawned by the launcher, and it kills only what it started, by the pid it recorded in a file (start it with \`cmd & echo $! > <file>\`, end it with \`kill $(cat <file>)\`). A kill by name or pattern can end other sessions' processes. Seen: ${kills.join(', ')}.` }
}

// The kill guard's answer when it could not run whole: the mark as last read decides.
// A session the launcher marked refuses its kills by pattern as the guard would; a mark
// never read refuses them with the reason the guard did not finish — the safe side when
// nothing says which session this is; an operator's own session is left alone.
export function guardFallback(mark: string | null | undefined, command: string, why: string): { deny: string } | null {
  if (mark !== undefined) return killDecision(mark, command)
  const kills = detectPatternKills(command)
  if (kills.length === 0) return null
  return { deny: `kill refused: the kill guard could not read whether the launcher spawned this session (${why}), and a kill by name or pattern waits until it can. Seen: ${kills.join(', ')}.` }
}

// prompt.submit's `context` is a list of blocks: what the model reads beside the
// prompt, each entry one block after the prompt as typed, and never shown the
// user. The announcement is one block appended after whatever the chain above
// already attached, never a newline folded into another hook's block.
function joinContext(existing: readonly string[] | undefined, line: string): readonly string[] {
  return [...(existing ?? []), line]
}

// The unmeasured line (context-gate.sh:126-130, said for the one channel the
// module world has): it names what was read, and the gate that cannot be.
function unmeasuredAnnouncement(env: { gate?: number; gateTokens?: number }): string {
  const words = (n: number) => n.toLocaleString('en-US')
  const gate = env.gate ?? 80
  const gateTokens = env.gateTokens ?? 300000
  return `CONTEXT GATE: unmeasured: the measure file carries no figure; the next turn fills it. The gate (the smaller of ${words(gateTokens)} tokens and ${gate}% of the reported window) cannot be read; measure by hand before dispatching or rotating.`
}

// $.fs.read carries no range — the API's own types offer only { as }, and a
// whole read is refused past 4 MiB while transcripts grow past any cap — so a
// block comes from dd through $.process.run (blockArgv): one bounded window per
// step, never the whole file, carried as bytes so a character the window cuts
// is joined whole. dd counts its windows from the file's start, so the blocks
// are aligned there; that changes only which bytes share a read, never what is
// scanned, and the short window is the one holding the file's end. Every read
// carries its own timeout: a read the caller stopped waiting for never outlives
// the bound it was given.
async function readBlock($: any, path: string, index: number, timeoutMs: number): Promise<Uint8Array> {
  const { exitCode, stdout } = await $.process.run(blockArgv(path, index), { timeoutMs })
  if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${path}`)
  return bytesOfBase64(String(stdout ?? ''))
}

// How long a name walk may take when its caller sets no deadline of its own.
const NAME_WALK_MS = 5000

// The host's record of a pid, the identity rule's first half: the text, or null
// when the pid has none.
function recordReader($: any, config: string, timeoutMs: () => number): ReadRecord {
  return async (pid: string) => {
    try {
      const text = await withDeadline($.fs.read(`${config}/sessions/${pid}.json`), timeoutMs())
      return isDegradedPass(text) ? null : String(text)
    } catch {
      return null
    }
  }
}

// The identity rule's second half: the basenames the host's binary goes by — the
// name ORCHESTRATOR_HOST_CLI spells (the launcher's default beside it) and the
// binary it resolves to through the PATH and its links.
function hostNamesReader($: any, timeoutMs: () => number): HostNames {
  return async () => {
    const host = (await $.env.get('ORCHESTRATOR_HOST_CLI')) ?? 'claude'
    let resolved: string | null = null
    try {
      const found = await $.process.run(['sh', '-c', 'command -v -- "$1"', 'sh', host], { timeoutMs: timeoutMs() })
      const path = found.exitCode === 0 ? String(found.stdout ?? '').trim() : ''
      if (path.startsWith('/')) resolved = (await $.fs.stat(path, { resolve: true })).realPath ?? path
    } catch { /* unresolved: the spelled name alone */ }
    return hostBasenames(host, resolved)
  }
}

// read_name() ported (session_name.py:81-92) on the identity rule: the tty
// first — a session with none (a headless run) is named by nobody — then the
// host process on it, named by its record, else its launch name, else the
// transcript's last rename. The walk itself is session-name.ts's pure core;
// this file's $ builds the readers it runs over (the fence law: $ never crosses
// an import), each bounded by what is left of `until`.
export async function readName($: any, transcriptPath: string, sessionId = '', until = Date.now() + NAME_WALK_MS):
Promise<{ tty: string | null; name: string | null; pid: string | null; known: boolean }> {
  const left = () => Math.max(1, until - Date.now())
  return walkName(
    (argv: readonly string[]) => $.process.run(argv, { timeoutMs: left() }),
    async (path: string) => (await $.fs.stat(path)).size,
    (path: string, index: number) => readBlock($, path, index, left()),
    transcriptPath,
    recordReader($, await configDir($), left),
    hostNamesReader($, left),
    sessionId,
  )
}

// prompt.submit's input carries no transcript path — that field belongs to the
// settings hook's payload — so the transcript is found the gauge's own way
// (context-gate.sh's reader): by session id under the projects directory,
// $.session.id() being the transcript file's name. A miss returns '': the
// rename fallback then names nothing, and a transcript nobody wrote holds no
// assistant entry either.
async function transcriptPathOf($: any, sessionId: string): Promise<string> {
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

// The first-prompt rule (context-gate.sh:113-119): « unmeasured » is said only
// once a turn has answered — a session with no assistant entry yet is not a
// gauge that failed, it is one the gauge has not rendered for at all. The walk
// is the session-name tail scan: from the end, one dd window at a time, the cut
// first line carried, and it stops at the first assistant entry — they are
// dense, so the walk is short and never a whole-file read.
async function transcriptHasAnswer($: any, path: string): Promise<boolean> {
  // A transcript that cannot be read has answered nothing the gate can know.
  const until = Date.now() + NAME_WALK_MS
  const { line } = await scanTail(
    async (p: string) => (await $.fs.stat(p)).size,
    (p: string, index: number) => readBlock($, p, index, Math.max(1, until - Date.now())),
    path,
    (l: string) => /"type"\s*:\s*"assistant"/.test(l),
  )
  return line !== null
}

// How many times a re-fired stop is refused again for an operator wait with no question block.
export const REFIRED_REFUSALS = 2

// `declarations`: the waits this session's turns declared, the one the stop gate decides on (wait.ts).
export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }, declarations: Declarations = DECLARATIONS) {
  // Module memory, the gauge's own law: a reload resets it all. The transcript's
  // place and the unmeasured line are the session's own, keyed by its id: after a
  // /clear the id changes and no session.start fires, so a memo held across it
  // would name the old session's transcript and keep the line already said.
  let memo: { sessionId: string; transcript: string | null; saidUnmeasured: boolean } | null = null
  // The session id that handed over (it spawned its successor), the stop gate's
  // release: keyed by id like the memo above, a /clear's new session has not.
  let handedOverIn: string | null = null
  // The peers whose idle notice this session subscribed to (SendMessage with
  // notify_when_idle), each with the time it was asked: the stop gate's release until
  // the peer's notice or message comes in, or the time-to-live runs out. Keyed by the
  // session id like the two above.
  let awaited: { sessionId: string; peers: Map<string, number> } | null = null
  const awaitingIn = (sessionId: string): boolean => {
    if (!awaited || awaited.sessionId !== sessionId) return false
    return awaitingAny(awaited.peers, Date.now())
  }
  // The launcher's mark, read once and kept: a re-entered call, or one past its
  // budget, can no longer read the environment, and the kill guard's net decides
  // on this instead. Undefined until the first read answers.
  let spawnedMark: string | null | undefined = undefined
  // The last prompt the operator typed in this session, keyed by its id like the memos
  // above: the tier map's guard stands aside when it names the map or a tier.
  // Its time answers the session's own question when no coordinator runs (ownWaitOpen).
  let lastTyped: { sessionId: string; text: string; at: string } | null = null
  // The refusals a re-fired stop has paid this turn for an operator wait with no question, by
  // session id: a fresh stop starts the count over, REFIRED_REFUSALS ends it (never an endless loop).
  const unaskedRefusals = new Map<string, number>()
  on('prompt.submit', async ($: any, e: any, next: (e: any) => any) => {
    if (typedByOperator(String(e.origin?.kind ?? ''))) {
      try {
        lastTyped = { sessionId: await $.session.id(), text: String(e.text ?? ''), at: new Date().toISOString() }
      } catch { /* no session id: the guard keeps no word of his, and stays up */ }
    }
    // An awaited peer's notice or message ends the wait on it, whatever else this prompt is.
    if (awaited && awaited.peers.size > 0) {
      const text = String(e.text ?? '')
      const kind = String(e.origin?.kind ?? '')
      for (const peer of [...awaited.peers.keys()]) if (noticeFrom(peer, text, kind)) awaited.peers.delete(peer)
    }
    // The model drift the gauge measured is said on this channel — the context the
    // model reads beside the prompt, never only a toast nobody sees — whatever the
    // session's role, once.
    const blocks: string[] = []
    const drift = takeDrift()
    if (drift) blocks.push(drift)
    const answer = () => next(blocks.length === 0 ? e : { ...e, context: blocks.reduce<readonly string[]>(joinContext, e.context ?? []) })
    try {
      const sessionId = await $.session.id()
      if (memo === null || memo.sessionId !== sessionId) memo = { sessionId, transcript: null, saidUnmeasured: false }
      if (memo.transcript === null) {
        // A miss is looked up again: a young session's transcript appears with
        // its first turn, and a memo of the miss would pin it forever.
        const found = await transcriptPathOf($, sessionId)
        if (found) memo.transcript = found
      }
      const { name } = await readName($, memo.transcript ?? '', sessionId)
      const role = roleOf(name)
      if (!role) return answer()                       // a session never spoken to
      // The auditor's and the coordinator's lines name a file: the plugin's own
      // directory makes it openable from any cwd. The module's environment
      // carries no CLAUDE_PLUGIN_ROOT (the host sets it for hook processes
      // only), so the root is the engine's own $.plugin.root.
      const root = role === 'auditor' || role === 'coordinator' ? $.plugin.root : ''
      let raw: string | null = null
      try { raw = await $.fs.read(measureFilePath(await configDir($), sessionId, await $.env.get('ORCHESTRATOR_MODULE_DIR'))) } catch { /* no file yet: unmeasured */ }
      const reading = parseMeasure(String(raw ?? ''))
      if (!reading) {
        if (!memo.saidUnmeasured && await transcriptHasAnswer($, memo.transcript ?? '')) {
          memo.saidUnmeasured = true
          blocks.push(unmeasuredAnnouncement(await gateEnv($)))
        }
        return answer()
      }
      const env = await gateEnv($)
      const gate = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, env)
      const announcement = gateAnnouncement(gate, role, root, setNames(env))
      if (announcement) blocks.push(announcement)
    } catch (err) {
      // A gate that cannot measure lets the prompt through and says so once in
      // the log; the log's own failure stays quiet (the every-handler-logs rule).
      await logLine($, 'guards', (err as Error).message)
    }
    return answer()
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see:
    // the body's own catch handles what throws inside it, this one what it
    // cannot — a handler overrunning its own time bound above all (Review
    // Focus 2's law, here for the walks). Either way the prompt is let
    // through, and the state dir says why; next is replay-safe in a catch,
    // called or not.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A subscription to a peer's idle notice, made by the main thread and sent: kept for
  // the stop gate, which reads it as something that will wake the session. Mounted
  // before the Bash guard below.
  on('tool.call', { tool: 'SendMessage' }, async ($: any, e: any, next: (e: any) => any) => {
    const to = typeof e.to === 'string' ? e.to.trim() : ''
    // A question sent to the coordinator by message reaches no round: refused, the turn's end carries it.
    // The coordinator is read only for a message that asks one; a read that fails lets the send through.
    if (to && typeof e.message === 'string' && asksTheOperator(e.message)) {
      try {
        const coordinator = await coordinatorAddress($)
        // Compared without the ` [ref]` suffix on both sides: « Coord: ops » is « Coord: ops [abc] ».
        const bare = (name: string) => name.replace(REFERENCED, '').trim()
        const addressed = coordinator !== null
          && [coordinator.name, typeof coordinator.to === 'string' ? coordinator.to : coordinator.to.sessionId].some(a => bare(a) === bare(to))
        if (addressed) {
          await logLine($, 'guards', `a question sent to the coordinator by message refused (${to})`)
          return { deny: QUESTION_BY_MESSAGE }
        }
      } catch (err) {
        await logLine($, 'guards', `the coordinator could not be read for a message to ${to}: ${(err as Error).message}`)
      }
    }
    // An agent's message to an orchestrator over the verdict limit: cut to it with the pointer to the
    // report it names, refused when it names none. The sender is read only for such a message; one
    // that cannot be read lets the message through.
    let sending = e
    if (to && typeof e.message === 'string' && roleOf(to.replace(REFERENCED, '').trim()) === 'orchestrator') {
      const short = shorten(e.message)
      if (short.kind !== 'whole') {
        try {
          const sessionId = await $.session.id()
          const { name } = await readName($, await transcriptPathOf($, sessionId), sessionId)
          if (roleOf(name) === 'agent') {
            if (short.kind === 'unnamed') {
              await logLine($, 'guards', `a message of ${short.length} characters to ${to} names no report file: refused`)
              return { deny: unnamedReport(short.length) }
            }
            await logLine($, 'guards', `a message of ${e.message.length} characters to ${to} cut, its report at ${short.path}`)
            sending = { ...e, message: short.text }
          }
        } catch (err) {
          await logLine($, 'guards', `the sender of a message to ${to} could not be read: ${(err as Error).message}`)
        }
      }
    }
    const out = await next(sending)
    if (!e.agentId && e.notify_when_idle === true && to && out && !out.isError && !out.deny) {
      try {
        const sessionId = await $.session.id()
        if (!awaited || awaited.sessionId !== sessionId) awaited = { sessionId, peers: new Map() }
        awaited.peers.set(to, Date.now())
      } catch (err) {
        await logLine($, 'guards', `the subscription to ${to} could not be kept: ${(err as Error).message}`)
      }
    }
    return out
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The tier map's guard: a session of the orchestration (one whose name gives it a role)
  // never writes the operator's map — a Write, Edit or MultiEdit on it, or a Bash line that
  // writes it, is denied with the rule — unless the last prompt he typed in this session
  // names the map or a tier: then the binding is his word on the point. Mounted before the
  // kill guard, so a Bash call reaches it first; the session's role is read only for a call
  // that writes the map. Never `ask`: under auto mode it goes to the mode's decider, not to him.
  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] }, async ($: any, e: any, next: (e: any) => any) => {
    const maps = mapPaths(await stateDir($), await configDir($))
    const writes = e.tool === 'Bash'
      ? bashWritesTheMap(String(e.command ?? ''), maps)
      : editsTheMap(String(e.file_path ?? ''), maps)
    if (!writes) return next(e)
    const sessionId = await $.session.id()
    if (lastTyped && lastTyped.sessionId === sessionId && namesTheMap(lastTyped.text)) return next(e)
    const { name } = await readName($, await transcriptPathOf($, sessionId), sessionId)
    if (!roleOf(name)) return next(e)                // the operator's own sessions: untouched
    await logLine($, 'guards', `models guard: a write of the tier map denied (${e.tool})`)
    return { deny: MODELS_DENY }
  }).catch(async ($: any, e: any, next: any) => {
    // A guard that could not read lets the call through, and the log says why: the map is
    // the operator's file, and a session held on the guard's own failure helps nobody.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A dialog in the session's own tab reaches neither the coordinator's pane nor a `waiting:` line,
  // so nothing tells the operator the session is blocked on him. The mode question is never a
  // dialog: an orchestrator's that offers `build` and `investigate` is denied with the way to ask
  // it. While a coordinator runs, an orchestrator and the coordinator are waited on: any dialog of
  // theirs is denied, the question going to the round.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any, next: (e: any) => any) => {
    const sessionId = await $.session.id()
    const role = roleOf((await readName($, await transcriptPathOf($, sessionId), sessionId)).name)
    if (role === 'orchestrator' && asksTheMode(e)) {
      await logLine($, 'guards', 'mode dialog denied: the mode is asked in the question format, never by dialog')
      return { deny: MODE_DIALOG_DENY }
    }
    if ((role !== 'orchestrator' && role !== 'coordinator') || !(await coordinatorAddress($))) return next(e)
    await logLine($, 'guards', `dialog denied: a ${role} is waited on while a coordinator runs`)
    return { deny: WAITED_ON_DIALOG_DENY }
  }).catch(async ($: any, e: any, next: any) => {
    // A guard that could not read lets the dialog through, and the log says why.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The kill guard. tool.call's input carries the tool's arguments beside the tool's name —
  // `e.command`, never a nested `input` — and the deny the engine documents for
  // the event is `{ deny: reason }`, the decision's own shape already, the
  // matcher keeping it to Bash calls. The same hook watches for the successor's
  // spawn: run without error, it is the hand-over the stop gate releases on.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: (e: any) => any) => {
    const command = String(e.command ?? '')
    try {
      spawnedMark = (await $.env.get('ORCHESTRATOR_SPAWNED')) ?? null
    } catch (err) {
      // The mark cannot be read: the decision falls to what is known of it.
      await logLine($, 'guards', (err as Error).message)
      const fallback = guardFallback(spawnedMark, command, (err as Error).message)
      if (fallback) return fallback
      return next(e)
    }
    const decision = killDecision(spawnedMark, command)
    if (decision) return decision
    const out = await next(e)
    if (!e.agentId && isSuccessorSpawn(command) && out && !out.isError && !out.deny) {
      try {
        handedOverIn = await $.session.id()
      } catch (err) {
        await logLine($, 'guards', `the hand-over could not be kept: ${(err as Error).message}`)
      }
    }
    return out
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see. A
    // call already run beneath is let through (next is replay-safe in a catch).
    // One not run yet — a re-entry, a guard past its budget — is decided on the
    // launcher's mark as last read: closed in a spawned session, open in one the
    // operator started, and a kill by pattern refused while the mark is unknown.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    if (next.called) return next(e)
    const fallback = guardFallback(spawnedMark, String(e.command ?? ''), next.error?.message ?? 'the guard did not finish')
    return fallback ?? next(e)
  })

  // The stop gate (hooks/stop_gate.py ported; the decisions in stop-gate.ts). The
  // classic events carry the settings payload's own fields — the shipped types give
  // classic.Stop the transcript path, the cwd and the last assistant message beside the
  // module's — so the scope and the message are read off the event itself. The refusal
  // answers through the module's own field, `block` carrying the reason: the classic
  // decision's shape as the engine documents it. The shell gate that once answered the
  // same stops is gone with the cutover — this handler is the only stop gate, its
  // refusals deduplicated against nothing.
  on('classic.Stop', async ($: any, e: any, next: (e: any) => any) => {
    // The sweep's one shot, armed once the stop is known Orch-scoped: every passing
    // exit below calls it before next(e), a refusal never does, and the catch does too
    // (the shell gate's own finally — a stop the gate could not read through passes all
    // the same, and sweeps). Null until the scope is settled, so a failure before it
    // sweeps nothing.
    let sweepAtStop: (() => Promise<void>) | null = null
    try {
      // At most one refusal per turn (stop_gate.py:653-654): the host re-fires the stop
      // with the marker set, and the gate steps aside before it reads anything — but for an
      // operator wait that still holds no question block, read off the message alone: that one
      // is refused again, within REFIRED_REFUSALS (below).
      const refired = Boolean(e.stop_hook_active)
      if (refired && operatorWaitRefusal(String(e.last_assistant_message ?? '')) === null) return next(e)
      const sessionId = String(e.session_id ?? '')
      if (!refired) unaskedRefusals.delete(sessionId)
      // The scope first, from the session itself: the launcher's listing is a call to
      // the terminal, and every agent's, auditor's and hand-started session would pay it.
      const transcript = String(e.transcript_path ?? '') || await transcriptPathOf($, sessionId)
      // One deadline over the whole gate, the name walk included: its reads are bounded.
      const until = Date.now() + await stopDeadline($)
      const { tty, name, pid } = await readName($, transcript, sessionId, until)
      if (!tty) {
        await logLine($, 'guards', "stop gate: the session's own tty cannot be read")
        return next(e)
      }
      if (!name) {
        await logLine($, 'guards', `stop gate: the session's name cannot be read on ${tty}`)
        return next(e)
      }
      const role = roleOf(name)
      if (role === 'agent') {
        // An agent's report over the verdict limit that names no report file: refused once, the way said.
        const short = shorten(String(e.last_assistant_message ?? '').trim())
        if (short.kind === 'unnamed') {
          await logLine($, 'guards', `stop gate: an agent's report of ${short.length} characters names no report file`)
          return refuse(unnamedReport(short.length))
        }
        return next(e)
      }
      if (role !== 'orchestrator' && role !== 'coordinator') return next(e)
      if (refired) {
        if (role !== 'orchestrator') return next(e)
        return await refiredWithoutQuestion($, unaskedRefusals, sessionId, name, String(e.last_assistant_message ?? ''), until) ?? next(e)
      }
      if (role === 'coordinator') return next(e)
      // An orchestrator ending on a wait for the operator puts him a question: read off the message too.
      const unasked = operatorWaitRefusal(String(e.last_assistant_message ?? ''))
      if (unasked !== null) {
        await logLine($, 'guards', 'stop gate: an operator wait with no question')
        return refuse(unasked)
      }
      const state = await stateDir($)
      // A question still on the operator stays open in the round until he answers it, its answer
      // waking the session, and is not repeated in later messages; with no coordinator, the
      // session's own operator wait is that question. Read off the round and the wait file within
      // the deadline, unless the session handed over, or ends on its last word `handed over`: its
      // successor holds the questions.
      const message = String(e.last_assistant_message ?? '')
      let pending: Awaited<ReturnType<typeof pendingQuestion>> = null
      let ownOpen = false
      if (sessionId !== '' && handedOverIn !== sessionId && !isEnding() && !endsOnHandOver(message)) {
        const typedAt = lastTyped?.sessionId === sessionId ? lastTyped.at : null
        const read = await quietly($, async () => {
          const entries = await roundEntries($, state)
          const wait = await waitRead($, sessionId)
          const own = !(await coordinatorAddress($)) && ownWaitOpen(sessionId, entries, wait, typedAt)
          return { pending: pendingQuestion(sessionId, entries, wait), own }
        }, until, { pending: null, own: false })
        pending = read.pending
        ownOpen = read.own
        const unshown = unansweredRefusal(message, pending)
        if (unshown !== null) {
          // Measured, not refused: a refusal made the turn rewrite the whole block each time. The pane
          // keeps the question visible, and the log counts the turns that left it out.
          await logLine($, 'guards', `stop gate: warn question-unshown (${pending?.entry?.id ?? pending?.blocks ?? '?'})`)
        }
      }
      const root = $.plugin.root   // never $.env: the module's environment has no CLAUDE_PLUGIN_ROOT
      let swept = false
      sweepAtStop = async () => {
        if (swept) return
        swept = true
        await runSweep($, state, root, until)
      }
      // Check 1, what will wake you. The agents of this orchestrator are the chain
      // entries its own session wrote, still running one by the listing's glyph.
      const rows = listing(await mustRun($, ['bash', launcherOf(root), 'list'], "the launcher's listing", until))
      const chain = await quietly($, () => $.fs.read(`${state}/chains/${tty.split('/').pop()}.jsonl`), until, '')
      const owner = await chainOwner($)
      if (!owner) {
        // Said once per stop, as the shell gate said it (stop_gate.py:232): without the
        // owner no chain entry is counted, and the operator should know why the gate
        // saw no agent of its own — a recycled tty's occupant would have been counted.
        await logLine($, 'guards', 'stop gate: ITERM_SESSION_ID is not set: no chain entry is counted')
      }
      const entries = chainEntries(String(chain))
      const hostStatus = await hostStatuses($, entries.filter(entry => entry.owner === owner).map(entry => entry.tty), until)
      const { agents, resident } = ownAgents(rows, entries, owner, hostStatus)
      const delivered: string[] = []
      for (const agent of agents) {
        if (agent.state !== 'idle') continue
        const pr = await pullRequestRead($, agent.tty, until)
        if (pr && (pr.state === 'OPEN' || pr.state === 'MERGED')) {
          delivered.push(`${agent.label} (pull request #${pr.number}, ${pr.state})`)
        }
      }
      // The process table, read once for both checks: the commands and monitors this
      // session started in the background (check 1: one still running will wake it, and
      // names the line that fits) and the ci-watches alive at all (check 2: a head waited
      // on in the background is not told).
      let table: ReturnType<typeof processTable> | null = null
      const processes = async () => {
        if (table === null) {
          const ps = await inTime($, () => runUntil($, ['ps', '-axo', 'pid=,ppid=,command='], until), until)
          table = ps && ps.exitCode === 0 ? processTable(String(ps.stdout ?? '')) : []
        }
        return table
      }
      const background = ownBackground(await processes(), pid)
      // Without the host pid no process can be told as the session's own: a true tool line
      // is accepted rather than refused as « nothing runs », which sends the turn back to a false operator wait.
      const hostUnread = !pid
      if (hostUnread) await logLine($, 'guards', 'stop gate: host pid unread: the process table could not be tied to this session')
      const wake = checkWake({
        agents, resident, delivered, background, hostUnread,
        // The host's own list of the session's work in flight: the tool line's reliable reading.
        tasks: hostTasks(e.background_tasks, e.session_crons),
        awaiting: sessionId !== '' && awaitingIn(sessionId),
        message: String(e.last_assistant_message ?? ''),
        declared: declarations.current(),
        handedOver: (sessionId !== '' && handedOverIn === sessionId) || isEnding(),
        questionOpen: pending !== null || ownOpen,
      })
      if (wake !== null && typeof wake === 'object' && 'blocks' in wake) {
        // The release the machine line grants, logged as the shell gate logged it — the
        // figures that say whether the gate earns its cost are read there.
        await logLine($, 'guards', `stop gate: check1 blocks ${wake.blocks}`)
      } else if (wake !== null && typeof wake === 'object' && 'tool' in wake) {
        await logLine($, 'guards', wake.notRunning ? `stop gate: warn tool-not-running ${wake.tool}` : `stop gate: check1 tool ${wake.tool}`)
      } else if (wake !== null && typeof wake === 'object' && 'warn' in wake) {
        // Measured, not refused: these three reminders cost a turn each and mostly turned out wrong.
        await logLine($, 'guards', `stop gate: warn ${wake.warn}${wake.detail === '' ? '' : ` ${wake.detail}`}`)
      } else if (wake === 'read-what-is-left') {
        // The done line: the facts are read only now, as the shell gate read them lazily.
        const top = await projectTop($, String(e.cwd ?? ''), until)
        const checkouts = projectCheckouts(top, await mustRun($, ['bash', `${root}/skills/orchestrator/scripts/workspace.sh`, 'list'], 'workspace.sh list', until))
        const records = await ownRecords($, await registeredRecords($, state, sessionId, until), orchestrationOf(name), until)
        const ids = deferredIds(machineLine(String(e.last_assistant_message ?? '')))
        const ending = ids === null ? 'done' : 'deferred'
        const texts = await readRecords($, records, until)
        const deferred = openRows(texts)
        const goals = await readGoals($, records, root, until)
        // Measured, not refused: the working copies are not filtered by session, so another
        // orchestrator's checkout of the same project would hold this one's done line.
        if (checkouts.length > 0) await logLine($, 'guards', `stop gate: warn working-copies ${checkouts.join(', ')}`)
        const held = checkWakeDone({
          agents, checkouts, deferred,
          deferredRows: deferredRows(texts),
          goalsOpen: goals.flatMap(g => g.open),
          goalsDeferred: goals.flatMap(g => g.deferred),
          goalsFaults: goals.flatMap(g => g.faults),
          rowRecords: recordsWithOpenRows(records, texts),
          goalsRecords: goals.filter(g => g.open.length > 0).map(g => g.path),
          ending,
          ids: ids ?? undefined,
        })
        if (held) {
          await logLine($, 'guards', `stop gate: check1 ${held.case}`)
          return refuse(held.reason)
        }
      } else if (wake !== null) {
        await logLine($, 'guards', `stop gate: check1 ${wake.case}`)
        return refuse(wake.reason)
      }
      // Check 2, the real CI state, over what ci-watch already watched: its logs are the
      // precomputed state, no synchronous network at a stop.
      if (!sessionId) {
        await logLine($, 'guards', 'stop gate: no session id: the reported heads cannot be kept')
        await sweepAtStop?.()
        return next(e)
      }
      const watches = await listCiWatches($, `${state}/ci-watch`, until)
      if (watches === null) {
        await sweepAtStop?.()
        return next(e)
      }
      // The universe of check 2 is this session's own watches: ci-watch wrote beside each
      // log its owner file, `<log>.session`, holding the id of the session that armed the
      // watch. A log is kept when its owner file, trimmed, is this session's id. A log with
      // no owner file was armed by no session, and an owner file that cannot be read is the
      // same: neither is this session's to be told of, and neither is said. The repository
      // a watch names decides nothing: a session's own watch is told whatever repository it
      // names, another session's never is. One widening stays, declared: a dead watch of
      // this session's closed or merged pull request is still told once per tell — the
      // shell gate read `--state open` live at the stop and a log name carries no state.
      let resolvedRepo: { name: string | null; why: string } | null = null
      const repository = async () => (resolvedRepo ??= await repositoryOf($, String(e.cwd ?? ''), until))
      const logs = []
      for (const entry of watches) {
        const number = watchNumberOf(entry.name)
        if (!number || entry.kind !== 'file') continue
        const owner = String(await quietly($, () => $.fs.read(`${state}/ci-watch/${entry.name}.session`), until, '')).trim()
        if (owner !== sessionId) continue
        const text = await mustReadText($, `${state}/ci-watch/${entry.name}`, `the ci-watch log ${entry.name}`, until)
        const buckets = parseCiWatchLog(text)
        logs.push({ number, tell: logTell(text), checks: Object.entries(buckets).map(([name, bucket]) => ({ name, bucket })) })
      }
      let watched: ReadonlySet<string> = new Set()
      if (logs.length > 0) {
        watched = watchedNumbers((await processes()).map(row => row.command).join('\n'))
      }
      const headsFile = headsPath(state, sessionId)
      const reported = readHeads(String(await quietly($, () => $.fs.read(headsFile), until, '')))
      const { lines, heads } = checkCi({
        logs,
        reported,
        watched,
        ignored: await ignoredChecks($, state, repository, until),
        watchCommand: `${root}/skills/orchestrator/scripts/ci-watch.sh`,
      })
      // The record is written before the refusal is answered, the shell gate's own
      // order: a head told is a head recorded even if the host never reads the reason.
      if (await inTime($, () => $.fs.write(headsFile, writeHeads(heads)), until) === null) {
        await logLine($, 'guards', 'stop gate: the reported heads unread: the write did not answer in time')
        throw new GateUnread('the reported heads')
      }
      if (lines.length > 0) {
        await logLine($, 'guards', `stop gate: check2 ci-not-finished ${lines.map(l => l.split('. Report')[0]).join(' ; ')}`)
        return refuse(lines.join('\n'))
      }
      // The checks have let the stop pass: the sweep runs now, last and never part of
      // the decision (the design's « The sweep runs by itself »).
      await sweepAtStop?.()
      return next(e)
    } catch (err) {
      // A gate that cannot read lets the stop pass and says so — one line, already
      // written where the read failed; anything else the gate broke on is said here.
      // Never a stop held on the gate's own failure.
      if (!(err instanceof GateUnread)) {
        await logLine($, 'guards', `stop gate: ${String((err as Error)?.message ?? err)}`)
      }
      // The shell gate swept in a finally over its checks: a stop it could not read
      // through passes all the same, and sweeps. Never after a refusal — a refusal
      // returns above, before this.
      await sweepAtStop?.()
      return next(e)
    }
  }).catch(async ($: any, e: any, next: any) => {
    // The registered net the plan's every-handler rule asks validate to see, both laws
    // above it: the stop is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// A re-fired stop (the host sets stop_hook_active after a refusal) of an orchestrator whose message still
// ends on an operator wait with no question block: refused again, REFIRED_REFUSALS times, then let through
// (null) with one log line and a notice to its coordinator that it waits on the operator without asking him.
// The notice runs under the gate's deadline: a coordinator that never answers never holds the stop.
async function refiredWithoutQuestion($: any, paidBySession: Map<string, number>, sessionId: string, name: string, message: string, until: number): Promise<{ block: string } | null> {
  const paid = paidBySession.get(sessionId) ?? 0
  if (paid < REFIRED_REFUSALS) {
    paidBySession.set(sessionId, paid + 1)
    await logLine($, 'guards', `stop gate: an operator wait with no question, refused again (${paid + 1} of ${REFIRED_REFUSALS})`)
    return refuse(operatorWaitRefusal(message) ?? '')
  }
  paidBySession.delete(sessionId)
  await logLine($, 'guards', `stop gate: an operator wait with no question let through after ${REFIRED_REFUSALS} more refusals (${name})`)
  try {
    // Not inTime: it turns a throw into null, and a send that fails must be logged as the failure it is.
    const left = until - Date.now()
    const told = left <= 0 ? null : await withDeadline((async () => {
      const coordinator = await coordinatorAddress($)
      if (!coordinator) return 'no coordinator to tell that an orchestrator waits on the operator with no question'
      const sent = await sendToCoordinator($, coordinator.to, `[module] ${name} ended its turn waiting on the operator with no question block, after ${REFIRED_REFUSALS + 1} refusals: he was not asked anything. Ask it of ${name}, or ask him for it.`)
      return sent?.isDelivered ? '' : `the notice to the coordinator was not delivered: ${sent?.reason ?? 'no answer'}`
    })(), left)
    if (told === null || isDegradedPass(told)) await logLine($, 'guards', 'stop gate: the notice to the coordinator did not finish within the deadline')
    else if (told !== '') await logLine($, 'guards', `stop gate: ${told}`)
  } catch (err) {
    await logLine($, 'guards', `stop gate: the notice to the coordinator failed: ${(err as Error).message}`)
  }
  return null
}

// --- the sweep (stop_gate.py:595-642) -----------------------------------------------------

// What the sweep leaves of the deadline for the stop's own answer (the python's
// SWEEP_MARGIN).
const SWEEP_MARGIN = 3.0

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

// sweep_due()/sweep() ported: `workspace.sh sweep` within what is left of the deadline,
// at most once per interval, everything it does a log line — never a refusal, never a
// held stop. The stamp keeps the shell gate's own name, `sweep.stamp`, so a stamp it
// wrote still holds the interval across the cutover: its token is a time, the same
// fact whatever gate reads it. It is written BEFORE the run, so a sweep that hangs is
// not retried by every stop that follows it.
async function runSweep($: any, stateRoot: string, root: string, until: number): Promise<void> {
  try {
    // What is left of the whole gate's deadline, minus the margin its own exit needs.
    // Under a second, or not due: nothing runs, nothing is said.
    const left = (until - Date.now()) / 1000 - SWEEP_MARGIN
    if (left < 1) return
    let mtimeMs: number | null = null
    try { mtimeMs = (await $.fs.stat(`${stateRoot}/sweep.stamp`)).mtimeMs } catch { mtimeMs = null }
    const every = (Number(await $.env.get('ORCHESTRATOR_SWEEP_INTERVAL')) || 600) * 1000
    if (mtimeMs !== null && Date.now() - mtimeMs < every) return
    await $.fs.write(`${stateRoot}/sweep.stamp`, `${Math.floor(Date.now() / 1000)}\n`)
    // The script's own `--deadline` self-limits between items, the real bound; the
    // timeoutMs is the engine's kill of what ignores it (the python killed the process
    // group itself), and the race keeps the stop's answer inside the deadline whatever
    // happens. A run that cannot start is said as its own failure (the python's except
    // naming it, stop_gate.py:642); a run that overruns the bound is one line — it did
    // not finish.
    const ms = Math.round((left + 1.5) * 1000)
    let outcome: { exitCode: number; stdout?: string; stderr?: string } | DegradedPass
    try {
      outcome = await withDeadline(
        $.process.run(
          ['bash', `${root}/skills/orchestrator/scripts/workspace.sh`, 'sweep', '--deadline', String(Math.floor(left))],
          { timeoutMs: ms },
        ),
        ms,
      )
    } catch (err) {
      await logLine($, 'guards', `stop gate: sweep error ${String((err as Error)?.message ?? err)}`)
      return
    }
    if (isDegradedPass(outcome)) {
      await logLine($, 'guards', `stop gate: sweep error did not finish within ${Math.floor(left + 1.5)}s`)
      return
    }
    for (const line of String(outcome.stdout ?? '').split('\n')) {
      if (line.startsWith('deleted ')) await logLine($, 'guards', `stop gate: sweep deleted ${line.slice('deleted '.length)}`)
    }
    if (outcome.exitCode !== 0) {
      await logLine($, 'guards', `stop gate: sweep error exit ${outcome.exitCode}: ${firstLine(String(outcome.stderr ?? ''))}`)
    }
  } catch { /* the sweep never refuses or delays a stop; its failures are said above */ }
}

// --- the stop gate's reads (hooks/stop_gate.py ported; the decisions in stop-gate.ts) -----

// The gate's own failure posture (stop_gate.py:692-693): a read that cannot be made is
// one log line and a stop that passes. Time is the same failure — every read races what
// is left of one overall deadline, and a read that loses lets the stop pass.
class GateUnread extends Error {}

// The whole gate's deadline (stop_gate.py:109): seconds, the env override the operator
// keeps, the shell gate's own default beside it.
async function stopDeadline($: any): Promise<number> {
  const raw = await $.env.get('ORCHESTRATOR_STOP_GATE_DEADLINE')
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 20000
}

// The race without the meaning: null when the work lost the race, threw, or the
// deadline was already spent. Each caller decides what that costs — loud (one line, the
// stop passes) or quiet (a fallback), as stop_gate.py's reads were.
async function inTime<T>($: any, work: () => Promise<T>, until: number): Promise<T | null> {
  const left = until - Date.now()
  if (left <= 0) return null
  try {
    const outcome = await withDeadline(work(), left)
    return isDegradedPass(outcome) ? null : outcome
  } catch {
    return null
  }
}

// The host's status of each tty's session: the processes on the tty, each one's host
// record read under the config dir. A tty no record answers for is left out, and its
// agent falls back to the listing's glyph — never a stop held on this read.
async function hostStatuses($: any, ttys: readonly string[], until: number): Promise<Map<string, 'idle' | 'busy'>> {
  const statuses = new Map<string, 'idle' | 'busy'>()
  const config = await configDir($)
  for (const tty of ttys) {
    const ps = await quietly($, () => runUntil($, ['ps', '-t', tty.replace(/^\/dev\//, ''), '-o', 'pid='], until), until, null)
    if (!ps || ps.exitCode !== 0) continue
    for (const pid of String(ps.stdout ?? '').split('\n').map(line => line.trim().split(/\s+/)[0] ?? '').filter(pid => /^\d+$/.test(pid))) {
      const status = hostStatusOf(String(await quietly($, () => $.fs.read(`${config}/sessions/${pid}.json`), until, '')))
      if (status) {
        statuses.set(tty, status)
        break
      }
    }
  }
  return statuses
}

// A process the gate runs under its deadline: the race above stops the gate's wait, and
// the timeout given here stops the process itself — a hung read never outlives the stop
// it was made for.
function runUntil($: any, argv: readonly string[], until: number, cwd?: string): Promise<any> {
  const timeoutMs = Math.max(1, until - Date.now())
  return $.process.run(argv, cwd ? { timeoutMs, cwd } : { timeoutMs })
}

// Every entry of the round on this machine (supervision.ts readRound's reading, $ never crossing
// an import): a file that does not parse, or a temporary one, is no entry; no directory, none.
async function roundEntries($: any, state: string): Promise<RoundEntry[]> {
  const dir = `${state}/round`
  const listed: readonly { name: string; kind: string }[] = await $.fs.list(dir).catch(() => [])
  const entries: RoundEntry[] = []
  for (const file of listed) {
    if (!file || file.kind !== 'file' || !file.name.endsWith('.json') || file.name.includes('.tmp-')) continue
    const entry = parseRoundEntry(String(await $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    if (entry) entries.push(entry)
  }
  return entries
}

// The session's wait file in the module's store (supervision.ts storeOf), or none.
async function waitRead($: any, sessionId: string): Promise<WaitRead | null> {
  const store = `${moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_MODULE_DIR'))}/store`
  return parseWaitRecord(String(await $.fs.read(`${store}/${waitKey(sessionId)}`).catch(() => '')))
}

// A quiet read's fallback shape.
async function quietly<T>($: any, work: () => Promise<T>, until: number, fallback: T): Promise<T> {
  const done = await inTime($, work, until)
  return done === null ? fallback : done
}

// A read the gate stands down on: it could not be made, so the stop passes and the log
// says so — never a stop held on the gate's own wait.
async function mustRun($: any, argv: readonly string[], what: string, until: number): Promise<string> {
  const done = await inTime($, () => runUntil($, argv, until), until)
  if (!done || done.exitCode !== 0) {
    await logLine($, 'guards', `stop gate: ${what} unread: ${!done ? 'it did not answer in time' : `it exited ${done.exitCode}`}`)
    throw new GateUnread(what)
  }
  return String(done.stdout ?? '')
}

async function mustReadText($: any, path: string, what: string, until: number): Promise<string> {
  let text: unknown = null
  try {
    const left = until - Date.now()
    text = left > 0 ? await withDeadline($.fs.read(path), left) : null
  } catch (err) {
    await logLine($, 'guards', `stop gate: ${what} unread: ${String((err as Error)?.message ?? err)}`)
    throw new GateUnread(what)
  }
  if (text === null || isDegradedPass(text)) {
    await logLine($, 'guards', `stop gate: ${what} unread: it did not answer in time`)
    throw new GateUnread(what)
  }
  return String(text)
}

// pull_request_of()'s reads (stop_gate.py:250-275; the launcher's host_cli_cwd): the
// host process on the agent's tty by the identity rule (hostOn: its record, else its
// basename), that process's working directory, that checkout's branch, then one gh read
// run in that checkout — the only network the gate pays, for an idle agent alone. Any
// read that fails, or cannot answer in time, is no pull request: the refusal simply does
// not name the agent, never a stop held on it.
async function pullRequestRead($: any, tty: string, until: number): Promise<{ number: string; state: string } | null> {
  const left = () => Math.max(1, until - Date.now())
  const config = await configDir($)
  const host = await inTime($, () => hostOn(
    (argv: readonly string[]) => $.process.run(argv, { timeoutMs: left() }),
    recordReader($, config, left),
    hostNamesReader($, left),
    tty,
  ), until)
  if (!host) return null
  const lsof = await inTime($, () => runUntil($, ['lsof', '-a', '-p', host.pid, '-d', 'cwd', '-Fn'], until), until)
  if (!lsof || lsof.exitCode !== 0) return null
  const cwd = String(lsof.stdout ?? '').split('\n').find(l => l.startsWith('n'))?.slice(1) ?? ''
  if (!cwd) return null
  const git = await inTime($, () => runUntil($, ['git', '-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], until), until)
  const branch = git && git.exitCode === 0 ? String(git.stdout ?? '').trim() : ''
  if (!branch) return null
  // One --json argument, the fields comma-joined: gh reads a second word as a second
  // positional and refuses the call. Run in the agent's checkout, the repository its
  // branch is pushed to.
  const gh = await inTime($, () => runUntil($, ['gh', 'pr', 'view', branch, '--json', 'number,state'], until, cwd), until)
  if (!gh || gh.exitCode !== 0) return null
  return pullRequestOf(branch, String(gh.stdout ?? ''))
}

// The project's root (project_checkouts' first half): git's answer, or the cwd itself
// when git gives none. The shell gate resolved the path; the sandbox exposes no
// resolver, and the cwd names the same project to workspace.sh's own listing.
async function projectTop($: any, cwd: string, until: number): Promise<string> {
  const done = await inTime($, () => runUntil($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'], until), until)
  const top = done && done.exitCode === 0 ? String(done.stdout ?? '').trim() : ''
  return top || cwd
}

// open_rows()'s reads (stop_gate.py:315-337): the register this session's records were
// filed under, one path a line, then each record file. A read that fails is no row.
async function registeredRecords($: any, state: string, sessionId: string, until: number): Promise<string[]> {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const register = await quietly($, () => $.fs.read(`${state}/records/${safe}`), until, '')
  return String(register).split('\n').map(line => line.trim()).filter(Boolean)
}

// The registered records that are this session's own: no owner file yet, or the owner file names
// the session's orchestration. A record another orchestration owns is not read, nor its goals.md:
// the session never answers for what it did not open. Each one skipped is said in the log with
// its path. A session whose orchestration is unknown owns nothing, and every owned record is skipped.
async function ownRecords($: any, records: readonly string[], own: string | null, until: number): Promise<string[]> {
  const kept: string[] = []
  for (const path of records) {
    const owner = ownerOf(String(await quietly($, () => $.fs.read(`${path}.owner`), until, '')))
    if (isOwnRecord(owner, own)) {
      kept.push(path)
      continue
    }
    await logLine($, 'guards', `stop gate: ${path} belongs to ${owner}: not read`)
  }
  return kept
}

async function readRecords($: any, records: readonly string[], until: number): Promise<string[]> {
  const texts: string[] = []
  for (const path of records) texts.push(String(await quietly($, () => $.fs.read(path), until, '')))
  return texts
}

// The spec's goals beside each registered record, read by goals.py check — the grammar's one
// implementation, shared with dispatch-record.sh. A record with no goals.md is a legacy one,
// opened before the file existed (open refuses without it now): it passes, said once. A
// check that cannot run, runs out of time, or cannot read its file lets the stop pass on
// that file, said in the log — the gate's own law. A spec that has moved is a note, logged.
async function readGoals($: any, records: readonly string[], root: string, until: number): Promise<GoalsReading[]> {
  const readings: GoalsReading[] = []
  for (const path of goalsPaths(records)) {
    const exists = await inTime($, () => $.fs.exists(path), until)
    if (exists !== true) {
      await logLine($, 'guards', `stop gate: ${path.replace(/\/goals\.md$/, '')} has no goals.md`)
      continue
    }
    const done = await inTime($, () => runUntil($, ['python3', `${root}/skills/orchestrator/scripts/goals.py`, 'check', path, '--json'], until), until)
    const reading = done && (done.exitCode === 0 || done.exitCode === 1) ? parseGoalsCheck(path, String(done.stdout ?? '')) : null
    if (!reading) {
      await logLine($, 'guards', `stop gate: goals unread: ${path}: ${!done ? 'it did not answer in time' : `it exited ${done.exitCode}`}`)
      continue
    }
    for (const note of reading.notes) await logLine($, 'guards', `stop gate: goals ${path}: ${note}`)
    readings.push(reading)
  }
  return readings
}

// The session's repository (`owner/name`), read from the origin remote of the cwd —
// the same fact the shell gate read from gh, a local read now. Null when it cannot be
// known; `why` is the half-line ignored-checks says when it had entries to match.
async function repositoryOf($: any, cwd: string, until: number): Promise<{ name: string | null; why: string }> {
  const remote = await inTime($, () => runUntil($, ['git', '-C', cwd, 'remote', 'get-url', 'origin'], until), until)
  if (!remote) return { name: null, why: 'the origin remote did not answer in time' }
  if (remote.exitCode !== 0) return { name: null, why: 'git remote get-url origin did not answer' }
  const url = String(remote.stdout ?? '').trim()
  const name = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1]
  if (!name) return { name: null, why: url ? `the origin URL names no repository: ${url}` : 'the origin URL is empty' }
  return { name, why: '' }
}

// ignored_checks() ported (stop_gate.py:481-508): the names of the checks the machine
// ignores for the session's repository, one `<owner>/<repo> <check name>` per line. An
// absent file is empty; a malformed line is said and dropped (stop_gate.py:498); a file
// that cannot be read, or a repository that cannot be known, is said once (its
// unreadable line at :507) and filters nothing: a red is never lost for want of a read.
async function ignoredChecks(
  $: any,
  state: string,
  repository: () => Promise<{ name: string | null; why: string }>,
  until: number,
): Promise<Set<string>> {
  let raw: unknown = null
  try {
    const left = until - Date.now()
    raw = left > 0 ? await withDeadline($.fs.read(`${state}/ignored-checks`), left) : null
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (!/ENOENT|no such/i.test(message)) {
      await logLine($, 'guards', `stop gate: ignored-checks unreadable: ${message}`)
    }
    return new Set()
  }
  if (raw === null || isDegradedPass(raw)) return new Set()
  const entries: [string, string][] = []
  for (const line of String(raw).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const [repo, ...rest] = line.trim().split(/\s+/)
    const name = rest.join(' ').trim()
    if (repo.includes('/') && name) entries.push([repo, name])
    else await logLine($, 'guards', `stop gate: ignored-checks malformed line: ${line}`)
  }
  if (entries.length === 0) return new Set()
  const repo = await repository()
  if (repo.name === null) {
    await logLine($, 'guards', `stop gate: ignored-checks repository unread: ${repo.why}`)
    return new Set()
  }
  const wanted = repo.name.toLowerCase()
  return new Set(entries.filter(([ownerRepo]) => ownerRepo.toLowerCase() === wanted).map(([, name]) => name))
}

// The watches ci-watch left behind (check 2's data): an absent directory is no watch
// ever run — the state dir is born without one — and anything else that cannot be read
// stands the check down. Null answers mean exactly that: already said in the log.
async function listCiWatches($: any, dir: string, until: number): Promise<{ name: string; kind: string; mtimeMs: number }[] | null> {
  let listed: unknown = null
  try {
    const left = until - Date.now()
    listed = left > 0 ? await withDeadline($.fs.list(dir), left) : null
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/ENOENT|no such/i.test(message)) return []
    await logLine($, 'guards', `stop gate: the ci-watch watches unread: ${message}`)
    return null
  }
  if (listed === null || isDegradedPass(listed)) {
    await logLine($, 'guards', 'stop gate: the ci-watch watches unread: it did not answer in time')
    return null
  }
  return (listed as { name: string; kind: string; mtimeMs: number }[])
    .filter(entry => entry && typeof entry.name === 'string')
    .map(entry => ({ name: entry.name, kind: String(entry.kind), mtimeMs: Number(entry.mtimeMs) || 0 }))
}
