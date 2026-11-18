// hooks/guards.ts
// N4: the walkthrough rules of /norms:check and /norms:learn, enforced on the
// main loop's tool calls while one of those commands is the session's last.
//
// The guards watch, they do not trap. A call a rule would have stopped goes through and leaves one
// escape line in the journal (observe.ts), under the rule's code; only what cannot be undone is
// still refused or asked:
// - a code edit on the command turn or after a pass/discuss answer (check.md 7.3), a CONTRIBUTING.md
//   edit before "add" or after "skip" (learn.md Step 8), a commit message naming the check, the
//   tooling or the TODO list (check.md 7.4), a plain `git push` and a subagent's shell line that
//   writes are noted. Any other words the user types release the edit rule, since check.md treats
//   them as discussion that may well end in "do it this way";
// - a forced or deleting `git push` asks the user, through the host's own question: Allow lets it
//   through, anything else (Deny, nobody there to answer) refuses it. A push the line does not show
//   whole (a variable set before it, `env`, a substitution, xargs, a configuration given with -c)
//   is read as forced. Words in a prompt never grant it: « don't push » holds the word too;
// - a subagent's `rm`, `rmdir`, `unlink` or `find -delete` (or -exec of one), and a line the reader
//   cannot read, stay refused;
// - an interrupted turn ends the mode, and so do /clear and any other slash command the user submits;
// - the mode is armed by the typed command (command.run) or by the main loop's Skill
//   tool call that runs it, which no slash prompt follows: that one also ends at the
//   check's check_done once it wrote its record (a refused call leaves the guards
//   armed). A spawned session (ORCHESTRATOR_SPAWNED) has nobody to walk through, so
//   its Skill call arms nothing; the words of the call never disarm a guard.
// A guard whose own code fails lets the call through: the markdown still states every rule.
// The push question is the exception: when nobody can be asked, the forced push is refused.

import { gitSubcommand, innerLine, readCommands, simpleCommands, stdinLines, unwrapPath, type ShellCommand } from '../core/shell.ts'
import { isSpawned } from '../core/env.ts'
import { fieldsOf, type Host, type Next, type On } from '../core/host.ts'
import { SKILL_MATCHER as CHECK_SKILL_MATCHER } from './check.ts'
import { askAllow, observed, type JournalHost } from './observe.ts'
import { clearMark } from './record.ts'
import { noteEnd } from './findings.ts'

type GuardHost = JournalHost & Host<'state'>

export type Mode = 'check' | 'learn'

// check.md 7.3's answers that are not "fix".
const PASS = ['2', 'pass', 'p', 'skip', 'no', 'next']
const DISCUSS = ['3', 'discuss', 'd', 'why', 'explain', '?']

function answer(text: string): string {
  return text.trim().toLowerCase().replace(/^\*+|\*+$/g, '').replace(/[.!]+$/, '').trim()
}

const isCommand = (text: string) => text.trim().startsWith('/')

/*
 * What a rule of the walkthrough found in a tool call: the stable code the journal holds it under,
 * and the words that said no. Only an irreversible act (a deletion, a forced push) is refused with
 * them; any other lets the call through, and the code is the one line it leaves.
 */
export type Verdict = { readonly code: string; readonly reason: string; readonly irreversible: boolean }

const observe = (code: string, reason: string): Verdict => ({ code, reason, irreversible: false })

export function editDecision(mode: Mode | undefined, lastPrompt: string | undefined, filePath: string): Verdict | null {
  if (!mode || lastPrompt === undefined) return null
  const a = answer(lastPrompt)
  if (mode === 'check') {
    if (isCommand(lastPrompt)) return observe('norms.edit.ungranted', 'norms: no code change before the user answers "fix". Present the report and the first finding, then wait.')
    if (PASS.includes(a) || DISCUSS.includes(a)) {
      return observe('norms.edit.ungranted', `norms: the user answered "${lastPrompt.trim()}", not "fix". No code change for this finding: ${PASS.includes(a) ? 'mark it passed and move on' : 'answer, then re-present the proposal'}.`)
    }
    return null
  }
  if (!/(^|\/)CONTRIBUTING\.md$/.test(filePath)) return null
  if (isCommand(lastPrompt)) return observe('norms.contributing.ungranted', 'norms: no rule is added before the user answers "add". Present the first proposed rule, then wait.')
  if (a === 'skip' || a === 'no' || a === 'pass') return observe('norms.contributing.ungranted', `norms: the user answered "${lastPrompt.trim()}". This rule is not added: move on to the next one.`)
  return null
}

// The review agents a walkthrough launches only read: during one, a subagent's shell line that
// writes is noted, and one that deletes is refused. A reader is a command that reads, redirecting
// nothing but to /dev/null or its own streams.
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'pwd', 'echo', 'printf', 'test', '[', 'true', 'jq', 'diff', 'file', 'stat', 'basename', 'dirname', 'realpath'])
const GIT_READERS = new Set(['diff', 'log', 'show', 'status', 'rev-parse', 'merge-base', 'ls-files', 'blame', 'grep', 'cat-file', 'show-ref', 'describe', 'shortlog', 'name-rev'])
const HARMLESS_REDIRECT = /\d?>>?\s*\/dev\/null|\d?>&\d/g
// The programs that delete a file: what they remove is gone for good.
const DELETERS = new Set(['rm', 'rmdir', 'unlink'])

const READ_INSTEAD = ' Use Read, Grep and Glob, or the <norms-context> block the plugin gave you.'
export const AGENT_DELETE_REFUSAL = 'norms: a review agent never deletes during a walkthrough: no rm, rmdir, unlink or find -delete (find -exec included).' + READ_INSTEAD
export const AGENT_UNREADABLE_REFUSAL = 'norms: this shell line cannot be read, so it is not known not to delete: a review agent splits it into lines that can be.' + READ_INSTEAD

const baseOf = (word: string | undefined): string => (word ?? '').split('/').pop() ?? ''

function reads(argv: readonly string[]): boolean {
  const name = baseOf(argv[0])
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

// A word that runs a deleter, alone or inside a shell string (`sh -c "rm {}"`).
const DELETER_WORD = /(^|[\s;&|(\/])(rm|rmdir|unlink)(\s|$)/

// Whether a command deletes: rm, rmdir and unlink, `find -delete`, and a `find` that executes one of them.
function deletes(argv: readonly string[]): boolean {
  const name = baseOf(argv[0])
  if (DELETERS.has(name)) return true
  if (name !== 'find') return false
  return argv.some(a => a === '-delete') || (argv.some(a => ['-exec', '-execdir', '-ok', '-okdir'].includes(a)) && argv.some(a => DELETER_WORD.test(a)))
}

// Whether a shell reads its commands from its standard input (no -c, no script file), whatever feeds it.
const readsStdin = (shell: ShellCommand): boolean => stdinLines({ ...shell, stdin: ['-'] }).length > 0

// A command name that only an expansion gives (`$x`, `rm$IFS`): the line does not say what runs. A directory
// that is expanded (`"$ROOT/scripts/resolve_base.sh"`) names its program all the same. A word a substitution
// gives is not among the argv, so a command holding one that does not read (`$(echo rm) x`) is read the same way.
const computedName = (word: string | undefined): boolean => /[$`]/.test(baseOf(word))

/*
 * The argv of every command the line runs: a wrapper written with its directory (`/usr/bin/env rm`) and
 * busybox skipped, the line a shell or eval runs from a string read again, and so are the lines a shell
 * is fed on its standard input (`echo 'rm x' | sh`, `sh <<< "rm x"`), at any depth. Throws when the line
 * cannot be read: a brace expansion past its limit, a command named by an expansion, a shell fed by a
 * program whose output the line does not show (`cat f | sh`).
 */
function unwrapped(command: string): string[][] {
  return readCommands(command).flatMap((cmd): string[][] => {
    const past = unwrapPath(cmd.argv).argv
    const argv = baseOf(past[0]) === 'busybox' ? past.slice(1) : past
    if (computedName(argv[0]) || (cmd.substitutions.length > 0 && !reads(argv))) throw new RangeError('a command named by an expansion')
    const inner = innerLine(argv)
    if (inner !== undefined) return unwrapped(inner)
    const shell = { ...cmd, argv }
    const fed = stdinLines(shell)
    if (fed.length === 0 && cmd.piped.length > 0 && readsStdin(shell)) throw new RangeError('a shell fed by a program')
    return [[...argv], ...fed.flatMap(unwrapped)]
  })
}

// The finding for a subagent's shell line during a walkthrough, or null when it only reads. A line
// the reader cannot read is refused: what it hides is not known not to delete.
export function agentBashDecision(mode: Mode | undefined, command: string): Verdict | null {
  if (!mode) return null
  const deleting: Verdict = { code: 'norms.agent.delete', reason: AGENT_DELETE_REFUSAL, irreversible: true }
  const unreadable: Verdict = { code: 'norms.agent.unreadable', reason: AGENT_UNREADABLE_REFUSAL, irreversible: true }
  const writing = observe('norms.agent.write', 'norms: a review agent only reads during a walkthrough: no shell command that writes, no redirection.')
  let argvs: string[][]
  try {
    argvs = simpleCommands(command)
    if (unwrapped(command).some(deletes)) return deleting
  } catch {
    return unreadable
  }
  if (command.replace(HARMLESS_REDIRECT, '').includes('>')) return writing
  return argvs.every(reads) ? null : writing
}

// The options and the words of a push that rewrite nothing on the remote: a plain push.
const PLAIN_PUSH_FLAGS = new Set(['-u', '--set-upstream', '--tags', '--follow-tags', '--no-verify', '-v', '--verbose', '-q', '--quiet', '-n', '--dry-run'])
// A remote, a branch or a `local:remote` refspec: a word that neither forces (`+`) nor deletes (`:remote`, `local:`).
const PLAIN_PUSH_WORD = /^[A-Za-z0-9_][A-Za-z0-9_./@{}^~-]*(:[A-Za-z0-9_][A-Za-z0-9_./@{}^~-]*)?$/
// The wrappers that feed a command words, or an environment, the line does not show.
const HIDING = /^(.*\/)?(env|xargs|parallel)$/
// A variable assigned on the line (`FOO=1 git push`, `export GIT_CONFIG_COUNT=1; git push`): git reads
// GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n and GIT_CONFIG_PARAMETERS, which can turn a
// plain push into a forced one without a word of it on the line.
const ASSIGNMENT = /(^|[\s;&|(){}`'"])[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=|\$\{[A-Za-z_][A-Za-z0-9_]*:?=/

// Whether one `git push` argv is plain: any option or word it cannot vouch for reads as a forced push,
// and so does a configuration given on the line (`git -c remote.origin.push=+HEAD push`).
function isPlainArgv(argv: readonly string[], at: number): boolean {
  if (argv.slice(1, at).some((word) => word === '-c' || word.startsWith('--config'))) return false
  return argv.slice(at + 1).every((word) => (word.startsWith('-') ? PLAIN_PUSH_FLAGS.has(word) : PLAIN_PUSH_WORD.test(word)))
}

/*
 * Each `git push` of the command, as `plain` or not; a command that runs none gives an empty list.
 * core's shell reader: each command of a list or a pipe, wrappers and assignments skipped, `eval`
 * and `sh -c` read again at any depth, and so is what a shell is fed on its standard input
 * (`echo 'git push -f' | sh`), a wrapper written with its directory (`/usr/bin/env git push`)
 * read through. A push whose words or environment the line does not show (a command substitution
 * among them, a variable assigned on the line, `env`, a wrapper such as xargs that feeds it) is not
 * plain. Throws when the line cannot be read.
 */
function pushes(command: string): boolean[] {
  const assigned = ASSIGNMENT.test(command)
  return readCommands(command).flatMap((cmd): boolean[] => {
    const { argv, wrappers } = unwrapPath(cmd.argv)
    const shown = cmd.substitutions.length === 0 && !assigned && ![...cmd.wrappers, ...wrappers].some((wrapper) => HIDING.test(wrapper))
    const inner = innerLine(argv)
    if (inner !== undefined) return pushes(inner).map((plain) => plain && shown)
    // The lines a shell is fed on its standard input are commands of the line.
    const fed = stdinLines({ ...cmd, argv }).flatMap(pushes).map((plain) => plain && shown)
    const at = gitSubcommand(argv)?.at
    if (at === undefined || argv[at] !== 'push') return fed
    return [shown && isPlainArgv(argv, at), ...fed]
  })
}

// How the command pushes: not at all, only plainly, or with a push that may rewrite or delete on the
// remote. A line the reader cannot read is taken for a forced push: the guard asks rather than lets it through.
function pushKind(command: string): 'none' | 'plain' | 'forced' {
  try {
    const all = pushes(command)
    if (all.length === 0) return 'none'
    return all.every(Boolean) ? 'plain' : 'forced'
  } catch {
    return 'forced'
  }
}

export const PUSH_REFUSAL = 'norms: never force-push during a norms walkthrough unless the user allows it when asked. The user pushes; remind them to.'

// The question a forced push during a walkthrough asks the user, or null when no walkthrough guards it
// (no push, or a plain one, which goes through and is only noted). A push is never granted by words in
// a prompt (« I will push later » holds the word): the user answers the host's own question.
export function pushQuestion(mode: Mode | undefined, command: string): string | null {
  if (!mode || pushKind(command) !== 'forced') return null
  return `norms: forced push now, during /norms:${mode}? ${command.trim().slice(0, 200)}`
}

// The finding for a plain push during a walkthrough: noted, never asked.
export function pushDecision(mode: Mode | undefined, command: string): Verdict | null {
  if (!mode || pushKind(command) !== 'plain') return null
  return observe('norms.push.ungranted', 'norms: never push during a norms walkthrough. The user pushes; remind them to.')
}


// What check.md 7.4 forbids in a commit message.
const FORBIDDEN: RegExp[] = [/\bnorms?-[a-z]+(-[a-z]+)*/i, /\bnorms?\b/i, /\bclaude\b/i, /\btodo[- ]list\b/i]

export function commitDecision(mode: Mode | undefined, lastPrompt: string | undefined, command: string): Verdict | null {
  if (mode !== 'check') return null
  const at = command.search(/\bgit(\s+(-C|-c)\s+\S+)*\s+commit\b/)
  if (at < 0) return null
  const tail = command.slice(at)
  for (const re of FORBIDDEN) {
    const m = tail.match(re)
    if (!m) continue
    if (lastPrompt !== undefined && lastPrompt.toLowerCase().includes(m[0].toLowerCase())) continue
    return observe('norms.commit.message', `norms: the commit message must describe the code change only; "${m[0]}" names the check or its tooling. Rewrite it.`)
  }
  return null
}

// The one finding of a Bash call during a walkthrough, or null. A subagent's deletion is found before
// anything else; then a plain push, then what the mode's rule says of the line: a subagent's writes, the
// main loop's commit message.
export function bashDecision(mode: Mode | undefined, lastPrompt: string | undefined, command: string, isAgent: boolean): Verdict | null {
  const agent = isAgent ? agentBashDecision(mode, command) : null
  if (agent?.irreversible) return agent
  return pushDecision(mode, command) ?? agent ?? (isAgent ? null : commitDecision(mode, lastPrompt, command))
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

const pass = <E>(_$: GuardHost, e: E, next: Next<E>): Promise<unknown> => next(e)

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
export async function spawned($: Host<'env'>): Promise<boolean> {
  const value: unknown = await Promise.resolve().then(() => $.env.get('ORCHESTRATOR_SPAWNED')).catch(() => undefined)
  return isSpawned(typeof value === 'string' ? value : undefined)
}

export function register(on: On<GuardHost>): void {
  for (const [command, armed] of Object.entries(MODES)) {
    on('command.run', { command }, async (_$, e, next) => {
      mode = armed
      lastPrompt = `/${command} ${String(e['args'] ?? '')}`.trim()
      viaSkill = false
      return next(e)
    }).catch(pass)
  }

  // Run by a session through the Skill tool: the host runs no command.run, so the mode is
  // armed at the tool call, for the main loop only.
  for (const [matcher, armed] of [[CHECK_SKILL_MATCHER, 'check'], [LEARN_SKILL_MATCHER, 'learn']] as const) {
    on('tool.call', matcher, async ($, e, next) => {
      if (e['agentId'] || await spawned($)) return next(e)
      mode = armed
      lastPrompt = `/norms:${armed} ${String(e['args'] ?? '')}`.trim()
      viaSkill = true
      return next(e)
    }).catch(pass)
  }

  // Any other command ends the mode: its slash prompt follows its command.run.
  on('prompt.submit', async (_$, e, next) => {
    const text = String(e['text'] ?? '')
    const command = promptCommand(text)
    if (command !== undefined && !command.startsWith('norms:')) resetGuards()
    if (USER_ORIGINS.includes(String(fieldsOf(e['origin'])?.['kind']))) lastPrompt = text
    return next(e)
  }).catch(pass)

  // The module's one turn.complete hook. A subagent's turn: a norms agent the host ran in the
  // background may have ended there without handing its report back (findings.ts).
  on('turn.complete', async (_$, e, next) => {
    if (e['agentId']) noteEnd(String(e['agentId']), String(e['reason'] ?? ''), String(e['answer'] ?? ''))
    else if (e['isAborted']) resetGuards()
    return next(e)
  }).catch(pass)

  // The module's one session.end hook: the host refuses a second one without a matcher.
  on('session.end', async ($, e, next) => {
    resetGuards()
    await clearMark($)
    return next(e)
  }).catch(pass)

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (e['agentId']) return next(e)
      const verdict = editDecision(mode, lastPrompt, String(e['file_path'] ?? e['notebook_path'] ?? ''))
      if (verdict) await observed($, verdict.code)
      return next(e)
    }).catch(pass)
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e['command'] ?? '')
    const verdict = bashDecision(mode, lastPrompt, command, Boolean(e['agentId']))
    // A deletion is refused before the user is asked about a push on the same line: the answer would change nothing.
    if (verdict?.irreversible) return { deny: verdict.reason }
    const question = pushQuestion(mode, command)
    // Only the user's own Allow lets the push through: a Deny, or nobody there to answer, refuses it.
    if (question && (await askAllow($, 'push', question)) !== true) return { deny: PUSH_REFUSAL }
    if (verdict) await observed($, verdict.code)
    return next(e)
  }).catch(pass)
}
