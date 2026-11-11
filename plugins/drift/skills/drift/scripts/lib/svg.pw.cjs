// drift svg's rendering, a Playwright spec: `drift svg` copies it into the run directory, with the
// path of the shared Playwright install in place of its placeholder. Its plan (one item per file
// and side, each with the renderings to write) is the JSON file named by DRIFT_PLAN. Each item is
// one test: the file parsed as XML, then shown as an image from a data: URL, which runs no script
// and loads nothing. Its own size is its viewBox's, else the size the browser gives it (its width
// and height, else 300x150, a browser's default, written to `<name>.shape.json` when its width or
// height could not size it). Each rendering is written to `<out>/<png>`: at a scale of that size,
// or at its intrinsic size with no size forced on the image; on a transparent or a white
// background; in the light or the dark colour scheme. Any request is aborted and listed in
// `<name>.requests.json`; on failure the first line of the error goes to `<name>.error.txt`.
'use strict'
const { test } = require(__PLAYWRIGHT_MODULE__)
const fs = require('node:fs')
const path = require('node:path')

const plan = JSON.parse(fs.readFileSync(process.env.DRIFT_PLAN, 'utf8'))

const PAGE = '<!doctype html><html><head><style>html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; } img { display: block; }</style></head><body><img alt=""></body></html>'

/** The size a browser gives an image that names none it can use. */
const DEFAULT_SIZE = { width: 300, height: 150 }

/** In the page: the file's viewBox size and the root's width and height, or why it is not an SVG. */
function shapeOf(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error !== undefined) return { error: `not an SVG: ${(error.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)}` }
  const root = doc.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') return { error: `not an SVG: its root is <${root.nodeName}>, not <svg> in the SVG namespace` }
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  const viewBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null
  return { viewBox, width: root.getAttribute('width'), height: root.getAttribute('height') }
}

/** In the page: shows the image, at `size` or at its own; its natural size, or null when the browser cannot decode it. */
async function show({ src, size }) {
  const img = document.querySelector('img')
  if (size !== null) {
    img.width = size.width
    img.height = size.height
  }
  img.src = src
  try {
    await img.decode()
  } catch {
    return null
  }
  return { width: img.naturalWidth, height: img.naturalHeight }
}

/** The root's width and height, when the browser left the file at its default size although it names one. */
function fallbackOf(shape, natural) {
  if (shape.viewBox !== null || natural.width !== DEFAULT_SIZE.width || natural.height !== DEFAULT_SIZE.height) return undefined
  const named = [['width', shape.width], ['height', shape.height]].filter(([, value]) => value !== null && !/^\s*\d+(\.\d+)?(px)?\s*$/.test(value))
  return named.length === 0 ? undefined : named.map(([name, value]) => `${name} ${value.trim()}`).join(', ')
}

for (const item of plan.items) {
  test(`${item.side} ${item.name}`, async ({ browser }) => {
    const blocked = new Set()
    const context = await browser.newContext({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url())
        blocked.add(`${url.origin}${url.pathname}`)
        return route.abort('blockedbyclient')
      })
      const page = await context.newPage()
      const bytes = fs.readFileSync(item.file)
      const shape = await page.evaluate(shapeOf, bytes.toString('utf8'))
      if (shape.error !== undefined) throw new Error(shape.error)
      const src = `data:image/svg+xml;base64,${bytes.toString('base64')}`
      await page.setContent(PAGE)
      const natural = await page.evaluate(show, { src, size: null })
      if (natural === null) throw new Error('not an SVG: the browser does not decode it')
      const fallback = fallbackOf(shape, natural)
      fs.writeFileSync(path.join(item.out, `${item.name}.shape.json`), `${JSON.stringify({ natural, ...(fallback === undefined ? {} : { fallback }) })}\n`)
      const own = shape.viewBox ?? natural
      for (const render of item.renders) {
        const size = render.scale === null ? null : { width: Math.max(1, Math.round(own.width * render.scale)), height: Math.max(1, Math.round(own.height * render.scale)) }
        const shown = size ?? { width: Math.max(1, Math.ceil(natural.width)), height: Math.max(1, Math.ceil(natural.height)) }
        await page.emulateMedia({ colorScheme: render.scheme })
        await page.setViewportSize(shown)
        await page.setContent(PAGE)
        if ((await page.evaluate(show, { src, size })) === null) throw new Error('not an SVG: the browser does not decode it')
        await page.evaluate(colour => { document.documentElement.style.background = colour; document.body.style.background = colour }, render.background)
        const png = await page.screenshot({ clip: { x: 0, y: 0, ...shown }, omitBackground: render.background === 'transparent', animations: 'disabled', scale: 'css' })
        fs.writeFileSync(path.join(item.out, render.png), png)
      }
    } catch (error) {
      fs.writeFileSync(path.join(item.out, `${item.name}.error.txt`), `${String(error && error.message || error).split('\n')[0]}\n`)
      throw error
    } finally {
      fs.writeFileSync(path.join(item.out, `${item.name}.requests.json`), `${JSON.stringify({ blocked: [...blocked].sort() })}\n`)
      await context.close()
    }
  })
}
