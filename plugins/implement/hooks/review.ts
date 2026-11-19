// hooks/review.ts
// /implement:review: the review of the branch's pull request is made by another session
// (method, « review on evidence »), launched here without a model turn. On macOS with the
// orchestrator installed, a visible iTerm tab through its launcher; anywhere else, a headless
// `claude -p` session whose report lands in a log file, named like the tab. The reviewer is the one
// review instrument: `orchestrator:lens` readers, then its verdict recorded through the
// orchestrator's review tool, which takes a pass or a fail from a session named `Agent: review …`;
// github refuses a record written by the session that pushed the head, so the implementer can never
// stand in for it.
import { recordedInstallPaths } from '../core/install-record.ts'
import { sessionName } from '../core/names.ts'
import { launcherOf } from '../core/orchestration.ts'

export const SUBJECT_MAX = 25

/** The reviewer's lenses, as core's lens description takes them (lens.ts: lower case, dashed); security if relevant. */
export const REVIEWER_LENSES = ['correctness', 'tests', 'silent-failures', 'spec-conformity', 'security'] as const

export function reviewerPrompt(branch: string): string {
  return [
    `You are the reviewer of the pull request of branch ${branch}, a session other than the one that wrote it:`,
    'you change no code, commit nothing and push nothing.',
    'Load the method:lifecycle skill. From a clean checkout at the pull request\'s head, launch one read-only',
    `orchestrator:lens reader per lens the diff calls for (${REVIEWER_LENSES.join(', ')} if relevant) over`,
    'origin/<base>...HEAD, each described `lens <lens, as written here> <owner/name>#<pr> <base>..<head, 12 characters>`.',
    'Then record the verdict at that head with mcp__orchestrator__review: pass when no critical or important finding',
    'stands, else fail, and its detail in one line. End with the method\'s report: the findings by severity, the record',
    'line, the status line.',
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
  return 'problem' in recorded ? [] : recorded.paths.map(launcherOf)
}

/** The headless reviewer: detached, named `title`, its output in `log`, the same permission mode the launcher gives agents, Remote Control off. */
export function headlessArgv(prompt: string, log: string, title: string): string[] {
  return ['sh', '-c', `nohup claude -p "$1" --permission-mode auto -n "$3" --settings '{"remoteControlAtStartup":false}' > "$2" 2>&1 < /dev/null &`, 'implement-review', prompt, log, title]
}

export const lastLine = (text: unknown): string => String(text ?? '').trim().split('\n').at(-1)?.trim() ?? ''
