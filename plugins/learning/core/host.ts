// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The part of the host's API the plugins' strict hook files call, as types only: each noun and
// event spelled as the host declares it ('claude-code', the declarations the host writes beside a
// loaded mod), narrowed to what is used. The host's declarations are written per build on the
// operator's machine and are no file of this repository, so the strict check reads these; the
// host's own `$` and events are wider, never narrower, than what is named here. A file names
// the nouns it holds (`Host<'env' | 'fs'>`), so a test's fake carries only those.

export type ProcessRunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type ProcessRunResult = { exitCode: number; stdout: string; stderr: string }

export type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean; mtimeMs?: number }

export type FsStat = { kind: 'file' | 'dir' | 'other'; size: number; realPath?: string; mtimeMs?: number }

export type SessionSendResult = { isDelivered: true; reason?: undefined } | { isDelivered: false; reason: string }

export type SessionContextUsage = { tokens?: number; window: number; percent?: number }

// The permission decision of a tool call; `rule` is set when an explicit rule gave it.
export type ToolCheckResult = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: unknown }

// A running `clock.every`.
export type Timer = { cancel(): void }

// A component of a surface, as `ui.resolve` hands it out: from its props to what the host draws.
export type UiElement = (props: Readonly<Record<string, unknown>>) => unknown
export type UiElements = { Box: UiElement; Text: UiElement; Button: UiElement; Link: UiElement }

export type CommandSpec = { name: string; description: string; argumentHint?: string }

type Nouns = {
  plugin: { root: string }
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    write(path: string, text: string): Promise<void>
    read(path: string): Promise<string>
    list(path: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string, options?: { resolve: boolean }): Promise<FsStat>
  }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  session: {
    id(): Promise<string>
    cwd(): Promise<string>
    model(): Promise<string>
    usage(): Promise<{ context: SessionContextUsage }>
    send(args: { to: string; text: string }): Promise<SessionSendResult>
  }
  ui: {
    toast(text: string): void
    invalidate(event: 'ui.render'): void
    log(text: string): void
    ask(question: string, options?: readonly string[]): Promise<string>
    open(pane: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean }): Promise<unknown>
    resolve(e: Events['ui.render']): UiElements
  }
  tool: {
    register(tool: ToolSpec): Promise<unknown>
    call(input: { tool: string } & Record<string, unknown>): Promise<unknown>
    check(input: { tool: string; input: unknown }): Promise<ToolCheckResult>
  }
  command: { run(args: { command: string; args?: string }): Promise<unknown>; register(command: CommandSpec): Promise<unknown> }
  prompt: { submit(input: { text: string }): Promise<unknown> }
  clock: { sleep(ms: number): Promise<void>; now(): Promise<number>; every(ms: number, fn: () => void): Timer }
}

export type ToolSpec = { name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }

export type Host<N extends keyof Nouns> = { [K in N]: Nouns[K] }

// The events' inputs, as far as the module reads them. A session id on an event that does not
// declare one is read when present, as some hosts and the test kit hand it.
export type Events = {
  'session.start': { readonly cwd: string }
  'session.measure': { readonly context: SessionContextUsage; readonly sessionId?: string }
  'session.compact': { readonly agentId?: string }
  'session.end': { readonly sessionId: string }
  'turn.start': { readonly agentId?: string }
  'command.run': { readonly command: string; readonly args: string }
  // A peer's delivery; `origin` is the host's own description of where it came from.
  'session.receive': { readonly agentId?: string; readonly origin: unknown; readonly text: string }
  'turn.complete': { readonly agentId?: string; readonly answer?: string; readonly isAborted?: boolean }
  'classic.Stop': { readonly last_assistant_message?: string }
  // A call of a tool: its arguments are the input's own fields.
  'tool.call': { readonly agentId?: string; readonly [argument: string]: unknown }
  'prompt.submit': { readonly text: string }
  'ui.close': { readonly id: string }
  // A surface to draw: the pane `requestId` names, its props as the host gives them.
  'ui.render': { readonly requestId?: string; readonly props?: Readonly<Record<string, unknown>> }
}

// What `next` carries into a `.catch` handler: why the hook failed.
export type Caught = { readonly error?: { readonly kind?: string; readonly message?: string } }

// What `next` reads of the hook's bound.
export type Budget = { readonly budget?: { readonly remainingMs: number } }

export type Next<E> = ((e: E) => Promise<unknown>) & Budget
export type Hook<H, E> = ($: H, e: E, next: Next<E>) => Promise<unknown>
export type CatchHook<H, E> = ($: H, e: E, next: Next<E> & Caught) => Promise<unknown>
export type Registration<H, E> = { catch(handler: CatchHook<H, E>): void }
// A registration, with or without a matcher (`{}`, `{ tool }`).
export type On<H> = {
  <K extends keyof Events>(event: K, hook: Hook<H, Events[K]>): Registration<H, Events[K]>
  <K extends keyof Events>(event: K, matcher: Readonly<Record<string, string>>, hook: Hook<H, Events[K]>): Registration<H, Events[K]>
}

// A rejection's reason as a line: its `message`, else the value itself.
export function reasonOf(err: unknown): string {
  const message = typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined
  return String(message ?? err)
}

// A thrown value's message, as the handlers have always logged it: its `message`, or
// `undefined` for a value that carries none.
export function messageOf(err: unknown): string {
  return String(typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined)
}
