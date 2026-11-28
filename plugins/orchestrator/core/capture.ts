// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// What a hook test calls without the engine: the hooks a module registers, each with its matcher
// and its net, found again by event and called with a `$` of the test's own; and that `$`, a host
// whose every noun throws but the ones a test hands it. For a seam the kit's engine cannot raise
// (a prompt the person typed, a pane the person closed) or a test that drives one hook alone.
import type { CatchHook, Events, Hook, Host, Matcher, Noun, On } from './host.ts'

// One registration as kept: its event, its matcher, its hook and the net its `.catch` gave. The
// hook is typed by its event once `hookOf` finds it by that event.
export type Captured<H> = {
  readonly event: keyof Events
  readonly matcher: Matcher | undefined
  readonly handler: ($: H, e: never, next: never) => Promise<unknown>
  net: (($: H, e: never, next: never) => Promise<unknown>) | undefined
}

// A registration found by its event: its hook and its net take that event's input.
export type CapturedOn<H, K extends keyof Events> = Captured<H> & {
  readonly event: K
  readonly handler: Hook<H, Events[K]>
  net: CatchHook<H, Events[K]> | undefined
}

/** The hooks `register` puts on `on`, in their order. */
export function capture<H>(register: (on: On<H>) => void): Array<Captured<H>> {
  const hooks: Array<Captured<H>> = []
  function on<K extends keyof Events>(event: K, hook: Hook<H, Events[K]>): { catch(net: CatchHook<H, Events[K]>): void }
  function on<K extends keyof Events>(event: K, matcher: Matcher, hook: Hook<H, Events[K]>): { catch(net: CatchHook<H, Events[K]>): void }
  function on<K extends keyof Events>(event: K, a: Matcher | Hook<H, Events[K]>, b?: Hook<H, Events[K]>): { catch(net: CatchHook<H, Events[K]>): void } {
    const handler = typeof a === 'function' ? a : b
    if (handler === undefined) throw new Error(`${event}: a registration without its hook`)
    const entry: Captured<H> = { event, matcher: typeof a === 'function' ? undefined : a, handler, net: undefined }
    hooks.push(entry)
    return { catch(net) { entry.net = net } }
  }
  register(on)
  return hooks
}

/** Every hook on `event`, whatever its matcher, in their order. */
export function hooksOn<H, K extends keyof Events>(hooks: ReadonlyArray<Captured<H>>, event: K): Array<CapturedOn<H, K>> {
  return hooks.filter((h): h is CapturedOn<H, K> => h.event === event)
}

/** The first hook on `event` whose matcher is `matcher` (none: a hook without one). */
export function hookOf<H, K extends keyof Events>(hooks: ReadonlyArray<Captured<H>>, event: K, matcher?: Matcher): CapturedOn<H, K> {
  const wanted = JSON.stringify(matcher ?? null)
  const found = hooks.find((h): h is CapturedOn<H, K> => h.event === event && JSON.stringify(h.matcher ?? null) === wanted)
  if (found === undefined) throw new Error(`no hook ${event} ${wanted}`)
  return found
}

// A host's nouns, each one given in part.
export type HostParts = { readonly [N in Noun]?: Partial<Host<Noun>[N]> }

const unset = (name: string) => () => { throw new Error(`$.${name} is not part of this test`) }

/** A host whose every call throws, but the members `parts` hands it. */
export function hostOf(parts: HostParts = {}): Host<Noun> {
  return {
    plugin: { root: '/plugin', ...parts.plugin },
    env: { get: unset('env.get'), ...parts.env },
    fs: { write: unset('fs.write'), read: unset('fs.read'), list: unset('fs.list'), exists: unset('fs.exists'), stat: unset('fs.stat'), ...parts.fs },
    process: { run: unset('process.run'), ...parts.process },
    session: { id: unset('session.id'), cwd: unset('session.cwd'), root: unset('session.root'), model: unset('session.model'), usage: unset('session.usage'), send: unset('session.send'), ...parts.session },
    ui: {
      toast: unset('ui.toast'), invalidate: unset('ui.invalidate'), log: unset('ui.log'), ask: unset('ui.ask'), open: unset('ui.open'), close: unset('ui.close'),
      panes: unset('ui.panes'), focus: unset('ui.focus'), scroll: unset('ui.scroll'), resolve: unset('ui.resolve'), ...parts.ui,
    },
    tool: { register: unset('tool.register'), call: unset('tool.call'), check: unset('tool.check'), list: unset('tool.list'), ...parts.tool },
    state: { get: unset('state.get'), set: unset('state.set'), ...parts.state },
    command: { run: unset('command.run'), register: unset('command.register'), ...parts.command },
    prompt: { submit: unset('prompt.submit'), read: unset('prompt.read'), ...parts.prompt },
    settings: { read: unset('settings.read'), ...parts.settings },
    clock: { sleep: unset('clock.sleep'), after: unset('clock.after'), now: unset('clock.now'), every: unset('clock.every'), ...parts.clock },
  }
}
