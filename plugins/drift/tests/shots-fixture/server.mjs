// The shots fixture's server: serves public/ on the port given as its argument, and writes its
// process id to FIXTURE_PID_FILE when set, so a test can tell it was stopped.
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }
const port = Number(process.argv[2])
if (process.env.FIXTURE_PID_FILE) await writeFile(process.env.FIXTURE_PID_FILE, String(process.pid))
createServer(async (request, response) => {
  const path = normalize(new URL(request.url, 'http://x').pathname).replace(/^\/$/, '/index.html')
  try {
    const body = await readFile(join('public', path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
}).listen(port, '127.0.0.1')
