// The Python coverage floor (docs/conventions.md, « Tests and coverage »): a plugin's suite run
// under coverage.py, every Python process it starts measured, its total held to the plugin's floor
// in ci/python-coverage.json.
//
// coverage.py starts in each Python process that names the plugin through a `sitecustomize.py` put
// first on PYTHONPATH, so the engines a bash suite calls are measured as well as an in-process pytest. A process started
// with `-I` or `-E`, or with its own environment, ignores PYTHONPATH and is not measured.
//
// A plugin without a floor, or a part of a suite split in parts (SUITE_SHARD set), runs its suite
// alone: the measure of a part is not the plugin's.
//
//   node scripts/python-coverage.ts <plugin>             runs the suite; fails under the floor
//   node scripts/python-coverage.ts <plugin> --measure   runs the suite and prints the total, no floor
//
// Requires coverage.py for the `python3` on PATH. The floor is a ratchet: it rises to the figure
// measured, rounded down, and never falls.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isRecord } from './lib/plugins.ts'

export const FLOORS_FILE = join('ci', 'python-coverage.json')

/** Validates ci/python-coverage.json: `{ "floors": { <plugin>: <percent from 0 to 100> } }`. */
export function parseFloors(raw: unknown): Map<string, number> {
  if (!isRecord(raw) || !isRecord(raw['floors'])) throw new Error(`${FLOORS_FILE}: expected { "floors": { <plugin>: <percent> } }`)
  const floors = new Map<string, number>()
  for (const [plugin, floor] of Object.entries(raw['floors'])) {
    if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0 || floor > 100) throw new Error(`${FLOORS_FILE}: "${plugin}" needs a whole percent from 0 to 100, not ${JSON.stringify(floor)}`)
    floors.set(plugin, floor)
  }
  return floors
}

/** coverage.py's configuration for a plugin: its Python, tests excluded, branches counted, one data file per process. */
export function rcText(pluginDir: string, dataFile: string): string {
  return ['[run]', 'branch = True', 'parallel = True', `data_file = ${dataFile}`, `source = ${pluginDir}`, `omit = ${join(pluginDir, 'tests')}/*`, ''].join('\n')
}

/**
 * Starts coverage.py in a process that can run the plugin's Python: one whose command line names the
 * plugin's directory, or runs a module (pytest). The suites' own helpers (`python3 -c` reading a JSON
 * answer) skip its start, about 50 ms each, a cost the suites pay thousands of times. A Python
 * without coverage.py (a suite's own interpreter) runs unmeasured and prints nothing more.
 */
export function sitecustomize(pluginDir: string): string {
  return [
    'import sys',
    `_dir = ${JSON.stringify(pluginDir)}`,
    "_argv = getattr(sys, 'orig_argv', sys.argv)",
    "if '-m' in _argv or any(_dir in arg for arg in _argv):",
    '    try:',
    '        import coverage',
    '    except ImportError:',
    '        pass',
    '    else:',
    '        coverage.process_startup()',
    '',
  ].join('\n')
}

/** What the run does for a plugin: the suite alone, or under coverage held to a floor (null: measured only). */
export type Plan = { readonly measure: false } | { readonly measure: true; readonly floor: number | null }

export function plan(floor: number | undefined, measureOnly: boolean, shard: string | undefined): Plan {
  if (shard !== undefined && shard !== '') return { measure: false }
  if (measureOnly) return { measure: true, floor: null }
  return floor === undefined ? { measure: false } : { measure: true, floor }
}

/** Runs a command with the process's own output; answers its exit code. */
export type Run = (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => number

const spawnRun: Run = (command, args, env) => spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1

export function main(argv: readonly string[], root: string, io: Io = processIo, run: Run = spawnRun): number {
  const plugin = argv.find(arg => !arg.startsWith('--'))
  if (plugin === undefined) {
    io.err('usage: node scripts/python-coverage.ts <plugin> [--measure]')
    return 2
  }
  const floors = parseFloors(JSON.parse(readFileSync(join(root, FLOORS_FILE), 'utf8')))
  const pluginDir = resolve(root, 'plugins', plugin)
  const suite = join(pluginDir, 'tests', 'run-tests.sh')
  const decided = plan(floors.get(plugin), argv.includes('--measure'), io.env['SUITE_SHARD'])
  if (!decided.measure) return run(suite, [], io.env)

  const work = mkdtempSync(join(tmpdir(), 'python-coverage-'))
  try {
    const site = join(work, 'site')
    mkdirSync(site)
    writeFileSync(join(site, 'sitecustomize.py'), sitecustomize(pluginDir))
    const rc = join(work, 'coveragerc')
    writeFileSync(rc, rcText(pluginDir, join(work, 'data')))
    const pythonPath = [site, io.env['PYTHONPATH']].filter(part => part !== undefined && part !== '').join(delimiter)
    const status = run(suite, [], { ...io.env, COVERAGE_PROCESS_START: rc, PYTHONPATH: pythonPath })
    if (status !== 0) return status
    const coverage = (...args: string[]): number => run('python3', ['-m', 'coverage', ...args, `--rcfile=${rc}`], io.env)
    if (coverage('combine', '--quiet') !== 0) return 1
    io.out(`python coverage of ${plugin}, lines and branches, ${decided.floor === null ? 'measured' : `floor ${decided.floor} %`}:`)
    return coverage('report', '--format=total', '--precision=1', ...(decided.floor === null ? [] : [`--fail-under=${decided.floor}`]))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2), process.cwd())
