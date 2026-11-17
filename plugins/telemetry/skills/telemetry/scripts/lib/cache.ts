// The API calls of a session, as the host's transcript records them: raw figures and timestamps,
// nothing derived. A turn is the calls under one `promptId` (the host's own `turn_duration` entries
// count the same turns); turns, idle gaps and cold rewrites are read from the calls' times by the
// report. Nothing of a message's text is read or kept.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * One API call as the transcript records it, whole: its ids, model, stop reason, the `usage` object
 * as the host wrote it (every field, future ones included), the names of the tools it used, and when
 * its response's first and last entries were written.
 */
export interface ApiCall {
  readonly prompt: string
  readonly message: string
  readonly request: string | undefined
  readonly model: string | undefined
  stopReason: string | undefined
  readonly start: number
  end: number
  usage: Fields
  tools: string[]
}

/** The two kinds of entry read; a message's own text, escaped inside another entry, never matches. */
const ENTRY = /"type": ?"(?:assistant|user)"/

/**
 * The calls of a transcript's lines, in order. A response written in several entries (one per content
 * block) is one call. A call whose entry has no timestamp, a synthetic answer, a subagent's entry and
 * a call before any prompt are left out.
 */
export function apiCalls(lines: string): ApiCall[] {
  const calls = new Map<string, ApiCall>()
  let prompt: string | undefined
  for (const line of lines.split('\n')) {
    if (!ENTRY.test(line)) continue
    let entry: Fields
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    if (entry['isSidechain'] === true) continue
    if (entry['type'] === 'user') {
      prompt = text(entry['promptId']) ?? prompt
      continue
    }
    if (entry['type'] !== 'assistant' || prompt === undefined) continue
    const at = Date.parse(text(entry['timestamp']) ?? '')
    const message = record(entry['message'])
    const model = text(message['model'])
    if (!Number.isFinite(at) || (model !== undefined && model.startsWith('<'))) continue
    const id = text(message['id']) ?? `${prompt}-${at}`
    const usage = record(message['usage'])
    const stopReason = text(message['stop_reason'])
    const content = Array.isArray(message['content']) ? message['content'].map(record) : []
    // Names only: a tool's inputs and outputs are never read.
    const tools = content.flatMap(block => (block['type'] === 'tool_use' || block['type'] === 'server_tool_use' ? [text(block['name'])] : [])).filter((name): name is string => name !== undefined)
    const seen = calls.get(id)
    if (seen !== undefined) {
      // The host writes one entry per content block of a response, each with the response's usage: the last is the final one.
      seen.end = Math.max(seen.end, at)
      if (Object.keys(usage).length > 0) seen.usage = usage
      seen.stopReason = stopReason ?? seen.stopReason
      seen.tools.push(...tools)
      continue
    }
    calls.set(id, { prompt, message: id, request: text(entry['requestId']), model, stopReason, start: at, end: at, usage, tools })
  }
  return [...calls.values()]
}

/** The fields of an `api_call` event (its `ts` is the call's `start`). */
export function callFields(call: ApiCall): Fields {
  return {
    prompt: call.prompt, message: call.message, request: call.request, model: call.model, stop_reason: call.stopReason, end: new Date(call.end).toISOString(),
    usage: call.usage, ...(call.tools.length > 0 ? { tools: call.tools } : {}),
  }
}

/** The tail read starts at this size and doubles while the turn is not wholly in it. */
export const TAIL_START_BYTES = 256 * 1024
/** A turn longer than this of transcript, blobs included, is not read: its calls stay out rather than cost a long read at each turn's end. */
export const TAIL_MAX_BYTES = 64 * 1024 * 1024
/** The turn that just ended must have ended this long before its `turn_end`, at most. */
export const END_SLACK_BEFORE_MS = 120_000
/** … and this long after it, at most: the transcript and the hook do not share a clock reading. */
export const END_SLACK_AFTER_MS = 5_000

/** The calls of the last turn of `calls` (the trailing run under one prompt), and whether an earlier turn precedes it. */
function lastRun(calls: readonly ApiCall[]): { run: ApiCall[]; earlier: boolean } {
  const last = calls.at(-1)
  if (last === undefined) return { run: [], earlier: false }
  let from = calls.length - 1
  while (from > 0 && calls[from - 1]?.prompt === last.prompt) from--
  return { run: calls.slice(from), earlier: from > 0 }
}

/**
 * The calls of the turn of the transcript at `path` that ended at `endedAt` (the `turn_end`'s time),
 * read from the end of the file: the window widens until it holds the turn's first call, that is,
 * until an earlier turn precedes it or the window is the whole file. A last turn that did not end
 * near `endedAt` (the host had not written it yet, or the turn made no call), or, when `startedAt`
 * is given, that began before the turn did, is not the turn asked for: undefined.
 */
export function lastTurn(path: string, endedAt: number, { startedAt, maxBytes = TAIL_MAX_BYTES }: { startedAt?: number | undefined; maxBytes?: number } = {}): ApiCall[] | undefined {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    for (let window = TAIL_START_BYTES; ; window *= 2) {
      const length = Math.min(size, window)
      const buffer = Buffer.alloc(length)
      const got = readSync(fd, buffer, 0, length, size - length)
      let body = buffer.toString('utf8', 0, got)
      const whole = length === size
      // The window's first line is cut unless the window is the whole file.
      if (!whole) body = body.slice(body.indexOf('\n') + 1)
      const { run, earlier } = lastRun(apiCalls(body))
      if (whole || earlier || window >= maxBytes) {
        const first = run[0]
        if (!(whole || earlier) || first === undefined) return undefined
        const delta = endedAt - Math.max(...run.map(call => call.end))
        if (startedAt !== undefined && first.start < startedAt - END_SLACK_AFTER_MS) return undefined
        return delta >= -END_SLACK_AFTER_MS && delta <= END_SLACK_BEFORE_MS ? run : undefined
      }
    }
  } finally {
    closeSync(fd)
  }
}
