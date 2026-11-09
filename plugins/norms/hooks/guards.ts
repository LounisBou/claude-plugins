// hooks/guards.ts
// N4: the walkthrough rules of /norms:check and /norms:learn, enforced on the
// main loop's tool calls while one of those commands is the session's last.
//
// The guards are narrow on purpose, so they never trap the user:
// - a code edit is refused only when the user's last words are the command
//   itself or a pass/discuss answer (check.md 7.3), and a CONTRIBUTING.md edit
//   only when they are the command itself or "skip" (learn.md Step 8). Any
//   other words the user types release the edit guard, since check.md treats
//   them as discussion that may well end in "do it this way";
// - `git push` asks the user, through the host's own question: Allow lets it
//   through, anything else (Deny, nobody there to answer) refuses it. Words in
//   a prompt never grant it: « don't push » holds the word too;
// - under /norms:check, a commit message naming the check, the tooling or the
//   TODO list is refused unless the user's last words use that word;
// - an interrupted turn ends the mode, and so do /clear and any other slash
//   command the user submits;
// - the mode is armed by the typed command (command.run) or by the main loop's Skill
//   tool call that runs it, which no slash prompt follows: that one also ends at the
//   check's check_done once it wrote its record (a refused call leaves the guards
//   armed). A spawned session (ORCHESTRATOR_SPAWNED) has nobody to walk through, so
//   its Skill call arms nothing; the words of the call never disarm a guard.
// A guard whose own code fails lets the call through: the markdown still states every rule.
// The push guard is the exception: when nobody can be asked, the push is refused.

import { gitSubcommand, simpleCommands } from '../core/shell.ts'
import { isSpawned } from '../core/env.ts'
import { SKILL_MATCHER as CHECK_SKILL_MATCHER } from './check.ts'
import { clearMark } from './record.ts'

export type Mode = 'check' | 'learn'

// check.md 7.3's answers that are not "fix".
const PASS = ['2', 'pass', 'p', 'skip', 'no', 'next']
const DISCUSS = ['3', 'discuss', 'd', 'why', 'explain', '?']

function answer(text: string): string {
  return text.trim().toLowerCase().replace(/^\*+|\*+$/g, '').replace(/[.!]+$/, '').trim()
}

const isCommand = (text: string) => text.trim().startsWith('/')

export function editDecision(mode: Mode | undefined, lastPrompt: string | undefined, filePath: string): string | null {
  if (!mode || lastPrompt === undefined) return null
  const a = answer(lastPrompt)
  if (mode === 'check') {
    if (isCommand(lastPrompt)) return 'norms: no code change before the user answers "fix". Present the report and the first finding, then wait.'
    if (PASS.includes(a) || DISCUSS.includes(a)) {
      return `norms: the user answered "${lastPrompt.trim()}", not "fix". No code change for this finding: ${PASS.includes(a) ? 'mark it passed and move on' : 'answer, then re-present the proposal'}.`
    }
    return null
  }
  if (!/(^|\/)CONTRIBUTING\.md$/.test(filePath)) return null
  if (isCommand(lastPrompt)) return 'norms: no rule is added before the user answers "add". Present the first proposed rule, then wait.'
  if (a === 'skip' || a === 'no' || a === 'pass') return `norms: the user answered "${lastPrompt.trim()}". This rule is not added: move on to the next one.`
  return null
}

// The review agents a walkthrough launches only read: during one, a subagent's shell line must
// be made of commands that read, and redirect nothing but to /dev/null or its own streams.
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'pwd', 'echo', 'printf', 'test', '[', 'true', 'jq', 'diff', 'file', 'stat', 'basename', 'dirname', 'realpath'])
const GIT_READERS = new Set(['diff', 'log', 'show', 'status', 'rev-parse', 'merge-base', 'ls-files', 'blame', 'grep', 'cat-file', 'show-ref', 'describe', 'shortlog', 'name-rev'])
const HARMLESS_REDIRECT = /\d?>>?\s*\/dev\/null|\d?>&\d/g

export const AGENT_WRITE_REFUSAL = 'norms: a review agent only reads during a walkthrough: no shell command that writes, no redirection.'
  + ' Use Read, Grep and Glob, or the <norms-context> block the plugin gave you.'

function reads(argv: readonly string[]): boolean {
  const name = (argv[0] ?? '').split('/').pop() ?? ''
  if (name === 'resolve_base.sh') return true
  if (name === 'git' || /(^|\/)git$/.test(argv[0] ?? '')) {
    const at = gitSubcommand(argv)?.at
    const sub = at === undefined ? '' : argv[at] ?? ''
    if (sub === 'branch') return argv.slice(at! + 1).every(a => a === '--show-current' || a === '--list' || a === '-a' || a === '-r')
    return GIT_READERS.has(sub)
  }
  if (name === 'sed') return !argv.some(a => a === '-i' || a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place='))
  if (name === 'find') return !argv.some(a => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok' || a === '-fprint')
  return READERS.has(name)
}

// The refusal for a subagent's shell line during a walkthrough, or null when it only reads.
export function agentBashDecision(mode: Mode | undefined, command: string): string | null {
  if (!mode) return null
  if (command.replace(HARMLESS_REDIRECT, '').includes('>')) return AGENT_WRITE_REFUSAL
  return simpleCommands(command).every(reads) ? null : AGENT_WRITE_REFUSAL
}

const PUSH = /(^|[\s;&|(])git(\s+(-C|-c)\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+push(\s|$)/

export const PUSH_REFUSAL = 'norms: never push during a norms walkthrough unless the user allows it when asked. The user pushes; remind them to.'

// The question a push during a walkthrough asks the user, or null when no walkthrough guards it.
export function pushQuestion(mode: Mode | undefined, command: string): string | null {
  if (!mode || !PUSH.test(command)) return null
  return `norms: push now, during /norms:${mode}? ${command.trim().slice(0, 200)}`
}

// Whether the user allows the push: only their own Allow does; a failure to ask refuses.
async function userAllows($: any, question: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, ['Allow', 'Deny'])) === 'Allow'
  } catch {
    return false
  }
}

// What check.md 7.4 forbids in a commit message.
const FORBIDDEN: RegExp[] = [/\bnorms?-[a-z]+(-[a-z]+)*/i, /\bnorms?\b/i, /\bclaude\b/i, /\btodo[- ]list\b/i]

export function commitDecision(mode: Mode | undefined, lastPrompt: string | undefined, command: string): string | null {
  if (mode !== 'check') return null
  const at = command.search(/\bgit(\s+(-C|-c)\s+\S+)*\s+commit\b/)
  if (at < 0) return null
  const tail = command.slice(at)
  for (const re of FORBIDDEN) {
    const m = tail.match(re)
    if (!m) continue
    if (lastPrompt !== undefined && lastPrompt.toLowerCase().includes(m[0].toLowerCase())) continue
    return `norms: the commit message must describe the code change only; "${m[0]}" names the check or its tooling. Rewrite it.`
  }
  return null
}

// The user's own words: typed, from the remote bridge, or a headless prompt.
const USER_ORIGINS = ['composer', 'bridge', 'sdk']

let mode: Mode | undefined
let lastPrompt: string | undefined
// The mode was armed by a Skill tool call, which no slash prompt follows: it ends at the
// check's last act too.
let viaSkill = false

export function resetGuards(): void {
  mode = undefined
  lastPrompt = undefined
  viaSkill = false
}

export function guardState(): { mode: Mode | undefined; lastPrompt: string | undefined } {
  return { mode, lastPrompt }
}

// The check's last act, once its record is written (hooks/record.ts calls it from the
// check_done tool, which answers the call itself, so no hook stands before it), ends the
// mode no slash prompt will end: the one a Skill tool call armed.
export function endSkillCheck(): void {
  if (viaSkill && mode === 'check') resetGuards()
}

const pass = ($: any, e: any, next: any) => next(e)

// The commands that arm a mode. Only these are hooked: a command.run hook with no
// matcher sits in every command's chain, and the host then names norms beside
// the plugin that owns the command.
const MODES: Record<string, Mode> = { 'norms:check': 'check', 'norms:learn': 'learn' }

// The command a typed slash prompt names, without its slash; undefined for words.
export function promptCommand(text: string): string | undefined {
  const m = text.trim().match(/^\/([\w:.-]+)(\s|$)/)
  return m ? m[1] : undefined
}

// The Skill tool calls that run a norms command. The check's own matcher is reused;
// /norms:learn has the same shape.
const LEARN_SKILL_MATCHER = { tool: 'Skill', skill: /^\/?norms:learn$/ }

// Whether the session was spawned, so nobody types in it. An unreadable variable is no
// variable: the guards arm.
async function spawned($: any): Promise<boolean> {
  const value: unknown = await Promise.resolve().then(() => $.env.get('ORCHESTRATOR_SPAWNED')).catch(() => undefined)
  return isSpawned(typeof value === 'string' ? value : undefined)
}

export function register(on: any): void {
  for (const [command, armed] of Object.entries(MODES)) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      mode = armed
      lastPrompt = `/${command} ${String(e.args ?? '')}`.trim()
      viaSkill = false
      return next(e)
    }).catch(pass)
  }

  // Run by a session through the Skill tool: the host runs no command.run, so the mode is
  // armed at the tool call, for the main loop only.
  for (const [matcher, armed] of [[CHECK_SKILL_MATCHER, 'check'], [LEARN_SKILL_MATCHER, 'learn']] as const) {
    on('tool.call', matcher, async ($: any, e: any, next: any) => {
      if (e.agentId || await spawned($)) return next(e)
      mode = armed
      lastPrompt = `/norms:${armed} ${String(e.args ?? '')}`.trim()
      viaSkill = true
      return next(e)
    }).catch(pass)
  }

  // Any other command ends the mode: its slash prompt follows its command.run.
  on('prompt.submit', async ($: any, e: any, next: any) => {
    const text = String(e.text ?? '')
    const command = promptCommand(text)
    if (command !== undefined && !command.startsWith('norms:')) resetGuards()
    if (USER_ORIGINS.includes(String(e.origin?.kind))) lastPrompt = text
    return next(e)
  }).catch(pass)

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (!e.agentId && e.isAborted) resetGuards()
    return next(e)
  }).catch(pass)

  // The module's one session.end hook: the host refuses a second one without a matcher.
  on('session.end', async ($: any, e: any, next: any) => {
    resetGuards()
    await clearMark($)
    return next(e)
  }).catch(pass)

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($: any, e: any, next: any) => {
      if (e.agentId) return next(e)
      const deny = editDecision(mode, lastPrompt, String(e.file_path ?? e.notebook_path ?? ''))
      return deny ? { deny } : next(e)
    }).catch(pass)
  }

  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const command = String(e.command ?? '')
    const question = pushQuestion(mode, command)
    if (question && !(await userAllows($, question))) return { deny: PUSH_REFUSAL }
    const deny = e.agentId ? agentBashDecision(mode, command) : commitDecision(mode, lastPrompt, command)
    return deny ? { deny } : next(e)
  }).catch(pass)
}
