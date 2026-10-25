// hooks/short-commands.ts
// The short names' user commands kept on the installed version. The installer writes each as a
// copy of its plugin command with the plugin root spelled out (short-commands.sh); a plugin
// update without the installer leaves them naming the earlier version's root, whose body the
// host keeps and would still run. At each session start the module runs the writer's own
// `sync`, which rewrites the copies marked as this plugin's that differ from what this version
// would write: never an unmarked file, never one the operator removed.
//
// Only from an installed plugin, under the config dir's plugins/: a session that loads a
// checkout (a test, a development host) would otherwise point the operator's commands at a
// directory that may be gone tomorrow. The override (ORCHESTRATOR_COMMANDS_DIR) names a
// directory the caller chose, and is synced from any root. The run is bounded, a failure is
// logged, and the start goes on either way.
import { logArgv, LOG_TIMEOUT_MS } from './module-log.ts'
import { commandsDirOf } from './short-names.ts'
import { withDeadline, isDegradedPass } from './stop-gate.ts'

export const SYNC_TIMEOUT_MS = 5000
export const START_BOUND_MS = 1500
// What the timeout's own log line may add: the log run is bounded too, the start goes on without it.
const TIMEOUT_LOG_MS = 500

// The whole start step's bound: the host's start budget when it is smaller, else 1500 ms.
export function startBoundMs(remainingMs: number | undefined): number {
  return Math.min(START_BOUND_MS, remainingMs ?? START_BOUND_MS)
}

// The writer's argv, or null where the start has nothing to sync from this root.
export function syncArgv(root: string, configDir: string, override: string | undefined): string[] | null {
  if (!override && !root.startsWith(`${configDir}/plugins/`)) return null
  return ['bash', `${root}/short-commands.sh`, 'sync', '--dir', commandsDirOf(override, configDir)]
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  on('session.start', {}, async ($: any, e: any, next: any) => {
    const bound = startBoundMs(next.budget?.remainingMs)
    try {
      const done = await withDeadline(sync($), bound)
      if (isDegradedPass(done)) await withDeadline(logLine($, `short commands not synced: did not finish within ${bound} ms`), TIMEOUT_LOG_MS)
    } catch (err) {
      await logLine($, `short commands not synced: ${(err as Error).message}`)
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    await logLine($, `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}

// The sync itself, and its failure's log line: all of it under the start's one bound.
async function sync($: any): Promise<void> {
  const argv = syncArgv($.plugin.root, await configDir($), await $.env.get('ORCHESTRATOR_COMMANDS_DIR'))
  if (!argv) return
  const done = await $.process.run(argv, { timeoutMs: SYNC_TIMEOUT_MS })
  if (done.exitCode !== 0) await logLine($, `short commands not synced (exit ${done.exitCode}): ${String(done.stderr ?? '').trim()}`)
}

// The config dir, this file's own resolution: $ never crosses an import.
async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
}

// One line appended to the module's log (module-log.ts). Never throws, never blocks the start.
async function logLine($: any, message: string): Promise<void> {
  try {
    const config = await configDir($)
    await $.process.run(logArgv($.plugin.root, config, 'short-commands', message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR')), { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the start */ }
}
