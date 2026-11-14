// hooks/register.ts
// The hooks module: answers /learning:health with the script's output, without a model turn. The
// markdown command stays the public face and the whole path under a non-interactive run and on a
// host that does not load modules.

type Hook = ($: Host, e: Record<string, unknown>) => Promise<unknown>
type On = (event: string, matcher: Readonly<Record<string, string>>, hook: Hook) => unknown

/** The part of the host's `$` this module calls. */
export interface Host {
  readonly plugin: { readonly root: string }
  readonly env: { get(name: string): Promise<string | undefined> }
  readonly process: { run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
}

/** The report reads files only: it is never given longer than this. */
export const HEALTH_TIMEOUT_MS = 30_000

const SCRIPT = 'skills/learning/scripts/health.ts'

/** The script's command line: node, the script, the config directory. */
export function scriptArgv(root: string, config: string): string[] {
  return ['node', '--experimental-strip-types', '--no-warnings', `${root}/${SCRIPT}`, '--config', config]
}

async function configDir($: Host): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
}

export function register(on: On): void {
  on('command.run', { command: 'learning:health' }, async $ => {
    try {
      const run = await $.process.run(scriptArgv($.plugin.root, await configDir($)), { timeoutMs: HEALTH_TIMEOUT_MS })
      return { text: `${run.stdout}${run.stderr}`.trim() || `health exited ${run.exitCode}` }
    } catch (error) {
      return { text: `learning: the health report did not run: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
