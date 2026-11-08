// The bench an arm works on and is graded on: a private clone of the repository at a commit,
// with no remote, so nothing an arm does reaches the forge; the change it leaves, read as a
// diff against the base; the plugin's suite run on it; and the reference's own tests laid over
// it. Git and the suite run as argument vectors, never through a shell.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ENV } from '../../../packages/core/src/env.ts'

const run = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024
const TAIL_LINES = 40

export interface Diff {
  readonly patch: string
  /** The paths the change touches, sorted. */
  readonly files: readonly string[]
  /** Lines added and removed. */
  readonly lines: number
}

export interface SuiteResult {
  readonly passed: boolean
  /** The last lines the suite printed, for the report. */
  readonly tail: string
}

export interface Bench {
  /** A clone at `commit` in `dir`, detached, without a remote. */
  prepare(dir: string, commit: string): Promise<void>
  /** Everything the arm left in `dir`, committed or not, against `base`. */
  changes(dir: string, base: string): Promise<Diff>
  /** The merged pull request's own change. */
  reference(base: string, merge: string): Promise<Diff>
  /** The test files the merged change added or changed in `plugin`. */
  referenceTests(base: string, merge: string, plugin: string): Promise<string[]>
  /** Lays the reference's version of `files` over `dir`. */
  overlay(dir: string, merge: string, files: readonly string[]): Promise<void>
  suite(dir: string, plugin: string, signal: AbortSignal): Promise<SuiteResult>
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, encoding: 'utf8' })
  return stdout
}

function sortedLines(text: string): string[] {
  return text.split('\n').filter(Boolean).sort()
}

function countLines(numstat: string): number {
  let lines = 0
  for (const row of numstat.split('\n')) {
    const [added, removed] = row.split('\t')
    // A binary file reads `-`: it counts no line.
    lines += (Number(added) || 0) + (Number(removed) || 0)
  }
  return lines
}

/** Whether `path` is a test of `plugin`: under a tests directory, or named as a test. */
export function isTestPath(path: string, plugin: string): boolean {
  if (!path.startsWith(`plugins/${plugin}/`)) return false
  return /\/tests?\//.test(path) || /\.test\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path)
}

/** What a failed child process printed, and why it failed. */
export function printed(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  return ['stdout', 'stderr', 'message']
    .map(key => Reflect.get(error, key))
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
}

/** What a suite's output says about its failure: its failing lines first, then its last lines. */
export function tail(text: string): string {
  const lines = text.split('\n').filter(Boolean)
  const failing = lines.filter(line => /\bFAIL\b|^not ok|\(fail\)|\bfailed\b|Error:/.test(line)).slice(0, TAIL_LINES / 2)
  const last = lines.slice(-TAIL_LINES / 2).filter(line => !failing.includes(line))
  return [...failing, ...last].join('\n')
}

/** Whether the plugin in `dir` holds TypeScript tests, which only the host's test kit runs. */
export function hasHostTests(dir: string): boolean {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).some(path => path.endsWith('.test.ts') && !path.split('/').includes('node_modules'))
}

/** The bench over a local clone of the repository at `source`; `host` is the host's binary, for its test kit. */
export function gitBench(source: string, suiteMs: number, host: string): Bench {
  return {
    async prepare(dir, commit) {
      await run('git', ['clone', '--quiet', '--shared', '--no-checkout', source, dir], { maxBuffer: MAX_BUFFER })
      await git(dir, ['checkout', '--quiet', '--detach', commit])
      await git(dir, ['remote', 'remove', 'origin'])
    },

    async changes(dir, base) {
      await git(dir, ['add', '--all'])
      return {
        patch: await git(dir, ['diff', '--cached', '--binary', base]),
        files: sortedLines(await git(dir, ['diff', '--cached', '--name-only', base])),
        lines: countLines(await git(dir, ['diff', '--cached', '--numstat', base])),
      }
    },

    async reference(base, merge) {
      return {
        patch: await git(source, ['diff', '--binary', base, merge]),
        files: sortedLines(await git(source, ['diff', '--name-only', base, merge])),
        lines: countLines(await git(source, ['diff', '--numstat', base, merge])),
      }
    },

    async referenceTests(base, merge, plugin) {
      const changed = sortedLines(await git(source, ['diff', '--name-only', '--diff-filter=d', base, merge]))
      return changed.filter(path => isTestPath(path, plugin))
    },

    async overlay(dir, merge, files) {
      if (files.length > 0) await git(dir, ['checkout', merge, '--', ...files])
    },

    async suite(dir, plugin, signal) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin)) throw new Error(`not a plugin name: ${JSON.stringify(plugin)}`)
      const root = join('plugins', plugin)
      const script = join(root, 'tests', 'run-tests.sh')
      if (!existsSync(join(dir, script))) return { passed: false, tail: `no suite at ${script}` }
      const steps: [string, string[]][] = [['bash', [script]]]
      // The plugin's TypeScript tests import the host's kit: its own command runs them.
      if (hasHostTests(join(dir, root))) steps.push([host, ['plugin', 'test', root]])
      // As CI runs it: a suite that checks a contract with github finds the bench's own github.
      const env = { ...process.env, [ENV.githubRoot]: join(dir, 'plugins', 'github') }
      const printedLines: string[] = []
      for (const [file, args] of steps) {
        try {
          const { stdout, stderr } = await run(file, args, { cwd: dir, env, signal, timeout: suiteMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' })
          printedLines.push(stdout, stderr)
        } catch (error: unknown) {
          printedLines.push(printed(error))
          return { passed: false, tail: tail(printedLines.join('\n')) }
        }
      }
      return { passed: true, tail: tail(printedLines.join('\n')) }
    },
  }
}
