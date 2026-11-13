// When a pull request needs no E2E record. Two routes, both decided here as pure functions:
// - its files hold no runtime (documentation, tests, CI configuration, prompt text, a plugin
//   manifest whose version alone moves), and a not-applicable E2E record giving the reason is
//   accepted for it;
// - the operator exempted its repository, every pull request or those a rule names (labels,
//   paths), in one file per repository under the plugin's data directory.
// register.ts reads GitHub and the files, and answers the calls.

import { RECORD_VERSION } from '../core/pr-record.ts'

// One file of pr-files, as far as the rule reads it.
export type PrFile = { filename: string; previous_filename?: string; patch?: string }

// pr-files' answer, or a throw: an answer that lists no files is never read as none.
export function parsePrFiles(text: string): PrFile[] {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('pr-files answered no list of files')
  return raw.map((entry: unknown) => {
    const { filename, previous_filename: previous, patch } = (entry ?? {}) as Record<string, unknown>
    if (typeof filename !== 'string' || filename === '') throw new Error('pr-files answered a file with no name')
    return {
      filename,
      ...(typeof previous === 'string' && previous !== '' ? { previous_filename: previous } : {}),
      ...(typeof patch === 'string' ? { patch } : {}),
    }
  })
}

// Documentation: a Markdown, reStructuredText or AsciiDoc file anywhere (prompt text included:
// skills, commands, agents and their references are Markdown), the top-level docs directory, and
// the repository's notices.
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc)$/i
const DOC_TOP = new Set(['docs', 'doc'])
const NOTICE = /^(LICEN[CS]E|NOTICE|AUTHORS|CODEOWNERS|CHANGELOG|CONTRIBUTING)(\.[A-Za-z]+)?$/
// Tests: a directory of tests at any depth, or a test file by its name.
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'])
const TEST_FILE = /[._](test|spec)\.[A-Za-z0-9]+$|^test_[^/]*\.py$|^conftest\.py$/
// CI configuration: its top-level directories and files.
const CI_TOP = new Set(['.github', '.gitlab', '.circleci', '.buildkite', 'ci'])
const CI_FILE = new Set(['.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'Jenkinsfile'])
// A plugin manifest, whose diff may only move its version.
const MANIFEST = /(^|\/)\.claude-plugin\/[^/]+\.json$/
const VERSION_LINE = /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/

// Whether a path, by itself, holds no runtime.
function quietPath(path: string): boolean {
  const parts = path.split('/')
  const base = parts[parts.length - 1]
  if (DOC_FILE.test(base) || NOTICE.test(base) || TEST_FILE.test(base) || CI_FILE.has(base)) return true
  if (parts.length > 1 && (DOC_TOP.has(parts[0]) || CI_TOP.has(parts[0]))) return true
  return parts.slice(0, -1).some((dir) => TEST_DIRS.has(dir))
}

// Whether a diff only moves version lines: each line it adds or removes is one.
function versionOnly(patch: string | undefined): boolean {
  if (!patch) return false
  const changed = patch.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line))
  return changed.length > 0 && changed.every((line) => VERSION_LINE.test(line))
}

/** The paths of a pull request that hold runtime: the files, and the old path of a moved one, the rule does not clear. */
export function runtimeFiles(files: readonly PrFile[]): string[] {
  const held: string[] = []
  for (const file of files) {
    const quiet = quietPath(file.filename) || (MANIFEST.test(file.filename) && versionOnly(file.patch))
    if (!quiet) held.push(file.filename)
    if (file.previous_filename && !quietPath(file.previous_filename)) held.push(file.previous_filename)
  }
  return held
}

// ---- the standing exemption of a repository ----

export const EXEMPT_DIR = 'e2e-exempt'

export type Exemption = {
  readonly v: number
  readonly repo: string
  // false once revoked: the file keeps the words that revoked it.
  readonly exempt: boolean
  readonly paths: readonly string[]
  readonly labels: readonly string[]
  readonly detail: string
  readonly session: string
  readonly at: string
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '')

/** The exemption a file holds, or undefined when it breaks its shape: then no pull request is exempt. */
export function parseExemption(raw: unknown): Exemption | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { v, repo, exempt, paths, labels, detail, session, at } = raw as Record<string, unknown>
  if (v !== RECORD_VERSION || typeof repo !== 'string' || !REPO.test(repo) || typeof exempt !== 'boolean') return undefined
  if (!strings(paths) || !strings(labels) || typeof detail !== 'string' || typeof session !== 'string' || typeof at !== 'string') return undefined
  return { v, repo, exempt, paths, labels, detail, session, at }
}

/** The file of a repository's exemption under the plugin's data directory. */
export function exemptionPath(dataDir: string, repo: string): string {
  return dataDir + '/' + EXEMPT_DIR + '/' + repo.toLowerCase() + '.json'
}

/** Whether a path matches a glob: `*` and `?` within a directory, `**` across them, a trailing `/` for all below. */
export function globMatches(glob: string, path: string): boolean {
  const pattern = glob.endsWith('/') ? glob + '**' : glob
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
      if (pattern[i + 1] === '/') i++
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + source + '$').test(path)
}

/**
 * Whether an exemption covers a pull request: with no rule, every one; else one that carries one of
 * its labels, or whose files (read, and not none) all match its paths, a moved file's old path too.
 */
export function covers(exemption: Exemption, labels: readonly string[], files: readonly PrFile[] | undefined): boolean {
  if (!exemption.exempt) return false
  if (exemption.paths.length === 0 && exemption.labels.length === 0) return true
  const carried = new Set(labels.map((label) => label.toLowerCase()))
  if (exemption.labels.some((label) => carried.has(label.toLowerCase()))) return true
  if (exemption.paths.length === 0 || !files || files.length === 0) return false
  const matched = (path: string) => exemption.paths.some((glob) => globMatches(glob, path))
  return files.every((file) => matched(file.filename) && (!file.previous_filename || matched(file.previous_filename)))
}

/** How the gate names the exemption that stands for a pull request's E2E. */
export function exemptionLine(exemption: Exemption): string {
  const rules = [
    ...(exemption.labels.length > 0 ? ['labels ' + exemption.labels.join(', ')] : []),
    ...(exemption.paths.length > 0 ? ['paths ' + exemption.paths.join(', ')] : []),
  ]
  return 'E2E exemption of ' + exemption.repo + (rules.length > 0 ? ' (' + rules.join(', ') + ')' : '') + ', '
    + exemption.at.slice(0, 10) + ': ' + exemption.detail
}
