// The part of the host's module 'claude-code' the hooks import, as far as they use it: the host
// writes its own declarations beside a loaded mod, on the operator's machine, and they are no
// file of this repository, so the strict check reads these. The host's are wider, never narrower.

declare module 'claude-code' {
  // Each plugin's values in the session, declared by its own types/index.d.ts.
  interface PluginState {}

  // A named value with its initial: read, it is never undefined.
  type Atom<T> = { readonly ref: { readonly plugin: string; readonly key: string }; readonly initial: T }

  function atom<P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(
    ref: { readonly plugin: P; readonly key: K }, initial: PluginState[P][K],
  ): Atom<PluginState[P][K]>
  function read<T>($: object, atom: Atom<T>): Promise<T>
  function update<T>($: object, atom: Atom<T>, change: (value: T) => T): Promise<unknown>
}
