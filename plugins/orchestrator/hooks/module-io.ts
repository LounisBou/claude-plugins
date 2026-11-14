// hooks/module-io.ts
// The module's own I/O over a handler's $, written once for every domain that holds one: the
// host's config dir, the scripts' state root, the module's log line, a write in one rename, and
// the context gate's thresholds. Each variable is read by its literal name, the way the host
// lists what a module reads; the rules themselves are core's (env.ts, store-io.ts) and
// module-log.ts's.
import { configDirOf, gateThresholds } from '../core/env.ts'
import { writeAtomicOver, type StoreIo } from '../core/store-io.ts'
import { logArgv, moduleDirOf, LOG_TIMEOUT_MS } from './module-log.ts'
import type { Host } from './host.ts'

/** The host's configuration directory: CLAUDE_CONFIG_DIR, else `.claude` under HOME. */
export async function configDir($: Host<'env'>): Promise<string> {
  return configDirOf({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') }, (await $.env.get('HOME')) ?? '')
}

/**
 * The root the surviving scripts share (the chains, the records registry, ci-watch's logs, the
 * coordinator's record): ORCHESTRATOR_STATE_DIR, else the config dir's claude-orchestrator. The
 * module's own files, its store and its log, stay under moduleDirOf's root.
 */
export async function stateDir($: Host<'env'>): Promise<string> {
  return moduleDirOf(await configDir($), await $.env.get('ORCHESTRATOR_STATE_DIR'))
}

/** One line appended to the module's log, stamped with `half`. Never throws, never blocks its caller. */
export async function logLine($: Host<'plugin' | 'env' | 'process'>, half: string, message: string): Promise<void> {
  try {
    const argv = logArgv($.plugin.root, await configDir($), half, message, undefined, await $.env.get('ORCHESTRATOR_MODULE_DIR'))
    await $.process.run(argv, { timeoutMs: LOG_TIMEOUT_MS })
  } catch { /* the log itself never blocks the handler that failed */ }
}

/** The store's I/O over this $: core's store-io runs its locks and renames over it. */
export function storeIo($: Host<'fs' | 'process' | 'clock'>): StoreIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    read: path => $.fs.read(path).then(text => String(text), () => undefined),
    run: argv => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: path => $.fs.stat(path).then(stat => stat.mtimeMs, () => undefined),
    sleep: ms => $.clock.sleep(ms),
    now: Date.now,
    tag: uniqueTag,
  }
}

/** A part of a temporary name no other write uses at the same time. */
export function uniqueTag(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** `text` written to `path` in one rename through a temporary file beside it: $.fs.write is not atomic. */
export async function writeAtomic($: Host<'fs' | 'process' | 'clock'>, path: string, text: string): Promise<void> {
  await writeAtomicOver(storeIo($), path, text)
}

/** The context gate's thresholds (core's gateThresholds) over the two variables. */
export async function gateEnv($: Host<'env'>): Promise<{ gate?: number; gateTokens?: number }> {
  return gateThresholds({
    ORCHESTRATOR_CONTEXT_GATE: await $.env.get('ORCHESTRATOR_CONTEXT_GATE'),
    ORCHESTRATOR_CONTEXT_GATE_TOKENS: await $.env.get('ORCHESTRATOR_CONTEXT_GATE_TOKENS'),
  })
}
