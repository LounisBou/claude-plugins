// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The orchestration a session belongs to, read from the host's own record of its sessions: a
// script outside the module (no `$`) asks here. The name shape is names.ts's.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { orchForm, parseSessionName } from './names.ts'
import { configDir, setting, type Env } from './paths.ts'
import { readText } from './store.ts'

/** The host's session records under its configuration directory, one `<pid>.json` each. */
export const HOST_SESSIONS_DIR = 'sessions'

/** A record's `updatedAt` as the comparison reads it: its text, `0` when absent, null or false. */
function stampOf(value: unknown): string {
  if (value === undefined || value === null || value === false) return '0'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const INTEGER = /^-?[0-9]+$/

/** A JSON object's fields, or undefined for any other value. */
function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * The orchestration this session belongs to, as the host's record of the session names it
 * (`<config dir>/sessions/<pid>.json`, the newest record carrying this session id), in orchForm's
 * shape. Empty for a shell outside any session, a session the host kept no record of, and one that
 * is no orchestrator.
 */
export function sessionOrchestration(env: Env): string {
  const session = setting(env, 'CLAUDE_CODE_SESSION_ID')
  if (session === undefined) return ''
  const dir = join(configDir(env, setting(env, 'HOME')), HOST_SESSIONS_DIR)
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return ''
  }
  let newest: { at: string; name: string } | undefined
  for (const file of files) {
    let value: unknown
    try {
      if (!statSync(join(dir, file)).isFile()) continue
      value = JSON.parse(readText(join(dir, file)) ?? '')
    } catch {
      continue
    }
    const record = objectOf(value)
    if (record === undefined) continue
    const name = record['name']
    if (record['sessionId'] !== session || typeof name !== 'string') continue
    const at = stampOf(record['updatedAt'])
    // A stamp that is no integer never keeps the earlier record.
    if (newest !== undefined && INTEGER.test(newest.at) && INTEGER.test(at) && BigInt(newest.at) >= BigInt(at)) continue
    newest = { at, name }
  }
  if (newest === undefined) return ''
  const name = orchForm(newest.name)
  return parseSessionName(name)?.role === 'orchestrator' ? name : ''
}
