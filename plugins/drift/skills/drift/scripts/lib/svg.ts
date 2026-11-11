// drift svg — whether the standalone SVG files changed between two refs render the same pixels. Its
// command line, its lines and its exit codes are documented in the header of drift.sh.
//
// No checkout, no build, no server: the changed files are listed by `git diff --raw` between the
// two commits and each side's bytes read from the object store, written under the run directory.
// One generated Playwright spec renders every changed file of both sides in the shared Chromium, as
// an image from a data: URL, at each scale of its viewBox size and on a transparent then a white
// background, every network request aborted. Each pair is then compared byte for byte (exactDiff).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DriftError } from './compare.ts'
import { flagsOf, routeName, USAGE, type Options } from './config.ts'
import { comparePair, type Box, type Sizes } from './png.ts'
import { exec, git, interrupted, refsOf, runDirectory, type Deps } from './run.ts'
import { generate, playwrightConfig, playwrightOf, requestsFileOf } from './shots.ts'

export interface SvgOptions extends Options {
  /** The sizes rendered, as multiples of each file's own size, ascending. */
  readonly scales: readonly number[]
}

const DEFAULT_SCALES = [1, 4]
const MAX_SCALE = 16
export const BACKGROUNDS = ['transparent', 'white'] as const
export type Background = (typeof BACKGROUNDS)[number]
/** How long rendering one file of one side, at every scale, may take. */
const RENDER_TIMEOUT_MS = 60_000
/** The largest blob read from the object store. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024

export function parseSvgArgs(argv: readonly string[]): SvgOptions {
  const [command, ...rest] = argv
  if (command !== 'svg') throw new DriftError(USAGE)
  const { options, values } = flagsOf(rest, ['--scales'])
  if (options.config !== undefined) throw new DriftError('drift svg reads no config: its sizes come from --scales')
  const raw = values.get('--scales')
  if (raw === undefined) return { ...options, scales: DEFAULT_SCALES }
  const scales = raw.split(',').map(item => (item.trim() === '' ? Number.NaN : Number(item)))
  if (scales.some(scale => !Number.isFinite(scale) || scale <= 0 || scale > MAX_SCALE)) {
    throw new DriftError(`--scales must be numbers above 0 and at most ${MAX_SCALE}, separated by commas: 1,4`)
  }
  return { ...options, scales: [...new Set(scales)].sort((a, b) => a - b) }
}

export interface Change {
  readonly path: string
  readonly status: 'changed' | 'added' | 'removed'
  /** The blob on each side where the file is. */
  readonly base?: string
  readonly head?: string
}

const ABSENT = '000000'
const REGULAR = ['100644', '100755']
const RAW_RECORD = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/

/**
 * The SVG files of a `git diff --raw -z --no-renames --no-abbrev` output, sorted by path. A side
 * that is not a regular file (a symbolic link, a submodule) cannot be rendered: the path is skipped.
 */
export function changesOf(raw: string): { changes: Change[]; skipped: string[] } {
  const changes: Change[] = []
  const skipped: string[] = []
  const parts = raw.split('\0')
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const match = RAW_RECORD.exec(parts[k] ?? '')
    const path = parts[k + 1] ?? ''
    if (match === null || path === '') throw new DriftError(`an unreadable git diff record: ${JSON.stringify(parts[k])}`)
    if (!/\.svg$/i.test(path)) continue
    const [, baseMode = '', headMode = '', baseBlob = '', headBlob = ''] = match
    const sides = [[baseMode, baseBlob], [headMode, headBlob]].filter(([mode]) => mode !== ABSENT)
    if (sides.some(([mode]) => !REGULAR.includes(mode ?? ''))) {
      skipped.push(path)
      continue
    }
    if (baseMode === ABSENT) changes.push({ path, status: 'added', head: headBlob })
    else if (headMode === ABSENT) changes.push({ path, status: 'removed', base: baseBlob })
    else changes.push({ path, status: 'changed', base: baseBlob, head: headBlob })
  }
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return { changes: changes.sort((a, b) => byPath(a.path, b.path)), skipped: skipped.sort(byPath) }
}

/** Where an SVG names another resource: an attribute, a CSS url(), an @import of a string. */
const REFERENCES = [/\bhref\s*=\s*(["'])(.*?)\1/g, /\bsrc\s*=\s*(["'])(.*?)\1/g, /url\(\s*(["']?)(.*?)\1\s*\)/g, /@import\s+(["'])(.*?)\1/g]

/** The resources an SVG text names outside itself, sorted: neither a fragment of the file nor a data: URL. */
export function externalRefs(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of REFERENCES) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[2] ?? '').trim()
      if (value !== '' && !value.startsWith('#') && !/^data:/i.test(value)) found.add(value)
    }
  }
  return [...found].sort()
}

export interface SvgPair {
  readonly scale: number
  readonly background: Background
  readonly verdict: 'identical' | 'differ'
  readonly pixels?: number
  readonly box?: Box
  readonly size?: Sizes
  /** The diff image, relative to the run directory. */
  readonly diff?: string
}

export interface SvgFile {
  readonly path: string
  readonly verdict: 'identical' | 'differ' | 'added' | 'removed'
  /** For a file on both sides: whether its bytes differ (a mode change alone leaves them the same). */
  readonly text?: 'same' | 'differs'
  readonly pairs?: readonly SvgPair[]
}

export interface SvgReport {
  readonly version: 1
  readonly verdict: 'identical' | 'differ'
  /** The files added, removed, or rendering differently. */
  readonly differ: number
  readonly scales: readonly number[]
  readonly base: { readonly ref: string; readonly sha: string }
  readonly head: { readonly ref: string; readonly sha: string }
  readonly files: readonly SvgFile[]
  /** The resources the files name outside themselves, on either side: never fetched. */
  readonly external: ReadonlyArray<{ readonly path: string; readonly url: string }>
  /** The paths not compared: one side is not a regular file. */
  readonly skipped: readonly string[]
  /** Requests a rendering made, aborted. */
  readonly blocked: readonly string[]
}

/** The report as text: the verdict first, one line per file and per differing rendering, what was left out, the refs last. */
export function renderSvg(report: SvgReport): string[] {
  const lines = [report.verdict === 'identical' ? 'drift: identical' : `drift: ${report.differ} differ`]
  if (report.files.length === 0) lines.push('no SVG file changed')
  for (const file of report.files) {
    if (file.verdict === 'added' || file.verdict === 'removed') {
      lines.push(`${file.verdict} ${file.path}`)
      continue
    }
    if (file.verdict === 'identical') {
      lines.push(`${file.path}: identical${file.text === 'differs' ? ' (text differs)' : ''}`)
      continue
    }
    for (const pair of file.pairs ?? []) {
      if (pair.verdict === 'identical') continue
      const box = pair.box === undefined ? '' : ` in ${pair.box.x},${pair.box.y},${pair.box.width},${pair.box.height}`
      const size = pair.size === undefined ? '' : ` (size ${pair.size.base.join('x')} → ${pair.size.head.join('x')})`
      lines.push(`${file.path} @${pair.scale}x ${pair.background}: ${pair.pixels ?? 0} px differ${box}${size}, diff ${pair.diff ?? 'none'}`)
    }
  }
  for (const { path, url } of report.external) lines.push(`external: ${path} ${url}`)
  for (const path of report.skipped) lines.push(`skipped: ${path} (not a regular file)`)
  for (const url of report.blocked) lines.push(`blocked: ${url}`)
  lines.push(`base ${report.base.sha.slice(0, 7)} (${report.base.ref}), head ${report.head.sha.slice(0, 7)} (${report.head.ref})`)
  return lines
}

/** A blob's bytes, read from the object store. */
function blobOf(top: string, blob: string, signal: AbortSignal | undefined): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile('git', ['-C', top, 'cat-file', 'blob', blob], { encoding: 'buffer', maxBuffer: MAX_BLOB_BYTES, ...(signal === undefined ? {} : { signal }) }, (error, stdout) => {
      if (error === null) done(stdout)
      else fail(new DriftError(`blob ${blob} could not be read: ${error.message.split('\n')[0] ?? ''}`))
    })
  })
}

interface Item {
  readonly side: 'base' | 'head'
  readonly name: string
  readonly path: string
  readonly file: string
  readonly out: string
}

/** Renders every item in one Playwright run; a tool error naming the first file of either side that could not be rendered. */
async function renderAll(run: string, items: readonly Item[], scales: readonly number[], deps: Deps): Promise<string[]> {
  const playwright = playwrightOf(deps)
  const spec = join(run, 'spec')
  mkdirSync(spec, { recursive: true })
  writeFileSync(join(spec, 'svg.spec.cjs'), generate('svg.pw.cjs', playwright))
  writeFileSync(join(spec, 'svg.config.cjs'), playwrightConfig(spec, 'svg.spec.cjs', join(spec, 'svg-results'), RENDER_TIMEOUT_MS))
  const plan = join(spec, 'svg.json')
  writeFileSync(plan, `${JSON.stringify({ scales, backgrounds: BACKGROUNDS, items }, null, 2)}\n`)
  const log = join(run, 'render.log')
  writeFileSync(log, '')
  const ran = await exec([process.execPath, playwright.cli, 'test', '--config', join(spec, 'svg.config.cjs')], spec, deps.signal, log, { ...playwright.env, DRIFT_PLAN: plan, FORCE_COLOR: '0' })
  interrupted(deps.signal)
  for (const item of items) {
    const error = join(item.out, `${item.name}.error.txt`)
    if (existsSync(error)) throw new DriftError(`${item.side}: ${item.path}: ${readFileSync(error, 'utf8').trim()}`)
  }
  const rendered = items.every(item => scales.every(scale => BACKGROUNDS.every(background => existsSync(join(item.out, `${item.name}@${scale}x-${background}.png`)))))
  if (ran.status !== 0 || !rendered) throw new DriftError(`the rendering failed (exit ${ran.status ?? 'none'}); its log: ${log}`)
  const blocked = new Set<string>()
  for (const item of items) for (const url of requestsFileOf(JSON.parse(readFileSync(join(item.out, `${item.name}.requests.json`), 'utf8'))).blocked) blocked.add(url)
  return [...blocked].sort()
}

/** `drift svg`: renders the SVG files changed between both refs and compares them; 0 identical, 1 differ, a tool error when it cannot answer. */
export async function svg(argv: readonly string[], deps: Deps): Promise<number> {
  const options = parseSvgArgs(argv)
  playwrightOf(deps)
  const { top, baseSha, headSha } = await refsOf(options, deps)
  const raw = await git(top, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', baseSha, headSha], deps.signal)
  if (raw === undefined) throw new DriftError(`git diff ${baseSha.slice(0, 7)} ${headSha.slice(0, 7)} failed`)
  const { changes, skipped } = changesOf(raw)
  const run = runDirectory(options.out, deps)
  for (const dir of ['svg', 'base', 'head', 'diff', 'spec']) rmSync(join(run, dir), { recursive: true, force: true })
  for (const dir of [join('svg', 'base'), join('svg', 'head'), 'base', 'head', 'diff']) mkdirSync(join(run, dir), { recursive: true })
  const items: Item[] = []
  const external: Array<{ path: string; url: string }> = []
  const names = changes.map((change, k) => `${k}-${routeName(change.path)}`)
  for (const [k, change] of changes.entries()) {
    const urls = new Set<string>()
    for (const side of ['base', 'head'] as const) {
      const blob = change[side]
      if (blob === undefined) continue
      const bytes = await blobOf(top, blob, deps.signal)
      interrupted(deps.signal)
      for (const url of externalRefs(bytes.toString('utf8'))) urls.add(url)
      if (change.status !== 'changed' || change.base === change.head) continue
      const file = join(run, 'svg', side, `${names[k] ?? ''}.svg`)
      writeFileSync(file, bytes)
      items.push({ side, name: names[k] ?? '', path: change.path, file, out: join(run, side) })
    }
    for (const url of [...urls].sort()) external.push({ path: change.path, url })
  }
  const blocked = items.length === 0 ? [] : await renderAll(run, items, options.scales, deps)
  const files: SvgFile[] = changes.map((change, k): SvgFile => {
    if (change.status !== 'changed') return { path: change.path, verdict: change.status }
    if (change.base === change.head) return { path: change.path, verdict: 'identical', text: 'same' }
    const name = names[k] ?? ''
    const pairs = options.scales.flatMap(scale => BACKGROUNDS.map((background): SvgPair => {
      const png = `${name}@${scale}x-${background}.png`
      const compared = comparePair(readFileSync(join(run, 'base', png)), readFileSync(join(run, 'head', png)))
      if (compared.verdict === 'identical') return { scale, background, verdict: 'identical' }
      writeFileSync(join(run, 'diff', png), compared.image)
      const { image: _image, ...found } = compared
      return { scale, background, ...found, diff: `diff/${png}` }
    }))
    return { path: change.path, verdict: pairs.some(pair => pair.verdict === 'differ') ? 'differ' : 'identical', text: 'differs', pairs }
  })
  const differ = files.filter(file => file.verdict !== 'identical').length
  const report: SvgReport = {
    version: 1,
    verdict: differ === 0 ? 'identical' : 'differ',
    differ,
    scales: options.scales,
    base: { ref: options.base, sha: baseSha },
    head: { ref: options.head, sha: headSha },
    files,
    external,
    skipped,
    blocked,
  }
  const lines = renderSvg(report)
  writeFileSync(join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(run, 'report.txt'), `${lines.join('\n')}\n`)
  for (const line of lines) deps.out(line)
  deps.out(`out: ${run}`)
  return differ === 0 ? 0 : 1
}
