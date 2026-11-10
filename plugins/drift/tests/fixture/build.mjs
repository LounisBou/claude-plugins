// The fixture project's build, run once install.mjs has: every module of src/ on its own line of one hashed bundle, with a
// source map (one segment per line, column 0 of its module), an index.html naming the bundle, and
// public/ copied as it is. The hash covers salt.txt too, so a commit changing only the salt renames
// the bundle without changing a byte of it. A file named FAIL makes the build fail; a file named
// LINK makes dist/latest a symbolic link to the path it holds; a file named FIFO adds a named pipe.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

if (existsSync('FAIL')) {
  console.error('build failed on purpose')
  process.exit(1)
}
if (!existsSync('node_modules/.installed')) {
  console.error('not installed')
  process.exit(1)
}
const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const vlq = n => VLQ[n < 0 ? -n * 2 + 1 : n * 2]
const modules = readdirSync('src').sort()
const code = modules.map(name => readFileSync(`src/${name}`, 'utf8').trim()).join('\n')
const hash = 'H' + createHash('sha256').update(code).update(readFileSync('salt.txt')).digest('hex').slice(0, 7)
const bundle = `index-${hash}.js`
const mappings = modules.map((_, k) => [0, k === 0 ? 0 : 1, 0, 0].map(vlq).join('')).join(';')
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist/assets', { recursive: true })
writeFileSync(`dist/assets/${bundle}`, `${code}\n//# sourceMappingURL=${bundle}.map\n`)
writeFileSync(`dist/assets/${bundle}.map`, JSON.stringify({ version: 3, file: bundle, sources: modules.map(name => `../../src/${name}`), mappings }))
writeFileSync('dist/index.html', `<script type="module" src="/assets/${bundle}"></script>\n`)
cpSync('public', 'dist', { recursive: true })
if (existsSync('LINK')) symlinkSync(readFileSync('LINK', 'utf8').trim(), 'dist/latest')
if (existsSync('FIFO')) execFileSync('mkfifo', ['dist/pipe'])
