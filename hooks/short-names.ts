// hooks/short-names.ts
// The short names the installer writes as user commands (short-commands.sh, from
// short-names.tsv): the forms one command reaches command.run under, and the marker line that
// makes a user command this plugin's copy. Plain values and pure functions: $ never crosses an
// import, so each domain reads a copy through its own $.fs and asks here whether it is marked.

export const SHORT_MARKER = 'installed-by: claude-orchestrator'

// The forms the host hands command.run for one command, measured live: the bare `<short>` of
// the installer's user command, `orchestrator:<file>` for the plugin's own command (no `name:`
// since 0.82.0), and `orchestrator:<short>`, the form 0.80.0 gave every typed spelling.
export function commandForms(file: string, short: string): string[] {
  return [...new Set([`orchestrator:${short}`, `orchestrator:${file}`, short])]
}

// A bare name is a user or project command: this plugin's copy, or the operator's own command
// of the same name.
export function isBare(command: string): boolean {
  return !command.includes(':')
}

// True when a command file's frontmatter carries the marker line.
export function isOwnCopy(text: string): boolean {
  const lines = text.split('\n')
  if (lines[0] !== '---') return false
  for (const line of lines.slice(1)) {
    if (line === '---') return false
    if (line === SHORT_MARKER) return true
  }
  return false
}

// The user commands directory the installer writes: the override, else the config dir's own.
export function commandsDirOf(override: string | undefined, configDir: string): string {
  return override ? override : `${configDir}/commands`
}
