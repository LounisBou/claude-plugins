// drift svg — whether the standalone SVG files changed between two refs render the same pixels. Its
// command line, its lines and its exit codes are documented in the header of drift.sh.
//
// No checkout, no build, no server: the changed files are listed by `git diff --raw` between the
// two commits, renames detected, and each side's bytes read from the object store, written under
// the run directory. One generated Playwright spec renders every changed file of both sides in the
// shared Chromium, as an image from a data: URL, at each scale of its own size and at its intrinsic
// size, on a transparent then a white background, in the light and the dark colour scheme when the
// file reads it, every network request aborted. Each pair is then compared byte for byte
// (comparePair). A file whose rendering could differ unseen (animated, a symbolic link) is never
// called identical: it is unproved, and the run gives no verdict.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DriftError } from './compare.ts'
import { parseSvgArgs, routeName } from './config.ts'
import { comparePair, type Box, type Sizes } from './png.ts'
import { exec, git, interrupted, readJson, refsOf, runDirectory, type Deps } from './run.ts'
import { generate, playwrightConfig, playwrightOf, requestsFileOf } from './shots.ts'

export const BACKGROUNDS = ['transparent', 'white'] as const
export type Background = (typeof BACKGROUNDS)[number]
export type Scheme = 'light' | 'dark'
/** How long rendering one file of one side, at every size, may take. */
const RENDER_TIMEOUT_MS = 60_000
/** The largest blob read from the object store. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024

export interface Change {
  readonly path: string
  readonly status: 'changed' | 'added' | 'removed' | 'unproved'
  /** The path on the base side, when the file was renamed. */
  readonly from?: string
  /** The blob on each side where the file is. */
  readonly base?: string
  readonly head?: string
  /** Why an unproved file cannot be compared. */
  readonly why?: string
}

const ABSENT = '000000'
const REGULAR = ['100644', '100755']
const SYMLINK = '120000'
const SUBMODULE = '160000'
const RAW_RECORD = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/
const isSvg = (path: string): boolean => /\.svg$/i.test(path)

/** Why a side of this mode cannot be rendered, or undefined for a regular file. */
function notRegular(mode: string): string | undefined {
  if (REGULAR.includes(mode)) return undefined
  if (mode === SYMLINK) return 'symlink'
  if (mode === SUBMODULE) return 'submodule'
  return `not a regular file (mode ${mode})`
}

/**
 * The SVG files of a `git diff --raw -z -M --no-abbrev` output, sorted by path. A renamed file is
 * listed under its new name; renamed from or to another type, it is added or removed. A side that
 * is not a regular file (a symbolic link, a submodule) cannot be rendered: the file is unproved.
 */
export function changesOf(raw: string): Change[] {
  const changes: Change[] = []
  const parts = raw.split('\0')
  let k = 0
  while (k + 1 < parts.length) {
    const record = parts[k] ?? ''
    const match = RAW_RECORD.exec(record)
    if (match === null) throw new DriftError(`an unreadable git diff record: ${JSON.stringify(record)}`)
    const [, recordBase = '', recordHead = '', baseBlob = '', headBlob = '', status = ''] = match
    const paired = status === 'R' || status === 'C'
    const from = parts[k + 1] ?? ''
    const path = paired ? (parts[k + 2] ?? '') : from
    k += paired ? 3 : 2
    if (from === '' || path === '') throw new DriftError(`an unreadable git diff record: ${JSON.stringify(record)}`)
    if (!isSvg(from) && !isSvg(path)) continue
    // A file renamed from another type is added; one renamed to another type is removed.
    const baseMode = isSvg(from) ? recordBase : ABSENT
    const headMode = isSvg(path) ? recordHead : ABSENT
    const shown = headMode === ABSENT ? from : path
    const why = [baseMode, headMode].filter(mode => mode !== ABSENT).map(notRegular).find(reason => reason !== undefined)
    if (why !== undefined) changes.push({ path: shown, status: 'unproved', why })
    else if (baseMode === ABSENT) changes.push({ path, status: 'added', head: headBlob })
    else if (headMode === ABSENT) changes.push({ path: from, status: 'removed', base: baseBlob })
    else changes.push({ path, status: 'changed', ...(from === path ? {} : { from }), base: baseBlob, head: headBlob })
  }
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return changes.sort((a, b) => byPath(a.path, b.path))
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

/** SMIL elements, a CSS animation: a still rendering proves nothing about the frames after it. */
const ANIMATION = [/<(?:[\w-]+:)?(?:animate|animateTransform|animateMotion|animateColor|set)\b/, /@keyframes\b|\banimation(?:-name)?\s*:/i]

export const isAnimated = (text: string): boolean => ANIMATION.some(pattern => pattern.test(text))

/** The colour schemes a text is rendered in: the dark one too when it reads the preference. */
export const schemesOf = (text: string): readonly Scheme[] => (/prefers-color-scheme/i.test(text) ? ['light', 'dark'] : ['light'])

export interface SvgPair {
  /** A multiple of the file's own size, or its intrinsic size, no size forced on the image. */
  readonly scale: number | 'intrinsic'
  readonly background: Background
  /** For a file rendered in both colour schemes: this rendering's. */
  readonly scheme?: Scheme
  readonly verdict: 'identical' | 'differ'
  readonly pixels?: number
  readonly box?: Box
  readonly size?: Sizes
  /** The diff image, relative to the run directory. */
  readonly diff?: string
}

export interface SvgFile {
  readonly path: string
  readonly verdict: 'identical' | 'differ' | 'added' | 'removed' | 'unproved'
  /** The path on the base side, when the file was renamed. */
  readonly from?: string
  /** Why an unproved file cannot be compared. */
  readonly why?: string
  /** For a file on both sides: whether its bytes differ (a mode change or a rename alone leaves them the same). */
  readonly text?: 'same' | 'differs'
  /** Set when the resources the file names outside itself differ between the sides: never fetched, so it differs. */
  readonly external?: 'changed'
  /** The root's width and height the browser could not size, the file drawn at its default 300x150. */
  readonly fallback?: string
  readonly pairs?: readonly SvgPair[]
}

export interface SvgReport {
  readonly version: 1
  /** `unproved` when a file could not be compared: no verdict then, exit 2. */
  readonly verdict: 'identical' | 'differ' | 'unproved'
  /** The files added, removed, or rendering differently. */
  readonly differ: number
  /** The files that could not be compared. */
  readonly unproved: number
  readonly scales: readonly number[]
  readonly base: { readonly ref: string; readonly sha: string }
  readonly head: { readonly ref: string; readonly sha: string }
  readonly files: readonly SvgFile[]
  /** The resources the files name outside themselves, on either side: never fetched. */
  readonly external: ReadonlyArray<{ readonly path: string; readonly url: string }>
  /** Requests a rendering made, aborted. */
  readonly blocked: readonly string[]
}

/** How a rendering is named in a line: `@1x white`, `@intrinsic transparent dark`. */
const pairName = (pair: Pick<SvgPair, 'scale' | 'background' | 'scheme'>): string =>
  `@${pair.scale === 'intrinsic' ? 'intrinsic' : `${pair.scale}x`} ${pair.background}${pair.scheme === undefined ? '' : ` ${pair.scheme}`}`

/** The report as text: the verdict first, one line per file and per differing rendering, what was left out, the refs last. */
export function renderSvg(report: SvgReport): string[] {
  const verdict = report.verdict === 'unproved' ? `drift: no verdict, ${report.unproved} unproved` : report.verdict === 'identical' ? 'drift: identical' : `drift: ${report.differ} differ`
  const lines = [verdict]
  if (report.files.length === 0) lines.push('no SVG file changed')
  for (const file of report.files) {
    if (file.verdict === 'added' || file.verdict === 'removed') {
      lines.push(`${file.verdict} ${file.path}`)
      continue
    }
    if (file.verdict === 'unproved') {
      lines.push(`unproved: ${file.path} — ${file.why ?? 'unknown'}`)
      continue
    }
    const notes = [...(file.text === 'differs' ? ['text differs'] : []), ...(file.from === undefined ? [] : [`renamed from ${file.from}`])]
    if (file.verdict === 'identical') {
      lines.push(`${file.path}: identical${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`)
      continue
    }
    if (file.external === 'changed') lines.push(`${file.path}: differ, external reference changed`)
    for (const pair of file.pairs ?? []) {
      if (pair.verdict === 'identical') continue
      const box = pair.box === undefined ? '' : ` in ${pair.box.x},${pair.box.y},${pair.box.width},${pair.box.height}`
      const size = pair.size === undefined ? '' : ` (size ${pair.size.base.join('x')} → ${pair.size.head.join('x')})`
      lines.push(`${file.path} ${pairName(pair)}: ${pair.pixels ?? 0} px differ${box}${size}, diff ${pair.diff ?? 'none'}`)
    }
  }
  for (const file of report.files) if (file.fallback !== undefined) lines.push(`fallback: ${file.path} 300x150 (${file.fallback})`)
  for (const { path, url } of report.external) lines.push(`external: ${path} ${url}`)
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

/** One rendering of a file: its PNG's name, its size (a scale, or null for the intrinsic size), its background and colour scheme. */
export interface Render {
  readonly png: string
  readonly scale: number | null
  readonly background: Background
  readonly scheme: Scheme
}

/** Every rendering of a file, in the report's order: each scale then the intrinsic size, each scheme, each background. */
export function rendersOf(name: string, scales: readonly number[], schemes: readonly Scheme[]): Render[] {
  return [...scales, null].flatMap(scale => schemes.flatMap(scheme => BACKGROUNDS.map(background => ({
    png: `${name}@${scale === null ? 'intrinsic' : `${scale}x`}-${background}${schemes.length > 1 ? `-${scheme}` : ''}.png`, scale, background, scheme,
  }))))
}

export interface Item {
  readonly side: 'base' | 'head'
  readonly name: string
  readonly path: string
  readonly file: string
  readonly out: string
  readonly renders: readonly Render[]
}

/**
 * After the rendering run: a tool error naming the first file of either side that could not be
 * rendered, else one for the run itself when it failed or left a rendering out.
 */
export function checkRendered(items: readonly Item[], status: number | null, log: string): void {
  for (const item of items) {
    const error = join(item.out, `${item.name}.error.txt`)
    if (existsSync(error)) throw new DriftError(`${item.side}: ${item.path}: ${readFileSync(error, 'utf8').trim()}`)
  }
  const rendered = items.every(item => item.renders.every(render => existsSync(join(item.out, render.png))))
  if (status !== 0 || !rendered) throw new DriftError(`the rendering failed (exit ${status ?? 'none'}); its log: ${log}`)
}

/** Renders every item in one Playwright run; the requests it aborted. */
async function renderAll(run: string, items: readonly Item[], deps: Deps): Promise<string[]> {
  const playwright = playwrightOf(deps)
  const spec = join(run, 'spec')
  mkdirSync(spec, { recursive: true })
  writeFileSync(join(spec, 'svg.spec.cjs'), generate('svg.pw.cjs', playwright))
  writeFileSync(join(spec, 'svg.config.cjs'), playwrightConfig(spec, 'svg.spec.cjs', join(spec, 'svg-results'), RENDER_TIMEOUT_MS))
  const plan = join(spec, 'svg.json')
  writeFileSync(plan, `${JSON.stringify({ items }, null, 2)}\n`)
  const log = join(run, 'render.log')
  writeFileSync(log, '')
  const ran = await exec([process.execPath, playwright.cli, 'test', '--config', join(spec, 'svg.config.cjs')], spec, deps.signal, log, { ...playwright.env, DRIFT_PLAN: plan, FORCE_COLOR: '0' })
  interrupted(deps.signal)
  checkRendered(items, ran.status, log)
  const blocked = new Set<string>()
  for (const item of items) for (const url of requestsFileOf(readJson(join(item.out, `${item.name}.requests.json`))).blocked) blocked.add(url)
  return [...blocked].sort()
}

/** Whether a report.json is drift svg's own: one of its runs may be overwritten, another command's never. */
const isSvgReport = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['files']) && Array.isArray((raw as Record<string, unknown>)['scales'])

/** The run directory, emptied of a previous svg run's report first; a tool error when it holds another command's run. */
function svgRunDirectory(out: string | undefined, deps: Deps): string {
  const run = runDirectory(out, deps)
  const previous = join(run, 'report.json')
  if (existsSync(previous) && !isSvgReport(readJson(previous))) throw new DriftError(`--out ${run} holds another command's run: name a new directory`)
  for (const entry of ['report.json', 'report.txt', 'svg', 'base', 'head', 'diff', 'spec', 'render.log']) rmSync(join(run, entry), { recursive: true, force: true })
  for (const dir of [join('svg', 'base'), join('svg', 'head'), 'base', 'head', 'diff']) mkdirSync(join(run, dir), { recursive: true })
  return run
}

/** What one changed file needs before rendering: its renderings, and why it differs or cannot be compared without them. */
interface Plan {
  readonly change: Change
  readonly name: string
  readonly renders: readonly Render[]
  readonly unproved?: string
  readonly external?: 'changed'
}

/** One file's pairs, compared, their diff images written. */
function pairsOf(run: string, renders: readonly Render[]): SvgPair[] {
  const schemes = new Set(renders.map(render => render.scheme)).size
  return renders.map((render): SvgPair => {
    const at = { scale: render.scale ?? 'intrinsic', background: render.background, ...(schemes > 1 ? { scheme: render.scheme } : {}) } as const
    const compared = comparePair(readFileSync(join(run, 'base', render.png)), readFileSync(join(run, 'head', render.png)))
    if (compared.verdict === 'identical') return { ...at, verdict: 'identical' }
    writeFileSync(join(run, 'diff', render.png), compared.image)
    const { image: _image, ...found } = compared
    return { ...at, ...found, diff: `diff/${render.png}` }
  })
}

/** The root's width and height the browser left at its default size, from either side's shape file. */
function fallbackOf(run: string, name: string): string | undefined {
  for (const side of ['base', 'head']) {
    const shape = join(run, side, `${name}.shape.json`)
    if (!existsSync(shape)) continue
    const raw = readJson(shape)
    const fallback = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['fallback'] : undefined
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

/** `drift svg`: renders the SVG files changed between both refs and compares them; 0 identical, 1 differ, 2 unproved or a tool error. */
export async function svg(argv: readonly string[], deps: Deps): Promise<number> {
  const options = parseSvgArgs(argv)
  playwrightOf(deps)
  const { top, baseSha, headSha } = await refsOf(options, deps)
  const raw = await git(top, ['diff', '--raw', '-z', '-M', '--no-abbrev', baseSha, headSha], deps.signal)
  if (raw === undefined) throw new DriftError(`git diff ${baseSha.slice(0, 7)} ${headSha.slice(0, 7)} failed`)
  const changes = changesOf(raw)
  const run = svgRunDirectory(options.out, deps)
  const items: Item[] = []
  const external: Array<{ path: string; url: string }> = []
  const plans: Plan[] = []
  for (const [k, change] of changes.entries()) {
    const name = `${k}-${routeName(change.path)}`
    const texts: Partial<Record<'base' | 'head', string>> = {}
    const urls = new Set<string>()
    for (const side of ['base', 'head'] as const) {
      const blob = change[side]
      if (blob === undefined) continue
      const bytes = await blobOf(top, blob, deps.signal)
      interrupted(deps.signal)
      texts[side] = bytes.toString('utf8')
      for (const url of externalRefs(texts[side])) urls.add(url)
      if (change.status === 'changed' && change.base !== change.head) writeFileSync(join(run, 'svg', side, `${name}.svg`), bytes)
    }
    for (const url of [...urls].sort()) external.push({ path: change.path, url })
    if (change.status !== 'changed' || change.base === change.head) {
      plans.push({ change, name, renders: [] })
      continue
    }
    const sides = [texts.base ?? '', texts.head ?? '']
    if (sides.some(isAnimated)) {
      plans.push({ change, name, renders: [], unproved: 'animated' })
      continue
    }
    const renders = rendersOf(name, options.scales, sides.some(text => schemesOf(text).length > 1) ? ['light', 'dark'] : ['light'])
    const refsChanged = JSON.stringify(externalRefs(sides[0] ?? '')) !== JSON.stringify(externalRefs(sides[1] ?? ''))
    plans.push({ change, name, renders, ...(refsChanged ? { external: 'changed' as const } : {}) })
    for (const side of ['base', 'head'] as const) items.push({ side, name, path: change.path, file: join(run, 'svg', side, `${name}.svg`), out: join(run, side), renders })
  }
  const blocked = items.length === 0 ? [] : await renderAll(run, items, deps)
  const files = plans.map(({ change, name, renders, unproved, external: refs }): SvgFile => {
    const from = change.from === undefined ? {} : { from: change.from }
    if (change.status === 'unproved') return { path: change.path, verdict: 'unproved', why: change.why ?? 'unknown' }
    if (change.status !== 'changed') return { path: change.path, verdict: change.status }
    if (unproved !== undefined) return { path: change.path, verdict: 'unproved', ...from, why: unproved }
    if (change.base === change.head) return { path: change.path, verdict: 'identical', ...from, text: 'same' }
    const pairs = pairsOf(run, renders)
    const fallback = fallbackOf(run, name)
    const differs = refs === 'changed' || pairs.some(pair => pair.verdict === 'differ')
    return {
      path: change.path, verdict: differs ? 'differ' : 'identical', ...from, text: 'differs',
      ...(refs === undefined ? {} : { external: refs }), ...(fallback === undefined ? {} : { fallback }), pairs,
    }
  })
  const differ = files.filter(file => file.verdict !== 'identical' && file.verdict !== 'unproved').length
  const unproved = files.filter(file => file.verdict === 'unproved').length
  const report: SvgReport = {
    version: 1,
    verdict: unproved > 0 ? 'unproved' : differ === 0 ? 'identical' : 'differ',
    differ,
    unproved,
    scales: options.scales,
    base: { ref: options.base, sha: baseSha },
    head: { ref: options.head, sha: headSha },
    files,
    external,
    blocked,
  }
  const lines = renderSvg(report)
  writeFileSync(join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(run, 'report.txt'), `${lines.join('\n')}\n`)
  for (const line of lines) deps.out(line)
  deps.out(`out: ${run}`)
  return unproved > 0 ? 2 : differ === 0 ? 0 : 1
}
