// What the plugins put in front of a model, measured: the tokens of each plugin's prompt files
// and the sentences said more than once. Both are ratchets held by ci/prompts.json: a budget
// or the duplicate count may fall, never rise (docs/conventions.md, « Prompts »).
//
//   npm run prompts              check against ci/prompts.json
//   npm run prompts -- --lower   rewrite ci/prompts.json down to what is measured (the release runs it)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, PLUGINS_DIR, readPlugins } from './lib/plugins.ts'

export const CEILINGS_PATH = join('ci', 'prompts.json')

/** Files under a plugin that no model reads: for people, for tests, for the record. */
const NOT_PROMPT = [/^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE/, /^docs\//, /^tests\//, /^evals\//, /^trigger-evals\//, /(^|\/)node_modules\//, /(^|\/)\.pytest_cache\//]

/** A sentence shorter than this is a phrase, and phrases may recur. */
const MIN_WORDS = 12

export interface PromptFile {
  readonly plugin: string
  readonly path: string
  readonly text: string
}

export interface Measure {
  readonly tokens: Readonly<Record<string, number>>
  readonly duplicates: readonly Duplicate[]
}

export interface Duplicate {
  readonly sentence: string
  readonly paths: readonly string[]
}

export interface Ceilings {
  readonly budgets: Readonly<Record<string, number>>
  readonly duplicates: number
}

/** The estimate every budget is kept in: stable, cheap, close to a tokenizer for prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function isPromptPath(pathInPlugin: string): boolean {
  return pathInPlugin.endsWith('.md') && !NOT_PROMPT.some(pattern => pattern.test(pathInPlugin))
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .map(sentence => sentence.toLowerCase().replace(/[`*_>#|-]/g, ' ').split(/\s+/).filter(Boolean))
    .filter(words => words.length >= MIN_WORDS)
    .map(words => words.join(' '))
}

export function measure(files: readonly PromptFile[]): Measure {
  const tokens: Record<string, number> = {}
  const seen = new Map<string, string[]>()
  for (const file of files) {
    tokens[file.plugin] = (tokens[file.plugin] ?? 0) + estimateTokens(file.text)
    for (const sentence of sentencesOf(file.text)) {
      const paths = seen.get(sentence) ?? []
      paths.push(file.path)
      seen.set(sentence, paths)
    }
  }
  const duplicates = [...seen].filter(([, paths]) => paths.length > 1).map(([sentence, paths]) => ({ sentence, paths }))
  return { tokens, duplicates }
}

/** One line per ceiling the measure exceeds; empty when every ratchet holds. */
export function breaches(measured: Measure, ceilings: Ceilings): string[] {
  const faults: string[] = []
  for (const [plugin, tokens] of Object.entries(measured.tokens)) {
    const budget = ceilings.budgets[plugin]
    if (budget === undefined) faults.push(`${plugin}: no prompt budget in ${CEILINGS_PATH}`)
    else if (tokens > budget) faults.push(`${plugin}: ${tokens} prompt tokens, over its budget of ${budget}`)
  }
  if (measured.duplicates.length > ceilings.duplicates) {
    faults.push(`${measured.duplicates.length} sentences said more than once, over the ceiling of ${ceilings.duplicates}`)
  }
  return faults
}

/** The ceilings, and the file's authored fields to keep when it is rewritten. */
export function parseCeilings(raw: unknown): { readonly ceilings: Ceilings; readonly authored: Readonly<Record<string, unknown>> } {
  if (!isRecord(raw) || !isRecord(raw['budgets']) || typeof raw['duplicates'] !== 'number') {
    throw new Error(`${CEILINGS_PATH}: expected { "budgets": { <plugin>: <tokens> }, "duplicates": <count> }`)
  }
  const budgets: Record<string, number> = {}
  for (const [plugin, value] of Object.entries(raw['budgets'])) {
    if (typeof value !== 'number') throw new Error(`${CEILINGS_PATH}: budget of "${plugin}" is not a number`)
    budgets[plugin] = value
  }
  return { ceilings: { budgets, duplicates: raw['duplicates'] }, authored: raw }
}

function promptFiles(root: string): PromptFile[] {
  const files: PromptFile[] = []
  for (const { dir } of readPlugins(root)) {
    const base = join(root, PLUGINS_DIR, dir)
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      if (isPromptPath(relative(base, path))) files.push({ plugin: dir, path: relative(root, path), text: readFileSync(path, 'utf8') })
    }
  }
  return files
}

export function run(root: string, args: readonly string[], io: Io): number {
  const lower = args.includes('--lower')
  const measured = measure(promptFiles(root))
  const { ceilings, authored } = parseCeilings(JSON.parse(readFileSync(join(root, CEILINGS_PATH), 'utf8')))
  const faults = breaches(measured, ceilings)
  for (const fault of faults) io.err(fault)
  for (const { sentence, paths } of measured.duplicates) io.out(`said ${paths.length}×: « ${sentence.slice(0, 90)}… » in ${paths.join(', ')}`)
  if (faults.length > 0) return 1
  if (lower) {
    writeFileSync(join(root, CEILINGS_PATH), `${JSON.stringify({ ...authored, budgets: measured.tokens, duplicates: measured.duplicates.length }, null, 2)}\n`)
  }
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
