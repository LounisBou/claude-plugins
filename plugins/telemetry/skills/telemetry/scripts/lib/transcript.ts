// What the host's own transcript already holds about a session, read after the fact: its title,
// efforts, models, token totals, tools and refusals. Nothing of a message's text is kept.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deciderOf, roleOf } from '../../../../hooks/collect.ts'

export interface Summary {
  title?: string | undefined
  role: string
  effort?: string | undefined
  models: string[]
  cwd?: string | undefined
  started?: string | undefined
  ended?: string | undefined
  first_turn_ms?: number | undefined
  totals: { in: number; out: number; cache_read: number; cache_write: number }
  tools: Record<string, number>
  errors: number
  refusals: Record<string, number>
}

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The text a tool result carried, its blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => text(record(block)['text']) ?? '').join(' ')
  return ''
}

/** The summary of a transcript's lines; `spawned` when the session was launched by the orchestrator. */
export function summarize(lines: string, spawned = false): Summary {
  const summary: Summary = { role: 'other', models: [], totals: { in: 0, out: 0, cache_read: 0, cache_write: 0 }, tools: {}, errors: 0, refusals: {} }
  const seen = new Set<string>()
  const models = new Set<string>()
  let firstTs: string | undefined
  let firstAnswer: string | undefined
  for (const line of lines.split('\n')) {
    if (line.trim() === '') continue
    let entry: Fields
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    const ts = text(entry['timestamp'])
    if (ts !== undefined) {
      firstTs ??= ts
      summary.ended = ts
    }
    summary.cwd ??= text(entry['cwd'])
    const type = entry['type']
    if (type === 'custom-title') summary.title = text(entry['customTitle']) ?? summary.title
    if (type === 'assistant') {
      const message = record(entry['message'])
      firstAnswer ??= ts
      summary.effort = text(entry['effort']) ?? summary.effort
      const model = text(message['model'])
      if (model !== undefined && !model.startsWith('<')) models.add(model)
      const id = text(message['id'])
      if (id === undefined || !seen.has(id)) {
        if (id !== undefined) seen.add(id)
        const usage = record(message['usage'])
        summary.totals.in += num(usage['input_tokens'])
        summary.totals.out += num(usage['output_tokens'])
        summary.totals.cache_read += num(usage['cache_read_input_tokens'])
        summary.totals.cache_write += num(usage['cache_creation_input_tokens'])
      }
      const content = message['content']
      if (Array.isArray(content)) {
        for (const block of content.map(record)) {
          const name = text(block['name'])
          if (block['type'] === 'tool_use' && name !== undefined) summary.tools[name] = (summary.tools[name] ?? 0) + 1
        }
      }
    }
    if (type === 'user') {
      const content = record(entry['message'])['content']
      if (!Array.isArray(content)) continue
      for (const block of content.map(record)) {
        if (block['type'] !== 'tool_result' || block['is_error'] !== true) continue
        const decider = deciderOf(resultText(block['content']), undefined)
        if (decider === undefined) summary.errors++
        else summary.refusals[decider] = (summary.refusals[decider] ?? 0) + 1
      }
    }
  }
  summary.models = [...models].sort()
  summary.role = roleOf(summary.title, spawned)
  if (firstTs !== undefined) summary.started = firstTs
  if (firstTs !== undefined && firstAnswer !== undefined) summary.first_turn_ms = Math.max(0, Date.parse(firstAnswer) - Date.parse(firstTs))
  return summary
}

/** The transcript of `session` under the host's projects directory, or undefined. */
export function transcriptOf(config: string, session: string): string | undefined {
  const projects = join(config, 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(projects)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    const path = join(projects, dir, `${session}.jsonl`)
    try {
      if (statSync(path).isFile()) return path
    } catch { /* not in this project */ }
  }
  return undefined
}

/** The summary of the transcript at `path`. */
export function summarizeFile(path: string, spawned = false): Summary {
  return summarize(readFileSync(path, 'utf8'), spawned)
}
