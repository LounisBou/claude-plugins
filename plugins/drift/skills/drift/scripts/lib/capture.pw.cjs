// drift shots' capture, a Playwright spec: `drift shots` copies it into the run directory, with the
// path of the shared Playwright install in place of its placeholder, and runs it once per side
// against that side's server. Its plan (routes, viewports, fixtures, hosts) is the JSON file named
// by DRIFT_PLAN. Every route at every viewport is one test writing `<out>/<route>@<width>.png`, the
// requests it blocked or found no fixture for in `<route>@<width>.requests.json`, and on failure
// the first line of its error in `<route>@<width>.error.txt`.
//
// Nothing reaches a host the plan does not name. The server's own requests and the allowed hosts'
// are fetched here without following redirects. The browser follows a redirect unrouted, so its
// whole chain is walked here first, hop by hop: one leaving the server and the allowed hosts gets
// the request aborted and its target listed. WebSockets are routed too; anything else is answered
// from the fixtures, or aborted.
'use strict'
const { test } = require(__PLAYWRIGHT_MODULE__)
const fs = require('node:fs')
const path = require('node:path')

const plan = JSON.parse(fs.readFileSync(process.env.DRIFT_PLAN, 'utf8'))
const origin = new URL(plan.url).origin
const appHost = new URL(plan.url).host

/** Every motion stopped and the caret hidden, whatever the page's own styles say. */
const STILL = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }'

/** The port a URL of each scheme means when it names none: a host listed without a port means only that one. */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }
const listed = (hosts, url) => hosts.includes(`${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`) || (url.port === '' && hosts.includes(url.hostname))

/** Whether the browser may reach `url` unrouted: the server's origin, or a host the plan allows. */
const passes = url => url.origin === origin || listed(plan.allow, url)

/** The most hops of a redirect chain walked, as many as a browser follows. */
const MAX_REDIRECTS = 20
/** The redirects that keep the method and body; the others become a GET. */
const KEEPS_METHOD = [307, 308]

/**
 * The first target of `response`'s redirect chain the browser may not reach, or undefined when
 * every hop stays: each hop fetched without following it, with the context's cookies.
 */
async function leaves(context, request, response) {
  let current = response
  let method = request.method()
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const location = current.headers()['location']
    if (current.status() < 300 || current.status() >= 400 || location === undefined) return undefined
    const target = new URL(location, current.url())
    if (!passes(target)) return target
    if (!KEEPS_METHOD.includes(current.status())) method = 'GET'
    current = await context.request.fetch(target.href, { method, maxRedirects: 0, ...(method === request.method() && request.postDataBuffer() !== null ? { data: request.postDataBuffer() } : {}) })
  }
  return undefined
}

/** A path's decoding, or undefined when it holds a malformed escape. */
function decoded(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

/** The fixture answering `method url`: `<fixtures>/<host>/<path>.<METHOD>.json`, else `<path>.json`. */
function fixtureOf(url, method) {
  if (plan.fixtures === null) return undefined
  const root = path.resolve(plan.fixtures)
  const route = decoded(url.pathname).replace(/\/+$/, '') || '/index'
  const base = path.resolve(root, url.host, `.${route}`)
  if (!base.startsWith(`${root}${path.sep}`)) return undefined
  return [`${base}.${method}.json`, `${base}.json`].find(file => fs.existsSync(file) && fs.statSync(file).isFile())
}

function cors(request) {
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }
  const asked = request.headers()
  if (asked['access-control-request-method'] !== undefined) headers['access-control-allow-methods'] = asked['access-control-request-method']
  if (asked['access-control-request-headers'] !== undefined) headers['access-control-allow-headers'] = asked['access-control-request-headers']
  return headers
}

for (const route of plan.routes) {
  for (const viewport of plan.viewports) {
    const name = `${route.name}@${viewport.width}`
    test(name, async ({ browser }) => {
      const blocked = new Set()
      const unmocked = new Set()
      const context = await browser.newContext({
        viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block',
      })
      try {
        await context.routeWebSocket(/.*/, socket => {
          const url = new URL(socket.url())
          if (url.host === appHost || listed(plan.allow, url)) return socket.connectToServer()
          blocked.add(`${url.origin}${url.pathname}`)
          return socket.close({ code: 1008, reason: 'blocked by drift shots' })
        })
        await context.route('**/*', async intercepted => {
          const request = intercepted.request()
          const url = new URL(request.url())
          if (passes(url)) {
            let response
            let away
            try {
              response = await intercepted.fetch({ maxRedirects: 0 })
              away = await leaves(context, request, response)
            } catch {
              return intercepted.abort('failed')
            }
            if (away === undefined) return intercepted.fulfill({ response })
            blocked.add(`${away.origin}${away.pathname}`)
            return intercepted.abort('blockedbyclient')
          }
          if (decoded(url.pathname) === undefined) return intercepted.fulfill({ status: 400, contentType: 'text/plain', headers: cors(request), body: 'malformed path' })
          const method = request.method()
          const answered = listed(plan.api, url) || fixtureOf(url, method) !== undefined
          if (method === 'OPTIONS' && answered) return intercepted.fulfill({ status: 204, headers: cors(request) })
          const fixture = fixtureOf(url, method)
          if (fixture !== undefined) return intercepted.fulfill({ status: 200, contentType: 'application/json', headers: cors(request), body: fs.readFileSync(fixture) })
          if (listed(plan.api, url)) {
            unmocked.add(`${method} ${url.origin}${url.pathname}`)
            return intercepted.fulfill({ status: 404, contentType: 'application/json', headers: cors(request), body: '{}' })
          }
          blocked.add(`${url.origin}${url.pathname}`)
          return intercepted.abort('blockedbyclient')
        })
        const page = await context.newPage()
        await page.clock.setFixedTime(new Date(plan.now))
        const response = await page.goto(plan.url + route.path, { waitUntil: 'networkidle', timeout: plan.timeoutMs })
        if (response !== null && (response.status() < 200 || response.status() >= 400)) throw new Error(`${route.path} answered ${response.status()}: an error page is not captured`)
        if (route.waitFor !== undefined) await page.locator(route.waitFor).first().waitFor({ state: 'visible', timeout: plan.timeoutMs })
        await page.addStyleTag({ content: STILL })
        await page.evaluate(() => document.fonts.ready)
        const ignored = plan.ignore.filter(region => region.route === undefined || region.route === route.path)
        await page.evaluate(boxes => {
          for (const [x, y, width, height] of boxes) {
            const cover = document.createElement('div')
            cover.setAttribute('data-drift-ignore', '')
            Object.assign(cover.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, zIndex: '2147483647' })
            document.documentElement.appendChild(cover)
          }
        }, ignored.filter(region => region.box !== undefined).map(region => region.box))
        const mask = [page.locator('[data-drift-ignore]'), ...ignored.filter(region => region.selector !== undefined).map(region => page.locator(region.selector))]
        const png = await page.screenshot({ fullPage: plan.fullPage, animations: 'disabled', caret: 'hide', scale: 'css', mask, maskColor: '#FF00FF', timeout: plan.timeoutMs })
        fs.writeFileSync(path.join(plan.out, `${name}.png`), png)
      } catch (error) {
        fs.writeFileSync(path.join(plan.out, `${name}.error.txt`), `${String(error && error.message || error).split('\n')[0]}\n`)
        throw error
      } finally {
        fs.writeFileSync(path.join(plan.out, `${name}.requests.json`), `${JSON.stringify({ blocked: [...blocked].sort(), unmocked: [...unmocked].sort() })}\n`)
        await context.close()
      }
    })
  }
}
