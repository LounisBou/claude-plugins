// What the host's transcript holds of the prompt cache, call by call: each turn's first API call (the
// one that pays a cold rewrite after an idle gap, where the calls after it are warm and drown it in
// the turn's sum), the time since the session's previous call, and how its writes split by TTL.
// A turn is the run of calls under one `promptId`: the host's own `turn_duration` entries count the
// same turns. Nothing of a message's text is read or kept.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** One API call: its tokens as the host counted them, its writes by cache TTL, when its response began and ended. */
export interface CacheCall {
  readonly start: number
  end: number
  in: number
  out: number
  cache_read: number
  cache_write: number
  write_1h: number
  write_5m: number
}

/** One turn: its first call, the idle gap before it, and when its last call ended. */
export interface CacheTurn {
  readonly prompt: string
  readonly first: CacheCall
  /** From the end of the session's previous call to the start of this turn's first; absent for the session's first call. */
  readonly idleMs: number | undefined
  end: number
}

/** The two kinds of entry read; a message's own text, escaped inside another entry, never matches. */
const ENTRY = /"type": ?"(?:assistant|user)"/

/** The turns of a transcript's lines, in order. A call whose entry has no timestamp, a synthetic answer and a subagent's entry are left out. */
export function cacheTurns(lines: string): CacheTurn[] {
  const turns: CacheTurn[] = []
  const calls = new Map<string, CacheCall>()
  let prompt: string | undefined
  let previous: CacheCall | undefined
  let current: CacheTurn | undefined
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
    const id = text(message['id']) ?? `${prompt}:${at}`
    const usage = record(message['usage'])
    const ttl = record(usage['cache_creation'])
    const seen = calls.get(id)
    if (seen !== undefined) {
      // The host writes one entry per content block of a response, each with the response's usage.
      seen.end = Math.max(seen.end, at)
      seen.out = Math.max(seen.out, num(usage['output_tokens']))
      if (current !== undefined) current.end = Math.max(current.end, at)
      continue
    }
    const call: CacheCall = {
      start: at, end: at, in: num(usage['input_tokens']), out: num(usage['output_tokens']), cache_read: num(usage['cache_read_input_tokens']),
      cache_write: num(usage['cache_creation_input_tokens']), write_1h: num(ttl['ephemeral_1h_input_tokens']), write_5m: num(ttl['ephemeral_5m_input_tokens']),
    }
    calls.set(id, call)
    if (current !== undefined && current.prompt === prompt) current.end = Math.max(current.end, at)
    else {
      current = { prompt, first: call, idleMs: previous === undefined ? undefined : Math.max(0, at - previous.end), end: at }
      turns.push(current)
    }
    previous = call
  }
  return turns
}

/** The fields a `turn_end` carries of its turn: the first call's counts and writes by TTL, and the idle gap before it. */
export function cacheFields(turn: CacheTurn): Fields {
  const { first } = turn
  return {
    first_call: { in: first.in, out: first.out, cache_read: first.cache_read, cache_write: first.cache_write, write_1h: first.write_1h, write_5m: first.write_5m },
    ...(turn.idleMs === undefined ? {} : { idle_ms: turn.idleMs }),
  }
}

/** The tail read starts at this size and doubles while the turn and the call before it are not both in it. */
export const TAIL_START_BYTES = 256 * 1024
/** A turn longer than this of transcript, blobs included, is not read: its fields stay out rather than cost a long read at each turn's end. */
export const TAIL_MAX_BYTES = 64 * 1024 * 1024
/** The turn that just ended must have ended this long before its `turn_end`, at most. */
export const END_SLACK_BEFORE_MS = 120_000
/** … and this long after it, at most: the transcript and the hook do not share a clock reading. */
export const END_SLACK_AFTER_MS = 5_000

/**
 * The turn of the transcript at `path` that ended at `endedAt` (the `turn_end`'s time), read from the
 * end of the file: it widens its window until it holds the turn's first call and the call before it,
 * or the file's start. A last turn that did not end near `endedAt` (the host had not written it yet,
 * or the turn made no call) is not the turn asked for: undefined.
 */
export function lastTurn(path: string, endedAt: number): CacheTurn | undefined {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    for (let window = TAIL_START_BYTES; ; window *= 2) {
      const length = Math.min(size, window)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      let body = buffer.toString('utf8')
      const whole = length === size
      // The window's first line is cut unless the window is the whole file.
      if (!whole) body = body.slice(body.indexOf('\n') + 1)
      const turns = cacheTurns(body)
      const last = turns.at(-1)
      // A first turn of the window is cut unless the window is the whole file; its idle gap needs the call before it.
      const complete = whole || turns.length >= 2
      if (complete || window >= TAIL_MAX_BYTES) {
        if (!complete || last === undefined) return undefined
        const delta = endedAt - last.end
        return delta >= -END_SLACK_AFTER_MS && delta <= END_SLACK_BEFORE_MS ? last : undefined
      }
    }
  } finally {
    closeSync(fd)
  }
}
