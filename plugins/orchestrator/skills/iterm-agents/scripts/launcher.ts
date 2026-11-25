// launcher — the entry of `iterm-agent.sh`: reads the command line by core's argument set
// (core/launcher.ts) into a typed request, then hands that request to the adapter beside it
// (iterm_agent.py, which drives iTerm2 through the app's own API) as `--request <json>`.
//
// A line the set cannot read is refused here, before the adapter starts: `ERROR: <why>` and exit 1
// for a refusal, `<command>: error: <why>` and exit 2 for a malformed line. A rotation whose spawn
// words are malformed is refused in the rotation's words.
//
// `resolve-tier` is answered here (tier.ts). A spawn, or a rotation's spawn, is prepared before (spawn-prep.ts): its refusals said the same way.
// With ORCHESTRATOR_PRINT_REQUEST set, the request is printed on stdout instead (the suite's
// cases that drive the adapter in its own process read it so).
//
// The interpreter is ORCHESTRATOR_ADAPTER_PYTHON, which `iterm-agent.sh` resolves; the adapter is
// handed this node as ORCHESTRATOR_ADAPTER_NODE, for its chain writes (chains.ts). The adapter's
// exit code is this command's; a signal that ends it ends this command with 128 + its number.
// SIGTERM and SIGHUP sent to this process are passed on; SIGINT is not, since the terminal sends
// it to the whole group and the adapter handles its own.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDirOf } from '../../../core/env.ts'
import { LauncherArgsError, parseLauncherArgs, type LauncherRequest } from '../../../core/launcher.ts'
import { dataRootFileOf, dataRootOf, moduleDirOf } from '../../../core/orchestration.ts'
import { logArgv } from '../../../hooks/module-log.ts'
import { isEntry, processIo, run, type Io } from '../../orchestrator/scripts/lib/process.ts'
import { recordAgent, type RowDeps } from './agent-row.ts'
import { prepared, type PrepDeps } from './spawn-prep.ts'
import { modelsMapOf, Refused, resolveTier } from './tier.ts'

/*
 * The directory as `iterm-agent.sh` names it (ORCHESTRATOR_ADAPTER_DIR): node resolves a module's
 * links, and the adapter builds the paths it prints and runs from its own, as the caller spells them.
 */
const HERE = process.env['ORCHESTRATOR_ADAPTER_DIR'] || dirname(fileURLToPath(import.meta.url))
const ADAPTER = join(HERE, 'iterm_agent.py')
const LINT = join(HERE, '..', '..', 'orchestrator', 'scripts', 'brief-lint.sh')
const DISPATCH_RECORD = join(HERE, '..', '..', 'orchestrator', 'scripts', 'dispatch-record.sh')

const kindOf = (path: string): 'dir' | 'file' | null => {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/** What a spawn's preparation reads, from this process. */
export function prepDeps(env: NodeJS.ProcessEnv, io: Io): PrepDeps {
  return {
    env, cwd: process.cwd(), run, lint: LINT, warn: line => io.err(`${line}\n`), home: homedir(),
    read: path => (kindOf(path) === 'file' ? readFileSync(path, 'utf8') : null),
    isDir: path => kindOf(path) === 'dir', isFile: path => kindOf(path) === 'file',
  }
}

/** One `ledger` line in the hooks module's log, where the module itself writes it (module-io.ts `moduleDir`). */
async function moduleLog(env: NodeJS.ProcessEnv, line: string): Promise<void> {
  const config = configDirOf(env, homedir())
  const base = moduleDirOf(config)
  const file = dataRootFileOf(base)
  const dir = env['ORCHESTRATOR_MODULE_DIR'] || dataRootOf(base, kindOf(file) === 'file' ? readFileSync(file, 'utf8') : null)
  const [command = 'sh', ...args] = logArgv(join(HERE, '..', '..', '..'), config, 'ledger', line, new Date(), dir)
  await run([command, ...args])
}

/** What putting an agent on its row reads, from this process. */
export function rowDeps(env: NodeJS.ProcessEnv, io: Io): RowDeps {
  return {
    env, run, script: DISPATCH_RECORD, warn: line => io.err(`${line}\n`), log: line => moduleLog(env, line),
    read: path => (kindOf(path) === 'file' ? readFileSync(path, 'utf8') : null),
    list: dir => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
  }
}

/** The request the line makes, or the line to say and the exit code. */
export function requestOf(argv: readonly string[]): { request: LauncherRequest } | { said: string; code: number } {
  const [command = '', ...words] = argv
  try {
    return { request: parseLauncherArgs(command, words) }
  } catch (error) {
    if (!(error instanceof LauncherArgsError)) throw error
    const spawnError = 'spawn: error: '
    if (command === 'rotate' && error.message.startsWith(spawnError)) {
      return { said: `ERROR: rotate: refused: the spawn's options cannot be read (${error.message.slice(spawnError.length)}): nothing was spawned`, code: 1 }
    }
    return { said: error.code === 2 ? error.message : `ERROR: ${error.message}`, code: error.code }
  }
}

/** The adapter run on the request, its stdio this process's; resolves to the exit code. */
export function runAdapter(python: string, request: LauncherRequest, adapter: string = ADAPTER): Promise<number> {
  return new Promise(resolve => {
    // The adapter makes its chain writes through core's store (chains.ts), on this same node.
    const env = { ...process.env, ORCHESTRATOR_ADAPTER_NODE: process.env['ORCHESTRATOR_ADAPTER_NODE'] || process.execPath }
    const child = spawn(python, [adapter, '--request', JSON.stringify(request)], { stdio: 'inherit', env })
    const pass = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }
    const ignore = (): void => {}
    process.on('SIGTERM', pass)
    process.on('SIGHUP', pass)
    process.on('SIGINT', ignore)
    const done = (code: number): void => {
      process.off('SIGTERM', pass)
      process.off('SIGHUP', pass)
      process.off('SIGINT', ignore)
      resolve(code)
    }
    child.on('error', error => {
      process.stderr.write(`ERROR: the adapter cannot be started with ${python}: ${error.message}\n`)
      done(1)
    })
    child.on('exit', (code, signal) => done(code ?? (signal === null ? 1 : 128 + constants.signals[signal])))
  })
}

export async function main(
  argv: readonly string[], env: NodeJS.ProcessEnv, io: Io, deps: PrepDeps = prepDeps(env, io),
  adapter: typeof runAdapter = runAdapter, onRow: RowDeps = rowDeps(env, io),
): Promise<number> {
  const read = requestOf(argv)
  if ('said' in read) {
    io.err(`${read.said}\n`)
    return read.code
  }
  let request: LauncherRequest
  try {
    if (read.request.command === 'resolve-tier') {
      io.out(`${resolveTier(read.request.words?.[0] ?? '', modelsMapOf(deps.env, deps.home), deps)}\n`)
      return 0
    }
    request = await prepared(read.request, deps)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    io.err(`ERROR: ${error.message}\n`)
    return 1
  }
  if (env['ORCHESTRATOR_PRINT_REQUEST']) {
    io.out(`${JSON.stringify(request)}\n`)
    return 0
  }
  const code = await adapter(env['ORCHESTRATOR_ADAPTER_PYTHON'] || 'python3', request)
  // The agent runs, verified: its row says so. A dry run touches nothing.
  if (code === 0 && !env['ORCHESTRATOR_DRY_RUN']) await recordAgent(request, onRow)
  return code
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2), process.env, processIo)
