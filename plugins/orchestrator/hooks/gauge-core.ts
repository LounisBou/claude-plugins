// hooks/gauge-core.ts
// The measurement rules, pure, with no host API in reach so the boundaries stay testable. The
// measure file's shape and path and the gate are core's (orchestration.ts), read here.
import { deployedAt, installedOver, parseDeployState } from '../core/deploy-state.ts'
import type { MeasureStart } from '../core/orchestration.ts'

export { hasFigures, measureFilePath, parseMeasure, tripGate, type MeasureReading, type MeasureStart } from '../core/orchestration.ts'

// The start a measure carries: the one the session already holds, else this measure's own.
export function startOf(
  kept: MeasureStart | null | undefined,
  reading: { context_tokens: number; updated_at: string },
  brief: { path: string; bytes: number | null } | null,
): MeasureStart {
  return kept ?? { tokens: reading.context_tokens, at: reading.updated_at, brief: brief?.path ?? null, brief_bytes: brief?.bytes ?? null }
}

// A commit installed over the one this session runs, not yet told to it.
export interface Newer {
  readonly own: string
  readonly installed: string
}

// The commit the continuous deploy installed since this session loaded its plugin, once per
// commit: `told` is the last one said. Null when the plugin does not run from a deploy directory,
// when the installed commit is the session's own or was already told, and when the state file
// cannot be read or is not valid — a notice that cannot be decided is not given.
/*
 * A newer install is told only once no other has followed it for this long: while main keeps merging,
 * the deploy installs a commit every few minutes, and a notice on each would make an orchestration
 * spend its time handing over.
 */
export const NOTICE_SETTLE_MS = 30 * 60_000

export async function newerInstalled(root: string, read: (path: string) => Promise<string>, told: string | null, now: number = Date.now()): Promise<Newer | null> {
  try {
    const deployed = deployedAt(root)
    if (deployed === null) return null
    const state = parseDeployState(await read(deployed.state))
    const installed = installedOver(deployed.commit, state)
    if (installed === null || installed === told) return null
    const at = Date.parse(state.history[0]!.at)
    if (!Number.isFinite(at) || now - at < NOTICE_SETTLE_MS) return null
    return { own: deployed.commit, installed }
  } catch {
    return null
  }
}
