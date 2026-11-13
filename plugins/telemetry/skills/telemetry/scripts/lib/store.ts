// The local store: one JSON line per event, one file per UTC day, appended under core's lock of
// that file. Nothing reaches a file before it is validated and redacted.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from '../../../../core/store.ts'
import { EVENTS, type Event } from '../../../../hooks/collect.ts'
import { IDENTIFIERS, redactText, redactValue, type EnvSecrets } from './redact.ts'

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export const eventsDir = (stateDir: string): string => join(stateDir, 'events')

/** An event read from outside, or why it is refused. */
export function parseEvent(line: string): Event | string {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return 'not JSON'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object'
  const fields = value as Record<string, unknown>
  if (fields['v'] !== 1) return 'not version 1'
  if (typeof fields['event'] !== 'string' || !(EVENTS as readonly string[]).includes(fields['event'])) return 'unknown event'
  for (const key of ['ts', 'session'] as const) {
    const shape = IDENTIFIERS[key]
    if (typeof fields[key] !== 'string' || shape === undefined || !shape.test(fields[key])) return `bad ${key}`
  }
  return fields as Event
}

/** Appends `lines` (JSON lines) to their day files, redacted; answers how many were written and refused. */
export function append(dir: string, lines: string, secrets: EnvSecrets): { written: number; refused: string[] } {
  const byDay = new Map<string, string[]>()
  const refused: string[] = []
  for (const line of lines.split('\n')) {
    if (line.trim() === '') continue
    const event = parseEvent(line)
    if (typeof event === 'string') {
      refused.push(event)
      continue
    }
    const { value } = redactValue(event, secrets)
    const day = event.ts.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(value)])
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let written = 0
  for (const [day, out] of byDay) {
    const file = join(dir, `${day}.jsonl`)
    withLock(file, () => appendFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 }))
    written += out.length
  }
  return { written, refused }
}

/** The day files of the store, oldest first. */
export function dayFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => DAY_FILE.test(name)).sort()
  } catch {
    return []
  }
}

/** One secret found in a stored line: where, and which pattern; never the value. */
export interface Finding {
  readonly file: string
  readonly line: number
  readonly pattern: string
}

/** Every line of `text` the redaction would still change, or that is no valid event. */
export function scan(file: string, text: string, secrets: EnvSecrets): Finding[] {
  const findings: Finding[] = []
  text.split('\n').forEach((line, index) => {
    if (line === '') return
    const event = parseEvent(line)
    if (typeof event === 'string') {
      const { hits } = redactText(line, secrets)
      findings.push({ file, line: index + 1, pattern: hits[0] ?? `invalid (${event})` })
      return
    }
    const { hits } = redactValue(event, secrets)
    for (const pattern of new Set(hits)) findings.push({ file, line: index + 1, pattern })
  })
  return findings
}

/** The scan of every day file of the store. */
export function check(dir: string, secrets: EnvSecrets): Finding[] {
  return dayFiles(dir).flatMap(name => scan(name, readFileSync(join(dir, name), 'utf8'), secrets))
}
