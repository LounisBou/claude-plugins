// hooks/config-sync.ts
// Bridges the host's plugin options to the settings file the shell status line
// reads. The status line stays a shell command (the host runs it from
// settings.json and hands it the session payload on stdin), and a shell command
// is not given a plugin's options, so the file is the one channel it can read.
//
// The file stays the source the script reads. Options the person has set in the
// config menu are written into it, and win over a hand edit of the same key.
// An option never set leaves its line alone: the options always read back their
// defaults, so writing those would erase every hand edit on the first load.

// The fourteen settings, in the order the file and the config menu list them.
export const KEYS = [
  'SHOW_DIRECTORY',
  'SHOW_BRANCH',
  'SHOW_GIT_STATUS',
  'SHOW_PR',
  'SHOW_MODEL',
  'SHOW_SESSION_NAME',
  'SHOW_CONTEXT',
  'SHOW_CONTEXT_TOKENS',
  'SHOW_USAGE',
  'SHOW_SEVEN_DAY',
  'SHOW_PROGRESS_BAR',
  'SHOW_RESET_TIME',
  'RESET_COUNTDOWN',
  'SHOW_LINES_CHANGED',
] as const

export type Stored = Record<string, boolean>

// The options stored in settings under pluginConfigs. The key is the plugin's
// name, or `name@marketplace` / `name@inline` depending on how it was loaded.
export function storedOptions(settings: unknown, plugin: string): Stored {
  const configs = (settings as { pluginConfigs?: Record<string, { options?: Record<string, unknown> }> } | null)?.pluginConfigs
  const stored: Stored = {}
  if (!configs || typeof configs !== 'object') return stored
  for (const [id, entry] of Object.entries(configs)) {
    if (id !== plugin && !id.startsWith(`${plugin}@`)) continue
    for (const key of KEYS) {
      const value = entry?.options?.[key]
      if (typeof value === 'boolean') stored[key] = value
    }
  }
  return stored
}

// The file's text with each stored key set: its line rewritten in place, or
// appended when the file has none. Comments, other lines and the order stay.
export function mergeConfig(existing: string, stored: Stored): string {
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n')
  for (const [key, value] of Object.entries(stored)) {
    const line = `${key}=${value ? 1 : 0}`
    const at = lines.findIndex(l => l.startsWith(`${key}=`))
    if (at === -1) lines.push(line)
    else lines[at] = line
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// Whether a config menu row is one of this plugin's fourteen: its key reads
// `<plugin>.<field>`, the plugin spelled as the host spells it.
export function isOwnRow(key: string, plugin: string): boolean {
  return key.startsWith(plugin) && KEYS.some(k => key.endsWith(`.${k}`))
}

// The config file the script reads, by the script's own rule: STATUSBAR_CONFIG,
// else the config directory's statusline-config.txt.
async function configPath($: any): Promise<string> {
  const override = await $.env.get('STATUSBAR_CONFIG')
  if (override) return override
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${dir}/statusline-config.txt`
}

// Writes the options the person has set into the file. Writes nothing when none
// is set or the file already says the same.
async function syncFromSettings($: any): Promise<void> {
  const stored = storedOptions(await $.settings.read(), $.plugin.name)
  if (Object.keys(stored).length === 0) return
  const path = await configPath($)
  const existing = await $.fs.read(path).catch(() => '')
  const merged = mergeConfig(String(existing), stored)
  if (merged !== existing) await $.fs.write(path, merged)
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // At the start of each session, so a session that begins after a change made
  // elsewhere (the settings file edited by hand) picks it up. A failure only
  // leaves the file as it was: the script keeps reading what is there, and the
  // net lets the start through.
  on('session.start', async ($: any, e: any, next: any) => {
    await syncFromSettings($)
    return next(e)
  }).catch(async ($: any, e: any, next: any) => next(e))

  // And as each option is changed in the config menu, once the host has stored
  // it, so the bar follows the toggle without waiting for the next session.
  on('config.set', async ($: any, e: any, next: any) => {
    const result = await next(e)
    if (isOwnRow(String(e.key), $.plugin.name)) await syncFromSettings($)
    return result
  }).catch(async ($: any, e: any, next: any) => next(e))
}
