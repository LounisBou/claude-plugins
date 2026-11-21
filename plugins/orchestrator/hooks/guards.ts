// hooks/guards.ts
// The guards in-process, and the walks they walk. The context gate,
// hooks/context-gate.sh ported: on every prompt of a session the
// orchestration named, the fill the gauge measured, said to the model past the
// gate — never a line the user must relay. The kill guard beside it, on every
// Bash call of a session the launcher spawned: every kill by name or pattern
// refused, since a session kills only what it started, by pid. A forced push is
// the forge's to refuse (github's `/github:protect`), never a reading of the
// command's text here. And
// an orchestrator's turn end, which decides nothing of the stop: it arms the
// module's tick on the busy agents and the pull requests, shows the idle
// agents' pull requests on their windows, and sweeps the checkouts.
//
// The engine fences $ to the file that received it — never passed across an
// import, a noun of it never read as a value — so the transcript block reader
// lives here, next to the handlers that hold $, while the name walk's logic
// stays pure in session-name.ts (readName below delegates to it over this
// file's own readers) and the turn end's pure parts in stop-gate.ts.
import {
  roleOf, walkName, hostOn, scanTail, hostBasenames, blockArgv, bytesOfBase64, hostRecordOf,
  type ReadRecord, type HostNames,
} from './session-name.ts'
import { tripGate, parseMeasure, measureFilePath, newerInstalled, generationLived, runtimeChanges, runtimeDiffArgv, homeReloadArgv, type Newer } from './gauge-core.ts'
import { takeDrift } from './gauge.ts'
import { DECLARATIONS, type Declarations } from './wait.ts'
import { detectPatternKills, type Own } from './pattern-kills.ts'
import {
  withDeadline, isDegradedPass, type DegradedPass,
  listing, chainOwner, ownAgents, hostStatusOf, pullRequestOf, isSuccessorSpawn,
  orchestrationOf, ownerOf, isOwnRecord, busyWake, type BusyAgent, type OwnAgent,
} from './stop-gate.ts'
import { launcherOf, recordsRegistryPath } from '../core/orchestration.ts'
import { chainPath, parseChain } from '../core/chain-entries.ts'
import { agentsOf, ledgerLines } from '../core/pr-ledger.ts'
import { refreshRowAndDeck, showPrStates } from './supervision.ts'
import { pullRequestsRead } from './tab-state.ts'
import { fieldsOf, messageOf, reasonOf, type Host, type On, type ProcessRunResult } from './host.ts'
import { MODELS_DENY, namesTheMap, typedByOperator, mapPaths, bashWritesTheMap } from './models-guard.ts'
import { configDir, dataDir, gateEnv, logLine, moduleDir, stateDir, writeAtomic } from './module-io.ts'
import { prWake } from './ledger.ts'
import { projectRecords } from './unattended.ts'
import { PR_FILE_INTERVAL_MS } from './pr-file-format.ts'
import { fileWanted } from './pr-file.ts'

// The nouns the guards hold.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'prompt' | 'session' | 'tool' | 'clock' | 'ui' | 'settings'>

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

// A newer commit installed under a running coordinator: only a successor loads it, so it is told to
// hand over, by its role's own line. The commits are named short, as the deploy's status does.
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
// their wait loops) — but a `pkill` of a path that is the session's own (under its scratchpad)
// reaches only its own, and passes.
export function killDecision(spawned: string | null | undefined, command: string, own?: Own): { deny: string } | null {
  if (!spawned) return null                        // the operator's own sessions: untouched
  const kills = detectPatternKills(command, own)
  if (kills.length === 0) return null
  return { deny: `kill refused: this session was spawned by the launcher, and it kills only what it started, by the pid it recorded in a file (start it with \`cmd & echo $! > <file>\`, end it with \`kill $(cat <file>)\`). A kill by name or pattern can end other sessions' processes. Seen: ${kills.join(', ')}.` }
}

// The kill guard's answer when it could not run whole: the mark as last read decides.
// A session the launcher marked refuses its kills by pattern as the guard would; a mark
// never read refuses them with the reason the guard did not finish — the safe side when
// nothing says which session this is; an operator's own session is left alone.
export function guardFallback(mark: string | null | undefined, command: string, why: string, own?: Own): { deny: string } | null {
  if (mark !== undefined) return killDecision(mark, command, own)
  const kills = detectPatternKills(command, own)
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

// What the session owns, for the kill guard: its id. One that cannot be read is left empty, so the
// guard refuses the more.
async function ownOf($: Held): Promise<Own> {
  try {
    return { session: await $.session.id() }
  } catch {
    return { session: '' }
  }
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
// The bound of the home servers' reload: one tmux round trip per server.
const HOME_RELOAD_MS = 10_000
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

// Every live home server reads the installed commit's tmux conf, with no restart; a reload that fails is
// said in the log and changes nothing else.
async function reloadHomes($: Held, newer: Newer): Promise<void> {
  const run = await $.process.run(homeReloadArgv(newer), { timeoutMs: HOME_RELOAD_MS }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: messageOf(err) }))
  if (run.exitCode !== 0) await logLine($, 'guards', `the home servers did not all reload ${newer.installed.slice(0, 7)}'s conf: ${String(run.stderr || run.stdout || `exit ${run.exitCode}`).trim().split('\n').pop()}`)
}

// Whether the installed commit changes a runtime file of a plugin the session loaded. A comparison
// that cannot be made says yes: the notice is then given as before the comparison existed.
async function changesRuntime($: Held, newer: Newer): Promise<boolean> {
  const run = await $.process.run(runtimeDiffArgv(newer), { timeoutMs: RUNTIME_DIFF_MS }).catch(() => null)
  if (run === null || (run.exitCode !== 0 && run.exitCode !== 1)) return true
  return run.exitCode === 1 && runtimeChanges(String(run.stdout ?? ''), newer, await loadedPlugins($)).length > 0
}

// `declarations`: the waits this session's turns declared and its hand-over (wait.ts), read at the turn's end (supervision.ts).
export function register(on: On<Held>, declarations: Declarations = DECLARATIONS): void {
  // Module memory, the gauge's own law: a reload resets it all. The transcript's
  // place and the version decided are the session's own, keyed by its id: after a
  // /clear the id changes and no session.start fires, so a memo held across it
  // would name the old session's transcript. `toldCommit` is the newer commit last
  // decided (told, or found to change nothing the session runs), `announced` whether
  // a newer commit was already acted on.
  let memo: { sessionId: string; transcript: string | null; toldCommit: string | null; announced: boolean } | null = null
  // The launcher's mark, read once and kept: a re-entered call, or one past its
  // budget, can no longer read the environment, and the kill guard's net decides
  // on this instead. Undefined until the first read answers.
  let spawnedMark: string | null | undefined = undefined
  // The last prompt the operator typed in this session, keyed by its id like the memos
  // above: the tier map's guard stands aside when it names the map or a tier.
  let lastTyped: { sessionId: string; text: string; at: string } | null = null
  // The module's tick (moduleTick): armed by a stop a busy agent released or that leaves a pull
  // request of the orchestration open, it stands across the turns until a later stop arms it again.
  const tick: TickMemory = { timer: null, told: new Map(), own: null, busy: [], busyAt: null, watch: false, anomalies: new Set() }
  on('prompt.submit', async ($, e, next) => {
    if (typedByOperator(String(e.origin?.kind ?? ''))) {
      try {
        lastTyped = { sessionId: await $.session.id(), text: String(e.text ?? ''), at: new Date().toISOString() }
      } catch { /* no session id: the guard keeps no word of his, and stays up */ }
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
      try { raw = await $.fs.read(measureFilePath(await configDir($), sessionId, await moduleDir($))) } catch { /* no file yet: unmeasured */ }
      const reading = parseMeasure(String(raw ?? ''))
      // A newer installed commit that changes a file the session runs has the home servers read its
      // conf, once per commit; an orchestrator only once its generation has lived. Only a coordinator
      // is also told to hand over: an orchestrator keeps its version to its context gate, and hands
      // over earlier only when a defect of it blocks the orchestrator (`succession-predecessor.md`).
      // An agent ends at its merge and is not told.
      if (role === 'coordinator' || (role === 'orchestrator' && generationLived(reading, Date.now()))) {
        const newer = await newerInstalled($.plugin.root, (path: string) => $.fs.read(path), memo.toldCommit, Date.now(), memo.announced)
        if (newer && await changesRuntime($, newer)) {
          memo.announced = true
          if (role === 'coordinator') blocks.push(versionAnnouncement(newer, role, root))
          await reloadHomes($, newer)
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

  // The tier map's guard: a session of the orchestration (one whose name gives it a role)
  // that runs a Bash line overwriting the operator's map (a redirection, `tee`, `sed -i`, `mv`,
  // `cp`, `install`, `ln`) is refused: that destroys his bindings with no backup, the deletion
  // class. Unless the last prompt he typed in this session names the map or a tier: then the
  // binding is his word on the point. Mounted before the kill guard, so a Bash call reaches it
  // first; the session's role is read only for a call that writes the map. Never `ask`.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const maps = mapPaths(await stateDir($), await configDir($))
    if (!bashWritesTheMap(String(e['command'] ?? ''), maps)) return next(e)
    const sessionId = await $.session.id()
    if (lastTyped && lastTyped.sessionId === sessionId && namesTheMap(lastTyped.text)) return next(e)
    const { name } = await readName($, await transcriptPathOf($, sessionId), sessionId)
    if (!roleOf(name)) return next(e)                // the operator's own sessions: untouched
    await logLine($, 'guards', 'models guard: a Bash write of the tier map denied')
    return { deny: MODELS_DENY }
  }).catch(async ($, e, next) => {
    // A guard that could not read lets the call through, and the log says why: the map is
    // the operator's file, and a session held on the guard's own failure helps nobody.
    await logLine($, 'guards', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The kill guard. tool.call's input carries the tool's arguments beside the tool's name —
  // `e.command`, never a nested `input` — and the deny the engine documents for
  // the event is `{ deny: reason }`, the decision's own shape already, the
  // matcher keeping it to Bash calls. The same hook watches for the successor's
  // spawn: run without error, it is the hand-over the turn's end reads (supervision.ts).
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
    const decision = killDecision(spawnedMark, command, spawnedMark && command.includes('pkill') ? await ownOf($) : undefined)
    if (decision) return decision
    const out = await next(e)
    if (!e.agentId && isSuccessorSpawn(command) && out && !answered(out).isError && !answered(out).deny) {
      try {
        declarations.handOver(await $.session.id())
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

  // An orchestrator's turn end: the module acts and decides nothing of the stop, which always
  // passes. It arms the tick on the session's busy agents and on its pull requests, shows each
  // idle agent's pull request on its window, and sweeps the checkouts. The classic events carry
  // the settings payload's own fields — the transcript path among them — so the scope is read off
  // the event itself. Every read races one deadline; a read that fails is a log line, and the stop
  // passes all the same.
  on('classic.Stop', async ($, e, next) => {
    // The sweep's one shot, armed once the stop is known an orchestrator's: every exit below
    // calls it before next(e), the catch too. Null until the scope is settled, so a failure
    // before it sweeps nothing.
    let sweepAtStop: (() => Promise<void>) | null = null
    try {
      // A stop another hook already held this turn is re-fired with the marker set: its acts already ran.
      if (e.stop_hook_active) return next(e)
      const sessionId = String(e.session_id ?? '')
      // The scope first, from the session itself: the launcher's listing is a call to
      // the terminal, and every agent's, auditor's and hand-started session would pay it.
      const transcript = String(e.transcript_path ?? '') || await transcriptPathOf($, sessionId)
      // One deadline over the whole handler, the name walk included: its reads are bounded.
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
      if (roleOf(name) !== 'orchestrator') return next(e)
      const state = await dataDir($)
      const root = $.plugin.root   // never $.env: the module's environment has no CLAUDE_PLUGIN_ROOT
      let swept = false
      sweepAtStop = async () => {
        if (swept) return
        swept = true
        await runSweep($, state, root, until)
      }
      // The agents of this orchestrator are the chain entries its own session wrote, still
      // running one by the listing's glyph.
      const rows = listing(await mustRun($, ['bash', launcherOf(root), 'list'], "the launcher's listing", until))
      const chain = await quietly($, () => $.fs.read(chainPath(state, tty)), until, '')
      const owner = await chainOwner($)
      if (!owner) {
        // Without the owner no chain entry is counted, and the log says why no agent of its own was seen.
        await logLine($, 'guards', 'stop gate: ITERM_SESSION_ID is not set: no chain entry is counted')
      }
      const entries = parseChain(String(chain))
      // The ledger lines of this orchestration's records, read once whichever act needs them first.
      let ledgerOnce: ReturnType<typeof ledgerLines> | undefined
      const ledgerOf = async () => {
        if (ledgerOnce !== undefined) return ledgerOnce
        try {
          const own = orchestrationOf(name)
          const records = await ownRecords($, await registeredRecords($, state, sessionId, own, until), own, until)
          ledgerOnce = (await readRecords($, records, until)).flatMap(text => ledgerLines(text))
        } catch (err) {
          await logLine($, 'guards', `stop gate: ledger unread: ${reasonOf(err)}`)
          ledgerOnce = []
        }
        return ledgerOnce
      }
      const hostStatus = await hostStatuses($, entries.filter(entry => entry.owner === owner).map(entry => entry.tty), until)
      const agents = ownAgents(rows, entries, owner, hostStatus)
      // Past its bound in one turn, a busy agent wakes the session at the tick, as a pull request
      // of the orchestration merged, closed or entering the anomaly does.
      const busyNow = agents.filter(agent => agent.state === 'busy')
      tick.own = pid
      if (busyNow.length > 0) {
        tick.busy = busyNow
        tick.busyAt = 0
      }
      tick.watch = (await ledgerOf()).length > 0 || await fileWanted($, state, Date.now())
      if (busyNow.length > 0 || tick.watch) armTick($, tick, 0)
      // What the pull requests read of each idle agent say its window should show (over, or Ready: done).
      const read: { tty: string; pr: { state: string; ready?: boolean | undefined } }[] = []
      for (const agent of agents) {
        if (agent.state !== 'idle') continue
        const got = await pullRequestRead($, agent.tty, until)
        if (!got) continue
        const own = got.own
        // Every pull request the dispatch record entrusts to the agent counts, the branch's among them.
        const others = (await ledgerOf()).filter(line => agentsOf(line).includes(agent.label)
          && !(own !== null && line.pr === Number(own.number) && (own.repo === undefined || own.repo.toLowerCase() === line.repo.toLowerCase())))
        const together = pullRequestsRead([...(own === null ? [] : [own]), ...await Promise.all(others.map(line => otherPullRequestRead($, line.repo, line.pr, until)))])
        if (together) read.push({ tty: agent.tty, pr: together })
      }
      await inTime($, () => showPrStates($, read), until)
      await sweepAtStop()
      return next(e)
    } catch (err) {
      // A read that failed lets the stop pass — one line, already written where it failed;
      // anything else the handler broke on is said here. The stop still sweeps.
      if (!(err instanceof GateUnread)) {
        await logLine($, 'guards', `stop gate: ${reasonOf(err)}`)
      }
      await sweepAtStop?.()
      return next(e)
    }
  }).catch(async ($, e, next) => {
    // The registered net the plan's every-handler rule asks validate to see: the stop is let
    // through, the state dir says why, and next is replay-safe in a catch, called or not.
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
// not retried by every stop that follows it, and in one rename: a link planted at that name
// of the data root is replaced, never written through.
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
    await writeAtomic($, `${stateRoot}/sweep.stamp`, `${Math.floor(Date.now() / 1000)}\n`)
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
      if (line.startsWith('pushed ')) await logLine($, 'guards', `stop gate: sweep pushed ${line.slice('pushed '.length)}`)
    }
    // A checkout whose orchestrator and agent are gone and that cannot go: said once, when its
    // reason is first written on its ledger line.
    for (const line of String(outcome.stderr ?? '').split('\n')) {
      if (line.startsWith('workspace: ledger: ')) await logLine($, 'guards', `stop gate: sweep ${line.slice('workspace: '.length)}`)
    }
    if (outcome.exitCode !== 0) {
      await logLine($, 'guards', `stop gate: sweep error exit ${outcome.exitCode}: ${firstLine(String(outcome.stderr ?? ''))}`)
    }
  } catch { /* the sweep never refuses or delays a stop; its failures are said above */ }
}

// --- the turn end's reads -----------------------------------------------------------------

// A read that cannot be made is one log line and a stop that passes, swept. Time is the same
// failure — every read races what is left of one overall deadline.
class GateUnread extends Error {}

// The turn end's deadline: seconds, the env override the operator keeps, its default beside it.
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

/*
 * The module's tick and its memory: one timer, armed by a stop while an agent is busy or a pull
 * request of the orchestration is open, standing across the turns. `own`: this session's host pid,
 * whose record says whether it is between turns; `busy` and `busyAt`: the busy agents and the instant
 * their next bound falls (busyWake), null when none is; `told`, the bounds told per agent turn;
 * `watch`, whether its pull requests are read at each tick (prWake, every PR_FILE_INTERVAL_MS);
 * `anomalies`, those told in anomaly.
 */
type TickMemory = {
  timer: { cancel(): void } | null; told: Map<string, number>; own: string | null
  busy: readonly OwnAgent[]; busyAt: number | null; watch: boolean; anomalies: Set<string>
}

// The tick armed `delay` ms from now, any timer before it cancelled; a timer no longer the one armed
// reads nothing. A clock that arms nothing is one log line, never a held stop.
function armTick($: Held, memory: TickMemory, delay: number): void {
  memory.timer?.cancel()
  memory.timer = null
  let timer: { cancel(): void } = { cancel: () => undefined }
  let armed: unknown
  try {
    armed = $.clock.after(Math.max(0, delay), () => moduleTick($, memory, timer))
  } catch (err) {
    void logLine($, 'guards', `module tick: not armed: ${reasonOf(err)}`)
    return
  }
  const cancel = typeof armed === 'object' && armed !== null ? (armed as { cancel?: unknown }).cancel : undefined
  if (typeof cancel === 'function') timer = { cancel: () => { Reflect.apply(cancel, armed, []) } }
  memory.timer = timer
}

/*
 * One tick: the busy agents' host records read when their bound is due, a line each for those past a
 * bound not told yet; the pull requests read in the machine's file while watched, a line each for one
 * merged, closed or entering the anomaly. The lines go as one wake, then the ended pull requests'
 * lines are archived and the timer armed again at the next bound or interval. A session in a turn of
 * its own is read again a minute later, its wake kept for the turn's end; a wake the host drops or
 * refuses is told nothing: what it told is restored and tried again a minute later.
 */
async function moduleTick($: Held, memory: TickMemory, timer: unknown): Promise<void> {
  if (memory.timer !== timer) return
  memory.timer = null
  const was = { told: new Map(memory.told), busyAt: memory.busyAt, watch: memory.watch, anomalies: new Set(memory.anomalies) }
  try {
    const config = await configDir($)
    if (memory.own && hostRecordOf(String(await $.fs.read(`${config}/sessions/${memory.own}.json`).catch(() => '')))?.status === 'busy') {
      armTick($, memory, TICK_RETRY_MS)
      return
    }
    const now = Date.now()
    const lines: string[] = []
    if (memory.busyAt !== null && memory.busyAt <= now) {
      const busy = busyWake(await busyAgents($, memory.busy), memory.told, now)
      lines.push(...busy.lines)
      memory.busyAt = busy.next
    }
    let settle = async (): Promise<void> => undefined
    if (memory.watch) {
      const prs = await prWake($, memory.anomalies, now)
      lines.push(...prs.lines)
      memory.watch = prs.watching
      settle = prs.settle
      // The row took new pull requests while no turn ended: the deck and the remote coordinator's row say them now.
      if (prs.moved) await refreshRowAndDeck($, await $.session.id())
    }
    if (lines.length > 0) {
      const taken: unknown = await $.prompt.submit({ text: lines.join('\n') })
      if (typeof taken === 'object' && taken !== null && 'drop' in taken && taken.drop) throw new Error(`the host dropped the wake: ${String(taken.drop)}`)
    }
    await settle()
    const next = Math.min(memory.busyAt ?? Infinity, memory.watch ? now + PR_FILE_INTERVAL_MS : Infinity)
    if (next !== Infinity && memory.timer === null) armTick($, memory, next - now)
  } catch (err) {
    memory.told = was.told
    memory.busyAt = was.busyAt
    memory.watch = was.watch
    memory.anomalies = was.anomalies
    await logLine($, 'guards', `module tick: ${reasonOf(err)}`)
    if (memory.timer === null) armTick($, memory, TICK_RETRY_MS)
  }
}

// The agents still busy, by the host's record of the session on each one's tty (its turn's start):
// local reads only.
async function busyAgents($: Held, agents: readonly OwnAgent[]): Promise<BusyAgent[]> {
  const config = await configDir($)
  const found: BusyAgent[] = []
  for (const agent of agents) {
    const ps = await $.process.run(['ps', '-t', agent.tty.replace(/^\/dev\//, ''), '-o', 'pid='], { timeoutMs: BUSY_READ_MS }).catch(() => null)
    if (!ps || ps.exitCode !== 0) continue
    for (const pid of String(ps.stdout ?? '').split('\n').map(line => line.trim().split(/\s+/)[0] ?? '').filter(pid => /^\d+$/.test(pid))) {
      const record = hostRecordOf(String(await $.fs.read(`${config}/sessions/${pid}.json`).catch(() => '')))
      if (!record?.sessionId || !record.status) continue
      if (record.status === 'busy' && record.since === undefined) await logLine($, 'guards', `busy wake: ${agent.label}'s host record gives no turn start`)
      if (record.status === 'busy' && record.since !== undefined) found.push({ label: agent.label, key: `${record.sessionId} ${record.since}`, since: record.since })
      break
    }
  }
  return found
}
const BUSY_READ_MS = 2000
const TICK_RETRY_MS = 60_000

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

// A read the turn end stands down on: it could not be made, so the stop passes and the log says so.
async function mustRun($: Held, argv: readonly string[], what: string, until: number): Promise<string> {
  const done = await inTime($, () => runUntil($, argv, until), until)
  if (!done || done.exitCode !== 0) {
    await logLine($, 'guards', `stop gate: ${what} unread: ${!done ? 'it did not answer in time' : `it exited ${done.exitCode}`}`)
    throw new GateUnread(what)
  }
  return String(done.stdout ?? '')
}

// pull_request_of()'s reads (stop_gate.py:250-275; the launcher's host_cli_cwd): the
// host process on the agent's tty by the identity rule (hostOn: its record, else its
// basename), that process's working directory, that checkout's branch, then one gh read
// run in that checkout — the only network the turn end pays, for an idle agent alone. Any
// read that fails, or cannot answer in time, is no pull request: its window is left as it is.
// The branch's own pull request (null where the checkout's HEAD is not its head) beside the agent's checkout reads; null when none could be read.
async function pullRequestRead($: Held, tty: string, until: number): Promise<{ own: { number: string; state: string; ready?: boolean; repo?: string } | null } | null> {
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
  const head = await inTime($, () => runUntil($, ['git', '-C', cwd, 'rev-parse', 'HEAD'], until), until)
  const headSha = head && head.exitCode === 0 ? String(head.stdout ?? '').trim() : ''
  // One --json argument, the fields comma-joined: gh reads a second word as a second
  // positional and refuses the call. Run in the agent's checkout, the repository its
  // branch is pushed to.
  const gh = await inTime($, () => runUntil($, ['gh', 'pr', 'view', branch, '--json', 'number,state,labels,url,headRefOid'], until, cwd), until)
  if (!gh || gh.exitCode !== 0) return null
  const own = pullRequestOf(branch, String(gh.stdout ?? ''))
  if (own === null) return null
  // The branch's pull request counts only where the checkout's HEAD is its head: a long-lived branch
  // has moved past an old pull request. Only that read is skipped; the entrusted ones still count.
  if (headSha === '' || headOf(String(gh.stdout ?? '')) !== headSha) return { own: null }
  return { own }
}

// The head commit a pull request's `gh pr view --json headRefOid` answer names, or '' when none.
function headOf(answer: string): string {
  try {
    const pr: unknown = JSON.parse(answer)
    return typeof pr === 'object' && pr !== null && typeof (pr as { headRefOid?: unknown }).headRefOid === 'string' ? (pr as { headRefOid: string }).headRefOid : ''
  } catch {
    return ''
  }
}

// Another pull request entrusted to an agent, read by its repository and number: its state and
// whether it carries Ready. A read that fails or cannot answer in time is none.
async function otherPullRequestRead($: Held, repo: string, pr: number, until: number): Promise<{ state: string; ready?: boolean } | null> {
  const gh = await inTime($, () => runUntil($, ['gh', 'pr', 'view', String(pr), '-R', repo, '--json', 'number,state,labels'], until), until)
  if (!gh || gh.exitCode !== 0) return null
  const read = pullRequestOf(String(pr), String(gh.stdout ?? ''))
  return read === null ? null : { state: read.state, ...(read.ready === undefined ? {} : { ready: read.ready }) }
}

// The records of the session's orchestration (unattended.ts projectRecords), whose ledger lines the
// turn end reads: the session's own register and those another session of the machine registered that
// its orchestration owns, since a successor that never read or wrote its record registered none. A read
// that fails is no record.
// The session's own register is read first, on its own: a scan of the others that does not finish keeps it, said in the log.
async function registeredRecords($: Held, state: string, sessionId: string, own: string | null, until: number): Promise<string[]> {
  const register = await quietly($, () => $.fs.read(recordsRegistryPath(state, sessionId)), until, '')
  const mine = String(register).split('\n').map(line => line.trim()).filter(Boolean)
  const scanned = await quietly<string[] | null>($, () => projectRecords($, state, sessionId, own), until, null)
  if (scanned === null) await logLine($, 'guards', "stop gate: the orchestration's records unread: the session's own register alone is read")
  return scanned ?? mine
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
