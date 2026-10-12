// hooks/models-guard.ts
// The tier map's guard, pure: whether a tool call writes the operator's tier map
// (`<state dir>/models.json`), and whether his last typed prompt lifts the guard. The
// routing skill says the map is his and never rebound by a session, and a plan that told
// an orchestrator to « bind the three tiers in models.json » was followed over the rule:
// prose alone lost. guards.ts holds the $ that reads the session's role and the prompt.

export const MODELS_DENY = 'The tier map is the operator\'s (model-routing, « Pairs, tiers and the map »): '
  + 'put the binding to him as one arbitration. A pair `pick` returned goes in the brief and the record.'

// The operator names the map or a tier in the prompt he typed: the binding is his word on
// the point, and the guard stands aside.
export function namesTheMap(prompt: string): boolean {
  return /models\.json|\b(?:deep|standard|light)\b/i.test(prompt)
}

// The prompt kinds the operator typed himself: at the terminal, or through the bridge. A
// peer's delivery, a notification or an unattested channel is never his word.
export function typedByOperator(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge'
}

const normal = (p: string) => p.replace(/\/{2,}/g, '/').replace(/\/+$/, '')

// The map's own paths: the state dir's, and the config dir's default root beside it.
export function mapPaths(stateDir: string, configDir: string): string[] {
  return [...new Set([`${stateDir}/models.json`, `${configDir}/claude-orchestrator/models.json`].map(normal))]
}

// A Write, Edit or MultiEdit on the map.
export function editsTheMap(filePath: string, maps: readonly string[]): boolean {
  return filePath !== '' && maps.includes(normal(filePath))
}

const unquote = (w: string) => w.replace(/^['"]+|['"]+$/g, '')

// A word that names the map: its basename is models.json, and it points at the state
// directory — spelled with it, through a variable or the home directory, or the map's own
// path. A project's own models.json in the session's cwd is not the map and passes, unless
// the line itself names the state directory (a `cd` into it first).
function namesMap(word: string, maps: readonly string[], lineNamesState: boolean): boolean {
  const w = unquote(word)
  if (!/(?:^|\/)models\.json$/.test(w)) return false
  if (maps.includes(normal(w))) return true
  if (/claude-orchestrator\/models\.json$/.test(w)) return true
  if (/^(?:\$|~)/.test(w)) return true
  return lineNamesState
}

// A Bash line that writes the map: a redirection to it, `tee` onto it, `sed -i` over it, or
// `mv`, `cp`, `install` or `ln` with it as the destination. Reads pass: `cat`, `jq` without a
// redirection, the launcher's `resolve-tier`.
export function bashWritesTheMap(command: string, maps: readonly string[]): boolean {
  const lineNamesState = /claude-orchestrator|ORCHESTRATOR_STATE_DIR/.test(command)
  for (const m of command.matchAll(/(?:^|[^<>&0-9])\d?>{1,2}\|?\s*(\S+)/g)) {
    if (namesMap(m[1], maps, lineNamesState)) return true
  }
  for (const segment of command.split(/&&|\|\||[;|\n&]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    const at = words.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !['env', 'command', 'sudo', 'nohup', 'exec'].includes(w))
    if (at < 0) continue
    const verb = words[at].split('/').pop() ?? ''
    const args = words.slice(at + 1)
    const operands = args.filter(w => !w.startsWith('-'))
    if (verb === 'tee' && operands.some(w => namesMap(w, maps, lineNamesState))) return true
    if ((verb === 'sed' || verb === 'gsed' || verb === 'perl') && args.some(w => /^-[A-Za-z]*i|^--in-place/.test(w))
      && operands.some(w => namesMap(w, maps, lineNamesState))) return true
    if (['mv', 'cp', 'install', 'ln', 'rsync'].includes(verb) && operands.length >= 2
      && namesMap(operands[operands.length - 1], maps, lineNamesState)) return true
  }
  return false
}
