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
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareTrees, DriftError, render, type Link, type Report, type Tree } from './lib/compare.ts'
import { installPlaywright, PLAYWRIGHT_VERSION } from '../../../core/index.ts'
import { parseArgs, parseConfig, USAGE, type Config } from './lib/config.ts'
import { shots } from './lib/shots.ts'
import { checkout, removeCheckout, readJson, runDirectory, stepper, targetOf, type Deps } from './lib/run.ts'

export type { Deps } from './lib/run.ts'

/**
 * Every file under `dir`, by its `/`-separated path: a regular file with its bytes, a symbolic link
 * with its target. Any other kind of entry (a pipe, a socket, a device) cannot be compared: an error.
 */
function readTree(dir: string): Tree {
  const tree = new Map<string, Buffer | Link>()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const name = relative(dir, path).split(sep).join('/')
    if (entry.isDirectory()) continue
    if (entry.isFile()) tree.set(name, readFileSync(path))
    else if (entry.isSymbolicLink()) tree.set(name, { link: readlinkSync(path) })
    else throw new DriftError(`${name} is neither a file, a directory nor a symbolic link`)
  }
  return tree
}

interface Context {
  readonly top: string
  readonly config: Config
  readonly run: string
  readonly signal: AbortSignal | undefined
}

/** Checks `sha` out at `tree`, installs, builds, and moves its output to `into`. */
async function buildSide(context: Context, side: 'base' | 'head', sha: string, tree: string, into: string): Promise<void> {
  const { top, config, run, signal } = context
  const step = stepper(side, join(run, `${side}.log`), signal)
  await checkout(step, top, sha, tree, config.install, config.env)
  await step('build', config.build, tree, config.env)
  const output = join(tree, config.outDir)
  if (!existsSync(output) || !lstatSync(output).isDirectory()) throw new DriftError(`${side}: the build left no ${config.outDir}`)
  renameSync(output, into)
  await removeCheckout(top, tree)
}

async function build(argv: readonly string[], deps: Deps): Promise<number> {
  const options = parseArgs(argv)
  const { signal } = deps
  const { top, configPath, baseSha, headSha } = await targetOf(options, deps)
  const config = parseConfig(readJson(configPath), configPath)
  const run = runDirectory(options.out, deps)
  const work = mkdtempSync(join(deps.tmp, 'drift-work-'))
  const tree = join(work, 'tree')
  const context: Context = { top, config, run, signal }
  let compared: ReturnType<typeof compareTrees>
  try {
    await buildSide(context, 'base', baseSha, tree, join(work, 'base'))
    await buildSide(context, 'head', headSha, tree, join(work, 'head'))
    // The checkout's path as given and as resolved: a build reading its working directory gets the latter.
    const roots = [tree, join(realpathSync(work), 'tree')]
    compared = compareTrees(readTree(join(work, 'base')), readTree(join(work, 'head')), new RegExp(config.hashPattern), config.outDir, roots)
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

/** `drift install`: the pinned Playwright and its browser, once per machine, where every plugin finds them. */
async function install(argv: readonly string[], deps: Deps): Promise<number> {
  if (argv.length !== 1) throw new DriftError(USAGE)
  const { playwright, installed, bytes } = await installPlaywright({
    env: deps.env,
    home: deps.home,
    ...(deps.installRun === undefined ? {} : { run: deps.installRun }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  deps.out(`drift: Playwright ${PLAYWRIGHT_VERSION} ${installed ? 'installed' : 'already installed'} in ${playwright.dir} (${Math.round(bytes / 1e6)} MB)`)
  return 0
}

/** The command: 0 identical, 1 differ, 2 a tool error said on stderr. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  try {
    if (argv[0] === 'shots') return await shots(argv, deps)
    if (argv[0] === 'install') return await install(argv, deps)
    return await build(argv, deps)
  } catch (error) {
    deps.err(`drift: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/* node:coverage ignore next 13 */
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
