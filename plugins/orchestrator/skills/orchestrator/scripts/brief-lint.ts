// brief-lint — flag a brief before it is dispatched, not after the round.
//
//   brief-lint.sh <brief-path> [--expect-created <path>]...
//
// --expect-created names a path the brief tells its session to create, so it cannot exist
// yet (an audit's report); the path check accepts exactly that path as absent. Repeatable.
//
// Prints one line per finding and exits 1 when there is any; exits 0 and says so otherwise.
// Every check reads the file's structure: a hole, a path, an address, a field. None
// reads the wording of an instruction. A brief that names its checkout and the head its base stood
// at when it was printed (`Checkout: <dir>`, `from <base>, which stood at <sha>`) also gets one line
// listing the files the base changed since: information, never a finding.
//
// What it CANNOT check: whether the scope is right, whether the contracts are the ones the
// next phase consumes, whether the tier fits the work, whether the spec it names was validated.
// Those stay the orchestrator's, and a green lint is not an approved brief.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isEntry, processIo, resolvedPath, type Io } from './lib/process.ts'
import { rows } from './short-commands.ts'

export const USAGE = 'usage: brief-lint.sh <brief-path> [--expect-created <path>]...'
/** The line of a review brief's §4 that names the index its review writes: a file that does not exist yet. */
const REVIEW_INDEX = /^\d+\. \*\*Your index\*\*, `(\/[^`]+)`/

export interface Finding {
  readonly line: number
  readonly text: string
}

export interface Context {
  /** The paths the brief tells its session to create. */
  readonly expected: readonly string[]
  /** The plugin's short command names, which a brief writes as `/name`. */
  readonly shortNames: ReadonlySet<string>
  readonly exists: (path: string) => boolean
}

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0

/** Every finding of a brief's text, in the order the checks run. */
export function lint(text: string, context: Context): Finding[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const found: Finding[] = []
  const say = (line: number, message: string): void => { found.push({ line, text: message }) }
  const some = (re: RegExp): boolean => lines.some(l => re.test(l))
  const implementer = some(/^You are the implementer/)

  /*
   * A placeholder that survived instantiation is a hole the agent reads as literal text. The one
   * name a brief may quote is the succession template's mode, inside an inline code span closed
   * on the same line (`Mode: {{MODE}}`): an odd count of backticks on each side of it.
   */
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\{\{[A-Za-z0-9_]+\}\}/g)) {
      const quoted = count(line.slice(0, m.index), /`/g) % 2 === 1 && count(line.slice(m.index + m[0].length), /`/g) % 2 === 1
      if (!(m[0] === '{{MODE}}' && quoted)) say(i + 1, `unfilled placeholder ${m[0]}`)
    }
  })

  // An upper-case variable reference does not expand in the shell of the session that opens the
  // file. Wider than the host's own variables on purpose: every one of them fails the same way.
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\$\{[A-Z][A-Z0-9_]*[:-]*[^}]*\}|\$[A-Z][A-Z0-9_]{2,}/g)) {
      say(i + 1, `unexpanded variable ${m[0]}: the agent's shell carries none of your environment; write the resolved value`)
    }
  })

  /*
   * Every absolute path the brief names in backticks exists on the machine the agent runs on,
   * but the ones named with --expect-created and the index a review brief tells its review to
   * write (`REVIEW_INDEX`), a file to be written, never one to be found. A slash command is no
   * path: /<plugin>:<command> with or without arguments, or one of this plugin's commands under
   * its short name.
   */
  lines.forEach((line, i) => {
    const index = REVIEW_INDEX.exec(line)?.[1]
    for (const m of line.matchAll(/`(\/[^`]+)`/g)) {
      const path = m[1] ?? ''
      if (path === index) continue
      if (/^\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+( .*)?$/.test(path)) continue
      if (context.shortNames.has((path.split(' ')[0] ?? '').slice(1))) continue
      if (!context.exists(path) && !context.expected.includes(path)) say(i + 1, `path does not exist: ${path}`)
    }
  })

  /*
   * One session reference. An implementer brief with none leaves the agent to discover its
   * orchestrator; two put a decoy beside the real address.
   */
  const refs = [...new Set(lines.flatMap(l => l.match(/\[[0-9a-f]{6}\]/g) ?? []))].sort()
  if (implementer && refs.length === 0) say(1, 'no orchestrator address: name the exact ListAgents name and reference')
  if (refs.length > 1) {
    say(1, `more than one session reference (${refs.map(r => `${r} `).join('')}): one address, no example beside it`)
  }

  // An implementer brief names the spec its phase builds, as a field of its own (`Spec: <path>`,
  // or `Spec: none` for a build that has none); the path's existence is the path check's.
  if (implementer && !some(/^(\d+\.\s+|[-*]\s+)?Spec:\s*\S/)) {
    say(1, 'no spec field: name the design this phase builds on a line of its own, `Spec: <path>`, or `Spec: none`')
  }

  /*
   * A brief whose reader confirms the takeover to its own predecessor carries that predecessor's
   * close, as the launcher's command: a brief written by hand dropped the step, and the
   * predecessor stayed open after the takeover.
   */
  if (some(/takeover confirmed/i) && some(/your predecessor/i) && !some(/(close|takeover) --tty .*--expect-title/)) {
    say(1, 'succession brief without the predecessor\'s close: the successor closes its predecessor\'s tab with the launcher\'s close --tty and --expect-title, on its "handed over" or after five minutes on a reading of its screen; instantiate the template, never write the brief by hand')
  }
  return found
}

/** `git diff --name-only <since> <base>` in a checkout: the files changed, undefined when it cannot be read. */
export type ChangedFiles = (dir: string, since: string, base: string) => readonly string[] | undefined

/** The files listed by name before the rest are counted. */
export const CHANGED_SHOWN = 20

/**
 * The line saying what the base changed since the brief was printed, from the checkout and the head
 * its `from <base>, which stood at <sha>` line names; undefined when the brief names neither, or git
 * cannot tell.
 */
export function changedLine(text: string, changed: ChangedFiles): string | undefined {
  const dir = /^Checkout: `([^`]+)`/m.exec(text)?.[1]
  const stood = /from `([^`]+)`, which stood at ([0-9a-f]{7,40})\b/.exec(text)
  if (dir === undefined || stood === null) return undefined
  const [, base = '', since = ''] = stood
  const files = changed(dir, since, base)
  if (files === undefined) return undefined
  if (files.length === 0) return `nothing changed on ${base} since ${since}`
  const shown = files.slice(0, CHANGED_SHOWN).join(', ')
  return `${files.length} file(s) changed on ${base} since ${since}: ${shown}${files.length > CHANGED_SHOWN ? `, and ${files.length - CHANGED_SHOWN} more` : ''}`
}

/** The changed files as git tells them in the checkout. */
export function gitChanged(dir: string, since: string, base: string): readonly string[] | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'diff', '--name-only', since, base], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).split('\n').filter(line => line !== '')
  } catch {
    return undefined
  }
}

export interface Deps {
  readonly io: Io
  /** The plugin's root, where short-names.tsv is. */
  readonly root: string
  readonly changed?: ChangedFiles
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function shortNames(root: string): Set<string> {
  try {
    return new Set(rows(readFileSync(join(root, 'short-names.tsv'), 'utf8')).map(r => r.short))
  } catch {
    return new Set()
  }
}

export function main(argv: readonly string[], deps: Deps): number {
  const die = (message: string): number => {
    deps.io.err(`${message}\n`)
    return 1
  }
  let brief = ''
  const expected: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--expect-created') {
      const path = argv[++i] ?? ''
      if (path === '') return die(`brief-lint: --expect-created needs a path (${USAGE})`)
      expected.push(path)
    } else if (brief !== '') return die(`brief-lint: one brief at a time (${USAGE})`)
    else brief = arg
  }
  if (brief === '') return die(USAGE)
  if (!isFile(brief)) return die(`brief-lint: not a file: ${brief}`)
  const text = readFileSync(brief, 'utf8')
  const found = lint(text, { expected, shortNames: shortNames(deps.root), exists: existsSync })
  for (const f of found) deps.io.out(`${brief}:${f.line}: ${f.text}\n`)
  const since = changedLine(text, deps.changed ?? gitChanged)
  if (since !== undefined) deps.io.out(`brief-lint: ${brief}: ${since}\n`)
  if (found.length === 0) {
    deps.io.out(`brief-lint: ${brief}: 0 findings\n`)
    return 0
  }
  return die(`brief-lint: ${brief}: ${found.length} finding(s)`)
}

/* node:coverage ignore next 4 */
if (isEntry(import.meta.url)) {
  const script = resolvedPath(process.argv[1] ?? '')
  process.exitCode = main(process.argv.slice(2), { io: processIo, root: resolve(dirname(script), '..', '..', '..') })
}
