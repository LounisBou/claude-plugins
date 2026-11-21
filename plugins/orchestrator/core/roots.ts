// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The orchestrator's roots as a script resolves them, with node's fs: the protected root, the data
// root its data-root file names, and the hooks module's own directory. What each holds, and the
// file's format, are orchestration.ts's; a hooks module, which has no node:fs, reads the same file
// through its own `$` (the orchestrator's hooks/module-io.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRootFileOf, dataRootOf, MODULE_DIR } from './orchestration.ts'
import { configDir, setting, stateDir, type Env } from './paths.ts'

export type OrchestratorRoots = {
  /** What runs or is trusted: ORCHESTRATOR_STATE_DIR, else the configuration directory's claude-orchestrator. */
  readonly protectedRoot: string
  /** The data: the directory the protected root's data-root file names, else the protected root. */
  readonly dataRoot: string
  /** The hooks module's own files (store, measure, log): ORCHESTRATOR_MODULE_DIR, else the data root of the configuration directory's claude-orchestrator. */
  readonly moduleDir: string
}

/** The text of a file, or undefined when it cannot be read: an unreadable data-root file names no data root. */
function textOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The hooks module's own directory under the configuration directory `config`: `override` (ORCHESTRATOR_MODULE_DIR) when set, else the data root of `config`'s claude-orchestrator. */
export function moduleDirUnder(config: string, override?: string | null, read: (path: string) => string | undefined = textOr): string {
  if (override) return override
  const own = join(config, MODULE_DIR)
  return dataRootOf(own, read(dataRootFileOf(own)))
}

export function orchestratorRoots(env: Env, home?: string, read: (path: string) => string | undefined = textOr): OrchestratorRoots {
  const protectedRoot = setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir(MODULE_DIR, env, home)
  return {
    protectedRoot,
    dataRoot: dataRootOf(protectedRoot, read(dataRootFileOf(protectedRoot))),
    moduleDir: moduleDirUnder(configDir(env, home), setting(env, 'ORCHESTRATOR_MODULE_DIR'), read),
  }
}
