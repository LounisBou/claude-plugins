// The orchestration arm, driven as the operator drives an orchestration: an interactive
// orchestrator session opened through the checkout's own launcher in a detached home of the
// arm's bench, left to spawn its agents, read through its transcript until a turn declares it is
// done or waits on an operator who is not there, then closed with its agents and proved gone.
// What decides is pure and tested here against a fake launcher; the processes are a thin layer.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionName } from '../../../packages/core/src/names.ts'
import type { Agent, AgentRun, OrchestrationRun } from './harness.ts'
import { readTranscript } from './transcript.ts'

/** A unix socket's address holds this many bytes on macOS, the terminating one left out. */
const SOCKET_PATH_MAX = 103
/** The launcher names a home server `orch-` and at most eight characters. */
const SOCKET_NAME_MAX = 'orch-'.length + 8
const SOCKET_SHAPE = /^orch-[0-9A-Za-z]{1,8}$/u
/** The longest a session name's subject may be. */
const SUBJECT_MAX = 25
const OPEN_MS = 240_000
const CLOSE_MS = 120_000
const PANES_MS = 15_000

/** What the orchestrator is told, once, after the brief: nobody answers in this run. */
export const NO_OPERATOR = [
  'No operator answers in this run, and none will. Every question you would put to the operator you decide yourself, by your own recommendation:',
  'record the decision in your state file, write it in your reply as one line `Decision: <question> → <choice>`, and go on.',
  'Never end a turn waiting on the operator.',
  'This checkout is what is graded: spawn every agent with `--dir` set to this checkout, never through `workspace.sh create`, with one agent writing at a time, and have each commit here.',
].join(' ')

/** What the orchestrator is typed at its start: its skill in `build` mode, then the brief. */
export function startupPrompt(brief: string): string {
  return `/orchestrator:orchestrator build\n\n${brief}\n\n${NO_OPERATOR}`
}

/** The orchestrator's session name for a case, its subject cut to what a name holds. */
export function benchTitle(caseId: string): string {
  return sessionName('Orch', `eval ${caseId}`.slice(0, SUBJECT_MAX).trimEnd())
}

/** Why a bench cannot hold the arm's home server, or null: checked before the arm, not after it. */
export function benchPathError(given: string, uid: number, home: string = homedir()): string | null {
  const bench = given.replace(/\/+$/u, '')
  if (!bench.startsWith('/')) return `the bench must be an absolute path: ${bench}`
  if (bench.split('/').filter(part => part !== '').length < 2) return `the bench must be at least two levels below /: ${bench}`
  if (home === bench || home.startsWith(`${bench}/`)) return `the bench must not be the home directory or hold it: ${bench}`
  const socket = join(bench, 'tmux', `tmux-${uid}`, 'x'.repeat(SOCKET_NAME_MAX))
  const bytes = Buffer.byteLength(socket)
  return bytes > SOCKET_PATH_MAX ? `the bench is too long for a socket's address (${bytes} > ${SOCKET_PATH_MAX} bytes): name a shorter --out, such as /tmp/oc/1` : null
}

/** The bench's path as the launcher sees it, links followed. */
export function realBench(bench: string): string {
  try {
    return realpathSync.native(bench)
  } catch {
    return bench
  }
}

// ---------------------------------------------------------------------------------------------
// The launcher

export interface BenchHome {
  /** The home server's socket name. */
  readonly socket: string
  /** Window 0's terminal. */
  readonly tty: string
  /** The orchestrator session's id, which names its transcript. */
  readonly session: string
}

export interface OpenRequest {
  readonly bench: string
  readonly dir: string
  readonly title: string
  readonly pluginDirs: readonly string[]
  readonly settingsFile: string
  readonly prompt: string
  readonly model: string
}

export interface Pane {
  readonly window: number
  readonly id: string
}

/** The launcher's bench opening, as the driver needs it. */
export interface Launcher {
  open(request: OpenRequest): Promise<BenchHome>
  /** The panes of the home, or null when its server is not running. */
  panes(bench: string, socket: string): Promise<Pane[] | null>
  /** Ends the home with every window of it; its answer says whether it was running. */
  close(bench: string, socket: string): Promise<string>
}

interface Exit {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function exec(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<Exit> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { env, timeout, maxBuffer: 4 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr })
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr })
      reject(error)
    })
  })
}

const lastLines = (exit: Exit): string => (exit.stderr.trim() || exit.stdout.trim()).split('\n').slice(-3).join(' / ').slice(0, 400)

export interface LauncherOptions {
  /** This checkout's `plugins/orchestrator`: the launcher run is the one the orchestrator ships. */
  readonly orchestratorDir: string
  readonly tmux?: string
  readonly env: NodeJS.ProcessEnv
}

export function benchLauncher(options: LauncherOptions): Launcher {
  const script = join(options.orchestratorDir, 'skills', 'iterm-agents', 'scripts', 'iterm-agent.sh')
  const tmux = options.tmux ?? 'tmux'
  return {
    async open(request) {
      mkdirSync(request.bench, { recursive: true })
      const promptFile = join(mkdtempSync(join(request.bench, 'prompt-')), 'prompt.txt')
      writeFileSync(promptFile, request.prompt)
      const args = ['bench-open', '--bench', request.bench, '--dir', request.dir, '--title', request.title]
      for (const dir of request.pluginDirs) args.push('--plugin-dir', dir)
      args.push('--settings', request.settingsFile, '--prompt-file', promptFile)
      if (request.model !== '') args.push('--model', request.model)
      args.push('--trust')
      const exit = await exec(script, args, options.env, OPEN_MS)
      if (exit.code !== 0) throw new Error(lastLines(exit) || `the launcher exited with ${exit.code}`)
      const field = (name: string): string => new RegExp(`^${name}=(\\S+)$`, 'mu').exec(exit.stdout)?.[1] ?? ''
      const home = { socket: field('socket'), tty: field('tty'), session: field('session') }
      if (!SOCKET_SHAPE.test(home.socket) || !/^\/dev\/\S+$/u.test(home.tty) || !/^[A-Za-z0-9-]{8,64}$/u.test(home.session)) {
        throw new Error(`the launcher printed no socket, tty and session: ${exit.stdout.trim().slice(-200)}`)
      }
      return home
    },
    async panes(bench, socket) {
      if (!SOCKET_SHAPE.test(socket)) return null
      const exit = await exec(tmux, ['-L', socket, 'list-panes', '-a', '-F', '#{window_index} #{pane_id}'], { ...options.env, TMUX_TMPDIR: join(bench, 'tmux') }, PANES_MS)
      if (exit.code !== 0) return null
      const panes: Pane[] = []
      for (const line of exit.stdout.split('\n')) {
        const match = /^(\d+) (%\d+)$/u.exec(line.trim())
        if (match?.[1] !== undefined && match[2] !== undefined) panes.push({ window: Number(match[1]), id: match[2] })
      }
      return panes
    },
    async close(bench, socket) {
      if (!SOCKET_SHAPE.test(socket)) throw new Error(`not a home server the launcher makes: ${JSON.stringify(socket)}`)
      const exit = await exec(script, ['close', '--bench', bench, '--socket', socket], options.env, CLOSE_MS)
      if (exit.code !== 0) throw new Error(lastLines(exit) || `the launcher exited with ${exit.code}`)
      return exit.stdout.trim()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The driver

export interface OrchestrationOptions {
  /** The run's `--out`: the home server's tmux directory is made in it, out of the graded diff. */
  readonly bench: string
  readonly model: string
  /** The orchestrator the arm loads: this checkout's, the release measured. */
  readonly orchestratorDir: string
  /** The plugins the orchestrator depends on, from the same checkout. */
  readonly dependencyDirs: readonly string[]
  /** A settings file that turns off every installed orchestrator, so only `orchestratorDir` loads. */
  readonly settingsFile: string
  readonly launcher: Launcher
  /** The orchestrator session's transcript text, or null while it does not exist yet. */
  readonly transcript: (session: string) => string | null
  /** How often the home and the transcript are read. */
  readonly pollMs: number
}

/** The launcher's answer to a close of a home that is not running. */
const NOT_RUNNING = /is not running/u

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The orchestration arm: one interactive orchestrator session in a detached home, closed whatever happens. */
export function orchestrationAgent(options: OrchestrationOptions): Agent {
  const { launcher, bench } = options
  return {
    async run({ case: task, dir, prompt, signal }): Promise<AgentRun> {
      let home: BenchHome
      try {
        home = await launcher.open({
          bench,
          dir,
          title: benchTitle(task.id),
          pluginDirs: [options.orchestratorDir, ...options.dependencyDirs],
          settingsFile: options.settingsFile,
          prompt: startupPrompt(prompt),
          model: options.model,
        })
      } catch (error: unknown) {
        return { costUsd: null, error: `could not open the orchestrator: ${messageOf(error)}` }
      }

      const agents = new Set<string>()
      let decisions: readonly string[] = []
      let askedOperator: string | null = null
      let problem: string | null = null
      const seen = (panes: readonly Pane[] | null): void => {
        for (const pane of panes ?? []) if (pane.window !== 0) agents.add(pane.id)
      }
      try {
        // The end is concluded only on the same idle state read twice in a row: a turn that has
        // just ended may be woken by a notice or a refusal of the stop gate a moment later.
        let previous: string | null = null
        while (!signal.aborted) {
          const panes = await launcher.panes(bench, home.socket)
          seen(panes)
          const text = options.transcript(home.session)
          const reading = text === null ? null : readTranscript(text)
          if (reading !== null) decisions = reading.decisions
          const kind = reading?.idle === true ? reading.wait?.kind : undefined
          if (reading !== null && (kind === 'done' || kind === 'operator')) {
            if (previous === reading.signature) {
              if (kind === 'operator') askedOperator = reading.wait?.blocks ?? ''
              break
            }
            previous = reading.signature
          } else {
            previous = null
          }
          if (panes === null) {
            problem = 'the orchestrator’s home ended before the orchestration was over'
            break
          }
          await sleep(options.pollMs, signal)
        }
        seen(await launcher.panes(bench, home.socket))
      } catch (error: unknown) {
        problem = `the orchestration could not be followed: ${messageOf(error)}`
      } finally {
        // The home ends whole, the orchestrator's window and its agents' with it; the second call
        // is the proof that none is left.
        try {
          await launcher.close(bench, home.socket)
          const left = await launcher.close(bench, home.socket)
          if (!NOT_RUNNING.test(left)) problem = [problem, `sessions are left open: ${left}`].filter(part => part !== null).join('; ')
        } catch (error: unknown) {
          problem = [problem, `could not close the home: ${messageOf(error)}`].filter(part => part !== null).join('; ')
        }
      }
      const orchestration: OrchestrationRun = { agentsOpened: agents.size, decisions, askedOperator }
      return { costUsd: null, error: problem, orchestration }
    },
  }
}
