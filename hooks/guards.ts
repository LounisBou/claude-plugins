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
// - `git push` is refused unless the user's last words say "push";
// - under /norms:check, a commit message naming the check, the tooling or the
//   TODO list is refused unless the user's last words use that word;
// - an interrupted turn ends the mode, and so do /clear and any other slash
//   command the user submits.
// A guard that fails lets the call through: the markdown still states every rule.

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

const PUSH = /(^|[\s;&|(])git(\s+(-C|-c)\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+push(\s|$)/

export function pushDecision(mode: Mode | undefined, lastPrompt: string | undefined, command: string): string | null {
  if (!mode || !PUSH.test(command)) return null
  if (lastPrompt !== undefined && /\bpush/i.test(lastPrompt)) return null
  return 'norms: never push during a norms walkthrough. The user pushes; remind them to.'
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

export function resetGuards(): void {
  mode = undefined
  lastPrompt = undefined
}

export function guardState(): { mode: Mode | undefined; lastPrompt: string | undefined } {
  return { mode, lastPrompt }
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

export function register(on: any): void {
  for (const [command, armed] of Object.entries(MODES)) {
    on('command.run', { command }, async ($: any, e: any, next: any) => {
      mode = armed
      lastPrompt = `/${command} ${String(e.args ?? '')}`.trim()
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

  on('session.end', async ($: any, e: any, next: any) => {
    resetGuards()
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
    const deny = pushDecision(mode, lastPrompt, command) ?? (e.agentId ? null : commitDecision(mode, lastPrompt, command))
    return deny ? { deny } : next(e)
  }).catch(pass)
}
