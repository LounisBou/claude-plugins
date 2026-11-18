// hooks/tests/fakes.ts
import { fieldsOf, type FsStat, type ProcessRunInit, type ProcessRunResult } from '../../core/host.ts'
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
    const [a = 0, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    out += `${B64[a >> 2]}${B64[((a & 3) << 4) | ((b ?? 0) >> 4)]}`
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
      stat: async (p: string): Promise<FsStat> => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: files.get(p)!.length } },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const [verb, , from = '', to = ''] = argv
        if (verb === 'mv') { put(to, files.get(from)!); files.delete(from) }
        if (verb === 'rm') for (const path of argv.slice(2)) files.delete(path)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: { sleep: async () => undefined },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
  }
}
export const emptied = (d: ReturnType<typeof disk>) => d.history.filter(([, text]) => text === '').map(([path]) => path)
export const MEASURES = '/tmp/cfg/claude-orchestrator/measure'

/*
 * The journal a fake host writes into (observe.ts, over core's journal.ts): the events renamed into
 * `<config>/orchestrator/journal/`, each as `<kind> <code>`. Wraps a fake `$` whose fs.write and
 * process.run it observes, answering what they answer.
 */
type Journalled = {
  fs: { write?(path: string, text: string): Promise<void> }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
}
export function journalled<D extends Journalled>(dollar: D): { dollar: D; journal: () => string[] } {
  const texts = new Map<string, string>()
  const events: string[] = []
  const wrapped = {
    ...dollar,
    fs: { ...dollar.fs, write: async (path: string, text: string) => { texts.set(path, text); return dollar.fs.write?.(path, text) } },
    process: {
      ...dollar.process,
      run: async (argv: readonly string[], init?: ProcessRunInit) => {
        const to = String(argv[argv.length - 1] ?? '')
        if (argv[0] === 'mv' && to.includes('/orchestrator/journal/')) {
          const event = fieldsOf(JSON.parse(texts.get(String(argv[argv.length - 2])) ?? '{}'))
          events.push(`${String(event?.['kind'])} ${String(fieldsOf(event?.['source'])?.['code'])}`)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return init === undefined ? dollar.process.run(argv) : dollar.process.run(argv, init)
      },
    },
  }
  return { dollar: wrapped as D, journal: () => [...events] }
}

// The forge's answer to the machine file's one query (pr-file.ts prQuery), built from each
// repository's open pull requests (`[{number, createdAt, labels, mergeable, sha, base, baseSha}]`; null: the forge cannot
// be read, the call exits 1 with no data; undefined: a repository it cannot resolve, its alias null
// and the call exiting 1 with the rest of its data, as `gh api graphql` does). The open ones are the
// viewer's; a pull request asked by its number and not listed open reads `closed[n]` of the
// repository, merged when none is given. Null for a run that is no such query.
export function prQueryRun(
  argv: readonly string[], open: (repo: string) => string | null | undefined, closed: Record<string, Record<number, 'MERGED' | 'CLOSED'>> = {},
): { exitCode: number; stdout: string; stderr: string } | null {
  if (argv[0] !== 'gh' || argv[1] !== 'api' || argv[2] !== 'graphql') return null
  const query = String(argv[4] ?? '').replace(/^query=/, '')
  const data: Record<string, unknown> = { viewer: { login: 'me' }, rateLimit: { cost: 1, remaining: 4999 } }
  const errors: string[] = []
  for (const part of query.split(/(?=\br\d+:repository\()/).slice(1)) {
    const [, alias = '', owner = '', name = ''] = /^(r\d+):repository\(owner:"([^"]*)",name:"([^"]*)"\)/.exec(part) ?? []
    const repo = `${owner}/${name}`
    const listed = open(repo)
    if (listed === null) return { exitCode: 1, stdout: '', stderr: 'HTTP 502' }
    if (listed === undefined) { data[alias] = null; errors.push(`Could not resolve to a Repository with the name '${repo}'.`); continue }
    const items = JSON.parse(listed) as { number: number; createdAt?: string; labels?: { name: string }[]; mergeable?: string; sha?: string; base?: string; baseSha?: string }[]
    const node = (item: { number: number; createdAt?: string; labels?: { name: string }[]; mergeable?: string; sha?: string; base?: string; baseSha?: string }, state = 'OPEN') => ({
      number: item.number, state, isDraft: false, createdAt: item.createdAt ?? null, headRefName: `b${item.number}`, headRefOid: item.sha ?? 'a'.repeat(40),
      baseRefName: item.base ?? 'main', baseRefOid: item.baseSha ?? 'c'.repeat(40),
      mergeable: item.mergeable ?? null, author: { login: 'me' }, labels: { nodes: item.labels ?? [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    })
    const answer: Record<string, unknown> = { open: { pageInfo: { hasNextPage: false }, nodes: items.map(item => node(item)) } }
    for (const [, n = ''] of part.matchAll(/\bn(\d+):pullRequest/g)) {
      const item = items.find(i => i.number === Number(n))
      answer[`n${n}`] = item === undefined ? node({ number: Number(n) }, closed[repo]?.[Number(n)] ?? 'MERGED') : node(item)
    }
    data[alias] = answer
  }
  return errors.length === 0 ? { exitCode: 0, stdout: JSON.stringify({ data }), stderr: '' }
    : { exitCode: 1, stdout: JSON.stringify({ data, errors: errors.map(message => ({ type: 'NOT_FOUND', message })) }), stderr: `gh: ${errors.join('\n')}` }
}
