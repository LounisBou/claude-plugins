// The catalogue is generated: its `plugins` list is derived from the manifests, never edited by
// hand. Everything else in .claude-plugin/marketplace.json (name, owner, metadata) is authored.
//
//   npm run marketplace            rewrite the list
//   npm run marketplace -- --check exit 1 when the file is not what the manifests give
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIo, type Io } from './lib/io.ts'
import { isEntry, isRecord, PLUGINS_DIR, readPlugins, type Plugin } from './lib/plugins.ts'

export const MARKETPLACE_PATH = join('.claude-plugin', 'marketplace.json')

export interface Entry {
  readonly name: string
  readonly source: string
  readonly description: string
  readonly version: string
  readonly author: { readonly name: string }
}

export function entryOf(plugin: Plugin): Entry {
  const { name, description, version, author } = plugin.manifest
  return { name, source: `./${PLUGINS_DIR}/${plugin.dir}`, description, version, author: { name: author.name } }
}

/** The catalogue's text for these plugins, keeping every authored field of the current file. */
export function render(current: unknown, plugins: readonly Plugin[]): string {
  if (!isRecord(current)) throw new Error(`${MARKETPLACE_PATH} is not an object`)
  return `${JSON.stringify({ ...current, plugins: plugins.map(entryOf) }, null, 2)}\n`
}

export function run(root: string, args: readonly string[], io: Io): number {
  const check = args.includes('--check')
  const path = join(root, MARKETPLACE_PATH)
  const text = readFileSync(path, 'utf8')
  const expected = render(JSON.parse(text), readPlugins(root))
  if (text === expected) return 0
  if (check) {
    io.err(`${MARKETPLACE_PATH} is out of date with the plugin manifests: run \`npm run marketplace\` and commit it.`)
    return 1
  }
  writeFileSync(path, expected)
  io.out(`${MARKETPLACE_PATH} rewritten`)
  return 0
}

/* node:coverage ignore next */
if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2), processIo))
