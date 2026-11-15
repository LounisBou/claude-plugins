// A prompt rule's ablation (docs/specs/learning-design.md, section 5 and review note 5): the
// plugin's behaviour cases run with the rule and without it, on the host's plugin evaluation
// command, paired by case. The rule enters, or stays, only when the runs show an outcome change
// at least the smallest effect they could detect; under it the result is « inconclusive », and an
// inconclusive or harmful rule does not enter and is proposed for removal when it is already in.
// Only the suite's pass flags decide: code-computed grades, never a judge's figure alone.
//
// The runs are paid model runs: the comparison, the staging and the command line are tested here
// with fakes, and the paid run is the operator's, through `npm run ablation` (scripts/ablation.ts),
// within the retrospective's cap (evals/outcome/caps.json, `retrospective`).
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RetrospectiveCaps } from './cases.ts'

/** z for 5 % two-sided and 80 % power, as the design's L0 measurement takes it. */
export const Z_POWER = 1.96 + 0.842
/**
 * The variance of one run of a case when no case of the ablation ran twice in an arm: the 0.34.0
 * baseline's « with » arm, the larger of the two measured (design, « L0 measurements »).
 */
export const FALLBACK_SIGMA_W2 = 0.0741

/** One arm's pass flags, by case. */
export type ArmRuns = ReadonlyMap<string, readonly boolean[]>

export type AblationVerdict = 'helps' | 'hurts' | 'inconclusive'

export interface Ablation {
  /** The cases both arms ran, in order. */
  readonly cases: readonly string[]
  /** Runs per variant over those cases (the smaller arm's). */
  readonly runs: number
  readonly passWith: number
  readonly passWithout: number
  /** The mean over cases of the pass rate with the rule less the rate without it. */
  readonly effect: number
  readonly sigmaW2: number
  /** The smallest effect the runs detect, paired by case. */
  readonly mde: number
  readonly verdict: AblationVerdict
}

/** The rule's text taken out of a file's text, once; or the sentence that says why it cannot be. */
export function withoutRule(text: string, rule: string): string {
  const needle = rule.trim()
  if (needle === '') throw new Error('the rule is empty')
  const at = text.indexOf(needle)
  if (at < 0) throw new Error('the rule is not in the file, word for word')
  if (text.indexOf(needle, at + needle.length) >= 0) throw new Error('the rule is in the file more than once: give a longer passage')
  return text.slice(0, at) + text.slice(at + needle.length).replace(/^[ \t]*\n/, '')
}

/** Copies the plugin into `withDir` as it is and into `withoutDir` with the rule taken out of `file` (relative to the plugin). */
export function stageVariants(pluginDir: string, file: string, rule: string, withDir: string, withoutDir: string): void {
  const source = readFileSync(join(pluginDir, file), 'utf8')
  const ablated = withoutRule(source, rule)
  const keep = (path: string): boolean => !path.split('/').includes('results') && !path.includes('/node_modules')
  cpSync(pluginDir, withDir, { recursive: true, filter: keep })
  cpSync(pluginDir, withoutDir, { recursive: true, filter: keep })
  writeFileSync(join(withoutDir, file), ablated)
}

export interface EvalOptions {
  readonly host: string
  readonly pluginDir: string
  readonly cases: string
  readonly runs: number
  readonly model: string
  readonly judgeModel: string
  readonly maxCostUsd: number
  readonly outDir: string
  readonly allowTools: readonly string[]
}

/** The host's evaluation command for one variant: the plugin only (no no-plugin arm), its cost capped. */
export function evalArgv(o: EvalOptions): string[] {
  return [
    o.host, 'plugin', 'eval', o.pluginDir, '--ablation', 'none', '--runs', String(o.runs), '--case', o.cases,
    '--no-publish', '--trust-plugin', ...(o.allowTools.length > 0 ? ['--allow-tools', ...o.allowTools] : []),
    '--model', o.model, '--judge-model', o.judgeModel, '--max-cost-usd', String(o.maxCostUsd),
    '--output-dir', o.outDir, '--json', join(o.outDir, 'run.json'),
  ]
}

/** What one variant may spend: the retrospective's cap shared among its prompt rules, then between the two variants. */
export function variantCapUsd(caps: RetrospectiveCaps): number {
  return Math.floor((caps.runUsd / caps.promptRules / 2) * 100) / 100
}

/** The pass flags by case of the evaluation's JSON, as the committed baselines hold it: `cases.<id>.with[].passed`. */
export function armRuns(json: unknown): ArmRuns {
  const cases = typeof json === 'object' && json !== null ? (json as { cases?: unknown }).cases : undefined
  if (typeof cases !== 'object' || cases === null) throw new Error('the evaluation\'s JSON holds no cases')
  const runs = new Map<string, boolean[]>()
  for (const [id, arms] of Object.entries(cases)) {
    const list = typeof arms === 'object' && arms !== null ? (arms as { with?: unknown }).with : undefined
    if (!Array.isArray(list)) continue
    runs.set(id, list.map(run => typeof run === 'object' && run !== null && (run as { passed?: unknown }).passed === true))
  }
  return runs
}

const rate = (flags: readonly boolean[]): number => flags.filter(Boolean).length / flags.length

/**
 * The paired comparison of the two variants: per case both ran, its pass rate with the rule less
 * without; the mean of those differences is the effect, and the smallest detectable effect is
 * Z_POWER · √(2 σw² / n), σw² the unbiased variance of one run pooled over the cases and arms that
 * ran twice or more, n the runs per variant.
 */
export function compare(withRule: ArmRuns, withoutRule: ArmRuns): Ablation {
  const cases = [...withRule.keys()].filter(id => (withRule.get(id)?.length ?? 0) > 0 && (withoutRule.get(id)?.length ?? 0) > 0)
  if (cases.length === 0) throw new Error('no case ran in both variants')
  const pairs = cases.map(id => [withRule.get(id) ?? [], withoutRule.get(id) ?? []] as const)
  const variances = pairs.flat().filter(flags => flags.length >= 2).map(flags => rate(flags) * (1 - rate(flags)) * flags.length / (flags.length - 1))
  const sigmaW2 = variances.length === 0 ? FALLBACK_SIGMA_W2 : variances.reduce((a, b) => a + b, 0) / variances.length
  const runsWith = pairs.reduce((n, [w]) => n + w.length, 0)
  const runsWithout = pairs.reduce((n, [, o]) => n + o.length, 0)
  const runs = Math.min(runsWith, runsWithout)
  const effect = pairs.reduce((sum, [w, o]) => sum + rate(w) - rate(o), 0) / pairs.length
  // A variance of zero (every case decided the same way every time) still needs a sample: the fallback stands.
  const mde = Z_POWER * Math.sqrt((2 * (sigmaW2 > 0 ? sigmaW2 : FALLBACK_SIGMA_W2)) / runs)
  const verdict: AblationVerdict = effect >= mde ? 'helps' : effect <= -mde ? 'hurts' : 'inconclusive'
  return {
    cases, runs, effect, sigmaW2, mde, verdict,
    passWith: pairs.reduce((n, [w]) => n + w.filter(Boolean).length, 0),
    passWithout: pairs.reduce((n, [, o]) => n + o.filter(Boolean).length, 0),
  }
}

const points = (x: number): string => `${Math.round(x * 100)} points`

/** The ablation's report, in lines: what ran, the effect against the smallest detectable, the verdict and what it means for the rule. */
export function ablationReport(a: Ablation): string {
  const meaning = a.verdict === 'helps'
    ? 'the rule changes the outcome: it may enter, replacing a rule, its plugin\'s budget unchanged'
    : a.verdict === 'hurts'
      ? 'the outcome is better without the rule: it does not enter, and where it is in it is proposed for removal'
      : 'the effect is under what these runs detect: the rule does not enter, and where it is in it is proposed for removal'
  return [
    `rule ablation over ${a.cases.length} cases, ${a.runs} runs per variant, paired by case`,
    `  passed: ${a.passWith} with the rule, ${a.passWithout} without`,
    `  effect ${points(a.effect)}, smallest detectable ${points(a.mde)} (σw² ${a.sigmaW2.toFixed(4)})`,
    `  ${a.verdict}: ${meaning}`,
  ].join('\n')
}
