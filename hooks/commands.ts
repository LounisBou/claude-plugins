// hooks/commands.ts
// /pr-review:doctor and /pr-review:install answered without a model turn, and
// the preflight run once per session instead of once per skill start. install
// runs install.sh in full: it installs gh when missing and waits for the GitHub
// login in the browser. doctor runs it with --check, which changes nothing.
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
  11: 'a system tool is missing: install the one named above (python3 3.9+, curl, gh)',
  12: 'no GitHub token: run /pr-review:install, which opens the GitHub login in the browser',
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

// The login waits on the user in the browser, and installing gh with Homebrew
// takes a few minutes before it: the longest run the host allows.
export const INSTALL_TIMEOUT_MS = 600_000
export const CHECK_TIMEOUT_MS = 60_000

async function install($: any, check: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const argv = ['bash', $.plugin.root + '/install.sh', ...(check ? ['--check'] : [])]
  return $.process.run(argv, { timeoutMs: check ? CHECK_TIMEOUT_MS : INSTALL_TIMEOUT_MS })
}

async function answer($: any, check: boolean): Promise<{ text: string }> {
  const run = await install($, check)
  if (run.exitCode === 0) preflight.hasPassed = true
  return { text: report(run) }
}

export function register(on: any): void {
  on('command.run', { command: 'pr-review:doctor' }, async ($: any) => answer($, true))
    .catch(async (_$: any, e: any, next: any) => next(e))
  on('command.run', { command: 'pr-review:install' }, async ($: any) => answer($, false))
    .catch(async (_$: any, e: any, next: any) => next(e))
}
