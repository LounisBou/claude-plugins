// The part of the host's test kit, 'claude-code/testing', the plugins' hook tests call, as types
// only: the host writes its declarations beside a loaded mod, on the operator's machine, and they are
// no file of this repository, so `tsconfig.json` maps the module's name to this file for the strict
// check. The host's kit is wider, never narrower, than what is named here. Nothing imports it at run
// time: the host hands a test its own `test`, `expect` and `mock`.
import type { CatchHook, CommandSpec, Events, FsStat, Host, Noun, ProcessRunInit, StateRef, StreamEvents, StreamHook, ToolSpec, UiElements } from './host.ts'

// What a call answers, through the module and the fakes beneath it, as far as a test reads it.
export type Reply = {
  readonly deny?: string
  readonly result?: unknown
  readonly text?: string
  readonly isError?: boolean
  readonly value?: unknown
  readonly context?: readonly string[]
  readonly decision?: string
  readonly reason?: string
  readonly [field: string]: unknown
}

// An event's fields as a test hands them: the host fills what the test leaves out.
type Fields = Readonly<Record<string, unknown>>

// A pane or a band drawn under a test, and what a test finds in it.
export type Found = { readonly type: string; readonly key: string | undefined; readonly props: Readonly<Record<string, unknown>>; readonly text: string; readonly children: readonly unknown[] }
export type ElementQuery = { readonly type?: string; readonly key?: string; readonly text?: string | RegExp; readonly in?: string; readonly props?: Fields }
export type Mounted = {
  drawn(): Promise<Found>
  find(query: ElementQuery): Promise<Found | undefined>
  findAll(query: ElementQuery): Promise<Found[]>
  press(target: { readonly key: string; readonly plugin?: string }): Promise<unknown>
  redraw(props?: Fields): Promise<void>
  unmount(): Promise<void>
}

// The test's `$`: each event raised through the engine, the module's hooks answering first.
export type Engine = {
  tool: { call(input: { readonly tool: string } & Fields): Promise<Reply>; check(input: { readonly tool: string; readonly input: unknown }): Promise<Reply> }
  command: { run(input: { readonly command: string; readonly args?: string } & Fields): Promise<Reply> }
  session: { start(e: Fields): Promise<Reply>; end(e: Fields): Promise<Reply>; receive(e: Fields): Promise<Reply>; root(): Promise<string> }
  skill: { prompt(e: Fields): Promise<Reply> }
  prompt: { submit(e: Fields): Promise<Reply> }
  turn: { complete(e: Fields): Promise<Reply>; step(e: Fields): AsyncGenerator<unknown, unknown> & { readonly result: Promise<unknown> } }
  attribution: { text(e: { readonly kind: string; readonly text: string }): Promise<Reply> }
  classic: { Stop(e: Fields): Promise<Reply> }
  state: { get(ref: StateRef): Promise<Reply> }
  fs: { read(path: string): Promise<string> }
  ui: { mount(target: Fields): Promise<Mounted>; resolve(e: Events['ui.render']): UiElements }
}

// The calls of the nouns beneath the module, as the fakes a test registers read them.
export type NounEvents = {
  'env.get': { readonly name: string }
  'fs.read': { readonly path: string }
  'fs.write': { readonly path: string; readonly text: string }
  'fs.list': { readonly path: string }
  'fs.exists': { readonly path: string }
  'fs.stat': { readonly path: string; readonly options?: { readonly resolve: boolean } }
  'process.run': { readonly argv: readonly string[]; readonly init?: ProcessRunInit }
  'session.id': Fields
  'session.cwd': Fields
  'session.root': Fields
  'session.usage': Fields
  'tool.register': ToolSpec
  'tool.check': { readonly tool: string; readonly input: unknown }
  'tool.list': Fields
  'command.register': CommandSpec
  'state.get': StateRef
  'settings.read': Fields
  'ui.log': { readonly text: string }
  'ui.toast': { readonly text: string }
  'ui.open': { readonly id: string; readonly title?: string; readonly focus?: boolean }
  'clock.sleep': { readonly ms: number }
}

export type TestEvents = Events & NounEvents

// Every noun of the host, as a hook under test receives it.
export type World = Host<Noun>

// What `next` carries in a fake: the call beneath, and the hook's bound.
export type FakeNext<E> = ((e: E) => Promise<unknown>) & { readonly budget?: { readonly remainingMs: number } }
// A fake answers as it likes, at once or later: `{ value }`, `{ result }`, `{ deny }`, or it throws.
export type Fake<E> = ($: World, e: E, next: FakeNext<E>) => unknown
export type Matcher = Readonly<Record<string, string | readonly string[] | RegExp>>
export type TestRegistration<E> = { catch(handler: CatchHook<World, E>): void }

// The test's `on`: the module registers on it, and the test registers its fakes beneath.
export type TestOn = {
  <K extends keyof TestEvents>(event: K, hook: Fake<TestEvents[K]>): TestRegistration<TestEvents[K]>
  <K extends keyof TestEvents>(event: K, matcher: Matcher, hook: Fake<TestEvents[K]>): TestRegistration<TestEvents[K]>
  <K extends keyof StreamEvents>(event: K, hook: StreamHook<World, StreamEvents[K]>): unknown
}

export type Matchers = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toStrictEqual(expected: unknown): void
  toMatchObject(expected: object): void
  toContain(item: unknown): void
  toContainEqual(item: unknown): void
  toHaveLength(length: number): void
  toHaveProperty(path: string | readonly string[], value?: unknown): void
  toBeUndefined(): void
  toBeDefined(): void
  toBeNull(): void
  toBeTruthy(): void
  toBeFalsy(): void
  toBeGreaterThan(bound: number): void
  toBeGreaterThanOrEqual(bound: number): void
  toBeLessThan(bound: number): void
  toBeLessThanOrEqual(bound: number): void
  toMatch(pattern: string | RegExp): void
  toStartWith(prefix: string): void
  toEndWith(suffix: string): void
  toThrow(expected?: string | RegExp): void
}
type AsyncMatchers = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> }
export type Expectation = Matchers & { not: Matchers; resolves: AsyncMatchers & { not: AsyncMatchers }; rejects: AsyncMatchers & { not: AsyncMatchers } }
export type AsymmetricMatcher = { readonly text: string }
export type Expect = ((received: unknown, message?: string) => Expectation) & {
  anything(): AsymmetricMatcher
  stringContaining(text: string): AsymmetricMatcher
  stringMatching(pattern: string | RegExp): AsymmetricMatcher
  objectContaining(shape: object): AsymmetricMatcher
  arrayContaining(items: readonly unknown[]): AsymmetricMatcher
}

export type MockClock = { now(): number; advance(ms: number): Promise<void>; set(ms: number): Promise<void>; settle(): Promise<void>; sleep(ms: number): Promise<void> }
export type Mock = {
  clock(on: TestOn, options?: { readonly now?: number }): MockClock
  store(on: TestOn, entries?: Readonly<Record<string, unknown>>): void
  env(on: TestOn, variables: Readonly<Record<string, string>>): void
}

export type TestBody = ($: Engine, on: TestOn) => unknown
export type TestOptions = { readonly timeoutMs?: number }

export declare const test: (name: string, ...rest: readonly [body: TestBody] | readonly [options: TestOptions, body: TestBody]) => void
export declare const describe: (name: string, body: () => void) => void
export declare const expect: Expect
export declare const mock: Mock

// A fake's file status, as `fs.stat` answers it.
export type { FsStat }
