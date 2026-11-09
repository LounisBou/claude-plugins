// The outcome evals: merged pull requests replayed from their base by a single session and by
// an orchestration, graded on what each leaves (evals/outcome/README.md).
//
//   npm run outcome -- dry-run --out <dir> [--case <id>] [--host <binary>]
//   npm run outcome -- pilot|measure --out <dir> --model <agent model> --judge-model <judge model>
//                      [--case <id>] [--host <binary>] [--deck <path>]
//
// A dry run replays the cases with stand-ins for the model: no money is spent, and it proves
// the cases, the benches and the graders before a paid run. A pilot and a measure run the host
// (the single arm) and an orchestrator session (the orchestration arm), each under its caps
// (evals/outcome/caps.json). <dir> is outside the checkout, short enough for a socket's address.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gitBench } from './lib/outcome/bench.ts'
import { CAPS_FILE, CASES_FILE, MODES, parseCapsFile, parseCases, selectCases, type Mode } from './lib/outcome/cases.ts'
import { byArm, deckMeter, dependencyNames, hostAgent, hostJudge, withoutOrchestrator } from './lib/outcome/host.ts'
import { benchLauncher, benchPathError, orchestrationAgent, realBench, type Launcher } from './lib/outcome/orchestration.ts'
import { findTranscript } from './lib/outcome/transcript.ts'
import { configDir, setting } from '../packages/core/src/paths.ts'
import { runEvals, type Ports, type Report } from './lib/outcome/harness.ts'
import { markdown } from './lib/outcome/report.ts'
import { filesJudge, oracleAgent, silentMeter } from './lib/outcome/stub.ts'
import { processIo, type Io } from './lib/io.ts'
import { isEntry } from './lib/plugins.ts'

const USAGE = 'usage: outcome dry-run|pilot|measure --out <dir outside the checkout> [--case <id>] [--host <binary>]; pilot and measure also --model <m> --judge-model <m> [--deck <path>]'
const SUITE_MS = 30 * 60 * 1000
const ARM_MS = 90 * 60 * 1000
/** How often an arm's meter is read, and how often an orchestration's transcript and home are. */
const METER_POLL_MS = 30_000
const ORCHESTRATION_POLL_MS = 15_000

export interface Options {
  readonly mode: Mode | 'dry-run'
  readonly out: string
  readonly only: string | undefined
  /** The host's binary: it runs the arms, the judgments and a plugin's TypeScript tests. */
  readonly host: string
  /** The agent's and the judge's models, pinned for a paid run: two runs compare only on the same pair. */
  readonly model: string | undefined
  readonly judgeModel: string | undefined
  /** The orchestrator's deck, read for what an orchestration's sessions spend. */
  readonly deck: string | undefined
}

const isMode = (value: string | undefined): value is Mode => MODES.some(mode => mode === value)

/** The options, or the line that says what is wrong with them. */
export function parseOptions(root: string, args: readonly string[]): Options | string {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        case: { type: 'string' },
        host: { type: 'string', default: 'claude' },
        model: { type: 'string' },
        'judge-model': { type: 'string' },
        deck: { type: 'string' },
      },
    })
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  const [mode, ...rest] = parsed.positionals
  if ((mode !== 'dry-run' && !isMode(mode)) || rest.length > 0) return USAGE
  const { out, model, deck } = parsed.values
  const judgeModel = parsed.values['judge-model']
  if (out === undefined) return USAGE
  if (mode !== 'dry-run' && (model === undefined || judgeModel === undefined)) return `${mode} needs --model and --judge-model: ${USAGE}`
  const absolute = resolve(root, out)
  const inside = relative(resolve(root), absolute)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return `--out must be outside the checkout: ${absolute}`
  return { mode, out: absolute, only: parsed.values.case, host: parsed.values.host, model, judgeModel, deck }
}

/** What a test stands in for: the launcher, and how often everything is polled. */
export interface Inject {
  readonly launcher?: Launcher
  readonly pollMs?: number
}

/** The deck's path: the orchestrator's state directory, under its override or the host's configuration. */
export function deckPath(env: Io['env']): string {
  return join(setting(env, 'ORCHESTRATOR_STATE_DIR') ?? join(configDir(env), 'claude-orchestrator'), 'deck.json')
}

/** The host's arms, meter and judge, with every installed orchestrator turned off but this checkout's. */
function hostPorts(root: string, options: Options, env: Io['env'], inject: Inject): Pick<Ports, 'agent' | 'meter' | 'judge'> {
  const operatorSettings = join(configDir(env), 'settings.json')
  const settingsFile = join(options.out, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(withoutOrchestrator(existsSync(operatorSettings) ? readJson(operatorSettings) : null)))
  const orchestratorDir = join(root, 'plugins', 'orchestrator')
  const names = dependencyNames(readJson(join(orchestratorDir, '.claude-plugin', 'plugin.json')))
  if (names instanceof Error) throw new Error(`the orchestrator's manifest: ${names.message}`)
  const dependencyDirs = names.map(name => join(root, 'plugins', name))
  const missing = dependencyDirs.find(dir => !existsSync(join(dir, '.claude-plugin', 'plugin.json')))
  if (missing !== undefined) throw new Error(`the orchestrator depends on a plugin this checkout lacks: ${missing}`)
  const bench = realBench(options.out)
  const tooLong = benchPathError(bench, process.getuid?.() ?? 0)
  if (tooLong !== null) throw new Error(`the orchestration arm cannot run in --out: ${tooLong}`)
  const judgeDir = join(options.out, 'judge')
  mkdirSync(judgeDir)
  const host = options.host
  const model = options.model ?? ''
  const projects = setting(env, 'ORCHESTRATOR_PROJECTS_DIR') ?? join(configDir(env), 'projects')
  const orchestration = orchestrationAgent({
    bench,
    model,
    orchestratorDir,
    dependencyDirs,
    settingsFile,
    launcher: inject.launcher ?? benchLauncher({ orchestratorDir, trustFile: join(options.out, 'trust.json'), env }),
    transcript: session => {
      const path = findTranscript(projects, session)
      return path === null ? null : readFileSync(path, 'utf8')
    },
    pollMs: inject.pollMs ?? ORCHESTRATION_POLL_MS,
  })
  return {
    agent: byArm(hostAgent({ host, model, settingsFile }), orchestration),
    meter: deckMeter(options.deck ?? deckPath(env)),
    judge: hostJudge({ host, model: options.judgeModel ?? '', settingsFile, dir: judgeDir }),
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export async function run(root: string, args: readonly string[], io: Io, signal: AbortSignal, now: () => number = Date.now, inject: Inject = {}): Promise<number> {
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
  const cases = parseCases(readJson(join(root, CASES_FILE)))
  const caps = parseCapsFile(readJson(join(root, CAPS_FILE))).runs[options.mode === 'dry-run' ? 'measure' : options.mode]
  const ports: Ports = {
    bench: gitBench(root, SUITE_MS, options.host),
    now,
    log: io.out,
    pollMs: inject.pollMs ?? METER_POLL_MS,
    armMs: ARM_MS,
    ...(options.mode === 'dry-run' ? { agent: oracleAgent(), meter: silentMeter(), judge: filesJudge() } : hostPorts(root, options, io.env, inject)),
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
