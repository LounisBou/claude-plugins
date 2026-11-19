// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The github plugin's `pr-gate` as the orchestrator reads it: the one reading of a pull request's CI, shared by
// ci-watch (which waits on it) and the hooks module (which refreshes it at the tick), so neither carries a copy.
// Pure, with no import: a hooks module imports its own files only.

/** One check the gate counted: its name and bucket (pass, fail, pending, skipping). */
export interface GateCheck { readonly name: string; readonly bucket: string }

/** The gate's reading of CI at a head, as the watch decides on it. */
export interface GateCi {
  /** The repository the gate read, `owner/name`, when it names one. */
  readonly repo?: string
  /** The head the gate read. */
  readonly head: string | undefined
  readonly result: string
  readonly running: number
  readonly unverified: boolean
  readonly failed: readonly string[]
  readonly checks: readonly GateCheck[]
  /** The answer as the gate gave it, for the draft guard's stdin and for the kept file. */
  readonly raw: string
}

/** The gate's JSON answer read; null when it has no CI result. */
export function parseGate(stdout: string): GateCi | null {
  interface Answer { readonly repo?: unknown; readonly head?: unknown; readonly ci?: { readonly result?: unknown; readonly running?: unknown; readonly unverified?: unknown; readonly failed?: unknown; readonly checks?: unknown } }
  let gate: Answer | null = null
  try {
    gate = JSON.parse(stdout) as Answer | null
  } catch {
    return null
  }
  const ci = gate?.ci
  if (typeof ci?.result !== 'string' || typeof ci.running !== 'number') return null
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  const checks = Array.isArray(ci.checks)
    ? (ci.checks as { readonly name?: unknown; readonly bucket?: unknown }[]).flatMap(check => (typeof check?.name === 'string' && typeof check.bucket === 'string' ? [{ name: check.name, bucket: check.bucket }] : []))
    : []
  return {
    ...(typeof gate?.repo === 'string' ? { repo: gate.repo } : {}), head: typeof gate?.head === 'string' ? gate.head : undefined, result: ci.result, running: ci.running,
    unverified: strings(ci.unverified).length > 0, failed: strings(ci.failed), checks, raw: stdout,
  }
}

/** The command that reads the gate of `pr` in `repo`, from the github plugin installed at `root` (its engine). */
export function gateArgv(root: string, repo: string, pr: string): [string, ...string[]] {
  return ['python3', `${root.replace(/\/+$/, '')}/engine/gh.py`, '--repo', repo, 'pr-gate', pr, '--json']
}

/**
 * The command that names, of a draft's failing checks (its `pr-gate` answer on stdin), those that are no draft guard, one a
 * line: `draft-guard.sh` of the orchestrator installed at `root`, the one classification `ci-watch` reads too.
 */
export function draftGuardArgv(root: string, repo: string, pr: string): [string, ...string[]] {
  return ['bash', `${root.replace(/\/+$/, '')}/skills/orchestrator/scripts/draft-guard.sh`, repo, pr]
}
