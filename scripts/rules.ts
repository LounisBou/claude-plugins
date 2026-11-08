// The rules a prompt states that neither code enforces nor an eval names (program goal 22): a
// report, never a gate. A rule is an imperative line of a prompt file (NEVER, Never, Do not,
// Don't, Always, Only, MUST). It counts as held when one of its terms in backticks — a command,
// a flag, a path, a word the code matches — appears in its plugin's code or tests (held by code)
// or in its evals (named by an eval). What is left rests on prose alone: a candidate for a guard,
// an eval, or removal.
//
//   npm run rules                 one line per plugin, then the rules left, by file
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, PLUGINS_DIR } from './lib/plugins.ts'
import { isPromptPath } from './prompts.ts'

const RULE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?(NEVER|Never|Do not|Don't|Always|ALWAYS|Only|ONLY|MUST)\b/
const TERM = /`([^`\n]{3,80})`/g
const CODE = /\.(ts|py|sh|js|json)$/

export interface Rule {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly terms: readonly string[]
}

/** The rules of a prompt's text, with the terms in backticks each one names. */
export function rulesOf(file: string, text: string): Rule[] {
  const rules: Rule[] = []
  // An Iron Rule block is fenced; a fenced line counts too, since a rule starts with its verb.
  text.split('\n').forEach((line, i) => {
    if (!RULE.test(line)) return
    const terms = [...line.matchAll(TERM)].map(m => (m[1] ?? '').trim()).filter(t => t.length >= 3)
    rules.push({ file, line: i + 1, text: line.trim(), terms })
  })
  return rules
}

/** Whether some term of the rule appears in `corpus`. A rule naming no term is never held. */
export const isHeld = (rule: Rule, corpus: string): boolean => rule.terms.some(term => corpus.includes(term))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'core' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

export interface Report {
  readonly plugin: string
  readonly rules: number
  readonly byCode: number
  readonly byEval: number
  readonly left: readonly Rule[]
}

export function report(root: string): Report[] {
  const plugins = readdirSync(join(root, PLUGINS_DIR), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  return plugins.map(plugin => {
    const base = join(root, PLUGINS_DIR, plugin)
    const files = walk(base).map(path => relative(base, path))
    const rules = files.filter(isPromptPath).flatMap(file => rulesOf(file, readFileSync(join(base, file), 'utf8')))
    const code = files.filter(f => CODE.test(f) && !f.startsWith(`evals${sep}`)).map(f => readFileSync(join(base, f), 'utf8')).join('\n')
    const evals = files.filter(f => f.startsWith(`evals${sep}`)).map(f => readFileSync(join(base, f), 'utf8')).join('\n')
    let byCode = 0
    let byEval = 0
    const left: Rule[] = []
    for (const rule of rules) {
      if (isHeld(rule, code)) byCode++
      else if (isHeld(rule, evals)) byEval++
      else left.push(rule)
    }
    return { plugin, rules: rules.length, byCode, byEval, left }
  })
}

export function run(root: string, _args: readonly string[], io: Io): number {
  const reports = report(root)
  io.out('| plugin | rules | held by code | named by an eval | prose alone |')
  io.out('|---|---:|---:|---:|---:|')
  for (const r of reports) io.out(`| ${r.plugin} | ${r.rules} | ${r.byCode} | ${r.byEval} | ${r.left.length} |`)
  for (const r of reports) {
    for (const rule of r.left) io.out(`${PLUGINS_DIR}/${r.plugin}/${rule.file}:${rule.line}: ${rule.text.slice(0, 140)}`)
  }
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
