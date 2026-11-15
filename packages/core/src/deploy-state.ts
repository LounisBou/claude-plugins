// The continuous deploy's state (`installed.json`), written by `scripts/deploy.ts` and read by a
// running session to learn that a newer commit is installed. Pure, with no import: a hooks module
// reads the file through its host.

/** The catalogue's name (`.claude-plugin/marketplace.json`), which the host keys installs by. */
export const DEPLOY_MARKETPLACE = 'lounisbou'
/** Under the host's configuration directory: `<marketplace>/<sha>/`, `installed.json`, `current`. */
export const DEPLOYS_DIR = 'deploys'
export const DEPLOY_STATE_FILE = 'installed.json'
export const DEPLOY_STATE_VERSION = 1
const SHA = /^[0-9a-f]{40}$/

export interface Installed {
  readonly commit: string
  /** ISO time of the install. */
  readonly at: string
}

/** The last run that failed: when, and its error in one line. */
export interface DeployFailure {
  readonly at: string
  readonly message: string
}

export interface DeployState {
  readonly version: typeof DEPLOY_STATE_VERSION
  readonly repo: string
  readonly marketplace: string
  /** Newest first; the first is the installed commit. */
  readonly history: readonly Installed[]
  /** Commits left by a rollback, never deployed again. */
  readonly skipped: readonly string[]
  /** Plugins of the marketplace still to update to the installed commit (an update failed). */
  readonly pending: boolean
  /** Each plugin's version at the installed commit, stamped. */
  readonly plugins: Readonly<Record<string, string>>
  /** The last run's failure, until a run succeeds. */
  readonly lastError?: DeployFailure
}

function installedOf(value: unknown): Installed {
  if (!isRecord(value) || typeof value['commit'] !== 'string' || !SHA.test(value['commit']) || typeof value['at'] !== 'string') {
    throw new Error('installed.json: a history entry is not {commit, at}')
  }
  return { commit: value['commit'], at: value['at'] }
}

/** The state file's text validated, or an error naming what is wrong. */
export function parseDeployState(text: string): DeployState {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || raw['version'] !== DEPLOY_STATE_VERSION) throw new Error(`installed.json: not version ${DEPLOY_STATE_VERSION}`)
  const { repo, marketplace, history, skipped, pending, plugins, lastError } = raw
  if (typeof repo !== 'string' || marketplace !== DEPLOY_MARKETPLACE) throw new Error(`installed.json: no repo, or a marketplace other than ${DEPLOY_MARKETPLACE}`)
  if (!Array.isArray(history) || history.length === 0) throw new Error('installed.json: no history')
  if (typeof pending !== 'boolean') throw new Error('installed.json: pending is not a boolean')
  if (!Array.isArray(skipped) || !skipped.every(sha => typeof sha === 'string' && SHA.test(sha))) throw new Error('installed.json: skipped is not a list of commits')
  if (!isRecord(plugins) || !Object.values(plugins).every(version => typeof version === 'string')) throw new Error('installed.json: plugins is not {name: version}')
  if (lastError !== undefined && (!isRecord(lastError) || typeof lastError['at'] !== 'string' || typeof lastError['message'] !== 'string')) throw new Error('installed.json: lastError is not {at, message}')
  return {
    version: DEPLOY_STATE_VERSION,
    repo,
    marketplace,
    history: history.map(installedOf),
    skipped: skipped.filter((sha): sha is string => typeof sha === 'string'),
    pending,
    plugins: Object.fromEntries(Object.entries(plugins).map(([name, version]) => [name, String(version)])),
    ...(lastError === undefined ? {} : { lastError: { at: String(lastError['at']), message: String(lastError['message']) } }),
  }
}

/** A plugin that runs from a deployed commit: the commit, and the state file beside its directory. */
export interface Deployed {
  readonly commit: string
  readonly state: string
}

const DEPLOYED = new RegExp(`^(.*/${DEPLOYS_DIR}/${DEPLOY_MARKETPLACE})/([0-9a-f]{40})(?:/|$)`)

/**
 * The deployed commit a plugin's own root directory lies in, with the path of the state file;
 * null when the plugin does not run from a deploy directory (a marketplace install, a checkout).
 */
export function deployedAt(pluginRoot: string): Deployed | null {
  const found = DEPLOYED.exec(pluginRoot.replaceAll('\\', '/'))
  return found === null ? null : { commit: found[2]!, state: `${found[1]}/${DEPLOY_STATE_FILE}` }
}

/**
 * The installed commit when it is another than `own` and a new session would run it (no plugin
 * update pending); null otherwise.
 */
export function installedOver(own: string, state: DeployState): string | null {
  const installed = state.history[0]!.commit
  return installed === own || state.pending ? null : installed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
