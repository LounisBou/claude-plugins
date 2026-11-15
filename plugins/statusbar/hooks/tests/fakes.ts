// hooks/tests/fakes.ts
// The world beneath the module, registered on the test's `on`: an in-memory file system, the
// settings, the environment and the scripts' runs. What reaches the bottom of a chain answers as
// the host would: the markdown body names the run it was handed, a start its directory, an option its value.
import type { TestOn } from 'claude-code/testing'

// The plugin's directory, as the host hands it to the module.
export const ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/\/$/, '')

// What the markdown body of a command answers, in place of a model turn.
export const markdown = (command: string, args: string): string => `markdown body of ${command} (${args})`

export type FakeOptions = {
  env?: Record<string, string>
  files?: Record<string, string>
  pluginConfigs?: Record<string, unknown>
  run?: { exitCode: number; stdout: string; stderr: string }
  failSettings?: boolean
  failRun?: string
}

export function world(on: TestOn, opts: FakeOptions = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const env: Record<string, string> = { HOME: '/home/u', ...(opts.env ?? {}) }
  const ran: (readonly string[])[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('config.set', (_$, e) => ({ value: e.value }))
  on('command.run', (_$, e) => ({ text: markdown(e.command, e.args) }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', () => {
    if (opts.failSettings) throw new Error('settings unavailable')
    return { value: opts.pluginConfigs ? { pluginConfigs: opts.pluginConfigs } : {} }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (opts.failRun) throw new Error(opts.failRun)
    ran.push(e.argv)
    return { value: opts.run ?? { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { files, ran }
}
