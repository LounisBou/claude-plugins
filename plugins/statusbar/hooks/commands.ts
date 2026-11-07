// hooks/commands.ts
// The commands whose markdown body only runs a script or prints a file, answered
// here without a model turn: install, uninstall, and config with no request.
// Each handler answers the command's whole run. Where it fails, its net lets the
// run through to the markdown body, so the command still works, with a turn, as
// it did before this module. The markdown files stay the commands' public face
// and the whole path under a non-interactive run and on a host that does not load modules.
import { KEYS } from './config-sync.ts'

// The restart line the install command ends on, as the markdown body says it.
export const RESTART = 'Restart your session for the bar to appear.'

// The script's output, with its exit status said when it failed. A failure is
// still an answer: the person reads what the script printed.
export function scriptText(run: { exitCode: number; stdout: string; stderr: string }, tail: string): string {
  const out = `${run.stdout}${run.stderr}`.trim()
  if (run.exitCode !== 0) return `${out}\n\nThe script failed (exit ${run.exitCode}).`.trim()
  return tail === '' ? out : `${out}\n\n${tail}`
}

// The file's settings as lines, the file's value or the shown default (a key the
// file lacks is on, as the script reads it).
export function settingsText(file: string, path: string): string {
  const set: Record<string, string> = {}
  for (const line of file.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0 && !line.startsWith('#')) set[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  const rows = KEYS.map(key => `  ${key.padEnd(20)} ${(set[key] ?? '1') === '0' ? 'hidden' : 'shown'}`)
  return [
    `Status bar settings (${path}):`,
    ...rows,
    '',
    'A setting changed in /config wins over this file. To change one by request, run the command with it: /statusbar:config hide the PR.',
  ].join('\n')
}

// The config directory and the settings file the script reads, by its own rule.
async function configPath($: any): Promise<string> {
  const override = await $.env.get('STATUSBAR_CONFIG')
  if (override) return override
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${dir}/statusline-config.txt`
}

// Runs one of the plugin's two scripts and answers its output.
async function runScript($: any, script: string, tail: string): Promise<{ text: string }> {
  const run = await $.process.run(['bash', `${$.plugin.root}/${script}`], { timeoutMs: 60000 })
  return { text: scriptText(run, tail) }
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => { catch(handler: Function): void }) {
  // The matcher names the invocation spelling the markdown commands carry, so
  // each hook answers its own command's run and no other plugin's.
  on('command.run', { command: 'statusbar:install' }, async ($: any) => runScript($, 'install.sh', RESTART))
    .catch(async ($: any, e: any, next: any) => next(e))

  on('command.run', { command: 'statusbar:uninstall' }, async ($: any) => runScript($, 'uninstall.sh', ''))
    .catch(async ($: any, e: any, next: any) => next(e))

  // A request needs the model to be read. Only the bare command, which shows the
  // current settings, is answered here; the request goes on to the markdown body.
  on('command.run', { command: 'statusbar:config' }, async ($: any, e: any, next: any) => {
    if (String(e.args).trim() !== '') return next(e)
    const path = await configPath($)
    const file = await $.fs.read(path).catch(() => '')
    return { text: settingsText(String(file), path) }
  }).catch(async ($: any, e: any, next: any) => next(e))
}
