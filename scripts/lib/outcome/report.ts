// The run's report read by a person: one table per case, then each arm's totals. The JSON
// report beside it is the record; this is a view of it.
import { ARMS, type Arm } from './cases.ts'
import type { ArmResult, Report } from './harness.ts'

export interface Totals {
  /** Arms that ran (any status but not-started). */
  readonly ran: number
  readonly costUsd: number
  readonly durationSeconds: number
  readonly suite: number
  readonly referenceTests: number
  readonly intent: number
  readonly blockingFindings: number
}

export function totals(report: Report, arm: Arm): Totals {
  const results = report.cases.flatMap(entry => entry.arms).filter(result => result.arm === arm && result.status !== 'not-started')
  const count = (test: (result: ArmResult) => boolean): number => results.filter(test).length
  return {
    ran: results.length,
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    durationSeconds: results.reduce((sum, result) => sum + result.durationSeconds, 0),
    suite: count(result => result.grades?.suite === true),
    referenceTests: count(result => result.grades?.referenceTests === true),
    intent: count(result => result.grades?.intent?.matches === true),
    blockingFindings: results.reduce((sum, result) => sum + (result.grades?.review?.blocking ?? 0), 0),
  }
}

function mark(value: boolean | null | undefined): string {
  if (value === true) return 'pass'
  if (value === false) return 'fail'
  return '—'
}

const usd = (value: number): string => value.toFixed(2)

export function markdown(report: Report): string {
  const lines = [
    `# Outcome evals, ${report.mode}`,
    '',
    `${report.startedAt} to ${report.finishedAt}. Spent ${usd(report.spentUsd)} USD of a ${report.caps.runUsd} USD cap, each arm of a case capped at ${report.caps.caseArmUsd} USD.`,
  ]
  if (report.stopped !== null) lines.push('', `Stopped: ${report.stopped}.`)
  for (const entry of report.cases) {
    const { calibration } = entry
    lines.push(
      '',
      `## ${entry.id} (#${entry.pr}, ${entry.plugin})`,
      '',
      `Calibration: the suite ${calibration.referenceSuite ? 'passes' : 'fails'} on the merged result; ${calibration.referenceTests.length} reference test files, ${calibration.referenceTestsFailOnBase ? 'failing' : 'not failing'} on the base.`,
    )
    if (calibration.referenceSuiteTail !== null) lines.push('', '```', calibration.referenceSuiteTail, '```')
    lines.push(
      '',
      '| Arm | Status | USD | Seconds | Suite | Reference tests | Intent | Blocking / minor findings | Files | Overlap |',
      '|---|---|---:|---:|---|---|---|---|---:|---:|',
    )
    for (const result of entry.arms) {
      const grades = result.grades
      const review = grades?.review ? `${grades.review.blocking} / ${grades.review.minor}` : '—'
      lines.push(
        `| ${result.arm} | ${result.status} | ${usd(result.costUsd)} | ${result.durationSeconds} | ${mark(grades?.suite)} | ${mark(grades?.referenceTests)} | ${mark(grades?.intent?.matches)} | ${review} | ${grades?.files ?? '—'} | ${grades ? grades.referenceOverlap.toFixed(2) : '—'} |`,
      )
    }
    for (const result of entry.arms) {
      if (result.reason !== null) lines.push('', `- ${result.arm}: ${result.reason}`)
      for (const note of result.grades?.notes ?? []) lines.push(`- ${result.arm}, ${note}`)
      if (result.grades?.intent) lines.push(`- ${result.arm}, intent: ${result.grades.intent.reason}`)
      if (result.agentsOpened !== null) lines.push(`- ${result.arm}, agents opened: ${result.agentsOpened}`)
      for (const decision of result.decisions) lines.push(`- ${result.arm}, decision: ${decision}`)
      if (result.grades && result.grades.outsidePlugin.length > 0) lines.push(`- ${result.arm}, outside its plugin: ${result.grades.outsidePlugin.join(', ')}`)
    }
  }
  lines.push('', '## Totals', '', '| Arm | Ran | USD | Seconds | Suite | Reference tests | Intent | Blocking findings |', '|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const arm of ARMS) {
    const sum = totals(report, arm)
    lines.push(`| ${arm} | ${sum.ran} | ${usd(sum.costUsd)} | ${sum.durationSeconds} | ${sum.suite} | ${sum.referenceTests} | ${sum.intent} | ${sum.blockingFindings} |`)
  }
  return `${lines.join('\n')}\n`
}
