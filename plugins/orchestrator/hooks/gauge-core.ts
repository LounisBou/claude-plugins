// hooks/gauge-core.ts
// The measurement rules, pure, with no host API in reach so the boundaries stay testable. The
// measure file's shape and path and the gate are core's (orchestration.ts), read here.
import { deployedAt, installedOver, parseDeployState } from '../core/deploy-state.ts'
import { launcherOf, type MeasureStart } from '../core/orchestration.ts'

export { hasFigures, measureFilePath, parseMeasure, tripGate, type MeasureReading, type MeasureStart } from '../core/orchestration.ts'

// The start a measure carries: the one the session already holds, else this measure's own.
export function startOf(
  kept: MeasureStart | null | undefined,
  reading: { context_tokens: number; updated_at: string },
  brief: { path: string; bytes: number | null } | null,
): MeasureStart {
  return kept ?? { tokens: reading.context_tokens, at: reading.updated_at, brief: brief?.path ?? null, brief_bytes: brief?.bytes ?? null }
}

// A commit installed over the one this session runs, not yet told to it, with the directories both
// commits were extracted into.
export interface Newer {
  readonly own: string
  readonly installed: string
  readonly ownDir: string
  readonly installedDir: string
}

/*
 * A newer install is told only once no other has followed it for this long: while main keeps merging,
 * the deploy installs a commit every few minutes, and a notice on each would make an orchestration
 * spend its time handing over.
 */
export const NOTICE_SETTLE_MS = 30 * 60_000
/*
 * Or, once, when the session's own install is this much older than the installed one: a main that
 * never stops merging would otherwise keep the settle from ever passing.
 */
export const NOTICE_CAP_MS = 60 * 60_000

// The commit the continuous deploy installed since this session loaded its plugin, once per
// commit: `told` is the last one decided. `announced` says whether a notice was already given:
// the cap is said once. Null when the plugin does not run from a deploy directory, when the
// installed commit is the session's own or was already decided, when neither the settle nor the
// cap has passed, and when the state file cannot be read or is not valid — a notice that cannot be
// decided is not given.
export async function newerInstalled(
  root: string, read: (path: string) => Promise<string>, told: string | null, now: number = Date.now(), announced = false,
): Promise<Newer | null> {
  try {
    const deployed = deployedAt(root)
    if (deployed === null) return null
    const state = parseDeployState(await read(deployed.state))
    const installed = installedOver(deployed.commit, state)
    if (installed === null || installed === told) return null
    const at = Date.parse(state.history[0]!.at)
    if (!Number.isFinite(at)) return null
    const settled = now - at >= NOTICE_SETTLE_MS
    const ownAt = Date.parse(state.history.find(entry => entry.commit === deployed.commit)?.at ?? '')
    const capped = !announced && Number.isFinite(ownAt) && at - ownAt > NOTICE_CAP_MS
    if (!settled && !capped) return null
    const base = deployed.state.slice(0, deployed.state.lastIndexOf('/'))
    return { own: deployed.commit, installed, ownDir: `${base}/${deployed.commit}`, installedDir: `${base}/${installed}` }
  } catch {
    return null
  }
}

/*
 * The installed commit's own launcher, asked to have every live home server read that commit's tmux
 * conf: the session's older launcher would read its own conf again.
 */
export function homeReloadArgv(newer: Newer): string[] {
  return [launcherOf(`${newer.installedDir}/plugins/orchestrator`), 'home-reload']
}

// The directories of a plugin that run in a session; a path under `tests`, `docs`, `ci` or `evals`
// never does, wherever it lies.
export const RUNTIME_DIRS: ReadonlySet<string> = new Set(['hooks', 'skills', 'scripts', 'templates', 'engine', 'commands', 'agents', 'core'])
const NOT_RUNTIME: readonly string[] = ['tests', 'docs', 'ci', 'evals']

// The comparison of the two commits' plugin trees, the parts that never run left out.
export function runtimeDiffArgv(newer: Newer): string[] {
  return ['diff', '-rq', ...NOT_RUNTIME.flatMap(name => ['-x', name]), '-x', '.claude-plugin', `${newer.ownDir}/plugins`, `${newer.installedDir}/plugins`]
}

/*
 * The runtime files the installed commit changes in a plugin the session loaded, from `diff -rq`'s
 * lines over both commits' `plugins` directories: `<plugin>/<dir>/...`. A plugin only the installed
 * commit has was not loaded; `loaded` null takes every plugin of the session's own commit.
 */
export function runtimeChanges(out: string, newer: Newer, loaded: ReadonlySet<string> | null): string[] {
  const prefixes = [`${newer.ownDir}/plugins/`, `${newer.installedDir}/plugins/`]
  const changed: string[] = []
  for (const line of out.split('\n')) {
    const only = /^Only in (.+?): (.+)$/.exec(line)
    let path: string
    if (only !== null) {
      const dir = `${only[1]!.replace(/\/+$/, '')}/`
      const prefix = prefixes.find(p => dir.startsWith(p))
      if (prefix === undefined) continue
      path = `${dir.slice(prefix.length)}${only[2]}`
    } else {
      const at = line.indexOf(prefixes[0]!)
      if (at < 0) continue
      const rest = line.slice(at + prefixes[0]!.length)
      path = rest.slice(0, rest.search(/ |$/))
    }
    const [plugin, dir, ...more] = path.split('/')
    if (plugin === undefined || dir === undefined) continue      // a whole plugin added or removed: none loaded
    if (loaded !== null && !loaded.has(plugin)) continue
    if (!RUNTIME_DIRS.has(dir) || [dir, ...more].some(part => NOT_RUNTIME.includes(part))) continue
    changed.push(path)
  }
  return changed
}

/*
 * An orchestrator's generation is told of a newer install only once it has lived: run this long, or
 * held this much context. A younger one keeps its code; a defect fix it needs reaches it by an
 * explicit message.
 */
export const GENERATION_LIVED_MS = 2 * 3_600_000
export const GENERATION_LIVED_TOKENS = 150_000

export function generationLived(reading: { context_tokens: number; start?: MeasureStart } | null, now: number): boolean {
  if (reading === null) return false
  if (reading.context_tokens >= GENERATION_LIVED_TOKENS) return true
  const started = Date.parse(reading.start?.at ?? '')
  return Number.isFinite(started) && now - started >= GENERATION_LIVED_MS
}
