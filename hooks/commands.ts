// hooks/commands.ts
// /pr-review:doctor and /pr-review:install answered without a model turn, and
// the preflight run once per session instead of once per skill start.
//
// The markdown commands stay the commands' public face and their fallback: a
// handler that fails passes the run on, and the markdown spends a turn running
// install.sh as it always did. The preflight is the same scripts/preflight.sh
// the skills run, so the two routes cannot disagree on what is missing.
import { preflight } from './state.ts'

// install.sh's exit codes, the remedy row commands/doctor.md prints.
export const REMEDIES: Record<number, string> = {
  0: 'everything satisfied',
  10: 'an upstream plugin is missing or installed but disabled: install it, then enable it in /plugin',
  11: 'a system tool is missing: install python3 (3.9+) or curl',
  12: 'no GitHub token: gh auth login',
  13: 'not a GitHub repository clone: run from one, or check the origin remote',
}

export function report(run: { exitCode: number; stdout: string; stderr: string }): string {
  const output = [run.stdout, run.stderr].map((s) => String(s ?? '').trimEnd()).filter(Boolean).join('\n')
  const remedy = REMEDIES[run.exitCode] ?? 'an unexpected failure: read the output above'
  return `${output}\n\nexit ${run.exitCode}: ${remedy}`
}

// What the skill reads in place of its preflight step once the preflight passed.
export const PASSED_NOTE =
  '**Preflight: already passed in this session** (run by the pr-review module). Skip the preflight step below.\n\n'

export function failedText(run: { exitCode: number; stdout: string; stderr: string }): string {
  return 'The pr-review preflight failed, so this skill stops here. Print this output to the user verbatim and do nothing else:\n\n'
    + '```\n' + report(run) + '\n```\n'
}

async function install($: any): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run(['bash', $.plugin.root + '/install.sh'], { timeoutMs: 60_000 })
}

async function answer($: any): Promise<{ text: string }> {
  const run = await install($)
  if (run.exitCode === 0) preflight.hasPassed = true
  return { text: report(run) }
}

export function register(on: any): void {
  on('command.run', { command: 'pr-review:doctor' }, async ($: any) => answer($))
    .catch(async (_$: any, e: any, next: any) => next(e))
  on('command.run', { command: 'pr-review:install' }, async ($: any) => answer($))
    .catch(async (_$: any, e: any, next: any) => next(e))
}
