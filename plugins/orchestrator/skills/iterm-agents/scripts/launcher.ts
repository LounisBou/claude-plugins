// launcher — the entry of `iterm-agent.sh`: reads the command line by core's argument set
// (core/launcher.ts) into a typed request, then hands that request to the adapter beside it
// (iterm_agent.py, which drives iTerm2 through the app's own API) as `--request <json>`.
//
// A line the set cannot read is refused here, before the adapter starts: `ERROR: <why>` and exit 1
// for a refusal, `<command>: error: <why>` and exit 2 for a malformed line. A rotation whose spawn
// words are malformed is refused in the rotation's words.
//
// With ORCHESTRATOR_PRINT_REQUEST set, the request is printed on stdout instead (the suite's
// cases that drive the adapter in its own process read it so).
//
// The interpreter is ORCHESTRATOR_ADAPTER_PYTHON, which `iterm-agent.sh` resolves. The adapter's
// exit code is this command's; a signal that ends it ends this command with 128 + its number.
// SIGTERM and SIGHUP sent to this process are passed on; SIGINT is not, since the terminal sends
// it to the whole group and the adapter handles its own.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LauncherArgsError, parseLauncherArgs, type LauncherRequest } from '../../../core/launcher.ts'
import { isEntry, processIo, type Io } from '../../orchestrator/scripts/lib/process.ts'

/*
 * The directory as `iterm-agent.sh` names it (ORCHESTRATOR_ADAPTER_DIR): node resolves a module's
 * links, and the adapter builds the paths it prints and runs from its own, as the caller spells them.
 */
const HERE = process.env['ORCHESTRATOR_ADAPTER_DIR'] || dirname(fileURLToPath(import.meta.url))
const ADAPTER = join(HERE, 'iterm_agent.py')

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
    const child = spawn(python, [adapter, '--request', JSON.stringify(request)], { stdio: 'inherit' })
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

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const read = requestOf(argv)
  if ('said' in read) {
    io.err(`${read.said}\n`)
    return read.code
  }
  if (env['ORCHESTRATOR_PRINT_REQUEST']) {
    io.out(`${JSON.stringify(read.request)}\n`)
    return 0
  }
  return runAdapter(env['ORCHESTRATOR_ADAPTER_PYTHON'] || 'python3', read.request)
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2), process.env, processIo)
