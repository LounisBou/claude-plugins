// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The part of the host's API a hooks module calls, as types, and the one reader of what a tool
// answers. The host's own declarations ('claude-code') are written per build on the operator's
// machine and are no file of this repository, so a strict hooks file reads these: each noun spelled
// as the host declares it, narrowed to what the modules use; the host's `$` is wider, never
// narrower. A file names the nouns it holds (`Host<'env' | 'fs'>`), so a test's fake carries only
// those. An event's input is a record of unknown fields: a handler validates what it reads.

export type RunInit = { cwd?: string; stdin?: string; timeoutMs?: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type StateRef = { plugin: string; key: string }
export type ToolSpec = { name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }

export type Input = Readonly<Record<string, unknown>>

type Nouns = {
  plugin: { readonly root: string }
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    write(path: string, text: string): Promise<unknown>
    read(path: string): Promise<string>
    list(path: string): Promise<ReadonlyArray<{ readonly name: string }>>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ readonly kind: string; readonly mtimeMs?: number }>
  }
  process: { run(argv: readonly string[], init?: RunInit): Promise<RunResult> }
  session: { id(): Promise<string>; root(): Promise<string> }
  state: { get(ref: StateRef): Promise<{ readonly value?: unknown } | undefined>; set(ref: StateRef, value: unknown): Promise<unknown> }
  ui: {
    log(text: string): unknown
    invalidate(event: string): void
    ask(question: string, choices: readonly string[]): Promise<string>
    /** The components a render event draws with, by name. */
    resolve(e: Input): Readonly<Record<string, (props: Readonly<Record<string, unknown>>) => unknown>>
  }
  tool: { register(spec: ToolSpec): Promise<unknown>; call(input: Input): Promise<unknown>; list(): Promise<ReadonlyArray<{ readonly name: string }>> }
  clock: { sleep(ms: number): Promise<void> }
}

export type Host<N extends keyof Nouns> = { [K in N]: Nouns[K] }

/** The chain beneath a hook; `called` says whether the hook already ran it, where the host tells. */
export type Next = ((e: Input) => Promise<unknown>) & { readonly called?: boolean }
export type Hook<H> = ($: H, e: Input, next: Next) => Promise<unknown>
export type Registration<H> = { catch(handler: Hook<H>): void }
/** A registration, with or without a matcher (`{ tool }`, `{ command }`). */
export type On<H> = {
  (event: string, hook: Hook<H>): Registration<H>
  (event: string, matcher: object, hook: Hook<H>): Registration<H>
}

/** A record's fields, or undefined for anything that is not one. */
export function fieldsOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** What a caught value says: an error's message, or the value as text. */
export function messageOf(error: unknown): string {
  const message = fieldsOf(error)?.['message']
  return String(message ?? error)
}

/** What a tool or a hook beneath answered, as far as a module reads it. */
export interface Answer {
  /** The refusal, when the call was refused. */
  readonly deny: string | undefined
  readonly isError: boolean
  /** The answer's `result`, as it came: a text, content parts, or a tool's own record. */
  readonly result: unknown
  /** The answer's `result`, else its `text`, as trimmed text. */
  readonly text: string
}

/** The answer `raw` holds; anything that is no record answers nothing. */
export function answerOf(raw: unknown): Answer {
  const fields = fieldsOf(raw) ?? {}
  const deny = fields['deny']
  return {
    deny: deny === undefined || deny === null || deny === false || deny === '' ? undefined : String(deny).trim(),
    isError: Boolean(fields['isError']),
    result: fields['result'],
    text: String(fields['result'] ?? fields['text'] ?? '').trim(),
  }
}
