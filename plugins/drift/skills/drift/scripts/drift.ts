// drift build — whether two refs of a repository build to the same output. Its command line, its
// lines and its exit codes are documented in the header of drift.sh, the launcher every caller runs.
//
// Each ref is checked out with `git worktree add --detach` into one temporary directory outside
// the target checkout, base first then head at the SAME path, so a path a bundler embeds reads
// the same on both sides; the caller's working tree and index are never touched. Each checkout
// runs the config's install then its build, both without a shell, their output in
// `<run>/<side>.log`; its output directory is moved aside and the checkout removed before the
// next. A shared node_modules is not used: the lockfile may differ between the refs, and a cache
// under node_modules would carry the base's build into the head's.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareTrees, DriftError, render, type Report, type Tree } from './lib/compare.ts'
import { configPathOf, parseArgs, parseConfig, scratchpadOf, slugOf, type Config } from './lib/config.ts'

export interface Deps {
  /** Where the temporary checkouts are made, and the run directory when no scratchpad is found. */
  readonly tmp: string
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The host's temp root, under which a session's scratchpad is searched. */
  readonly hostTmp?: string
  readonly signal?: AbortSignal
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

interface Ran {
  readonly status: number | null
  readonly stdout: string
}

/** Runs `argv` without a shell; its streams go to `log` (appended) or are collected. Never rejects. */
function exec(argv: readonly string[], cwd: string, signal: AbortSignal | undefined, log?: string): Promise<Ran> {
  return new Promise(done => {
    const [command = '', ...args] = argv
    const fd = log === undefined ? undefined : openSync(log, 'a')
    const child = spawn(command, args, {
      cwd,
      stdio: fd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd],
      ...(signal === undefined ? {} : { signal }),
    })
    if (fd !== undefined) closeSync(fd)
    const out: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    let settled = false
    const settle = (status: number | null): void => {
      if (settled) return
      settled = true
      done({ status, stdout: Buffer.concat(out).toString('utf8').trim() })
    }
    child.on('error', () => settle(null))
    child.on('close', code => settle(code))
  })
}

/** Every regular file under `dir`, by its `/`-separated path, with its bytes. */
function readTree(dir: string): Tree {
  const tree = new Map<string, Buffer>()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    if (entry.isFile()) tree.set(relative(dir, path).split(sep).join('/'), readFileSync(path))
  }
  return tree
}

interface Context {
  readonly top: string
  readonly config: Config
  readonly run: string
  readonly signal: AbortSignal | undefined
}

const interrupted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new DriftError('interrupted')
}

/** Checks `sha` out at `tree`, installs, builds, and moves its output to `into`. */
async function buildSide(context: Context, side: 'base' | 'head', sha: string, tree: string, into: string): Promise<void> {
  const { top, config, run, signal } = context
  const log = join(run, `${side}.log`)
  writeFileSync(log, '')
  const step = async (what: string, argv: readonly string[], cwd: string): Promise<void> => {
    interrupted(signal)
    const ran = await exec(argv, cwd, signal, log)
    interrupted(signal)
    if (ran.status !== 0) throw new DriftError(`${side}: ${what} failed (exit ${ran.status ?? 'none'}); its log: ${log}`)
  }
  await step('checkout', ['git', '-C', top, 'worktree', 'add', '--detach', tree, sha], top)
  if (config.install !== undefined) await step('install', config.install, tree)
  await step('build', config.build, tree)
  const output = join(tree, config.outDir)
  if (!existsSync(output) || !lstatSync(output).isDirectory()) throw new DriftError(`${side}: the build left no ${config.outDir}`)
  renameSync(output, into)
  await removeCheckout(top, tree)
}

/** Removes a checkout made by `buildSide`, its record in the repository too; a no-op when there is none. */
async function removeCheckout(top: string, tree: string): Promise<void> {
  if (!existsSync(tree)) return
  const removed = await exec(['git', '-C', top, 'worktree', 'remove', '--force', tree], top, undefined)
  if (removed.status === 0 && !existsSync(tree)) return
  rmSync(tree, { recursive: true, force: true })
  await exec(['git', '-C', top, 'worktree', 'prune'], top, undefined)
}

async function git(top: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string | undefined> {
  const ran = await exec(['git', '-C', top, ...args], top, signal)
  interrupted(signal)
  return ran.status === 0 ? ran.stdout : undefined
}

function readConfig(path: string): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new DriftError(`no config at ${path}: write one, or name it with --config`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DriftError(`${path}: not JSON`)
  }
  return parseConfig(raw, path)
}

function runDirectory(out: string | undefined, deps: Deps): string {
  if (out !== undefined) {
    const dir = resolve(out)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const uid = process.getuid?.() ?? 0
  const pad = scratchpadOf(deps.env, deps.hostTmp ?? `/tmp/claude-${uid}`)
  return mkdtempSync(join(pad ?? deps.tmp, 'drift-'))
}

async function build(argv: readonly string[], deps: Deps): Promise<number> {
  const options = parseArgs(argv)
  const { signal } = deps
  const repo = resolve(options.repo)
  const top = existsSync(repo) ? await git(repo, ['rev-parse', '--show-toplevel'], signal) : undefined
  if (top === undefined) throw new DriftError(`${repo} is not a git repository`)
  let configPath = options.config
  if (configPath === undefined) {
    const slug = slugOf((await git(top, ['remote', 'get-url', 'origin'], signal)) ?? '')
    if (slug === undefined) throw new DriftError('no origin to name the config after: name it with --config')
    configPath = configPathOf(deps.home, slug)
  }
  const config = readConfig(resolve(configPath))
  const resolveRef = async (side: string, ref: string): Promise<string> => {
    const found = await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal)
    if (found === undefined) throw new DriftError(`${side}: ${ref} is not a commit`)
    return found
  }
  const baseSha = await resolveRef('base', options.base)
  const headSha = await resolveRef('head', options.head)
  const run = runDirectory(options.out, deps)
  const work = mkdtempSync(join(deps.tmp, 'drift-work-'))
  const tree = join(work, 'tree')
  const context: Context = { top, config, run, signal }
  let compared: ReturnType<typeof compareTrees>
  try {
    await buildSide(context, 'base', baseSha, tree, join(work, 'base'))
    await buildSide(context, 'head', headSha, tree, join(work, 'head'))
    compared = compareTrees(readTree(join(work, 'base')), readTree(join(work, 'head')), new RegExp(config.hashPattern), config.outDir)
  } finally {
    await removeCheckout(top, tree)
    rmSync(work, { recursive: true, force: true })
  }
  const report: Report = {
    version: 1,
    verdict: compared.files.length === 0 ? 'identical' : 'differ',
    differ: compared.files.length,
    normalised: compared.normalised,
    ambiguous: compared.ambiguous,
    hashPattern: config.hashPattern,
    base: { ref: options.base, sha: baseSha },
    head: { ref: options.head, sha: headSha },
    files: compared.files,
  }
  const lines = render(report)
  writeFileSync(join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(run, 'report.txt'), `${lines.join('\n')}\n`)
  for (const line of lines) deps.out(line)
  deps.out(`out: ${run}`)
  return report.verdict === 'identical' ? 0 : 1
}

/** The command: 0 identical, 1 differ, 2 a tool error said on stderr. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  try {
    return await build(argv, deps)
  } catch (error) {
    deps.err(`drift: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/* node:coverage ignore next 14 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(name, () => controller.abort())
  const code = await main(process.argv.slice(2), {
    tmp: tmpdir(),
    home: process.env['HOME'] ?? tmpdir(),
    env: process.env,
    signal: controller.signal,
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  })
  process.exitCode = code
}
