// The outcome evals: merged pull requests replayed from their base by a single session and by
// an orchestration, graded on what each leaves (evals/outcome/README.md).
//
//   npm run outcome -- dry-run --out <dir outside the checkout> [--case <id>] [--host <binary>]
//
// A dry run replays the cases with stand-ins for the model: no money is spent, and it proves
// the cases, the benches and the graders before a paid run.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gitBench } from './lib/outcome/bench.ts'
import { CAPS_FILE, CASES_FILE, parseCapsFile, parseCases, selectCases } from './lib/outcome/cases.ts'
import { runEvals, type Ports, type Report } from './lib/outcome/harness.ts'
import { markdown } from './lib/outcome/report.ts'
import { filesJudge, oracleAgent, silentMeter } from './lib/outcome/stub.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry } from './lib/plugins.ts'

const USAGE = 'usage: outcome dry-run --out <dir outside the checkout> [--case <id>] [--host <binary>]'
const SUITE_MS = 30 * 60 * 1000
const ARM_MS = 90 * 60 * 1000

export interface Options {
  readonly mode: 'dry-run'
  readonly out: string
  readonly only: string | undefined
  /** The host's binary: its test kit runs a plugin's TypeScript tests. */
  readonly host: string
}

/** The options, or the line that says what is wrong with them. */
export function parseOptions(root: string, args: readonly string[]): Options | string {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, options: { out: { type: 'string' }, case: { type: 'string' }, host: { type: 'string', default: 'claude' } } })
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  const [mode, ...rest] = parsed.positionals
  if (mode !== 'dry-run' || rest.length > 0) return USAGE
  const out = parsed.values.out
  if (out === undefined) return USAGE
  const absolute = resolve(root, out)
  const inside = relative(resolve(root), absolute)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return `--out must be outside the checkout: ${absolute}`
  return { mode, out: absolute, only: parsed.values.case, host: parsed.values.host }
}

function readJson(root: string, file: string): unknown {
  return JSON.parse(readFileSync(join(root, file), 'utf8'))
}

export async function run(root: string, args: readonly string[], io: Io, signal: AbortSignal, now: () => number = Date.now): Promise<number> {
  const options = parseOptions(root, args)
  if (typeof options === 'string') {
    io.err(options)
    return 2
  }
  mkdirSync(options.out, { recursive: true })
  if (readdirSync(options.out).length > 0) {
    io.err(`--out must be empty: ${options.out}`)
    return 2
  }
  const cases = parseCases(readJson(root, CASES_FILE))
  const caps = parseCapsFile(readJson(root, CAPS_FILE)).runs.measure
  const ports: Ports = {
    bench: gitBench(root, SUITE_MS, options.host),
    agent: oracleAgent(),
    meter: silentMeter(),
    judge: filesJudge(),
    now,
    log: io.out,
    pollMs: 30_000,
    armMs: ARM_MS,
  }
  const report: Report = await runEvals({
    mode: options.mode,
    repository: cases.repository,
    cases: selectCases(cases, caps, options.only),
    caps,
    workRoot: join(options.out, 'work'),
    ports,
    signal,
  })
  writeFileSync(join(options.out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`)
  writeFileSync(join(options.out, 'report.md'), markdown(report))
  io.out(`report: ${join(options.out, 'report.md')}`)
  return report.stopped === null ? 0 : 1
}

/* node:coverage ignore next 5 */
if (isEntry(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('cancelled')))
  process.exit(await run(process.cwd(), process.argv.slice(2), processIo, controller.signal))
}
