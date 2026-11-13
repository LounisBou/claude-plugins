// The redaction every stored line goes through, and the scan the export runs before it pushes:
// the same patterns, so what `check` finds is exactly what `append` would have replaced. Pure:
// the values of ~/.env are handed in, never read here.

/** One pattern: its name, written in the replacement, and how it rewrites a text. */
interface Pattern {
  readonly name: string
  readonly apply: (text: string, mark: string) => string
}

/** The secrets of the operator's ~/.env: each key with its value. */
export type EnvSecrets = ReadonlyMap<string, string>

/** A value shorter than this is no secret worth hiding, and hiding it would erase common words. */
export const ENV_VALUE_MIN = 8

/** The identifier fields of an event's top level, held to their shape (and scanned, but for entropy). */
export const IDENTIFIERS: Readonly<Record<string, RegExp>> = {
  v: /^1$/,
  ts: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
  event: /^[a-z_]{1,32}$/,
  session: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  agent: /^[A-Za-z0-9_@.-]{1,80}$/,
  child: /^[A-Za-z0-9_@.-]{1,80}$/,
  turn: /^[A-Za-z0-9_-]{1,80}$/,
  tool_use_id: /^[A-Za-z0-9_-]{1,80}$/,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const byRegex = (name: string, regex: RegExp, keep?: (match: string, ...groups: string[]) => string): Pattern => ({
  name,
  apply: (text, mark) => text.replace(regex, (match: string, ...rest: unknown[]) => (keep ? keep(match, ...rest.filter((x): x is string => typeof x === 'string')) : '') + mark),
})

/** Shannon entropy of `text`, in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Whether a run of token characters looks random enough to be a secret. */
export function isHighEntropy(run: string): boolean {
  if (UUID.test(run)) return false
  const longest = run.split(/[-_.]/).reduce((a, b) => (b.length > a.length ? b : a), '')
  if (longest.length < 20) return false
  const letter = /[A-Za-z]/.test(longest)
  const digit = /[0-9]/.test(longest)
  const both = /[a-z]/.test(longest) && /[A-Z]/.test(longest)
  const bits = entropy(longest)
  return (letter && digit && bits >= 3.5) || (both && bits >= 4.1)
}

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]*`

/** A command-line option that takes a secret: `--password`, `--db-password`, `--token`, `--api-key`... */
const SECRET_FLAG = String.raw`--(?:[A-Za-z0-9]+-)*(?:token|secret|passw(?:or)?d|passwd|pass|api-?key|apikey|private-key|access-key|credentials?)`

/** A mark this redaction left, alone in its quotes: a quoted value already redacted. */
const MARK_ONLY = /^\[REDACTED:[a-z-]+\]$/

/** `KEY="a b c"`, `"client_secret": "x"`: the whole quoted value, its quotes kept. */
const quotedAssignment: Pattern = {
  name: 'secret-assignment',
  apply: (text, mark) => text.replace(
    new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)+"|'[^']+')`, 'gi'),
    (match: string, key: string, sep: string, quoted: string) => (MARK_ONLY.test(quoted.slice(1, -1)) ? match : `${key}${sep}${quoted[0]}${mark}${quoted[0]}`),
  ),
}

/** The patterns that need no knowledge of the machine, in the order they run. */
export const PATTERNS: readonly Pattern[] = [
  byRegex('private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g),
  byRegex('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g),
  byRegex('anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g),
  byRegex('openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g),
  byRegex('aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  byRegex('slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g),
  byRegex('google-key', /\bAIza[0-9A-Za-z_-]{30,}/g),
  byRegex('stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  byRegex('telegram-token', /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g),
  byRegex('npm-token', /\bnpm_[A-Za-z0-9]{30,}/g),
  byRegex('jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  byRegex('authorization', /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+(?:\s+[^\s"',}]+)?/gi, (_m, key, sep) => `${key}${sep}`),
  byRegex('bearer', /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} `),
  byRegex('user-password', /(^|[\s;&|(])(-u\s*|--user(?:\s+|=))(?!\[REDACTED)("[^"]*:[^"]*"|'[^']*:[^']*'|[^\s"'-][^\s"']*:[^\s"']*)/g, (_m, before, flag) => `${before}${flag}`),
  byRegex('url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, (_m, scheme) => scheme),
  byRegex('url-secret', /([?&](?:access_token|token|key|api_key|apikey|secret|password|sig|signature|auth)=)[^&#\s"']+/gi, (_m, key) => key),
  byRegex('secret-flag', new RegExp(String.raw`(${SECRET_FLAG})(\s+|=)(?!\[REDACTED)(?:"[^"]*"|'[^']*'|[^\s"'-][^\s"']*)`, 'gi'), (_m, flag, sep) => `${flag}${sep}`),
  quotedAssignment,
  byRegex('secret-assignment', new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;&|)}]+`, 'gi'), (_m, key, sep) => `${key}${sep}`),
  { name: 'entropy', apply: (text, mark) => text.replace(/[A-Za-z0-9+=_-]{20,}/g, run => (isHighEntropy(run) ? mark : run)) },
]

/** The patterns of the operator's ~/.env: its values, and assignments of its keys. */
export function envPatterns(secrets: EnvSecrets): Pattern[] {
  const values = [...secrets.values()].filter(value => value.length >= ENV_VALUE_MIN).sort((a, b) => b.length - a.length)
  const keys = [...secrets].filter(([key, value]) => value.length >= ENV_VALUE_MIN && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).map(([key]) => key)
  const patterns: Pattern[] = []
  if (values.length > 0) patterns.push(byRegex('env', new RegExp(values.map(escape).join('|'), 'g')))
  if (keys.length > 0) patterns.push(byRegex('env', new RegExp(String.raw`\b(?:${keys.map(escape).join('|')})=(?:"[^"]*"|'[^']*'|[^\s;&|]*)`, 'g')))
  return patterns
}

/**
 * `text` with every secret replaced by `[REDACTED:<pattern>]`, and the names of the patterns that
 * matched. `entropy: false` skips the entropy guess only, for an identifier already held to its
 * shape: a tool call's id is random by nature, a known token shape or an env value still is not.
 */
export function redactText(text: string, secrets: EnvSecrets = new Map(), options: { entropy?: boolean } = {}): { text: string; hits: string[] } {
  const hits: string[] = []
  let out = text
  const patterns = options.entropy === false ? PATTERNS.filter(p => p.name !== 'entropy') : PATTERNS
  for (const pattern of [...envPatterns(secrets), ...patterns]) {
    const next = pattern.apply(out, `[REDACTED:${pattern.name}]`)
    if (next !== out) hits.push(pattern.name)
    out = next
  }
  return { text: out, hits }
}

/**
 * An event with every string redacted, at any depth, and what matched. The identifier fields of
 * the event itself (its top level only) are held to their shape as well; a nested field of the
 * same name is plain text.
 */
export function redactValue(value: unknown, secrets: EnvSecrets): { value: unknown; hits: string[] } {
  return walk(value, secrets, undefined, 0)
}

function walk(value: unknown, secrets: EnvSecrets, key: string | undefined, depth: number): { value: unknown; hits: string[] } {
  if (typeof value === 'string') {
    const shape = depth === 1 && key !== undefined ? IDENTIFIERS[key] : undefined
    if (shape !== undefined && !shape.test(value)) return { value: '[REDACTED:identifier]', hits: ['identifier'] }
    const { text, hits } = redactText(value, secrets, { entropy: shape === undefined })
    return { value: text, hits }
  }
  if (Array.isArray(value)) {
    const hits: string[] = []
    const out = value.map(item => {
      const r = walk(item, secrets, undefined, depth + 1)
      hits.push(...r.hits)
      return r.value
    })
    return { value: out, hits }
  }
  if (typeof value === 'object' && value !== null) {
    const hits: string[] = []
    const out: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(value)) {
      const r = walk(item, secrets, k, depth + 1)
      hits.push(...r.hits)
      out[k] = r.value
    }
    return { value: out, hits }
  }
  return { value, hits: [] }
}

/** The operator's ~/.env read as key and value: `export` and quotes dropped, comments skipped. */
export function parseEnvFile(text: string): Map<string, string> {
  const secrets = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    let value = (match[2] ?? '').trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    secrets.set(key, value)
  }
  return secrets
}
