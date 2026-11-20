// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// A plan's quota as a file: `<orchestrator state>/quota/<accountUuid>.json`. The status line of any
// session writes it from the `rate_limits` of its payload, the only place the host shows the 5-hour
// and 7-day figures; a reader (the coordinator's `facts`) parses it here, never the writer's
// internals. A change of the format raises QUOTA_VERSION.
import { join } from 'node:path'

export const QUOTA_VERSION = 1

/** The quota files' directory under the orchestrator's state directory, one `<account>.json` each. */
export const QUOTA_DIR = 'quota'

/** A reading older than this is stale: no session of the account has refreshed it. */
export const QUOTA_STALE_AFTER_MS = 30 * 60 * 1000

/** A writer rewrites an unchanged reading once this many seconds old, so a live account never reads stale. */
export const QUOTA_REFRESH_SECONDS = 300

/** An account's identifier as a file name: what the host's `oauthAccount.accountUuid` is made of. */
export const ACCOUNT_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/** The data half, for the writer in another language: statusbar's `statusline.sh`. */
export const QUOTA_CONTRACT = {
  version: 1,
  dir: QUOTA_DIR,
  file_version: QUOTA_VERSION,
  refresh_seconds: QUOTA_REFRESH_SECONDS,
} as const

export interface QuotaWindow {
  /** The share of the window used, 0 to 100 and over. */
  readonly used_percentage: number
  /** When the window resets, epoch seconds. */
  readonly resets_at: number
}

export interface Quota {
  readonly version: typeof QUOTA_VERSION
  readonly account: string
  /** The configuration directory of the session that read it: what names the plan. */
  readonly config: string
  readonly five_hour?: QuotaWindow
  readonly seven_day?: QuotaWindow
  /** When it was written, ISO UTC. */
  readonly at: string
}

export function quotaFilePath(state: string, account: string): string {
  return join(state, QUOTA_DIR, `${account}.json`)
}

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined)
const figure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function windowOf(value: unknown): QuotaWindow | undefined | null {
  if (value === undefined) return undefined
  const window = fields(value)
  const used = window?.['used_percentage']
  const resets = window?.['resets_at']
  return figure(used) && figure(resets) ? { used_percentage: used, resets_at: resets } : null
}

/** The quota a parsed file holds, or null when it is no reading: another version, a missing field, no window. */
export function parseQuota(value: unknown): Quota | null {
  const record = fields(value)
  if (record === undefined || record['version'] !== QUOTA_VERSION) return null
  const account = record['account']
  const config = record['config']
  const at = record['at']
  if (typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) return null
  if (typeof config !== 'string' || config === '') return null
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null
  const five = windowOf(record['five_hour'])
  const seven = windowOf(record['seven_day'])
  if (five === null || seven === null || (five === undefined && seven === undefined)) return null
  return { version: QUOTA_VERSION, account, config, at, ...(five ? { five_hour: five } : {}), ...(seven ? { seven_day: seven } : {}) }
}

/** The plan a configuration directory is: `plan1` for `~/.claude`, `plan2` for `~/.claude-bis`, any other by its path. */
export function planOfConfig(config: string, home: string): string {
  const path = config.replace(/\/+$/, '')
  if (path === `${home}/.claude`) return 'plan1'
  if (path === `${home}/.claude-bis`) return 'plan2'
  return path
}

/** Whether a reading is stale at `now` (epoch milliseconds). */
export function isStale(quota: Quota, now: number): boolean {
  return now - Date.parse(quota.at) > QUOTA_STALE_AFTER_MS
}

const share = (window: QuotaWindow | undefined): string => (window === undefined ? '-' : `${Math.round(window.used_percentage)}%`)

/** `quota <plan> | 5h <n>% | 7d <n>% | read <UTC time>`, with ` (stale)` after the time when no session has refreshed it. */
export function quotaLine(quota: Quota, home: string, now: number): string {
  const read = `${new Date(quota.at).toISOString().slice(0, 19)}Z`
  return `quota ${planOfConfig(quota.config, home)} | 5h ${share(quota.five_hour)} | 7d ${share(quota.seven_day)} | read ${read}${isStale(quota, now) ? ' (stale)' : ''}`
}
