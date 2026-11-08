// Where the host keeps its configuration and where each plugin keeps its state. An empty
// variable counts as unset everywhere, so no path is ever resolved against the filesystem root.
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Env = Readonly<Record<string, string | undefined>>

/** The value of `name`, or undefined when it is unset or empty. */
export function setting(env: Env, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/** The host's configuration directory: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function configDir(env: Env, home: string = homedir()): string {
  return setting(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude')
}

/** A plugin's own state directory, under the configuration directory. */
export function stateDir(plugin: string, env: Env, home?: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin)) throw new Error(`not a plugin name: ${JSON.stringify(plugin)}`)
  return join(configDir(env, home), plugin)
}
