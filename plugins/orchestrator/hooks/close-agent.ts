// hooks/close-agent.ts
// The module's close of an agent done with its pull request, an act of the module's tick (ledger.ts prWake),
// never a line asking the orchestrator: read on facts alone, the agent's last turn ended on `status: done`
// (its wait file `delivered`, cleared at its next turn's start) unless its pull request is merged or closed, which
// ends its work whatever its last turn said, its host idle, its checkout clean with nothing unpushed (the facts its delivery line reads, relay.ts); then, once the wake that says it is delivered,
// the launcher's `close`, its clone left in place, unmarked, so its session resumes with `spawn --resume` within the hour, and its
// session's cost on its row (`dispatch-record.sh cost`). A close the facts do not allow yet is tried again at a
// later tick; one they refuse is told once.
import { launcherOf } from '../core/orchestration.ts'
import { messageOf, type FsEntry, type Host } from './host.ts'
import { configDir, logLine } from './module-io.ts'
import { parseWaitRecord, storeOf, waitKey } from './supervision.ts'
import { readOr } from './unattended.ts'

type Held = Host<'plugin' | 'env' | 'fs' | 'process'>

// The bound of the launcher's close (its proof waits for the host to leave the process table), and of a read.
export const CLOSE_BOUND_MS = 60_000
const READ_BOUND_MS = 10_000

/**
 * The agent to close: its name, the tty the launcher lists it idle on, its session, and the row its cost goes to.
 * `ended`: the pull request it is closed for is merged or closed, so its last turn needs no `status: done`.
 */
export type ToClose = { agent: string; tty: string; session: string; cost?: { record: string; row: number } | undefined; ended?: boolean }

/**
 * What the facts allow: `close` now, `refused` with the fact that keeps it open (told once), or `later` with why (tried again);
 * `stuck`, a later that is no work of the agent's (its host busy or unread while its tab is idle), which the module bounds.
 */
export type CloseFacts = { kind: 'close' } | { kind: 'refused'; why: string } | { kind: 'later'; why: string; stuck?: true }

// The host's record of a session (`<config>/sessions/<pid>.json`): its status and the directory it runs in.
async function hostOf($: Held, session: string): Promise<{ status: unknown; cwd: unknown } | null> {
  const dir = `${await configDir($)}/sessions`
  for (const entry of await $.fs.list(dir).catch((): FsEntry[] => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const read = JSON.parse(await readOr($, `${dir}/${entry.name}`)) as Record<string, unknown> | null
      if (read?.['sessionId'] === session) return { status: read['status'], cwd: read['cwd'] }
    } catch {
      continue
    }
  }
  return null
}

// The last line a run printed on stderr, else on stdout.
const lastLine = (run: { stdout?: unknown; stderr?: unknown }): string => {
  const last = (text: unknown) => String(text ?? '').split('\n').map(line => line.trim()).filter(line => line !== '').at(-1)
  return last(run.stderr) ?? last(run.stdout) ?? ''
}

/** What the facts say of closing the agent now: its last turn ended on done (not asked of one whose pull request ended), its host idle, its checkout clean and pushed. */
export async function closeFacts($: Held, a: ToClose): Promise<CloseFacts> {
  const wait = parseWaitRecord(await readOr($, `${await storeOf($)}/${waitKey(a.session)}`))
  if (a.ended !== true && wait?.waiting !== 'delivered') return { kind: 'later', why: `its last turn did not end on done: ${wait?.waiting ?? 'no status'}` }
  const host = await hostOf($, a.session)
  if (host === null || typeof host.cwd !== 'string' || host.cwd === '') return { kind: 'later', why: 'no host record of its session read', stuck: true }
  if (host.status === 'busy') return { kind: 'later', why: 'its host is busy', stuck: true }
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: READ_BOUND_MS, cwd: host.cwd as string }).catch(() => null)
  const [status, unpushed] = await Promise.all([run(['git', 'status', '--porcelain']), run(['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'])])
  if (status?.exitCode !== 0 || unpushed?.exitCode !== 0) return { kind: 'later', why: `its checkout ${host.cwd} unread`, stuck: true }
  const dirty = String(status.stdout ?? '').split('\n').filter(line => line.trim() !== '').length
  const ahead = Number(String(unpushed.stdout ?? '').trim())
  if (dirty === 0 && ahead === 0) return { kind: 'close' }
  return { kind: 'refused', why: `tree not clean in ${host.cwd} (${dirty} paths changed, ${Number.isFinite(ahead) ? ahead : '?'} commits unpushed)` }
}

// The launcher's exit for a close refused on the session's prompt (text the operator typed and has not sent, or a
// prompt it cannot read) or by its close gate, not yet released: nothing was closed, and the close is tried again at a later tick.
export const UNSENT_EXIT = 3

/**
 * Closes the agent and records its cost; `why`, the fact that failed, null when both are done (an agent whose brief names no row is logged);
 * `later`, a close refused on the agent's prompt, tried again. The close waits for no text: one he types to the agent keeps it open, and
 * what he sends is the agent's to answer, never killed while it starts on it.
 */
export async function closeAgent($: Held, a: ToClose): Promise<{ closed: boolean; why: string | null; later?: true }> {
  const closed = await $.process.run(['bash', launcherOf($.plugin.root), 'close', '--tty', a.tty, '--expect-title', a.agent], { timeoutMs: CLOSE_BOUND_MS, env: { ORCHESTRATOR_INPUT_WAIT: '0', ORCHESTRATOR_GATE_WAIT: '0' } })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: messageOf(err) }))
  if (closed.exitCode === UNSENT_EXIT) return { closed: false, why: `left open: ${lastLine(closed) || 'its prompt holds text the operator typed'}`, later: true }
  if (closed.exitCode !== 0) return { closed: false, why: `the launcher's close failed: ${lastLine(closed) || `exit ${closed.exitCode}`}` }
  await logLine($, 'ledger', `closed ${a.agent} on ${a.tty} (session ${a.session})`)
  if (a.cost === undefined) {
    await logLine($, 'ledger', `the cost of ${a.agent} (session ${a.session}) not recorded: no row of its brief found`)
    return { closed: true, why: null }
  }
  const cost = await $.process.run(['bash', `${$.plugin.root}/skills/orchestrator/scripts/dispatch-record.sh`, 'cost', a.cost.record, String(a.cost.row), '--session', a.session], { timeoutMs: READ_BOUND_MS * 6 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: messageOf(err) }))
  return { closed: true, why: cost.exitCode === 0 ? null : `its cost not recorded: ${lastLine(cost) || `dispatch-record.sh exited ${cost.exitCode}`}` }
}
