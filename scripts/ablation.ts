// A prompt rule's ablation on a plugin's behaviour suite (scripts/lib/outcome/ablation.ts): the
// cases run with the rule and without it, each variant capped at its share of a retrospective's
// eval cap (evals/outcome/caps.json, `retrospective`), compared paired by case.
//
//   npm run ablation -- --plugin <dir> --file <path in the plugin> --rule-file <file holding the rule's text>
//                       --case <glob> --out <dir outside the checkout> --model <m> --judge-model <m>
//                       [--runs <n>] [--host <binary>] [--allow-tools <tool>]...
//
// Paid: each run is a model run on the operator's credential. <dir> receives both variants, their
// results and `ablation.json`; nothing lands in the checkout.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ablationReport, armRuns, compare, evalArgv, stageVariants, variantCapUsd } from './lib/outcome/ablation.ts'
import { CAPS_FILE, parseCapsFile } from './lib/outcome/cases.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry } from './lib/plugins.ts'

const USAGE = 'usage: ablation --plugin <dir> --file <path in the plugin> --rule-file <file> --case <glob> --out <dir outside the checkout> --model <m> --judge-model <m> [--runs <n>] [--host <binary>] [--allow-tools <tool>]...'

/** Runs one evaluation; its exit status. */
export type Evaluate = (argv: readonly string[]) => number

export function run(root: string, args: readonly string[], io: Io, evaluate: Evaluate): number {
  let values
  try {
    values = parseArgs({
      args: [...args],
      options: {
        plugin: { type: 'string' }, file: { type: 'string' }, 'rule-file': { type: 'string' }, case: { type: 'string' },
        out: { type: 'string' }, model: { type: 'string' }, 'judge-model': { type: 'string' },
        runs: { type: 'string', default: '3' }, host: { type: 'string', default: 'claude' }, 'allow-tools': { type: 'string', multiple: true },
      },
    }).values
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 2
  }
  const { plugin, file, case: cases, out, model, host } = values
  const ruleFile = values['rule-file']
  const judgeModel = values['judge-model']
  const runs = Number(values.runs)
  if (!plugin || !file || !ruleFile || !cases || !out || !model || !judgeModel || !Number.isInteger(runs) || runs < 1) {
    io.err(USAGE)
    return 2
  }
  const outDir = resolve(root, out)
  const inside = relative(resolve(root), outDir)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    io.err(`--out must be outside the checkout: ${outDir}`)
    return 2
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    io.err(`--out must be empty: ${outDir}`)
    return 2
  }
  const caps = parseCapsFile(JSON.parse(readFileSync(join(root, CAPS_FILE), 'utf8'))).retrospective
  if (caps === undefined) {
    io.err(`${CAPS_FILE} holds no retrospective cap: a rule's ablation spends nothing without one`)
    return 2
  }
  const pluginDir = resolve(root, plugin)
  const dirs = { with: join(outDir, 'with'), without: join(outDir, 'without') }
  mkdirSync(outDir, { recursive: true })
  try {
    stageVariants(pluginDir, file, readFileSync(resolve(root, ruleFile), 'utf8'), join(dirs.with, 'plugin'), join(dirs.without, 'plugin'))
  } catch (error) {
    io.err(`the variants are not staged: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const maxCostUsd = variantCapUsd(caps)
  for (const variant of ['with', 'without'] as const) {
    const results = join(dirs[variant], 'results')
    mkdirSync(results, { recursive: true })
    const argv = evalArgv({ host, pluginDir: join(dirs[variant], 'plugin'), cases, runs, model, judgeModel, maxCostUsd, outDir: results, allowTools: values['allow-tools'] ?? [] })
    io.out(`${variant} the rule: ${argv.join(' ')}`)
    const status = evaluate(argv)
    // Exit 1 is a case under the threshold, exit 2 the cost ceiling reached with partial results: both leave a JSON to read.
    if (!existsSync(join(results, 'run.json'))) {
      io.err(`the ${variant} variant left no result (exit ${status})`)
      return 1
    }
  }
  const read = (variant: 'with' | 'without') => armRuns(JSON.parse(readFileSync(join(dirs[variant], 'results', 'run.json'), 'utf8')))
  const ablation = compare(read('with'), read('without'))
  writeFileSync(join(outDir, 'ablation.json'), `${JSON.stringify({ plugin, file, caseGlob: cases, runsPerCase: runs, maxCostUsdPerVariant: maxCostUsd, ...ablation }, null, 1)}\n`)
  io.out(ablationReport(ablation))
  return 0
}

/* node:coverage ignore next 4 */
if (isEntry(import.meta.url)) {
  const evaluate: Evaluate = ([command = 'claude', ...argv]) => spawnSync(command, argv, { stdio: 'inherit' }).status ?? 1
  process.exit(run(process.cwd(), process.argv.slice(2), processIo, evaluate))
}
