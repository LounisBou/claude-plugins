// A live Coord, Orch or Audit session whose orchestrator module is not loaded, read from outside it.
// The host runs every plugin's hooks module in one worker; one that stops answering is blamed on a
// plugin, which stays unloaded for the rest of the session while the others come back, and only
// that session's own tab says so. Its transcript keeps what the host announced at each model call:
// `mcp_instructions_delta`, the plugins whose tools the session gained and lost, and
// `deferred_tools_delta`, those still connecting. A session not announced since then reads as before,
// so a loss counts only once the running process has called the model: a resumed one keeps the
// old announcements until its first call.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { currentSessionName, roleOf } from '../../../core/names.ts'
import type { Context } from './context.ts'
import type { Session } from './facts.ts'
import { launcherPath } from './liveness.ts'

const MODULE = 'orchestrator'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function objectOf(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** Whether the transcript's announcements leave the module out, and not among those connecting. */
export function moduleLost(transcript: string): boolean {
  const held = new Set<string>()
  let connecting: readonly string[] = []
  let announced = false
  for (const row of transcript.split('\n')) {
    // A transcript runs to tens of megabytes: only the rows that can be announcements are parsed.
    if (!row.includes('_delta"')) continue
    const entry = objectOf(row)
    const said = entry?.['attachment']
    if (entry?.['type'] !== 'attachment' || entry['isSidechain'] === true || !isObject(said)) continue
    if (said['type'] === 'mcp_instructions_delta') {
      announced = true
      for (const name of names(said['removedNames'])) held.delete(name)
      for (const name of names(said['addedNames'])) held.add(name)
    } else if (said['type'] === 'deferred_tools_delta') connecting = names(said['pendingMcpServers'])
  }
  return announced && !held.has(MODULE) && !connecting.includes(MODULE)
}

/** Whether the main thread's latest model call is dated after `startedAt` (ms); a `<synthetic>` row is the host's own, no call. */
function calledSince(transcript: string, startedAt: number): boolean {
  const rows = transcript.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] ?? ''
    if (!row.includes('"assistant"')) continue
    const entry = objectOf(row)
    const message = entry?.['message']
    if (entry?.['type'] !== 'assistant' || entry['isSidechain'] === true || (isObject(message) && message['model'] === '<synthetic>')) continue
    return Date.parse(String(entry['timestamp'])) > startedAt
  }
  return false
}

/*
 * The launcher builds the line from the running process, so it is read before the operator ends
 * it: a bare resume would drop a spawned session's options, plan, directory and kill-guard mark.
 */
function cureOf(ctx: Context, pid: string, id: string): string {
  const built = ctx.run('bash', [launcherPath(ctx.here), 'resume-line', '--pid', pid])
  const line = built.stdout.trim()
  if (built.status === 0 && line !== '') return `end it, then run: ${line}`
  const why = built.stderr.trim().replace(/^ERROR: /, '') || `exit ${built.status}`
  return `end it, then resume it from its directory with --resume ${id} and the options it was started with (its launch line cannot be read: ${why})`
}

/** The transcript of a session under a configuration directory; undefined before the host wrote one. */
function transcriptOf(config: string, id: string): string | undefined {
  const projects = join(config, 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(projects)
  } catch {
    return undefined
  }
  return dirs.map(dir => join(projects, dir, `${id}.jsonl`)).find(path => statSync(path, { throwIfNoEntry: false }) !== undefined)
}

/**
 * One line per session of those, named `Coord:`, `Orch:` or `Audit:`, whose module is lost, with
 * its cure. The host's record of the session (`sessions/<pid>.json` of its configuration directory)
 * gives its name and its id.
 */
export function lostModuleLines(ctx: Context, sessions: readonly Session[], unread: string[]): string[] {
  const home = ctx.env['HOME'] ?? ''
  const lines: string[] = []
  for (const session of sessions) {
    const config = session.config || (home === '' ? '' : join(home, '.claude'))
    if (config === '') continue
    let record: Json | undefined
    try {
      record = objectOf(readFileSync(join(config, 'sessions', `${session.pid}.json`), 'utf8'))
    } catch {
      continue
    }
    const id = record?.['sessionId']
    if (typeof id !== 'string') continue
    const name = currentSessionName(typeof record?.['name'] === 'string' && record['name'] !== '' ? record['name'] : session.title)
    const role = roleOf(name)
    if (role === null || role === 'agent') continue
    const path = transcriptOf(config, id)
    if (path === undefined) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      unread.push(`module of session ${session.pid}: ${path} cannot be read`)
      continue
    }
    const startedAt = record?.['startedAt']
    if (moduleLost(text) && (typeof startedAt !== 'number' || calledSince(text, startedAt))) {
      lines.push(`module-lost ${name} | session ${id} | pid ${session.pid} | ${session.tty} | its orchestrator module is not loaded: tell the operator; cure: ${cureOf(ctx, session.pid, id)}`)
    }
  }
  return lines
}
