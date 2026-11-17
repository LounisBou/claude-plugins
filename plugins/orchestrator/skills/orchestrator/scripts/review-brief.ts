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
// `--delivery-report` is the implementer's report (its self-review lines and its E2E line), a path the
// brief names so the review session reads it; it is only read, never written.
// `--report`, the index flag's former name, read as the implementer's report and was taken for it, so it
// is refused with a message naming `--index`.
//
// No lens is a single reading by the review session itself: the lens list and the tier read `none`.
// Lenses are one `--lens` each, their size said as « 3 read-only lenses (a, b, c) » unless `--size`
// gives it; `--scope` is the text that follows the list, what the readers check.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntry, processIo, type Io } from './lib/process.ts'
import { fill } from './succession.ts'

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
  const tier = get('tier', 'standard')
  if (!TIERS.includes(tier)) return { error: `--tier is deep, standard or light, got: ${tier}` }
  if (lenses.length === 0 && get('tier') !== '') return { error: '--tier goes with --lens: with no lens the tier reads none' }
  return {
    out: get('out'), repo: get('repo'), pr: get('pr'), title: get('title'), spec: get('spec'), index: get('index'), deliveryReport: get('delivery-report'), branch: get('branch'),
    head: get('head'), worktree: get('worktree'), orchestrator: get('orchestrator'), reason: get('reason'), size: get('size'), lenses, tier,
    scope: get('scope'), plan: get('plan', get('spec')), norms: get('norms', 'CONTRIBUTING.md'), base: get('base', 'origin/main'), envelope: get('envelope', 'none'),
  }
}

/** The names of the `{{FIELD}}`s a text holds, each once, in order. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(match => match[1] ?? ''))]
}

/** What each field of the template reads, from the fields given. */
function values(f: Fields): Record<string, string> {
  const lensed = f.lenses.length > 0
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
    LENS_TIER: lensed ? f.tier : 'none',
    LENSES: lensed ? [f.lenses.map(lens => `- ${lens}`).join('\n'), ...(f.scope === '' ? [] : [f.scope])].join('\n\n') : f.scope === '' ? 'none' : `none\n\n${f.scope}`,
    SCREENSHOT_CHECKLIST: CHECKLIST,
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
  const known = values(parsed)
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
  io.out(`review brief: ${parsed.out}\n`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2), processIo)
