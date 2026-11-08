// The context simulator: the tokens each scenario of ci/scenarios.json puts in front of a model,
// summed from the prompt files it declares, in the estimate the prompt budgets use. With --base,
// the same scenarios read at another commit, and the difference: what a pull request costs each
// kind of session (program goal 21).
//
//   npm run context                     the table, at the working tree
//   npm run context -- --base <ref>     the table and the difference against <ref>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, PLUGINS_DIR } from './lib/plugins.ts'
import { estimateTokens } from './prompts.ts'

export const SCENARIOS_PATH = join('ci', 'scenarios.json')

export type Scenarios = Readonly<Record<string, readonly string[]>>

export function parseScenarios(raw: unknown): Scenarios {
  const table = isRecord(raw) ? raw['scenarios'] : undefined
  if (!isRecord(table)) throw new Error(`${SCENARIOS_PATH}: expected { "scenarios": { <name>: [<path>] } }`)
  const out: Record<string, readonly string[]> = {}
  for (const [name, paths] of Object.entries(table)) {
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === 'string')) throw new Error(`${SCENARIOS_PATH}: "${name}" lists no paths`)
    out[name] = paths as string[]
  }
  return out
}

/** Each scenario's tokens, or the files it names that `read` cannot find. */
export function simulate(scenarios: Scenarios, read: (path: string) => string | undefined): { tokens: Record<string, number>; missing: string[] } {
  const tokens: Record<string, number> = {}
  const missing: string[] = []
  for (const [name, paths] of Object.entries(scenarios)) {
    let sum = 0
    for (const path of paths) {
      const text = read(path)
      if (text === undefined) missing.push(`${name}: ${path}`)
      else sum += estimateTokens(text)
    }
    tokens[name] = sum
  }
  return { tokens, missing }
}

/** The markdown table: scenario, tokens, and with a base its tokens there and the difference. */
export function table(now: Readonly<Record<string, number>>, base?: Readonly<Record<string, number>>): string[] {
  const rows = base === undefined ? ['| scenario | tokens |', '|---|---:|'] : ['| scenario | tokens | base | difference |', '|---|---:|---:|---:|']
  for (const [name, tokens] of Object.entries(now)) {
    if (base === undefined) { rows.push(`| ${name} | ${tokens} |`); continue }
    const before = base[name]
    const diff = before === undefined ? 'new' : tokens - before === 0 ? '0' : `${tokens - before > 0 ? '+' : ''}${tokens - before}`
    rows.push(`| ${name} | ${tokens} | ${before ?? '—'} | ${diff} |`)
  }
  return rows
}

const readAt = (root: string, ref: string) => (path: string): string | undefined => {
  try {
    return execFileSync('git', ['show', `${ref}:${PLUGINS_DIR}/${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

const readHere = (root: string) => (path: string): string | undefined => {
  try {
    return readFileSync(join(root, PLUGINS_DIR, path), 'utf8')
  } catch {
    return undefined
  }
}

export function run(root: string, args: readonly string[], io: Io): number {
  const scenarios = parseScenarios(JSON.parse(readFileSync(join(root, SCENARIOS_PATH), 'utf8')))
  const now = simulate(scenarios, readHere(root))
  for (const missing of now.missing) io.err(`${SCENARIOS_PATH}: no such prompt file, ${missing}`)
  if (now.missing.length > 0) return 1
  const at = args.indexOf('--base')
  const ref = at >= 0 ? args[at + 1] : undefined
  const base = ref === undefined ? undefined : simulate(scenarios, readAt(root, ref)).tokens
  for (const line of table(now.tokens, base)) io.out(line)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
