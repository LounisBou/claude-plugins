import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SHORT_MARKER } from '../../../hooks/short-names.ts'
import { main, render, rows, USAGE } from './short-commands.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'short-commands-')) })
test.afterEach(() => {
  try {
    chmodSync(join(dir, 'out'), 0o755)
  } catch {
    // Not made read-only.
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A plugin root with two rows, one whose command is missing. */
function plugin(): string {
  const root = join(dir, 'a & #root')
  mkdirSync(join(root, 'commands'), { recursive: true })
  writeFileSync(join(root, 'short-names.tsv'), 'orchestrator-agents\torchestrator-agents\norchestrator-audit\taudit\nmissing\tnone\n\n')
  writeFileSync(join(root, 'commands', 'orchestrator-agents.md'), '---\ndescription: c\n---\nrun ${CLAUDE_PLUGIN_ROOT}/x and ${CLAUDE_PLUGIN_ROOT}/y\n')
  writeFileSync(join(root, 'commands', 'audit.md'), '---\ndescription: a\n---\naudit')
  return root
}

function sc(root: string, env: Record<string, string>, ...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, { io: { out: t => out.push(t), err: t => err.push(t) }, env, root })
  return { code, out: out.join(''), err: err.join('') }
}

test('render puts the marker after the opening line and spells the root out, as plain text', () => {
  assert.equal(render('---\nd: x\n---\n${CLAUDE_PLUGIN_ROOT}/a ${CLAUDE_PLUGIN_ROOT}', '/r&$1'), `---\n${SHORT_MARKER}\nd: x\n---\n/r&$1/a /r&$1\n`)
  assert.equal(render('one', '/r'), 'one\n')
  assert.deepEqual(rows('a\tb\n\nc\td\te\nlast'), [{ short: 'a', file: 'b' }, { short: 'c', file: 'd\te' }, { short: 'last', file: '' }])
})

test('the command line: a mode, --dry-run and --dir, nothing else', () => {
  const root = plugin()
  assert.deepEqual(sc(root, {}), { code: 2, out: '', err: `${USAGE}\n` })
  assert.deepEqual(sc(root, {}, 'install', '--bogus'), { code: 2, out: '', err: '  unknown option: --bogus (expected --dry-run, --dir <path>)\n' })
  assert.equal(sc(root, {}, 'install', '--dir').code, 2)
})

test('install writes the absent, says the missing command, and leaves a foreign file or a dangling link; then it is up to date', () => {
  const root = plugin()
  const out = join(dir, 'out')
  mkdirSync(out)
  writeFileSync(join(out, 'orchestrator-audit.md'), '---\ndescription: mine\n---\nmine\n')
  const r = sc(root, { ORCHESTRATOR_COMMANDS_DIR: out }, 'install')
  assert.equal(r.code, 0)
  assert.equal(r.out, `  short command written: ${join(out, 'orchestrator-agents.md')}\n  kept: ${join(out, 'orchestrator-audit.md')} is not this plugin's (no « ${SHORT_MARKER} » line), left as it is\n`)
  assert.equal(r.err, `  no plugin command ${join(root, 'commands', 'none.md')} for /missing\n`)
  assert.equal(readFileSync(join(out, 'orchestrator-agents.md'), 'utf8'), `---\n${SHORT_MARKER}\ndescription: c\n---\nrun ${root}/x and ${root}/y\n`)
  assert.equal(statSync(join(out, 'orchestrator-agents.md')).mode & 0o777, 0o644)
  assert.deepEqual(readdirSync(out).sort(), ['orchestrator-agents.md', 'orchestrator-audit.md'], 'no temporary file outlives the write')
  assert.equal(sc(root, { ORCHESTRATOR_COMMANDS_DIR: out }, 'install').out.split('\n')[0], `  short command up to date: ${join(out, 'orchestrator-agents.md')}`)
  const links = join(dir, 'links')
  mkdirSync(links)
  symlinkSync(join(dir, 'nowhere'), join(links, 'orchestrator-agents.md'))
  for (const mode of ['install', 'sync', 'uninstall']) sc(root, {}, mode, '--dir', links)
  assert.ok(lstatSync(join(links, 'orchestrator-agents.md')).isSymbolicLink())
})

test('the default directory is the config dir\'s commands/, made by install, never by a dry run or a sync', () => {
  const root = plugin()
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg') }
  assert.deepEqual(sc(root, env, 'sync'), { code: 0, out: '', err: '' })
  assert.match(sc(root, env, 'install', '--dry-run').out, /^ {2}\[dry-run\] short command written: .*cfg\/commands\/orchestrator-agents\.md$/m)
  assert.ok(!existsSync(join(dir, 'cfg')))
  assert.equal(sc(root, env, 'install').code, 0)
  assert.ok(existsSync(join(dir, 'cfg', 'commands', 'orchestrator-agents.md')))
})

test('sync rewrites its own copy that differs, never creates one, never touches a foreign file', () => {
  const root = plugin()
  const out = join(dir, 'out')
  sc(root, {}, 'install', '--dir', out)
  const copy = join(out, 'orchestrator-agents.md')
  writeFileSync(copy, readFileSync(copy, 'utf8').replaceAll(root, '/old/root'))
  assert.deepEqual(sc(root, {}, 'sync', '--dir', out), { code: 0, out: `  short command rewritten: ${copy}\n`, err: `  no plugin command ${join(root, 'commands', 'none.md')} for /missing\n` })
  assert.ok(!readFileSync(copy, 'utf8').includes('/old/root'))
  rmSync(copy)
  assert.equal(sc(root, {}, 'sync', '--dir', out).out, '')
  assert.ok(!existsSync(copy), 'a copy the operator removed stays removed')
  writeFileSync(join(out, 'orchestrator-audit.md'), '---\nmine\n---\n')
  assert.equal(sc(root, {}, 'sync', '--dir', out).out, '', 'sync says nothing of a foreign file')
})

test('uninstall removes its own, a dry run removes nothing; every mode removes a marked copy no row names', () => {
  const root = plugin()
  const out = join(dir, 'out')
  sc(root, {}, 'install', '--dir', out)
  const stale = join(out, 'orchestrator-dropped.md')
  const foreign = join(out, 'mine.md')
  writeFileSync(stale, `---\n${SHORT_MARKER}\n---\nstale\n`)
  writeFileSync(foreign, '---\nmine\n---\n')
  mkdirSync(join(out, 'dir.md'))
  symlinkSync(stale, join(out, 'link.md'))
  const dry = sc(root, {}, 'uninstall', '--dry-run', '--dir', out)
  assert.equal(dry.out, `  [dry-run] short command removed: ${join(out, 'orchestrator-agents.md')}\n  [dry-run] short command removed: ${join(out, 'orchestrator-audit.md')}\n  [dry-run] stale short command removed: ${stale} (no row of short-names.tsv names it)\n`)
  assert.ok(existsSync(join(out, 'orchestrator-agents.md')) && existsSync(stale))
  const r = sc(root, {}, 'uninstall', '--dir', out)
  assert.equal(r.code, 0)
  assert.ok(!existsSync(join(out, 'orchestrator-agents.md')) && !existsSync(stale))
  assert.ok(existsSync(foreign) && existsSync(join(out, 'dir.md')))
  writeFileSync(stale, `---\n${SHORT_MARKER}\n---\nstale\n`)
  assert.match(sc(root, {}, 'install', '--dir', out).out, /stale short command removed/)
  writeFileSync(stale, `---\n${SHORT_MARKER}\n---\nstale\n`)
  assert.match(sc(root, {}, 'sync', '--dir', out).out, /stale short command removed/)
})

test('a directory that cannot be written fails the install and leaves nothing behind', () => {
  if (process.getuid?.() === 0) return // root writes anywhere.
  const root = plugin()
  const out = join(dir, 'out')
  mkdirSync(out)
  chmodSync(out, 0o555)
  const r = sc(root, {}, 'install', '--dir', out)
  assert.equal(r.code, 1)
  assert.match(r.err, /^short-commands: /m)
  assert.deepEqual(readdirSync(out), [])
})
