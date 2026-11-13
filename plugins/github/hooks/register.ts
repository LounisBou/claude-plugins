// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

import { atom, read, update } from 'claude-code'

import type { GithubPane, GithubPaneRow } from '../types'
import { lint, refusal, textFields } from './writing.ts'
import { CONSENT_PRODUCER, CONSENT_QUOTE_MIN, consentDir, parseConsentRecord, quotesConsent, type ConsentSubject } from '../core/consent-record.ts'
import { DETAIL_MAX, KINDS } from '../core/pr-record.ts'
import { covers, EXEMPT_DIR, exemptionLine, exemptionPath, parseExemption, parsePrFiles, runtimeFiles, type Exemption, type PrFile } from './e2e-scope.ts'
import {
  type WritingFile, bashAuthoring, bashTexts, lineCount, normalise, printsWhole, readerKey, readsWhole, toolAuthoring, writingFileAt, writingFilesFor,
  unreadRefusal,
} from './guards.ts'
import {
  NOT_READY, PRUNE_DAYS, PRUNE_EVERY_MS, READY, RECORDS_REFUSAL, STDIN_REFUSAL, autoMergeRefusal, bashActs, bashPushes,
  carriesReady, ciUndraft, ciUndraftLine, createdPr, draftRefusal, gateLeftLine, gateMissingLine, gateMovedLine,
  gateNotReadyLine, gateReadyLine, gateUnwrittenLine, graphqlRefusal, labelMove, leaveDraftRefusal, missingItems,
  notReadyRefusal, opaqueGraphqlRefusal, parseGate, producerSlug,
  kindRefusal, recordKindFor, toolAct, touchesRecords, unnamedRepoRefusal, unreadablePrRefusal, unverifiedRefusal, warnLine,
  type Act, type Gate, type Phase, type RecordFile,
} from './ready.ts'

export const PANE_ID = 'github-prs'

// The tool's subcommands, for its command enum: gh.py's, which it maps itself
// (--stdin-json), and the mod's own (MOD_COMMANDS), answered here.
// tests/run-tests.sh fails when this list and the two sources disagree.
export const COMMANDS = [
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-gate', 'pr-diff', 'pr-files',
  'pr-commits', 'file-at-ref', 'pr-create', 'pr-merge', 'pr-threads',
  'pr-comments', 'pr-issue-comments', 'pr-reviews', 'thread-reply',
  'pr-comment', 'comment-edit', 'comment-delete', 'thread-resolve',
  'comment-resolve', 'comment-unresolve', 'comment-resolved',
  'comments-resolved-batch', 'review-submit', 'review-pending-create',
  'review-pending-add', 'review-pending', 'repo-review-comments', 'pr-update',
  'pr-ready', 'pr-draft', 'label-add', 'label-remove', 'reviewer-add', 'reviewer-remove',
  'assignee-add', 'assignee-remove', 'labels-ensure', 'pr-readiness', 'issue-view', 'issue-list',
  'issue-search', 'pr-linked-issues', 'image-upload', 'auth-check', 'auto-merge-set', 'auto-merge-list',
  'protect-check', 'protect-apply',
]

// The subcommands this module answers without the engine: the list of
// repositories in auto-merge is a file on this machine, not GitHub's.
export const MOD_COMMANDS = new Set(['auto-merge-set', 'auto-merge-list'])

// The subcommands the session calls to read. Every other one writes to GitHub, and a
// command missing here is treated as a write, so the safe side is the default. After
// pr-gate and pr-checks the gate may write the Ready label itself: its act, not the session's.
export const READS = new Set([
  'pr-get', 'pr-list', 'pr-status', 'pr-checks', 'pr-gate', 'pr-diff', 'pr-files', 'pr-commits',
  'file-at-ref', 'pr-threads', 'pr-comments', 'pr-issue-comments', 'pr-reviews',
  'comment-resolved', 'comments-resolved-batch', 'review-pending', 'repo-review-comments',
  'issue-view', 'issue-list', 'issue-search', 'pr-linked-issues', 'auth-check', 'auto-merge-list',
  'protect-check',
])

export const TOOL = 'mcp__github__gh'

// The request travels as JSON on stdin: gh.py maps it onto its own parser,
// refuses what that parser does not declare, and writes the bodies to a
// private directory it removes. No argv is built and no file written here.
async function runGhRaw(
  $: any, command: string, args: Record<string, unknown> = {}, repo?: string,
): Promise<{ out: string; err: string }> {
  const r = await $.process.run(
    ['python3', $.plugin.root + '/engine/gh.py', '--stdin-json'],
    { stdin: JSON.stringify({ command, args, repo }), timeoutMs: 120_000 },
  )
  if (r.exitCode !== 0) throw new Error(r.stderr || 'gh.py exited ' + r.exitCode)
  const out = r.isStdoutTruncated ? r.stdout + '\n[output cut at 4 MiB]' : r.stdout
  return { out, err: r.stderr?.trim() ?? '' }
}

// The output followed by the line a call printed on stderr, when it printed one.
const withNote = (out: string, err: string): string => (err ? out.trimEnd() + '\n' + err : out)

// notes: a call that succeeds can still print a line on stderr (a label that could not
// be set after a pull request was opened). The tool shows it after the output.
async function runGh(
  $: any, command: string, args: Record<string, unknown> = {}, repo?: string, notes = false,
): Promise<string> {
  const r = await runGhRaw($, command, args, repo)
  return notes ? withNote(r.out, r.err) : r.out
}

/*
 * A tool.call hook that answers in place of next(e) skips core, and with it
 * the permission check: settings rules and the mode would never be read. So
 * the hook asks for the verdict itself. A deny refuses. An ask with no rule
 * behind it lets a read through, as reading is what the tool is mostly for,
 * and puts a write to the person. An ask from an explicit rule always asks.
 * Where nobody can answer (a -p run) the ask rejects and the call is refused.
 *
 * Between the verdict and the run come the house rules of engine/writing/:
 * the mechanical ones refuse a text before it leaves the machine, and the
 * approvals the file reserves to the person (a pull request out of draft, a
 * merge) are asked whatever the settings allow.
 *
 * Outside auto-merge, leaving draft (a CI undraft aside) is refused, never
 * asked: it is the person's act on GitHub, after their review.
 *
 * In a repository in auto-merge no write is put to the person: the reserved
 * approvals lift and an ask with no rule behind it runs. A deny and an ask
 * from an explicit rule stand, and so do the mechanical writing rules.
 */
async function permit(
  $: any, e: any, beforeAsk?: () => Promise<string | undefined>, ciUndraft?: () => Promise<boolean>,
): Promise<string | undefined> {
  const input = { command: e.command, args: e.args, repo: e.repo }
  const verdict = await $.tool.check({ tool: TOOL, input })
  if (verdict.decision === 'deny') return verdict.reason || 'refused by a permission rule'
  const args = e.args ?? {}

  const unread = await writingUnread($, toolAuthoring(e.command, args), e.agentId)
  if (unread) return unread

  // The ready guard, before any question: nobody is asked about a pull
  // request that is not ready.
  const notReady = beforeAsk ? await beforeAsk() : undefined
  if (notReady) return notReady

  // Going back to draft, and leaving it for CI still Not Ready, are no
  // approvals to give: they run in every repository, as through Bash. An ask
  // from an explicit rule stands.
  if (e.command === 'pr-draft' || (ciUndraft && await ciUndraft())) {
    if (verdict.decision === 'allow' || !verdict.rule) return undefined
    return ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
  }

  // Read once per call, for a write only.
  const autoMerge = !READS.has(e.command) && await inAutoMerge($, e)
  // Outside auto-merge, leaving draft is the operator's on GitHub: refused, never asked, and
  // before the writing rules, whose « Send as it is? » would otherwise open it.
  if (!autoMerge && leavesDraft(e.command, args)) {
    const repo = await targetRepo($, e).catch(() => undefined)
    const pr = Number(String(args.pr ?? '').replace('#', ''))
    return leaveDraftRefusal(e.command, repo ?? 'the origin repository', Number.isInteger(pr) && pr > 0 ? pr : undefined)
  }

  const found = lint(e.command, args, lastTyped)
  if (found.length > 0) {
    const print = fingerprint(e)
    if (!refusedOnce.has(print)) {
      refusedOnce.add(print)
      return refusal(e.command, found)
    }
    // The same text again: the person decides whether it goes as it is.
    const rules = [...new Set(found.map((v) => v.rule.split(' (')[0]))].join(', ')
    return ask($, describe(e) + ', which breaks the writing rules (' + rules + '). Send it as it is?',
      ['Send as it is', 'Deny'], e.command)
  }

  const reserved = reservedToPerson(e.command, autoMerge)
  if (reserved) return ask($, reserved + ' ' + describe(e) + '?', ['Allow', 'Deny'], e.command)

  if (verdict.decision === 'allow') return undefined
  if (READS.has(e.command) && !verdict.rule) return undefined
  if (autoMerge && !verdict.rule) return undefined

  // A grant for the session stands in for an ask no rule demanded, and only
  // for the command and repository it was given on.
  const grantable = !verdict.rule && !NEVER_GRANTED.has(e.command)
  const key = grantable ? await grantKey($, e) : undefined
  if (key && sessionGrants.has(key)) return undefined
  if (!key) return ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
  const where = e.repo || 'the origin repository'
  const question = '« Allow for this session » also allows every later gh ' + e.command + ' on '
    + where + ' until the session ends. ' + describe(e) + '?'
  try {
    const answer = await $.ui.ask(question, ['Allow', 'Allow for this session', 'Deny'])
    if (answer === 'Allow') return undefined
    if (answer === 'Allow for this session') {
      sessionGrants.add(key)
      return undefined
    }
  } catch {
    return 'gh ' + e.command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + e.command
}

/*
 * The writing rules on the Bash path: a gh pr create, edit, comment or review
 * whose title or body (inline, or the file --body-file names) breaks them is
 * refused once, as through the tool, and the same text again is put to the
 * person. A body the hook cannot see, from stdin or a command substitution, is
 * left out, and so is a file it cannot read, logged: the command then runs as it is.
 */
async function bashLint($: any, line: string): Promise<string | undefined> {
  let texts
  try {
    texts = bashTexts(line)
  } catch (err) {
    return guardFailed($, err)
  }
  for (const text of texts) {
    const args: Record<string, unknown> = {}
    if (text.title !== undefined) args.title = text.title
    if (text.body !== undefined) args.body = text.body
    else if (text.bodyFile !== undefined) {
      try {
        args.body = String(await $.fs.read(await bodyPath($, text.bodyFile)))
      } catch (err) {
        // An unreadable file is gh's to refuse: the command runs unchecked.
        $.ui.log('github: the writing rules could not read ' + text.bodyFile + ' and let the command through: '
          + String((err as any)?.message ?? err))
      }
    }
    const found = lint(text.command, args, lastTyped)
    if (found.length === 0) continue
    const command = text.name.startsWith('gh ') ? text.name.slice('gh '.length) : text.command
    const print = JSON.stringify(['Bash', text.argv, args])
    if (!refusedOnce.has(print)) {
      refusedOnce.add(print)
      return refusal(command, found)
    }
    const rules = [...new Set(found.map((v) => v.rule.split(' (')[0]))].join(', ')
    const refused = await ask($, 'Run ' + text.name + ' through Bash, which breaks the writing rules (' + rules
      + '). Send it as it is?', ['Send as it is', 'Deny'], command)
    if (refused) return refused
  }
  return undefined
}

// The file a --body-file names, as the shell reads it: `~` is HOME, a relative
// path is under the session's directory.
async function bodyPath($: any, file: string): Promise<string> {
  const tilde = /^~(\/|$)/.exec(file)
  if (!tilde && file.startsWith('~')) throw new Error('another user\'s home is not read: ' + file)
  if (!tilde) return normalise(file, String(await $.session.cwd()))
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is unset, ' + file + ' is not read')
  return normalise(String(home) + file.slice(1))
}

async function ask($: any, question: string, options: string[], command: string): Promise<string | undefined> {
  try {
    if ((await $.ui.ask(question, options)) === options[0]) return undefined
  } catch {
    return 'gh ' + command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + command
}

// ---- the guard « writing rules read » ----

/*
 * Every text engine/writing/ governs (a commit, a pull request, a comment, a
 * review) waits until its author read, whole and in the context that writes
 * it, the files that kind of text needs (writingFilesFor). A whole Read of one
 * of the loaded version's files marks it for the reader, the session and the
 * loop within it, and so does a Bash cat or sed -n '1,$p' of it, and, in a
 * checkout of this plugin, a Read of the checkout's copy. A compaction of that
 * loop clears its marks, as the text left its context, and a reload of the
 * module clears them all: both cost one more Read. A failure of the guard
 * itself never holds a text back: the writing rules still run.
 */

// The files each reader holds in its context, by readerKey, and the readers
// whose read could not be marked: a failure of the guard, which lets their
// texts through rather than hold them back for ever.
const readers = new Map<string, Set<WritingFile>>()
const unmarked = new Set<string>()

// The repository whose checkout carries the files as its own engine/writing/.
export const PLUGIN_REPOSITORY = 'lounisbou/claude-github'

function guardFailed($: any, err: any): undefined {
  $.ui.log('github: the writing rules guard failed and let the call through: ' + String(err?.message ?? err))
  return undefined
}

// The session's id, or a throw: an absent or empty one would make every
// session without one the same reader.
async function sessionId($: any): Promise<string> {
  const id = await $.session.id()
  if (typeof id !== 'string' || id === '') throw new Error('the session id is unreadable: ' + String(id))
  return id
}

// The refusal for an authoring command whose reader has not read the files
// its text needs, or undefined: no authoring, a reader who read them, or a
// guard failure.
async function writingUnread($: any, command: string | undefined, agentId?: string): Promise<string | undefined> {
  if (!command) return undefined
  try {
    const key = readerKey(await sessionId($), agentId)
    const read = readers.get(key)
    const missing = writingFilesFor(command).filter((name) => !read?.has(name))
    if (missing.length === 0) return undefined
    if (unmarked.has(key)) return guardFailed($, 'a read of the writing rules could not be marked')
    return unreadRefusal($.plugin.root, command, missing)
  } catch (err) {
    return guardFailed($, err)
  }
}

// The writing file a path is, when this reader may read it for the rules: the
// loaded version's, or the session's checkout's when it is this plugin. Any
// other file costs one string comparison.
async function writingFileOf($: any, path: unknown): Promise<WritingFile | undefined> {
  if (typeof path !== 'string' || !path.includes('writing/')) return undefined
  const dir = String(await $.session.cwd())
  const file = normalise(path, dir)
  const loaded = writingFileAt(file, $.plugin.root)
  if (loaded) return loaded
  const own = writingFileAt(file, dir)
  if (!own) return undefined
  const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  const match = r.exitCode === 0 ? GITHUB_ORIGIN.exec(String(r.stdout).trim()) : null
  return match !== null && (match[1] + '/' + match[2]).toLowerCase() === PLUGIN_REPOSITORY ? own : undefined
}

async function markReader($: any, name: WritingFile, agentId?: string): Promise<void> {
  const key = readerKey(await sessionId($), agentId)
  const read = readers.get(key) ?? new Set<WritingFile>()
  read.add(name)
  readers.set(key, read)
}

// A read that could not be marked: logged, and its reader let through until a
// compaction for the files no earlier read marked.
async function markFailed($: any, err: any, agentId?: string): Promise<void> {
  guardFailed($, err)
  try {
    unmarked.add(readerKey(await sessionId($), agentId))
  } catch {
    // No reader to name: writingUnread fails on the same session id and lets the call through.
  }
}

function failed(result: any): boolean {
  return !result || result.deny !== undefined || result.isError === true
}

function describe(e: any): string {
  const detail = JSON.stringify(e.args ?? {})
  return 'Run gh ' + e.command + ' on ' + (e.repo || 'the origin repository') + ' with '
    + (detail.length > 200 ? detail.slice(0, 199) + '…' : detail)
}

// The writes no session grant covers: a merge and a deletion are asked each
// time, as neither can be taken back.
export const NEVER_GRANTED = new Set(['pr-merge', 'comment-delete'])

// The approval engine/writing/ reserves to the person, asked whatever a rule or
// the mode allows: a pull request is merged only on their word, except in a
// repository they put in auto-merge (autoMerge), where nothing is reserved. The
// description of their own draft is published and edited without asking, under
// the writing rules.
export function reservedToPerson(command: string, autoMerge = false): string | undefined {
  if (autoMerge) return undefined
  if (command === 'pr-merge') return 'Merge a pull request:'
  return undefined
}

// A call that takes a pull request out of draft, or opens one out of draft.
export function leavesDraft(command: string, args: Record<string, unknown>): boolean {
  return command === 'pr-ready' || (command === 'pr-create' && args.draft === false)
}

// The repositories in auto-merge, as owner/name: there no write is put to the
// person. The file is the operator's, in the host's data directory for this
// plugin; it changes only through auto-merge-set, on their quoted word.
export const AUTO_MERGE_FILE = 'auto-merge.json'
// Auto-merge as the operator writes it: « auto-merge », « auto merge », « automerge ».
export const AUTO_MERGE_WORD = /auto[-\s]?merge/i
// The list's path in any plugin's data directory, for the Write and Edit guard.
const AUTO_MERGE_PATH = /\/\.claude\/plugins\/data\/[^/]+\/auto-merge\.json$/
// The E2E exemptions, one file per repository below this directory of the data directory.
const EXEMPT_PATH = new RegExp('/' + EXEMPT_DIR + '(/|$)')
const ANY_EXEMPT_PATH = new RegExp('/\\.claude/plugins/data/[^/]+/' + EXEMPT_DIR + '/')
export const EXEMPT_REFUSAL = 'github: an E2E exemption changes only through mcp__github__record'
  + ' {"repo": "owner/name", "exempt": true|false, "detail": "<the operator\'s words, dated>"}.'

// What a guard's net refuses when the guard itself failed: only what the guard protects, judged
// from the call alone (no state can be read once the hook has thrown); the rest goes through.
export const NET_REFUSAL = 'github: its guard failed on this call, which it protects; nothing was run. Try again, or run /github:doctor.'

// Opening a draft and returning a pull request to draft reach no reviewer and no merge.
const HARMLESS_ACTS: ReadonlySet<string> = new Set(['create-draft', 'redraft'])

export function bashNetRefusal(command: string): string | null {
  try {
    if (touchesRecords(command) || command.includes(AUTO_MERGE_FILE) || command.includes(EXEMPT_DIR + '/')) return NET_REFUSAL
    return bashActs(command).some((act) => !HARMLESS_ACTS.has(act.kind)) ? NET_REFUSAL : null
  } catch {
    // Unreadable: refused only when it may name what the guard protects.
    return /\b(gh|git)\b|pr-records|auto-merge|e2e-exempt/.test(command) ? NET_REFUSAL : null
  }
}

export function writeNetRefusal(path: string): string | null {
  return path.includes('/pr-records/') || path.endsWith('/pr-records') || AUTO_MERGE_PATH.test(path) || EXEMPT_PATH.test(path)
    ? NET_REFUSAL : null
}
export const AUTO_MERGE_REFUSAL = 'github: the auto-merge list changes only through mcp__github__gh auto-merge-set,'
  + ' on the operator\'s words quoted verbatim ({"repo": "owner/name", "on": true|false, "words": "..."});'
  + ' auto-merge-list prints it.'
// The data directory under HOME when the host does not name it.
export const DATA_UNDER_HOME = '/.claude/plugins/data/github-lounisbou'
// The forms of a GitHub origin URL, as engine/ghlib/repo.py reads them.
const GITHUB_ORIGIN = /(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/

// The plugin's data directory: the host's, else the one under HOME, else ''.
async function dataDir($: any): Promise<string> {
  const home = await $.env.get('HOME')
  return (await $.env.get('CLAUDE_PLUGIN_DATA')) || (home ? home + DATA_UNDER_HOME : '')
}

// A list that is there but cannot be read, with its path.
class UnreadList extends Error {
  constructor(readonly path: string, why: string) {
    super(path + ': ' + why)
  }
}

// The file as it stands: its path, its object and its list as written. An
// absent file is an empty list; an unreadable or malformed one throws UnreadList.
async function readAutoMerge($: any): Promise<{ path: string; data: Record<string, unknown>; listed: string[] }> {
  const dir = await dataDir($)
  if (!dir) throw new Error('the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set')
  const path = dir + '/' + AUTO_MERGE_FILE
  if (!(await $.fs.exists(path))) return { path, data: { repositories: [] }, listed: [] }
  let data: any
  try {
    data = JSON.parse(String(await $.fs.read(path)))
  } catch (err: any) {
    throw new UnreadList(path, String(err?.message ?? err))
  }
  const listed = data?.repositories
  if (!Array.isArray(listed) || !listed.every((r) => typeof r === 'string')) {
    throw new UnreadList(path, '"repositories" is not a list of owner/name strings')
  }
  return { path, data, listed }
}

// The listed repositories, lowercased. An absent file lists none, and so does
// an unreadable or malformed one, which also says so in one log line.
async function autoMergeRepos($: any): Promise<Set<string>> {
  try {
    return new Set((await readAutoMerge($)).listed.map((r) => r.trim().toLowerCase()))
  } catch (err: any) {
    if (err instanceof UnreadList) {
      $.ui.log('github: ' + err.path + ' unread, every write is asked: ' + err.message.slice(err.path.length + 2))
    }
    return new Set()
  }
}

// The repository the engine will act on, in its own order. The call's repo is
// passed last as --repo=, so it wins over a repo in its args even when empty;
// an empty or absent one falls through to GH_REPO, then to the checkout's origin.
// Read once per call: the ready guard and the auto-merge check ask for it both.
const targets = new WeakMap<object, Promise<string | undefined>>()

function targetRepo($: any, e: any): Promise<string | undefined> {
  let found = targets.get(e)
  if (!found) {
    found = readTargetRepo($, e)
    targets.set(e, found)
  }
  return found
}

async function readTargetRepo($: any, e: any): Promise<string | undefined> {
  const override = e.repo !== undefined && e.repo !== null ? e.repo : e.args?.repo
  for (const named of [override, await $.env.get('GH_REPO')]) {
    if (named !== undefined && named !== null && String(named) !== '') return String(named)
  }
  const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  const match = r.exitCode === 0 ? GITHUB_ORIGIN.exec(String(r.stdout).trim()) : null
  return match ? match[1] + '/' + match[2] : undefined
}

// Whether a write goes to a repository in auto-merge. Any doubt answers no,
// and the person is asked as before.
async function inAutoMerge($: any, e: any): Promise<boolean> {
  const listed = await autoMergeRepos($)
  if (listed.size === 0) return false
  try {
    const repo = await targetRepo($, e)
    return repo !== undefined && listed.has(repo.trim().toLowerCase())
  } catch {
    return false
  }
}

// Every pull request is opened as a draft unless the call says otherwise,
// and saying otherwise is put to the person (reservedToPerson).
export function withHouseDefaults(command: string, args: Record<string, unknown>): Record<string, unknown> {
  if (command === 'pr-create' && (args.draft === undefined || args.draft === null)) return { ...args, draft: true }
  return args
}

// A grant is the session's, the command's and the repository's: an explicit
// repo by its name, the origin by the directory whose remote it is.
async function grantKey($: any, e: any): Promise<string | undefined> {
  try {
    const session = await $.session.id()
    const repo = e.repo ? 'repo:' + String(e.repo).toLowerCase() : 'origin:' + await $.session.cwd()
    return session + '\n' + e.command + '\n' + repo
  } catch {
    // Without the session or its directory no grant can be scoped: ask.
    return undefined
  }
}

function fingerprint(e: any): string {
  return JSON.stringify([e.command, e.repo ?? '', textFields(e.command, e.args ?? {})])
}

async function prText(
  $: any,
  rawArgs: string,
  command: string,
  format: string,
  shape: (pr: string, out: string) => string = (_pr, out) => out,
): Promise<string> {
  // "#12" is how a PR number is usually written by hand.
  const explicit = (rawArgs ?? '').trim().replace(/^#/, '')
  if (explicit) return shape(explicit, await runGh($, command, { pr: explicit, format }))
  const current = (await runGh($, 'pr-get', { format: 'pr-number' })).trim()
  if (!current) return 'no open PR for this branch'
  return shape(current, await runGh($, command, { pr: current, format }))
}

// checks-status JSON as a line a person reads: "#12 CI: FAILURE (lint, test)".
export function checksLine(pr: string, out: string): string {
  try {
    const status = JSON.parse(out)
    const failed: string[] = status.failed_checks ?? []
    return '#' + pr + ' CI: ' + status.result + (failed.length > 0 ? ' (' + failed.join(', ') + ')' : '')
  } catch {
    return out
  }
}

export type PaneRow = GithubPaneRow

// Each detailed PR costs two engine runs (its checks and its own record,
// which alone carries the comment counts), so only the newest are detailed.
export const DETAILED = 5

// How often the open pane reads its PRs again, for CI and review counts that
// change with nobody asking: one pr-list and two runs per detailed PR, well
// under GitHub's hourly limit.
export const WATCH_MS = 60_000

// The pane's rows live in the session's state: a reload of the module keeps
// them, and a write redraws the pane with nobody invalidating it.
const pane = atom({ plugin: 'github', key: 'pane' } as const, { rows: [], error: null, refreshing: false } as GithubPane)

// Names this module registered; a taken name is left to its owner.
const ownedCommands = new Set<string>()
// The heads this session pushed: its review of one of them is no review (method, « review on evidence »).
const pushedHeads = new Set<string>()

// A review record refused when the session writing it pushed the head it reviews.
export function selfReviewRefusal(kind: string, head: string, pushed: ReadonlySet<string>): string | null {
  if (kind !== 'review' || !pushed.has(head)) return null
  return 'github: this session pushed ' + head.slice(0, 7) + ': a review is made by another session, never by the one that'
    + ' wrote or pushed the code. Run the review from another session (implement: /implement:review).'
}
// The last prompt the user typed (at the terminal or through the bridge): a
// text found in it verbatim is the user's own words, never refused.
let lastTyped = ''
// The texts refused once: the same text sent again goes to the person.
const refusedOnce = new Set<string>()
// The grants « Allow for this session » gave, by session, command and repository.
// Kept in the module: a reload or a restart drops them, which only asks again.
const sessionGrants = new Set<string>()
let refreshing = false
// The timer reading the PRs while the pane is open.
let watch: { cancel: () => void } | undefined

// The width of the label column: CI:SUCCESS, CI:FAILURE and CI:PENDING.
const LABEL_COLUMN = 10

function ciColor(ci: string): string {
  if (ci === 'SUCCESS') return 'success'
  if (ci === 'FAILURE') return 'error'
  if (ci === 'PENDING') return 'warning'
  return 'inactive'
}

async function detail($: any, pr: number): Promise<{ ci: string; failed: string[]; comments: number | null }> {
  const [checks, status] = await Promise.allSettled([
    runGh($, 'pr-checks', { pr, format: 'checks-status' }),
    runGh($, 'pr-status', { pr }),
  ])
  let ci = '?'
  let failed: string[] = []
  let comments: number | null = null
  try {
    if (checks.status === 'fulfilled') {
      const parsed = JSON.parse(checks.value)
      ci = String(parsed.result)
      failed = Array.isArray(parsed.failed_checks) ? parsed.failed_checks.map(String) : []
    }
  } catch {
    // Unreadable checks stay "?": never shown as a state they are not.
  }
  try {
    if (status.status === 'fulfilled') {
      const pull = JSON.parse(status.value)
      comments = (pull.comments ?? 0) + (pull.review_comments ?? 0)
    }
  } catch {
    // Unreadable record: no count shown.
  }
  return { ci, failed, comments }
}

async function collectRows($: any): Promise<PaneRow[]> {
  const prs = JSON.parse(await runGh($, 'pr-list')) as any[]
  const details = await Promise.all(
    prs.slice(0, DETAILED).map((p) => detail($, Number(p.number))),
  )
  return prs.map((p, i) => ({
    number: p.number,
    title: String(p.title ?? ''),
    url: String(p.html_url ?? ''),
    draft: Boolean(p.draft),
    comments: details[i]?.comments ?? null,
    ci: details[i]?.ci ?? '–',
    failed: details[i]?.failed ?? [],
  }))
}

// The CI changes worth a toast between two reads: a PR read in both whose
// checks came to an end (SUCCESS or FAILURE) or changed from one end to the
// other. A first read, an unreadable one and a PR new to the list say nothing.
export function ciTransitions(before: PaneRow[], after: PaneRow[]): string[] {
  const old = new Map(before.map((r) => [r.number, r.ci]))
  const lines: string[] = []
  for (const r of after) {
    const was = old.get(r.number)
    if (was === undefined || was === r.ci) continue
    if (was === '?' || was === '–') continue
    if (r.ci !== 'SUCCESS' && r.ci !== 'FAILURE') continue
    lines.push('#' + r.number + ' CI: ' + r.ci + (r.failed.length > 0 ? ' (' + r.failed.join(', ') + ')' : ''))
  }
  return lines
}

async function refresh($: any): Promise<void> {
  if (refreshing) return
  refreshing = true
  await update($, pane, (p) => ({ ...p, refreshing: true }))
  try {
    const before = (await read($, pane)).rows
    const rows = await collectRows($)
    await update($, pane, (p) => ({ ...p, rows, error: null }))
    for (const line of ciTransitions(before, rows)) $.ui.toast(line)
  } catch (err: any) {
    // The rows from the last good read stay on screen under the error.
    const error = String(err?.message ?? err).trim()
    await update($, pane, (p) => ({ ...p, error }))
  } finally {
    refreshing = false
    await update($, pane, (p) => ({ ...p, refreshing: false }))
  }
}

// One timer while the pane is open; a reload of the module cancels it with
// the old copy, and the next /prs or Refresh starts it again.
function startWatch($: any): void {
  if (watch) return
  watch = $.clock.every(WATCH_MS, () => {
    void refresh($)
  })
}

function stopWatch(): void {
  watch?.cancel()
  watch = undefined
}

function clip(text: string, max: number): string {
  const room = Math.max(1, max)
  return text.length > room ? text.slice(0, room - 1) + '…' : text
}

// install.sh's exit codes, the table commands/doctor.md gives in prose.
export const DIAGNOSTIC: Record<number, string> = {
  0: 'everything satisfied',
  11: 'a system tool is missing: install python3 (3.9+) or curl',
  12: 'no GitHub token: run /github:install',
  14: 'GitHub sign-in started: enter the code above in the browser, then run /github:doctor',
}

// install.sh run in the session's directory, its output verbatim and its exit
// code named. /github:install lets it install gh and start the browser
// sign-in, which can take minutes; /github:doctor only checks (--check).
export async function diagnose($: any, check = false): Promise<string> {
  const argv = ['bash', $.plugin.root + '/install.sh', ...(check ? ['--check'] : [])]
  const r = await $.process.run(argv, { timeoutMs: check ? 60_000 : 600_000 })
  const out = [r.stdout, r.stderr].map((t: string) => (t ?? '').trimEnd()).filter(Boolean).join('\n')
  const meaning = DIAGNOSTIC[r.exitCode] ?? 'an unexpected failure'
  return out + '\n\nExit code ' + r.exitCode + ': ' + meaning + '.'
}

// ---- the ready guard and the auto-merge split ----

/*
 * A pull request is ready when a clean review, a passed norms check, passed
 * E2E and green CI all stand at its current head (engine/writing/pull-requests.md « Ready
 * pull requests »). Marking it Ready, taking it out of draft and merging it
 * need the four, through the tool and through Bash alike. Under the warn
 * phase an act that is not ready goes ahead with one warn line, under the
 * enforce phase it is refused. In a repository not in auto-merge, leaving
 * draft is refused on every route, and a merge is refused through Bash: the
 * tool asks the person for it. A pull request that carries Not Ready and none
 * of whose checks has passed yet may leave draft for its CI to run, still Not
 * Ready, in every repository.
 */

// The phase this release ships with.
export const READY_PHASE: Phase = 'warn'
// Set to 1 in the environment, it brings the enforce phase forward. It only
// ever tightens: no variable turns a release's enforce phase back to warn.
export const ENFORCE_ENV = 'CLAUDE_GITHUB_READY_ENFORCE'

async function phaseOf($: any): Promise<Phase> {
  if (READY_PHASE === 'enforce') return 'enforce'
  try {
    return (await $.env.get('CLAUDE_GITHUB_READY_ENFORCE')) === '1' ? 'enforce' : 'warn'
  } catch {
    return READY_PHASE
  }
}

export const RECORD_TOOL = 'mcp__github__record'
export const WARN_LOG = 'guard-warn.log'

// A line in the transcript that never fails what it reports on.
function note($: any, text: string): void {
  try {
    const sent = $.ui.log(text)
    if (sent && typeof sent.catch === 'function') sent.catch(() => undefined)
  } catch {
    // Nowhere to say it: the act it notes is not held for that.
  }
}

async function configDir($: any): Promise<string | undefined> {
  const named = await $.env.get('CLAUDE_CONFIG_DIR')
  if (named) return String(named)
  const home = await $.env.get('HOME')
  return home ? home + '/.claude' : undefined
}

// ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records, or undefined when unreadable.
async function recordsRoot($: any): Promise<string | undefined> {
  try {
    const dir = await configDir($)
    return dir ? dir + '/pr-records' : undefined
  } catch {
    return undefined
  }
}

// A head's records directory that is there but cannot be listed.
class RecordsUnread extends Error {}

// The records of a pull request's head, as files. A directory that is not there
// holds none; one that cannot be listed throws RecordsUnread, never read as none.
// A file that cannot be read is one that does not parse.
async function headRecords($: any, gate: Gate): Promise<RecordFile[]> {
  const root = await recordsRoot($)
  if (!root) return []
  const dir = root + '/' + gate.repo.toLowerCase() + '/' + gate.head
  let entries: any[]
  try {
    entries = await $.fs.list(dir)
  } catch (err: any) {
    let absent = false
    try {
      absent = !(await $.fs.exists(dir))
    } catch {
      // Unknown: not read as absent.
    }
    if (absent) return []
    throw new RecordsUnread('the records of ' + gate.head.slice(0, 7) + ' cannot be listed: ' + String(err?.message ?? err).trim())
  }
  const files: RecordFile[] = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (entry?.kind === 'directory' || name.startsWith('.') || !name.endsWith('.json')) continue
    let text = ''
    try {
      text = String(await $.fs.read(dir + '/' + name))
    } catch {
      // Left empty: it is named as unreadable.
    }
    files.push({ name, text })
  }
  return files
}

/*
 * The CI undrafts the plugin made itself, kept in the data directory: the same account takes a pull
 * request out of draft for the operator, so GitHub cannot say which one this was. The gate puts a
 * pull request back to draft only when one is marked, and a mark is written only for a pull request
 * that was in draft when the plugin took it out of it. The mark covers the pull request across pushes
 * for as long as the gate reads it open and out of draft; it is spent (rewritten with no head) when
 * the gate redrafts, and when it reads the pull request in draft or closed. One small file per pull
 * request, replaced whole, so no write reads another's. The head in it is the one the undraft was made at.
 */
export const CI_UNDRAFT_PREFIX = 'ci-undraft.'

// The mark's file: the repository (lowercase, encoded) and the pull request number.
async function ciUndraftPath($: any, repo: string, pr: number): Promise<string | undefined> {
  const dir = await dataDir($)
  return dir ? dir + '/' + CI_UNDRAFT_PREFIX + encodeURIComponent(repo.toLowerCase()) + '.' + pr + '.json' : undefined
}

// The head the pull request was undrafted at for CI, or '' when it was not or the mark is spent or unreadable.
async function ciUndraftHead($: any, repo: string, pr: number): Promise<string> {
  try {
    const path = await ciUndraftPath($, repo, pr)
    if (!path || !(await $.fs.exists(path))) return ''
    const head = JSON.parse(String(await $.fs.read(path)))?.head
    return typeof head === 'string' ? head : ''
  } catch {
    return ''
  }
}

async function writeCiUndraft($: any, repo: string, pr: number, head: string): Promise<void> {
  const path = await ciUndraftPath($, repo, pr)
  if (!path) throw new Error('the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set')
  await $.fs.write(path, JSON.stringify({ v: 1, repo: repo.toLowerCase(), pr, head }) + '\n')
}

async function ciUndraftMarked($: any, repo: string, pr: number): Promise<boolean> {
  return await ciUndraftHead($, repo, pr) !== ''
}

// Spends the mark, written only when there is one.
async function dropCiUndraft($: any, repo: string, pr: number): Promise<void> {
  if (await ciUndraftHead($, repo, pr) !== '') await writeCiUndraft($, repo, pr, '')
}

// A mark that cannot be kept only means the gate will not redraft: said in one line.
async function noteCiUndraft($: any, repo: string, pr: number, head: string | undefined): Promise<void> {
  note($, ciUndraftLine(repo, pr))
  if (!head) return
  try {
    await writeCiUndraft($, repo, pr, head)
  } catch (err: any) {
    note($, 'github: ' + repo + '#' + pr + ' out of draft to run CI is not marked, the gate will leave it out of draft: ' + String(err?.message ?? err).trim())
  }
}

// ---- E2E a pull request does not need (e2e-scope.ts) ----

// The files of a pull request, or a throw: never read as none.
async function prFiles($: any, repo: string, pr: number): Promise<PrFile[]> {
  return parsePrFiles(await runGh($, 'pr-files', { pr }, repo))
}

// The repository's exemption file as it stands, or undefined when there is none or it cannot be read.
async function readExemption($: any, repo: string): Promise<Exemption | undefined> {
  try {
    const dir = await dataDir($)
    if (!dir) return undefined
    const path = exemptionPath(dir, repo)
    if (!(await $.fs.exists(path))) return undefined
    return parseExemption(JSON.parse(String(await $.fs.read(path))))
  } catch {
    return undefined
  }
}

// The line of the operator's exemption that covers this pull request, or undefined. Any doubt (a
// file or a list of files that cannot be read) covers nothing: the E2E record is asked as before.
async function e2eExemptionOf($: any, gate: Gate): Promise<string | undefined> {
  const exemption = await readExemption($, gate.repo)
  if (!exemption?.exempt) return undefined
  let files: PrFile[] | undefined
  if (exemption.paths.length > 0) files = await prFiles($, gate.repo, Number(gate.pr)).catch(() => undefined)
  return covers(exemption, gate.labels, files) ? exemptionLine(exemption) : undefined
}

type Readiness = { gate?: Gate; missing: string[]; error?: string }

// What a pull request misses at its head, read from GitHub and the records.
async function readiness($: any, repo: string, pr: number, sha?: string): Promise<Readiness> {
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return { missing: [], error: String(err?.message ?? err).trim() }
  }
  let files: RecordFile[]
  try {
    files = await headRecords($, gate)
  } catch (err: any) {
    if (err instanceof RecordsUnread) return { gate, missing: [], error: err.message }
    throw err
  }
  return { gate, missing: missingItems(gate, files, sha, await e2eExemptionOf($, gate)) }
}

/*
 * The Ready label follows the gate: whenever the module learns something that can complete or
 * break readiness (a record written, the gate or the checks read through the tool), it reads the
 * four at the head and puts Ready, or Not Ready back on a pull request carrying Ready. The head is
 * read again just before the write, and a head that moved meanwhile gets no label. Outside
 * auto-merge Ready lands on a draft: a pull request the plugin took out of draft for its CI goes back first. The
 * labels the gate leaves (labels, draft) when it wrote, and the line it says, or none: always
 * names what is missing too. It never fails the call it follows.
 */
type Followed = { line?: string; labels?: string[]; draft?: boolean }

async function followGate($: any, repo: string, pr: number, known?: Gate, always = false): Promise<Followed> {
  let gate: Gate
  let missing: string[]
  let exempt: string | undefined
  try {
    gate = known ?? parseGate(await runGh($, 'pr-gate', { pr }, repo))
    exempt = await e2eExemptionOf($, gate)
    missing = missingItems(gate, await headRecords($, gate), undefined, exempt)
  } catch (err: any) {
    return { line: gateLeftLine(repo, pr, String(err?.message ?? err).trim()) }
  }
  // A pull request in draft or closed is no CI undraft any more: its mark is dropped.
  if (gate.draft || gate.state !== 'open') await dropCiUndraft($, repo, pr).catch(() => undefined)
  const move = labelMove(gate, missing)
  if (!move) {
    if (always && gate.state === 'open' && missing.length > 0) return { line: gateMissingLine(repo, pr, gate.head, missing) }
    return {}
  }
  let now: Gate
  try {
    now = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return { line: gateLeftLine(repo, pr, String(err?.message ?? err).trim()) }
  }
  if (now.head !== gate.head) return { line: gateMovedLine(repo, pr, gate.head, now.head) }
  const redraft = move === 'ready' && !now.draft && !(await autoMergeRepos($)).has(repo.toLowerCase())
    && await ciUndraftMarked($, repo, pr)
  try {
    if (redraft) {
      await runGh($, 'pr-draft', { pr }, repo)
      await dropCiUndraft($, repo, pr).catch(() => undefined)
    }
    await runGh($, 'pr-readiness', { pr, state: move }, repo)
  } catch (err: any) {
    return { line: gateUnwrittenLine(repo, pr, String(err?.message ?? err).trim()) }
  }
  const labels = [...now.labels.filter((label) => ![READY, NOT_READY].includes(label.toLowerCase())), move === 'ready' ? 'Ready' : 'Not Ready']
  const draft = redraft || now.draft
  if (move === 'ready') return { line: gateReadyLine(repo, pr, gate.head, redraft, exempt), labels, draft }
  return { line: gateNotReadyLine(repo, pr, gate.head, missing), labels, draft }
}

// The reads after which the gate puts the label.
const GATE_READS = new Set(['pr-gate', 'pr-checks'])

// A read's output once the gate followed it. Its line is the module's own, never in the output;
// pr-gate's JSON says the labels and the draft the gate left.
async function afterRead($: any, e: any, output: string): Promise<string> {
  if (!GATE_READS.has(e.command)) return output
  const pr = Number(String(e.args?.pr ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return output
  const repo = await targetRepo($, e).catch(() => undefined)
  if (!repo) return output
  let known: Gate | undefined
  if (e.command === 'pr-gate') {
    try {
      known = parseGate(output)
    } catch {
      return output
    }
  }
  const followed = await followGate($, repo, pr, known)
  if (followed.line) note($, followed.line)
  if (!known || !followed.labels) return output
  return JSON.stringify({ ...known, labels: followed.labels, draft: followed.draft }, null, 2)
}

// A line added at the end of a file, the file created when absent. $.fs only
// rewrites a file whole: a file already there is appended to by the shell, so
// a read that fails or another session's line in between loses nothing.
async function appendLine($: any, path: string, text: string): Promise<void> {
  let present = true
  try {
    await $.fs.stat(path)
  } catch {
    present = false
  }
  if (!present) {
    await $.fs.write(path, text)
    return
  }
  const r = await $.process.run(['sh', '-c', 'cat >> "$1"', 'sh', path], { stdin: text, timeoutMs: 10_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr || 'the append exited ' + r.exitCode)
}

// One transcript line and one JSON line in the plugin's guard-warn.log.
async function warnAct(
  $: any, act: Act, route: 'tool' | 'bash', repo: string, pr: number | string, head: string, missing: string[],
): Promise<void> {
  note($, warnLine(act.name, repo, pr, missing))
  try {
    const dir = await dataDir($)
    if (!dir) return
    const path = dir + '/' + WARN_LOG
    let session = ''
    try {
      session = String(await $.session.id() ?? '')
    } catch {
      // Logged without it.
    }
    const line = { at: new Date().toISOString(), session, repo, pr, head, act: act.name, route, missing }
    await appendLine($, path, JSON.stringify(line) + '\n')
  } catch {
    // The transcript line stands for it.
  }
}

async function labelNotReady($: any, repo: string, pr: number): Promise<void> {
  await runGh($, 'pr-readiness', { pr, state: 'not-ready' }, repo)
}

// The number of the open pull request of a branch, the current one when none
// is named, or undefined.
async function prOfBranch($: any, repo: string, branch?: string): Promise<number | undefined> {
  const pulls = JSON.parse(await runGh($, 'pr-get', branch ? { branch } : {}, repo))
  const pull = Array.isArray(pulls) ? pulls.find((p: any) => p && p.number) : undefined
  return pull ? Number(pull.number) : undefined
}

// The enforce phase's refusal, which also takes Ready off a pull request
// that still carries it, so the label never claims what the guard refused.
async function refuseNotReady($: any, act: Act, repo: string, pr: number, r: Readiness): Promise<string> {
  const gate = r.gate as Gate
  if (carriesReady(gate)) {
    try {
      await labelNotReady($, repo, pr)
    } catch (err: any) {
      note($, 'github: ' + repo + '#' + pr + ' keeps Ready, the label could not be changed: ' + String(err?.message ?? err))
    }
  }
  return notReadyRefusal(act.name, repo, pr, gate.head, r.missing)
}

// The Bash ready guard failed on its own: under warn the command goes on with
// a warn line, under enforce it is refused as a readiness that could not be read.
// A Ready label is refused so in both phases: it is the gate's.
// An undraft outside auto-merge is refused on the list first, in both phases: only a CI
// undraft passes there, and the failed read cannot tell whether this is one.
async function guardThrew($: any, act: Act | undefined, err: any): Promise<string | undefined> {
  const error = String(err?.message ?? err).trim()
  if (act?.opaque) return opaqueGraphqlRefusal()
  if (act?.kind === 'undraft' && act.repo && !(await autoMergeRepos($)).has(act.repo.toLowerCase())) {
    return autoMergeRefusal('undraft', act.repo, act.pr, engineName(act))
  }
  if (act?.kind === 'ready-label' || await phaseOf($) === 'enforce') return unverifiedRefusal(act?.repo, act?.pr, error)
  const named: Act = act ?? { kind: 'merge', name: 'the command' }
  await warnAct($, named, 'bash', act?.repo ?? '?', act?.pr ?? '?', '', ['readiness unverified: ' + error])
  return undefined
}

// The tool's act: checked before any question under enforce, and once it goes
// ahead under warn. A CI undraft runs as pr-ready --for-ci, which keeps Not Ready.
function toolReady($: any, e: any, act: Act) {
  let read: Readiness | undefined
  let forCi = false
  const repoPr = async (): Promise<{ repo?: string; pr?: number }> => {
    let repo: string | undefined
    try {
      repo = await targetRepo($, e)
    } catch {
      repo = undefined
    }
    return { repo, pr: act.pr !== undefined && Number.isFinite(act.pr) ? act.pr : undefined }
  }
  // undefined when the act may go on; else what it misses, or why that is unknown.
  const evaluate = async (): Promise<{ repo: string; pr: number | string; r: Readiness } | undefined> => {
    const { repo, pr } = await repoPr()
    if (!repo || pr === undefined) {
      return { repo: repo ?? 'the origin repository', pr: pr ?? '?', r: { missing: [], error: 'no repository or pull request named' } }
    }
    try {
      read = read ?? await readiness($, repo, pr, act.sha)
      if (act.kind === 'undraft' && read.gate && ciUndraft(read.gate)) {
        forCi = true
        e.args = { ...e.args, 'for-ci': true }
        return undefined
      }
    } catch (err: any) {
      // The guard's own failure reads as a readiness that could not be read.
      read = { missing: [], error: String(err?.message ?? err).trim() }
    }
    if (read.error || read.missing.length > 0) return { repo, pr, r: read }
    return undefined
  }
  const gated = act.kind === 'merge' || act.kind === 'undraft' || act.kind === 'ready-label'
  return {
    async beforeAsk(): Promise<string | undefined> {
      // A Ready label is the gate's in both phases; the other acts only under enforce.
      const enforce = await phaseOf($) === 'enforce'
      if (act.kind === 'create') return enforce ? draftRefusal(act.name) : undefined
      if (!gated || (!enforce && act.kind !== 'ready-label')) return undefined
      const found = await evaluate()
      if (!found) return undefined
      if (found.r.error) return unverifiedRefusal(found.repo, found.pr, found.r.error)
      try {
        return await refuseNotReady($, act, found.repo, Number(found.pr), found.r)
      } catch (err: any) {
        return unverifiedRefusal(found.repo, found.pr, String(err?.message ?? err).trim())
      }
    },
    // Whether this is an undraft for CI, read in both phases.
    async ciUndraft(): Promise<boolean> {
      if (act.kind !== 'undraft') return false
      await evaluate()
      return forCi
    },
    async goingAhead(): Promise<void> {
      if (await phaseOf($) !== 'warn') return
      if (act.kind === 'create') {
        const { repo } = await repoPr()
        await warnAct($, act, 'tool', repo ?? 'the origin repository', '?', '', ['opened out of draft'])
        return
      }
      if (!gated) return
      const found = await evaluate()
      if (!found) return
      const missing = found.r.error ? ['readiness unverified: ' + found.r.error] : found.r.missing
      await warnAct($, act, 'tool', found.repo, found.pr, found.r.gate?.head ?? '', missing)
    },
    async ran(): Promise<void> {
      if (!forCi) return
      const { repo, pr } = await repoPr()
      // Marked only when the gate read it in draft: out of draft already, it was not the plugin's undraft.
      if (repo && pr !== undefined) await noteCiUndraft($, repo, pr, read?.gate?.draft ? read.gate.head : undefined)
    },
  }
}

// The engine's own name for an act run through gh.py, which its refusals keep;
// a gh act is named by the gh command of its kind.
function engineName(act: Act): string | undefined {
  return act.name.startsWith('gh.py ') ? act.name : undefined
}

// The Bash act's refusal, or undefined; what must follow its success goes in after.
async function bashReady($: any, act: Act, after: Array<(result: any) => Promise<void>>): Promise<string | undefined> {
  // A Ready label is the gate's: refused in both phases when the four do not hold.
  const readyPhase: Phase = act.kind === 'ready-label' ? 'enforce' : await phaseOf($)
  if (act.stdin) return STDIN_REFUSAL
  if (act.kind === 'create') {
    if (readyPhase === 'enforce') return draftRefusal(act.name)
    // Opening out of draft is leaving draft: outside auto-merge it is refused, as
    // gh pr ready is, on every route.
    if (!act.repo) return unnamedRepoRefusal(act.name)
    if (!(await autoMergeRepos($)).has(act.repo.toLowerCase())) return autoMergeRefusal('create', act.repo, undefined, engineName(act))
    await warnAct($, act, 'bash', act.repo, '?', '', ['opened out of draft'])
    return undefined
  }
  if (act.kind === 'create-draft') {
    after.push(async (result) => {
      const made = createdPr(stdoutOf(result))
      if (made) await labelNotReady($, made.repo, made.pr)
      else note($, 'github: the new draft keeps its labels: gh pr create printed no pull request URL')
    })
    return undefined
  }
  if (act.kind === 'redraft') {
    after.push(async () => {
      const pr = act.repo ? act.pr ?? await prOfBranch($, act.repo, act.branch) : undefined
      if (act.repo && pr !== undefined) await labelNotReady($, act.repo, pr)
      else note($, 'github: the pull request back in draft keeps its labels: name it with -R owner/name and its number')
    })
    return undefined
  }
  if (act.opaque) {
    // An unread query may leave draft or merge: refused outside auto-merge, read as an
    // unverified readiness inside it. gh api names the origin's repository, or GH_REPO's.
    const origin = await targetRepo($, { repo: undefined, args: {} })
    if (!origin || !(await autoMergeRepos($)).has(origin.toLowerCase())) return opaqueGraphqlRefusal()
    const why = 'the GraphQL query cannot be read from the command'
    if (readyPhase === 'enforce') return unverifiedRefusal(origin, undefined, why)
    await warnAct($, act, 'bash', origin, '?', '', ['readiness unverified: ' + why])
    return undefined
  }
  if (act.unnamed) return graphqlRefusal(act.kind)
  if (act.unreadable) return unreadablePrRefusal(act.name)
  if (!act.repo) {
    // A merge, leaving draft and the Ready label are refused in both phases:
    // the auto-merge split and the gate need the repository.
    return unnamedRepoRefusal(act.name)
  }
  const repo = act.repo
  const listed = act.kind === 'ready-label' ? false : (await autoMergeRepos($)).has(repo.toLowerCase())
  if (act.kind === 'merge' && !listed) return autoMergeRefusal('merge', repo, act.pr, engineName(act))
  let pr = act.pr
  let lookup = ''
  if (pr === undefined) {
    try {
      pr = await prOfBranch($, repo, act.branch)
      if (pr === undefined) lookup = 'no open pull request for ' + (act.branch ?? 'the current branch')
    } catch (err: any) {
      lookup = String(err?.message ?? err).trim()
    }
  }
  const r: Readiness = pr === undefined ? { missing: [], error: lookup } : await readiness($, repo, pr, act.sha)
  if (act.kind === 'undraft') {
    // The engine leaves draft for CI only when told to (--for-ci): without it, it puts Ready on.
    if (r.gate && ciUndraft(r.gate) && pr !== undefined && act.forCi !== false) {
      const n = pr
      const head = r.gate.draft ? r.gate.head : undefined
      after.push(() => noteCiUndraft($, repo, n, head))
      return undefined
    }
    if (!listed) return autoMergeRefusal('undraft', repo, pr, engineName(act))
  }
  const shown = pr ?? '?'
  if (r.error) {
    if (readyPhase === 'enforce') return unverifiedRefusal(repo, shown, r.error)
    await warnAct($, act, 'bash', repo, shown, '', ['readiness unverified: ' + r.error])
    return undefined
  }
  if (r.missing.length > 0) {
    if (readyPhase === 'enforce') return refuseNotReady($, act, repo, Number(pr), r)
    await warnAct($, act, 'bash', repo, shown, r.gate?.head ?? '', r.missing)
  }
  return undefined
}

function stdoutOf(result: any): string {
  const out = result?.result
  if (typeof out === 'string') return out
  return String(out?.stdout ?? '')
}

// A push moves the head of the branches it names: a pull request of theirs
// that carries Ready goes back to Not Ready. A branch or a repository read
// with any doubt is left alone, with one line saying so.
// After a push this session ran, its checkout's head is one it pushed.
async function notePushedHead($: any, line: string): Promise<void> {
  try {
    if (bashPushes(line).pushes.length === 0) return
    const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
    if (head.exitCode === 0) pushedHeads.add(String(head.stdout).trim().toLowerCase())
  } catch {
    // Unread: the head is not known as pushed here.
  }
}

async function followPushes($: any, line: string): Promise<void> {
  const { pushes, moves } = bashPushes(line)
  for (const push of pushes) {
    try {
      const byUrl = push.remote !== undefined && GITHUB_ORIGIN.test(push.remote)
      if (push.unsure || (moves && (push.current !== undefined || !byUrl))) {
        note($, 'github: the labels are left as they are after the push: ' + (push.unsure ?? 'the command changes directory first'))
        continue
      }
      let remote = push.remote
      const branches = [...push.branches]
      if (push.current === 'upstream') {
        const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 10_000 })
        const upstream = r.exitCode === 0 ? String(r.stdout).trim() : ''
        const slash = upstream.indexOf('/')
        if (slash <= 0) {
          note($, 'github: the labels are left as they are after the push: the current branch has no upstream')
          continue
        }
        remote = upstream.slice(0, slash)
        branches.push(upstream.slice(slash + 1))
      } else if (push.current === 'branch') {
        const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
        const branch = r.exitCode === 0 ? String(r.stdout).trim() : ''
        if (!branch || branch === 'HEAD') {
          note($, 'github: the labels are left as they are after the push: the current branch cannot be read')
          continue
        }
        branches.push(branch)
      }
      let url = remote ?? ''
      if (!GITHUB_ORIGIN.test(url)) {
        const r = await $.process.run(['git', 'remote', 'get-url', url], { timeoutMs: 10_000 })
        url = r.exitCode === 0 ? String(r.stdout).trim() : ''
      }
      const match = GITHUB_ORIGIN.exec(url)
      if (!match) {
        note($, 'github: the labels are left as they are after the push: ' + (remote ?? 'its remote') + ' is no GitHub repository')
        continue
      }
      const repo = match[1] + '/' + match[2]
      for (const branch of branches) {
        const pulls = JSON.parse(await runGh($, 'pr-get', { branch }, repo))
        for (const pull of Array.isArray(pulls) ? pulls : []) {
          const labels = (pull?.labels ?? []).map((l: any) => String(l?.name ?? l).toLowerCase())
          if (!labels.includes('ready')) continue
          await labelNotReady($, repo, Number(pull.number))
          note($, 'github: ' + repo + '#' + pull.number + ' back to Not Ready after the push to ' + branch)
        }
      }
    } catch (err: any) {
      note($, 'github: the labels could not be read after the push: ' + String(err?.message ?? err))
    }
  }
}

// ---- the operator's word ----

// The prompts the person typed in this session, at the terminal or through the bridge, a prompt
// typed while the session worked included, each with the day it was received: an E2E waiver and
// auto-merge-set quote them.
const typedPrompts: Array<{ text: string; day: string }> = []
const TYPED_KEPT = 200

// A text with its runs of whitespace made one space: a quote keeps the words, not the line breaks.
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// The machine's own day, YYYY-MM-DD, of a moment in milliseconds: the date a record carries.
function dayOf(ms: number): string {
  const at = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return at.getFullYear() + '-' + two(at.getMonth() + 1) + '-' + two(at.getDate())
}

// A prompt received while the clock cannot be read is kept without a day: it proves a quote
// undated, and no date.
function keepTyped(text: string, now: number | undefined): void {
  typedPrompts.push({ text, day: now === undefined ? '' : dayOf(now) })
  if (typedPrompts.length > TYPED_KEPT) typedPrompts.shift()
}

const QUOTED_SPAN = /«([^»]*)»|"([^"]*)"|“([^”]*)”/g
const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/g

// What a quote must say to carry a record: its words name it.
type Quoting = {
  // The date the text carries is the day the message was received, and the only one.
  dated: boolean
  // Each quoted span names the subject, itself.
  names: (span: string) => boolean
  // A span that is the whole message needs not name it.
  wholeBare: boolean
}

// True when a text is the person's words: the text whole found in a prompt they typed; else, when
// it wraps quotes (« … » — operator, date), every quoted span found in one prompt, each naming the
// subject in itself, and the day that prompt was received the only date the text carries when it is
// dated. A span shorter than a consent quote proves nothing unless it is the whole prompt.
function typedWords(text: string, quoting: Quoting): boolean {
  const whole = spaced(text)
  if (whole === '') return false
  if (typedPrompts.some((p) => spaced(p.text).includes(whole))) return true
  const spans = [...text.matchAll(QUOTED_SPAN)].map((m) => spaced(m[1] ?? m[2] ?? m[3] ?? '')).filter((s) => s !== '')
  if (spans.length === 0) return false
  const days = text.match(ISO_DAY) ?? []
  return typedPrompts.some((p) => {
    const sent = spaced(p.text)
    const quoted = spans.every((span) => {
      if (span.length < CONSENT_QUOTE_MIN ? span !== sent : !sent.includes(span)) return false
      return (quoting.wholeBare && span === sent) || quoting.names(span)
    })
    return quoted && (!quoting.dated || (days.length > 0 && days.every((d) => d === p.day)))
  })
}

// An E2E waiver of a pull request: each quoted span names the waiver or the pull request.
function waiverQuoting(pr: number): Quoting {
  const names = new RegExp('E2E|end[-\\s]to[-\\s]end|bout[-\\s]en[-\\s]bout|tests?\\b|dispens|waiv|(?<![\\d])' + pr + '(?![\\d])', 'i')
  return { dated: true, names: (span) => names.test(span), wholeBare: true }
}

// The consent records of a repository (core's consent-record.ts): read-only here, the newest files only.
const CONSENT_READ = 200

// True when some consent record of the subject, written for the operator's answer to the
// question that asked it, is quoted whole in the text, its whitespace normalised. A directory or
// a file that cannot be read matches nothing.
async function consentAnswered($: any, quote: string, subject: ConsentSubject): Promise<boolean> {
  try {
    const dir = await configDir($)
    if (!dir) return false
    const root = consentDir(dir, subject.repo)
    const dated: Array<{ path: string; mtime: number }> = []
    for (const entry of await $.fs.list(root)) {
      const name = String(entry?.name ?? '')
      if (entry?.kind === 'directory' || name.startsWith('.') || !name.endsWith('.json')) continue
      try {
        dated.push({ path: root + '/' + name, mtime: Number((await $.fs.stat(root + '/' + name)).mtimeMs) })
      } catch {
        // Not a match.
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const { path } of dated.slice(0, CONSENT_READ)) {
      try {
        const record = parseConsentRecord(JSON.parse(String(await $.fs.read(path))))
        if (record && quotesConsent(record, subject, quote)) return true
      } catch {
        // Not a match.
      }
    }
  } catch {
    // No records: no match.
  }
  return false
}

// ---- auto-merge on the operator's word ----

// Whether a Bash command line names the list where it lives: its file name
// with the plugin's data directory, any plugin's, or the variable naming it.
// The name alone, in this plugin's sources or a message, is no path.
async function touchesAutoMerge($: any, line: string): Promise<boolean> {
  if (!line.includes(AUTO_MERGE_FILE)) return false
  const dir = await dataDir($)
  return (dir !== '' && line.includes(dir)) || /plugins\/data\/|CLAUDE_PLUGIN_DATA|github-lounisbou/.test(line)
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Whether a Bash command line names the exemption files where they live, as touchesAutoMerge reads the list.
async function touchesExemptions($: any, line: string): Promise<boolean> {
  if (!line.includes(EXEMPT_DIR)) return false
  const dir = await dataDir($)
  return (dir !== '' && line.includes(dir)) || /plugins\/data\/|CLAUDE_PLUGIN_DATA|github-lounisbou/.test(line)
}

// The list, one repository per line as written.
async function listAutoMerge($: any): Promise<string> {
  const { listed } = await readAutoMerge($)
  return listed.length > 0 ? listed.join('\n') : 'no repository in auto-merge'
}

// The refusal of an auto-merge-set whose words are not the operator's, or undefined.
async function unprovenWord($: any, words: string, repo: string): Promise<string | undefined> {
  if (spaced(words).length < CONSENT_QUOTE_MIN) {
    return 'github: auto-merge-set quotes the operator: "words" must hold at least ' + CONSENT_QUOTE_MIN
      + ' characters of what they said, verbatim.'
  }
  if (!AUTO_MERGE_WORD.test(words)) {
    return 'github: auto-merge-set quotes the operator: "words" must name auto-merge ("auto-merge", "auto merge" or'
      + ' "automerge"), in their own words, typed or answered.'
  }
  const quoting: Quoting = { dated: false, names: (span) => AUTO_MERGE_WORD.test(span), wholeBare: false }
  if (typedWords(words, quoting) || await consentAnswered($, words, { kind: 'auto-merge', repo })) return undefined
  return 'github: auto-merge-set refused on ' + repo + ': its "words" are neither in a prompt the operator typed in'
    + ' this session, nor their answer in a consent record (' + CONSENT_PRODUCER + ') of auto-merge on ' + repo
    + '. Quote them verbatim; a peer\'s message is not their word.'
}

// The list's lock, core's convention (`<path>.lock` holding the holder's pid), taken
// with the shell's noclobber since the module has no node:fs. A lock older than
// LOCK_STALE_MS is a holder that died and is taken over; one still held after
// LOCK_TRIES polls refuses the change. Released whatever the work does.
const LOCK_TRIES = 100
const LOCK_POLL = '0.05'
const LOCK_STALE_MS = 30_000

async function withListLock<T>($: any, path: string, work: () => Promise<T>): Promise<T> {
  const lock = path + '.lock'
  const made = await $.process.run(['mkdir', '-p', '--', path.slice(0, path.lastIndexOf('/'))], { timeoutMs: 10_000 })
  if (made.exitCode !== 0) throw new Error(made.stderr || 'mkdir exited ' + made.exitCode)
  for (let tries = 0; ; tries++) {
    const taken = await $.process.run(['sh', '-c', 'set -C; echo "$$" > "$1"', 'sh', lock], { timeoutMs: 10_000 })
    if (taken.exitCode === 0) break
    let mtimeMs: number
    try {
      mtimeMs = Number((await $.fs.stat(lock)).mtimeMs)
    } catch {
      throw new Error(taken.stderr || lock + ' could not be taken')
    }
    if (Date.now() - mtimeMs > LOCK_STALE_MS) {
      await $.process.run(['rm', '-f', '--', lock], { timeoutMs: 10_000 })
      continue
    }
    if (tries >= LOCK_TRIES) throw new Error(path + ' stays locked by another session; try again')
    await $.process.run(['sleep', LOCK_POLL], { timeoutMs: 10_000 })
  }
  try {
    return await work()
  } finally {
    await $.process.run(['rm', '-f', '--', lock], { timeoutMs: 10_000 }).catch(() => undefined)
  }
}

// The list written whole to a temporary file beside it, then moved over it:
// a reader sees the old list or the new one, never half of one. A move that
// fails removes the temporary file.
async function writeAutoMerge($: any, path: string, text: string): Promise<void> {
  const temp = path + '.' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.tmp'
  try {
    await $.fs.write(temp, text)
    const moved = await $.process.run(['mv', '-f', '--', temp, path], { timeoutMs: 10_000 })
    if (moved.exitCode !== 0) throw new Error(moved.stderr || 'mv exited ' + moved.exitCode)
  } catch (err) {
    await $.process.run(['rm', '-f', '--', temp], { timeoutMs: 10_000 }).catch(() => undefined)
    throw err
  }
}

// The line a typed prompt that speaks of auto-merge enters with: the list
// changes only when the session calls auto-merge-set, so it is told to.
async function autoMergeHeard($: any): Promise<string> {
  let today: string
  try {
    today = (await readAutoMerge($)).listed.join(', ') || 'none'
  } catch (err: any) {
    today = 'unreadable (' + String(err?.message ?? err) + ')'
  }
  return 'github: the operator spoke of auto-merge. If they put a repository in or out of it, call mcp__github__gh'
    + ' auto-merge-set with {"repo": "owner/name", "on": true|false, "words": "<their words, verbatim>"} in this same'
    + ' turn: nothing else changes the list. In auto-merge today: ' + today + '.'
}

async function setAutoMerge($: any, e: any): Promise<{ result?: string; deny?: string; isError?: boolean }> {
  const verdict = await $.tool.check({ tool: TOOL, input: { command: e.command, args: e.args, repo: e.repo } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const args = e.args ?? {}
  const repo = String(args.repo ?? '').trim()
  if (!REPO_NAME.test(repo)) return { deny: 'github: auto-merge-set names its repository as owner/name: {"repo": "owner/name"}' }
  if (typeof args.on !== 'boolean') return { deny: 'github: auto-merge-set says in or out: {"on": true} or {"on": false}' }
  const words = typeof args.words === 'string' ? args.words : ''
  const unproven = await unprovenWord($, words, repo)
  if (unproven) return { deny: unproven }
  if (verdict.decision === 'ask' && verdict.rule) {
    const refused = await ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
    if (refused) return { deny: refused }
  }
  const { path } = await readAutoMerge($)
  // Read and written under the lock: two sessions setting at once both land.
  return withListLock($, path, async () => {
    const { data, listed } = await readAutoMerge($)
    const key = repo.toLowerCase()
    const kept = listed.filter((r) => r.trim().toLowerCase() !== key)
    const was = kept.length < listed.length
    if (args.on && was && kept.length === listed.length - 1) return { result: repo + ' is already in auto-merge' }
    if (!args.on && !was) return { result: repo + ' was not in auto-merge' }
    const repositories = args.on ? [...kept, repo] : kept
    await writeAutoMerge($, path, JSON.stringify({ ...data, repositories }, null, 2) + '\n')
    return { result: repo + (args.on ? ' is now in auto-merge' : ' is no longer in auto-merge') }
  })
}

// ---- E2E not applicable, and the standing exemption ----

// An E2E not applicable refused when the session writing it pushed the head: another session says so.
export function selfNoneRefusal(result: string, head: string, pushed: ReadonlySet<string>): string | null {
  if (result !== 'not-applicable' || !pushed.has(head)) return null
  return 'github: this session pushed ' + head.slice(0, 7) + ': whether a pull request needs no E2E, a reviewer says so from another session.'
}

// Why the pull request at `head` is no pull request without runtime, or undefined: its files, read
// at that head (read again after them, so files of another head are never vouched for), all hold none.
async function runtimeRefusal($: any, repo: string, pr: number, head: string): Promise<string | undefined> {
  let files: PrFile[]
  let after: Gate
  try {
    files = await prFiles($, repo, pr)
    after = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return 'github: the files of ' + repo + '#' + pr + ' cannot be read: ' + String(err?.message ?? err).trim()
  }
  if (after.head !== head) return 'github: the head moved from ' + head.slice(0, 7) + ' to ' + after.head.slice(0, 7) + ' while its files were read: record again.'
  const held = runtimeFiles(files)
  if (held.length === 0) return undefined
  return 'github: E2E is not applicable only to a pull request whose files hold no runtime; ' + repo + '#' + pr + ' changes '
    + held.slice(0, 5).join(', ') + (held.length > 5 ? ' and ' + (held.length - 5) + ' more' : '') + '.'
}

// An exemption of a repository: each quoted span names E2E, the exemption or the repository.
function exemptionQuoting(repo: string): Quoting {
  const name = repo.split('/')[1].replace(/[.+^${}()|[\]\\-]/g, '\\$&')
  const names = new RegExp('E2E|end[-\\s]to[-\\s]end|bout[-\\s]en[-\\s]bout|tests?\\b|dispens|d[ée]rogation|waiv|exempt|exon[ée]r|' + name, 'i')
  return { dated: true, names: (span) => names.test(span), wholeBare: true }
}

const RULES_MAX = 50
const isRule = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= RULES_MAX && value.every((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200)

// The record tool's {repo, exempt, detail, paths?, labels?}: the operator exempts a repository's pull
// requests from E2E (all, or those a rule names), or revokes it, in their words with their date.
async function setExemption($: any, e: any, detail: string): Promise<{ result?: string; deny?: string; isError?: boolean }> {
  if (typeof e.exempt !== 'boolean') return { deny: 'github: an E2E exemption says in or out: {"exempt": true} or {"exempt": false}' }
  const repo = await targetRepo($, { repo: e.repo, args: {} })
  if (!repo || !REPO_NAME.test(repo)) return { deny: 'github: an E2E exemption names its repository: {"repo": "owner/name"}' }
  const paths = e.paths ?? []
  const labels = e.labels ?? []
  if (!isRule(paths) || !isRule(labels)) {
    return { deny: 'github: "paths" and "labels" are lists of at most ' + RULES_MAX + ' globs and label names.' }
  }
  if (detail.length > DETAIL_MAX || !/\b\d{4}-\d{2}-\d{2}\b/.test(detail)) {
    return { deny: 'github: an E2E exemption quotes the operator in "detail", at most ' + DETAIL_MAX + ' characters, with their date (YYYY-MM-DD).' }
  }
  if (!typedWords(detail, exemptionQuoting(repo)) && !(await consentAnswered($, detail, { kind: 'e2e-exemption', repo }))) {
    return {
      deny: 'github: an E2E exemption quotes the operator: its detail must be words they typed in this session,'
        + ' or their answer in a consent record (' + CONSENT_PRODUCER + ') of an E2E exemption of ' + repo + ', with their date.',
    }
  }
  const dir = await dataDir($)
  if (!dir) return { result: 'github: the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set', isError: true }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Written without it.
  }
  const exempt: boolean = e.exempt
  const kept = exempt ? { paths: paths.map((p: string) => p.trim()), labels: labels.map((l: string) => l.trim()) } : { paths: [], labels: [] }
  const body = { v: 1, repo: repo.toLowerCase(), exempt, ...kept, detail, session, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }
  const path = exemptionPath(dir, repo)
  await withListLock($, path, () => writeAutoMerge($, path, JSON.stringify(body, null, 2) + '\n'))
  if (!exempt) return { result: 'github: ' + repo + ' no longer exempt from E2E' }
  const rules = [
    ...(kept.labels.length > 0 ? ['carrying ' + kept.labels.join(' or ')] : []),
    ...(kept.paths.length > 0 ? ['whose files all match ' + kept.paths.join(' or ')] : []),
  ]
  return { result: 'github: ' + repo + ' exempt from E2E for ' + (rules.length > 0 ? 'its pull requests ' + rules.join(' or ') : 'all its pull requests') }
}

// ---- records ----

async function writeRecord($: any, e: any, origin: string): Promise<{ result?: string; deny?: string; isError?: boolean }> {
  const verdict = await $.tool.check({ tool: RECORD_TOOL, input: { pr: e.pr, repo: e.repo, kind: e.kind, result: e.result, detail: e.detail } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const owned = recordKindFor(origin)
  const kind = e.kind === undefined || e.kind === null || e.kind === '' ? owned : String(e.kind)
  if (kind !== owned) {
    return {
      deny: kindRefusal(kind, origin, owned),
    }
  }
  const detail = e.detail === undefined || e.detail === null ? '' : String(e.detail)
  if (e.exempt !== undefined) return owned === 'e2e' ? await setExemption($, e, detail) : { deny: kindRefusal('e2e', origin, owned) }
  const result = String(e.result ?? '')
  if (result === 'not-applicable' && detail.trim() === '') {
    return { deny: 'github: an E2E not applicable gives its reason in "detail": what the pull request changes that runs nothing.' }
  }
  const pr = Number(String(e.pr ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return { deny: 'github: name the pull request: {"pr": <n>}' }
  const repo = await targetRepo($, { repo: e.repo, args: {} })
  if (!repo) return { deny: 'github: name the repository: {"repo": "owner/name"}' }
  if (result === 'waived' && !typedWords(detail, waiverQuoting(pr)) && !(await consentAnswered($, detail, { kind: 'e2e-waiver', repo, pr }))) {
    return {
      deny: 'github: an E2E waiver quotes the operator: its detail must be words they typed in this session,'
        + ' or their answer in a consent record (' + CONSENT_PRODUCER + ') of an E2E waiver of this pull request, with their date.',
    }
  }
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: any) {
    return { deny: unverifiedRefusal(repo, pr, String(err?.message ?? err).trim()) }
  }
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  const local = head.exitCode === 0 ? String(head.stdout).trim().toLowerCase() : ''
  if (local !== gate.head) {
    return { deny: 'github: the checkout is at ' + (local.slice(0, 7) || 'no commit') + ', the pull request\'s head is ' + gate.head.slice(0, 7) + ': a record is written at the head it read.' }
  }
  const status = await $.process.run(['git', 'status', '--porcelain', '-uno'], { timeoutMs: 10_000 })
  if (status.exitCode !== 0 || String(status.stdout).trim() !== '') {
    return { deny: 'github: the tracked files have changes: a record is written on a clean checkout of the head.' }
  }
  const selfReview = selfReviewRefusal(kind, gate.head, pushedHeads) ?? selfNoneRefusal(result, gate.head, pushedHeads)
  if (selfReview) return { deny: selfReview }
  if (result === 'not-applicable') {
    const refused = await runtimeRefusal($, repo, pr, gate.head)
    if (refused) return { deny: refused }
  }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Written without it.
  }
  const argv = [
    'python3', $.plugin.root + '/engine/record.py', '--repo', repo, '--pr', String(pr), '--head', gate.head,
    '--kind', kind, '--result', result, '--producer', producerSlug(origin), '--detail', detail, '--session', session,
  ]
  const run = await $.process.run(argv, { timeoutMs: 30_000 })
  if (run.exitCode !== 0) return { result: String(run.stderr || 'record.py exited ' + run.exitCode).trim(), isError: true }
  // The record may complete the four: the gate reads them at the head it just checked.
  const { line } = await followGate($, repo, pr, gate, true)
  return { result: String(run.stdout).trim() + (line ? '\n' + line : '') }
}

// At most once a day, the head directories whose newest record is older than
// PRUNE_DAYS go: their pull request merged or moved on long ago.
async function pruneRecords($: any): Promise<void> {
  const root = await recordsRoot($)
  if (!root || !(await $.fs.exists(root))) return
  const stamp = root + '/.pruned'
  try {
    const last = await $.fs.stat(stamp)
    if (Date.now() - Number(last.mtimeMs) < PRUNE_EVERY_MS) return
  } catch {
    // Never pruned.
  }
  const cut = Date.now() - PRUNE_DAYS * 24 * 3600 * 1000
  const dirs = async (path: string): Promise<string[]> =>
    (await $.fs.list(path)).filter((x: any) => x?.kind === 'directory').map((x: any) => path + '/' + x.name)
  const stale: string[] = []
  for (const owner of await dirs(root)) {
    for (const name of await dirs(owner)) {
      for (const head of await dirs(name)) {
        let newest = Number((await $.fs.stat(head)).mtimeMs)
        for (const file of await $.fs.list(head)) {
          newest = Math.max(newest, Number((await $.fs.stat(head + '/' + file.name)).mtimeMs))
        }
        if (newest < cut) stale.push(head)
      }
    }
  }
  if (stale.length > 0) await $.process.run(['rm', '-rf', '--', ...stale], { timeoutMs: 60_000 })
  await $.fs.write(stamp, new Date().toISOString() + '\n')
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const root = $.plugin.root
    await $.tool.register({
      name: 'gh',
      // Listed with its schema from the start: behind ToolSearch the model
      // would reach for Bash and curl before it found this tool.
      isDeferred: false,
      description:
        'GitHub API: pull requests, review threads, comments, reviews, labels, '
        + 'issues, search, image uploads. Before first use, Read '
        + root + '/engine/REFERENCE.md for every subcommand. Before authoring any '
        + 'PR title, body, comment, review or commit message, Read its rules in '
        + root + '/engine/writing/ (commits.md, pull-requests.md or comments.md, and references.md). Pass positionals by their documented name '
        + '(pr-checks: {"pr": 12}); other keys become --flags; text bodies go in "body".',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: COMMANDS },
          args: {
            type: 'object',
            description: 'subcommand arguments: positionals by name, flags as keys',
          },
          repo: { type: 'string', description: 'owner/name, overriding origin' },
        },
        required: ['command'],
      },
    })
    // Apart from the gh tool: a failure here leaves it and the commands registered.
    try {
      await $.tool.register({
        name: 'record',
        isDeferred: false,
        description:
          'Record a pull request\'s E2E at its head, from a clean checkout of it: pass or fail after a run, '
          + 'not-applicable with its reason when no file holds runtime (docs, tests, CI, prompts), or waived. '
          + 'A waiver, and {repo, exempt, paths?, labels?} that exempts a repository\'s pull requests for good (false revokes), '
          + 'quote the operator\'s dated words, typed here or in a consent record. See '
          + root + '/engine/REFERENCE.md « Records ».',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name, overriding origin' },
            result: { type: 'string', enum: ['pass', 'fail', 'waived', 'not-applicable'] },
            detail: { type: 'string', description: 'what ran, the reason, or the operator\'s words with their date' },
            kind: { type: 'string', enum: [...KINDS], description: 'default: the kind this caller writes' },
            exempt: { type: 'boolean', description: 'exempt the repository (true) or revoke it (false), in place of pr and result' },
            paths: { type: 'array', items: { type: 'string' }, description: 'exempt only pull requests whose files all match these globs' },
            labels: { type: 'array', items: { type: 'string' }, description: 'exempt only pull requests carrying one of these labels' },
          },
          required: [],
        },
      })
    } catch (err: any) {
      note($, 'github: the record tool could not be registered: ' + String(err?.message ?? err))
    }
    try {
      await pruneRecords($)
    } catch (err: any) {
      note($, 'github: the old records could not be pruned: ' + String(err?.message ?? err))
    }
    ownedCommands.clear()
    // Commands last: a taken name throws and would skip the rest of the hook.
    for (const spec of [
      { name: 'checks', description: 'CI status of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'threads', description: 'Open review threads of a PR (default: the current branch\'s)', argumentHint: '[pr]' },
      { name: 'prs', description: 'Open the PR pane' },
    ]) {
      try {
        await $.command.register(spec)
        ownedCommands.add(spec.name)
      } catch {
        // Name already taken by another plugin; skip it.
      }
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('prompt.submit', async ($: any, e: any, next: any) => {
    const kind = String(e.origin?.kind ?? '')
    if (kind !== 'composer' && kind !== 'bridge') return next(e)
    lastTyped = String(e.text ?? '')
    let now: number | undefined
    try {
      now = await $.clock.now()
    } catch {
      // Kept without its day.
    }
    keepTyped(lastTyped, now)
    if (!AUTO_MERGE_WORD.test(lastTyped)) return next(e)
    return next({ ...e, context: [...(e.context ?? []), await autoMergeHeard($)] })
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    try {
      if (touchesRecords(String(e.command), await recordsRoot($))) return { deny: RECORDS_REFUSAL }
      if (await touchesAutoMerge($, String(e.command))) return { deny: AUTO_MERGE_REFUSAL }
      if (await touchesExemptions($, String(e.command))) return { deny: EXEMPT_REFUSAL }
    } catch {
      // A command that is no text names no record either.
    }
    let command: string | undefined
    try {
      command = bashAuthoring(e.command)
    } catch (err) {
      guardFailed($, err)
      return next(e)
    }
    const unread = await writingUnread($, command, e.agentId)
    if (unread) return { deny: unread }
    const after: Array<(result: any) => Promise<void>> = []
    let current: Act | undefined
    try {
      for (const act of bashActs(String(e.command))) {
        current = act
        const refused = await bashReady($, act, after)
        if (refused) return { deny: refused }
      }
    } catch (err) {
      // The ready guard failed on its own: its readiness reads as unverified, never as a pass.
      const refused = await guardThrew($, current, err)
      if (refused) return { deny: refused }
    }
    const unfit = await bashLint($, String(e.command))
    if (unfit) return { deny: unfit }
    const result = await next(e)
    try {
      const printed = printsWhole(e.command)
      const name = printed && !failed(result) ? await writingFileOf($, printed) : undefined
      if (name) await markReader($, name, e.agentId)
    } catch (err) {
      await markFailed($, err, e.agentId)
    }
    if (!failed(result)) {
      for (const then of after) {
        try {
          await then(result)
        } catch (err: any) {
          note($, 'github: the label could not be set after the command: ' + String(err?.message ?? err))
        }
      }
      await followPushes($, String(e.command))
      await notePushedHead($, String(e.command))
    }
    return result
  }).catch(async (_$: any, e: any, next: any) => {
    const refusal = bashNetRefusal(String(e?.command ?? ''))
    return refusal === null ? next(e) : { deny: refusal }
  })

  // The records are written by their producers only, the auto-merge list by auto-merge-set only.
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($: any, e: any, next: any) => {
      const root = await recordsRoot($)
      const path = normalise(String(e.file_path ?? e.notebook_path ?? ''), String(await $.session.cwd()))
      if ((root && (path === root || path.startsWith(root + '/'))) || path.includes('/.claude/pr-records/')) {
        return { deny: RECORDS_REFUSAL }
      }
      const data = await dataDir($)
      if ((data && path === normalise(data + '/' + AUTO_MERGE_FILE)) || AUTO_MERGE_PATH.test(path)) {
        return { deny: AUTO_MERGE_REFUSAL }
      }
      if ((data && path.startsWith(normalise(data + '/' + EXEMPT_DIR) + '/')) || ANY_EXEMPT_PATH.test(path)) {
        return { deny: EXEMPT_REFUSAL }
      }
      return next(e)
    }).catch(async (_$: any, e: any, next: any) => {
      const refusal = writeNetRefusal(String(e?.file_path ?? e?.notebook_path ?? ''))
      return refusal === null ? next(e) : { deny: refusal }
    })
  }

  on('tool.call', { tool: RECORD_TOOL }, async ($: any, e: any, next: any) => {
    try {
      return await writeRecord($, e, String(next?.origin?.plugin ?? 'engine'))
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the record hook itself failed' }))

  on('tool.call', { tool: 'Read' }, async ($: any, e: any, next: any) => {
    const result = await next(e)
    try {
      const name = !failed(result) && !result.result?.file?.truncatedByTokenCap
        ? await writingFileOf($, e.file_path) : undefined
      if (name) {
        // The file's length as the Read counted it, else read from the file,
        // and only when a limit makes it matter.
        let total = result.result?.file?.totalLines
        if (typeof total !== 'number' && e.limit !== undefined && e.limit !== null) {
          total = lineCount(String(await $.fs.read(normalise(e.file_path))))
        }
        if (readsWhole(e.offset, e.limit, () => Number(total))) await markReader($, name, e.agentId)
      }
    } catch (err) {
      await markFailed($, err, e.agentId)
    }
    return result
  }).catch(async (_$: any, e: any, next: any) => next(e))

  // Cleared as the compaction starts: one that is vetoed costs one more Read.
  on('session.compact', async ($: any, e: any, next: any) => {
    try {
      const key = readerKey(await sessionId($), e.agentId)
      readers.delete(key)
      unmarked.delete(key)
    } catch (err) {
      guardFailed($, err)
    }
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: TOOL }, async ($: any, raw: any) => {
    if (MOD_COMMANDS.has(raw.command)) {
      try {
        if (raw.command === 'auto-merge-set') return await setAutoMerge($, raw)
        const verdict = await $.tool.check({ tool: TOOL, input: { command: raw.command, args: raw.args, repo: raw.repo } })
        if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
        return { result: await listAutoMerge($) }
      } catch (err: any) {
        return { result: String(err?.message ?? err), isError: true }
      }
    }
    const e = { ...raw, args: withHouseDefaults(raw.command, raw.args ?? {}) }
    const act = toolAct(e.command, e.args)
    const ready = act ? toolReady($, e, act) : undefined
    const refused = await permit($, e, ready?.beforeAsk, ready?.ciUndraft)
    if (refused) return { deny: refused }
    if (ready) await ready.goingAhead()
    try {
      // The line of a gate read (the Actions runs it could not read) is shown after afterRead,
      // which parses the output: no added text may reach parseGate.
      const ran = await runGhRaw($, e.command, e.args, e.repo)
      let result = (READS.has(e.command) ? ran.out : withNote(ran.out, ran.err)) || '(no output)'
      if (ready) await ready.ran()
      result = await afterRead($, e, result)
      if (GATE_READS.has(e.command)) result = withNote(result, ran.err)
      // A write changes what the open pane shows: read it again, unawaited.
      if (watch && !READS.has(e.command)) void refresh($)
      return { result }
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the hook itself failed' }))

  on('command.run', { command: 'checks' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('checks')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-checks', 'checks-status', checksLine) }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /checks failed; the mod itself errored' }))

  on('command.run', { command: 'threads' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('threads')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-threads', 'thread-summary') }
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /threads failed; the mod itself errored' }))

  on('command.run', { command: 'prs' }, async ($: any, e: any, next: any) => {
    if (!ownedCommands.has('prs')) return next(e)
    try {
      const rows = await collectRows($)
      await update($, pane, (p) => ({ ...p, rows, error: null }))
      await $.ui.open({ id: PANE_ID, title: 'PRs', closeOnEscape: true })
      startWatch($)
      return {}
    } catch (err: any) {
      return { text: String(err?.message ?? err) }
    }
  }).catch(async () => ({ text: 'github mod: /prs failed; the mod itself errored' }))

  // The markdown commands answered here without a model turn. A failure falls
  // back to the markdown, which runs the same script through the model.
  // /github:protect [apply]: the default branch's force-push and deletion protection, read on
  // the forge, and put in place on the operator's « apply ».
  on('command.run', { command: 'github:protect' }, async ($: any, e: any) => {
    const command = /\bapply\b/.test(String(e.args ?? '')) ? 'protect-apply' : 'protect-check'
    try {
      return { text: (await runGh($, command, {}, await targetRepo($, { repo: undefined, args: {} }))).trim() }
    } catch (err: any) {
      return { text: 'github: ' + command + ' failed: ' + String(err?.message ?? err).trim() }
    }
  }).catch(async ($: any, e: any, next: any) => next(e))

  on('command.run', { command: 'github:install' }, async ($: any) => ({ text: await diagnose($) }))
    .catch(async (_$: any, e: any, next: any) => next(e))
  on('command.run', { command: 'github:doctor' }, async ($: any) => ({ text: await diagnose($, true) }))
    .catch(async (_$: any, e: any, next: any) => next(e))

  on('ui.close', async (_$: any, e: any, next: any) => {
    if (e.id === PANE_ID) stopWatch()
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const width = e.props?.bodyColumns ?? 80
    const state = await read($, pane)
    const rows = state.rows.length === 0
      ? [Text({ key: 'empty', children: [state.refreshing ? 'Loading…' : 'No open PRs'] })]
      : state.rows.map((r) => {
          const suffix = (r.draft ? ' ○ draft' : '') + (r.comments ? ' 💬' + r.comments : '')
          return Box({
            key: 'pr-' + r.number,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Link({ key: 'link-' + r.number, href: r.url, label: '#' + r.number }),
              // The title takes the room the number and the label leave, so the
              // label always shows; only the label is coloured.
              Box({
                key: 'room-' + r.number,
                flexGrow: 1,
                flexShrink: 1,
                children: [
                  Text({
                    wrap: 'truncate-end',
                    children: [clip(r.title, width - LABEL_COLUMN - 10 - suffix.length) + suffix],
                  }),
                ],
              }),
              Box({
                key: 'label-' + r.number,
                width: LABEL_COLUMN,
                flexShrink: 0,
                children: [Text({ color: ciColor(r.ci), children: ['CI:' + r.ci] })],
              }),
            ],
          })
        })
    return Box({
      key: 'prs',
      flexDirection: 'column',
      children: [
        ...rows,
        ...(state.error ? [Text({ key: 'error', color: 'error', children: [state.error] })] : []),
        Button({
          key: 'refresh',
          label: state.refreshing ? 'Refreshing…' : 'Refresh',
          onPress: () => {
            startWatch($)
            return refresh($)
          },
        }),
      ],
    })
  }).catch(async (_$: any, e: any, next: any) => next(e))
}
