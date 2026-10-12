// hooks/tests/fakes.ts
// A fake $ over an in-memory file system, and the capture of what a module
// registers: the handlers and their nets, matchers beside them.
export type Registration = { event: string; matcher: object | undefined; handler: Function; net: Function }

export function mount(register: (on: any) => void): Registration[] {
  const registrations: Registration[] = []
  register((...args: unknown[]) => {
    const caught: { net: Function } = { net: () => undefined }
    registrations.push({
      event: String(args[0]),
      matcher: args.length === 3 ? (args[1] as object) : undefined,
      handler: args[args.length - 1] as Function,
      net: (...call: unknown[]) => (caught.net as (...x: unknown[]) => unknown)(...call),
    })
    return { catch: (net: Function) => { caught.net = net } }
  })
  return registrations
}

// The real next is a callable carrying fields; a spread would not be callable.
export function fakeNext(failure?: string) {
  const through = (x: unknown) => ({ passed: x })
  return Object.assign(through, { called: false, error: failure ? { kind: 'failure', message: failure } : undefined })
}

export type FakeOptions = {
  env?: Record<string, string>
  files?: Record<string, string>
  pluginConfigs?: Record<string, unknown>
  run?: { exitCode: number; stdout: string; stderr: string }
  failSettings?: boolean
}

export function fakeDollar(opts: FakeOptions = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const env: Record<string, string> = { HOME: '/home/u', ...(opts.env ?? {}) }
  const ran: (readonly string[])[] = []
  const dollar = {
    env: { get: async (name: string) => env[name] },
    settings: {
      read: async () => {
        if (opts.failSettings) throw new Error('settings unavailable')
        return opts.pluginConfigs ? { pluginConfigs: opts.pluginConfigs } : {}
      },
    },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
    },
    plugin: { name: 'claude-statusbar', root: '/plugins/sb' },
    process: {
      run: async (argv: readonly string[]) => {
        ran.push(argv)
        return opts.run ?? { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, ran }
}
