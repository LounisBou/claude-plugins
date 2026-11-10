// Two build outputs compared: file names read without their content hash, files paired by that
// name, contents compared byte for byte once the hashed names they reference are read the same
// way, and a changed file attributed to its source modules when both sides carry its map.
import { posix } from 'node:path'
import { gzipSync } from 'node:zlib'
import { changedSources, mapUrlOf, parseSourceMap, type Mapped } from './sourcemap.ts'

/**
 * Vite's and Rollup's `name-[hash].ext`: eight base64url characters after the last dash of the
 * file name, before its extension (and a `.map`). One digit or capital at least, so a word
 * (`icon-settings.svg`, `use-dropdown.js`) is never read as a hash.
 */
export const DEFAULT_HASH_PATTERN = String.raw`-(?=[A-Za-z0-9_-]{0,7}[0-9A-Z])[A-Za-z0-9_-]{8}(?=\.[A-Za-z0-9]+(?:\.map)?$)`

/** A failure of the tool itself, said on stderr with exit code 2. */
export class DriftError extends Error {}

/** A symbolic link of a build output, compared by its target. */
export interface Link {
  readonly link: string
}

/** A build output: each entry's path under the output directory (`/`-separated), with its bytes or its link. */
export type Tree = ReadonlyMap<string, Buffer | Link>

export interface Side {
  /** The file's name in that build, its hash kept. */
  readonly name: string
  /** The target, when the file is a symbolic link; its sizes are the target's. */
  readonly link?: string
  readonly raw: number
  readonly gzip: number
}

export interface FileDiff {
  /** The file's name with its hash stripped: the name both sides are paired by. */
  readonly path: string
  readonly status: 'changed' | 'added' | 'removed'
  readonly base?: Side
  readonly head?: Side
  /** Head's size minus base's, raw and gzipped. */
  readonly raw: number
  readonly gzip: number
  /** The source modules whose generated output changed, when both sides carry a readable map. */
  readonly sources?: readonly string[]
}

export interface Report {
  readonly version: 1
  readonly verdict: 'identical' | 'differ'
  readonly differ: number
  /** Pairs identical only once the hashed names they reference were read without the hash. */
  readonly normalised: number
  /** Files of either side paired by their full name, their stripped name being shared on their side. */
  readonly ambiguous: readonly string[]
  readonly hashPattern: string
  readonly base: { readonly ref: string; readonly sha: string }
  readonly head: { readonly ref: string; readonly sha: string }
  readonly files: readonly FileDiff[]
}

/** A path with the hash stripped from its file name; directories are kept as they are. */
export function stripName(path: string, hash: RegExp): string {
  const dir = posix.dirname(path)
  const name = posix.basename(path).replace(hash, '')
  return dir === '.' ? name : `${dir}/${name}`
}

/**
 * Key → name, sorted by key. A file's key is its stripped name, unless another file of the same
 * side strips to the same one (Rollup names two chunks of same-named modules alike, the hash alone
 * tells them apart): those keep their full name as their key, and are listed as ambiguous.
 */
export function keyed(paths: readonly string[], hash: RegExp): { keys: Map<string, string>; ambiguous: string[] } {
  const byKey = new Map<string, string[]>()
  for (const path of paths) {
    const key = stripName(path, hash)
    byKey.set(key, [...(byKey.get(key) ?? []), path])
  }
  const keys = new Map<string, string>()
  const ambiguous: string[] = []
  for (const [key, group] of byKey) {
    if (group.length === 1) keys.set(key, group[0] ?? key)
    else for (const path of group) {
      keys.set(path, path)
      ambiguous.push(path)
    }
  }
  return { keys: new Map([...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), ambiguous: ambiguous.sort() }
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The side's contents with every hashed file name it outputs read as its stripped name. */
function normaliser(keys: ReadonlyMap<string, string>): (bytes: Buffer) => Buffer {
  const names = new Map<string, string>()
  for (const [key, path] of keys) if (key !== path) names.set(posix.basename(path), posix.basename(key))
  if (names.size === 0) return bytes => bytes
  const pattern = new RegExp([...names.keys()].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g')
  // latin1 maps each byte to one code unit and back: the replacement leaves every other byte as it was.
  return bytes => Buffer.from(bytes.toString('latin1').replace(pattern, name => names.get(name) ?? name), 'latin1')
}

interface Read {
  readonly keys: ReadonlyMap<string, string>
  readonly tree: Tree
  readonly normalise: (bytes: Buffer) => Buffer
}

function sideOf(name: string, entry: Buffer | Link): Side {
  const bytes = Buffer.isBuffer(entry) ? entry : Buffer.from(entry.link)
  return { name, ...(Buffer.isBuffer(entry) ? {} : { link: entry.link }), raw: bytes.length, gzip: gzipSync(bytes).length }
}

/** Whether two entries are the same: a file's bytes, a link's target, never a file and a link. */
function same(before: Buffer | Link, after: Buffer | Link): boolean {
  if (Buffer.isBuffer(before) && Buffer.isBuffer(after)) return before.equals(after)
  return !Buffer.isBuffer(before) && !Buffer.isBuffer(after) && before.link === after.link
}

/**
 * The map of a generated file, by its `sourceMappingURL` (a data: URL, or a file of the output), else
 * `<file>.map`. The URL is read in the normalised text, where a hashed name reads as its key; the
 * text handed on is the raw one, whose columns the map indexes, each module's part normalised once cut.
 */
function mappedOf(read: Read, key: string): { readonly mapped: Mapped; readonly mapKey: string } | undefined {
  const bytesOf = (k: string): Buffer | undefined => {
    const path = read.keys.get(k)
    const bytes = path === undefined ? undefined : read.tree.get(path)
    return Buffer.isBuffer(bytes) ? bytes : undefined
  }
  const raw = bytesOf(key)
  if (raw === undefined) return undefined
  const text = raw.toString('utf8')
  const url = mapUrlOf(read.normalise(raw).toString('utf8'))
  let mapText: string | undefined
  let mapKey = `${key}.map`
  if (url?.startsWith('data:') === true) {
    const comma = url.indexOf(',')
    mapText = Buffer.from(url.slice(comma + 1), url.slice(0, comma).endsWith(';base64') ? 'base64' : 'utf8').toString('utf8')
    mapKey = key
  } else {
    if (url !== undefined) mapKey = posix.normalize(posix.join(posix.dirname(key), url))
    mapText = bytesOf(mapKey)?.toString('utf8')
  }
  const map = mapText === undefined ? undefined : parseSourceMap(mapText)
  const normalise = (chunk: string): string => read.normalise(Buffer.from(chunk, 'utf8')).toString('utf8')
  return map === undefined ? undefined : { mapped: { text, map, normalise }, mapKey }
}

/** The changed modules of a file both sides map, or undefined when either map is missing or unreadable. */
function attribute(base: Read, head: Read, key: string, outDir: string): readonly string[] | undefined {
  const before = mappedOf(base, key)
  const after = mappedOf(head, key)
  if (before === undefined || after === undefined) return undefined
  try {
    return changedSources(before.mapped, after.mapped, posix.join(outDir, posix.dirname(after.mapKey)))
  } catch {
    return undefined
  }
}

/** The differing files, sorted by stripped name, and how many pairs matched only once normalised. */
export function compareTrees(baseTree: Tree, headTree: Tree, hash: RegExp, outDir: string): { files: FileDiff[]; normalised: number; ambiguous: string[] } {
  const ambiguous = new Set<string>()
  const read = (tree: Tree): Read => {
    const sided = keyed([...tree.keys()], hash)
    for (const path of sided.ambiguous) ambiguous.add(path)
    return { keys: sided.keys, tree, normalise: normaliser(sided.keys) }
  }
  const base = read(baseTree)
  const head = read(headTree)
  const files: FileDiff[] = []
  let normalised = 0
  const all = [...new Set([...base.keys.keys(), ...head.keys.keys()])].sort()
  for (const key of all) {
    const basePath = base.keys.get(key)
    const headPath = head.keys.get(key)
    const before = basePath === undefined ? undefined : baseTree.get(basePath)
    const after = headPath === undefined ? undefined : headTree.get(headPath)
    if (basePath !== undefined && before !== undefined && headPath !== undefined && after !== undefined) {
      if (same(before, after)) continue
      if (Buffer.isBuffer(before) && Buffer.isBuffer(after) && base.normalise(before).equals(head.normalise(after))) {
        normalised++
        continue
      }
      const b = sideOf(basePath, before)
      const h = sideOf(headPath, after)
      const sources = key.endsWith('.map') ? undefined : attribute(base, head, key, outDir)
      files.push({ path: key, status: 'changed', base: b, head: h, raw: h.raw - b.raw, gzip: h.gzip - b.gzip, ...(sources === undefined ? {} : { sources }) })
    } else if (headPath !== undefined && after !== undefined) {
      const h = sideOf(headPath, after)
      files.push({ path: key, status: 'added', head: h, raw: h.raw, gzip: h.gzip })
    } else if (basePath !== undefined && before !== undefined) {
      const b = sideOf(basePath, before)
      files.push({ path: key, status: 'removed', base: b, raw: -b.raw, gzip: -b.gzip })
    }
  }
  return { files, normalised, ambiguous: [...ambiguous].sort() }
}

export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

/** The report as text: the verdict first, one line per file and per changed module, the refs last. */
export function render(report: Report): string[] {
  const n = report.normalised
  const verdict = report.verdict === 'identical'
    ? `drift: identical${n > 0 ? ` (hash references normalised in ${n} file${n === 1 ? '' : 's'})` : ''}`
    : `drift: ${report.differ} differ`
  const lines = [verdict]
  for (const file of report.files) {
    lines.push(`${file.status} ${file.path} raw ${signed(file.raw)} gzip ${signed(file.gzip)}`)
    for (const source of file.sources ?? []) lines.push(`  source ${source}`)
  }
  if (report.ambiguous.length > 0) {
    lines.push(`ambiguous: ${report.ambiguous.length} files paired by their hashed name`)
    for (const path of report.ambiguous) lines.push(`  ${path}`)
  }
  lines.push(`base ${report.base.sha.slice(0, 7)} (${report.base.ref}), head ${report.head.sha.slice(0, 7)} (${report.head.ref})`)
  return lines
}
