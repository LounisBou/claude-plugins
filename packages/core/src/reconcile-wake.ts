// The reconciler's wake (pr-reconcile.ts): a producer that has written a pull request record touches
// the edge marker beside the readings, so the reconciler lists its repositories at its next tick
// rather than at the one after. Nothing is read back: a wake that fails costs the reconciler's
// periodic tick its promptness and nothing else, the record being written already. The marker's
// directory is the reconciler's own, made by its first reading; until then the wake is a no-op.
import { configDirOf } from './env.ts'
import type { Host } from './host.ts'
import { reconcileEdgePath } from './pr-reconcile.ts'

/** Touches the reconciler's edge marker in the configuration directory. */
export async function wakeReconciler($: Host<'env' | 'fs'>): Promise<void> {
  try {
    const named = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = await $.env.get('HOME')
    if (!named && !home) return
    await $.fs.write(reconcileEdgePath(configDirOf({ CLAUDE_CONFIG_DIR: named }, home ?? '')), '\n')
  } catch {
    // Not woken: the reconciler lists at its periodic tick all the same.
  }
}
