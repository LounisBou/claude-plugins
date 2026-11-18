// hooks/close-agent.ts
// The module's close of an agent done with its pull request, an act of the module's tick (ledger.ts prWake),
// never a line asking the orchestrator: read on facts alone, the agent's last turn ended on `status: done`
// (its wait file `delivered`, cleared at its next turn's start), its host idle, its checkout clean with
// nothing unpushed (the facts its delivery line reads, relay.ts), then the launcher's `close`, its checkout
// kept so its session resumes with `spawn --resume` within the hour, and its session's cost on its row
// (`dispatch-record.sh cost`). A close the facts do not allow yet is tried again at a later tick; one they
// refuse is told once.
import { launcherOf } from '../core/orchestration.ts'
import { messageOf, type FsEntry, type Host } from './host.ts'
import { configDir, logLine } from './module-io.ts'
import { parseWaitRecord, storeOf, waitKey } from './supervision.ts'
import { readOr } from './unattended.ts'

type Held = Host<'plugin' | 'env' | 'fs' | 'process'>

// The bound of the launcher's close (its proof waits for the host to leave the process table), and of a read.
export const CLOSE_BOUND_MS = 60_000
const READ_BOUND_MS = 10_000

/** The agent to close: its name, the tty the launcher lists it idle on, its session, and the row its cost goes to. */
export type ToClose = { agent: string; tty: string; session: string; cost?: { record: string; row: number } | undefined }

/**
 * What the close did: `closed`, with why its cost was not recorded (null when it was); `refused`, the facts or the
 * launcher kept it open, told once; `later`, the agent is not done yet or is working, tried again at the next tick.
 */
export type CloseOutcome = { kind: 'closed'; cost: string | null } | { kind: 'refused'; why: string } | { kind: 'later' }

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
const lastLine = (run: { stdout?: unknown; stderr?: unknown }): string =>
  `${String(run.stderr ?? '')}\n${String(run.stdout ?? '')}`.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''

// Whether the checkout is clean with nothing unpushed; the reason it is not otherwise.
async function treeFault($: Held, cwd: string): Promise<string | null> {
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: READ_BOUND_MS, cwd }).catch(() => null)
  const [status, unpushed] = await Promise.all([run(['git', 'status', '--porcelain']), run(['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'])])
  if (status?.exitCode !== 0 || unpushed?.exitCode !== 0) return `its checkout ${cwd} unread`
  const dirty = String(status.stdout ?? '').split('\n').filter(line => line.trim() !== '').length
  const ahead = Number(String(unpushed.stdout ?? '').trim())
  if (dirty === 0 && ahead === 0) return null
  return `tree not clean in ${cwd} (${dirty} paths changed, ${Number.isFinite(ahead) ? ahead : '?'} commits unpushed)`
}

/** Closes the agent when the facts say it is done, idle and clean; its cost recorded once it is closed. */
export async function closeDoneAgent($: Held, a: ToClose): Promise<CloseOutcome> {
  const wait = parseWaitRecord(await readOr($, `${await storeOf($)}/${waitKey(a.session)}`))
  if (wait?.waiting !== 'delivered') return { kind: 'later' }
  const host = await hostOf($, a.session)
  if (host !== null && host.status === 'busy') return { kind: 'later' }
  if (host === null || typeof host.cwd !== 'string' || host.cwd === '') return { kind: 'refused', why: 'its checkout unread (no host record of its session)' }
  const fault = await treeFault($, host.cwd)
  if (fault !== null) return { kind: 'refused', why: fault }
  const closed = await $.process.run(['bash', launcherOf($.plugin.root), 'close', '--tty', a.tty, '--expect-title', a.agent, '--keep-checkout'], { timeoutMs: CLOSE_BOUND_MS })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: messageOf(err) }))
  if (closed.exitCode !== 0) return { kind: 'refused', why: `the launcher's close failed: ${lastLine(closed) || `exit ${closed.exitCode}`}` }
  await logLine($, 'ledger', `closed ${a.agent} on ${a.tty} (session ${a.session})`)
  if (a.cost === undefined) return { kind: 'closed', cost: 'no row of its brief found' }
  const cost = await $.process.run(['bash', `${$.plugin.root}/skills/orchestrator/scripts/dispatch-record.sh`, 'cost', a.cost.record, String(a.cost.row), '--session', a.session], { timeoutMs: READ_BOUND_MS * 6 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: messageOf(err) }))
  return { kind: 'closed', cost: cost.exitCode === 0 ? null : lastLine(cost) || `dispatch-record.sh exited ${cost.exitCode}` }
}
