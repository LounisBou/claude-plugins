// hooks/retrospective.ts
// The close of a feature is a boundary where the learning plugin's retrospective may start
// (docs/specs/learning-design.md, section 2): once the turn that ran implement:close ends, this runs
// the one command the learning plugin answers, which decides by itself whether enough candidates
// wait and starts the session, another one than this. Nothing runs where the learning plugin is not
// enabled: disabling it is the switch. An observation: it never throws, and says what it did in the
// host's log.
import { configDirOf } from '../core/env.ts'
import { recordedInstallPaths } from '../core/install-record.ts'
import { RETROSPECTIVE_CONTRACT, retrospectiveStartArgv } from '../core/learning.ts'

const LEARNING = 'learning@lounisbou'
export const START_TIMEOUT_MS = 30_000

/** The part of the host's `$` the start calls. */
export interface Host {
  readonly settings: { read(): Promise<{ readonly enabledPlugins?: Readonly<Record<string, unknown>> } | undefined> }
  readonly env: { get(name: string): Promise<string | undefined> }
  readonly fs: { read(path: string): Promise<unknown>; exists(path: string): Promise<boolean> }
  readonly process: { run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
  readonly ui: { log(line: string): void }
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? ''

export async function startRetrospective($: Host): Promise<void> {
  try {
    if ((await $.settings.read())?.enabledPlugins?.[LEARNING] !== true) return
    const config = configDirOf({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') }, (await $.env.get('HOME')) ?? '')
    const recorded = recordedInstallPaths(String(await $.fs.read(`${config}/plugins/installed_plugins.json`)), 'learning', ['lounisbou'])
    for (const root of 'problem' in recorded ? [] : recorded.paths) {
      if (!(await $.fs.exists(`${root}/${RETROSPECTIVE_CONTRACT.script}`))) continue
      const run = await $.process.run(retrospectiveStartArgv(root, config), { timeoutMs: START_TIMEOUT_MS })
      $.ui.log(`implement: ${lastLine(run.stdout) || lastLine(run.stderr) || `the learning retrospective's start exited ${run.exitCode}`}`)
      return
    }
  } catch (err: unknown) {
    try {
      $.ui.log(`implement: the learning retrospective was not started: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      // A session with no log has nothing to tell.
    }
  }
}
