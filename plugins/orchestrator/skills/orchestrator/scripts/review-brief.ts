// review-brief — a review round's brief, filled from its fields.
//
//   review-brief.sh --out <path> --repo <owner/name> --pr <n> --title "<delivery>" --spec <path> --index <path>
//     --delivery-report <path> --branch <b> --head <sha> --worktree <dir> --orchestrator "<exact name and reference>" --reason "<why this size>"
//     [--size "<round size>"] [--lens <name>]... [--tier deep|standard|light] [--scope "<text>"]
//     [--plan <path>] [--norms <path>] [--base <ref>] [--envelope "<text>"]
//
// `templates/agent-review-brief.md` is fixed text; what changes from a round to the next is a few
// fields, and the orchestrator that retyped the template inline (a copy, a hand-made replacement of
// each field) spent its context on text the plugin already holds. The command writes the filled
// brief to `--out` and says its path, one line. A field left out is refused with its name; a field
// the template gained and this command does not fill is refused too, so no brief leaves with a
// `{{FIELD}}` in it.
//
// `--index` is the path where the REVIEW agent writes its index (the three-level report's second
// level), never the implementer's report: it must be a new file, and an existing path is refused.
// `--delivery-report` is the implementer's report (its E2E line), a path the
// brief names so the review session reads it; it is only read, never written.
// `--report`, the index flag's former name, read as the implementer's report and was taken for it, so it
// is refused with a message naming `--index`.
//
// No lens is a single reading by the review session itself: the lens list and the tier read `none`.
// Lenses are one `--lens` each, their size said as « 3 read-only lenses (a, b, c) » unless `--size`
// gives it; `--scope` is the text that follows the list, what the readers check. The readers' tier and
// model are read from the diff (`lens-model.ts`); `--tier` overrides the tier, the model follows it.
// Each lens's method (`hooks/lens-method.ts`: its pr-review-toolkit agent's file, or generic, or generic
// because the toolkit is missing here) is said in the brief, which the review index carries; the
// review session writes a toolkit method's file into that reader's launch prompt.
// A refactor (`base..head` holds a `refactor` commit and no `feat` or `fix` one; a rename or a move
// is typed so) in a project with a build (a `build` script in the worktree's `package.json`) gets one
// more check: `drift build` and `drift shots`, and `drift svg` when an SVG file changes, from the
// merge base to the head. A project with a build whose commits cannot be read is said on stderr.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { fill } from './succession.ts'
import { diffFiles, modelOf, tierOf, type Tier } from './lens-model.ts'
import { typeOf } from './rhythm.ts'
import { Refused } from '../../iterm-agents/scripts/tier.ts'
import { LENS_HEAD_CHARS } from '../../../core/lens.ts'
import { configDirOf } from '../../../core/env.ts'
import { lensMethod, methodWords } from '../../../hooks/lens-method.ts'

export const USAGE =
  'usage: review-brief.sh --out <path> --repo <owner/name> --pr <n> --title "<delivery>" --spec <path> --index <path> --delivery-report <path> --branch <b> --head <sha> '
  + '--worktree <dir> --orchestrator "<name [ref]>" --reason "<why this size>" [--size "<text>"] [--lens <name>]... [--tier deep|standard|light] '
  + '[--scope "<text>"] [--plan <path>] [--norms <path>] [--base <ref>] [--envelope "<text>"]'

const here = dirname(fileURLToPath(import.meta.url))
/** The fixed text of a review round's brief, in the plugin. */
export const TEMPLATE = join(here, '..', '..', '..', 'templates', 'agent-review-brief.md')
/** The one checklist every capture is audited against, by the path the briefs name. */
const CHECKLIST = join(here, '..', 'references', 'screenshot-checklist.md')

const REQUIRED = ['out', 'repo', 'pr', 'title', 'spec', 'index', 'delivery-report', 'branch', 'head', 'worktree', 'orchestrator', 'reason'] as const
const OPTIONAL = ['size', 'tier', 'scope', 'plan', 'norms', 'base', 'envelope'] as const
const TIERS = ['deep', 'standard', 'light']

export interface Fields {
  readonly out: string
  readonly repo: string
  readonly pr: string
  readonly title: string
  readonly spec: string
  readonly index: string
  readonly deliveryReport: string
  readonly branch: string
  readonly head: string
  readonly worktree: string
  readonly orchestrator: string
  readonly reason: string
  readonly size: string
  readonly lenses: readonly string[]
  readonly tier: string
  readonly scope: string
  readonly plan: string
  readonly norms: string
  readonly base: string
  readonly envelope: string
}

/** The fields the command line gives, or the line that says what it lacks. */
export function parseArgs(argv: readonly string[]): Fields | { readonly error: string } {
  const values = new Map<string, string>()
  const lenses: string[] = []
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k] ?? ''
    const name = flag.slice(2)
    if (flag === '--report') return { error: `--report is no longer a flag: the review's index path is --index <path>, a new file, never the implementer's report (${USAGE})` }
    if (!flag.startsWith('--') || !([...REQUIRED, ...OPTIONAL, 'lens'] as string[]).includes(name)) return { error: `unknown argument: ${flag} (${USAGE})` }
    const value = argv[k + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (name === 'lens') {
      if (value.trim() === '') return { error: '--lens needs a name' }
      lenses.push(value)
    }
    else values.set(name, value)
  }
  for (const name of REQUIRED) if ((values.get(name) ?? '').trim() === '') return { error: `--${name} is required (${USAGE})` }
  const get = (name: string, otherwise = ''): string => (values.get(name) ?? '') || otherwise
  for (const name of ['out', 'spec', 'index', 'delivery-report', 'worktree']) if (!isAbsolute(get(name))) return { error: `--${name} is an absolute path, got: ${get(name)}` }
  if (!/^[1-9][0-9]*$/.test(get('pr'))) return { error: `--pr is the pull request number, got: ${get('pr')}` }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(get('repo'))) return { error: `--repo is owner/name, got: ${get('repo')}` }
  if (!/^[0-9a-f]{7,40}$/i.test(get('head'))) return { error: `--head is a commit sha, 7 to 40 hexadecimal characters, got: ${get('head')}` }
  const tier = get('tier')
  if (tier !== '' && !TIERS.includes(tier)) return { error: `--tier is deep, standard or light, got: ${tier}` }
  return {
    out: get('out'), repo: get('repo'), pr: get('pr'), title: get('title'), spec: get('spec'), index: get('index'), deliveryReport: get('delivery-report'), branch: get('branch'),
    head: get('head'), worktree: get('worktree'), orchestrator: get('orchestrator'), reason: get('reason'), size: get('size'), lenses, tier,
    scope: get('scope'), plan: get('plan', get('spec')), norms: get('norms', existsSync(join(get('worktree'), 'CONTRIBUTING.md')) ? 'CONTRIBUTING.md' : 'none'), base: get('base', 'origin/main'), envelope: get('envelope', 'none'),
  }
}

/** The names of the `{{FIELD}}`s a text holds, each once, in order. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(match => match[1] ?? ''))]
}

/** A file's text, or undefined when it cannot be read. */
function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Each lens's method as this machine gives it, joined; none with no lens. */
export function lensMethods(lenses: readonly string[]): string {
  if (lenses.length === 0) return 'none'
  const record = textOf(join(configDirOf(process.env, homedir()), 'plugins', 'installed_plugins.json'))
  return lenses.map(lens => methodWords(lens, lensMethod(lens, record, textOf))).join('; ')
}

/** Whether the worktree's `package.json` names a build; a file that is there and does not parse is thrown. */
function hasBuild(worktree: string): boolean {
  const text = textOf(join(worktree, 'package.json'))
  if (text === undefined) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${join(worktree, 'package.json')} does not read as JSON`)
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts
  return typeof (scripts as { build?: unknown } | undefined)?.build === 'string'
}

/** The drift check of a refactor in a project with a build, or empty; `warning` says why it could not be decided. */
export function driftCheck(f: Fields): { readonly text: string; readonly warning?: string } {
  let from: string
  let subjects: string[]
  try {
    if (!hasBuild(f.worktree)) return { text: '' }
    const git = (...args: string[]): string => execFileSync('git', ['-C', f.worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    try {
      subjects = git('log', '--no-merges', '--format=%s', `${f.base}..${f.head}`).split('\n')
      // drift builds the two refs as given: the base's tip would count what the base gained since.
      from = git('merge-base', f.base, f.head)
    } catch {
      throw new Error(`the commits of ${f.base}..${f.head} cannot be read in ${f.worktree}`)
    }
  } catch (error) {
    return { text: '', warning: (error as Error).message }
  }
  const types = new Set(subjects.map(typeOf))
  if (!types.has('refactor') || types.has('feat') || types.has('fix')) return { text: '' }
  const commands = ['build', 'shots', ...(diffFiles(f.worktree, f.base, f.head).some(file => /\.svg$/i.test(file)) ? ['svg'] : [])]
  const runs = commands.map(command => `drift.sh ${command} --repo '${f.worktree}' --base ${from} --head ${f.head} --out <scratchpad>/drift-${command}`)
  return {
    text: [
      "One more check is fixed on this delivery: its commits make it a refactor, in a project with a build, so it is meant to change nothing. Load the `drift:drift` skill and run each line below with the `scripts/drift.sh` of its directory, one call each, with `timeout: 600000`:",
      '',
      '```bash',
      ...runs,
      '```',
      '',
      "Your index quotes each verdict in one line, as the skill's « Quote it » words it; a run that gives none (exit 2) reads `drift <command>: no verdict (<its reason>)`. A verdict is evidence, never a gate or a CI step: write no config and install nothing to get one, and a difference is a finding only where §4 bears it out.",
      '',
    ].join('\n'),
  }
}

/** What each field of the template reads, from the fields given. */
function values(f: Fields, drift: string): Record<string, string> {
  const lensed = f.lenses.length > 0
  // The readers' tier is the diff's class (lens-model.ts) unless `--tier` says otherwise; their model follows the tier.
  const tier = (f.tier !== '' || !lensed ? f.tier : tierOf(diffFiles(f.worktree, f.base, f.head))) as Tier
  return {
    PROJECT: f.repo.split('/').at(-1) ?? f.repo,
    DELIVERY_TITLE: f.title,
    SPEC: f.spec,
    PLAN: f.plan,
    NORMS: f.norms,
    PR: f.pr,
    BRANCH: f.branch,
    HEAD: f.head,
    BASE_BRANCH: f.base,
    WORKTREE: f.worktree,
    STATE_COMMANDS: 'git fetch origin && git status -sb | head -1 && git log --oneline -1',
    ROUND_SIZE: f.size !== '' ? f.size : lensed ? `${f.lenses.length} read-only lenses (${f.lenses.join(', ')})` : 'a single reading by you',
    ROUND_SIZE_REASON: f.reason,
    LENS_TIER: lensed ? tier : 'none',
    LENS_MODEL: lensed ? modelOf(tier) : 'none',
    // Core's reader description (lens.ts): the module reads the lens, pull request and range from it.
    LENS_DESCRIPTION: lensed ? `lens <lens> ${f.repo}#${f.pr} ${f.base}..${f.head.slice(0, LENS_HEAD_CHARS).toLowerCase()}` : 'none',
    LENS_METHODS: lensMethods(f.lenses),
    LENSES: lensed ? [f.lenses.map(lens => `- ${lens}`).join('\n'), ...(f.scope === '' ? [] : [f.scope])].join('\n\n') : f.scope === '' ? 'none' : `none\n\n${f.scope}`,
    SCREENSHOT_CHECKLIST: CHECKLIST,
    DRIFT_CHECK: drift,
    REPORT_PATH: f.index,
    DELIVERY_REPORT: f.deliveryReport,
    ORCHESTRATOR_NAME: f.orchestrator,
    RESOURCE_ENVELOPE: f.envelope,
  }
}

/**
 * Writes the brief and says its path; returns the exit status. `template` is the text to fill (the
 * plugin's own when omitted), read from `templatePath`.
 */
export function main(argv: readonly string[], io: Io, template?: string, templatePath: string = TEMPLATE): number {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    io.err(`review-brief: ${parsed.error}\n`)
    return 2
  }
  if (existsSync(parsed.index)) {
    io.err(`review-brief: --index ${parsed.index} already exists: it must be a new file for the review's index, never the implementer's report or another file\n`)
    return 2
  }
  let text = template
  if (text === undefined) {
    if (!existsSync(templatePath)) {
      io.err(`review-brief: the plugin's template ${templatePath} cannot be read\n`)
      return 2
    }
    text = readFileSync(templatePath, 'utf8')
  }
  const drift = driftCheck(parsed)
  let known: Record<string, string>
  try {
    known = values(parsed, drift.text)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    io.err(`review-brief: ${error.message}\n`)
    return 2
  }
  const unknown = placeholdersOf(text).filter(name => !(name in known))
  if (unknown.length > 0) {
    io.err(`review-brief: the template has fields this command does not fill: ${unknown.map(name => `{{${name}}}`).join(', ')}\n`)
    return 2
  }
  try {
    writeFileSync(parsed.out, fill(text, known))
  } catch (error) {
    io.err(`review-brief: ${parsed.out} cannot be written: ${(error as Error).message}\n`)
    return 2
  }
  if (drift.warning !== undefined) io.err(`review-brief: no drift step: ${drift.warning}\n`)
  io.out(`review brief: ${parsed.out}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo)
