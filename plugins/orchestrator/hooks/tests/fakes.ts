// hooks/tests/fakes.ts
// What every fake $ answers the same way: the module's log line, appended through
// hooks/log-append.sh by $.process.run (module-log.ts) — never a $.fs write. A fake
// hands each run here first; a log run is captured and answered, anything else is the
// fake's own.
export function logLineOf(argv: readonly string[]): string | null {
  return argv[0] === 'sh' && String(argv[1] ?? '').endsWith('/hooks/log-append.sh') ? String(argv[3] ?? '') : null
}

// A transcript window as the module asks it (session-name.ts blockArgv): dd's block,
// base64 on the way out. The fake answers from the text it is handed, cut as bytes —
// the same cut dd makes — or null for a run that is no block read.
export function blockOf(argv: readonly string[], textOf: (path: string) => string): string | null {
  if (argv[0] !== 'sh' || !String(argv[2] ?? '').startsWith('dd ')) return null
  const [path, bs, skip] = [String(argv[4]), Number(argv[5]), Number(argv[6])]
  return base64Of(new TextEncoder().encode(textOf(path)).slice(skip * bs, (skip + 1) * bs))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64Of(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out + '\n'
}

// The store's lock as the module takes it (core's takeLockArgv, `sh -c '… set -C …' sh <path>.lock`):
// an exclusive create, played over the fake's own file map — taken when no file holds the path,
// refused while one does. The lock's release is the module's `rm -f <path>.lock`, which the
// fake's rm answers; null for a run that is no lock.
export function lockRun(argv: readonly string[], files: Map<string, string>): { exitCode: number; stdout: string; stderr: string } | null {
  if (argv[0] !== 'sh' || argv[1] !== '-c' || !String(argv[2] ?? '').includes('set -C')) return null
  const lock = String(argv[4])
  if (files.has(lock)) return { exitCode: 1, stdout: '', stderr: `${lock}: file exists` }
  files.set(lock, '1\n')
  return { exitCode: 0, stdout: '', stderr: '' }
}

// A disk the gauge's I/O runs over: fs.write lands in place (as the host's does, not atomic), the
// store's rename and remove arrive through process.run as `mv -f` and `rm -f`. `history` keeps every
// state a path took, so a test sees a file that was ever empty, not only the last state.
export function disk(files: Map<string, string> = new Map()) {
  const history: [string, string][] = []
  const inPlace: string[] = []
  const put = (path: string, text: string) => { files.set(path, text); history.push([path, text]) }
  return {
    files, history, inPlace,
    fs: {
      write: async (p: string, text: string) => { if (!p.includes('.tmp-')) inPlace.push(p); put(p, text) },
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { size: files.get(p)!.length } },
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'mv') { put(argv[3], files.get(argv[2])!); files.delete(argv[2]) }
        if (argv[0] === 'rm') for (const path of argv.slice(2)) files.delete(path)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: { sleep: async () => undefined },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
  }
}
export const emptied = (d: ReturnType<typeof disk>) => d.history.filter(([, text]) => text === '').map(([path]) => path)
export const MEASURES = '/tmp/cfg/claude-orchestrator/measure'
