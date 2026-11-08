// hooks/policy.ts
// The Iron Rules of the two interactive skills as pure decisions: which words of
// the user grant an edit, a publication or a resolution, and which tool calls a
// walkthrough refuses without them. No $ here, so the guards and their .catch
// nets decide the same way, and the tests read the rules without an engine.

import { gitSubcommand, simpleCommands } from '../core/shell.ts'

export type Skill = 'start-review' | 'process-comments' | 'auto-fix-loop'

// The skills this plugin ships, by the key skill.prompt carries.
export const SKILL_KEYS: Record<string, Skill> = {
  'pr-review:start-review': 'start-review',
  'pr-review:process-comments': 'process-comments',
  'pr-review:auto-fix-loop': 'auto-fix-loop',
}

export const GH_TOOL = 'mcp__github__gh'

// Where the walkthroughs keep their own files: comment bodies, commit messages,
// request files. Writing there is never a code change.
const SCRATCH = /^(\/private)?\/tmp\/claude-pr-review-[^/]*(\/|$)/

// The tools that change a file.
const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/*
 * A user's answer as a menu answer: lowercased, trimmed, a leading « ok », « yes »
 * or « oui » and its comma dropped, trailing punctuation dropped. A question is no
 * answer: "fix?" asks, it does not decide. A grant is the command the answer starts
 * with, never a word inside it: "don't fix this one" and "why not post now" grant
 * nothing.
 */
function answerOf(prompt: string): string | null {
  const text = prompt.trim().toLowerCase()
  if (text.endsWith('?')) return null
  return text.replace(/^(ok|okay|yes|oui)\b[\s,.!:-]*/, '').replace(/[\s.!,;:]+$/, '')
}

// The answer's first token, stripped of punctuation: "1.", "3 please" and "FR" read as 1, 3 and fr.
function firstToken(answer: string): string {
  return (answer.split(/\s+/)[0] ?? '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

const starts = (prompt: string, re: RegExp): boolean => {
  const answer = answerOf(prompt)
  return answer !== null && re.test(answer)
}

/*
 * The edit grant. start-review: the answer "fix" ("fix", "fix all", "fix it").
 * process-comments: option 1 or 3, or an alias the skill's input table lists
 * ("fix & resolve", "fix resolve", "fr", "fix and resolve", "fix only", "fix",
 * "f", "fix no resolve"): each starts with the word fix, or is 1, 3, f or fr.
 */
export function grantsEdit(skill: Skill, prompt: string): boolean {
  if (starts(prompt, /^fix\b/)) return true
  if (skill !== 'process-comments') return false
  const answer = answerOf(prompt)
  return answer !== null && ['1', '3', 'f', 'fr'].includes(firstToken(answer))
}

/*
 * The resolve grant of process-comments: option 1 or 4, or their aliases
 * ("fix & resolve", "fix resolve", "fr", "fix and resolve", "pass & resolve",
 * "pr", "resolve only", "just resolve"). "fix no resolve" is option 3 and keeps
 * the thread open.
 */
export function grantsResolve(prompt: string): boolean {
  const answer = answerOf(prompt)
  if (answer === null) return false
  if (['1', '4', 'fr', 'pr'].includes(firstToken(answer))) return true
  return /^((fix|pass)\s*(&|and)?\s*resolve|resolve( only)?|just resolve)\b/.test(answer)
}

export const grantsPublish = (prompt: string): boolean => starts(prompt, /^post now\b/)
// The words that end a walkthrough's guards at once, whatever the skill.
export const releases = (prompt: string): boolean => starts(prompt, /^(end|stop) review\b/)

/*
 * Whether a shell command runs `git push`. Each command of a list or a pipe is
 * read on its own; within one, the subcommand is the first word after `git` and
 * its global options. A quoted "push" inside a commit message is a word of the
 * message, not the subcommand, and reads as no push.
 */
export function runsGitPush(command: string): boolean {
  // core's shell reader: each command of a list or a pipe, wrappers and assignments skipped,
  // `sh -c` / `bash -lc` read again. `eval` joins its words into a line read the same way.
  return simpleCommands(command).some((argv) => {
    if (argv[0] === 'eval') return runsGitPush(argv.slice(1).join(' '))
    const at = gitSubcommand(argv)?.at
    return at !== undefined && argv[at] === 'push'
  })
}

// A path of the walkthrough's own scratch directory, never a code change. A path
// that climbs out with `..` is not one.
export function isScratch(path: string): boolean {
  return SCRATCH.test(path) && !/(^|\/)\.\.(\/|$)/.test(path)
}

// The PR scratch directory a path lies in, for the band: `/tmp/claude-pr-review-12`.
export function scratchDirOf(path: string): string | undefined {
  const m = /^((?:\/private)?\/tmp\/claude-pr-review-\d+)\//.exec(path)
  return m && isScratch(path) ? m[1] : undefined
}

// GitHub commands that only read (the github plugin's own READS list).
const GH_READS = new Set([
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-diff', 'pr-files', 'pr-commits',
  'file-at-ref', 'pr-threads', 'pr-comments', 'pr-issue-comments', 'pr-reviews',
  'comment-resolved', 'comments-resolved-batch', 'review-pending', 'repo-review-comments',
  'issue-view', 'issue-list', 'issue-search', 'pr-linked-issues', 'auth-check',
])

// What the PR author would see: replies, resolutions, edits of comments.
const GH_CONVERSATION = new Set([
  'thread-reply', 'thread-resolve', 'comment-resolve', 'comment-unresolve', 'comment-edit', 'comment-delete',
])

// Publications a user can order by name.
const GH_PUBLISH = new Set(['pr-comment', 'review-submit'])

export type Call = { tool: string; [key: string]: unknown }

const ASK = 'Ask the user; they lift this by answering with that word, by saying "end review", or by pressing Esc.'

function editDecision(skill: Skill, e: Call, prompt: string): string | null {
  const path = String(e.file_path ?? e.notebook_path ?? '')
  if (path && isScratch(path)) return null
  if (grantsEdit(skill, prompt)) return null
  const word = skill === 'start-review' ? '"fix"' : '"fix", 1 or 3'
  return `pr-review ${skill}: no code change without the user's ${word} for the item on screen. ${ASK}`
}

function ghDecision(skill: Skill, e: Call, prompt: string): string | null {
  const command = String(e.command ?? '')
  const args = (e.args && typeof e.args === 'object' ? e.args : {}) as Record<string, unknown>
  if (GH_READS.has(command)) return null
  if (skill === 'start-review') {
    if (command === 'review-pending-create' || command === 'review-pending-add') return null
    if (command === 'review-submit' && args.event !== undefined && String(args.event) !== 'COMMENT') {
      return `pr-review start-review: a review is never submitted with event ${String(args.event)}; post now publishes as COMMENT and the user submits the pending review on GitHub. ${ASK.replace('that word', '"end review"')}`
    }
    if (GH_PUBLISH.has(command)) {
      return grantsPublish(prompt) ? null
        : `pr-review start-review: ${command} publishes on the PR, and only the user's "post now" publishes. ${ASK}`
    }
    if (GH_CONVERSATION.has(command)) {
      return grantsPublish(prompt) ? null
        : `pr-review start-review: the walkthrough never replies in, resolves or edits a conversation (${command}). ${ASK.replace('that word', '"post now"')}`
    }
    return null
  }
  if (skill === 'process-comments') {
    if (command === 'thread-resolve' || command === 'comment-resolve') {
      return grantsResolve(prompt) ? null
        : `pr-review process-comments: a comment is resolved only on the user's option 1 or 4 (${command}). ${ASK.replace('that word', '1 or 4')}`
    }
    if (GH_CONVERSATION.has(command) || GH_PUBLISH.has(command) || command.startsWith('review-pending-')) {
      return grantsPublish(prompt) ? null
        : `pr-review process-comments: replies are proposed to the user, never posted (${command}); the user posts them, or says "post now". ${ASK.replace('that word', '"post now"')}`
    }
  }
  return null
}

/*
 * The guard's decision for one tool call: null lets it through, a string is the
 * deny reason the model reads. `ghListed` says whether the github plugin's tool
 * is in the session; it is only asked about a Bash call naming the resolver.
 */
export function decide(skill: Skill | null, e: Call, prompt: string, ghListed = false): string | null {
  if (skill === null || skill === 'auto-fix-loop') return null
  if (EDITORS.has(e.tool)) return editDecision(skill, e, prompt)
  if (e.tool === GH_TOOL) return ghDecision(skill, e, prompt)
  if (e.tool === 'Bash') {
    const command = String(e.command ?? '')
    if (ghListed && /resolve_github\.py/.test(command)) {
      return `pr-review ${skill}: ${GH_TOOL} is listed in this session, so GitHub calls go through it, where the permission check applies; the Bash route is for sessions without it.`
    }
  }
  return null
}

export const PUSH_REFUSAL = 'the walkthrough never pushes unless the user allows it when asked; pushing is the user\'s.'

/*
 * The question a push during a walkthrough asks the user, or null when none guards it. A push is
 * never granted by words in a prompt (« I will push later » holds the word): the user answers the
 * host's own question (decision 0004).
 */
export function pushQuestion(skill: Skill | null, e: Call): string | null {
  if (skill === null || skill === 'auto-fix-loop' || e.tool !== 'Bash') return null
  const command = String(e.command ?? '')
  return runsGitPush(command) ? `pr-review ${skill}: push now? ${command.trim().slice(0, 200)}` : null
}

// Whether a Bash call needs the tool list to be decided (the one async read).
export const needsToolList = (e: Call): boolean => e.tool === 'Bash' && /resolve_github\.py/.test(String(e.command ?? ''))

// The closing lines the two skills print at their end: the walkthrough is over.
export function endsWalkthrough(skill: Skill, answer: string): boolean {
  if (skill === 'start-review') return /^## Walkthrough complete\s*$/m.test(answer)
  if (skill === 'process-comments') return /All PR comments have been addressed\./.test(answer)
  return false
}
