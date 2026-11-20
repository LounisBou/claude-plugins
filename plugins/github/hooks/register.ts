// The github mod: a thin facade over engine/gh.py. The $, e and next
// arguments are typed loosely here; Claude Code writes the exact API types
// to .claude-plugin/types/ the first time the mod loads (gitignored).

import { atom, read, update } from 'claude-code'

import type { GithubPane, GithubPaneRow } from '../types/index.d.ts'
import { reasonOf, type Events, type FsEntry, type Host, type On } from '../core/host.ts'
import {
  AUTO_DEPLOY_FILE, bashDeploys, DEPLOY_ENVS, type DeployEnv, firstRefusal, parseDeclared, parseDeployList, skillDeploys, type Declared, type DeployList,
} from './deploy.ts'
import { ACCEPTANCE, DETAIL_MAX, KINDS, parsePrRecord, SCRIPTED, type PrRecord } from '../core/pr-record.ts'
import { FORGE, forgeContext, recordPost, type ForgePost } from '../core/forge-status.ts'
import { FORGE_SESSION, forgeSync, POSTS_PER_TICK } from './forge-sync.ts'
import { PLAN_NEEDS, REVIEW_ROUNDS } from '../core/readiness.ts'
import {
  covers, EXEMPT_DIR, expired, expiryLine, exemptionLine, exemptionPath, isExpiryLine, isInstant, isRepoName, parseExemption, parsePrFiles, runtimeFiles, type Exemption, type PrFile,
} from './e2e-scope.ts'
import { parsePlan, PLAN_DIR, PLAN_WRITER, planExcuses, needText, planInput, planPath, planText, WAIVED, type CheckPlan, type Excused, type Waivable } from './check-plan.ts'
import { normalise } from './guards.ts'
import {
  fingerprintOf, FLAP_UNDONE, flapCheck, flapWrote, FOREIGN_CEILING_MS, foreignGivenUp, foreignHold, GATES_PER_TICK, LEASE_FILE, leaseDue, leaseOf, nextListing, parseLease, parseListing, PUBLISH_WAIT_MS, QUOTA_LOW, QUOTA_WAIT_MS, reconciledRepos, RETRY_MS,
  listedPath, parseSeen, seenLabel, seenPath, seenText, seenWrote, sortedStatuses, takenLease, TICK_MS,
  type Counts, type Flap, type LabelMove, type ListedPr, type Listing, type Local, type Schedule, type Seen,
} from './reconcile.ts'
import { parseReconcile, reconcileEdgePath, reconcilePath, reconcileRoot, RECONCILE_VERSION } from '../core/pr-reconcile.ts'
import { moduleDirOf } from '../core/orchestration.ts'
import { prFilePath, prFileRepos } from '../core/pr-file.ts'
import { updateOver, writeAtomicOver } from '../core/store-io.ts'
import { appendEventOver, journalIoOf, randomPart } from '../core/journal.ts'
import { auditEvent, journalDir } from '../core/learning.ts'
import { isCatchable, observe, OBSERVED, REFUSED } from './observe.ts'
import {
  acceptanceOriginRefusal, latestReview, unpinnedMergeRefusal, passOverFailRefusal, reviewAccepted, NOT_READY, PRUNE_DAYS, PRUNE_EVERY_MS, READY, STDIN_REFUSAL, autoMergeRefusal, bashActs, bashPushes,
  carriesReady, ciUndraft, ciUndraftLine, createdPr, durableWaiver, gateHeldAnswer, gateHeldGivenUpLine, gateHeldLine, gateHeldRefusal, gateLeftLine, gateMissingLine, gateMovedLine,
  gateNotReadyLine, gateReadyLine, gateUnwrittenLine, graphqlRefusal, labelMove, missingItems, notReadyAnswer, onlyAbsentRecords, stackedCi, unverifiedAnswer,
  notReadyRefusal, opaqueGraphqlRefusal, parseGate, parseHeadRead, producerSlug, carries, headLatest, recordPrs, uncarriedLine, unreadableRecords, unrecorded,
  kindRefusal, recordKindFor, toolAct, onlyReads, unnamedRepoRefusal, unreadablePrRefusal, unverifiedRefusal,
  RECORDS_REFUSAL, deletes, deletesRecords, postsStatus, STATUS_REFUSAL,
  type Act, type Carried, type Gate, type HeadRead, type RecordFile,
} from './ready.ts'

// The host's nouns the module calls.
type Mod = Host<'plugin' | 'env' | 'fs' | 'process' | 'session' | 'ui' | 'tool' | 'command' | 'clock'>

// What a tool call hands a hook: the tool's arguments, each read through a validator.
type ToolInput = Events['tool.call']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'

// A value as a refusal quotes it.
const quoted = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value) ?? String(value))

// A field of a tool call's `args`, undefined when the call gives no arguments object.
const argOf = (args: unknown, name: string): unknown => (isRecord(args) ? args[name] : undefined)

// A pull request number as a call writes it: 12, "12" or "#12".
const prNumber = (value: unknown): number => Number(String(value ?? '').replace('#', ''))

export const PANE_ID = 'github-prs'

// The tool's subcommands, for its command enum: gh.py's, which it maps itself
// (--stdin-json), and the mod's own (MOD_COMMANDS), answered here.
// tests/run-tests.sh fails when this list and the two sources disagree.
export const COMMANDS = [
  'pr-get', 'pr-list', 'pr-panel', 'pr-status', 'pr-checks', 'pr-gate', 'pr-fingerprint', 'pr-diff', 'pr-files',
  'pr-commits', 'file-at-ref', 'pr-create', 'pr-merge', 'pr-threads',
  'pr-comments', 'pr-issue-comments', 'pr-reviews', 'thread-reply',
  'pr-comment', 'comment-edit', 'comment-delete', 'thread-resolve',
  'comment-resolve', 'comment-unresolve', 'comment-resolved',
  'comments-resolved-batch', 'review-submit', 'review-pending-create',
  'review-pending-add', 'review-pending', 'repo-review-comments', 'pr-update',
  'pr-ready', 'pr-draft', 'label-add', 'label-remove', 'reviewer-add', 'reviewer-remove',
  'assignee-add', 'assignee-remove', 'labels-ensure', 'pr-readiness', 'issue-view', 'issue-list',
  'issue-search', 'pr-linked-issues', 'image-upload', 'auth-check', 'auto-merge-set', 'auto-merge-list',
  'auto-deploy-set', 'auto-deploy-list', 'protect-check', 'protect-apply', 'pr-plan',
]

// The subcommands this module answers without the engine: the lists of repositories in
// auto-merge and in auto-deploy, and a pull request's check plan, are files on this machine, not GitHub's.
export const MOD_COMMANDS = new Set(['auto-merge-set', 'auto-merge-list', 'auto-deploy-set', 'auto-deploy-list', 'pr-plan'])

// The subcommands the session calls to read. Every other one writes to GitHub, and a
// command missing here is treated as a write, so the safe side is the default. After
// pr-gate and pr-checks the gate may write the Ready label itself: its act, not the session's.
export const READS = new Set([
  'pr-get', 'pr-list', 'pr-panel', 'pr-status', 'pr-checks', 'pr-gate', 'pr-fingerprint', 'pr-diff', 'pr-files', 'pr-commits',
  'file-at-ref', 'pr-threads', 'pr-comments', 'pr-issue-comments', 'pr-reviews',
  'comment-resolved', 'comments-resolved-batch', 'review-pending', 'repo-review-comments',
  'issue-view', 'issue-list', 'issue-search', 'pr-linked-issues', 'auth-check', 'auto-merge-list',
  'auto-deploy-list', 'protect-check', 'pr-plan',
])

export const TOOL = 'mcp__github__gh'

// A call of the gh tool as its schema declares it: the subcommand, its arguments when given, the repository when named.
type GhRequest = { readonly command: string; readonly args: Record<string, unknown> | undefined; readonly repo: string | undefined }
// The call once the house defaults are in: its arguments are there, and a CI undraft adds one to them.
type GhCall = { readonly command: string; args: Record<string, unknown>; readonly repo: string | undefined }
// What names the repository a call is for: its own `repo`, else its arguments'.
type Named = { readonly repo?: unknown; readonly args?: unknown }
// What a tool's hook answers.
type Answer = { result?: string; deny?: string; isError?: boolean }

/** The gh tool's call a hook was handed, or a sentence saying what is wrong with it. */
export function ghRequest(raw: ToolInput): GhRequest | string {
  const { command, args, repo } = raw
  if (typeof command !== 'string' || command === '') return 'github: "command" names the subcommand, a text; got: ' + quoted(command)
  if (args !== undefined && args !== null && !isRecord(args)) return 'github: "args" is an object of the subcommand\'s arguments; got: ' + quoted(args)
  if (repo !== undefined && repo !== null && typeof repo !== 'string') return 'github: "repo" is owner/name, a text; got: ' + quoted(repo)
  return { command, args: args ?? undefined, repo: repo ?? undefined }
}

// The request travels as JSON on stdin: gh.py maps it onto its own parser,
// refuses what that parser does not declare, and writes the bodies to a
// private directory it removes. No argv is built and no file written here.
//
// full: the module parses the answer, so it asks the full object where a read has a short default.
async function runGhRaw(
  $: Mod, command: string, args: Record<string, unknown> = {}, repo?: string, full = false,
): Promise<{ out: string; err: string }> {
  const r = await $.process.run(
    ['python3', $.plugin.root + '/engine/gh.py', '--stdin-json'],
    { stdin: JSON.stringify({ command, args, repo, ...(full ? { full: true } : {}) }), timeoutMs: 120_000 },
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
  $: Mod, command: string, args: Record<string, unknown> = {}, repo?: string, notes = false,
): Promise<string> {
  const r = await runGhRaw($, command, args, repo, true)
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
 * Between the verdict and the run come the approvals engine/writing/ reserves
 * to the person (a pull request out of draft, a merge), asked whatever the
 * settings allow. The mechanical writing rules are the engine's: pr-create and
 * pr-update refuse a text that breaks one.
 *
 * Outside auto-merge, leaving draft (a CI undraft aside) is asked: it is the person's act on
 * GitHub, after their review, and the readiness gate refuses one not ready.
 *
 * In a repository in auto-merge no write is put to the person: the reserved
 * approvals lift and an ask with no rule behind it runs. A deny and an ask
 * from an explicit rule stand.
 */
async function permit(
  $: Mod, e: GhCall, beforeAsk?: () => Promise<string | undefined>, ciUndraft?: () => Promise<boolean>,
): Promise<string | undefined> {
  const input = { command: e.command, args: e.args, repo: e.repo }
  const verdict = await $.tool.check({ tool: TOOL, input })
  if (verdict.decision === 'deny') return verdict.reason || 'refused by a permission rule'

  // The ready guard, before any question: nobody is asked about a pull
  // request that is not ready.
  const notReady = beforeAsk ? await beforeAsk() : undefined
  if (notReady) {
    await observed($, REFUSED.ready)
    return notReady
  }

  // Going back to draft, and leaving it for CI still Not Ready, are no
  // approvals to give: they run in every repository, as through Bash. An ask
  // from an explicit rule stands.
  if (e.command === 'pr-draft' || (ciUndraft && await ciUndraft())) {
    if (verdict.decision === 'allow' || !verdict.rule) return undefined
    return ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
  }

  // Read once per call, for a write only.
  const autoMerge = !READS.has(e.command) && await inAutoMerge($, e)
  // Outside auto-merge, leaving draft is the operator's on GitHub: asked below as any write no rule
  // allows. The readiness gate above still refuses a pull request not ready.
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

async function ask($: Mod, question: string, options: string[], command: string): Promise<string | undefined> {
  try {
    if ((await $.ui.ask(question, options)) === options[0]) return undefined
  } catch {
    return 'gh ' + command + ' needs permission and nobody could be asked'
  }
  return 'the user refused gh ' + command
}

// Whether a call's answer is a refusal or an error: an answer that is no object has no such field.
function failed(result: unknown): boolean {
  if (!result) return true
  if (typeof result !== 'object') return false
  return ('deny' in result && result.deny !== undefined) || ('isError' in result && result.isError === true)
}

function describe(e: GhRequest): string {
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

// The repositories in auto-merge, as owner/name: there no write is put to the
// person. The file is the operator's, in the host's data directory for this
// plugin; it changes only through auto-merge-set, on their quoted word.
export const AUTO_MERGE_FILE = 'auto-merge.json'
// Auto-merge as the operator writes it: « auto-merge », « auto merge », « automerge ».
// The list's path in any plugin's data directory, for the Write and Edit guard.
const AUTO_MERGE_PATH = /\/\.claude\/plugins\/data\/[^/]+\/auto-merge\.json$/
// The deploy list, beside it.
const AUTO_DEPLOY_PATH = /\/\.claude\/plugins\/data\/[^/]+\/auto-deploy\.json$/
// The E2E exemptions, one file per repository, and the check plans, one per pull request, below these directories of the data directory.
const GUARDED_DIRS = '(' + EXEMPT_DIR + '|' + PLAN_DIR + ')'
const namesExemptions = (text: string) => text.includes(EXEMPT_DIR) || text.includes(PLAN_DIR)
export const EXEMPT_REFUSAL = 'github: an E2E exemption changes only through mcp__github__record'
  + ' {"repo": "owner/name", "exempt": true|false, "detail": "« <the operator\'s words> », <their date>"}, and a check plan through ' + PLAN_WRITER.tool + '.'
const ANY_EXEMPT_PATH = new RegExp('/\\.claude/plugins/data/[^/]+/' + GUARDED_DIRS + '/')
export const PLAN_REFUSAL = 'github: a check plan is written by ' + PLAN_WRITER.tool + ', from an orchestrator session.'

/*
 * What an E2E or norms waiver, an E2E exemption, auto-merge and auto-deploy rest on: the operator's words, quoted
 * with their date, from any channel. The quote is the record, and it stays visible in the file it writes.
 */
const QUOTED_DATE = /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?/
// The letters his words hold at least, dates and times left out: digits are no words.
const QUOTE_LETTERS_MIN = 6
export function quotedWordsRefusal(what: string, detail: string, field = 'detail'): string | undefined {
  const asks = 'github: ' + what + ' rests on the operator\'s words, quoted in "' + field + '" with their date ("« <his words> », 2026-11-15T08:50Z")'
  if (detail.trim() === '') return asks + ': "' + field + '" is empty.'
  if (detail.length > DETAIL_MAX) return asks + ': "' + field + '" is at most ' + DETAIL_MAX + ' characters.'
  if (!QUOTED_DATE.test(detail)) return asks + ': it carries no date.'
  const words = detail.replace(new RegExp(QUOTED_DATE.source, 'g'), ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ').replace(/[^\p{L}]/gu, '')
  if (words.length < QUOTE_LETTERS_MIN) return asks + ': it quotes fewer than ' + QUOTE_LETTERS_MIN + ' letters of his words.'
  return undefined
}

// What a guard's net refuses when the guard itself failed: only what the guard still refuses (a merge, the
// auto-merge and deploy lists, a deletion of the records, the exemptions or the plans, a commit status), judged from the call alone (no state can be read once the hook has
// thrown); the rest, observed guards included, goes through.
export const NET_REFUSAL = 'github: its guard failed on this call, which it protects; nothing was run. Try again, or run /github:doctor.'

// Opening a pull request, in draft or not, and returning one to draft reach no merge.
const HARMLESS_ACTS: ReadonlySet<string> = new Set(['create', 'create-draft', 'redraft'])

export function bashNetRefusal(command: string): string | null {
  try {
    if (command.includes(AUTO_MERGE_FILE) || command.includes(AUTO_DEPLOY_FILE) || deletesRecords(command) || postsStatus(command)) return NET_REFUSAL
    if (namesExemptions(command) && deletes(command, namesExemptions)) return NET_REFUSAL
    return bashActs(command).some((act) => !HARMLESS_ACTS.has(act.kind)) ? NET_REFUSAL : null
  } catch {
    // Unreadable: refused only when it may name what the guard protects.
    const names = (text: string) => /pr-records|e2e-exempt|check-plans/.test(text)
    if (names(command) && deletes(command, names)) return NET_REFUSAL
    return /\b(gh|git)\b|auto-merge|auto-deploy/.test(command) ? NET_REFUSAL : null
  }
}

export function writeNetRefusal(path: string): string | null {
  return AUTO_MERGE_PATH.test(path) || AUTO_DEPLOY_PATH.test(path) ? NET_REFUSAL : null
}
export const AUTO_MERGE_REFUSAL = 'github: the auto-merge list changes only through mcp__github__gh auto-merge-set,'
  + ' on the operator\'s recorded answer ({"repo": "owner/name", "on": true|false, "words": "..."});'
  + ' auto-merge-list prints it.'
export const AUTO_DEPLOY_REFUSAL = 'github: the deploy list changes only through mcp__github__gh auto-deploy-set,'
  + ' on the operator\'s recorded answer ({"repo": "owner/name", "env": "dev"|"staging"|"prod", "on": true|false, "words": "..."});'
  + ' auto-deploy-list prints it.'
// The data directory under HOME when the host does not name it.
export const DATA_UNDER_HOME = '/.claude/plugins/data/github-lounisbou'
// The forms of a GitHub origin URL, as engine/ghlib/repo.py reads them.
const GITHUB_ORIGIN = /(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/

// The plugin's data directory: the host's, else the one under HOME, else ''.
async function dataDir($: Mod): Promise<string> {
  const home = await $.env.get('HOME')
  return (await $.env.get('CLAUDE_PLUGIN_DATA')) || (home ? home + DATA_UNDER_HOME : '')
}

// A list that is there but cannot be read, with its path.
class UnreadList extends Error {
  readonly path: string
  constructor(path: string, why: string) {
    super(path + ': ' + why)
    this.path = path
  }
}

// The file as it stands: its path, its object and its list as written. An
// absent file is an empty list; an unreadable or malformed one throws UnreadList.
async function readAutoMerge($: Mod): Promise<{ path: string; data: Record<string, unknown>; listed: string[] }> {
  const dir = await dataDir($)
  if (!dir) throw new Error('the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set')
  const path = dir + '/' + AUTO_MERGE_FILE
  if (!(await $.fs.exists(path))) return { path, data: { repositories: [] }, listed: [] }
  let data: unknown
  try {
    data = JSON.parse(String(await $.fs.read(path)))
  } catch (err: unknown) {
    throw new UnreadList(path, reasonOf(err))
  }
  const listed = isRecord(data) ? data['repositories'] : undefined
  if (!isRecord(data) || !Array.isArray(listed) || !listed.every(isText)) {
    throw new UnreadList(path, '"repositories" is not a list of owner/name strings')
  }
  return { path, data, listed }
}

// The listed repositories, lowercased. An absent file lists none, and so does
// an unreadable or malformed one, which also says so in one log line.
async function autoMergeRepos($: Mod): Promise<Set<string>> {
  try {
    return new Set((await readAutoMerge($)).listed.map((r) => r.trim().toLowerCase()))
  } catch (err: unknown) {
    if (err instanceof UnreadList) {
      $.ui.log('github: ' + err.path + ' unread, every write is asked: ' + err.message.slice(err.path.length + 2))
    }
    return new Set()
  }
}

// The deploy file as it stands: its path, its object and its list. An absent file grants and
// declares nothing; an unreadable or malformed one throws UnreadList.
async function readDeployFile($: Mod): Promise<{ path: string; data: Record<string, unknown>; list: DeployList }> {
  const dir = await dataDir($)
  if (!dir) throw new Error('the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set')
  const path = dir + '/' + AUTO_DEPLOY_FILE
  if (!(await $.fs.exists(path))) return { path, data: {}, list: { grants: [], declared: [] } }
  let data: unknown
  try {
    data = JSON.parse(String(await $.fs.read(path)))
  } catch (err: unknown) {
    throw new UnreadList(path, reasonOf(err))
  }
  const list = parseDeployList(data)
  if (typeof list === 'string') throw new UnreadList(path, list)
  if (!isRecord(data)) throw new UnreadList(path, 'the file is not an object')
  return { path, data, list }
}

// The deploy list a call is judged by. An unreadable one declares nothing: no deploy is
// recognised, the host's own protections stand, and one log line says so.
async function deployList($: Mod): Promise<DeployList> {
  try {
    return (await readDeployFile($)).list
  } catch (err: unknown) {
    if (err instanceof UnreadList) {
      $.ui.log('github: ' + err.path + ' unread, no deploy is recognised: ' + err.message.slice(err.path.length + 2))
    }
    return { grants: [], declared: [] }
  }
}

// The refusal of a Bash line that runs a declared deploy the list does not grant, or undefined.
async function bashDeployRefusal($: Mod, line: string): Promise<string | undefined> {
  try {
    const list = await deployList($)
    return list.declared.length === 0 ? undefined : firstRefusal(list, bashDeploys(line, list.declared))
  } catch {
    // A line that cannot be read runs no deploy it shows.
    return undefined
  }
}

// The refusal of a skill that is a declared deploy the list does not grant, or undefined.
async function skillDeployRefusal($: Mod, skill: string): Promise<string | undefined> {
  try {
    const list = await deployList($)
    return list.declared.length === 0 ? undefined : firstRefusal(list, skillDeploys(skill, list.declared))
  } catch {
    return undefined
  }
}

// The repository the engine will act on, in its own order. The call's repo is
// passed last as --repo=, so it wins over a repo in its args even when empty;
// an empty or absent one falls through to GH_REPO, then to the checkout's origin.
// Read once per call: the ready guard and the auto-merge check ask for it both.
const targets = new WeakMap<object, Promise<string | undefined>>()

// `dir`: the checkout whose origin names the repository, when not the session's directory.
function targetRepo($: Mod, e: Named, dir?: string): Promise<string | undefined> {
  let found = targets.get(e)
  if (!found) {
    found = readTargetRepo($, e, dir)
    targets.set(e, found)
  }
  return found
}

async function readTargetRepo($: Mod, e: Named, dir?: string): Promise<string | undefined> {
  const override = e.repo !== undefined && e.repo !== null ? e.repo : argOf(e.args, 'repo')
  for (const named of [override, await $.env.get('GH_REPO')]) {
    if (named !== undefined && named !== null && String(named) !== '') return String(named)
  }
  const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000, ...(dir ? { cwd: dir } : {}) })
  const match = r.exitCode === 0 ? GITHUB_ORIGIN.exec(String(r.stdout).trim()) : null
  return match ? match[1] + '/' + match[2] : undefined
}

// Whether a write goes to a repository in auto-merge. Any doubt answers no,
// and the person is asked as before.
async function inAutoMerge($: Mod, e: Named): Promise<boolean> {
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
  if (command === 'pr-create' && (args['draft'] === undefined || args['draft'] === null)) return { ...args, draft: true }
  return args
}

// A grant is the session's, the command's and the repository's: an explicit
// repo by its name, the origin by the directory whose remote it is.
async function grantKey($: Mod, e: GhRequest): Promise<string | undefined> {
  try {
    const session = await $.session.id()
    const repo = e.repo ? 'repo:' + String(e.repo).toLowerCase() : 'origin:' + await $.session.cwd()
    return session + '\n' + e.command + '\n' + repo
  } catch {
    // Without the session or its directory no grant can be scoped: ask.
    return undefined
  }
}

async function prText(
  $: Mod,
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

// checks-status's answer: its verdict and the checks that failed, or a throw naming what is wrong with it.
function parseChecksStatus(text: string): { result: string; failed: string[] } {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('checks-status answered no object')
  const failed = raw['failed_checks']
  if (failed !== undefined && failed !== null && !Array.isArray(failed)) throw new Error('checks-status answered failed checks that are no list')
  return { result: String(raw['result']), failed: Array.isArray(failed) ? failed.map(String) : [] }
}

// pr-panel's answer, the rows the pane draws, or a throw naming what is wrong with it.
function parsePanel(text: string): PaneRow[] {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('pr-panel answered no list of pull requests')
  return raw.map((pull: unknown) => {
    if (!isRecord(pull) || typeof pull['number'] !== 'number') throw new Error('pr-panel answered a pull request with no number')
    const { title, url, draft, comments, ci, failed } = pull
    if (typeof title !== 'string' || typeof url !== 'string' || typeof draft !== 'boolean') throw new Error('pr-panel answered a pull request without its title, url or draft flag')
    if (typeof comments !== 'number' || typeof ci !== 'string') throw new Error('pr-panel answered a pull request without its comment count or CI state')
    if (!Array.isArray(failed) || !failed.every((name) => typeof name === 'string')) throw new Error('pr-panel answered failed checks that are no list of names')
    return { number: pull['number'], title, url, draft, comments, ci, failed }
  })
}

// checks-status JSON as a line a person reads: "#12 CI: FAILURE (lint, test)".
export function checksLine(pr: string, out: string): string {
  try {
    const status = parseChecksStatus(out)
    return '#' + pr + ' CI: ' + status.result + (status.failed.length > 0 ? ' (' + status.failed.join(', ') + ')' : '')
  } catch {
    return out
  }
}

export type PaneRow = GithubPaneRow

// How old the open pane's rows may get before they are read again, for the CI and review counts
// that change with nobody asking: one pr-panel run, a single GraphQL query. Only a visible pane
// is read (paneShown); a hidden one is read once, when it shows again, if its rows are older.
export const WATCH_MS = 300_000

// The pane's rows live in the session's state: a reload of the module keeps
// them, and a write redraws the pane with nobody invalidating it.
const EMPTY_PANE: GithubPane = { rows: [], error: null, refreshing: false }
const pane = atom({ plugin: 'github', key: 'pane' } as const, EMPTY_PANE)

// Names this module registered; a taken name is left to its owner.
const ownedCommands = new Set<string>()
// The heads a session pushed are kept on disk, one file per head naming the sessions that pushed it
// (<config>/pushed-heads/<sha>), so a later process of the same session, another session reading the head
// or a reload of this module knows them too: a review of one's own push is no review (method, « review on evidence »).
const PUSHED_DIR = 'pushed-heads'

// A review record refused when the session writing it pushed the head it reviews.
export function selfReviewRefusal(kind: string, head: string, pushed: ReadonlySet<string>): string | null {
  if (kind !== 'review' || !pushed.has(head)) return null
  return 'github: this session pushed ' + head.slice(0, 7) + ': a review is made by another session, never by the one that'
    + ' wrote or pushed the code. Run the review from another session (implement: /implement:review).'
}
// The grants « Allow for this session » gave, by session, command and repository.
// Kept in the module: a reload or a restart drops them, which only asks again.
const sessionGrants = new Set<string>()
let refreshing = false
// The timer reading the PRs while the pane is open.
let watch: { cancel: () => void } | undefined
// When the rows were last read (or tried), and whether a write since then makes them stale at once.
let readAt: number | undefined
let dirty = false

// The width of the label column: CI:SUCCESS, CI:FAILURE and CI:PENDING.
const LABEL_COLUMN = 10

function ciColor(ci: string): string {
  if (ci === 'SUCCESS') return 'success'
  if (ci === 'FAILURE') return 'error'
  if (ci === 'PENDING') return 'warning'
  return 'inactive'
}

const collectRows = async ($: Mod): Promise<PaneRow[]> => parsePanel(await runGh($, 'pr-panel'))

// Whether a surface draws the pane now: open, shown and placed. A host that cannot say reads as
// shown, the way the pane behaved before it looked.
async function paneShown($: Mod): Promise<boolean> {
  try {
    const mine = (await $.ui.panes()).find((p) => p.id === PANE_ID)
    return mine !== undefined && mine.isShown !== false && mine.isPlaced !== false
  } catch {
    return true
  }
}

// The clock's now, NaN when the host cannot say: nothing then looks old, so a drawn pane never reads in a loop.
const nowMs = ($: Mod): Promise<number> => Promise.resolve($.clock.now()).then(Number, () => NaN)

// How much younger than the watch the rows may be when the timer fires: a read is stamped a few
// awaits after its tick, so the next tick finds them a little under WATCH_MS old.
export const TICK_SLACK_MS = 10_000

// The rows are due when a write made them stale or they are older than the watch. The timer is
// itself the cadence (fromTimer): it reads when the rows are within the slack of the interval,
// and when the clock cannot say how old they are; a drawing never does, or it would read in a loop.
async function due($: Mod, fromTimer: boolean): Promise<boolean> {
  if (dirty || readAt === undefined) return true
  const age = await nowMs($) - readAt
  if (Number.isNaN(age)) return fromTimer
  return age >= WATCH_MS - (fromTimer ? TICK_SLACK_MS : 0)
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

async function refresh($: Mod): Promise<void> {
  if (refreshing) return
  refreshing = true
  // Stamped before the read, a failed one too: a pane drawn again must not read again at once.
  dirty = false
  readAt = await nowMs($)
  await update($, pane, (p) => ({ ...p, refreshing: true }))
  try {
    const before = (await read($, pane)).rows
    const rows = await collectRows($)
    await update($, pane, (p) => ({ ...p, rows, error: null }))
    for (const line of ciTransitions(before, rows)) $.ui.toast(line)
  } catch (err: unknown) {
    // The rows from the last good read stay on screen under the error.
    const error = reasonOf(err).trim()
    await update($, pane, (p) => ({ ...p, error }))
  } finally {
    refreshing = false
    await update($, pane, (p) => ({ ...p, refreshing: false }))
  }
}

// The pane is read again when it is shown and its rows are due; a hidden pane reads nothing.
async function refreshIfDue($: Mod, fromTimer: boolean, shown?: boolean): Promise<void> {
  if (await due($, fromTimer) && (shown ?? await paneShown($))) await refresh($)
}

// One timer while the pane is open; a reload of the module cancels it with
// the old copy, and the next /prs or Refresh starts it again.
function startWatch($: Mod): void {
  if (watch) return
  watch = $.clock.every(WATCH_MS, () => {
    void refreshIfDue($, true)
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
export async function diagnose($: Mod, check = false): Promise<string> {
  const argv = ['bash', $.plugin.root + '/install.sh', ...(check ? ['--check'] : [])]
  const r = await $.process.run(argv, { timeoutMs: check ? 60_000 : 600_000 })
  const out = [r.stdout, r.stderr].map((t: string) => (t ?? '').trimEnd()).filter(Boolean).join('\n')
  const meaning = DIAGNOSTIC[r.exitCode] ?? 'an unexpected failure'
  return out + '\n\nExit code ' + r.exitCode + ': ' + meaning + '.'
}

// ---- the ready guard and the auto-merge split ----

/*
 * A pull request is ready as core's readiness contract defines it (readiness.ts). Taking it out of
 * draft and merging it are refused while its CI is not green or a record failed at the head, through
 * the tool and through Bash alike; a record only absent there is observed, and the act goes on without
 * the Ready label, which the gate puts when the whole contract holds. In a repository not in
 * auto-merge, leaving draft meets the same gate on every route, and a merge is refused through Bash: the
 * tool asks the person for it. A pull request that carries Not Ready and none of whose checks has
 * passed yet may leave draft for its CI to run, still Not Ready, in every repository.
 */

export const RECORD_TOOL = 'mcp__github__record'

// A line in the transcript that never fails what it reports on.
function note($: Mod, text: string): void {
  try {
    const sent: unknown = $.ui.log(text)
    if (isCatchable(sent)) sent.catch(() => undefined)
  } catch {
    // Nowhere to say it: the act it notes is not held for that.
  }
}

async function configDir($: Mod): Promise<string | undefined> {
  const named = await $.env.get('CLAUDE_CONFIG_DIR')
  if (named) return String(named)
  const home = await $.env.get('HOME')
  return home ? home + '/.claude' : undefined
}

// A guard that no longer refuses: the call goes on, one refusal event of its code is journaled.
async function observed($: Mod, code: string): Promise<void> {
  let config: string | undefined
  try {
    config = await configDir($)
  } catch {
    // Without a configuration directory observe says it cannot journal; the call goes on.
  }
  await observe($, config, code)
}

// A refusal that protects something: one refusal event of its stable code, then the refusal.
async function refuse($: Mod, code: string, text: string): Promise<{ deny: string }> {
  await observed($, code)
  return { deny: text }
}

/*
 * The light CI's project file, ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/light-ci/<owner>-<name>.json, which the
 * gate reads for one key: `off`, the operator's refusal of light CI for the repository. A stacked pull request's
 * repository with no file, or with that refusal, has no light CI: the words the Ready line names it by. Undefined
 * when the file holds a command, or cannot be read, which refuses nothing.
 */
export const LIGHT_CI_TOOL = SCRIPTED.tool
// The host runs a process for 10 minutes at most: the script stops the run within its budget, a little less.
const LIGHT_CI_TIMEOUT_MS = 600_000
const LIGHT_CI_BUDGET_S = 570

async function lightCiOffOf($: Mod, gate: Gate): Promise<string | undefined> {
  if (gate.stacked !== true) return undefined
  try {
    const dir = await configDir($)
    const [owner, name] = gate.repo.toLowerCase().split('/')
    const path = dir ? dir + '/light-ci/' + owner + '-' + name + '.json' : undefined
    if (!path) return undefined
    if (!(await $.fs.exists(path))) return 'no light CI configured for this repository'
    const file: unknown = JSON.parse(String(await $.fs.read(path)))
    const { off, at } = isRecord(file) ? file : {}
    if (typeof off !== 'string' || off.trim() === '') return undefined
    return 'the operator\'s refusal of light CI for this repository ('
      + (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : 'undated') + ')'
  } catch {
    return undefined
  }
}

// ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records, or undefined when unreadable.
async function recordsRoot($: Mod): Promise<string | undefined> {
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
async function headRecords($: Mod, gate: Gate, head = gate.head): Promise<RecordFile[]> {
  const root = await recordsRoot($)
  if (!root) return []
  const dir = root + '/' + gate.repo.toLowerCase() + '/' + head
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch (err: unknown) {
    let absent = false
    try {
      absent = !(await $.fs.exists(dir))
    } catch {
      // Unknown: not read as absent.
    }
    if (absent) return []
    throw new RecordsUnread('the records of ' + head.slice(0, 7) + ' cannot be listed: ' + reasonOf(err).trim())
  }
  const files: RecordFile[] = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (entry?.kind === 'dir' || name.startsWith('.') || !name.endsWith('.json')) continue
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
 * A rebase that leaves a pull request's own commits unchanged keeps its review, its norms check (if one ran) and
 * its E2E waiver: a kind with no record at the head counts as present when an earlier head of the
 * same pull request holds one, clean, passed or waived, and that head's fingerprint is the head's
 * (the engine's pr-fingerprint: the diffs of the pull request's k commits along first parents, so a
 * parent branch rewritten below them changes nothing). An E2E pass is run again at the new head, and
 * CI is always read at it. An earlier head carries only when it held as many commits of the pull
 * request as the head: the count each gate read finds at its head is kept in the data directory, with
 * the fingerprint once computed over that count (version 3: the files of version 1 and 2, whose count
 * may be another head's, are never read).
 */
const SHA = /^[0-9a-f]{40}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const FINGERPRINT_VERSION = 3
export const FINGERPRINT_PREFIX = 'fingerprint.'

type Fingerprint = { fingerprint: string; commits: number }
// What the data directory keeps of a head: its commit count, and the fingerprint over it once computed.
type Kept = { commits: number; fingerprint?: string }

async function fingerprintPath($: Mod, repo: string, pr: number, head: string): Promise<string | undefined> {
  const dir = await dataDir($)
  return dir ? dir + '/' + FINGERPRINT_PREFIX + encodeURIComponent(repo.toLowerCase()) + '.' + pr + '.' + head + '.json' : undefined
}

const countOf = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

async function keptOf($: Mod, path: string | undefined): Promise<Kept | undefined> {
  try {
    if (!path || !(await $.fs.exists(path))) return undefined
    const kept: unknown = JSON.parse(String(await $.fs.read(path)))
    if (!isRecord(kept) || kept['v'] !== FINGERPRINT_VERSION) return undefined
    const { commits, fingerprint } = kept
    if (!countOf(commits)) return undefined
    return { commits, ...(typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint) ? { fingerprint } : {}) }
  } catch {
    return undefined
  }
}

async function writeKept($: Mod, path: string, repo: string, pr: number, head: string, kept: Kept): Promise<void> {
  await $.fs.write(path, JSON.stringify({ v: FINGERPRINT_VERSION, repo: repo.toLowerCase(), pr, head, ...kept }) + '\n').catch(() => undefined)
}

// The commit count the gate read at its head, kept for when that head is an earlier one; a count
// that changed at the same head (a base merged into it) drops the fingerprint taken over the other.
async function keepCount($: Mod, gate: Gate): Promise<void> {
  if (gate.state !== 'open' || !countOf(gate.commits)) return
  const path = await fingerprintPath($, gate.repo, gate.pr, gate.head)
  if (path && (await keptOf($, path))?.commits !== gate.commits) await writeKept($, path, gate.repo, gate.pr, gate.head, { commits: gate.commits })
}

// The fingerprint of the pull request's own commits at a head, over `count` commits (by default the
// pull request's), or a throw naming why there is none.
async function headFingerprint($: Mod, repo: string, pr: number, head: string, count?: number): Promise<Fingerprint> {
  const path = await fingerprintPath($, repo, pr, head)
  const kept = await keptOf($, path)
  if (kept?.fingerprint && (count === undefined || kept.commits === count)) return { fingerprint: kept.fingerprint, commits: kept.commits }
  const computed: unknown = JSON.parse(await runGh($, 'pr-fingerprint', { pr, head, ...(count === undefined ? {} : { count }) }, repo))
  const { fingerprint, commits } = isRecord(computed) ? computed : {}
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint) || !countOf(commits)) throw new Error('pr-fingerprint answered no fingerprint')
  if (path) await writeKept($, path, repo, pr, head, { commits, fingerprint })
  return { fingerprint, commits }
}

// The pull requests each head directory's records name, by path, as of the directory's mtime: a
// directory whose records name other pull requests only is not read again until a record lands in it.
const headPrs = new Map<string, { mtimeMs: number; prs: number[] }>()

// The records of the gate's pull request at its earlier heads, read once each, by head, and the
// first head whose records cannot be listed, by why.
async function earlierRecords($: Mod, gate: Gate, root: string): Promise<{ found: Map<string, RecordFile[]>; unread?: string | undefined }> {
  const dir = root + '/' + gate.repo.toLowerCase()
  const found = new Map<string, RecordFile[]>()
  let unread: string | undefined
  let heads: string[]
  try {
    heads = (await $.fs.list(dir))
      .filter((x) => x?.kind === 'dir' && SHA.test(String(x.name)) && x.name !== gate.head)
      .map((x) => String(x.name))
  } catch {
    return { found }
  }
  for (const head of heads) {
    const path = dir + '/' + head
    let mtimeMs = NaN
    try {
      mtimeMs = Number((await $.fs.stat(path)).mtimeMs)
    } catch {
      // Read as changed.
    }
    const known = headPrs.get(path)
    if (known && known.mtimeMs === mtimeMs && !known.prs.includes(Number(gate.pr))) continue
    let files: RecordFile[]
    try {
      files = await headRecords($, gate, head)
    } catch (err: unknown) {
      // Unread, it may hold any kind of the pull request: no earlier head carries.
      unread ??= reasonOf(err).trim()
      continue
    }
    // A file that does not parse may be the pull request's: such a directory is read every time.
    if (Number.isFinite(mtimeMs) && unreadableRecords(files).length === 0) headPrs.set(path, { mtimeMs, prs: recordPrs(files) })
    found.set(head, files)
  }
  return { found, unread }
}

/*
 * The records the earlier heads of the same commits carry to the gate's head, for the kinds it has
 * none of: per kind, the latest record by its time across every earlier head of the same commit count
 * and fingerprint, so a newer failure at one of them is never hidden by an older pass at another. An
 * earlier head that cannot be fingerprinted may hold that newer failure: the kinds it has records of
 * are carried from no head, and every kind when the records of a head cannot be listed. A record file
 * of a head of the same diff that does not parse may be that failure too: its kind is carried from no head.
 */
async function carriedRecords($: Mod, gate: Gate, files: RecordFile[]): Promise<Carried[]> {
  await keepCount($, gate)
  // A tests record carries only to a stacked pull request: the bottom one reads no light CI.
  const possible = KINDS.filter((kind) => kind !== SCRIPTED.kind || gate.stacked === true)
  const wanted = gate.state === 'open' ? unrecorded(gate, files).filter((kind) => possible.includes(kind)) : []
  const root = wanted.length > 0 ? await recordsRoot($) : undefined
  if (!root) return []
  const { found, unread } = await earlierRecords($, gate, root)
  const waivers: Carried[] = []
  for (const kind of unread ? [] : WAIVED.filter((k) => wanted.includes(k))) {
    const waiver = durableWaiver(gate, found, kind)
    if (waiver) waivers.push(waiver)
  }
  // A waiver stands beside what the same diff carries, or alone.
  const withWaiver = (carried: Carried[]): Carried[] => [...carried, ...waivers.filter((w) => !carried.some((c) => c.kind === w.kind))]
  // A line on the kinds not carried leaves out the kinds a waiver stands for.
  const uncarried = (reason: string, kinds: PrRecord['kind'][] = wanted) => {
    const left = kinds.filter((kind) => !waivers.some((w) => w.kind === kind))
    if (left.length > 0) note($, uncarriedLine(gate.repo, gate.pr, gate.head, reason, left.length === possible.length ? undefined : left))
  }
  const candidates: Array<{ head: string; latest: PrRecord[]; unreadable: Array<{ name: string; kinds: PrRecord['kind'][] }> }> = []
  for (const [head, records] of found) {
    const at = headLatest(gate, head, records)
    const latest = wanted.flatMap((kind) => at.get(kind) ?? [])
    const unreadable = unreadableRecords(records)
      .map((file) => ({ name: file.name, kinds: file.kinds.filter((kind) => wanted.includes(kind)) }))
      .filter((file) => file.kinds.length > 0)
    if (latest.length > 0 || unreadable.length > 0) candidates.push({ head, latest, unreadable })
  }
  if (!candidates.some((c) => c.latest.some(carries))) return withWaiver([])
  if (unread) {
    uncarried(unread)
    return withWaiver([])
  }
  let current: Fingerprint
  try {
    current = await headFingerprint($, gate.repo, gate.pr, gate.head, countOf(gate.commits) ? gate.commits : undefined)
  } catch (err: unknown) {
    uncarried(gate.head.slice(0, 7) + "'s commits cannot be fingerprinted: " + reasonOf(err).trim())
    return withWaiver([])
  }
  const newest = new Map<PrRecord['kind'], { record: PrRecord; from: string }>()
  const blocked = new Set<PrRecord['kind']>()
  for (const { head, latest, unreadable } of candidates) {
    const unreadKinds = wanted.filter((kind) => unreadable.some((file) => file.kinds.includes(kind)))
    let earlier: Fingerprint
    try {
      const kept = await keptOf($, await fingerprintPath($, gate.repo, gate.pr, head))
      if (!kept) throw new Error('the pull request was never read at that head, its commit count is not known')
      if (kept.commits !== current.commits) continue
      earlier = await headFingerprint($, gate.repo, gate.pr, head, kept.commits)
    } catch (err: unknown) {
      const kinds = wanted.filter((kind) => unreadKinds.includes(kind) || latest.some((record) => record.kind === kind))
      for (const kind of kinds) blocked.add(kind)
      uncarried(head.slice(0, 7) + "'s commits cannot be fingerprinted: " + reasonOf(err).trim(), kinds)
      continue
    }
    if (earlier.fingerprint !== current.fingerprint) continue
    if (unreadKinds.length > 0) {
      for (const kind of unreadKinds) blocked.add(kind)
      const files = unreadable.map((file) => head.slice(0, 7) + "'s record " + file.name + ' does not parse').join(', ')
      uncarried(files, unreadKinds)
    }
    for (const record of latest) {
      const before = newest.get(record.kind)?.record
      // At the same time, the record that carries nothing wins.
      if (!before || record.at > before.at || (record.at === before.at && !carries(record))) newest.set(record.kind, { record, from: head })
    }
  }
  return withWaiver(wanted.flatMap((kind) => {
    const kept = newest.get(kind)
    return kept && carries(kept.record) && !blocked.has(kind) ? [{ kind, from: kept.from }] : []
  }))
}

// ---- E2E a pull request does not need (e2e-scope.ts) ----

// The files of a pull request, or a throw: never read as none.
async function prFiles($: Mod, repo: string, pr: number): Promise<PrFile[]> {
  return parsePrFiles(await runGh($, 'pr-files', { pr }, repo))
}

// The repository's exemption file as it stands, or undefined when there is none or it cannot be read.
async function readExemption($: Mod, repo: string): Promise<Exemption | undefined> {
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

// Whether an exemption with an expiry has run out on the module's clock. A clock that cannot be read runs it out
// (the exemption the operator limited excuses only while it is known to stand).
// One with no expiry never reads the clock.
async function runOut($: Mod, exemption: Exemption): Promise<boolean> {
  if (exemption.until === undefined) return false
  try {
    const now = Number(await $.clock.now())
    return Number.isFinite(now) ? expired(exemption, now) : true
  } catch {
    return true
  }
}

// The line of the operator's exemption that covers this pull request, or undefined. Any doubt (a
// file or a list of files that cannot be read) covers nothing: the E2E record is asked as before.
async function e2eExemptionOf($: Mod, gate: Gate): Promise<string | undefined> {
  const exemption = await readExemption($, gate.repo)
  if (!exemption?.exempt || (await runOut($, exemption))) return undefined
  let files: PrFile[] | undefined
  if (exemption.paths.length > 0) files = await prFiles($, gate.repo, Number(gate.pr)).catch(() => undefined)
  return covers(exemption, gate.labels, files) ? exemptionLine(exemption) : undefined
}

// What a pull request misses, and one line more when its repository's exemption ran out while its E2E record is
// missing: the operator's limit is why the exemption no longer stands for it. A rule by labels it does not carry,
// or an E2E that failed, was never the exemption's to excuse: no line. A rule by paths is not read here, the line stays.
async function missingWithExpiry($: Mod, gate: Gate, missing: string[]): Promise<string[]> {
  if (!missing.some((item) => item.startsWith('e2e: no record'))) return missing
  const exemption = await readExemption($, gate.repo)
  if (!exemption?.exempt || !(await runOut($, exemption))) return missing
  return exemption.paths.length > 0 || covers(exemption, gate.labels, undefined) ? [...missing, expiryLine(exemption)] : missing
}

// The pull request's check plan as it stands, or undefined when there is none or it cannot be read: then it owes every proof.
async function readPlan($: Mod, repo: string, pr: number): Promise<CheckPlan | undefined> {
  try {
    const dir = await dataDir($)
    const path = dir ? planPath(dir, repo, pr) : undefined
    if (!path || !(await $.fs.exists(path))) return undefined
    const plan = parsePlan(JSON.parse(String(await $.fs.read(path))))
    return plan && plan.repo === repo.toLowerCase() && plan.pr === pr ? plan : undefined
  } catch {
    return undefined
  }
}

// The kinds that stand without a record at the head: those the plan excuses, and E2E under the operator's exemption.
async function excusedOf($: Mod, gate: Gate): Promise<Excused> {
  const exempt = await e2eExemptionOf($, gate)
  return { ...(exempt ? { e2e: exempt } : {}), ...planExcuses(await readPlan($, gate.repo, Number(gate.pr))) }
}

type Readiness = { gate?: Gate; missing: string[]; carried?: Carried[]; error?: string }

// What a pull request misses at its head, read from GitHub and the records.
async function readiness($: Mod, repo: string, pr: number, sha?: string): Promise<Readiness> {
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: unknown) {
    return { missing: [], error: reasonOf(err).trim() }
  }
  let files: RecordFile[]
  try {
    files = await headRecords($, gate)
  } catch (err: unknown) {
    if (err instanceof RecordsUnread) return { gate, missing: [], error: err.message }
    throw err
  }
  const carried = await carriedRecords($, gate, files)
  const missing = missingItems(gate, files, sha, await excusedOf($, gate), carried, 'gate', await lightCiOffOf($, gate))
  return { gate, missing: await missingWithExpiry($, gate, missing), carried }
}

/*
 * The Ready label follows the gate: whenever the module learns something that can complete or
 * break readiness (a record written, the gate or the checks read through the tool), it reads the
 * three at the head and puts Ready, or Not Ready back on a pull request carrying Ready. The head is
 * read again just before the write, and a head that moved meanwhile gets no label. The draft
 * state is left as it is, never put back. The
 * labels the gate leaves (labels, draft) when it wrote, and the line it says, or none: always
 * names what is missing too. It never fails the call it follows.
 */
// `unwritten`: the gate read at the head, its label not written (the reconciler keeps the reading all the same).
// `held`: Ready held over a Not Ready this machine did not set, until when (ms) at the earliest; none when the clock cannot be read.
type Followed = { line?: string; labels?: string[]; draft?: boolean; missing?: string[]; gate?: Gate; unwritten?: { gate: Gate; missing: string[] }; held?: { until: number | undefined } }

const flapKey = (repo: string, pr: number) => repo.toLowerCase() + '#' + pr

// The reconciler's say on a label about to be written: `copies` whether to hold it for the forge copy of the head's records,
// `flap` whether to hold it as another machine keeps undoing it (it says so itself, once).
type Watch = { copies: (gate: Gate, move: LabelMove) => boolean; flap: (gate: Gate, move: LabelMove) => boolean }

// What this machine saw of a pull request's label, shared by the reconciler and the tools of every session: a file of the
// data directory, changed under core's store lock. Without a data directory, what this module instance saw.
const seenInMemory = new Map<string, Seen>()

// Notes the labels the gate read at its head, and gives what this machine saw of them (reconcile.ts seenLabel).
async function noteSeen($: Mod, repo: string, pr: number, gate: Gate, now: number): Promise<Seen> {
  return changeSeen($, repo, pr, (current) => seenLabel(current, gate.head, gate.labels, now))
}

// Notes the label this machine wrote.
async function noteWrote($: Mod, repo: string, pr: number, head: string, move: LabelMove, now: number): Promise<void> {
  await changeSeen($, repo, pr, () => seenWrote(head, move, now))
}

async function changeSeen($: Mod, repo: string, pr: number, change: (current: Seen | undefined) => Seen): Promise<Seen> {
  const data = await dataDir($)
  const memory = flapKey(repo, pr)
  if (!data) {
    const next = change(seenInMemory.get(memory))
    seenInMemory.set(memory, next)
    return next
  }
  let next: Seen | undefined
  try {
    await updateOver(journalIoOf($), seenPath(data, repo, pr), (current) => {
      const kept = parseSeen(current)
      next = change(kept)
      return kept !== undefined && seenText(kept) === seenText(next) ? undefined : seenText(next)
    })
  } catch {
    // A file that cannot be written leaves what was seen where it was: this instance's.
    next = change(seenInMemory.get(memory))
    seenInMemory.set(memory, next)
  }
  return next ?? change(undefined)
}

// When the forge was last listed here and its statuses imported (ms), kept by the reconciler where the tools of every session read it:
// the file, or what this instance holds when it cannot be written. Undefined when it is not known.
const listedInMemory = new Map<string, number>()

async function listedAtOf($: Mod, repo: string): Promise<number | undefined> {
  const data = await dataDir($)
  const read = data ? Number(await textOf($, listedPath(data, repo))) : NaN
  const kept = listedInMemory.get(repo.toLowerCase())
  const known = [read, kept].filter((at): at is number => at !== undefined && Number.isFinite(at) && at > 0)
  return known.length > 0 ? Math.max(...known) : undefined
}

// Keeps that the forge was listed at `at` and its statuses imported. A file that cannot be written is said once; this instance then holds it.
async function noteListed($: Mod, rec: Reconciler, repo: string, at: number): Promise<void> {
  const data = await dataDir($)
  try {
    if (!data) throw new Error('no data directory')
    await writeAtomicOver(journalIoOf($), listedPath(data, repo), String(at) + '\n')
    listedInMemory.delete(repo.toLowerCase())
  } catch {
    listedInMemory.set(repo.toLowerCase(), at)
    const where = data ? listedPath(data, repo) : 'the data directory'
    sayOnce($, rec, 'github: the listing of ' + repo + ' could not be kept in ' + where + ' for the tools of the machine\'s other sessions: a Ready they hold over another machine\'s Not Ready waits for the forge to be read')
  }
}

// unlabelled: Not Ready goes on a pull request carrying neither label too (the reconciler's, labelMove).
// watch: the reconciler's, which holds a label that another machine keeps undoing and one that waits for a record's copy to
// reach the forge. Whoever follows, Ready is held over a Not Ready this machine did not set (`held`: when it may go).
async function followGate($: Mod, repo: string, pr: number, known?: Gate, always = false, unlabelled = false, watch?: Watch): Promise<Followed> {
  let gate: Gate
  let missing: string[]
  let excused: Excused
  let accepted: string | undefined
  let carried: Carried[]
  let ciText: string | undefined
  try {
    gate = known ?? parseGate(await runGh($, 'pr-gate', { pr }, repo))
    excused = await excusedOf($, gate)
    const files = await headRecords($, gate)
    carried = await carriedRecords($, gate, files)
    const off = await lightCiOffOf($, gate)
    missing = await missingWithExpiry($, gate, missingItems(gate, files, undefined, excused, carried, undefined, off))
    accepted = reviewAccepted(gate, files)
    ciText = stackedCi(gate, files, carried, off)
  } catch (err: unknown) {
    return { line: gateLeftLine(repo, pr, reasonOf(err).trim()) }
  }
  const readAt = await nowMs($)
  const seen = Number.isFinite(readAt) ? await noteSeen($, repo, pr, gate, readAt) : undefined
  const move = labelMove(gate, missing, unlabelled)
  if (!move) {
    if (always && gate.state === 'open' && missing.length > 0) return { line: gateMissingLine(repo, pr, gate.head, missing, accepted, carried), missing, gate }
    return { missing, gate }
  }
  if (watch?.copies(gate, move)) return { missing, gate }
  if (!Number.isFinite(readAt)) {
    // The sighting cannot be dated, so a Not Ready cannot be told this machine's from another's: Ready waits for a clock (no
    // ceiling: it needs the time too, and a host that cannot tell it is broken, not slow).
    if (move === 'ready' && gate.labels.some((label) => label.toLowerCase() === NOT_READY)) return { line: gateHeldLine(repo, pr, gate.head, undefined, readAt), missing, gate, held: { until: undefined } }
  } else {
    const listedAt = await listedAtOf($, repo)
    const until = foreignHold(seen, move, listedAt, readAt)
    if (until !== undefined) return { line: gateHeldLine(repo, pr, gate.head, until, readAt), missing, gate, held: { until } }
    if (foreignGivenUp(seen, move, listedAt, readAt)) note($, gateHeldGivenUpLine(repo, pr, gate.head, FOREIGN_CEILING_MS / 60_000))
  }
  if (watch?.flap(gate, move)) return { missing, gate }
  let now: HeadRead
  try {
    now = parseHeadRead(await runGh($, 'pr-gate', { pr, 'head-only': true }, repo))
  } catch (err: unknown) {
    return { line: gateLeftLine(repo, pr, reasonOf(err).trim()) }
  }
  if (now.head !== gate.head) return { line: gateMovedLine(repo, pr, gate.head, now.head) }
  try {
    await runGh($, 'pr-readiness', { pr, state: move }, repo)
  } catch (err: unknown) {
    return { line: gateUnwrittenLine(repo, pr, reasonOf(err).trim()), unwritten: { gate, missing } }
  }
  // Every write is noted, the tool's too: only the same label put again counts as undone by another machine.
  if (reconciler) {
    reconciler.flaps.set(flapKey(repo, pr), flapWrote(reconciler.flaps.get(flapKey(repo, pr)), gate.head, move))
  }
  const written = await nowMs($)
  if (Number.isFinite(written)) await noteWrote($, repo, pr, gate.head, move, written)
  const labels = [...now.labels.filter((label) => ![READY, NOT_READY].includes(label.toLowerCase())), move === 'ready' ? 'Ready' : 'Not Ready']
  const draft = now.draft
  if (move === 'ready') return { line: gateReadyLine(repo, pr, gate.head, accepted, excused, carried, ciText), labels, draft, missing, gate }
  return { line: gateNotReadyLine(repo, pr, gate.head, missing, carried), labels, draft, missing, gate }
}

/*
 * The reconciler: one per machine, the session holding the lease (reconcile.ts). At each beat it lists the open pull
 * requests of the repositories it follows when their listing is due (`pr-panel --reconcile`, one GitHub call a
 * repository), then runs the gate (followGate) on each pull request whose fingerprint changed since its last reading,
 * GATES_PER_TICK at most, Not Ready put on one carrying neither label. Each reading is kept under the configuration
 * directory (core's pr-reconcile.ts), where the orchestrator reads it. It runs on the module's timer, never inside a
 * tool call or a hook, one beat at a time; a beat that fails is one line, and the next beat tries again.
 */
type Reconciler = {
  timer?: { cancel: () => void }
  me: string
  running: boolean
  // Each repository's next listing, the open pull requests it last listed, the account that listed them and when (ms).
  repos: Map<string, Listed>
  // The fingerprint of each pull request's last reading, by repo#pr; a gate that failed, with its fingerprint and when.
  kept: Map<string, string>
  failed: Map<string, { fingerprint: string; at: number }>
  // What each head was last copied with to and from the forge (forge-sync.ts), by repo#pr: what it read, when, and whether all went through.
  synced: Map<string, { key: string; at: number; ok: boolean; imported: boolean }>
  // The label last written to each pull request, by repo#pr, and how often another machine took it away (reconcile.ts flapCheck).
  flaps: Map<string, Flap>
  // What each head holds that is not on the forge yet, by repo#pr: the copies waiting for their tool, refused or over the beat's budget.
  unpublished: Map<string, ForgePost[]>
  // A move held back, by repo#pr, for the fingerprint it was read at: the gate is not read again before `until` (ms), nor while the
  // same copies are missing. `since`: when this fingerprint was first held; `copies`: held for copies to post, `until` then the ceiling.
  held: Map<string, { fingerprint: string; until: number; unpublished: string; since: number; copies: boolean }>
  edgeSeen: number
  counts: Counts
  // The last line said, and whether this beat said one: a beat that said none lets the same failure be said again.
  said: string | undefined
  saidNow: boolean
  // The host's session id, and the counts the journal last received.
  session: string
  journaled: Counts
  // When the journal last received them (ms), 0 before the first.
  journaledAt: number
  // No listing and no gate before this (ms): the quota ran low, or a listing was refused for the rate limit.
  quotaUntil: number
}

// kept: the listing (ms) the tools of the sessions were told of.
type Listed = { schedule: Schedule; rows: ListedPr[]; viewer?: string; listedAt?: number; kept?: number }

let reconciler: Reconciler | undefined

// A file's text, undefined when it is not there or cannot be read.
const textOf = ($: Mod, path: string): Promise<string | undefined> => Promise.resolve().then(() => $.fs.read(path)).then(String, () => undefined)
// A path's mtime, 0 when it is not there or cannot be read.
const mtimeOf = ($: Mod, path: string): Promise<number> => Promise.resolve().then(() => $.fs.stat(path)).then((stat) => Number(stat.mtimeMs) || 0, () => 0)
// The directories of a directory, by name; none when it cannot be listed.
const dirsOf = async ($: Mod, path: string): Promise<string[]> =>
  (await Promise.resolve().then(() => $.fs.list(path)).catch((): FsEntry[] => [])).filter((x) => x?.kind === 'dir').map((x) => String(x.name))

// The repositories the reconciler follows at `now`: those whose records directory changed within RECENT_MS, and
// those the orchestrator's pull request file read.
async function followedRepos($: Mod, config: string, root: string, now: number): Promise<string[]> {
  const records: Array<{ repo: string; mtimeMs: number }> = []
  for (const owner of await dirsOf($, root)) {
    for (const name of await dirsOf($, root + '/' + owner)) {
      const repo = owner + '/' + name
      if (isRepoName(repo)) records.push({ repo, mtimeMs: await mtimeOf($, root + '/' + repo) })
    }
  }
  // The orchestrator's state directory where it stands by default: its override is a variable of its own.
  return reconciledRepos(records, prFileRepos((await textOf($, prFilePath(moduleDirOf(config)))) ?? ''), now)
}

// What the gate reads on this machine for a pull request: its head's records directory, its plan, its repository's exemption.
async function localOf($: Mod, root: string, data: string, repo: string, row: ListedPr, exemption: Exemption | undefined): Promise<Local> {
  return {
    records: await mtimeOf($, root + '/' + repo + '/' + row.head),
    plan: data ? await mtimeOf($, planPath(data, repo, row.number)) : 0,
    exemption: data ? await mtimeOf($, exemptionPath(data, repo)) : 0,
    expired: exemption !== undefined && (await runOut($, exemption)),
  }
}

// A line the reconciler says once until it says another: a failure that repeats at every beat is not repeated.
function sayOnce($: Mod, rec: Reconciler, line: string): void {
  rec.saidNow = true
  if (rec.said === line) return
  rec.said = line
  note($, line)
}

// Whether a held move calls for a listing now: a Ready held over another machine's Not Ready that has waited long enough with no listing since, or copies still to post.
function forgeAwaited(rec: Reconciler, repo: string, now: number): boolean {
  const listedAt = rec.repos.get(repo)?.listedAt ?? 0
  // A move held for copies still to post lists at each beat until its ceiling: the copies left to their tool are posted by a listing taken after their settling.
  return [...rec.held].some(([key, held]) => key.startsWith(repo.toLowerCase() + '#') && (held.copies ? now < held.until && listedAt < now : held.until <= now && listedAt < held.until))
}

// Lists a repository: its rows and its next listing, the rows kept on a failure. Whether it was listed.
async function listRepo($: Mod, rec: Reconciler, repo: string, now: number): Promise<boolean> {
  const before = rec.repos.get(repo)
  let listing: Listing
  try {
    rec.counts.listings += 1
    listing = parseListing(await runGh($, 'pr-panel', { reconcile: true }, repo))
  } catch (err: unknown) {
    const why = reasonOf(err).trim()
    const limited = /rate limit/i.test(why)
    const schedule = limited ? { nextAt: now + QUOTA_WAIT_MS, idle: before?.schedule.idle ?? 0 } : nextListing(before?.schedule, now, false, [], {})
    if (limited) rec.quotaUntil = Math.max(rec.quotaUntil, schedule.nextAt)
    rec.repos.set(repo, { ...before, rows: before?.rows ?? [], schedule })
    sayOnce($, rec, 'github: the reconciler could not list ' + repo + ': ' + why)
    return false
  }
  const changed = JSON.stringify(before?.rows ?? null) !== JSON.stringify(listing.rows)
  const schedule = nextListing(before?.schedule, now, changed, listing.rows, listing.rate)
  // The quota is the account's: once low, no repository is listed and no gate read before its reset.
  if (listing.rate.remaining !== undefined && listing.rate.remaining < QUOTA_LOW) rec.quotaUntil = Math.max(rec.quotaUntil, schedule.nextAt)
  rec.repos.set(repo, { rows: listing.rows, schedule, ...(listing.viewer !== undefined ? { viewer: listing.viewer } : {}), listedAt: now })
  return true
}

// The readings of a repository's pull requests no longer open, removed once a listing says so.
async function dropClosed($: Mod, rec: Reconciler, config: string, repo: string, rows: readonly ListedPr[]): Promise<void> {
  const open = new Set(rows.map((row) => row.number + '.json'))
  const dir = reconcileRoot(config) + '/' + repo
  const gone = (await Promise.resolve().then(() => $.fs.list(dir)).catch((): FsEntry[] => []))
    .map((entry) => String(entry?.name ?? ''))
    .filter((name) => /^\d+\.json$/.test(name) && !open.has(name))
  for (const name of gone) rec.kept.delete(repo + '#' + name.slice(0, -'.json'.length))
  // The label notes of a pull request no longer listed open go with its reading.
  const listed = new Set(rows.map((row) => flapKey(repo, row.number)))
  for (const map of [rec.flaps, rec.unpublished, rec.held]) for (const key of [...map.keys()]) if (key.startsWith(repo.toLowerCase() + '#') && !listed.has(key)) map.delete(key)
  if (gone.length === 0) return
  // What the machine saw of their labels goes with the readings.
  const data = await dataDir($)
  const forgotten = data ? gone.map((name) => seenPath(data, repo, Number(name.slice(0, -'.json'.length)))) : []
  const ran = await $.process.run(['rm', '-f', '--', ...gone.map((name) => dir + '/' + name), ...forgotten], { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) sayOnce($, rec, 'github: the reconciler could not remove the readings of closed pull requests of ' + repo + ': ' + (String(ran.stderr ?? '').trim() || 'exit ' + ran.exitCode))
}

// A pull request's reading as the orchestrator reads it (core's pr-reconcile.ts).
function readingOf(repo: string, row: ListedPr, gate: Gate, missing: string[], labels: string[], draft: boolean, now: number, fingerprint: string) {
  return {
    v: RECONCILE_VERSION, repo, pr: row.number, head: gate.head, base: gate.base ?? row.base, draft, labels, ci: gate.ci, missing,
    at: new Date(now).toISOString(), fingerprint,
  }
}

// A session id of the host's shape, the only one an event names.
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/
export const RECONCILE_CODE = 'github.reconcile.counts'

// The reconciler's counts are journaled at most this often: the journal's cap is shared with the module's refusals.
export const JOURNAL_EVERY_MS = 3_600_000

/*
 * What the reconciler did since its last event (core's audit kind `reconcile`), where telemetry's sweep reads it: looked
 * at each renewal of its lease, written at most once per JOURNAL_EVERY_MS. No forge call since (no listing, gate or move),
 * nothing written: its beats go with the next event. A journal that cannot be written is said once, and its counts go
 * with the next event.
 */
async function journalCounts($: Mod, rec: Reconciler, io: ReturnType<typeof journalIoOf>, config: string, now: number): Promise<void> {
  const { ticks, listings, gates, moves } = rec.counts
  const fact = { ticks: ticks - rec.journaled.ticks, listings: listings - rec.journaled.listings, gates: gates - rec.journaled.gates, moves: moves - rec.journaled.moves }
  if (now - rec.journaledAt < JOURNAL_EVERY_MS || fact.listings + fact.gates + fact.moves === 0) return
  const at = new Date(now).toISOString().replace(/\.[0-9]{3}Z$/, 'Z')
  const event = auditEvent({
    at, random: randomPart(), source: { plugin: 'github', code: RECONCILE_CODE }, context: { session: SESSION_ID.test(rec.session) ? rec.session : null },
    trust: 'computed', kind: 'reconcile', fact,
  })
  try {
    if (event === undefined) throw new Error('the event breaks the audit contract')
    await appendEventOver(io, journalDir(config, 'github'), event, at, false)
    rec.journaled = { ...rec.counts }
    rec.journaledAt = now
  } catch (err: unknown) {
    sayOnce($, rec, 'github: the reconciler\'s counts could not be journaled: ' + reasonOf(err).trim())
  }
}

// Holds the lease at `now`: takes or renews it when due, its counts journaled. False when another session holds it.
async function holdLease($: Mod, rec: Reconciler, io: ReturnType<typeof journalIoOf>, config: string, now: number): Promise<boolean> {
  const leasePath = reconcileRoot(config) + '/' + LEASE_FILE
  const lease = parseLease(await textOf($, leasePath))
  const whose = leaseOf(lease, rec.me, now)
  if (whose === 'other') return false
  if (!leaseDue(lease, rec.me, now)) return true
  if ((await updateOver(io, leasePath, (current) => takenLease(current, rec.me, now, rec.counts))) === undefined) return false
  await journalCounts($, rec, io, config, now)
  return true
}

// What a head holds that is not on the forge yet, as the text a held move compares (the same copies missing, the same hold).
const unpublishedKey = (posts: readonly ForgePost[] | undefined): string => (posts ?? []).map((post) => post.name + ' ' + post.state).join(',')

// The copies a move waits for: Ready, every one of the head's (the other machine judges on the forge's); Not Ready, the failures.
const awaited = (posts: readonly ForgePost[], move: LabelMove): ForgePost[] => (move === 'ready' ? [...posts] : posts.filter((post) => post.state === FORGE.states.fail))

// The gate on one pull request whose fingerprint changed, its reading kept.
async function reconcilePr(
  $: Mod, rec: Reconciler, io: ReturnType<typeof journalIoOf>, at: { config: string; root: string; data: string; now: number },
  repo: string, row: ListedPr, local: Local, fingerprint: string,
): Promise<void> {
  const key = repo + '#' + row.number
  const id = flapKey(repo, row.number)
  rec.counts.gates += 1
  // Set when the guard holds a move that is to be tried again: until when (ms), and whether it waits for copies to post.
  const waiting: { until?: number; copies?: boolean } = {}
  const before = rec.held.get(id)?.fingerprint === fingerprint ? rec.held.get(id) : undefined
  const since = before?.since ?? at.now
  const watch: Watch = {
    copies: (gate, move) => {
      // The copies of the head's records the move rests on reach the forge first: the other machine reads them there, not the label.
      const missingCopies = awaited(rec.unpublished.get(id) ?? [], move)
      if (missingCopies.length > 0 && at.now < since + PUBLISH_WAIT_MS) {
        waiting.until = since + PUBLISH_WAIT_MS
        waiting.copies = true
        return true
      }
      if (missingCopies.length > 0) {
        sayOnce($, rec, 'github: the ' + (move === 'ready' ? 'Ready' : 'Not Ready') + ' label of ' + key + ' at ' + gate.head.slice(0, 7) + ' no longer waits for '
          + missingCopies.map((post) => forgeContext(post.name)).join(', ') + ' to reach the forge: it was not posted within ' + String(PUBLISH_WAIT_MS / 60_000) + ' minutes')
      }
      return false
    },
    flap: (gate, move) => {
      // Two machines in lasting disagreement stop moving it.
      const head = gate.head
      const checked = flapCheck(rec.flaps.get(id), head, move)
      if (checked.flap) rec.flaps.set(id, checked.flap)
      if (checked.say) {
        sayOnce($, rec, 'github: the ' + (move === 'ready' ? 'Ready' : 'Not Ready') + ' label of ' + key + ' at ' + head.slice(0, 7) + ' was put back ' + String(FLAP_UNDONE)
          + ' times after it was taken away: this machine no longer moves it there, another machine disagrees on what the pull request misses')
      }
      return checked.hold
    },
  }
  const followed = await followGate($, repo, row.number, undefined, false, true, watch)
  // Ready held over a Not Ready this machine did not set: the gate is read again once the forge was listed after the wait.
  if (followed.held) waiting.until = followed.held.until ?? at.now + TICK_MS
  const gate = followed.gate
  if (!gate || followed.missing === undefined) {
    rec.failed.set(key, { fingerprint, at: at.now })
    if (followed.line) sayOnce($, rec, followed.line)
    // The gate was read at the head, only its label failed: the reading is kept, the label tried again after RETRY_MS.
    // Its fingerprint is none, so a restart that seeds from the file reads the gate again too.
    const read = followed.unwritten
    if (read) await writeAtomicOver(io, reconcilePath(at.config, repo, row.number), JSON.stringify(readingOf(repo, row, read.gate, read.missing, read.gate.labels, read.gate.draft, at.now, '')) + '\n')
    return
  }
  if (followed.labels) rec.counts.moves += 1
  // A held move: the reading is kept for the orchestrator, the gate read again when what holds it has passed (its fingerprint is none).
  if (waiting.until !== undefined) {
    rec.held.set(id, { fingerprint, until: waiting.until, unpublished: unpublishedKey(rec.unpublished.get(id)), since, copies: waiting.copies === true })
    // The fingerprint a clean gate kept is no longer the label's: the gate is read again if the pull request returns to it.
    rec.kept.delete(key)
    await writeAtomicOver(io, reconcilePath(at.config, repo, row.number), JSON.stringify(readingOf(repo, row, gate, followed.missing, gate.labels, gate.draft, at.now, '')) + '\n')
    rec.failed.delete(key)
    return
  }
  rec.held.delete(id)
  // The labels the gate left are those the next listing reads: the fingerprint is kept with them.
  // The machine's side as it stood before the gate read it: a record written during the gate changes the next fingerprint.
  const kept = followed.labels ? fingerprintOf(row, local, followed.labels) : fingerprint
  const reading = readingOf(repo, row, gate, followed.missing, followed.labels ?? gate.labels, followed.draft ?? gate.draft, at.now, kept)
  await writeAtomicOver(io, reconcilePath(at.config, repo, row.number), JSON.stringify(reading) + '\n')
  rec.kept.set(key, kept)
  rec.failed.delete(key)
}

// Posts the status that copies a record, the plan or the exemption at a head (engine/forge_status.py); the line that
// says why it failed, or undefined.
async function postForge($: Mod, repo: string, head: string, post: ForgePost): Promise<string | undefined> {
  const run = await $.process.run([
    'python3', $.plugin.root + '/engine/forge_status.py', '--repo', repo, '--head', head, '--what', post.name, '--state', post.state, '--description', post.description,
  ], { timeoutMs: 30_000 })
  return run.exitCode === 0 ? undefined : String(run.stderr || 'forge_status.py exited ' + run.exitCode).trim()
}

// Copies to the forge the record a tool just wrote at `path`. A copy that fails is one line in the log, the tool's
// answer unchanged: the reconciler posts it at a later beat.
async function postWritten($: Mod, path: string): Promise<void> {
  const record = parsePrRecord(await Promise.resolve().then(() => $.fs.read(path)).then((text) => JSON.parse(String(text)) as unknown, () => undefined))
  const post = record ? recordPost(record) : undefined
  const failed = record && post ? await postForge($, record.repo, record.head, post) : 'the record at ' + path + ' cannot be read back'
  if (failed) note($, 'github: the record is not copied to the forge yet (' + failed + '): the reconciler copies it at a later beat.')
}

// The records a head holds on this machine, or undefined when its directory is there but cannot be listed.
async function recordsAt($: Mod, root: string, repo: string, head: string): Promise<PrRecord[] | undefined> {
  const dir = root + '/' + repo + '/' + head
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return (await Promise.resolve().then(() => $.fs.exists(dir)).catch(() => true)) ? undefined : []
  }
  const records: PrRecord[] = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (entry?.kind === 'dir' || name.startsWith('.') || !name.endsWith('.json')) continue
    const text = await textOf($, dir + '/' + name)
    let raw: unknown
    try {
      raw = JSON.parse(text ?? '')
    } catch {
      continue
    }
    const record = parsePrRecord(raw)
    if (record && record.head === head) records.push(record)
  }
  return records
}

/*
 * Copies one head between this machine and the forge (forge-sync.ts): the newer copies the forge holds of its records,
 * its plan and its repository's exemption are written here, and those this machine holds newer are posted, the beat's
 * `budget` of posts at most. Nothing is done again while what it read is unchanged, nor before RETRY_MS after a
 * failure. Whether it wrote something here.
 */
async function syncForge(
  $: Mod, rec: Reconciler, at: { root: string; data: string; now: number }, repo: string, listed: Listed, row: ListedPr,
  exemption: Exemption | undefined, budget: { posts: number },
): Promise<{ wrote: boolean; ok: boolean; imported: boolean }> {
  const viewer = listed.viewer
  const id = repo + '#' + row.number
  if (row.statuses === undefined || !viewer || listed.listedAt === undefined) {
    rec.unpublished.delete(flapKey(repo, row.number))
    // Nothing to import: the listing carries no statuses, or no account says whose they are.
    return { wrote: false, ok: true, imported: true }
  }
  const local = await localOf($, at.root, at.data, repo, row, exemption)
  const key = JSON.stringify([row.head, row.statuses, local.records, local.plan, local.exemption])
  const last = rec.synced.get(id)
  if (last?.key === key && (last.ok || at.now - last.at < RETRY_MS)) return { wrote: false, ok: last.ok, imported: last.imported }
  const records = await recordsAt($, at.root, repo, row.head)
  if (records === undefined) {
    // What it waited for stays: an unread set is not an empty one.
    sayOnce($, rec, 'github: the reconciler could not read the records of ' + id + ' at ' + row.head.slice(0, 7) + ': its forge copies wait')
    return { wrote: false, ok: false, imported: false }
  }
  const plan = at.data ? await readPlan($, repo, row.number) : undefined
  const sync = forgeSync({ repo, statuses: row.statuses, viewer, records, plan, exemption: at.data ? exemption : undefined, listedAt: listed.listedAt })
  // ok: nothing failed; imported: what the forge holds was copied here (a refused post or a spent budget leaves it so).
  let ok = true
  let imported = true
  for (const copy of sync.records) {
    const run = await $.process.run([
      'python3', $.plugin.root + '/engine/record.py', '--repo', repo, '--pr', String(row.number), '--head', row.head, '--kind', copy.kind,
      '--result', copy.result, '--producer', copy.producer, '--detail', 'copied from the forge, ' + forgeContext(copy.kind) + ' posted by ' + viewer,
      '--session', FORGE_SESSION, '--at', copy.at,
    ], { timeoutMs: 30_000 })
    if (run.exitCode !== 0) {
      ok = false
      imported = false
      sayOnce($, rec, 'github: the reconciler could not copy ' + forgeContext(copy.kind) + ' of ' + id + ' from the forge: ' + (String(run.stderr ?? '').trim() || 'exit ' + run.exitCode))
    }
  }
  // The plan and the exemption are written as their tools write them, under the list's lock.
  const copies: Array<{ what: string; path: string; body: object }> = []
  if (sync.plan && at.data) copies.push({ what: 'readiness/plan', path: planPath(at.data, repo, row.number), body: { v: 1, repo: repo.toLowerCase(), pr: row.number, ...sync.plan.checks, at: sync.plan.at } })
  if (sync.exemption && at.data) copies.push({ what: 'readiness/exemption', path: exemptionPath(at.data, repo), body: sync.exemption })
  for (const copy of copies) {
    try {
      await withListLock($, copy.path, () => writeAutoMerge($, copy.path, JSON.stringify(copy.body, null, 2) + '\n'))
    } catch (err: unknown) {
      ok = false
      imported = false
      sayOnce($, rec, 'github: the reconciler could not copy ' + copy.what + ' of ' + id + ' from the forge: ' + reasonOf(err).trim())
    }
  }
  for (const line of sync.unposted) sayOnce($, rec, line)
  // What this head holds that is not on the forge when the beat ends: a label move that rests on it waits (reconcilePr).
  const pending: ForgePost[] = [...(sync.deferred ?? [])]
  for (const [done, post] of sync.posts.entries()) {
    if (budget.posts >= POSTS_PER_TICK) {
      ok = false
      pending.push(...sync.posts.slice(done))
      break
    }
    budget.posts += 1
    rec.counts.posts = (rec.counts.posts ?? 0) + 1
    const failed = await postForge($, repo, row.head, post)
    if (failed) {
      ok = false
      pending.push(post)
      sayOnce($, rec, 'github: the reconciler could not post ' + forgeContext(post.name) + ' of ' + id + ': ' + failed)
      continue
    }
    // What the next listing reads: the status as posted, so the same post is not made twice.
    const context = forgeContext(post.name)
    row.statuses = sortedStatuses([...row.statuses.filter((s) => s.context !== context), { context, state: post.state, description: post.description, creator: viewer }])
  }
  if (pending.length > 0) rec.unpublished.set(flapKey(repo, row.number), pending)
  else rec.unpublished.delete(flapKey(repo, row.number))
  // A copy left to its tool, or a budget spent, leaves the rest to the next beat at once; a failure, to RETRY_MS later.
  if (sync.waiting && ok) rec.synced.delete(id)
  else if (ok || budget.posts < POSTS_PER_TICK) rec.synced.set(id, { key, at: at.now, ok, imported })
  else rec.synced.delete(id)
  return { wrote: sync.records.length > 0 || sync.plan !== undefined || sync.exemption !== undefined, ok, imported }
}

async function reconcileTick($: Mod): Promise<void> {
  const rec = reconciler
  if (!rec || rec.running) return
  rec.running = true
  rec.saidNow = false
  try {
    const now = await nowMs($)
    const config = await configDir($)
    const root = await recordsRoot($)
    if (!Number.isFinite(now) || !config || !root) return
    const leasePath = reconcileRoot(config) + '/' + LEASE_FILE
    if (leaseOf(parseLease(await textOf($, leasePath)), rec.me, now) === 'other') return
    const repos = await followedRepos($, config, root, now)
    if (repos.length === 0) return
    const io = journalIoOf($)
    if (!(await holdLease($, rec, io, config, now))) return
    rec.counts.ticks += 1
    const edge = await mtimeOf($, reconcileEdgePath(config))
    const woken = edge > rec.edgeSeen
    rec.edgeSeen = Math.max(rec.edgeSeen, edge)
    for (const repo of [...rec.repos.keys()]) {
      if (repos.includes(repo)) continue
      rec.repos.delete(repo)
      for (const map of [rec.unpublished, rec.held]) for (const key of [...map.keys()]) if (key.startsWith(repo + '#')) map.delete(key)
    }
    const listed = new Set<string>()
    for (const repo of repos) {
      if (now < rec.quotaUntil) break
      if ((woken || now >= (rec.repos.get(repo)?.schedule.nextAt ?? 0) || forgeAwaited(rec, repo, now)) && (await listRepo($, rec, repo, now))) listed.add(repo)
    }
    if (now < rec.quotaUntil) return
    const data = await dataDir($)
    const at = { config, root, data, now }
    let gates = 0
    const budget = { posts: 0 }
    for (const [repo, entry] of rec.repos) {
      const { rows } = entry
      if (listed.has(repo)) await dropClosed($, rec, config, repo, rows)
      // The forge's copies first, so the gate reads the same truth on both machines.
      let copied = data ? await readExemption($, repo) : undefined
      let imported = true
      for (const row of rows) {
        const synced = await syncForge($, rec, at, repo, entry, row, copied, budget)
        if (!synced.imported) imported = false
        if (synced.wrote) copied = data ? await readExemption($, repo) : undefined
      }
      // The tools of the machine's sessions read there that the forge was listed and its statuses imported, not before.
      if (imported && entry.listedAt !== undefined && entry.kept !== entry.listedAt) {
        entry.kept = entry.listedAt
        await noteListed($, rec, repo, entry.listedAt)
      }
      const exemption = data ? await readExemption($, repo) : undefined
      for (const row of rows) {
        const key = repo + '#' + row.number
        const local = await localOf($, root, data, repo, row, exemption)
        const fingerprint = fingerprintOf(row, local)
        if (!rec.kept.has(key)) {
          const reading = parseReconcile((await textOf($, reconcilePath(config, repo, row.number))) ?? '')
          if (reading) rec.kept.set(key, reading.fingerprint)
        }
        const failed = rec.failed.get(key)
        if (rec.kept.get(key) === fingerprint || (failed?.fingerprint === fingerprint && now - failed.at < RETRY_MS)) continue
        // A move held back is tried again once its time has come, or the copies it waited for have reached the forge.
        const held = rec.held.get(flapKey(repo, row.number))
        if (held?.fingerprint === fingerprint && now < held.until && held.unpublished === unpublishedKey(rec.unpublished.get(flapKey(repo, row.number)))) continue
        if (gates >= GATES_PER_TICK) break
        // A beat can outlast what the lease had left: it is held again before each gate, the time read anew.
        if (!(await holdLease($, rec, io, config, await nowMs($)))) return
        gates += 1
        await reconcilePr($, rec, io, at, repo, row, local, fingerprint)
      }
    }
  } catch (err: unknown) {
    sayOnce($, rec, 'github: the reconciler\'s beat failed: ' + reasonOf(err).trim())
  } finally {
    if (!rec.saidNow) rec.said = undefined
    rec.running = false
  }
}

// The reconciler's timer, started again at each start of the session (a reload of the module cancels it with the old copy).
async function startReconciler($: Mod): Promise<void> {
  reconciler?.timer?.cancel()
  listedInMemory.clear()
  const session = String(await Promise.resolve().then(() => $.session.id()).catch(() => ''))
  const now = await nowMs($)
  const rec: Reconciler = {
    // The same session started again (resume, clear, compact) keeps its name, and with it the lease it holds.
    me: reconciler?.me ?? (session || 'session') + ':' + Math.random().toString(36).slice(2, 10), running: false, repos: new Map(), kept: new Map(), failed: new Map(), synced: new Map(), flaps: reconciler?.flaps ?? new Map(),
    unpublished: new Map(), held: new Map(),
    edgeSeen: 0, said: undefined, saidNow: false, quotaUntil: 0, session,
    journaled: { since: '', ticks: 0, listings: 0, gates: 0, moves: 0 }, journaledAt: 0,
    counts: { since: Number.isFinite(now) ? new Date(now).toISOString() : '', ticks: 0, listings: 0, gates: 0, moves: 0, posts: 0 },
  }
  reconciler = rec
  // The edge marker as it stands at the start is no news.
  const config = await configDir($)
  if (config) rec.edgeSeen = await mtimeOf($, reconcileEdgePath(config))
  rec.timer = $.clock.every(TICK_MS, () => {
    void reconcileTick($)
  })
}

// The reads after which the gate puts the label.
const GATE_READS = new Set(['pr-gate', 'pr-checks'])

// A read's output once the gate followed it. Its line is the module's own, never in the output;
// pr-gate's JSON says the labels and the draft the gate left.
async function afterRead($: Mod, e: GhCall, output: string): Promise<string> {
  if (!GATE_READS.has(e.command)) return output
  const pr = prNumber(e.args['pr'])
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

// Puts Not Ready, which this machine then keeps as its own (at the head the gate read; with none, at the next head the gate reads):
// Ready goes back over it as soon as the gate allows, with no wait for another machine's records.
async function labelNotReady($: Mod, repo: string, pr: number, head?: string): Promise<void> {
  await runGh($, 'pr-readiness', { pr, state: 'not-ready' }, repo)
  const now = await nowMs($)
  // A write the clock cannot date is not noted, as followGate's.
  if (!Number.isFinite(now)) return
  try {
    await noteWrote($, repo, pr, head ?? '', 'not-ready', now)
  } catch (err: unknown) {
    note($, 'github: the Not Ready put on ' + repo + '#' + pr + ' is not kept as this machine\'s, Ready waits for the forge to be read: ' + reasonOf(err).trim())
  }
}

// The number of the open pull request of a branch, the current one when none
// is named, or undefined.
async function prOfBranch($: Mod, repo: string, branch?: string): Promise<number | undefined> {
  return parsePulls(await runGh($, 'pr-get', branch ? { branch } : {}, repo))[0]?.number
}

// pr-get's answer for a branch: its open pull requests, each with its number and its labels' names, lowercased.
// An answer that is no list holds none, and an entry with no number is left out.
function parsePulls(text: string): Array<{ number: number; labels: string[] }> {
  const raw: unknown = JSON.parse(text)
  const pulls: Array<{ number: number; labels: string[] }> = []
  const entries: unknown[] = Array.isArray(raw) ? raw : []
  for (const pull of entries) {
    if (!isRecord(pull) || typeof pull['number'] !== 'number' || !(pull['number'] > 0)) continue
    const labels: unknown[] = Array.isArray(pull['labels']) ? pull['labels'] : []
    pulls.push({ number: pull['number'], labels: labels.map((l) => String((isRecord(l) ? l['name'] : undefined) ?? l).toLowerCase()) })
  }
  return pulls
}

// What the gate says when it does not let Ready on: the refusal of an act, and pr-readiness's answer.
type Held = { refusal: string; answer: string }

function heldUnverified(repo: string | undefined, pr: number | string | undefined, error: string, gate?: Gate): Held {
  return { refusal: unverifiedRefusal(repo, pr, error), answer: unverifiedAnswer(repo, pr, error, gate?.labels) }
}

// A pull request that is not ready, which also loses Ready when it still carries it, so the label
// never claims what the gate refused.
async function heldNotReady($: Mod, name: string, repo: string, pr: number, r: Readiness): Promise<Held> {
  const gate = r.gate
  if (!gate) throw new Error('the gate of ' + repo + '#' + pr + ' was not read')
  let labels = gate.labels
  if (carriesReady(gate)) {
    try {
      await labelNotReady($, repo, pr, gate.head)
      labels = [...labels.filter((label) => ![READY, NOT_READY].includes(label.toLowerCase())), 'Not Ready']
    } catch (err: unknown) {
      note($, 'github: ' + repo + '#' + pr + ' keeps Ready, the label could not be changed: ' + reasonOf(err))
    }
  }
  return {
    refusal: notReadyRefusal(name, repo, pr, gate.head, r.missing, r.carried),
    answer: notReadyAnswer(repo, pr, gate.head, labels, r.missing, r.carried),
  }
}

// Whether a pull request misses only records absent at its head, the exemption's expiry line beside them.
function missesOnlyRecords(missing: string[]): boolean {
  return onlyAbsentRecords(missing.filter((item) => !isExpiryLine(item)))
}

/*
 * The one readiness check of every act that needs Ready (pr-ready, pr-merge, pr-readiness ready,
 * their shell forms), core's readiness contract read at the head: undefined when the gate put Ready
 * itself, the whole contract holding, CI included; else what is missing, or why that is unknown.
 * An act (`act` true: a merge, leaving draft) goes through as well when only records are absent at
 * the head: CI, a record that failed and a readiness unread still refuse it.
 */
async function gateHeld($: Mod, name: string, repo: string, pr: number, r: Readiness, act = false): Promise<Held | undefined> {
  if (r.error) return heldUnverified(repo, pr, r.error, r.gate)
  const passes = (missing: string[]): boolean => missing.length === 0 || (act && missesOnlyRecords(missing))
  if (!passes(r.missing)) return heldNotReady($, name, repo, pr, r)
  const followed = await followGate($, repo, pr, r.gate)
  if (followed.missing === undefined) return heldUnverified(repo, pr, followed.line ?? 'the Ready label could not be put', r.gate)
  if (!passes(followed.missing)) return heldNotReady($, name, repo, pr, { ...r, missing: followed.missing })
  // Ready held over a Not Ready this machine did not set: the act waits as the gate does.
  if (followed.held && followed.gate) {
    const at = await nowMs($)
    return {
      refusal: gateHeldRefusal(name, repo, pr, followed.gate.head, followed.held.until, at),
      answer: gateHeldAnswer(repo, pr, followed.gate.head, followed.gate.labels, followed.held.until, at),
    }
  }
  if (followed.line) note($, followed.line)
  return undefined
}

/*
 * The tool's pr-readiness ready: Ready goes on only where gateHeld lets it, as for pr-ready. Where
 * it does not, the call answers the state the pull request carries and what is missing, or why that
 * is unknown: an answer, no error, as pr-readiness reports a state (`answer`).
 */
function readyLabelCall($: Mod, e: GhCall): { check: () => Promise<string | undefined>; answer: (refused: string) => { result: string } | undefined } | undefined {
  if (e.command !== 'pr-readiness' || e.args['state'] !== 'ready') return undefined
  let held: Held | undefined
  const check = async (): Promise<string | undefined> => {
    const repo = await targetRepo($, e).catch(() => undefined)
    const named = e.args['pr']
    const pr = prNumber(e.args['pr'])
    try {
      if (!repo || !Number.isInteger(pr) || pr < 1) held = heldUnverified(repo, typeof named === 'number' || typeof named === 'string' ? named : undefined, 'no repository or pull request named')
      else held = await gateHeld($, e.command, repo, pr, await readiness($, repo, pr))
    } catch (err: unknown) {
      held = heldUnverified(repo, pr, reasonOf(err).trim())
    }
    return held?.refusal
  }
  return { check, answer: (refused) => (held && held.refusal === refused ? { result: held.answer } : undefined) }
}

// The Bash ready guard failed on its own: the command is refused as a readiness that could not be read.
function guardThrew(act: Act | undefined, err: unknown): string {
  const error = reasonOf(err).trim()
  if (act?.opaque) return opaqueGraphqlRefusal()
  return unverifiedRefusal(act?.repo, act?.pr, error)
}

// The tool's act: checked before any question. A CI undraft runs as pr-ready --for-ci, which keeps Not Ready.
function toolReady($: Mod, e: GhCall, act: Act) {
  let read: Readiness | undefined
  let forCi = false
  const repoPr = async (): Promise<{ repo?: string | undefined; pr?: number | undefined }> => {
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
    } catch (err: unknown) {
      // The guard's own failure reads as a readiness that could not be read.
      read = { missing: [], error: reasonOf(err).trim() }
    }
    if (read.error || read.missing.length > 0) return { repo, pr, r: read }
    return undefined
  }
  const gated = act.kind === 'merge' || act.kind === 'undraft'
  // The gate's refusal of the act, or undefined once it lets it through.
  // A merge the gate lets through is pinned to the head it checked: GitHub refuses it if that head moved.
  const heldAct = async (repo: string, pr: number, r: Readiness): Promise<string | undefined> => {
    const held = await gateHeld($, act.name, repo, pr, r, true)
    // A sha the gate accepted as a prefix of the head reaches the tool as the full head, the only form it takes.
    const given = e.args['sha']
    if (!held && act.kind === 'merge' && r.gate && (typeof given !== 'string' || given.length < r.gate.head.length)) e.args = { ...e.args, sha: r.gate.head }
    return held?.refusal
  }
  return {
    async beforeAsk(): Promise<string | undefined> {
      if (!gated) return undefined
      const found = await evaluate()
      if (!found) {
        if (forCi || !read?.gate) return undefined
        const { repo, pr } = await repoPr()
        return repo && pr !== undefined ? heldAct(repo, pr, read) : undefined
      }
      if (typeof found.pr !== 'number') return unverifiedRefusal(found.repo, found.pr, found.r.error ?? '')
      try {
        return await heldAct(found.repo, found.pr, found.r)
      } catch (err: unknown) {
        return unverifiedRefusal(found.repo, found.pr, reasonOf(err).trim())
      }
    },
    // Whether this is an undraft for CI.
    async ciUndraft(): Promise<boolean> {
      if (act.kind !== 'undraft') return false
      await evaluate()
      return forCi
    },
    async ran(): Promise<void> {
      if (!forCi) return
      const { repo, pr } = await repoPr()
      if (repo && pr !== undefined) note($, ciUndraftLine(repo, pr))
    },
  }
}

// The engine's own name for an act run through gh.py, which its refusals keep;
// a gh act is named by the gh command of its kind.
function engineName(act: Act): string | undefined {
  return act.name.startsWith('gh.py ') ? act.name : undefined
}

// The Bash act's refusal, or undefined; what must follow its success goes in after.
async function bashReady($: Mod, act: Act, after: Array<(result: unknown) => Promise<void>>): Promise<string | undefined> {
  if (act.stdin) return STDIN_REFUSAL
  if (act.kind === 'create' || act.kind === 'create-draft') {
    after.push(async (result) => {
      const made = createdPr(stdoutOf(result))
      if (made) await labelNotReady($, made.repo, made.pr)
      else note($, 'github: the new draft keeps its labels: gh pr create printed no pull request URL')
    })
    return undefined
  }
  // Back to draft moves no label: Ready follows the records at the head, not the draft state.
  if (act.kind === 'redraft') return undefined
  if (act.opaque) {
    // An unread query may leave draft or merge: refused outside auto-merge, read as an
    // unverified readiness inside it. gh api names the origin's repository, or GH_REPO's.
    const origin = await targetRepo($, { repo: undefined, args: {} })
    if (!origin || !(await autoMergeRepos($)).has(origin.toLowerCase())) return opaqueGraphqlRefusal()
    return unverifiedRefusal(origin, undefined, 'the GraphQL query cannot be read from the command')
  }
  if (act.unnamed) return graphqlRefusal(act.kind)
  if (act.unreadable) return unreadablePrRefusal(act.name)
  if (!act.repo) {
    // A merge and leaving draft are refused without the repository:
    // the auto-merge split and the gate need it.
    return unnamedRepoRefusal(act.name)
  }
  const repo = act.repo
  const listed = (await autoMergeRepos($)).has(repo.toLowerCase())
  if (act.kind === 'merge' && !listed) return autoMergeRefusal(repo, act.pr, engineName(act))
  let pr = act.pr
  let lookup = ''
  if (pr === undefined) {
    try {
      pr = await prOfBranch($, repo, act.branch)
      if (pr === undefined) lookup = 'no open pull request for ' + (act.branch ?? 'the current branch')
    } catch (err: unknown) {
      lookup = reasonOf(err).trim()
    }
  }
  const r: Readiness = pr === undefined ? { missing: [], error: lookup } : await readiness($, repo, pr, act.sha)
  if (act.kind === 'undraft') {
    // The engine leaves draft for CI only when told to (--for-ci): without it, it puts Ready on.
    if (r.gate && ciUndraft(r.gate) && pr !== undefined && act.forCi !== false) {
      const n = pr
      after.push(async () => note($, ciUndraftLine(repo, n)))
      return undefined
    }
  }
  if (pr === undefined) return unverifiedRefusal(repo, '?', r.error ?? '')
  const held = (await gateHeld($, act.name, repo, pr, r, true))?.refusal
  // A shell merge cannot be rewritten: a prefix the gate accepted is refused with the full head to pin, not left to fail downstream as a moved head.
  if (!held && act.kind === 'merge' && r.gate && (!act.sha || act.sha.length < r.gate.head.length)) return unpinnedMergeRefusal(act.name, repo, pr, r.gate.head)
  return held
}

function stdoutOf(result: unknown): string {
  const out = isRecord(result) ? result['result'] : undefined
  if (typeof out === 'string') return out
  return String((isRecord(out) ? out['stdout'] : undefined) ?? '')
}

// A push moves the head of the branches it names: a pull request of theirs
// that carries Ready goes back to Not Ready. A branch or a repository read
// with any doubt is left alone, with one line saying so.
// After a push this session ran, its checkout's head is one it pushed.
async function notePushedHead($: Mod, line: string): Promise<void> {
  try {
    if (bashPushes(line).pushes.length === 0) return
    const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
    const sha = head.exitCode === 0 ? String(head.stdout).trim().toLowerCase() : ''
    const dir = await configDir($)
    const session = String(await $.session.id() ?? '')
    if (!SHA.test(sha) || !dir || session === '') return
    const path = dir + '/' + PUSHED_DIR + '/' + sha
    const before = await pushersOf($, sha)
    if (!before.has(session)) await $.fs.write(path, [...before, session].join('\n') + '\n')
  } catch (err: unknown) {
    note($, 'github: the pushed head could not be kept: ' + reasonOf(err))
  }
}

// The sessions that pushed a head, from its file; none when it is not there or cannot be read.
async function pushersOf($: Mod, sha: string): Promise<Set<string>> {
  const dir = await configDir($).catch(() => undefined)
  if (!dir || !SHA.test(sha)) return new Set()
  const text = await $.fs.read(dir + '/' + PUSHED_DIR + '/' + sha).then(String, () => '')
  return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
}

async function followPushes($: Mod, line: string): Promise<void> {
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
        for (const pull of parsePulls(await runGh($, 'pr-get', { branch }, repo))) {
          if (!pull.labels.includes('ready')) continue
          await labelNotReady($, repo, pull.number)
          note($, 'github: ' + repo + '#' + pull.number + ' back to Not Ready after the push to ' + branch)
        }
      }
    } catch (err: unknown) {
      note($, 'github: the labels could not be read after the push: ' + reasonOf(err))
    }
  }
}

// ---- auto-merge on the operator's word ----

// Whether a Bash command line names a list where it lives: its file name
// with the plugin's data directory, any plugin's, or the variable naming it.
// The name alone, in this plugin's sources or a message, is no path.
async function touchesList($: Mod, line: string, file: string): Promise<boolean> {
  if (!line.includes(file)) return false
  const dir = await dataDir($)
  return (dir !== '' && line.includes(dir)) || /plugins\/data\/|CLAUDE_PLUGIN_DATA|github-lounisbou/.test(line)
}

// Whether a Bash command line names the exemption files where they live, as touchesAutoMerge reads the list.
async function touchesExemptions($: Mod, line: string): Promise<boolean> {
  if (!line.includes(EXEMPT_DIR) && !line.includes(PLAN_DIR)) return false
  const dir = await dataDir($)
  return (dir !== '' && line.includes(dir)) || /plugins\/data\/|CLAUDE_PLUGIN_DATA|github-lounisbou/.test(line)
}

// The list, one repository per line as written.
async function listAutoMerge($: Mod): Promise<string> {
  const { listed } = await readAutoMerge($)
  return listed.length > 0 ? listed.join('\n') : 'no repository in auto-merge'
}

// The refusal of an auto-merge-set whose words are not the operator's quoted, dated words, or undefined.
const unprovenWord = (words: string): string | undefined => quotedWordsRefusal('auto-merge-set', words, 'words')

// The list's lock, core's convention (`<path>.lock` holding the holder's pid), taken
// with the shell's noclobber since the module has no node:fs. A lock older than
// LOCK_STALE_MS is a holder that died and is taken over; one still held after
// LOCK_TRIES polls refuses the change. Released whatever the work does.
const LOCK_TRIES = 100
const LOCK_POLL = '0.05'
const LOCK_STALE_MS = 30_000

async function withListLock<T>($: Mod, path: string, work: () => Promise<T>): Promise<T> {
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
async function writeAutoMerge($: Mod, path: string, text: string): Promise<void> {
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

async function setAutoMerge($: Mod, e: GhRequest): Promise<Answer> {
  const verdict = await $.tool.check({ tool: TOOL, input: { command: e.command, args: e.args, repo: e.repo } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const args = e.args ?? {}
  const repo = String(args['repo'] ?? '').trim()
  if (!isRepoName(repo)) return { deny: 'github: auto-merge-set names its repository as owner/name: {"repo": "owner/name"}' }
  if (typeof args['on'] !== 'boolean') return { deny: 'github: auto-merge-set says in or out: {"on": true} or {"on": false}' }
  const words = typeof args['words'] === 'string' ? args['words'] : ''
  const unproven = unprovenWord(words)
  if (unproven) return await refuse($, REFUSED.autoMergeSet, unproven)
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
    if (args['on'] && was && kept.length === listed.length - 1) return { result: repo + ' is already in auto-merge' }
    if (!args['on'] && !was) return { result: repo + ' was not in auto-merge' }
    const repositories = args['on'] ? [...kept, repo] : kept
    await writeAutoMerge($, path, JSON.stringify({ ...data, repositories }, null, 2) + '\n')
    return { result: repo + (args['on'] ? ' is now in auto-merge' : ' is no longer in auto-merge') }
  })
}

// ---- the deploy list on the operator's word ----

// The list, one environment of a repository per line.
async function listAutoDeploy($: Mod): Promise<string> {
  const { list } = await readDeployFile($)
  return list.grants.length > 0 ? list.grants.map((g) => g.repo + ' ' + g.env).join('\n') : 'no repository in auto-deploy'
}

// The declarations a call adds for its repository, or a refusal naming what is wrong.
function declarationsOf(raw: unknown, repo: string): Declared[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return 'github: auto-deploy-set declares its commands as a list: {"commands": [{"kind": "command", "argv": [...], "env": "prod"}]}'
  const out: Declared[] = []
  const entries: unknown[] = raw
  for (const entry of entries) {
    const one = parseDeclared(typeof entry === 'object' && entry !== null ? { ...entry, repo } : entry)
    if (typeof one === 'string') return 'github: auto-deploy-set: ' + one
    out.push(one)
  }
  return out
}

async function setAutoDeploy($: Mod, e: GhRequest): Promise<Answer> {
  const verdict = await $.tool.check({ tool: TOOL, input: { command: e.command, args: e.args, repo: e.repo } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const args = e.args ?? {}
  const repo = String(args['repo'] ?? '').trim()
  if (!isRepoName(repo)) return { deny: 'github: auto-deploy-set names its repository as owner/name: {"repo": "owner/name"}' }
  const env = DEPLOY_ENVS.find((known) => known === args['env'])
  if (env === undefined) return { deny: 'github: auto-deploy-set names its environment: {"env": "' + DEPLOY_ENVS.join('"|"') + '"}' }
  if (typeof args['on'] !== 'boolean') return { deny: 'github: auto-deploy-set says in or out: {"on": true} or {"on": false}' }
  const declared = declarationsOf(args['commands'], repo)
  if (typeof declared === 'string') return { deny: declared }
  const unproven = quotedWordsRefusal('auto-deploy-set', typeof args['words'] === 'string' ? args['words'] : '', 'words')
  if (unproven) return await refuse($, REFUSED.autoDeploySet, unproven)
  if (verdict.decision === 'ask' && verdict.rule) {
    const refused = await ask($, describe(e) + '?', ['Allow', 'Deny'], e.command)
    if (refused) return { deny: refused }
  }
  const { path } = await readDeployFile($)
  return withListLock($, path, async () => {
    const { data, list } = await readDeployFile($)
    const key = repo.toLowerCase()
    const kept = list.grants.filter((g) => !(g.repo.toLowerCase() === key && g.env === env))
    const was = kept.length < list.grants.length
    const known = new Set(list.declared.map((d) => JSON.stringify(d)))
    const added = declared.filter((d) => !known.has(JSON.stringify(d)))
    if (args['on'] && was && added.length === 0) return { result: repo + ' is already in auto-deploy on ' + env }
    if (!args['on'] && !was && added.length === 0) return { result: repo + ' was not in auto-deploy on ' + env }
    const repositories = (args['on'] ? [...kept, { repo, env }] : kept).map((g) => ({ repo: g.repo, env: g.env }))
    const commands = [...list.declared, ...added]
    await writeAutoMerge($, path, JSON.stringify({ ...data, repositories, commands }, null, 2) + '\n')
    return { result: repo + (args['on'] ? ' is now in auto-deploy on ' : ' is no longer in auto-deploy on ') + env }
  })
}

// ---- E2E not applicable, and the standing exemption ----

// Why the pull request at `head` is no pull request without runtime, or undefined: its files, read
// at that head (read again after them, so files of another head are never vouched for), all hold none.
async function runtimeRefusal($: Mod, repo: string, pr: number, head: string): Promise<string | undefined> {
  let files: PrFile[]
  let after: Gate
  try {
    files = await prFiles($, repo, pr)
    after = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: unknown) {
    return 'github: the files of ' + repo + '#' + pr + ' cannot be read: ' + reasonOf(err).trim()
  }
  if (after.head !== head) return 'github: the head moved from ' + head.slice(0, 7) + ' to ' + after.head.slice(0, 7) + ' while its files were read: record again.'
  const held = runtimeFiles(files)
  if (held.length === 0) return undefined
  return 'github: E2E is not applicable only to a pull request whose files hold no runtime; ' + repo + '#' + pr + ' changes '
    + held.slice(0, 5).join(', ') + (held.length > 5 ? ' and ' + (held.length - 5) + ' more' : '') + '.'
}

const RULES_MAX = 50
const isRule = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= RULES_MAX && value.every((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200)

// The record tool's {repo, exempt, detail, paths?, labels?}: the operator exempts a repository's pull
// requests from E2E (all, or those a rule names), or revokes it, in their words.
async function setExemption($: Mod, e: ToolInput, detail: string): Promise<Answer> {
  if (typeof e['exempt'] !== 'boolean') return { deny: 'github: an E2E exemption says in or out: {"exempt": true} or {"exempt": false}' }
  const repo = await targetRepo($, { repo: e['repo'], args: {} })
  if (!repo || !isRepoName(repo)) return { deny: 'github: an E2E exemption names its repository: {"repo": "owner/name"}' }
  const paths = e['paths'] ?? []
  const labels = e['labels'] ?? []
  if (!isRule(paths) || !isRule(labels)) {
    return { deny: 'github: "paths" and "labels" are lists of at most ' + RULES_MAX + ' globs and label names.' }
  }
  const until: unknown = e['until'] ?? undefined
  if (until !== undefined) {
    if (!e['exempt']) return { deny: 'github: an E2E exemption is revoked with no "until": only one that is granted has an expiry.' }
    if (typeof until !== 'string' || !isInstant(until)) {
      return { deny: 'github: "until" is the instant the exemption ends, in UTC to the second: 2026-11-15T22:00:00Z.' }
    }
    const now = await Promise.resolve($.clock.now()).then(Number, () => NaN)
    if (!(Date.parse(until) > now)) return { deny: 'github: "until" ' + until + ' is already past: an exemption that ends before it begins exempts nothing.' }
  }
  const refused = quotedWordsRefusal('an E2E exemption', detail)
  if (refused) return await refuse($, REFUSED.recordUnquoted, refused)
  const dir = await dataDir($)
  if (!dir) return { result: 'github: the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set', isError: true }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Written without it.
  }
  const exempt: boolean = e['exempt']
  const kept = exempt ? { paths: paths.map((p: string) => p.trim()), labels: labels.map((l: string) => l.trim()) } : { paths: [], labels: [] }
  const body = { v: 1, repo: repo.toLowerCase(), exempt, ...kept, detail, session, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ...(until === undefined ? {} : { until }) }
  const path = exemptionPath(dir, repo)
  await withListLock($, path, () => writeAutoMerge($, path, JSON.stringify(body, null, 2) + '\n'))
  if (!exempt) return { result: 'github: ' + repo + ' no longer exempt from E2E' }
  const rules = [
    ...(kept.labels.length > 0 ? ['carrying ' + kept.labels.join(' or ')] : []),
    ...(kept.paths.length > 0 ? ['whose files all match ' + kept.paths.join(' or ')] : []),
  ]
  return { result: 'github: ' + repo + ' exempt from E2E for ' + (rules.length > 0 ? 'its pull requests ' + rules.join(' or ') : 'all its pull requests') + (until === undefined ? '' : ' until ' + until) }
}

// pr-plan {pr}: the pull request's check plan as the gate reads it, as JSON, or the line that says it has none.
async function showPlan($: Mod, raw: GhRequest): Promise<{ result: string; isError?: boolean }> {
  const pr = prNumber(raw.args?.['pr'])
  if (!Number.isInteger(pr) || pr < 1) return { result: 'github: name the pull request: {"pr": <n>}', isError: true }
  const repo = await targetRepo($, raw)
  if (!repo || !isRepoName(repo)) return { result: 'github: name the repository: {"repo": "owner/name"}', isError: true }
  const plan = await readPlan($, repo, pr)
  return { result: plan ? JSON.stringify(plan, null, 2) : 'no check plan for ' + repo + '#' + pr }
}

/*
 * The record tool's {pr, plan: {e2e, norms}}: the proofs the pull request owes, decided when the work is
 * scoped, kept across its heads and posted on it. A new plan replaces the previous one.
 */
async function setPlan($: Mod, e: ToolInput): Promise<Answer> {
  const checks = planInput(e['plan'])
  if (typeof checks === 'string') {
    return { deny: 'github: a check plan is {"e2e": "required|none|screenshots", "norms": "required|none", "review": "required[: max <n>]|one-pass"}, each "<need>: <reason>" but the first: ' + checks }
  }
  const pr = Number(String(e['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return { deny: 'github: name the pull request: {"pr": <n>}' }
  const repo = await targetRepo($, { repo: e['repo'], args: {} })
  if (!repo || !isRepoName(repo)) return { deny: 'github: name the repository: {"repo": "owner/name"}' }
  const dir = await dataDir($)
  if (!dir) return { result: 'github: the plugin has no data directory: neither CLAUDE_PLUGIN_DATA nor HOME is set', isError: true }
  const path = planPath(dir, repo, pr)
  const body = { v: 1, repo: repo.toLowerCase(), pr, ...checks, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }
  await withListLock($, path, () => writeAutoMerge($, path, JSON.stringify(body, null, 2) + '\n'))
  let posted = ''
  try {
    await runGh($, 'pr-comment', { pr, body: planText(checks) }, repo)
  } catch (err: unknown) {
    posted = '\ngithub: the plan is not posted on ' + repo + '#' + pr + ': ' + reasonOf(err).trim()
  }
  const { line } = await followGate($, repo, pr, undefined, true)
  return { result: 'github: check plan of ' + repo + '#' + pr + ': e2e ' + checks.e2e.need + ', norms ' + checks.norms.need + ', review ' + needText(checks.review) + posted + (line ? '\n' + line : '') }
}

// ---- records ----

// Why a path is no directory, or undefined when it is one. The host's `$.fs.stat` says `dir`; a
// spawn in a path that is none fails with a raw ENOENT, so the refusal comes first.
async function notDirectory($: Mod, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path)).kind === 'dir' ? undefined : 'dir ' + path + ' is not a directory: name the checkout the tests ran in'
  } catch (err: unknown) {
    const why = reasonOf(err).trim()
    return /ENOENT|no such file|not found/i.test(why)
      ? 'dir ' + path + ' is not a directory: name the checkout the tests ran in'
      : 'cannot stat dir ' + path + ': ' + why
  }
}

// ---- the E2E run: performed by the record tool, or observed in the session ----

// The E2E run the record tool performs stays under the host's limit on one process, as the light CI's does.
const E2E_TIMEOUT_MS = LIGHT_CI_BUDGET_S * 1000
// The Bash runs this module observed, newest last: what a record « ran » may name.
const OBSERVED_RUNS_MAX = 50
const observedRuns: Array<{ line: string; cwd: string; ok: boolean; at: number }> = []
// A command line that starts in another directory: `cd <absolute path> && …`.
const CD_FIRST = /^\s*cd\s+(\/[^\s;&|]+)\s*&&\s*/

// A Bash call run to its end, kept with the directory it ran in, whether it succeeded and when it started.
async function noteRun($: Mod, line: string, started: number, result: unknown): Promise<void> {
  try {
    const cd = CD_FIRST.exec(line)
    const cwd = cd ? String(cd[1]) : String(await $.session.cwd())
    observedRuns.push({ line: line.trim(), cwd: cwd.replace(/\/+$/, ''), ok: !failed(result), at: started })
    if (observedRuns.length > OBSERVED_RUNS_MAX) observedRuns.splice(0, observedRuns.length - OBSERVED_RUNS_MAX)
  } catch {
    // An unread directory leaves the run unobserved: the record asks for it again.
  }
}

// An argv shown as one line, each word quoted when it holds a character the shell reads.
function shownArgv(argv: readonly string[]): string {
  return argv.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : "'" + word.replace(/'/g, "'\\''") + "'")).join(' ')
}

// When the checkout's HEAD last moved, from its reflog, in ms; undefined when it cannot be read.
async function headMovedAt($: Mod, inDir: { cwd?: string }): Promise<number | undefined> {
  const out = await $.process.run(['git', 'log', '-g', '-1', '--date=unix', '--format=%gd', 'HEAD'], { timeoutMs: 10_000, ...inDir })
  const at = /\{(\d+)\}/.exec(String(out.stdout ?? ''))
  return out.exitCode === 0 && at ? Number(at[1]) * 1000 : undefined
}

type E2eRun = { argv: string[] } | { ran: string }

// The mark of an E2E pass or fail written on the session's word, with no run the tool performed or observed.
const STATED = 'stated, not computed: '

// The E2E run a pass or a fail rests on, from the input: `run` (an argv the tool runs) or `ran` (a command line the
// session ran in Bash); a string says why the input names none.
function e2eRunOf(e: ToolInput): E2eRun | string | undefined {
  const run: unknown = e['run']
  const ran: unknown = e['ran']
  if (run !== undefined && ran !== undefined) return 'github: an E2E rests on one run: "run" (the tool runs it) or "ran" (a command this session ran in Bash), not both.'
  if (run !== undefined) {
    if (!Array.isArray(run) || run.length === 0 || !run.every((word): word is string => typeof word === 'string' && word !== '')) {
      return 'github: "run" is the E2E command as an argv, no shell: ["npm", "run", "e2e"].'
    }
    return { argv: run }
  }
  if (ran !== undefined) {
    if (typeof ran !== 'string' || ran.trim() === '') return 'github: "ran" is the command line this session ran in Bash, as it ran it.'
    return { ran: ran.trim() }
  }
  return undefined
}

/*
 * The result and detail of an E2E record, computed from its run: the tool runs `run` in the checkout at the head
 * (allowed as that command would be in Bash), or finds `ran` among the Bash runs this session made in that checkout
 * since its HEAD last moved. Pass on exit 0, fail otherwise; the session's own detail follows. A `ran` not found is
 * not computed: it is the session's word, `stated`, under the result it gave.
 */
async function e2eOutcome($: Mod, run: E2eRun, dir: string | undefined, head: string, inDir: { cwd?: string }, said: string, given: string): Promise<{ result: 'pass' | 'fail'; detail: string; stated?: true } | { deny: string }> {
  const tail = said.trim() === '' ? '' : '; ' + said.trim()
  const cut = (text: string): string => text.slice(0, DETAIL_MAX)
  if ('argv' in run) {
    const line = shownArgv(run.argv)
    const allowed = await $.tool.check({ tool: 'Bash', input: { command: line } })
    if (allowed.decision !== 'allow') {
      return { deny: 'github: the record tool runs only what Bash may run without asking; `' + line + '` is not: run it in Bash' + (dir ? ' from ' + dir : '') + ', then record with "ran".' }
    }
    const started = Date.now()
    const out = await $.process.run(run.argv, { timeoutMs: E2E_TIMEOUT_MS, ...inDir })
    const secs = Math.round((Date.now() - started) / 1000)
    if (Date.now() - started >= E2E_TIMEOUT_MS - 1000) {
      return { deny: 'github: `' + line + '` ran past ' + LIGHT_CI_BUDGET_S + ' s and was stopped, nothing written: run it in Bash in the background, then record with "ran".' }
    }
    const now = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000, ...inDir })
    if (String(now.stdout).trim().toLowerCase() !== head) return { deny: 'github: the checkout moved off ' + head.slice(0, 7) + ' while `' + line + '` ran: nothing written.' }
    const last = String(out.stderr || out.stdout || '').trim().split('\n').pop() ?? ''
    const result = out.exitCode === 0 ? 'pass' : 'fail'
    return { result, detail: cut('ran `' + line + '` at ' + head.slice(0, 7) + ': exit ' + out.exitCode + ' in ' + secs + ' s' + (result === 'fail' && last ? ' (' + last.slice(0, 120) + ')' : '') + tail) }
  }
  const cwd = (dir ?? String(await $.session.cwd())).replace(/\/+$/, '')
  const moved = await headMovedAt($, inDir)
  if (moved === undefined) return { deny: 'github: when the checkout ' + cwd + ' last moved cannot be read from its reflog: record with "run" instead.' }
  const seen = observedRuns.filter((r) => r.line === run.ran && r.cwd === cwd && r.at >= moved).pop()
  if (!seen) {
    if (given !== 'pass' && given !== 'fail') {
      return { deny: 'github: this session ran no `' + run.ran + '` in ' + cwd + ' since its head ' + head.slice(0, 7) + ' was checked out (a background run is not observed): give "result": "pass" or "fail" to record it as stated, or run it there in Bash.' }
    }
    return { result: given, detail: cut('`' + run.ran + '` at ' + head.slice(0, 7) + ' not observed in ' + cwd + tail), stated: true }
  }
  const result = seen.ok ? 'pass' : 'fail'
  return { result, detail: cut('observed `' + run.ran + '` at ' + head.slice(0, 7) + ', run by this session ' + new Date(seen.at).toISOString().replace(/\.\d+Z$/, 'Z') + ': ' + (seen.ok ? 'succeeded' : 'failed') + tail) }
}

async function writeRecord($: Mod, e: ToolInput, origin: string): Promise<Answer> {
  const verdict = await $.tool.check({ tool: RECORD_TOOL, input: { pr: e['pr'], repo: e['repo'], kind: e['kind'], result: e['result'], detail: e['detail'], dir: e['dir'], run: e['run'], ran: e['ran'] } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  // The checkout the tests ran in: named, or the session's directory.
  const dir = e['dir'] === undefined || e['dir'] === null || e['dir'] === '' ? undefined : String(e['dir'])
  if (dir !== undefined && !dir.startsWith('/')) return { deny: 'github: dir is the absolute path of the checkout the tests ran in, got: ' + dir }
  const notDir = dir === undefined ? undefined : await notDirectory($, dir)
  if (notDir) return { deny: 'github: ' + notDir }
  const inDir = dir ? { cwd: dir } : {}
  const owned = recordKindFor(origin)
  const kind = e['kind'] === undefined || e['kind'] === null || e['kind'] === '' ? owned : String(e['kind'])
  if (kind !== owned) {
    return await refuse($, REFUSED.recordKind, kindRefusal(kind, origin, owned))
  }
  const detail = e['detail'] === undefined || e['detail'] === null ? '' : String(e['detail'])
  if (e['exempt'] !== undefined) return owned === 'e2e' ? await setExemption($, e, detail) : await refuse($, REFUSED.recordKind, kindRefusal('e2e', origin, owned))
  if (e['plan'] !== undefined) return origin === PLAN_WRITER.plugin ? await setPlan($, e) : await refuse($, REFUSED.recordPlan, PLAN_REFUSAL)
  let result = String(e['result'] ?? '')
  // An E2E pass or fail is computed from a run the tool performs or observed, never taken from the session's word.
  const e2eRun = kind === 'e2e' ? e2eRunOf(e) : undefined
  if (typeof e2eRun === 'string') return { deny: e2eRun }
  if (e2eRun && result !== '' && result !== 'pass' && result !== 'fail') {
    return { deny: 'github: a run gives a pass or a fail; a ' + result + ' rests on no run: leave "run" and "ran" out.' }
  }
  if (kind === 'e2e' && !e2eRun && result === '') {
    return { deny: 'github: an E2E record gives "run" (the command as an argv, run here in the checkout), "ran" (the command line this session ran there in Bash), or a result.' }
  }
  // An E2E pass or fail with no run (one made on another machine), or with a `ran` not seen, is written as stated, not computed, and observed.
  let stated = kind === 'e2e' && !e2eRun && (result === 'pass' || result === 'fail')
  if (result === 'not-applicable' && detail.trim() === '') {
    return { deny: 'github: an E2E not applicable gives its reason in "detail": what the pull request changes that runs nothing.' }
  }
  if (result === ACCEPTANCE.result && origin !== ACCEPTANCE.plugin) return await refuse($, REFUSED.recordAcceptance, acceptanceOriginRefusal(origin))
  if (result === ACCEPTANCE.result && detail.trim() === '') {
    return { deny: 'github: an acceptance names each point it sets aside with its reason in "detail".' }
  }
  const pr = Number(String(e['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return { deny: 'github: name the pull request: {"pr": <n>}' }
  const repo = await targetRepo($, { repo: e['repo'], args: {} }, dir)
  if (!repo) {
    return {
      deny: dir
        ? 'github: ' + dir + ' has no GitHub origin remote, so the repository is unknown: name it: {"repo": "owner/name"}'
        : 'github: name the repository: {"repo": "owner/name"}',
    }
  }
  const waived = result === 'waived' ? WAIVED.find((k) => k === kind) : undefined
  const planned = waived ? (await readPlan($, repo, pr))?.[waived] : undefined
  if (waived && planned && planned.need !== 'required') {
    return await refuse($, REFUSED.recordUnplanned, 'github: the check plan of ' + repo + '#' + pr + ' needs no ' + (waived === 'e2e' ? 'E2E' : 'norms check') + ' (' + planned.need + ': ' + planned.reason + '): a waiver lifts only a check the plan requires.')
  }
  const unquoted = waived ? quotedWordsRefusal(waived === 'e2e' ? 'an E2E waiver' : 'a norms waiver', detail) : undefined
  if (unquoted) return await refuse($, REFUSED.recordUnquoted, unquoted)
  let gate: Gate
  try {
    gate = parseGate(await runGh($, 'pr-gate', { pr }, repo))
  } catch (err: unknown) {
    return await refuse($, REFUSED.recordUnverified, unverifiedRefusal(repo, pr, reasonOf(err).trim()))
  }
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 10_000, ...inDir })
  const local = head.exitCode === 0 ? String(head.stdout).trim().toLowerCase() : ''
  if (dir && !local) return { deny: 'github: ' + dir + ' has no commit to read: ' + (String(head.stderr ?? '').trim() || 'git rev-parse HEAD exited ' + head.exitCode) }
  if (local !== gate.head) {
    return await refuse($, REFUSED.recordHead, 'github: the checkout is at ' + (local.slice(0, 7) || 'no commit') + ', the pull request\'s head is ' + gate.head.slice(0, 7) + ' (' + repo + '#' + pr + '): a record is written at the head it read. '
        + (dir ? 'Checkout read: ' + dir + '.' : 'Name the checkout the tests ran in: {"dir": "<absolute path>"}.'))
  }
  const status = await $.process.run(['git', 'status', '--porcelain', '-uno'], { timeoutMs: 10_000, ...inDir })
  if (status.exitCode !== 0) {
    return { deny: 'github: git status failed' + (dir ? ' in ' + dir : '') + ': ' + (String(status.stderr ?? '').trim() || 'exit ' + status.exitCode) }
  }
  if (String(status.stdout).trim() !== '') {
    return await refuse($, REFUSED.recordDirty, 'github: the tracked files have changes: a record is written on a clean checkout of the head.')
  }
  let self = ''
  try {
    self = String(await $.session.id() ?? '')
  } catch {
    // Without its id the session is known as no pusher.
  }
  const selfReview = selfReviewRefusal(kind, gate.head, (await pushersOf($, gate.head)).has(self) && self !== '' ? new Set([gate.head]) : new Set<string>())
  if (selfReview) return await refuse($, REFUSED.recordSelfReview, selfReview)
  // The orchestrator's pass does not override a failed review at its head: it sets the points aside.
  if (origin === ACCEPTANCE.plugin && result === 'pass' && latestReview(gate, await headRecords($, gate))?.result === 'fail') {
    return await refuse($, REFUSED.recordPassOverFail, passOverFailRefusal(gate.head))
  }
  if (result === 'not-applicable') {
    const refused = await runtimeRefusal($, repo, pr, gate.head)
    if (refused) return await refuse($, REFUSED.recordRuntime, refused)
  }
  let written = detail
  if (e2eRun) {
    const outcome = await e2eOutcome($, e2eRun, dir, gate.head, inDir, detail, result)
    if ('deny' in outcome) return await refuse($, REFUSED.recordE2eUnrun, outcome.deny)
    result = outcome.result
    written = outcome.detail
    stated = outcome.stated === true
  }
  if (stated) {
    written = (STATED + written).slice(0, DETAIL_MAX)
    await observed($, OBSERVED.e2eStated)
  }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Written without it.
  }
  const argv = [
    'python3', $.plugin.root + '/engine/record.py', '--repo', repo, '--pr', String(pr), '--head', gate.head,
    '--kind', kind, '--result', result, '--producer', producerSlug(origin), '--detail', written, '--session', session,
  ]
  const run = await $.process.run(argv, { timeoutMs: 30_000 })
  if (run.exitCode !== 0) return { result: String(run.stderr || 'record.py exited ' + run.exitCode).trim(), isError: true }
  // Its copy on the forge, for the other machine's gate.
  await postWritten($, String(run.stdout).trim())
  // The record may complete readiness: the gate reads it at the head it just checked.
  const { line } = await followGate($, repo, pr, gate, true)
  return { result: String(run.stdout).trim() + (line ? '\n' + line : '') }
}

/*
 * The light CI of a stacked pull request (engine/light_ci.py): `run` checks the checkout is the pull request's
 * head and clean, runs the project's command and writes the tests record of its exit code, then the gate follows
 * it; `status` says what the repository's project file holds and the facts of the invitation. The script does
 * every check and every write: this hook names the checkout, the session and the gate's line.
 */
async function lightCi($: Mod, e: ToolInput): Promise<Answer> {
  const verdict = await $.tool.check({ tool: LIGHT_CI_TOOL, input: { action: e['action'], pr: e['pr'], repo: e['repo'], dir: e['dir'] } })
  if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
  const action = String(e['action'] ?? '')
  if (action !== 'run' && action !== 'status') {
    return { deny: 'github: ' + LIGHT_CI_TOOL + ' takes {"action": "run", "pr": <n>} or {"action": "status"}, each with "repo" and "dir" if needed' }
  }
  const dir = e['dir'] === undefined || e['dir'] === null || e['dir'] === '' ? undefined : String(e['dir'])
  if (dir !== undefined && !dir.startsWith('/')) return { deny: 'github: dir is the absolute path of the checkout, got: ' + dir }
  const notDir = dir === undefined ? undefined : await notDirectory($, dir)
  if (notDir) return { deny: 'github: ' + notDir }
  const named = e['repo'] === undefined || e['repo'] === null || e['repo'] === '' ? undefined : String(e['repo'])
  if (named !== undefined && !isRepoName(named)) return { deny: 'github: repo is owner/name, got: ' + named }
  const script = ['python3', $.plugin.root + '/engine/light_ci.py']
  const inDir = dir ? { cwd: dir } : {}
  const repoArgs = named ? ['--repo', named] : []
  if (action === 'status') {
    const run = await $.process.run([...script, 'status', ...repoArgs], { timeoutMs: 120_000, ...inDir })
    if (run.exitCode !== 0) return { result: String(run.stderr || 'light_ci.py exited ' + run.exitCode).trim(), isError: true }
    return { result: String(run.stdout).trim() }
  }
  const pr = Number(String(e['pr'] ?? '').replace('#', ''))
  if (!Number.isInteger(pr) || pr < 1) return { deny: 'github: name the pull request: {"action": "run", "pr": <n>}' }
  let session = ''
  try {
    session = String(await $.session.id() ?? '')
  } catch {
    // Run without it.
  }
  const run = await $.process.run([...script, 'run', '--pr', String(pr), '--session', session, '--budget', String(LIGHT_CI_BUDGET_S), ...repoArgs],
    { timeoutMs: LIGHT_CI_TIMEOUT_MS, ...inDir })
  if (run.exitCode !== 0) return { result: String(run.stderr || 'light_ci.py exited ' + run.exitCode).trim(), isError: true }
  // Its copy on the forge: the line names the record it wrote last.
  const written = / record (\S+\.json)$/.exec(String(run.stdout).trim())?.[1]
  if (written) await postWritten($, written)
  const repo = await targetRepo($, { repo: named, args: {} }, dir).catch(() => undefined)
  // The record may complete readiness, or break it: the gate reads the pull request again.
  const { line } = repo ? await followGate($, repo, pr, undefined, true) : { line: undefined }
  return { result: String(run.stdout).trim() + (line ? '\n' + line : '') }
}

// At most once a day, the head directories whose newest record is older than
// PRUNE_DAYS go, their pull request merged or moved on long ago, and the fingerprints kept as long.
async function pruneRecords($: Mod): Promise<void> {
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
    (await $.fs.list(path)).filter((x) => x?.kind === 'dir').map((x) => path + '/' + x.name)
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
  // The fingerprints kept for the heads, by the same cut-off.
  const data = await dataDir($)
  if (data) {
    for (const file of await $.fs.list(data).catch(() => [])) {
      const name = String(file?.name ?? '')
      if (!name.startsWith(FINGERPRINT_PREFIX) || !name.endsWith('.json')) continue
      if (Number((await $.fs.stat(data + '/' + name)).mtimeMs) < cut) stale.push(data + '/' + name)
    }
  }
  // The pushed heads, by the same cut-off.
  const config = await configDir($)
  if (config) {
    const pushed = config + '/' + PUSHED_DIR
    for (const file of await $.fs.list(pushed).catch(() => [])) {
      const name = String(file?.name ?? '')
      if (SHA.test(name) && Number((await $.fs.stat(pushed + '/' + name)).mtimeMs) < cut) stale.push(pushed + '/' + name)
    }
  }
  if (stale.length > 0) await $.process.run(['rm', '-rf', '--', ...stale], { timeoutMs: 60_000 })
  await $.fs.write(stamp, new Date().toISOString() + '\n')
}

export function register(on: On<Mod>): void {
  on('session.start', async ($, e, next) => {
    const root = $.plugin.root
    await $.tool.register({
      name: 'gh',
      // Listed with its schema from the start: behind ToolSearch the model
      // would reach for Bash and curl before it found this tool.
      isDeferred: false,
      description:
        'GitHub API: pull requests, review threads, comments, reviews, labels, '
        + 'issues, search, image uploads. Before a subcommand, Read its section of '
        + root + '/engine/REFERENCE.md, not the whole file. Before authoring any '
        + 'PR title, body, comment, review or commit message, Read its rules in ' + root + '/engine/writing/: '
        + 'commits.md (commit), pull-requests.md (PR title or body, with security-updates.md for advisories), '
        + 'comments.md (comment, review, reply), each with references.md. Pass positionals by their documented name '
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
          'Record a pull request\'s E2E at its head, from a clean checkout of it: pass or fail computed from a run, "run" (an argv the tool runs there) or "ran" (a command line this session ran there in Bash), or stated with neither, or a "ran" not seen, '
          + 'not-applicable with its reason when no file holds runtime (docs, tests, CI, prompts), or waived on the operator\'s quoted, dated words. '
          + '{repo, exempt, paths?, labels?, until?} exempts a repository\'s pull requests for good, or until the instant given '
          + '(false revokes) and quotes the operator\'s dated words in detail. See '
          + root + '/engine/REFERENCE.md « Records ».',
        inputSchema: {
          type: 'object',
          properties: {
            pr: { type: 'integer', description: 'the pull request number' },
            repo: { type: 'string', description: 'owner/name, overriding origin' },
            result: { type: 'string', enum: ['pass', 'fail', 'waived', 'not-applicable', ACCEPTANCE.result] },
            detail: { type: 'string', description: 'the reason, the operator\'s words, or a note added after the run' },
            run: { type: 'array', items: { type: 'string' }, description: 'E2E: the command as an argv, run by the tool in the checkout; its exit code gives pass or fail' },
            ran: { type: 'string', description: 'E2E: the command line this session ran in Bash in that checkout since its head was checked out; its outcome gives pass or fail' },
            kind: { type: 'string', enum: KINDS.filter((kind) => kind !== SCRIPTED.kind), description: 'default: the kind this caller writes' },
            exempt: { type: 'boolean', description: 'exempt the repository (true) or revoke it (false), in place of pr and result' },
            paths: { type: 'array', items: { type: 'string' }, description: 'exempt only pull requests whose files all match these globs' },
            labels: { type: 'array', items: { type: 'string' }, description: 'exempt only pull requests carrying one of these labels' },
            until: { type: 'string', description: 'the exemption ends at this instant, ISO UTC to the second (2026-11-15T22:00:00Z)' },
            plan: {
              type: 'object',
              description: 'the check plan, from ' + PLAN_WRITER.tool + ' only: each "<need>" or "<need>: <reason>", a reason for any need but the first; one left out needs the first; a required review "required: max <n>", its rounds from 1 to ' + REVIEW_ROUNDS.cap,
              // The needs each check may be given are core's readiness contract's alone.
              properties: Object.fromEntries(
                Object.entries(PLAN_NEEDS).map(([check, needs]) => [check, { type: 'string', description: needs.join(', ') }]),
              ),
            },
            dir: { type: 'string', description: 'absolute path of that checkout (default: the session\'s directory)' },
          },
          required: [],
        },
      })
    } catch (err: unknown) {
      note($, 'github: the record tool could not be registered: ' + reasonOf(err))
    }
    try {
      await $.tool.register({
        name: 'light_ci',
        isDeferred: false,
        description:
          'Light CI of a stacked pull request (its base another open pull request\'s head): "run" {pr}, from a clean checkout '
          + 'of its head, runs the repository\'s command and records its tests at the head for the Ready gate; "status" '
          + 'says what the repository\'s light CI file holds. See ' + root + '/engine/REFERENCE.md « Light CI ».',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['run', 'status'] },
            pr: { type: 'integer', description: 'run: the pull request number' },
            repo: { type: 'string', description: 'owner/name, overriding origin' },
            dir: { type: 'string', description: 'absolute path of the checkout (default: the session\'s directory)' },
          },
          required: ['action'],
        },
      })
    } catch (err: unknown) {
      note($, 'github: the light CI tool could not be registered: ' + reasonOf(err))
    }
    try {
      await pruneRecords($)
    } catch (err: unknown) {
      note($, 'github: the old records could not be pruned: ' + reasonOf(err))
    }
    try {
      await startReconciler($)
    } catch (err: unknown) {
      note($, 'github: the reconciler could not start: ' + reasonOf(err))
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
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const line = String(e['command'])
    // What the call is observed for, journaled just before it runs: a call refused further down leaves no line.
    const observations: string[] = []
    try {
      // A command that only reads them passes: the auto-merge list is refused a write, the deploy list any touch.
      if (await touchesList($, line, AUTO_MERGE_FILE) && !onlyReads(line)) return await refuse($, REFUSED.autoMergeList, AUTO_MERGE_REFUSAL)
      if (await touchesList($, line, AUTO_DEPLOY_FILE)) return await refuse($, REFUSED.autoDeployList, AUTO_DEPLOY_REFUSAL)
    } catch {
      // A line the reader cannot read: the ready guard below reads it again and refuses it.
    }
    try {
      // The records and the exemptions are refused a deletion (irreversible); any other write to the exemptions is observed.
      const root = await recordsRoot($)
      if (deletesRecords(line, root)) return await refuse($, REFUSED.recordsDelete, RECORDS_REFUSAL)
      if (postsStatus(line)) return await refuse($, REFUSED.statusWrite, STATUS_REFUSAL)
      const exempt = await touchesExemptions($, line)
      if (exempt && deletes(line, namesExemptions)) return await refuse($, REFUSED.exemptionDelete, EXEMPT_REFUSAL)
      if (exempt && !onlyReads(line)) observations.push(OBSERVED.exemption)
    } catch {
      // A line the reader cannot read: the ready guard below reads it again and refuses it.
    }
    const undeployed = await bashDeployRefusal($, line)
    if (undeployed) return await refuse($, REFUSED.deploy, undeployed)
    const after: Array<(result: unknown) => Promise<void>> = []
    let current: Act | undefined
    try {
      for (const act of bashActs(line)) {
        current = act
        const refused = await bashReady($, act, after)
        if (refused) return await refuse($, REFUSED.ready, refused)
      }
    } catch (err) {
      // The ready guard failed on its own: its readiness reads as unverified, never as a pass.
      return await refuse($, REFUSED.ready, guardThrew(current, err))
    }
    for (const code of new Set(observations)) await observed($, code)
    const started = Date.now()
    const result = await next(e)
    // A run to its end is observed for an E2E record; a background one has not ended.
    if (e['run_in_background'] !== true) await noteRun($, line, started, result)
    if (!failed(result)) {
      for (const then of after) {
        try {
          await then(result)
        } catch (err: unknown) {
          note($, 'github: the label could not be set after the command: ' + reasonOf(err))
        }
      }
      await followPushes($, line)
      await notePushedHead($, line)
    }
    return result
  }).catch(async ($, e, next) => {
    const refusal = bashNetRefusal(String(e['command'] ?? ''))
    return refusal === null ? next(e) : await refuse($, REFUSED.net, refusal)
  })

  // The auto-merge and deploy lists are written by their tools only; a write to the exemptions is observed.
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($, e, next) => {
      const path = normalise(String(e['file_path'] ?? e['notebook_path'] ?? ''), String(await $.session.cwd()))
      const data = await dataDir($)
      if ((data && path === normalise(data + '/' + AUTO_MERGE_FILE)) || AUTO_MERGE_PATH.test(path)) {
        return await refuse($, REFUSED.autoMergeList, AUTO_MERGE_REFUSAL)
      }
      if ((data && path === normalise(data + '/' + AUTO_DEPLOY_FILE)) || AUTO_DEPLOY_PATH.test(path)) {
        return await refuse($, REFUSED.autoDeployList, AUTO_DEPLOY_REFUSAL)
      }
      if ((data && [EXEMPT_DIR, PLAN_DIR].some((dir) => path.startsWith(normalise(data + '/' + dir) + '/'))) || ANY_EXEMPT_PATH.test(path)) {
        await observed($, OBSERVED.exemption)
      }
      return next(e)
    }).catch(async ($, e, next) => {
      const refusal = writeNetRefusal(String(e['file_path'] ?? e['notebook_path'] ?? ''))
      return refusal === null ? next(e) : await refuse($, REFUSED.net, refusal)
    })
  }

  // A skill the repositories declare as a deploy runs only where the list grants it.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const refused = await skillDeployRefusal($, String(e['skill'] ?? ''))
    return refused ? await refuse($, REFUSED.deploy, refused) : next(e)
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: RECORD_TOOL }, async ($, e, next) => {
    try {
      return await writeRecord($, e, String(next?.origin?.plugin ?? 'engine'))
    } catch (err: unknown) {
      return { result: reasonOf(err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the record hook itself failed' }))

  on('tool.call', { tool: LIGHT_CI_TOOL }, async ($, e) => {
    try {
      return await lightCi($, e)
    } catch (err: unknown) {
      return { result: reasonOf(err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the light CI hook itself failed' }))

  on('tool.call', { tool: TOOL }, async ($, input) => {
    const raw = ghRequest(input)
    if (typeof raw === 'string') return { result: raw, isError: true }
    if (MOD_COMMANDS.has(raw.command)) {
      try {
        if (raw.command === 'auto-merge-set') return await setAutoMerge($, raw)
        if (raw.command === 'auto-deploy-set') return await setAutoDeploy($, raw)
        const verdict = await $.tool.check({ tool: TOOL, input: { command: raw.command, args: raw.args, repo: raw.repo } })
        if (verdict.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
        if (raw.command === 'pr-plan') return await showPlan($, raw)
        return { result: raw.command === 'auto-deploy-list' ? await listAutoDeploy($) : await listAutoMerge($) }
      } catch (err: unknown) {
        return { result: reasonOf(err), isError: true }
      }
    }
    const e: GhCall = { ...raw, args: withHouseDefaults(raw.command, raw.args ?? {}) }
    const act = toolAct(e.command, e.args)
    const ready = act ? toolReady($, e, act) : undefined
    const label = ready ? undefined : readyLabelCall($, e)
    const refused = await permit($, e, ready?.beforeAsk ?? label?.check, ready?.ciUndraft)
    if (refused) return label?.answer(refused) ?? { deny: refused }
    try {
      // The line of a gate read (the Actions runs it could not read) is shown after afterRead,
      // which parses the output: no added text may reach parseGate.
      const ran = await runGhRaw($, e.command, e.args, e.repo)
      let result = (READS.has(e.command) ? ran.out : withNote(ran.out, ran.err)) || '(no output)'
      if (ready) await ready.ran()
      result = await afterRead($, e, result)
      if (GATE_READS.has(e.command)) result = withNote(result, ran.err)
      // A write changes what the open pane shows: its rows are stale, read again at once when the
      // pane is shown, else when it shows again. Unawaited.
      if (watch && !READS.has(e.command)) {
        dirty = true
        void refreshIfDue($, false)
      }
      return { result }
    } catch (err: unknown) {
      return { result: reasonOf(err), isError: true }
    }
  }).catch(async () => ({ deny: 'github mod error: the hook itself failed' }))

  on('command.run', { command: 'checks' }, async ($, e, next) => {
    if (!ownedCommands.has('checks')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-checks', 'checks-status', checksLine) }
    } catch (err: unknown) {
      return { text: reasonOf(err) }
    }
  }).catch(async () => ({ text: 'github mod: /checks failed; the mod itself errored' }))

  on('command.run', { command: 'threads' }, async ($, e, next) => {
    if (!ownedCommands.has('threads')) return next(e)
    try {
      return { text: await prText($, e.args, 'pr-threads', 'thread-summary') }
    } catch (err: unknown) {
      return { text: reasonOf(err) }
    }
  }).catch(async () => ({ text: 'github mod: /threads failed; the mod itself errored' }))

  on('command.run', { command: 'prs' }, async ($, e, next) => {
    if (!ownedCommands.has('prs')) return next(e)
    try {
      // Stamped before the read, as refresh does: a write during it stays dirty.
      readAt = await nowMs($)
      dirty = false
      const rows = await collectRows($)
      await update($, pane, (p) => ({ ...p, rows, error: null }))
      await $.ui.open({ id: PANE_ID, title: 'PRs', closeOnEscape: true })
      startWatch($)
      return {}
    } catch (err: unknown) {
      return { text: reasonOf(err) }
    }
  }).catch(async () => ({ text: 'github mod: /prs failed; the mod itself errored' }))

  // The markdown commands answered here without a model turn. A failure falls
  // back to the markdown, which runs the same script through the model.
  // /github:protect [apply] [ci]: the default branch's force-push and deletion protection, read on
  // the forge, and put in place on the operator's « apply »; « ci » adds the CI check readiness requires.
  on('command.run', { command: 'github:protect' }, async ($, e) => {
    const words = String(e.args ?? '')
    const command = /\bapply\b/.test(words) ? 'protect-apply' : 'protect-check'
    const args = /\bci\b/.test(words) ? { 'require-ci': true } : {}
    try {
      return { text: (await runGh($, command, args, await targetRepo($, { repo: undefined, args: {} }))).trim() }
    } catch (err: unknown) {
      return { text: 'github: ' + command + ' failed: ' + reasonOf(err).trim() }
    }
  }).catch(async ($, e, next) => next(e))

  on('command.run', { command: 'github:install' }, async ($) => ({ text: await diagnose($) }))
    .catch(async (_$, e, next) => next(e))
  on('command.run', { command: 'github:doctor' }, async ($) => ({ text: await diagnose($, true) }))
    .catch(async (_$, e, next) => next(e))

  on('ui.close', async (_$, e, next) => {
    if (e.id === PANE_ID) stopWatch()
    return next(e)
  }).catch(async (_$, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const width = e.props?.bodyColumns ?? 80
    // Drawn means shown: a pane whose rows are due is read again, and redrawn when the read ends.
    if (watch) void refreshIfDue($, false, true)
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
  }).catch(async (_$, e, next) => next(e))
}
