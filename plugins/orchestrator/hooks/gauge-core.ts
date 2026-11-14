// hooks/gauge-core.ts
// The measurement rules, pure, with no host API in reach so the boundaries stay testable. The
// measure file's shape and path and the gate are core's (orchestration.ts), read here.
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
