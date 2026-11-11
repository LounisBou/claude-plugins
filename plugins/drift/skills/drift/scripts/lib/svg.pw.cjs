// drift svg's rendering, a Playwright spec: `drift svg` copies it into the run directory, with the
// path of the shared Playwright install in place of its placeholder. Its plan (the scales, the
// backgrounds, one item per file and side) is the JSON file named by DRIFT_PLAN. Each item is one
// test: the file parsed as XML, its size read from its viewBox (else its width and height in px,
// else 300x150, a browser's default), then shown as an image from a data: URL, which runs no script
// and loads nothing, at each scale and on each background, written to
// `<out>/<name>@<scale>x-<background>.png`. Any request is aborted and listed in
// `<name>.requests.json`; on failure the first line of the error goes to `<name>.error.txt`.
'use strict'
const { test } = require(__PLAYWRIGHT_MODULE__)
const fs = require('node:fs')
const path = require('node:path')

const plan = JSON.parse(fs.readFileSync(process.env.DRIFT_PLAN, 'utf8'))

const PAGE = '<!doctype html><html><head><style>html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; } img { display: block; }</style></head><body><img alt=""></body></html>'

/** In the page: the file's size, or why it is not an SVG. */
function shapeOf(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error !== undefined) return { error: `not an SVG: ${(error.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)}` }
  const root = doc.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') return { error: `not an SVG: its root is <${root.nodeName}>, not <svg> in the SVG namespace` }
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] }
  const length = name => {
    const match = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(root.getAttribute(name) || '')
    return match === null ? 0 : Number(match[1])
  }
  if (length('width') > 0 && length('height') > 0) return { width: length('width'), height: length('height') }
  return { width: 300, height: 150 }
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
      for (const scale of plan.scales) {
        const width = Math.max(1, Math.round(shape.width * scale))
        const height = Math.max(1, Math.round(shape.height * scale))
        await page.setViewportSize({ width, height })
        await page.setContent(PAGE)
        const shown = await page.evaluate(async ({ src, width, height }) => {
          const img = document.querySelector('img')
          img.width = width
          img.height = height
          img.src = src
          try {
            await img.decode()
            return true
          } catch {
            return false
          }
        }, { src, width, height })
        if (!shown) throw new Error('not an SVG: the browser does not render it')
        for (const background of plan.backgrounds) {
          await page.evaluate(colour => { document.documentElement.style.background = colour; document.body.style.background = colour }, background)
          const png = await page.screenshot({ clip: { x: 0, y: 0, width, height }, omitBackground: background === 'transparent', animations: 'disabled', scale: 'css' })
          fs.writeFileSync(path.join(item.out, `${item.name}@${scale}x-${background}.png`), png)
        }
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
