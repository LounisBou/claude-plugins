// hooks/register.ts
// The hooks module: every hook that holds `$`. The decisions are core.ts's;
// this file reads the repository, the settings and the state it keeps, and
// hands the facts in. Every hook carries a .catch that falls back to what the
// plugin does without the module: the markdown command runs, the skill text
// is read as written, the tool call goes through.
import {
  IDLE, armedBy, agentDecision, bandOf, bandSegments, bashDecision, codenameOf, doctorText, editDecision,
  ignoreVerdict, shellActions, isVerdict, markRow, modeOf, nextRow, onTurnEnd, onTyped, parseState,
  preflightLines, silencesAttribution, skillOf, skillText, stateLine, typedByUser,
  type Band, type Guard, type Snapshot,
} from './core.ts'
import { isSpawned } from '../core/env.ts'
import { candidateLaunchers, headlessArgv, lastLine, reviewerPrompt, reviewerTitle } from './review.ts'

export const TOOL = 'mcp__implement__state'

// The values the host keeps for this plugin, read by the band as it draws.
const GUARD = { plugin: 'implement', key: 'guard' } as const
const BAND = { plugin: 'implement', key: 'band' } as const

const STATE_SPEC = {
  name: 'state',
  description: [
    "The implement skills' state in one call, in place of the bash blocks that derive it.",
    'action "get": branch, codename, docs path, artifacts mode, ignore-guard verdict ("ok" or the stop to print),',
    'head, whether the tree is clean, and the parsed IMPLEMENTATION.md (header, rows, next phase).',
    'Pass "docs" when the skill was given --docs <path>.',
    'action "mark": writes one row of the state table: "phase" (its number), "status" (todo, doing or done)',
    'and "milestone" ("HEAD", the default, or a sha); a todo row leaves the milestone empty.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'mark'] },
      docs: { type: 'string', description: 'the feature directory given with --docs; omitted, docs/features/<codename>' },
      phase: { type: ['string', 'number'], description: 'mark: the row, by its phase number' },
      status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'mark: the new status' },
      milestone: { type: 'string', description: 'mark: "HEAD" (the default) or a commit sha' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

async function git($: any, args: string[]): Promise<{ code: number; out: string }> {
  const run = await $.process.run(['git', ...args], { timeoutMs: 10_000 })
  return { code: run.exitCode, out: String(run.stdout ?? '').trim() }
}

// Whether the orchestrator spawned this session, so no operator answers in it. An unreadable
// variable is no variable: the operator is asked.
async function spawned($: any): Promise<boolean> {
  const value: unknown = await Promise.resolve().then(() => $.env.get('ORCHESTRATOR_SPAWNED')).catch(() => undefined)
  return isSpawned(typeof value === 'string' ? value : undefined)
}

async function readText($: any, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

// The preflight, scripts/preflight.sh's checks over the merged settings. With
// depsOnly, its --deps-only form: the repository is not looked at.
async function preflight($: any, depsOnly = false): Promise<string[]> {
  const settings = await $.settings.read()
  if (depsOnly) return preflightLines(settings?.enabledPlugins, null)
  const inside = (await git($, ['rev-parse', '--is-inside-work-tree'])).code === 0
  const branch = inside ? (await git($, ['branch', '--show-current'])).out : ''
  return preflightLines(settings?.enabledPlugins, { inside, branch })
}

// Everything the skills' derivation blocks compute, read once.
async function snapshot($: any, docs?: string): Promise<Snapshot> {
  const branch = (await git($, ['branch', '--show-current'])).out
  const codename = codenameOf(branch)
  const given = typeof docs === 'string' && docs.trim() !== ''
  const dir = given ? docs!.trim().replace(/\/+$/, '') : `docs/features/${codename}`
  const mode = modeOf(await readText($, '.implement.json'))
  const guard = given
    ? ignoreVerdict(mode, true, false, false)
    : ignoreVerdict(mode, false,
      (await git($, ['check-ignore', '-q', 'docs/features/probe'])).code === 0,
      (await git($, ['check-ignore', '-q', 'ROADMAP.md'])).code === 0)
  const head = (await git($, ['rev-parse', '--short', 'HEAD'])).out
  const clean = (await git($, ['status', '--porcelain'])).out === ''
  const text = await readText($, `${dir}/IMPLEMENTATION.md`)
  const state = text === null ? null : parseState(text)
  return {
    branch, codename, docs: dir, mode, guard, head, clean,
    stateFile: text === null ? 'absent' : 'present', state, next: state ? nextRow(state.rows) : null,
  }
}

async function readGuard($: any): Promise<Guard> {
  const { value } = await $.state.get(GUARD)
  return value && typeof value === 'object' ? { ...IDLE, ...value } : IDLE
}

async function writeGuard($: any, g: Guard): Promise<void> {
  await $.state.set(GUARD, g)
}

// The band follows the phase run: redrawn from the state file after each step.
async function refreshBand($: any): Promise<void> {
  try {
    const g = await readGuard($)
    const band: Band | null = g.outer === 'phase' ? bandOf(await snapshot($)) : null
    await $.state.set(BAND, band)
  } catch { /* the band keeps what it drew */ }
}

async function serveState($: any, e: any): Promise<{ result: string; isError?: true }> {
  if (e.action === 'get') return { result: JSON.stringify(await snapshot($, e.docs), null, 2) }
  if (e.action !== 'mark') return { result: `unknown action: ${e.action}; use get or mark`, isError: true }
  if ((await readGuard($)).checking) return { result: 'implement:check edits nothing: mark refused until its verdict line is written', isError: true }
  const s = await snapshot($, e.docs)
  const path = `${s.docs}/IMPLEMENTATION.md`
  const text = await readText($, path)
  if (text === null) return { result: `no IMPLEMENTATION.md under ${s.docs}: run implement:feature first, or pass docs`, isError: true }
  const wanted = String(e.milestone ?? 'HEAD').trim() || 'HEAD'
  const milestone = wanted === 'HEAD' ? s.head : wanted
  const marked = markRow(text, e.phase, String(e.status ?? ''), milestone)
  if ('error' in marked) return { result: marked.error, isError: true }
  await $.fs.write(path, marked.text)
  const next = nextRow(parseState(marked.text).rows)
  return { result: JSON.stringify({ path, row: marked.row, next }, null, 2) }
}

// A Bash line after which the band has something new to draw: a commit, or a
// write naming the state file.
function touchesState(command: string): boolean {
  return shellActions(command).includes('commit') || command.includes('IMPLEMENTATION.md')
}

// /implement:review: the reviewer launched as another session, in iTerm when the orchestrator's
// launcher is installed on macOS, headless otherwise. Never the implementer's own review.
async function launchReviewer($: any): Promise<string> {
  const branch = await git($, ['branch', '--show-current'])
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (branch.code !== 0 || !branch.out || top.code !== 0) return 'implement:review needs a git repository on a branch: nothing was launched.'
  const prompt = reviewerPrompt(branch.out)
  const config = String((await $.env.get('CLAUDE_CONFIG_DIR')) || `${String((await $.env.get('HOME')) ?? '')}/.claude`)
  const uname = await $.process.run(['uname', '-s'], { timeoutMs: 10_000 })
  let launcher: string | null = null
  if (String(uname.stdout ?? '').trim() === 'Darwin') {
    const record = await readText($, `${config}/plugins/installed_plugins.json`)
    for (const path of record === null ? [] : candidateLaunchers(record)) {
      if (await $.fs.exists(path)) {
        launcher = path
        break
      }
    }
  }
  if (launcher !== null) {
    const title = reviewerTitle(codenameOf(branch.out))
    const spawned = await $.process.run([launcher, 'spawn', '--dir', top.out, '--title', title, '--prompt', prompt], { cwd: top.out, timeoutMs: 120_000 })
    const tty = lastLine(spawned.stdout)
    if (spawned.exitCode === 0 && tty.startsWith('/dev/')) return `Reviewer « ${title} » launched in iTerm on ${tty}. Its review record is the ready gate's; nothing more to do here.`
    return `The launcher refused the reviewer (exit ${spawned.exitCode}): ${lastLine(spawned.stderr) || tty || 'no tty printed'}. Nothing was launched another way.`
  }
  const log = `${top.out}/.git/implement-review.log`
  const started = await $.process.run(headlessArgv(prompt, log), { cwd: top.out, timeoutMs: 10_000 })
  if (started.exitCode !== 0) return `The headless reviewer did not start (exit ${started.exitCode}): ${lastLine(started.stderr) || 'no output'}.`
  return `Reviewer launched headless (no iTerm launcher here); its report goes to ${log}. Its review record is the ready gate's.`
}

// Whether this session loaded the method's kernel: the skills point at it until it is.
const METHOD_SKILL = 'method:lifecycle'
const method = { isLoaded: false }

export function register(on: any) {
  // The state tool, listed from the first turn.
  on('session.start', async ($: any, e: any, next: any) => {
    await $.tool.register(STATE_SPEC)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  on('session.end', async ($: any, e: any, next: any) => {
    await writeGuard($, IDLE)
    await $.state.set(BAND, null)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  on('tool.call', { tool: TOOL }, async ($: any, e: any) => {
    // Answering in place of next skips the engine's permission check, so its
    // verdict is asked first: a rule that denies the tool is honoured.
    const verdict = await $.tool.check({ tool: TOOL, input: { action: e.action, docs: e.docs, phase: e.phase, status: e.status, milestone: e.milestone } })
    if (verdict?.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
    try {
      const out = await serveState($, e)
      if (e.action === 'mark') await refreshBand($)
      return out
    } catch (err: any) {
      return { result: String(err?.message ?? err), isError: true }
    }
  }).catch(async () => ({ deny: 'the implement state tool failed; derive the state with the bash blocks of the skill' }))

  // /implement:install and /implement:doctor, answered without a model turn.
  // They check the dependency only; the skills check the repository.
  for (const command of ['implement:install', 'implement:doctor']) {
    on('command.run', { command }, async ($: any) => {
      return { text: doctorText(await preflight($, true)) }
    }).catch(async ($: any, e: any, next: any) => next(e))
  }

  on('command.run', { command: 'implement:review' }, async ($: any) => ({ text: await launchReviewer($) }))
    .catch(async ($: any, e: any, next: any) => next(e))

  on('command.run', { command: 'implement:release-guard' }, async ($: any) => {
    await writeGuard($, IDLE)
    await $.state.set(BAND, null)
    return { text: 'implement: every guard is released until an implement skill starts again.' }
  }).catch(async ($: any, e: any, next: any) => next(e))

  // The preflight ahead of the skill's text, and the guards the skill arms.
  on('skill.prompt', async ($: any, e: any, next: any) => {
    if (String(e.skill ?? '') === METHOD_SKILL) {
      method.isLoaded = true
      return next(e)
    }
    const skill = skillOf(String(e.skill ?? ''))
    if (skill === null) return next(e)
    await writeGuard($, armedBy(await readGuard($), skill))
    const lines = await preflight($)
    const reads = skill === 'phase' || skill === 'check' || skill === 'close'
    const line = lines.length === 0 && reads ? stateLine(await snapshot($)) : null
    if (skill === 'phase') await refreshBand($)
    return { text: skillText(String(e.text ?? ''), lines, line, !method.isLoaded) }
  }).catch(async ($: any, e: any, next: any) => next(e))

  on('prompt.submit', async ($: any, e: any, next: any) => {
    if (typedByUser(String(e.origin?.kind ?? ''))) await writeGuard($, onTyped(await readGuard($), String(e.text ?? '')))
    return next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (!e.agentId) await writeGuard($, onTurnEnd(await readGuard($), e.isAborted === true || e.reason === 'aborted'))
    return next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  // implement:check ends with its verdict, even mid-turn inside a phase run.
  on('turn.step', async function* ($: any, e: any, next: any) {
    const response = yield* next(e)
    try {
      if (!e.agentId && isVerdict(String(response?.answer ?? ''))) {
        const g = await readGuard($)
        if (g.checking) await writeGuard($, { ...g, checking: false })
      }
    } catch { /* the check stays armed until its turn ends */ }
    return response
  })

  // The guards. Each judges before next. A guard that could not read what is
  // armed lets the call through. A failure after next replays what already ran.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const g = await readGuard($)
    const deny = bashDecision(g, String(e.command ?? ''))
    if (deny) return { deny }
    const out = await next(e)
    if (g.outer === 'phase' && touchesState(String(e.command ?? ''))) await refreshBand($)
    return out
  }).catch(($: any, e: any, next: any) => next(e))

  // A subagent that writes, during a phase, runs only on the user's Allow in the host's own
  // dialog: words in a prompt grant nothing, and nobody there to answer refuses it. In a session
  // the orchestrator spawned there is no operator to ask: the refusal sends the question to the
  // orchestrator, whose answer is the guard released.
  on('tool.call', { tool: 'Agent' }, async ($: any, e: any, next: any) => {
    const isOrchestrated = await spawned($)
    const deny = agentDecision(await readGuard($), e.subagent_type, isOrchestrated)
    if (deny === null) return next(e)
    if (isOrchestrated) return { deny }
    let answer: unknown
    try {
      answer = await $.ui.ask(`implement:phase writes the work itself. Let a ${String(e.subagent_type || 'general-purpose')} subagent run?`, ['Allow', 'Deny'])
    } catch {
      answer = undefined
    }
    return answer === 'Allow' ? next(e) : { deny }
  }).catch(($: any, e: any, next: any) => next(e))

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'] }, async ($: any, e: any, next: any) => {
    const g = await readGuard($)
    const deny = editDecision(g, String(e.tool))
    if (deny) return { deny }
    const out = await next(e)
    if (g.outer === 'phase' && String(e.file_path ?? e.notebook_path ?? '').endsWith('IMPLEMENTATION.md')) await refreshBand($)
    return out
  }).catch(($: any, e: any, next: any) => next(e))

  // No commit trailer is asked for while a skill that commits runs.
  on('attribution.text', { kind: 'commit' }, async ($: any, e: any, next: any) => {
    return silencesAttribution(await readGuard($)) ? { text: '' } : next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  // The band above the prompt while a phase run is armed.
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    if (e.props?.hasSurvey) return next(e)
    const g = await readGuard($)
    const { value: band } = await $.state.get(BAND)
    if (g.outer !== 'phase' || !band) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const pieces = bandSegments(band, e.props?.bodyColumns ?? 80)
    return Box({
      key: 'implement',
      children: pieces.map((p, i) => Text({ key: `p${i}`, color: p.color, bold: p.bold, dimColor: p.dim, children: [p.text] })),
    })
  }).catch(async ($: any, e: any, next: any) => next(e))
}
