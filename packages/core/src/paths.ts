// Where the host keeps its configuration and where each plugin keeps its state. An empty
// variable counts as unset everywhere, so no path is ever resolved against the filesystem root.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDirOf, type Env } from './env.ts'

export { setting, type Env } from './env.ts'

/** The host's configuration directory: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function configDir(env: Env, home: string = homedir()): string {
  return configDirOf(env, home)
}

/** A plugin's own state directory, under the configuration directory. */
export function stateDir(plugin: string, env: Env, home?: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin)) throw new Error(`not a plugin name: ${JSON.stringify(plugin)}`)
  return join(configDir(env, home), plugin)
}
