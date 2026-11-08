// hooks/host.ts
// The part of the host's API the module's strict files call, as types only: each noun and event
// spelled as the host declares it ('claude-code', the declarations the host writes beside a
// loaded mod), narrowed to what is used. The host's declarations are written per build on the
// operator's machine and are no file of this repository, so the strict check reads these; the
// host's own `$` and events are wider, never narrower, than what is named here. A file names
// the nouns it holds (`Host<'env' | 'fs'>`), so a test's fake carries only those.

export type ProcessRunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type ProcessRunResult = { exitCode: number; stdout: string; stderr: string }

export type SessionContextUsage = { tokens?: number; window: number; percent?: number }

type Nouns = {
  plugin: { root: string }
  env: { get(name: string): Promise<string | undefined> }
  fs: { write(path: string, text: string): Promise<void> }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  session: { id(): Promise<string>; model(): Promise<string>; usage(): Promise<{ context: SessionContextUsage }> }
  ui: { toast(text: string): void; invalidate(event: 'ui.render'): void }
}

export type Host<N extends keyof Nouns> = { [K in N]: Nouns[K] }

// The events' inputs, as far as the module reads them. A session id on an event that does not
// declare one is read when present, as some hosts and the test kit hand it.
export type Events = {
  'session.measure': { readonly context: SessionContextUsage; readonly sessionId?: string }
  'session.compact': { readonly agentId?: string }
  'session.end': { readonly sessionId: string }
}

// What `next` carries into a `.catch` handler: why the hook failed.
export type Caught = { readonly error?: { readonly kind?: string; readonly message?: string } }

export type Hook<H, E> = ($: H, e: E, next: (e: E) => Promise<unknown>) => Promise<unknown>
export type CatchHook<H, E> = ($: H, e: E, next: ((e: E) => Promise<unknown>) & Caught) => Promise<unknown>
export type Registration<H, E> = { catch(handler: CatchHook<H, E>): void }
export type On<H> = <K extends keyof Events>(event: K, hook: Hook<H, Events[K]>) => Registration<H, Events[K]>

// A thrown value's message, as the handlers have always logged it: its `message`, or
// `undefined` for a value that carries none.
export function messageOf(err: unknown): string {
  return String(typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined)
}
