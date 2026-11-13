// hooks/core.ts
// The pure half of the hooks module: the state file's parser and writer, the
// preflight's verdict, the ignore guard's verdict, the shell reader the guards
// judge Bash lines with, and every guard decision. Nothing here touches `$`:
// register.ts reads the world and hands the facts in.

export const REQUIRED_PLUGINS = ['superpowers@claude-plugins-official'] as const

// The five skills by their short name, and the spelling the engine gives them.
export const SKILLS = ['feature', 'phase', 'check', 'close', 'prepare'] as const
export type SkillName = typeof SKILLS[number]

export function skillOf(key: string): SkillName | null {
  const short = key.startsWith('implement:') ? key.slice('implement:'.length) : ''
  return (SKILLS as readonly string[]).includes(short) ? short as SkillName : null
}

// ── The state file ───────────────────────────────────────────────────────────

// The method's state-file format, owned by the method plugin and parsed in core.
export { markRow, nextRow, parseState, twoDigits, ROW_STATUSES as STATUSES, type Row, type State } from '../core/method.ts'
import type { Row, State } from '../core/method.ts'
import { gitSubcommand, redirectsToFile, simpleCommands } from '../core/shell.ts'

// ── The branch, the mode, the ignore guard ───────────────────────────────────

// `${BRANCH#*/}`: everything after the first slash, the whole name without one.
export function codenameOf(branch: string): string {
  const slash = branch.indexOf('/')
  return slash < 0 ? branch : branch.slice(slash + 1)
}

// The skills' one-liner: `artifacts` from .implement.json, `local` when the
// file is absent. Only `committed` changes anything, so any other value reads
// as local, exactly as the skills' `[ "$MODE" = committed ]` reads it.
export function modeOf(implementJson: string | null): 'local' | 'committed' {
  if (implementJson === null) return 'local'
  try {
    const parsed = JSON.parse(implementJson)
    return parsed && typeof parsed === 'object' && parsed.artifacts === 'committed' ? 'committed' : 'local'
  } catch {
    return 'local'
  }
}

export const LOCAL_NOT_IGNORED = 'docs/features and ROADMAP.md must be ignored in local mode: add them to the excludes, or set artifacts to committed in .implement.json'
export const COMMITTED_IGNORED = 'docs/features and ROADMAP.md must not be ignored in committed mode'
export const GUARD_SKIPPED = 'artifacts path given, ignore guard skipped'

// The skills' guard block, verbatim: an explicit path skips it, committed mode
// inverts it, local mode wants both paths ignored. `ok` when it passes.
export function ignoreVerdict(mode: 'local' | 'committed', docsGiven: boolean, docsIgnored: boolean, roadmapIgnored: boolean): string {
  if (docsGiven) return GUARD_SKIPPED
  if (mode === 'committed') return docsIgnored || roadmapIgnored ? COMMITTED_IGNORED : 'ok'
  return !docsIgnored || !roadmapIgnored ? LOCAL_NOT_IGNORED : 'ok'
}

// ── The preflight ────────────────────────────────────────────────────────────

// scripts/preflight.sh's two checks and its exact lines: every required plugin
// set to true in the merged enabledPlugins, then a repository on a branch. A
// null repo is --deps-only: install and doctor need nothing from the project.
export function preflightLines(enabledPlugins: unknown, repo: { inside: boolean; branch: string } | null): string[] {
  const enabled = enabledPlugins && typeof enabledPlugins === 'object' ? enabledPlugins as Record<string, unknown> : {}
  const lines: string[] = []
  for (const dep of REQUIRED_PLUGINS) {
    if (enabled[dep] === true) continue
    lines.push(`error: required plugin not installed or not enabled: ${dep}`)
    lines.push(`fix:   /plugin install ${dep}   then enable it in /plugin`)
  }
  if (lines.length > 0 || repo === null) return lines
  if (!repo.inside || repo.branch === '') {
    return ['error: not a git repository with a current branch', 'fix:   run this from inside a git repository, on a branch']
  }
  return []
}

// What /implement:install and /implement:doctor print.
export function doctorText(lines: readonly string[]): string {
  if (lines.length > 0) return lines.join('\n')
  return `ready: ${REQUIRED_PLUGINS.join(', ')} enabled`
}

export const PREFLIGHT_PASSED = 'Preflight: passed'

// The skill text as the model reads it: the stop when the preflight failed, the
// verdict and the derived state ahead of the skill's own text when it passed.
// The line that sends the session to the method once: the lifecycle, done, the report and
// question formats are the method plugin's, loaded as its own skill, never restated here.
export const METHOD_LINE = 'The method governs this skill: load the `method:lifecycle` skill once, now, before going on.'

export function skillText(original: string, lines: readonly string[], stateLine: string | null, needsMethod = false): string {
  if (lines.length > 0) {
    return [
      'Preflight: failed, so this skill does not run. Print these lines to the user verbatim and do nothing else:',
      '',
      ...lines,
    ].join('\n')
  }
  const header = [`${PREFLIGHT_PASSED}, checked before this text was loaded: do not run scripts/preflight.sh.`]
  if (stateLine) header.push(stateLine)
  if (needsMethod) header.push(METHOD_LINE)
  return `${header.join('\n')}\n\n${original}`
}

export type Snapshot = {
  branch: string
  codename: string
  docs: string
  mode: 'local' | 'committed'
  guard: string
  head: string
  clean: boolean
  stateFile: 'present' | 'absent'
  state: State | null
  next: Row | null
}

// The state as one line ahead of a skill's text. Derived from the branch: a
// --docs path changes it, and that is the state tool's to answer.
export function stateLine(s: Snapshot): string {
  const parts = [
    `branch ${s.branch}`, `codename ${s.codename}`, `docs ${s.docs}`, `artifacts ${s.mode}`,
    `ignore guard ${s.guard}`, `head ${s.head}`, `tree ${s.clean ? 'clean' : 'dirty'}`,
  ]
  if (s.state) {
    parts.push(`bump ${s.state.bump ?? 'unset'}`, `base ${s.state.base ?? 'unset'}`)
    parts.push(s.next ? `next phase ${s.next.phase} ${s.next.status}${s.next.milestone ? ` (milestone ${s.next.milestone})` : ''}` : 'every phase done')
  } else {
    parts.push(`no IMPLEMENTATION.md under ${s.docs}`)
  }
  return `State, derived from the branch (a --docs path overrides it: ask the state tool with docs): ${parts.join(', ')}.`
}

// ── The shell reader ─────────────────────────────────────────────────────────

// core's reader, the one every plugin reads a command line with: quoting, heredocs, wrappers,
// assignments, and `sh -c` read again. `eval` joins its words into a line read the same way.
export { simpleCommands } from '../core/shell.ts'

// What a command line does that implement:check refuses: stage or commit.
export type Action = 'stage' | 'commit'

function actionsOf(argv: readonly string[], depth: number): Action[] {
  if ((argv[0] ?? '').split('/').pop() === 'eval') return shellActions(argv.slice(1).join(' '), depth + 1)
  const at = gitSubcommand(argv)?.at
  if (at === undefined) return []
  if (argv[at] === 'add') return ['stage']
  if (argv[at] === 'commit') return ['commit']
  return []
}

export function shellActions(command: string, depth = 0): Action[] {
  if (depth > 8) return []
  return simpleCommands(command).flatMap(argv => actionsOf(argv, depth))
}

// ── The guards ───────────────────────────────────────────────────────────────

// What is armed. `outer` is the implement skill last started, and holds until
// another one starts, the conversation ends or is cleared, a turn is aborted or
// the user releases it: a phase stopped on a question resumes on the next
// prompt under the same rules. `checking` is implement:check's own, and ends
// with its verdict, its turn, or the user's words. `typed` is the user's last
// prompt.
export type Guard = { outer: 'feature' | 'prepare' | 'phase' | 'close' | null; checking: boolean; typed: string }
export const IDLE: Guard = { outer: null, checking: false, typed: '' }

// The user's last prompt is kept across the start: a prompt that asks for a
// subagent and names the skill in one breath arms the skill after it was read,
// and the subagent guard still finds the request.
export function armedBy(g: Guard, skill: SkillName): Guard {
  if (skill === 'check') return { ...g, checking: true }
  return { outer: skill, checking: false, typed: g.typed }
}

// The origins a person types from: the terminal, the remote bridge, and the
// caller of a headless run. A notification, a peer and a plugin are not them.
export function typedByUser(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

// The user's words end a check in flight, unless the words are the slash
// command that started it.
export function onTyped(g: Guard, text: string): Guard {
  return { ...g, typed: text, checking: g.checking && text.trimStart().startsWith('/') }
}

// An interrupted turn releases everything; any other end of a turn ends the
// check, which is a one-turn skill.
export function onTurnEnd(g: Guard, aborted: boolean): Guard {
  return aborted ? IDLE : { ...g, checking: false }
}

const VERDICT_TABLE = /^\| *check *\| *evidence *\| *result *\|/m
const VERDICT_LINE = /^(PASS|FAIL: *[0-9][0-9, ]*)[ \t]*$/m

// implement:check is over once its table and its verdict line are written.
export function isVerdict(answer: string): boolean {
  return VERDICT_TABLE.test(answer) && VERDICT_LINE.test(answer)
}

const LABEL: Record<Action, string> = { 'stage': 'git add', 'commit': 'git commit' }
const RELEASE = 'Words in a prompt release nothing: a subagent runs when the user allows it when asked, and /implement:release-guard releases every guard.'
// An orchestrated build has no operator to ask: the orchestrator decides.
const RELEASE_BY_ORCHESTRATOR = 'Words in a prompt release nothing: your orchestrator decides, not the operator. Name the need to it, last line status: question, and wait; it allows by releasing the guard with /implement:release-guard.'

export function checkDeny(what: string): string {
  return `implement:check edits, stages and commits nothing: ${what} refused by the implement plugin. Name the defect as a FAIL row; the repair belongs to the caller once the verdict line (PASS, or FAIL: <rows>) is written under the table. ${RELEASE}`
}
export function agentDeny(type: string, isOrchestrated = false): string {
  return `implement:phase writes the work itself: a subagent only searches (subagent_type Explore). ${type} refused by the implement plugin: do the work inline, or name the need and wait. ${isOrchestrated ? RELEASE_BY_ORCHESTRATOR : RELEASE}`
}

export const READ_ONLY_AGENTS = new Set(['Explore'])

// The commands of a line that write into the tree implement:check reads: a file removed,
// moved, copied over, created, or edited in place.
const WRITERS = new Set(['tee', 'rm', 'mv', 'cp', 'touch', 'truncate', 'ln', 'install', 'dd', 'patch', 'rmdir'])

function writesTree(argv: readonly string[]): string | null {
  const name = (argv[0] ?? '').split('/').pop() ?? ''
  if (WRITERS.has(name)) return name
  if ((name === 'sed' || name === 'perl') && argv.some(a => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) return `${name} -i`
  return null
}

export function bashDecision(g: Guard, command: string): string | null {
  if (!g.checking) return null
  const write = shellActions(command).find(a => a === 'stage' || a === 'commit')
  if (write) return checkDeny(LABEL[write])
  if (redirectsToFile(command)) return checkDeny('a redirection into a file')
  const writer = simpleCommands(command).map(writesTree).find(w => w !== null)
  return writer ? checkDeny(writer) : null
}

export function agentDecision(g: Guard, subagentType: unknown, isOrchestrated = false): string | null {
  if (g.outer !== 'phase') return null
  const type = typeof subagentType === 'string' && subagentType !== '' ? subagentType : 'general-purpose'
  if (READ_ONLY_AGENTS.has(type)) return null
  return agentDeny(type, isOrchestrated)
}

export function editDecision(g: Guard, tool: string): string | null {
  return g.checking ? checkDeny(tool) : null
}

// The commit trailer the engine asks for: none while a skill that commits runs.
export function silencesAttribution(g: Guard): boolean {
  return g.outer === 'feature' || g.outer === 'phase' || g.outer === 'close'
}

// ── The band ─────────────────────────────────────────────────────────────────

export type Band = { codename: string; phase: string; of: number; status: string; title: string; milestone: string; head: string }

export function bandOf(s: Snapshot): Band | null {
  if (!s.state || s.state.rows.length === 0) return null
  const current = s.next ?? s.state.rows[s.state.rows.length - 1]
  return {
    codename: s.codename, phase: current.phase, of: s.state.rows.length, status: current.status,
    title: current.title, milestone: current.milestone, head: s.head,
  }
}

export type BandPiece = { text: string; color?: 'warning' | 'success'; bold?: boolean; dim?: boolean }

// The band as styled pieces, the phase title shortened first when the line exceeds the columns,
// then `base` dropped whole to keep the sha, and only then the end of the line.
export function bandSegments(b: Band, columns: number): BandPiece[] {
  const total = String(b.of).padStart(2, '0')
  const build = (title: string, withBase = true): BandPiece[] => {
    const out: BandPiece[] = [{ text: `implement:phase ${b.codename}`, bold: true }]
    if (b.status === 'done') out.push({ text: ' · ' }, { text: `all ${total} phases done, implement:close is next`, color: 'success' })
    else {
      const color = b.status === 'doing' ? 'warning' : undefined
      out.push({ text: ` · phase ${b.phase}/${total} ` }, color ? { text: b.status, color } : { text: b.status }, { text: `: ${title}` })
      if (b.milestone && withBase) out.push({ text: ` · base ${b.milestone}` })
    }
    out.push({ text: ' · ' }, { text: `head ${b.head}`, dim: true })
    return out
  }
  const merge = (ps: BandPiece[]): BandPiece[] => ps.reduce<BandPiece[]>((acc, p) => {
    const last = acc[acc.length - 1]
    if (last && last.color === p.color && last.bold === p.bold && last.dim === p.dim) last.text += p.text
    else acc.push({ ...p })
    return acc
  }, [])
  const length = (ps: BandPiece[]) => ps.reduce((n, p) => n + p.text.length, 0)
  const shorten = (withBase: boolean): BandPiece[] => {
    const full = merge(build(b.title, withBase))
    if (length(full) <= columns) return full
    const keep = Math.max(0, b.title.length - (length(full) - columns) - 1)
    return merge(build(`${b.title.slice(0, keep)}…`, withBase))
  }
  let pieces = merge(build(b.title))
  if (length(pieces) > columns && b.status !== 'done') {
    pieces = shorten(true)
    if (length(pieces) > columns) pieces = shorten(false)
  }
  if (length(pieces) <= columns) return pieces
  let room = Math.max(1, columns - 1)
  const cut: BandPiece[] = []
  for (const p of pieces) {
    if (room <= 0) break
    cut.push({ ...p, text: p.text.slice(0, room) })
    room -= p.text.length
  }
  cut[cut.length - 1].text += '…'
  return cut
}

export function bandLine(b: Band, columns: number): string {
  return bandSegments(b, columns).map(p => p.text).join('')
}
