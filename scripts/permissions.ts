// The permission rules of docs/conventions.md (« Permissions and security »), checked: no
// committed settings file grants a permission, and a plugin that writes a permission rule into
// the operator's settings is listed in the installer rules of docs/contracts.md, where the
// validation its script performs is written beside the rule.
//
//   npm run permissions
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, PLUGINS_DIR } from './lib/plugins.ts'

const SETTINGS = new Set(['settings.json', 'settings.local.json'])
const SKIPPED = new Set(['node_modules', '.git'])
const SOURCE = /\.(sh|py|ts|js|mjs)$/
// The spellings of a write to the allow list: jq, Python, JavaScript.
const WRITES_RULE = /\.permissions\.allow\s*=|\["permissions"\]\s*\[\s*"allow"\s*\]\s*(\.append|=|\+=)|permissions\.allow\.push\(|\.setdefault\(\s*"allow"/

function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** Whether a settings file's text grants a permission: a `permissions` object with any key. */
export function grantsPermission(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  const permissions = isRecord(parsed) ? parsed['permissions'] : undefined
  return isRecord(permissions) && Object.keys(permissions).length > 0
}

/** Whether a source file writes a rule into a permission allow list. */
export const writesRule = (source: string): boolean => WRITES_RULE.test(source)

/** The plugins the installer rules table of contracts.md lists, by its « Plugin » column. */
export function listedInstallers(contracts: string): string[] {
  const section = contracts.split(/^## /m).find(part => part.startsWith('Installer permission rules')) ?? ''
  return section.split('\n')
    .filter(line => line.startsWith('|') && !/^\|\s*(Rule|---)/.test(line))
    .map(line => (line.split('|')[2] ?? '').trim())
    .filter(name => name !== '')
}

/** A test file is no rule written: its fixtures spell the writes they test. */
const isTest = (path: string): boolean => /(^|[/.])tests?[/.]|\.test\.|(^|\/)test_[^/]*\.py$|conftest\.py$/.test(path)

export function run(root: string, _args: readonly string[], io: Io): number {
  const faults: string[] = []
  const files = filesUnder(root).map(path => relative(root, path))
  for (const file of files.filter(path => SETTINGS.has(basename(path)))) {
    if (grantsPermission(readFileSync(join(root, file), 'utf8'))) faults.push(`${file}: a committed settings file grants a permission`)
  }
  const listed = listedInstallers(readFileSync(join(root, 'docs', 'contracts.md'), 'utf8'))
  const plugins = new Set(readdirSync(join(root, PLUGINS_DIR)))
  for (const name of listed) if (!plugins.has(name)) faults.push(`docs/contracts.md: the installer rules list ${name}, which is not a plugin`)
  for (const file of files.filter(path => path.startsWith(PLUGINS_DIR + sep) && SOURCE.test(path) && !isTest(path))) {
    const plugin = file.split(sep)[1] ?? ''
    if (!listed.includes(plugin) && writesRule(readFileSync(join(root, file), 'utf8'))) {
      faults.push(`${file}: writes a permission rule, and ${plugin} has no row in the installer rules of docs/contracts.md`)
    }
  }
  for (const fault of faults) io.err(fault)
  return faults.length === 0 ? 0 : 1
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
