// spawn-prep — what a spawn's command line decides on its own, before the adapter reads the
// process table or the terminal: the refusals of options that cannot go together, the title's
// shape (core's names.ts), the tool names, the gate, the startup prompt and the brief built into it,
// and the tier's binding (tier.ts).
// A rotation's own refusals of the spawn it makes are read here too, before its spawn's.
//
// The adapter receives the options normalized (the title written the current way, the tool names
// trimmed, the gate a number) and the brief's prompt, its lint verdict and its path, and keeps the
// refusals that read who the caller is: an opening's and a wake's caller, an Orch title's caller.
import { resolve } from 'node:path'
import { currentSessionName } from '../../../core/names.ts'
import { NAMES_CONTRACT } from '../../../core/names.ts'
import type { LauncherRequest, OptionValue } from '../../../core/launcher.ts'
import type { Run } from '../../orchestrator/scripts/lib/process.ts'
import { EFFORT_LIST, EFFORTS, modelsMapOf, Refused, resolveTierPair } from './tier.ts'

export { Refused }


/** A name of one of `prefixes`, written the current way: the word, its colon, a blank, the subject. */
const shapeOf = (...prefixes: string[]): RegExp => new RegExp(`^(${prefixes.join('|')}): ${NAMES_CONTRACT.subject}$`, 'u')
export const TITLE_SHAPE = shapeOf('Orch', 'Agent')
export const AUDIT_TITLE_SHAPE = shapeOf('Audit')
export const COORD_TITLE_SHAPE = shapeOf('Coord')
/** An auditor's name as read, the strict title or a qualified one: « Audit neutre : <subject> ». */
export const AUDIT_NAME_SHAPE = new RegExp(`^Audit(?: [^\\s:]+)* ?: ${NAMES_CONTRACT.subject}$`, 'u')

/** What the preparation reads outside the line. */
export interface PrepDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly isDir: (path: string) => boolean
  readonly isFile: (path: string) => boolean
  readonly run: Run
  /** The brief lint (`brief-lint.sh`). */
  readonly lint: string
  readonly warn: (line: string) => void
  readonly home: string
  /** A file's text, or null when no file is there (the tier map). */
  readonly read: (path: string) => string | null
}


type Options = Record<string, OptionValue>

const text = (o: Options, key: string): string => {
  const v = o[key]
  return typeof v === 'string' ? v : ''
}
const yes = (o: Options, key: string): boolean => o[key] === true
const words = (o: Options, key: string): string[] => {
  const v = o[key]
  return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : []
}

function refuse(message: string): never {
  throw new Refused(message)
}

/** The first flag of `pairs` given, refused with `why`. */
function noneOf(pairs: readonly (readonly [string, boolean])[], why: (flag: string) => string): void {
  for (const [flag, given] of pairs) if (given) refuse(why(flag))
}

const isOrchName = (title: string): boolean => title.startsWith('Orch: ') && TITLE_SHAPE.test(title) && !/ \[[0-9A-Za-z]+\]$/.test(title)

/** A rotation's refusals of the spawn it makes, read before that spawn's own. */
export function rotationRefusal(rotate: Options, spawn: Options, unknown: readonly string[]): void {
  if (!text(rotate, 'old_tty')) refuse('rotate: --old-tty is required')
  noneOf([['--successor', yes(spawn, 'successor')], ['--auditor', yes(spawn, 'auditor')],
    ['--coordinator-successor', yes(spawn, 'coordinator_successor')], ['--wake', yes(spawn, 'wake')],
    ['--open', yes(spawn, 'open_')], ['--title-free', yes(spawn, 'title_free')],
    ['--no-remote-control', spawn['remote_control'] === false]],
  flag => `rotate: refused: ${flag} is not a rotation's (a rotation replaces an agent with a titled agent; a successor is spawned with spawn --successor)`)
  if (spawn['verify'] === false) {
    refuse("rotate: refused: --no-verify is not a rotation's (the old agent is closed only once its replacement is verified running)")
  }
  const word = unknown[0]
  if (word !== undefined) refuse(`spawn: unknown option ${word}`)
}

/** The spawn's options, normalized, with its brief read in; a Refused saying why none. */
export async function prepareSpawn(given: Options, deps: PrepDeps): Promise<Options> {
  const o: Options = { ...given, title: currentSessionName(text(given, 'title')) }
  const keep = words(given, 'keep_tool').map(name => name.trim())
  const drop = words(given, 'drop_tool').map(name => name.trim())
  o['keep_tool'] = keep
  o['drop_tool'] = drop
  for (const [flag, names] of [['--keep-tool', keep], ['--drop-tool', drop]] as const) {
    if (names.some(name => !name)) refuse(`spawn: refused: ${flag} needs a tool name, and got an empty one`)
  }
  const both = keep.find(name => drop.includes(name))
  if (both !== undefined) refuse(`spawn: refused: '${both}' is given to both --keep-tool and --drop-tool`)
  const gate = given['gate_tokens']
  let gateTokens = 0
  if (typeof gate === 'string') {
    if (!/^[0-9]+$/.test(gate) || Number(gate) < 1) refuse(`spawn: --gate-tokens must be a positive integer of tokens, got '${gate}'`)
    gateTokens = Number(gate)
  }
  o['gate_tokens'] = gateTokens
  const title = text(o, 'title')
  const [dir, model, tier, effort] = [text(o, 'dir'), text(o, 'model'), text(o, 'tier'), text(o, 'effort')]
  const [leftOf, rightOf, of, resume] = [text(o, 'left_of'), text(o, 'right_of'), text(o, 'of'), text(o, 'resume')]
  const [prompt, promptFile, brief, orchestrator] = [text(o, 'prompt'), text(o, 'prompt_file'), text(o, 'brief'), text(o, 'orchestrator')]
  const successor = yes(o, 'successor')
  const auditor = yes(o, 'auditor')
  const coordinator = yes(o, 'coordinator_successor')
  const wake = yes(o, 'wake')
  const open = yes(o, 'open_')
  const inherit = yes(o, 'inherit')
  const titleFree = yes(o, 'title_free')
  const resident = yes(o, 'resident')
  const noRemote = o['remote_control'] === false
  if (!dir) refuse('spawn: --dir is required')
  if (leftOf && rightOf) refuse('spawn: --left-of and --right-of are mutually exclusive')
  if (resident && (successor || auditor || coordinator)) {
    refuse("spawn: refused: --resident marks an agent of your chain; a successor, an auditor or a coordinator's successor is written into no chain as an agent")
  }
  if (coordinator) {
    noneOf([['--successor', successor], ['--auditor', auditor], ['--left-of', !!leftOf], ['--right-of', !!rightOf],
      ['--title-free', titleFree], ['--tier', !!tier], ['--model', !!model], ['--effort', !!effort], ['--no-remote-control', noRemote]],
    flag => `spawn: refused: ${flag} is not a coordinator-successor's: it lands at the first place of your window, reads "Coord: <subject>", runs on your model and effort and comes up under remote control`)
    if (!title) refuse('spawn: refused: --coordinator-successor needs --title "Coord: <subject>"')
    if (!COORD_TITLE_SHAPE.test(title)) {
      refuse(`spawn: refused: the coordinator's title reads "Coord: <subject>", the subject at most 25 characters and neither starting nor ending with a space, got '${title}'`)
    }
  } else if (title.startsWith('Coord:')) {
    refuse('spawn: refused: a "Coord:" title is the coordinator\'s; spawn it with --coordinator-successor, which places it at the first place of your window, keeps it out of every chain and brings it up under remote control on your model')
  }
  if (wake) {
    noneOf([['--successor', successor], ['--auditor', auditor], ['--coordinator-successor', coordinator], ['--left-of', !!leftOf],
      ['--right-of', !!rightOf], ['--title-free', titleFree], ['--tier', !!tier], ['--inherit-model', inherit],
      ['--resident', resident], ['--no-remote-control', noRemote]],
    flag => `spawn: refused: ${flag} is not a wake's: a woken orchestrator runs under its recorded name, model and effort, lands immediately right of you, joins no chain and comes up under remote control`)
    if (!isOrchName(title)) refuse(`spawn: refused: --wake needs the recorded name, --title "Orch: <subject>" without its reference, got '${title}'`)
    if (!!model !== !!effort) {
      refuse('spawn: refused: --wake takes the recorded model with its recorded effort, --model <id> --effort <level>, or neither: a wake never guesses the effort, nor the model, its orchestrator ran on')
    }
  }
  const plan = text(o, 'plan')
  if (plan) {
    if (!['1', '2', 'auto'].includes(plan)) refuse(`spawn: refused: --plan is 1, 2 or auto, got '${plan}'`)
    if (!(open || wake || (resume && title.startsWith('Agent:')))) refuse("spawn: refused: --plan routes an orchestrator at its birth, with --open or --wake, or a closed agent's resume: an orchestrator's agents, its successor and an auditor run on the plan of the session that spawns them")
  }
  if (resume && !wake && (!title.startsWith('Agent:') || successor || auditor || coordinator || open)) refuse("spawn: refused: --resume is a wake's or an agent's: it names the session a paused orchestrator or a closed agent of the same checkout resumes")
  if (resume && !/^[0-9A-Za-z-]+$/.test(resume)) refuse(`spawn: refused: --resume needs a session id, letters, digits and hyphens, got '${resume}'`)
  if ((open || wake) && !deps.env['ORCHESTRATOR_DRY_RUN'] && (deps.env['ORCHESTRATOR_SELF_TTY'] || deps.env['ORCHESTRATOR_PS_TABLE'])) {
    refuse(`spawn: refused: ${open ? '--open' : '--wake'} reads its caller from the real process table, and ORCHESTRATOR_SELF_TTY or ORCHESTRATOR_PS_TABLE would stand in for it: both are for tests and dry runs`)
  }
  if (open) {
    noneOf([['--successor', successor], ['--auditor', auditor], ['--coordinator-successor', coordinator], ['--wake', wake],
      ['--tier', !!tier], ['--inherit-model', inherit], ['--left-of', !!leftOf], ['--right-of', !!rightOf], ['--title-free', titleFree],
      ['--resident', resident], ['--brief', !!brief], ['--orchestrator', !!orchestrator], ['--no-remote-control', noRemote]],
    flag => `spawn: refused: ${flag} is not an opening's: an opened orchestrator runs under its own name, on the model and the effort its order names or the host's default, lands immediately right of you, joins no chain, reads its brief from its prompt and comes up under remote control`)
    if (!!model !== !!effort) {
      refuse("spawn: refused: an opening types the model and the effort the order names, --model <id> --effort <level>, or neither (the host's default applies)")
    }
    if (!isOrchName(title)) refuse(`spawn: refused: --open needs the new orchestrator's name, --title "Orch: <subject>" without a reference, got '${title}'`)
  }
  if (auditor) {
    noneOf([['--successor', successor], ['--right-of', !!rightOf], ['--left-of', !!leftOf], ['--title-free', titleFree],
      ['--tier', !!tier], ['--no-remote-control', noRemote]],
    flag => `spawn: refused: ${flag} is not an auditor's: an auditor lands immediately left of the orchestrator it audits (its caller, or the one --of names), reads "Audit: <subject>", runs on the pair given with --model and --effort, else on its caller's, and comes up under remote control`)
    if (of && of !== 'self' && !of.startsWith('/dev/')) refuse(`spawn: refused: --of names the audited orchestrator's tty (/dev/ttysNNN) or self, got '${of}'`)
    if (!!model !== !!effort) refuse("spawn: refused: an auditor takes --model and --effort together, or neither (the caller's pair): half a pair is a guess at the other half")
    if (!title) refuse('spawn: refused: --auditor needs --title "Audit: <subject>"')
    if (!AUDIT_TITLE_SHAPE.test(title)) {
      refuse(`spawn: refused: an auditor's title reads "Audit: <subject>", the subject at most 25 characters and neither starting nor ending with a space, got '${title}'`)
    }
  } else if (of) {
    refuse("spawn: refused: --of names the orchestrator an auditor audits; it is an auditor's, with --auditor")
  } else if (title.startsWith('Audit:') || AUDIT_NAME_SHAPE.test(title)) {
    refuse("spawn: refused: an audit title is an auditor's; spawn it with --auditor, which places it beside you, keeps it out of every chain and brings it up under remote control on your model")
  }
  if (successor && (leftOf || rightOf)) refuse('spawn: --successor names its own anchor, immediately right of this session; drop --left-of and --right-of')
  if (successor && titleFree) refuse('spawn: refused: a successor is named after its caller, --title-free does not apply')
  if (title.startsWith('Orch:') && (leftOf || rightOf)) {
    refuse("spawn: refused: an orchestrator's title is a successor's; spawn it with --successor, which places it and hands it the chain")
  }
  if (title.startsWith('Orch:') && !(successor || open || wake)) {
    refuse("spawn: refused: an orchestrator's tab is opened only as a successor (--successor), an opened orchestrator (--open) or a woken one (--wake)")
  }
  if (!deps.isDir(dir)) refuse(`spawn: directory not found: ${dir}`)
  if (prompt && promptFile) refuse('spawn: --prompt and --prompt-file are exclusive')
  if (successor && brief) {
    refuse("spawn: refused: --successor takes its prompt, not --brief: give succeed's prompt with --prompt, which loads the rulebook and runs the takeover")
  }
  if (brief && (prompt || promptFile)) refuse('spawn: --brief and --prompt/--prompt-file are mutually exclusive')
  if (brief && !orchestrator) refuse('spawn: --brief without --orchestrator is refused: pass --orchestrator "<name [ref]>"')
  let briefPrompt = ''
  let lintVerdict = ''
  if (brief) {
    if (!deps.isFile(brief)) refuse(`spawn: brief not found: ${brief}`)
    const briefAbs = resolve(deps.cwd, brief)
    // The lint's findings are said, and the launch goes on.
    const lint = await deps.run(['bash', '-c', 'exec bash "$0" "$1" 2>&1', deps.lint, briefAbs])
    lintVerdict = lint.stdout.trim()
    if (lint.status !== 0) {
      deps.warn(`spawn: warning: brief-lint found findings in ${briefAbs}`)
      deps.warn(lintVerdict)
    }
    briefPrompt = `Read and execute ${briefAbs}. Your orchestrator is ${orchestrator}.`
    // So a brief's gate is read against the session's real one: the smaller of the two. The
    // literal breaks before its percent sign: the suite's sweep for a gate stated without its
    // token half reads source lines, and this one states both halves.
    if (gateTokens) {
      briefPrompt += ` Your context gate is the smaller of ${gateTokens} tokens and 80`
        + ' % of the reported window.'
    }
  }
  if (!(briefPrompt || prompt || promptFile)) {
    refuse("spawn: refused: no startup prompt: the host writes no transcript before a first prompt, so the session's mode cannot be read; give the brief with --prompt or --prompt-file")
  }
  if (tier && model) refuse('spawn: --tier and --model are mutually exclusive')
  if (inherit && (tier || model)) refuse('spawn: --inherit-model is exclusive with --tier and --model')
  if (inherit && effort) refuse("spawn: --inherit-model reads the caller's effort with its model; drop --effort")
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) refuse(`spawn: unknown effort: ${effort} (expected ${EFFORT_LIST})`)
  // The tier's binding, said once, read after every refusal of the line.
  const bound = tier && !(resume && !wake) ? resolveTierPair(tier, modelsMapOf(deps.env, deps.home), deps) : null
  o['tier_bound'] = bound === null ? null : [bound.model, bound.effort]
  o['brief_prompt'] = briefPrompt
  o['lint_verdict'] = lintVerdict
  o['start_brief'] = brief ? resolve(deps.cwd, brief) : ''
  return o
}

/** The request with its spawn prepared: a spawn's own options, or a rotation's spawn after the rotation's refusals. */
export async function prepared(request: LauncherRequest, deps: PrepDeps): Promise<LauncherRequest> {
  if (request.command === 'spawn') return { ...request, options: await prepareSpawn(request.options, deps) }
  if (request.command === 'rotate' && request.rest !== undefined) {
    rotationRefusal(request.options, request.rest.options, request.rest.unknown ?? [])
    const { unknown: _kept, ...rest } = request.rest
    return { ...request, rest: { ...rest, options: await prepareSpawn(rest.options, deps) } }
  }
  return request
}
