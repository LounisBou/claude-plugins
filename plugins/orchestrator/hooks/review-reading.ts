// hooks/review-reading.ts
// What a review brief says of its round, and whether a verdict is for that round. Pure: the files are review-close.ts's.

/** The round a verdict is recorded for: the repository `owner/name`, the pull request, and the full head the verdict is at. */
export type Round = { repo: string; pr: number; head: string }

/** What a review brief names of its round: the project (the repository's name), the pull request and the head it reads. */
export type Reading = { project: string; pr: number; head: string }

/**
 * What a brief reads, or null when it is no review brief: the REVIEW agent's brief names its project on the
 * first line and, in its § 1, the pull request and the head under review (`templates/agent-review-brief.md`).
 * Any other text, an implementer's brief for one, is none.
 */
export function readingOf(text: string): Reading | null {
  const project = /^# (\S+) — review: /.exec(text)?.[1]
  const delivery = /^4\. The delivery: pull request ([1-9][0-9]*) \(.*\), branch `[^`]*`, head `([0-9a-f]{7,40})`, base /im.exec(text)
  if (project === undefined || delivery === null || !/^You are the REVIEW agent for this round\./m.test(text)) return null
  return { project, pr: Number(delivery[1]), head: (delivery[2] ?? '').toLowerCase() }
}

/** Whether a reading is the round's: its project is the repository's name, its pull request and its head, a prefix of the verdict's. */
export const isRound = (read: Reading, round: Round): boolean =>
  read.project.toLowerCase() === (round.repo.split('/').at(-1) ?? '').toLowerCase() && read.pr === round.pr && round.head.toLowerCase().startsWith(read.head)
