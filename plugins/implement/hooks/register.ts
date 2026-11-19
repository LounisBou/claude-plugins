// hooks/register.ts
// The hooks module: every hook that holds `$`. The decisions are core.ts's;
// this file reads the repository, the settings and the state it keeps, and
// hands the facts in. Every hook carries a .catch that falls back to what the
// plugin does without the module: the markdown command runs, the skill text
// is read as written, the tool call goes through.
import {
  IDLE, armedBy, guardOf, keptBand, bandOf, bandSegments, codenameOf, doctorText,
  ignoreVerdict, shellActions, markRow, modeOf, nextRow, onTurnEnd, parseState,
  preflightLines, silencesAttribution, skillOf, skillText, stateLine,
  type Band, type Guard, type Snapshot,
} from './core.ts'
import { fieldsOf, reasonOf, type Host, type On, type OnStream } from '../core/host.ts'
import { spawnArgv } from '../core/orchestration.ts'
import { startRetrospective } from './retrospective.ts'
import { candidateLaunchers, headlessArgv, lastLine, reviewerPrompt, reviewerTitle } from './review.ts'

export const TOOL = 'mcp__implement__state'

// What the module reads of the host.
type ImplementHost = Host<'env' | 'fs' | 'process' | 'session' | 'settings' | 'state' | 'tool' | 'ui' | 'clock'>

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

async function git($: ImplementHost, args: string[]): Promise<{ code: number; out: string }> {
  const run = await $.process.run(['git', ...args], { timeoutMs: 10_000 })
  return { code: run.exitCode, out: String(run.stdout ?? '').trim() }
}

async function readText($: ImplementHost, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

// The preflight, scripts/preflight.sh's checks over the merged settings. With
// depsOnly, its --deps-only form: the repository is not looked at.
async function preflight($: ImplementHost, depsOnly = false): Promise<string[]> {
  const enabled = fieldsOf(await $.settings.read())?.['enabledPlugins']
  if (depsOnly) return preflightLines(enabled, null)
  const inside = (await git($, ['rev-parse', '--is-inside-work-tree'])).code === 0
  const branch = inside ? (await git($, ['branch', '--show-current'])).out : ''
  return preflightLines(enabled, { inside, branch })
}

// Everything the skills' derivation blocks compute, read once.
async function snapshot($: ImplementHost, docs?: string): Promise<Snapshot> {
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

async function readGuard($: ImplementHost): Promise<Guard> {
  return guardOf((await $.state.get(GUARD))?.value)
}

async function writeGuard($: ImplementHost, g: Guard): Promise<void> {
  await $.state.set(GUARD, g)
}

// The band follows the phase run: redrawn from the state file after each step.
async function refreshBand($: ImplementHost): Promise<void> {
  try {
    const g = await readGuard($)
    const band: Band | null = g.outer === 'phase' ? bandOf(await snapshot($)) : null
    await $.state.set(BAND, band)
  } catch { /* the band keeps what it drew */ }
}

// The state tool's arguments, as far as it reads them.
type StateCall = { readonly [argument: string]: unknown }

async function serveState($: ImplementHost, e: StateCall): Promise<{ result: string; isError?: true }> {
  const docs = typeof e['docs'] === 'string' ? e['docs'] : undefined
  const action = e['action']
  if (action === 'get') return { result: JSON.stringify(await snapshot($, docs), null, 2) }
  if (action !== 'mark') return { result: `unknown action: ${String(action)}; use get or mark`, isError: true }
  const s = await snapshot($, docs)
  const path = `${s.docs}/IMPLEMENTATION.md`
  const text = await readText($, path)
  if (text === null) return { result: `no IMPLEMENTATION.md under ${s.docs}: run implement:feature first, or pass docs`, isError: true }
  const wanted = String(e['milestone'] ?? 'HEAD').trim() || 'HEAD'
  const milestone = wanted === 'HEAD' ? s.head : wanted
  const phase = e['phase']
  const marked = markRow(text, typeof phase === 'number' ? phase : String(phase), String(e['status'] ?? ''), milestone)
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
async function launchReviewer($: ImplementHost): Promise<string> {
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
  // The review tool knows a review session by this name, in iTerm and headless alike.
  const title = reviewerTitle(codenameOf(branch.out))
  if (launcher !== null) {
    const spawned = await $.process.run(spawnArgv(launcher, { dir: top.out, title, prompt, keepTools: ['mcp__orchestrator__review'] }), { cwd: top.out, timeoutMs: 120_000 })
    const tty = lastLine(spawned.stdout)
    if (spawned.exitCode === 0 && tty.startsWith('/dev/')) return `Reviewer « ${title} » launched in iTerm on ${tty}. Its review record is the ready gate's; nothing more to do here.`
    return `The launcher refused the reviewer (exit ${spawned.exitCode}): ${lastLine(spawned.stderr) || tty || 'no tty printed'}. Nothing was launched another way.`
  }
  const log = `${top.out}/.git/implement-review.log`
  const started = await $.process.run(headlessArgv(prompt, log, title), { cwd: top.out, timeoutMs: 10_000 })
  if (started.exitCode !== 0) return `The headless reviewer did not start (exit ${started.exitCode}): ${lastLine(started.stderr) || 'no output'}.`
  return `Reviewer launched headless (no iTerm launcher here); its report goes to ${log}. Its review record is the ready gate's.`
}

// Whether this session loaded the method's kernel: the skills point at it until it is.
const METHOD_SKILL = 'method:lifecycle'
const method = { isLoaded: false }

// Whether implement:close ran in the turn in progress: its end is where the learning retrospective may start.
const close = { ran: false }

export function register(on: On<ImplementHost> & OnStream<ImplementHost>): void {
  // The state tool, listed from the first turn.
  on('session.start', async ($, e, next) => {
    await $.tool.register(STATE_SPEC)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await writeGuard($, IDLE)
    await $.state.set(BAND, null)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // Answering in place of next skips the engine's permission check, so its
    // verdict is asked first: a rule that denies the tool is honoured.
    const verdict = await $.tool.check({ tool: TOOL, input: { action: e['action'], docs: e['docs'], phase: e['phase'], status: e['status'], milestone: e['milestone'] } })
    if (verdict?.decision === 'deny') return { deny: verdict.reason || 'refused by a permission rule' }
    try {
      const out = await serveState($, e)
      if (e['action'] === 'mark') await refreshBand($)
      return out
    } catch (err) {
      return { result: reasonOf(err), isError: true }
    }
  }).catch(async () => ({ deny: 'the implement state tool failed; derive the state with the bash blocks of the skill' }))

  // /implement:install and /implement:doctor, answered without a model turn.
  // They check the dependency only; the skills check the repository.
  for (const command of ['implement:install', 'implement:doctor']) {
    on('command.run', { command }, async ($) => {
      return { text: doctorText(await preflight($, true)) }
    }).catch(async ($, e, next) => next(e))
  }

  on('command.run', { command: 'implement:review' }, async ($) => ({ text: await launchReviewer($) }))
    .catch(async ($, e, next) => next(e))

  // The preflight ahead of the skill's text, and what the skill arms.
  on('skill.prompt', async ($, e, next) => {
    if (String(e.skill ?? '') === METHOD_SKILL) {
      method.isLoaded = true
      return next(e)
    }
    const skill = skillOf(String(e.skill ?? ''))
    if (skill === null) return next(e)
    await writeGuard($, armedBy(await readGuard($), skill))
    if (skill === 'close') close.ran = true
    const lines = await preflight($)
    const reads = skill === 'phase' || skill === 'check' || skill === 'close'
    const line = lines.length === 0 && reads ? stateLine(await snapshot($)) : null
    if (skill === 'phase') await refreshBand($)
    return { text: skillText(String(e.text ?? ''), lines, line, !method.isLoaded) }
  }).catch(async ($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const aborted = e.isAborted === true || e.reason === 'aborted'
    if (!e.agentId) await writeGuard($, onTurnEnd(await readGuard($), aborted))
    if (!e.agentId && close.ran) {
      close.ran = false
      if (!aborted) await startRetrospective($)
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // The band follows the phase run: redrawn after a commit or a write naming the state file.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const g = await readGuard($)
    const out = await next(e)
    if (g.outer === 'phase' && touchesState(String(e['command'] ?? ''))) await refreshBand($)
    return out
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'] }, async ($, e, next) => {
    const g = await readGuard($)
    const out = await next(e)
    if (g.outer === 'phase' && String(e['file_path'] ?? e['notebook_path'] ?? '').endsWith('IMPLEMENTATION.md')) await refreshBand($)
    return out
  }).catch(($, e, next) => next(e))

  // No commit trailer is asked for while a skill that commits runs.
  on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
    return silencesAttribution(await readGuard($)) ? { text: '' } : next(e)
  }).catch(async ($, e, next) => next(e))

  // The band above the prompt while a phase run is armed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    const g = await readGuard($)
    const band = keptBand((await $.state.get(BAND))?.value)
    if (g.outer !== 'phase' || !band) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const pieces = bandSegments(band, e.props?.bodyColumns ?? 80)
    return Box({
      key: 'implement',
      children: pieces.map((p, i) => Text({ key: `p${i}`, color: p.color, bold: p.bold, dimColor: p.dim, children: [p.text] })),
    })
  }).catch(async ($, e, next) => next(e))
}
