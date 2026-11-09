// hooks/review.ts
// /implement:review: the review of the branch's pull request is made by another session
// (method, « review on evidence »), launched here without a model turn. On macOS with the
// orchestrator installed, a visible iTerm tab through its launcher; anywhere else, a headless
// `claude -p` session whose report lands in a log file. The reviewer writes the review record
// itself, through pr-review's loop in its reviewer mode; github refuses a record written by the
// session that pushed the head, so the implementer can never stand in for it.
import { recordedInstallPaths } from '../core/install-record.ts'
import { sessionName } from '../core/names.ts'

export const LAUNCHER = 'skills/iterm-agents/scripts/iterm-agent.sh'
export const SUBJECT_MAX = 25

export function reviewerPrompt(branch: string): string {
  return [
    `You are the reviewer of the pull request of branch ${branch}, a session other than the one that wrote it:`,
    'you change no code, commit nothing and push nothing.',
    'Load the method:lifecycle skill, then run /pr-review:auto-fix-loop as its reviewer: call the loop tool\'s start',
    'with "review_only": true, run one review, report its findings. The loop ends there and leaves the review record',
    'for the ready gate. End with the method\'s report: the findings by severity, the record line, the status line.',
  ].join(' ')
}

/** The reviewer's session name, `Agent: review <codename>`, its subject cut to the shape's limit. */
export function reviewerTitle(codename: string): string {
  const subject = `review ${codename}`.slice(0, SUBJECT_MAX).trim()
  return sessionName('Agent', subject)
}

/** Where the orchestrator's launcher would be, for each install the record gives it. */
export function candidateLaunchers(record: string): string[] {
  const recorded = recordedInstallPaths(record, 'orchestrator', ['lounisbou'])
  return 'problem' in recorded ? [] : recorded.paths.map(root => `${root.replace(/\/+$/, '')}/${LAUNCHER}`)
}

/** The headless reviewer: detached, its output in `log`, the same permission mode the launcher gives agents. */
export function headlessArgv(prompt: string, log: string): string[] {
  return ['sh', '-c', 'nohup claude -p "$1" --permission-mode auto > "$2" 2>&1 < /dev/null &', 'implement-review', prompt, log]
}

export const lastLine = (text: unknown): string => String(text ?? '').trim().split('\n').at(-1)?.trim() ?? ''
