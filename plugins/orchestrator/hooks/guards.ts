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
import { tripGate, parseMeasure, measureFilePath, newerInstalled, generationLived, runtimeChanges, runtimeDiffArgv, type Newer } from './gauge-core.ts'
import { takeDrift } from './gauge.ts'
import { isEnding } from './naming.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'
import { detectPatternKills } from './pattern-kills.ts'
import {
  withDeadline, isDegradedPass, type DegradedPass,
  listing, chainOwner, ownAgents, hostStatusOf, pullRequestOf, openRows, deferredRows, projectCheckouts,
  headsPath, readHeads, writeHeads, parseCiWatchLog, watchedNumbers,
  checkWake, checkWakeDone, checkCi, isSuccessorSpawn, processTable, ownBackground, hostTasks, logTell,
  noticeFrom, awaitingAny, goalsPaths, parseGoalsCheck, type GoalsReading,
  orchestrationOf, ownerOf, isOwnRecord, recordsWithOpenRows, todoOpen, liveNames, restatedQuestions, restatedReason,
} from './stop-gate.ts'
import { CI_WATCH_DIR, launcherOf, recordsRegistryPath, watchNumberOf } from '../core/orchestration.ts'
import { chainPath, parseChain } from '../core/chain-entries.ts'
import { ledgerLines, readyRows, readyRowsLine } from '../core/pr-ledger.ts'
import { coordinatorAddress, REFERENCED } from './supervision.ts'
import { askedThisTurn, readAsked } from './question.ts'
import { fieldsOf, messageOf, reasonOf, type FsEntry, type Host, type On, type ProcessRunResult } from './host.ts'
import { asksTheMode } from './mode-dialog.ts'
import { unnamedReport } from './relay.ts'
import { shorten } from '../core/verdict.ts'
import { MODELS_DENY, namesTheMap, typedByOperator, mapPaths, editsTheMap, bashWritesTheMap } from './models-guard.ts'
import { configDir, gateEnv, logLine, stateDir } from './module-io.ts'
import { openFor } from './todo.ts'
import {
  MAP_WRITE_CODE, MODE_DIALOG_CODE, observed, REPORT_UNNAMED_CODE, STOP_GATE_CODE, WAITED_ON_DIALOG_CODE,
} from './observe.ts'
import { todoName } from './todo-format.ts'

// The nouns the guards hold.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'tool' | 'clock' | 'ui' | 'settings'>

// What a call beneath answered, read for the marks of one that did not go through.
function answered(out: unknown): { isError?: unknown; deny?: unknown; isDelivered?: unknown } {
  return (typeof out === 'object' && out !== null ? out : {}) as { isError?: unknown; deny?: unknown; isDelivered?: unknown }
}

export function roleLine(role: string, root = ''): string {
  // Verbatim from hooks/context-gate.sh:57-63 — the four role answers. The
  // auditor's brief and the coordinator's skill are spelled from a root the
  // handler reads: a session's cwd is its own project, so a path relative to the
  // plugin's checkout names a file the model cannot open.
  switch (role) {
    case 'orchestrator': return 'Succeed at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.'
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

// A newer commit installed under a running session: only a successor loads it, so the session is
// told to hand over, by its role's own line. The commits are named short, as the deploy's status does.
export function versionAnnouncement(newer: Newer, role: string, root = ''): string {
  return `NEWER VERSION: commit ${newer.installed.slice(0, 7)} of the plugins is installed and this session still runs ${newer.own.slice(0, 7)}; only a successor runs the newer one. Hand over at the end of the step in progress, at once when a defect of the running version blocks you. ${roleLine(role, root)}`
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

// $.fs.read carries no range — the API's own types offer only { as }, and a
// whole read is refused past 4 MiB while transcripts grow past any cap — so a
// block comes from dd through $.process.run (blockArgv): one bounded window per
// step, never the whole file, carried as bytes so a character the window cuts
// is joined whole. dd counts its windows from the file's start, so the blocks
// are aligned there; that changes only which bytes share a read, never what is
// scanned, and the short window is the one holding the file's end. Every read
// carries its own timeout: a read the caller stopped waiting for never outlives
// the bound it was given.
async function readBlock($: Held, path: string, index: number, timeoutMs: number): Promise<Uint8Array> {
  const { exitCode, stdout } = await $.process.run(blockArgv(path, index), { timeoutMs })
  if (exitCode !== 0) throw new Error(`dd exited ${exitCode} on ${path}`)
  return bytesOfBase64(String(stdout ?? ''))
}

// How long a name walk may take when its caller sets no deadline of its own.
const NAME_WALK_MS = 5000

// The host's record of a pid, the identity rule's first half: the text, or null
// when the pid has none.
function recordReader($: Held, config: string, timeoutMs: () => number): ReadRecord {
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
function hostNamesReader($: Held, timeoutMs: () => number): HostNames {
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
export async function readName($: Held, transcriptPath: string, sessionId = '', until = Date.now() + NAME_WALK_MS):
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
async function transcriptPathOf($: Held, sessionId: string): Promise<string> {
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

// The bound of the comparison of two installed commits.
const RUNTIME_DIFF_MS = 5000
const MARKETPLACE_SUFFIX = '@lounisbou'

// The plugins of the deploy's marketplace this session enabled, or null when the settings cannot be
// read: every plugin of its own commit is then taken for loaded.
async function loadedPlugins($: Held): Promise<ReadonlySet<string> | null> {
  try {
    const enabled = fieldsOf(fieldsOf(await $.settings.read())?.['enabledPlugins'])
    if (enabled === undefined) return null
    return new Set(Object.entries(enabled).flatMap(([id, on]) => (on === true && id.endsWith(MARKETPLACE_SUFFIX) ? [id.slice(0, -MARKETPLACE_SUFFIX.length)] : [])))
  } catch {
    return null
  }
}

// Whether the installed commit changes a runtime file of a plugin the session loaded. A comparison
// that cannot be made says yes: the notice is then given as before the comparison existed.
async function changesRuntime($: Held, newer: Newer): Promise<boolean> {
  const run = await $.process.run(runtimeDiffArgv(newer), { timeoutMs: RUNTIME_DIFF_MS }).catch(() => null)
  if (run === null || (run.exitCode !== 0 && run.exitCode !== 1)) return true
  return run.exitCode === 1 && runtimeChanges(String(run.stdout ?? ''), newer, await loadedPlugins($)).length > 0
}

// `declarations`: the waits this session's turns declared, the one the stop gate decides on (wait.ts).
export function register(on: On<Held>, declarations: Declarations = DECLARATIONS): void {
  // Module memory, the gauge's own law: a reload resets it all. The transcript's
  // place and the version decided are the session's own, keyed by its id: after a
  // /clear the id changes and no session.start fires, so a memo held across it
  // would name the old session's transcript. `toldCommit` is the newer commit last
  // decided (told, or found to change nothing the session runs), `announced` whether
  // a version notice was given.
  let memo: { sessionId: string; transcript: string | null; toldCommit: string | null; announced: boolean } | null = null
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
  let lastTyped: { sessionId: string; text: string; at: string } | null = null
  on('prompt.submit', async ($, e, next) => {
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
      if (memo === null || memo.sessionId !== sessionId) memo = { sessionId, transcript: null, toldCommit: null, announced: false }
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
      // A newer installed commit is said to the sessions that last, once per commit, when it changes
      // a file the session runs; an orchestrator only once its generation has lived. An agent ends at
      // its merge and is not told.
      if (role === 'coordinator' || (role === 'orchestrator' && generationLived(reading, Date.now()))) {
        const newer = await newerInstalled($.plugin.root, (path: string) => $.fs.read(path), memo.toldCommit, Date.now(), memo.announced)
        if (newer && await changesRuntime($, newer)) {
          memo.announced = true
          blocks.push(versionAnnouncement(newer, role, root))
        }
        if (newer) memo.toldCommit = newer.installed
      }
      if (!reading) return answer()
      const env = await gateEnv($)
      const gate = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, env)
      const announcement = gateAnnouncement(gate, role, root, setNames(env))
      if (announcement) blocks.push(announcement)
    } catch (err) {
      // A gate that cannot measure lets the prompt through and says so once in
      // the log; the log's own failure stays quiet (the every-handler-logs rule).
      await logLine($, 'guards', messageOf(err))
    }
    return answer()
  }).catch(async ($, e, next) => {
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
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const { to: target, message } = e
    const to = typeof target === 'string' ? target.trim() : ''
    // An agent's message to an orchestrator over the verdict limit: cut to it with the pointer to the
    // report it names, let through whole when it names none. The sender is read only for such a message; one
    // that cannot be read lets the message through.
    let sending = e
    if (to && typeof message === 'string' && roleOf(to.replace(REFERENCED, '').trim()) === 'orchestrator') {
      const short = shorten(message)
      if (short.kind !== 'whole') {
        try {
          const sessionId = await $.session.id()
          const { name } = await readName($, await transcriptPathOf($, sessionId), sessionId)
          if (roleOf(name) === 'agent') {
            if (short.kind === 'unnamed') {
              // Observed, not refused: the message goes whole, and the journal holds the escape.
              await logLine($, 'guards', `a message of ${short.length} characters to ${to} names no report file: let through`)
              await observed($, REPORT_UNNAMED_CODE)
            } else {
              await logLine($, 'guards', `a message of ${message.length} characters to ${to} cut, its report at ${short.path}`)
              sending = { ...e, message: short.text }
            }
          }
        } catch (err) {
          await logLine($, 'guards', `the sender of a message to ${to} could not be read: ${messageOf(err)}`)
        }
      }
    }
    const out = await next(sending)
    if (!e.agentId && e['notify_when_idle'] === true && to && out && !answered(out).isError && !answered(out).deny) {
      try {
        const sessionId = await $.session.id()
        if (!awaited || awaited.sessionId !== sessionId) awaited = { sessionId, peers: new Map() }
        awaited.peers.set(to, Date.now())
      } catch (err) {
        await logLine($, 'guards', `the subscription to ${to} could not be kept: ${messageOf(err)}`)
      }
    }
    return out
  }).catch(async ($, e, next) => {
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The tier map's guard: a session of the orchestration (one whose name gives it a role)
  // that writes the operator's map is observed when it is a Write, Edit or MultiEdit on it (the
  // call goes through with one escape in the journal), and refused when it is a Bash line that
  // overwrites it (a redirection, `tee`, `sed -i`, `mv`, `cp`, `install`, `ln`): that destroys his
  // bindings with no backup, the deletion class. Unless the last prompt he typed in this session
  // names the map or a tier: then the binding is his word on the point. Mounted before the
  // kill guard, so a Bash call reaches it first; the session's role is read only for a call
  // that writes the map. Never `ask`.
  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] }, async ($, e, next) => {
    const maps = mapPaths(await stateDir($), await configDir($))
    const writes = e['tool'] === 'Bash'
      ? bashWritesTheMap(String(e['command'] ?? ''), maps)
      : editsTheMap(String(e['file_path'] ?? ''), maps)
    if (!writes) return next(e)
    const sessionId = await $.session.id()
    if (lastTyped && lastTyped.sessionId === sessionId && namesTheMap(lastTyped.text)) return next(e)
    const { name } = await readName($, await transcriptPathOf($, sessionId), sessionId)
    if (!roleOf(name)) return next(e)                // the operator's own sessions: untouched
    // A Bash overwrite destroys the bindings: refused. A file tool's write is observed.
    if (e['tool'] === 'Bash') {
      await logLine($, 'guards', 'models guard: a Bash write of the tier map denied')
      return { deny: MODELS_DENY }
    }
    // Observed, not refused: the write goes through, and the journal holds the escape.
    await logLine($, 'guards', `models guard: a write of the tier map let through (${e['tool']})`)
    await observed($, MAP_WRITE_CODE)
    return next(e)
  }).catch(async ($, e, next) => {
    // A guard that could not read lets the call through, and the log says why: the map is
    // the operator's file, and a session held on the guard's own failure helps nobody.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // A dialog in the session's own tab reaches neither the coordinator's pane nor a `waiting:` line,
  // so nothing tells the operator the session is blocked on him. The mode question is never a
  // dialog: an orchestrator's that offers `build` and `investigate` is observed. While a coordinator
  // runs, an orchestrator and the coordinator are waited on: any dialog of theirs is observed. Both
  // open, each with one escape in the journal.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const sessionId = await $.session.id()
    const role = roleOf((await readName($, await transcriptPathOf($, sessionId), sessionId)).name)
    if (role === 'orchestrator' && asksTheMode({ questions: e['questions'] })) {
      // Observed, not refused: the dialog opens, and the journal holds the escape.
      await logLine($, 'guards', 'mode dialog let through: the mode is asked in the question format, never by dialog')
      await observed($, MODE_DIALOG_CODE)
      return next(e)
    }
    if ((role !== 'orchestrator' && role !== 'coordinator') || !(await coordinatorAddress($))) return next(e)
    await logLine($, 'guards', `dialog let through: a ${role} is waited on while a coordinator runs`)
    await observed($, WAITED_ON_DIALOG_CODE)
    return next(e)
  }).catch(async ($, e, next) => {
    // A guard that could not read lets the dialog through, and the log says why.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The kill guard. tool.call's input carries the tool's arguments beside the tool's name —
  // `e.command`, never a nested `input` — and the deny the engine documents for
  // the event is `{ deny: reason }`, the decision's own shape already, the
  // matcher keeping it to Bash calls. The same hook watches for the successor's
  // spawn: run without error, it is the hand-over the stop gate releases on.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e['command'] ?? '')
    try {
      spawnedMark = (await $.env.get('ORCHESTRATOR_SPAWNED')) ?? null
    } catch (err) {
      // The mark cannot be read: the decision falls to what is known of it.
      await logLine($, 'guards', messageOf(err))
      const fallback = guardFallback(spawnedMark, command, messageOf(err))
      if (fallback) return fallback
      return next(e)
    }
    const decision = killDecision(spawnedMark, command)
    if (decision) return decision
    const out = await next(e)
    if (!e.agentId && isSuccessorSpawn(command) && out && !answered(out).isError && !answered(out).deny) {
      try {
        handedOverIn = await $.session.id()
        declarations.handOver(handedOverIn)
      } catch (err) {
        await logLine($, 'guards', `the hand-over could not be kept: ${messageOf(err)}`)
      }
    }
    return out
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see. A
    // call already run beneath is let through (next is replay-safe in a catch).
    // One not run yet — a re-entry, a guard past its budget — is decided on the
    // launcher's mark as last read: closed in a spawned session, open in one the
    // operator started, and a kill by pattern refused while the mark is unknown.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    if (next.called) return next(e)
    const fallback = guardFallback(spawnedMark, String(e['command'] ?? ''), next.error?.message ?? 'the guard did not finish')
    return fallback ?? next(e)
  })

  // The stop gate (hooks/stop_gate.py ported; the decisions in stop-gate.ts). The
  // classic events carry the settings payload's own fields — the shipped types give
  // classic.Stop the transcript path, the cwd and the last assistant message beside the
  // module's — so the scope and the message are read off the event itself. Since the
  // operator's ruling of 2026-11-15 the gate refuses nothing: each stop it would have held
  // passes, with one `let through` log line and one escape in the journal. The shell gate
  // that once answered the same stops is gone with the cutover — this handler is the only
  // stop gate.
  on('classic.Stop', async ($, e, next) => {
    // The sweep's one shot, armed once the stop is known Orch-scoped: every passing
    // exit below calls it before next(e), a refusal never does, and the catch does too
    // (the shell gate's own finally — a stop the gate could not read through passes all
    // the same, and sweeps). Null until the scope is settled, so a failure before it
    // sweeps nothing.
    let sweepAtStop: (() => Promise<void>) | null = null
    // Observed, not refused: what the gate once refused the stop for is logged whole, the journal
    // holds one escape under the gate's code, and the stop passes, swept as any other.
    // The open rows ready with nobody on them, once the launcher's listing is read: said in every line
    // the gate writes for a stop it lets through, and a warning of its own for one that would pass.
    let readiness: (() => Promise<string | null>) | null = null
    const letThrough = async (reason: string | null): Promise<unknown> => {
      const ready = await readiness?.() ?? null
      const said = [reason, ready].flatMap(text => text ?? []).join('\n')
      await logLine($, 'guards', `stop gate: let through: ${said.replace(/\s*\n\s*/g, ' ')}`)
      await observed($, STOP_GATE_CODE)
      await sweepAtStop?.()
      return next(e)
    }
    try {
      // A stop another gate already held this turn is re-fired with the marker set: this gate,
      // which only observes, steps aside before it reads anything, its line already written.
      if (e.stop_hook_active) return next(e)
      const sessionId = String(e.session_id ?? '')
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
        // An agent's report over the verdict limit that names no report file: observed, the way said in the log.
        const short = shorten(String(e.last_assistant_message ?? '').trim())
        if (short.kind === 'unnamed') {
          await logLine($, 'guards', `stop gate: an agent's report of ${short.length} characters names no report file`)
          return await letThrough(unnamedReport(short.length))
        }
        return next(e)
      }
      if (role === 'auditor') {
        // An auditor ends on no gate of its own, except its list: an item still open and no wait declared is refused once.
        const owed = await quietly($, () => openFor($, name), until, { pending: [], deferred: [] })
        const open = [...owed.pending, ...owed.deferred]
        if (declarations.current() !== null || open.length === 0) return next(e)
        await logLine($, 'guards', `stop gate: an auditor with ${open.length} open to-do`)
        return await letThrough(todoOpen(open.map(todoName)))
      }
      if (role !== 'orchestrator' && role !== 'coordinator') return next(e)
      if (role === 'coordinator') return next(e)
      const state = await stateDir($)
      // A question asked with `ask` still open stays in the round until he answers it, its answer
      // waking the session; unless the session handed over: its successor holds the questions.
      let opened: { id: string; ask: string }[] = []
      if (sessionId !== '' && handedOverIn !== sessionId && !isEnding()) {
        opened = await quietly($, async () => (await readAsked($)).filter(entry => entry.status === 'open' && entry.sender.session === sessionId), until, [])
      }
      const questionOpen = opened.length > 0
      const root = $.plugin.root   // never $.env: the module's environment has no CLAUDE_PLUGIN_ROOT
      let swept = false
      sweepAtStop = async () => {
        if (swept) return
        swept = true
        await runSweep($, state, root, until)
      }
      // A turn's end that copies the block of a question asked in an earlier turn: told once, by its subject.
      const earlier = opened.filter(entry => !askedThisTurn().includes(entry.id))
      const restated = restatedQuestions(String(e.last_assistant_message ?? ''), earlier)
      if (restated.length > 0) {
        await logLine($, 'guards', `stop gate: restated question ${restated.join(', ')}`)
        return await letThrough(restatedReason(restated))
      }
      // Check 1, what will wake you. The agents of this orchestrator are the chain
      // entries its own session wrote, still running one by the listing's glyph.
      const rows = listing(await mustRun($, ['bash', launcherOf(root), 'list'], "the launcher's listing", until))
      const chain = await quietly($, () => $.fs.read(chainPath(state, tty)), until, '')
      const owner = await chainOwner($)
      if (!owner) {
        // Said once per stop, as the shell gate said it (stop_gate.py:232): without the
        // owner no chain entry is counted, and the operator should know why the gate
        // saw no agent of its own — a recycled tty's occupant would have been counted.
        await logLine($, 'guards', 'stop gate: ITERM_SESSION_ID is not set: no chain entry is counted')
      }
      const entries = parseChain(String(chain))
      let readyOnce: string | null | undefined
      readiness = async () => {
        if (readyOnce !== undefined) return readyOnce
        try {
          const records = await ownRecords($, await registeredRecords($, state, sessionId, until), orchestrationOf(name), until)
          const texts = await readRecords($, records, until)
          readyOnce = readyRowsLine(readyRows({ texts, lines: texts.flatMap(text => ledgerLines(text)), live: liveNames(rows) }))
        } catch (err) {
          await logLine($, 'guards', `stop gate: ready rows unread: ${reasonOf(err)}`)
          readyOnce = null
        }
        return readyOnce
      }
      const hostStatus = await hostStatuses($, entries.filter(entry => entry.owner === owner).map(entry => entry.tty), until)
      const { agents, resident } = ownAgents(rows, entries, owner, hostStatus)
      // An idle agent whose pull request merged is delivered; one whose pull request is open
      // lives until the merge, the kept findings its own to correct, and is never asked to stand down.
      const delivered: string[] = []
      const awaitingMerge: string[] = []
      for (const agent of agents) {
        if (agent.state !== 'idle') continue
        const pr = await pullRequestRead($, agent.tty, until)
        if (pr?.state === 'MERGED') delivered.push(`${agent.label} (pull request #${pr.number}, ${pr.state})`)
        if (pr?.state === 'OPEN') awaitingMerge.push(agent.label)
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
      if (!pid) await logLine($, 'guards', 'stop gate: host pid unread: the process table could not be tied to this session')
      const wake = checkWake({
        agents, resident, delivered, background, awaitingMerge,
        // The host's own list of the session's work in flight, the reliable reading of what will wake it.
        tasks: hostTasks(e.background_tasks, e.session_crons),
        awaiting: sessionId !== '' && awaitingIn(sessionId),
        declared: declarations.current(),
        handedOver: (sessionId !== '' && handedOverIn === sessionId) || isEnding(),
        questionOpen,
      })
      if (wake !== null && typeof wake === 'object' && 'blocks' in wake) {
        // The release the machine line grants, logged as the shell gate logged it — the
        // figures that say whether the gate earns its cost are read there.
        await logLine($, 'guards', `stop gate: check1 blocks ${wake.blocks}`)
      } else if (wake !== null && typeof wake === 'object' && 'warn' in wake) {
        // Measured, not refused: these reminders cost a turn each and mostly turned out wrong.
        await logLine($, 'guards', `stop gate: warn ${wake.warn}${wake.detail === '' ? '' : ` ${wake.detail}`}`)
      } else if (wake === 'read-what-is-left') {
        // The done line: the facts are read only now, as the shell gate read them lazily.
        const top = await projectTop($, String(e.cwd ?? ''), until)
        const checkouts = projectCheckouts(top, await mustRun($, ['bash', `${root}/skills/orchestrator/scripts/workspace.sh`, 'list'], 'workspace.sh list', until))
        const records = await ownRecords($, await registeredRecords($, state, sessionId, until), orchestrationOf(name), until)
        // The ending is the wait the turn declared: done, or deferred with the items it names.
        const declared = declarations.current()
        const ids = declared?.kind === 'deferred' ? declared.blocks : null
        const ending = ids === null ? 'done' : 'deferred'
        const texts = await readRecords($, records, until)
        const deferred = openRows(texts)
        const goals = await readGoals($, records, root, until)
        const owed = await quietly($, () => openFor($, name), until, { pending: [], deferred: [] })
        // Measured, not refused: the working copies are not filtered by session, so another
        // orchestrator's checkout of the same project would hold this one's done line.
        if (checkouts.length > 0) await logLine($, 'guards', `stop gate: warn working-copies ${checkouts.join(', ')}`)
        const held = checkWakeDone({
          agents, checkouts, deferred,
          deferredRows: deferredRows(texts),
          goalsOpen: goals.flatMap(g => g.open),
          goalsDeferred: goals.flatMap(g => g.deferred),
          goalsFaults: goals.flatMap(g => g.faults),
          todos: owed.pending.map(todoName),
          todosDeferred: owed.deferred.map(todoName),
          rowRecords: recordsWithOpenRows(records, texts),
          goalsRecords: goals.filter(g => g.open.length > 0).map(g => g.path),
          ending,
          ids: ids ?? undefined,
        })
        if (held) {
          await logLine($, 'guards', `stop gate: check1 ${held.case}`)
          return await letThrough(held.reason)
        }
      } else if (wake !== null) {
        await logLine($, 'guards', `stop gate: check1 ${wake.case}`)
        return await letThrough(wake.reason)
      }
      // Check 2, the real CI state, over what ci-watch already watched: its logs are the
      // precomputed state, no synchronous network at a stop.
      if (!sessionId) {
        await logLine($, 'guards', 'stop gate: no session id: the reported heads cannot be kept')
        await sweepAtStop?.()
        return next(e)
      }
      // A stop the checks let pass is still said when a ready row has nobody on it: a warning, as the others the gate measures.
      const passing = async (): Promise<unknown> => {
        // Measured, not refused: nothing held this stop, so no escape is journalled for it.
        const ready = await readiness?.() ?? null
        if (ready !== null) await logLine($, 'guards', `stop gate: warn ready-rows ${ready.replace(/\s*\n\s*/g, ' ')}`)
        await sweepAtStop?.()
        return next(e)
      }
      const watches = await listCiWatches($, `${state}/${CI_WATCH_DIR}`, until)
      if (watches === null) return await passing()
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
        const owner = String(await quietly($, () => $.fs.read(`${state}/${CI_WATCH_DIR}/${entry.name}.session`), until, '')).trim()
        if (owner !== sessionId) continue
        const text = await mustReadText($, `${state}/${CI_WATCH_DIR}/${entry.name}`, `the ci-watch log ${entry.name}`, until)
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
        return await letThrough(lines.join('\n'))
      }
      // The checks have let the stop pass: the sweep runs now, last and never part of
      // the decision (the design's « The sweep runs by itself »).
      return await passing()
    } catch (err) {
      // A gate that cannot read lets the stop pass and says so — one line, already
      // written where the read failed; anything else the gate broke on is said here.
      // Never a stop held on the gate's own failure.
      if (!(err instanceof GateUnread)) {
        await logLine($, 'guards', `stop gate: ${reasonOf(err)}`)
      }
      // The shell gate swept in a finally over its checks: a stop it could not read
      // through passes all the same, and sweeps.
      await sweepAtStop?.()
      return next(e)
    }
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see, both laws
    // above it: the stop is let through, the state dir says why, and next is
    // replay-safe in a catch, called or not.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
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
async function runSweep($: Held, stateRoot: string, root: string, until: number): Promise<void> {
  try {
    // What is left of the whole gate's deadline, minus the margin its own exit needs.
    // Under a second, or not due: nothing runs, nothing is said.
    const left = (until - Date.now()) / 1000 - SWEEP_MARGIN
    if (left < 1) return
    let mtimeMs: number | null = null
    try { mtimeMs = (await $.fs.stat(`${stateRoot}/sweep.stamp`)).mtimeMs ?? null } catch { mtimeMs = null }
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
      await logLine($, 'guards', `stop gate: sweep error ${reasonOf(err)}`)
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
async function stopDeadline($: Held): Promise<number> {
  const raw = await $.env.get('ORCHESTRATOR_STOP_GATE_DEADLINE')
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 20000
}

// The race without the meaning: null when the work lost the race, threw, or the
// deadline was already spent. Each caller decides what that costs — loud (one line, the
// stop passes) or quiet (a fallback), as stop_gate.py's reads were.
async function inTime<T>($: Held, work: () => Promise<T>, until: number): Promise<T | null> {
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
async function hostStatuses($: Held, ttys: readonly string[], until: number): Promise<Map<string, 'idle' | 'busy'>> {
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
function runUntil($: Held, argv: readonly string[], until: number, cwd?: string): Promise<ProcessRunResult> {
  const timeoutMs = Math.max(1, until - Date.now())
  return $.process.run(argv, cwd ? { timeoutMs, cwd } : { timeoutMs })
}

// A quiet read's fallback shape.
async function quietly<T>($: Held, work: () => Promise<T>, until: number, fallback: T): Promise<T> {
  const done = await inTime($, work, until)
  return done === null ? fallback : done
}

// A read the gate stands down on: it could not be made, so the stop passes and the log
// says so — never a stop held on the gate's own wait.
async function mustRun($: Held, argv: readonly string[], what: string, until: number): Promise<string> {
  const done = await inTime($, () => runUntil($, argv, until), until)
  if (!done || done.exitCode !== 0) {
    await logLine($, 'guards', `stop gate: ${what} unread: ${!done ? 'it did not answer in time' : `it exited ${done.exitCode}`}`)
    throw new GateUnread(what)
  }
  return String(done.stdout ?? '')
}

async function mustReadText($: Held, path: string, what: string, until: number): Promise<string> {
  let text: unknown = null
  try {
    const left = until - Date.now()
    text = left > 0 ? await withDeadline($.fs.read(path), left) : null
  } catch (err) {
    await logLine($, 'guards', `stop gate: ${what} unread: ${reasonOf(err)}`)
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
async function pullRequestRead($: Held, tty: string, until: number): Promise<{ number: string; state: string } | null> {
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
async function projectTop($: Held, cwd: string, until: number): Promise<string> {
  const done = await inTime($, () => runUntil($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'], until), until)
  const top = done && done.exitCode === 0 ? String(done.stdout ?? '').trim() : ''
  return top || cwd
}

// open_rows()'s reads (stop_gate.py:315-337): the register this session's records were
// filed under, one path a line, then each record file. A read that fails is no row.
async function registeredRecords($: Held, state: string, sessionId: string, until: number): Promise<string[]> {
  const register = await quietly($, () => $.fs.read(recordsRegistryPath(state, sessionId)), until, '')
  return String(register).split('\n').map(line => line.trim()).filter(Boolean)
}

// The registered records that are this session's own: no owner file yet, or the owner file names
// the session's orchestration. A record another orchestration owns is not read, nor its goals.md:
// the session never answers for what it did not open. Each one skipped is said in the log with
// its path. A session whose orchestration is unknown owns nothing, and every owned record is skipped.
async function ownRecords($: Held, records: readonly string[], own: string | null, until: number): Promise<string[]> {
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

async function readRecords($: Held, records: readonly string[], until: number): Promise<string[]> {
  const texts: string[] = []
  for (const path of records) texts.push(String(await quietly($, () => $.fs.read(path), until, '')))
  return texts
}

// The spec's goals beside each registered record, read by goals.py check — the grammar's one
// implementation, shared with dispatch-record.sh. A record with no goals.md is a legacy one,
// opened before the file existed (open refuses without it now): it passes, said once. A
// check that cannot run, runs out of time, or cannot read its file lets the stop pass on
// that file, said in the log — the gate's own law. A spec that has moved is a note, logged.
async function readGoals($: Held, records: readonly string[], root: string, until: number): Promise<GoalsReading[]> {
  const readings: GoalsReading[] = []
  for (const path of goalsPaths(records)) {
    const exists = await inTime($, () => $.fs.exists(path), until)
    if (exists !== true) {
      await logLine($, 'guards', `stop gate: ${path.replace(/\/goals\.md$/, '')} has no goals.md`)
      continue
    }
    const done = await inTime($, () => runUntil($, ['bash', `${root}/skills/orchestrator/scripts/goals.sh`, 'check', path, '--json'], until), until)
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
async function repositoryOf($: Held, cwd: string, until: number): Promise<{ name: string | null; why: string }> {
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
  $: Held,
  state: string,
  repository: () => Promise<{ name: string | null; why: string }>,
  until: number,
): Promise<Set<string>> {
  let raw: unknown = null
  try {
    const left = until - Date.now()
    raw = left > 0 ? await withDeadline($.fs.read(`${state}/ignored-checks`), left) : null
  } catch (err) {
    const message = reasonOf(err)
    if (!/ENOENT|no such/i.test(message)) {
      await logLine($, 'guards', `stop gate: ignored-checks unreadable: ${message}`)
    }
    return new Set()
  }
  if (raw === null || isDegradedPass(raw)) return new Set()
  const entries: [string, string][] = []
  for (const line of String(raw).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const [repo = '', ...rest] = line.trim().split(/\s+/)
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
async function listCiWatches($: Held, dir: string, until: number): Promise<{ name: string; kind: string; mtimeMs: number }[] | null> {
  let listed: FsEntry[] | DegradedPass | null = null
  try {
    const left = until - Date.now()
    listed = left > 0 ? await withDeadline($.fs.list(dir), left) : null
  } catch (err) {
    const message = reasonOf(err)
    if (/ENOENT|no such/i.test(message)) return []
    await logLine($, 'guards', `stop gate: the ci-watch watches unread: ${message}`)
    return null
  }
  if (listed === null || isDegradedPass(listed)) {
    await logLine($, 'guards', 'stop gate: the ci-watch watches unread: it did not answer in time')
    return null
  }
  return listed
    .filter(entry => entry && typeof entry.name === 'string')
    .map(entry => ({ name: entry.name, kind: String(entry.kind), mtimeMs: Number(entry.mtimeMs) || 0 }))
}
