// Where the host installed another plugin, from its own record of installs: a path is never
// built by hand, because an installed version may be a commit rather than a version number.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, setting, type Env } from './paths.ts'
import { readText } from './store.ts'
import { recordedInstallPaths } from './install-record.ts'

export class NotInstalled extends Error {
  /** What to do about it, one command when there is one. */
  readonly fix: string

  constructor(problem: string, fix: string) {
    super(problem)
    this.name = 'NotInstalled'
    this.fix = fix
  }
}

/** The install record the host keeps under its configuration directory. */
export function installRecordPath(env: Env, home?: string): string {
  return join(configDir(env, home), 'plugins', 'installed_plugins.json')
}

/**
 * The directory of `plugin` installed from one of `marketplaces`, in that order of preference.
 * `override`, when set, names an environment variable whose directory wins over the record, for
 * a checkout under development.
 */
export function locatePlugin(plugin: string, marketplaces: readonly string[], env: Env, options: { readonly override?: string; readonly home?: string } = {}): string {
  const install = `/plugin install ${plugin}@${marketplaces[0] ?? 'lounisbou'}`
  const forced = options.override === undefined ? undefined : setting(env, options.override)
  if (forced !== undefined) {
    if (!isDirectory(forced)) throw new NotInstalled(`${options.override} is not a directory: ${forced}`, `unset ${options.override}, or point it at a checkout of the ${plugin} plugin`)
    return forced
  }
  const recordPath = installRecordPath(env, options.home)
  const text = readText(recordPath)
  if (text === undefined) throw new NotInstalled(`no install record at ${recordPath}`, install)
  const recorded = recordedInstallPaths(text, plugin, marketplaces)
  if ('problem' in recorded) throw new NotInstalled(`${recorded.problem}: ${recordPath}`, install)
  const found = recorded.paths.find(isDirectory)
  if (found !== undefined) return found
  throw new NotInstalled(`the ${plugin} plugin is not installed (looked for ${marketplaces.map(m => `${plugin}@${m}`).join(', ')})`, install)
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}
