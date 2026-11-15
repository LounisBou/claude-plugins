// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The part of the host's API the plugins' strict hook files call, as types only: each noun and
// event spelled as the host declares it ('claude-code', the declarations the host writes beside a
// loaded mod), narrowed to what is used. The host's declarations are written per build on the
// operator's machine and are no file of this repository, so the strict check reads these; the
// host's own `$` and events are wider, never narrower, than what is named here. A file names
// the nouns it holds (`Host<'env' | 'fs'>`), so a test's fake carries only those.

export type ProcessRunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
// `isStdoutTruncated`: the output was cut at the host's limit.
export type ProcessRunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }

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
// `Select` and `Input` are drawn by a surface that has them (not mobile): a caller tests for them.
export type UiElements = { Box: UiElement; Text: UiElement; Button: UiElement; Link: UiElement; Select?: UiElement; Input?: UiElement }

// A pane as `ui.panes` lists it, and what `ui.open` answers.
export type UiPane = { id: string; title?: string; isShown?: boolean; isFocused?: boolean; isPlaced?: boolean }
export type UiOpenResult = { isPlaced: true; reason?: undefined } | { isPlaced: false; reason: string }

export type CommandSpec = { name: string; description: string; argumentHint?: string }

// A key of the host's session state: the plugin that owns it and its name.
export type StateRef = { plugin: string; key: string }

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
    // The session's project root, which a shell `cd` does not move.
    root(): Promise<string>
    model(): Promise<string>
    usage(): Promise<{ context: SessionContextUsage }>
    send(args: { to: string | { sessionId: string }; text: string }): Promise<SessionSendResult>
  }
  ui: {
    toast(text: string): void
    invalidate(event: 'ui.render'): void
    log(text: string): void
    ask(question: string, options?: readonly string[]): Promise<string>
    open(pane: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean }): Promise<UiOpenResult | undefined>
    close(pane: { id: string }): Promise<void>
    panes(): Promise<readonly UiPane[]>
    focus(args: { requestId: string; key: string }): Promise<unknown>
    scroll(args: { to: { key: string } | 'end'; in?: string }): Promise<unknown>
    resolve(e: Events['ui.render']): UiElements
  }
  tool: {
    register(tool: ToolSpec): Promise<unknown>
    call(input: { tool: string } & Record<string, unknown>): Promise<unknown>
    check(input: { tool: string; input: unknown }): Promise<ToolCheckResult>
    list(): Promise<ReadonlyArray<{ readonly name: string }>>
  }
  state: { get(ref: StateRef): Promise<{ readonly value?: unknown } | undefined>; set(ref: StateRef, value: unknown): Promise<unknown> }
  command: { run(args: { command: string; args?: string }): Promise<unknown>; register(command: CommandSpec): Promise<unknown> }
  prompt: { submit(input: { text: string }): Promise<unknown> }
  // The settings merged over every source, as the host reads them.
  settings: { read(): Promise<unknown> }
  clock: { sleep(ms: number): Promise<void>; after(ms: number, run: () => unknown): unknown; now(): Promise<number>; every(ms: number, fn: () => void): Timer }
}

export type ToolSpec = { name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }

// The host's nouns, by name.
export type Noun = keyof Nouns

export type Host<N extends keyof Nouns> = { [K in N]: Nouns[K] }

// A file read as bytes, for a file that reads one (`Host<'fs'> & Bytes` holds both reads).
export type Bytes = { readonly fs: { read(path: string, options: { readonly as: 'bytes' }): Promise<{ readonly base64: string }> } }

// The plugin's manifest name beside its root, for a file that reads it (`Host<'plugin'> & Named`).
export type Named = { readonly plugin: { readonly name: string } }

// The events' inputs, as far as the module reads them. A session id on an event that does not
// declare one is read when present, as some hosts and the test kit hand it.
export type Events = {
  'session.start': { readonly cwd: string }
  'session.measure': { readonly context: SessionContextUsage; readonly sessionId?: string }
  'session.compact': { readonly agentId?: string }
  'session.end': { readonly sessionId: string }
  'turn.start': { readonly agentId?: string }
  'command.run': { readonly command: string; readonly args: string }
  // An option changed in the config menu, once the host has stored it: its key, `<plugin>.<field>`.
  'config.set': { readonly key: string; readonly value?: unknown }
  // A prompt as the turn takes it: who typed it (`origin.kind`), and the lines a handler adds beside it.
  'prompt.submit': { readonly agentId?: string; readonly origin?: { readonly kind?: string }; readonly text?: string; readonly context?: readonly string[]; readonly turnId?: string }
  // A peer's delivery; `origin` is the host's own description of where it came from.
  'session.receive': { readonly agentId?: string; readonly origin: unknown; readonly text: string }
  // `reason` is why the turn ended (`answer` for a turn that answered, `aborted` when the person
  // interrupted it), `turnId` names it.
  'turn.complete': { readonly agentId?: string; readonly answer?: string; readonly isAborted?: boolean; readonly reason?: string; readonly turnId?: unknown }
  // The settings payload's own fields, as far as the stop gate reads them; the host's lists of the
  // work in flight are read through a validator.
  'classic.Stop': {
    readonly last_assistant_message?: string
    readonly stop_hook_active?: boolean
    readonly session_id?: string
    readonly transcript_path?: string
    readonly cwd?: string
    readonly background_tasks?: unknown
    readonly session_crons?: unknown
  }
  // A message this session sends a peer: who wrote it (`origin.kind`) and its text.
  'session.send': { readonly agentId?: string; readonly origin?: { readonly kind?: string }; readonly text?: string }
  // A call of a tool: its arguments are the input's own fields.
  'tool.call': { readonly agentId?: string; readonly [argument: string]: unknown }
  'ui.close': { readonly id: string }
  // A skill's text as it loads: its name, and the text the handler may rewrite.
  'skill.prompt': { readonly skill?: string; readonly text?: string; readonly args?: string }
  // A subagent about to start: its type and the prompt it is handed.
  'agent.spawn': { readonly subagentType?: string; readonly fork?: boolean; readonly prompt?: string }
  // A surface to draw: the pane `requestId` names, its props as the host gives them: its width, its
  // body's window over the tree (`scroll`), and whether it holds the keys.
  'ui.render': {
    readonly requestId?: string
    readonly props?: { readonly bodyColumns?: number; readonly scroll?: { readonly offset: number; readonly bodyRows: number }; readonly isFocused?: boolean; readonly hasSurvey?: boolean }
  }
  // A git text the engine composed (`kind`: `commit`, `pr`, …), which the handler may rewrite.
  'attribution.text': { readonly kind: string; readonly text: string }
  // The person moving a pane's window: the tree's height the host measured.
  'ui.scroll': { readonly requestId?: string; readonly contentRows: number }
  // The ring moving in a pane: the element it reaches, by its key.
  'ui.focus': { readonly requestId?: string; readonly element?: string }
}

// What `next` carries into a `.catch` handler: why the hook failed, and whether the call beneath already ran.
export type Caught = { readonly error?: { readonly kind?: string; readonly message?: string }; readonly called?: boolean }

// What `next` reads of the hook's bound.
export type Budget = { readonly budget?: { readonly remainingMs: number } }

// What `next` says of who raised the event: the plugin whose call it is, the engine's own when absent.
export type Origin = { readonly origin?: { readonly plugin?: string } }

export type Next<E> = ((e: E) => Promise<unknown>) & Budget & Origin
export type Hook<H, E> = ($: H, e: E, next: Next<E>) => Promise<unknown>
export type CatchHook<H, E> = ($: H, e: E, next: Next<E> & Caught) => Promise<unknown>
export type Registration<H, E> = { catch(handler: CatchHook<H, E>): void }
// The events that stream: a hook is an async generator over `next(e)`'s chunks.
export type StreamEvents = {
  // One request of a turn to the model; what it returns carries the model's `answer`.
  'turn.step': { readonly agentId?: string; readonly turnId?: string }
}
export type StreamNext<E> = (e: E) => AsyncGenerator<unknown, unknown>
export type StreamHook<H, E> = ($: H, e: E, next: StreamNext<E>) => AsyncGenerator<unknown, unknown>

// A registration, with or without a matcher (`{}`, `{ tool }`, a tool or several, a pattern).
export type On<H> = {
  <K extends keyof Events>(event: K, hook: Hook<H, Events[K]>): Registration<H, Events[K]>
  <K extends keyof Events>(event: K, matcher: Readonly<Record<string, string | readonly string[] | RegExp>>, hook: Hook<H, Events[K]>): Registration<H, Events[K]>
  <K extends keyof StreamEvents>(event: K, hook: StreamHook<H, StreamEvents[K]>): unknown
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

// A record's fields, or undefined for anything that is not one.
export function fieldsOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

// A list's items, or none for anything that is not a list.
export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

// The dialog a `$.ui.ask` raises, as the AskUserQuestion call carries it: its first question and
// that question's option labels.
export function dialogOf(input: Readonly<Record<string, unknown>>): { readonly question: string; readonly labels: readonly string[] } {
  const first = fieldsOf(listOf(input['questions'])[0])
  return { question: String(first?.['question'] ?? ''), labels: listOf(first?.['options']).map(option => String(fieldsOf(option)?.['label'] ?? '')) }
}

// What a tool or a hook beneath answered, as far as a module reads it.
export interface Answer {
  // The refusal, when the call was refused.
  readonly deny: string | undefined
  readonly isError: boolean
  // The answer's `result`, as it came: a text, content parts, or a tool's own record.
  readonly result: unknown
  // The answer's `result`, else its `text`, as trimmed text.
  readonly text: string
}

// The answer `raw` holds; anything that is no record answers nothing.
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
