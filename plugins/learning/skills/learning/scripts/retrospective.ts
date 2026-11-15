// learning — the retrospective's code: what waits to be judged, the judgment kept, the session started.
//
//   retrospective.ts digest --config <dir>    the candidates to judge, each with its events' pointers
//   retrospective.ts judge  --config <dir>    one judgment, JSON on the input, kept as the candidate's state
//   retrospective.ts mark   --config <dir> <signature> <state> [--pr <owner/name#n>] [--ruling <text>]
//   retrospective.ts start  --config <dir>    start the retrospective's session when enough candidates wait
//
// <dir> is the host's configuration directory. The candidates are the distiller's (distil.ts); a
// candidate's state is one file per signature under <dir>/learning/candidates (core/learning.ts,
// `CANDIDATE_STATE_CONTRACT`). A candidate waits when it has no state, or when it was rejected or
// left unresolved and its events have since doubled (`isDue`). The session `start` launches is
// another one, headless: it wrote none of the pull requests it reads.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_STATE_CONTRACT, candidateStateDir, candidateStateFile, isDue, judged, moved, readCandidateState, RETROSPECTIVE_CONTRACT,
  type Candidate, type CandidateState, type Evidence, type LearningEvent,
} from '../../../core/learning.ts'
import { writeAtomic } from '../../../core/store.ts'
import { distil } from './distil.ts'
import { readJournals } from './health.ts'

export const RETROSPECTIVE_USAGE = 'usage: retrospective.ts digest|judge|start --config <dir>, or mark --config <dir> <signature> <state> [--pr <owner/name#n>] [--ruling <text>]'

/** The file that holds the time the last retrospective was started, and the session's output. */
export const STARTED_FILE = 'retrospective.started'
export const LOG_FILE = 'retrospective.log'

export const PROMPT = [
  'You are the learning retrospective, a session other than any that wrote the pull requests you read:',
  'you change no code, commit nothing and push nothing.',
  'Run the learning:retrospective skill and end with its report.',
].join(' ')

const HOUR_MS = 3_600_000
const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`

export interface Deps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
  /** The whole input, for `judge`. */
  readonly input: () => string
  /** Starts the session, detached, its output in `log`; the exit status of the start. */
  readonly launch: (prompt: string, log: string, cwd: string) => number
}

interface Waiting {
  readonly events: ReadonlyMap<string, LearningEvent>
  /** The candidates to judge, with the state each already has. */
  readonly due: ReadonlyArray<{ readonly candidate: Candidate; readonly state: CandidateState | undefined }>
  readonly candidates: readonly Candidate[]
}

/** The state kept for `signature`: undefined when none is, the sentence that says why when the file is not one. */
export function stateOf(config: string, signature: string): CandidateState | string | undefined {
  const path = join(candidateStateDir(config), candidateStateFile(signature))
  if (!existsSync(path)) return undefined
  try {
    return readCandidateState(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The candidates of the journals at `now` and those among them that wait; a state file that cannot be read keeps its candidate out, and is said. */
export function waiting(config: string, now: number, err: (line: string) => void): Waiting {
  const events = readJournals(config).flatMap(journal => journal.events)
  const candidates = distil(events, now)
  const due: Array<{ candidate: Candidate; state: CandidateState | undefined }> = []
  for (const candidate of candidates) {
    const state = stateOf(config, candidate.signature)
    if (typeof state === 'string') err(`learning retrospective: the state of ${candidate.signature} cannot be read, so it is not judged again: ${state}`)
    else if (isDue(candidate, state)) due.push({ candidate, state })
  }
  return { events: new Map(events.map(event => [event.id, event])), due, candidates }
}

function pointer(evidence: Evidence): string {
  if (evidence.type === 'record') return `record ${evidence.path}`
  if (evidence.type === 'check') return `check ${evidence.name} at ${evidence.head}`
  if (evidence.type === 'finding') return `finding ${evidence.severity} ${evidence.file}`
  if (evidence.type === 'ruling') return `ruling ${evidence.path}:${evidence.line}`
  return `refusal ${evidence.code}`
}

function eventLine(event: LearningEvent): string {
  const { repo, pr, head } = event.subject
  const subject = [repo === null ? null : `${repo}${pr === null ? '' : `#${pr}`}`, head === null ? null : `head ${head}`].filter(part => part !== null)
  const context = [event.context.role === null ? null : `role ${event.context.role}`, event.context.paths.length === 0 ? null : `paths ${event.context.paths.join(' ')}`].filter(part => part !== null)
  return `  event ${event.id} ${[`trust ${event.trust}`, ...subject, ...context, ...event.evidence.map(pointer)].join('; ')}`
}

function block(candidate: Candidate, state: CandidateState | undefined, events: ReadonlyMap<string, LearningEvent>): string {
  const shown = candidate.events.slice(0, RETROSPECTIVE_CONTRACT.digest_events)
  const more = candidate.events.length - shown.length
  return [
    `candidate ${candidate.signature}`,
    `  ${candidate.events.length} events from ${candidate.prs.length} pull requests (${candidate.prs.join(', ')}) in ${candidate.repos.length} repositories (${candidate.repos.join(', ')}), ${candidate.since} to ${candidate.until}`,
    ...(state === undefined ? [] : [`  ${state.state} at ${state.at} on ${state.candidate.events.length} events${state.ruling === null ? '' : `, ruling: ${state.ruling}`}`]),
    ...shown.flatMap(id => { const event = events.get(id); return event === undefined ? [] : [eventLine(event)] }),
    ...(more > 0 ? [`  and ${more} more events`] : []),
  ].join('\n')
}

/** The digest: the candidates to judge, whole ones only, under the contract's ceiling; those past it are counted. */
export function digest(found: Waiting): string {
  const blocks: string[] = []
  let size = 0
  for (const { candidate, state } of found.due) {
    const text = block(candidate, state, found.events)
    if (size + text.length > RETROSPECTIVE_CONTRACT.digest_max_chars) break
    blocks.push(text)
    size += text.length
  }
  const left = found.due.length - blocks.length
  return [
    `learning retrospective: ${found.due.length} of ${found.candidates.length} candidates to judge`,
    ...blocks,
    ...(left > 0 ? [`${left} more candidates wait past the digest's ceiling: judge these, then run the digest again`] : []),
  ].join('\n')
}

function keep(config: string, state: CandidateState): void {
  writeAtomic(join(candidateStateDir(config), candidateStateFile(state.signature)), `${JSON.stringify(state)}\n`)
}

function judge(config: string, deps: Deps): number {
  let judgement: unknown
  try {
    judgement = JSON.parse(deps.input())
  } catch {
    deps.err('learning retrospective: the judgment is not JSON; give { "signature", "cause", "remedy" } on the input')
    return 1
  }
  const signature = typeof judgement === 'object' && judgement !== null ? (judgement as Record<string, unknown>)['signature'] : undefined
  const found = waiting(config, deps.now(), deps.err).due.find(({ candidate }) => candidate.signature === signature)
  if (found === undefined) {
    deps.err(`learning retrospective: ${JSON.stringify(signature)} is no candidate that waits; the digest lists them`)
    return 1
  }
  const state = judged(found.candidate, judgement, iso(deps.now()))
  if (typeof state === 'string') {
    deps.err(`learning retrospective: the judgment of ${found.candidate.signature} is not kept: ${state}`)
    return 1
  }
  keep(config, state)
  deps.out(`${state.signature}: ${state.state}`)
  return 0
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}

function mark(config: string, args: readonly string[], deps: Deps): number {
  const [signature, to, ...options] = args
  const state = signature === undefined ? undefined : stateOf(config, signature)
  const name = CANDIDATE_STATE_CONTRACT.states.find(known => known === to)
  if (signature === undefined || name === undefined || options.length % 2 !== 0) {
    deps.err(RETROSPECTIVE_USAGE)
    return 2
  }
  if (state === undefined || typeof state === 'string') {
    deps.err(`learning retrospective: ${signature} has no state to move${state === undefined ? ': it was never judged' : `: ${state}`}`)
    return 1
  }
  const next = moved(state, { state: name, pr: option(options, '--pr') ?? null, ruling: option(options, '--ruling') ?? null }, iso(deps.now()))
  if (typeof next === 'string') {
    deps.err(`learning retrospective: ${signature} is not moved to ${to}: ${next}`)
    return 1
  }
  keep(config, next)
  deps.out(`${next.signature}: ${next.state}`)
  return 0
}

function start(config: string, deps: Deps): number {
  const now = deps.now()
  const count = waiting(config, now, deps.err).due.length
  if (count < RETROSPECTIVE_CONTRACT.min_candidates) {
    deps.out(`learning retrospective: not started, ${count} candidates wait and it starts at ${RETROSPECTIVE_CONTRACT.min_candidates}`)
    return 0
  }
  const dir = join(config, CANDIDATE_STATE_CONTRACT.plugin)
  const marker = join(dir, STARTED_FILE)
  const last = existsSync(marker) ? Date.parse(readFileSync(marker, 'utf8').trim()) : NaN
  if (now - last < RETROSPECTIVE_CONTRACT.again_hours * HOUR_MS) {
    deps.out(`learning retrospective: not started, one was started at ${iso(last)}`)
    return 0
  }
  const log = join(dir, LOG_FILE)
  mkdirSync(dir, { recursive: true })
  const status = deps.launch(PROMPT, log, dir)
  if (status !== 0) {
    deps.err(`learning retrospective: the session did not start (exit ${status})`)
    return 1
  }
  writeAtomic(marker, `${iso(now)}\n`)
  deps.out(`learning retrospective: started on ${count} candidates, its report goes to ${log}`)
  return 0
}

/** The command line; the exit status. */
export function run(args: readonly string[], deps: Deps): number {
  const [command, flag, config, ...rest] = args
  const known = command === 'digest' || command === 'judge' || command === 'start' || command === 'mark'
  if (!known || flag !== '--config' || config === undefined || (command !== 'mark' && rest.length > 0)) {
    deps.err(RETROSPECTIVE_USAGE)
    return 2
  }
  try {
    if (command === 'judge') return judge(config, deps)
    if (command === 'mark') return mark(config, rest, deps)
    if (command === 'start') return start(config, deps)
    deps.out(digest(waiting(config, deps.now(), deps.err)))
    return 0
  } catch (error) {
    deps.err(`learning retrospective: the journals or the states could not be read or written, so nothing is done: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** The headless session's command line: detached, its output in `log`, Remote Control off. */
export function launchArgv(prompt: string, log: string): string[] {
  return ['sh', '-c', `nohup claude -p "$1" --permission-mode auto --settings '{"remoteControlAtStartup":false}' > "$2" 2>&1 < /dev/null &`, 'learning-retrospective', prompt, log]
}

/* node:coverage ignore next 13 */
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    now: Date.now,
    input: () => readFileSync(0, 'utf8'),
    launch: (prompt, log, cwd) => {
      const [command = 'sh', ...argv] = launchArgv(prompt, log)
      return spawnSync(command, argv, { cwd, stdio: 'ignore' }).status ?? 1
    },
  })
}
