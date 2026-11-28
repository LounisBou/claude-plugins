import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ablationReport, armRuns, compare, evalArgv, FALLBACK_SIGMA_W2, stageVariants, variantCapUsd, withoutRule, Z_POWER } from './ablation.ts'
import { CAPS_FILE } from './cases.ts'
import { run } from '../../ablation.ts'

const arm = (cases: Record<string, readonly boolean[]>) => new Map(Object.entries(cases))
const T = true
const F = false

describe('a prompt rule\'s ablation', () => {
  it('takes the rule out of its file once, word for word, and refuses otherwise', () => {
    assert.equal(withoutRule('# Rules\n\n- keep the line\n- never push\n- last\n', '- never push'), '# Rules\n\n- keep the line\n- last\n')
    assert.throws(() => withoutRule('a', '  '), /empty/)
    assert.throws(() => withoutRule('a', 'b'), /not in the file/)
    assert.throws(() => withoutRule('b b', 'b'), /more than once/)
  })

  it('stages the plugin as it is and without the rule, leaving out past results', () => {
    const work = mkdtempSync(join(tmpdir(), 'ablation-stage-'))
    try {
      const plugin = join(work, 'plugin')
      mkdirSync(join(plugin, 'skills', 'a'), { recursive: true })
      mkdirSync(join(plugin, 'evals', 'results'), { recursive: true })
      writeFileSync(join(plugin, 'skills', 'a', 'SKILL.md'), 'one\nthe rule\ntwo\n')
      writeFileSync(join(plugin, 'evals', 'results', 'old.json'), '{}')
      stageVariants(plugin, 'skills/a/SKILL.md', 'the rule\n', join(work, 'with'), join(work, 'without'))
      assert.equal(readFileSync(join(work, 'with', 'skills', 'a', 'SKILL.md'), 'utf8'), 'one\nthe rule\ntwo\n')
      assert.equal(readFileSync(join(work, 'without', 'skills', 'a', 'SKILL.md'), 'utf8'), 'one\ntwo\n')
      assert.equal(existsSync(join(work, 'with', 'evals', 'results', 'old.json')), false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('runs the plugin only, its cost capped at its share of the retrospective\'s cap', () => {
    assert.equal(variantCapUsd({ runUsd: 10, promptRules: 3 }), 1.66)
    assert.deepEqual(evalArgv({ host: 'h', pluginDir: '/p', cases: 'a-*', runs: 3, model: 'm', judgeModel: 'j', maxCostUsd: 1.66, outDir: '/o', allowTools: ['Write'] }), [
      'h', 'plugin', 'eval', '/p', '--ablation', 'none', '--runs', '3', '--case', 'a-*', '--no-publish', '--trust-plugin', '--allow-tools', 'Write',
      '--model', 'm', '--judge-model', 'j', '--max-cost-usd', '1.66', '--output-dir', '/o', '--json', '/o/run.json',
    ])
    assert.equal(evalArgv({ host: 'h', pluginDir: '/p', cases: '*', runs: 1, model: 'm', judgeModel: 'j', maxCostUsd: 1, outDir: '/o', allowTools: [] }).includes('--allow-tools'), false)
  })

  it('reads the pass flags by case from the evaluation\'s JSON, as the baselines hold it', () => {
    const runs = armRuns({ cases: { a: { with: [{ passed: true }, { passed: false }, null] }, b: { without: [] }, c: 3 } })
    assert.deepEqual([...runs], [['a', [true, false, false]]])
    assert.throws(() => armRuns({}), /no cases/)
    assert.throws(() => armRuns(null), /no cases/)
  })

  it('pairs the variants by case and calls a change only at the smallest effect the runs detect', () => {
    // Six cases, three runs each: every case passes with the rule and fails without, so σw² is 0 and the fallback stands.
    const all = (flag: boolean) => arm(Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, [flag, flag, flag]])))
    const helps = compare(all(T), all(F))
    assert.deepEqual([helps.cases.length, helps.runs, helps.passWith, helps.passWithout, helps.effect, helps.verdict], [6, 18, 18, 0, 1, 'helps'])
    assert.equal(helps.sigmaW2, 0)
    assert.ok(Math.abs(helps.mde - Z_POWER * Math.sqrt(2 * FALLBACK_SIGMA_W2 / 18)) < 1e-12)
    assert.equal(compare(all(F), all(T)).verdict, 'hurts')
    // One case, three runs a variant: 62 points, the design's figure, is out of reach of a two-of-three split.
    const one = compare(arm({ a: [T, T, F] }), arm({ a: [F, T, F] }))
    assert.equal(one.verdict, 'inconclusive')
    assert.ok(one.sigmaW2 > 0)
    // A case one variant did not run is left out; none in common is refused.
    assert.deepEqual(compare(arm({ a: [T], b: [T] }), arm({ a: [F], c: [F] })).cases, ['a'])
    assert.throws(() => compare(arm({ a: [T] }), arm({ b: [T] })), /no case ran in both/)
  })

  it('reports the effect against the smallest detectable, and what the verdict means for the rule', () => {
    const report = ablationReport(compare(arm({ a: [T, T, F] }), arm({ a: [F, T, F] })))
    assert.match(report, /over 1 cases, 3 runs per variant, paired by case/)
    assert.match(report, /effect 33 points, smallest detectable \d+ points/)
    assert.match(report, /inconclusive: .* does not enter, .* proposed for removal/)
    assert.match(ablationReport(compare(arm({ a: [T, T, T, T, T, T] }), arm({ a: [F, F, F, F, F, F] }))), /helps: the rule changes the outcome/)
    assert.match(ablationReport(compare(arm({ a: [F, F, F, F, F, F] }), arm({ a: [T, T, T, T, T, T] }))), /hurts: the outcome is better without the rule/)
  })
})

describe('npm run ablation', () => {
  // A checkout of its own, whose caps file holds a retrospective cap.
  const root = mkdtempSync(join(tmpdir(), 'ablation-root-'))
  const caps = { runUsd: 20, caseArmUsd: 10, judgeUsd: 1, cases: 1 }
  mkdirSync(dirname(join(root, CAPS_FILE)), { recursive: true })
  writeFileSync(join(root, CAPS_FILE), JSON.stringify({ version: 1, runs: { pilot: caps, measure: caps }, retrospective: { runUsd: 10, promptRules: 3 } }))
  after(() => rmSync(root, { recursive: true, force: true }))
  const io = () => {
    const outs: string[] = []
    const errs: string[] = []
    return { outs, errs, io: { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l), env: {} } }
  }

  it('stages both variants, runs each through the host\'s command, and writes the comparison', () => {
    const work = mkdtempSync(join(tmpdir(), 'ablation-run-'))
    try {
      const plugin = join(work, 'plugin')
      mkdirSync(plugin)
      writeFileSync(join(plugin, 'SKILL.md'), 'keep\nnever push\n')
      writeFileSync(join(work, 'rule.txt'), 'never push\n')
      const calls: string[][] = []
      const { outs, errs, io: sink } = io()
      const status = run(root, ['--plugin', plugin, '--file', 'SKILL.md', '--rule-file', join(work, 'rule.txt'), '--case', '*', '--out', join(work, 'out'), '--model', 'm', '--judge-model', 'j', '--runs', '2'], sink, argv => {
        calls.push([...argv])
        const staged = argv[3] ?? ''
        const passed = readFileSync(join(staged, 'SKILL.md'), 'utf8').includes('never push')
        const out = argv[argv.indexOf('--json') + 1] ?? ''
        writeFileSync(out, JSON.stringify({ cases: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => [id, { with: [{ passed }, { passed }] }])) }))
        return passed ? 0 : 1
      })
      assert.equal(status, 0, errs.join('\n'))
      assert.equal(calls.length, 2)
      assert.ok(calls.every(argv => argv.includes('--max-cost-usd') && argv[argv.indexOf('--max-cost-usd') + 1] === '1.66'))
      assert.match(outs.join('\n'), /helps: the rule changes the outcome/)
      assert.equal(JSON.parse(readFileSync(join(work, 'out', 'ablation.json'), 'utf8')).verdict, 'helps')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('refuses a call that lacks an option, an output inside the checkout or not empty, a rule not in the file, a variant that left nothing', () => {
    const work = mkdtempSync(join(tmpdir(), 'ablation-refuse-'))
    try {
      const plugin = join(work, 'plugin')
      mkdirSync(plugin)
      writeFileSync(join(plugin, 'SKILL.md'), 'keep\n')
      writeFileSync(join(work, 'rule.txt'), 'never push\n')
      const base = ['--plugin', plugin, '--file', 'SKILL.md', '--rule-file', join(work, 'rule.txt'), '--case', '*', '--model', 'm', '--judge-model', 'j']
      const never = () => { throw new Error('no evaluation expected') }
      const { errs, io: sink } = io()
      assert.equal(run(root, ['--bogus'], sink, never), 2)
      assert.equal(run(root, base, sink, never), 2)
      assert.equal(run(root, [...base, '--out', 'inside'], sink, never), 2)
      assert.match(errs.at(-1) ?? '', /outside the checkout/)
      mkdirSync(join(work, 'full'))
      writeFileSync(join(work, 'full', 'x'), '')
      assert.equal(run(root, [...base, '--out', join(work, 'full')], sink, never), 2)
      assert.match(errs.at(-1) ?? '', /must be empty/)
      assert.equal(run(root, [...base, '--out', join(work, 'o1')], sink, never), 2)
      assert.match(errs.at(-1) ?? '', /not in the file/)
      writeFileSync(join(plugin, 'SKILL.md'), 'keep\nnever push\n')
      assert.equal(run(root, [...base, '--out', join(work, 'o2')], sink, () => 1), 1)
      assert.match(errs.at(-1) ?? '', /with variant left no result \(exit 1\)/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('refuses on the repository\'s caps file, which holds no retrospective cap, without running an eval', () => {
    const work = mkdtempSync(join(tmpdir(), 'ablation-repo-'))
    try {
      const plugin = join(work, 'plugin')
      mkdirSync(plugin)
      writeFileSync(join(plugin, 'SKILL.md'), 'keep\nnever push\n')
      writeFileSync(join(work, 'rule.txt'), 'never push\n')
      const calls: string[][] = []
      const { errs, io: sink } = io()
      const status = run(process.cwd(), ['--plugin', plugin, '--file', 'SKILL.md', '--rule-file', join(work, 'rule.txt'), '--case', '*', '--out', join(work, 'out'), '--model', 'm', '--judge-model', 'j'], sink, argv => {
        calls.push([...argv])
        return 1
      })
      assert.deepEqual(calls, [])
      assert.equal(status, 2)
      assert.match(errs.at(-1) ?? '', /holds no retrospective cap/)
      assert.equal(existsSync(join(work, 'out')), false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
