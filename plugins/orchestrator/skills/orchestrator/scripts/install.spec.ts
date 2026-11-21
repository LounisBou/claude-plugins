import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { afterTap, HOST_FLOOR, main, olderThan, type Deps } from './install.ts'

const NOW = new Date(2026, 10, 15, 9, 5, 7)
const SUFFIX = '/skills/iterm-agents/scripts/iterm-agent.sh spawn --open *)'

let home = ''
let root = ''
let state = ''
let settings = ''
let tap = ''
test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'install-'))
  root = join(home, 'cache', '1.0.0')
  state = join(home, '.claude', 'claude-orchestrator')
  settings = join(home, '.claude', 'settings.json')
  tap = join(state, 'statusline-tap.sh')
  mkdirSync(join(root, 'commands'), { recursive: true })
  writeFileSync(join(root, 'short-names.tsv'), 'orchestrator-status\tstatus\n')
  writeFileSync(join(root, 'commands', 'status.md'), '---\ndescription: s\n---\nstatus\n')
  mkdirSync(join(home, '.claude'))
})
test.afterEach(() => { rmSync(home, { recursive: true, force: true }) })

interface Machine {
  readonly version?: string
  readonly platform?: string
  /** The commands that succeed, by their first words. */
  readonly succeeds?: readonly string[]
  readonly noPython?: boolean
  readonly alive?: readonly number[]
}

function go(argv: string[], machine: Machine = {}): { code: number; out: string; err: string; ran: string[] } {
  const out: string[] = []
  const err: string[] = []
  const ran: string[] = []
  const deps: Deps = {
    io: { out: t => out.push(t), err: t => err.push(t) },
    env: { HOME: home, ORCHESTRATOR_HOST_CLI: 'host-cli' },
    root,
    now: () => NOW,
    platform: machine.platform ?? 'linux',
    alive: pid => (machine.alive ?? []).includes(pid),
    exec: argv => {
      const line = argv.join(' ')
      ran.push(line)
      if (line === 'host-cli --version') return { status: 0, stdout: machine.version ?? '2.1.292 (host)\nmore 9.9.9\n' }
      if (line === 'python3 --version' && machine.noPython === true) return { status: null, stdout: '' }
      return { status: (machine.succeeds ?? []).some(s => line.includes(s)) ? 0 : 1, stdout: '' }
    },
  }
  const code = main(argv, deps)
  return { code, out: out.join(''), err: err.join(''), ran }
}
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const put = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
const rule = (): string => `Bash(${root}${SUFFIX}`

test('a version sorts below the floor component by component', () => {
  assert.equal(olderThan('2.1.100', HOST_FLOOR), true)
  assert.equal(olderThan('2.1', HOST_FLOOR), true)
  assert.equal(olderThan('2.1.287', HOST_FLOOR), false)
  assert.equal(olderThan('2.1.287.1', HOST_FLOOR), false)
  assert.equal(olderThan('3', HOST_FLOOR), false)
})

test('what follows the tap, in each spelling of the home', () => {
  assert.equal(afterTap('/h/.claude/t.sh', '/h/.claude/t.sh', '/h'), '')
  assert.equal(afterTap('/h/.claude/t.sh /x/bar.sh  -a', '/h/.claude/t.sh', '/h'), '/x/bar.sh  -a')
  assert.equal(afterTap('$HOME/.claude/t.sh $HOME/b.sh', '/h/.claude/t.sh', '/h'), '$HOME/b.sh')
  assert.equal(afterTap('${HOME}/.claude/t.sh', '/h/.claude/t.sh', '/h'), '')
  assert.equal(afterTap('~/.claude/t.sh b', '/h/.claude/t.sh', '/h'), 'b')
  assert.equal(afterTap('/h/.claude/t.sh2 b', '/h/.claude/t.sh', '/h'), undefined)
  assert.equal(afterTap('/elsewhere/t.sh b', '/elsewhere/t.sh', '/h'), 'b')
})

test('a host below the floor, or whose version cannot be read, is refused before anything is made', () => {
  assert.deepEqual(go(['install'], { version: '2.1.100 (old)\n' }), {
    code: 1, out: '\nPrerequisites\n', err: `  the host is 2.1.100; this plugin needs ${HOST_FLOOR} or later (the hooks module).\n`, ran: ['host-cli --version'],
  })
  assert.equal(go(['install'], { version: 'a version I will not say\n' }).err, `  the host's version could not be read from 'host-cli --version'; this plugin needs ${HOST_FLOOR} or later.\n`)
  assert.equal(existsSync(state), false)
  assert.deepEqual(go(['install', '--bogus']), { code: 2, out: '', err: '  unknown option: --bogus (expected --dry-run, --allow-open)\n', ran: [] })
})

test('a fresh install: every line it prints, and what it leaves', () => {
  const r = go(['install'])
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  assert.equal(r.out, [
    '', 'Prerequisites', '  host 2.1.292',
    '', 'State directory', `  measure directory ready: ${state}/measure`, '  no ctx/ to remove',
    '  measure files pruned (past 90 days, no live session): 0',
    `  tier map created: ${state}/models.json`,
    '  bind deep, standard and light there to the identifiers this host accepts;', '  an unbound tier leaves the choice to the host.',
    `  server catalogue created: ${state}/mcp.json`,
    "  name there the servers this machine offers, in the host's own shape, and list the",
    '  elementary ones in default; an agent gets that set, plus what its spawn line adds.',
    '', 'Terminal tooling environment', '  not macOS: the tab tooling is skipped, the other skills work anywhere',
    '  iTerm2 must have its API enabled (Preferences > General > Magic > Enable Python API)',
    '', 'settings.json', `  no ${settings}: nothing to unwire`, `  the opening of an orchestrator allowed: ${rule()}`,
    '', 'Old pipeline files', '  old pipeline files removed: 0',
    '', 'Short commands', `  short command written: ${home}/.claude/commands/orchestrator-status.md`,
    '', 'Done.', '  Restart your session for the module to take effect.', '',
  ].join('\n'))
  assert.equal(readFileSync(join(state, 'models.json'), 'utf8'), '{"deep": "", "standard": "", "light": ""}\n')
  assert.equal(readFileSync(join(state, 'mcp.json'), 'utf8'), '{"servers": {}, "default": []}\n')
  assert.equal(readFileSync(settings, 'utf8'), `{\n  "permissions": {\n    "allow": [\n      "${rule()}"\n    ]\n  }\n}\n`)
  assert.equal(statSync(settings).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(home, '.claude', 'backups', 'claude-orchestrator-20261115-090507', 'settings.json.before'), 'utf8'), '{}\n')
})

test('a second install changes nothing and says what it found', () => {
  go(['install'])
  put(join(state, 'models.json'), '{"deep":"a-model"}\n')
  const before = readFileSync(settings, 'utf8')
  const r = go(['install', '--allow-open'])
  assert.match(r.out, /tier map already present: .*\n/)
  assert.match(r.out, /server catalogue already present: .*\n/)
  assert.ok(r.out.includes(`  the opening of an orchestrator is already allowed: ${rule()}\n`))
  assert.ok(r.out.includes('  no statusLine to unwire\n'))
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.equal(readFileSync(join(state, 'models.json'), 'utf8'), '{"deep":"a-model"}\n')
})

test('a dry run prints each command and changes nothing', () => {
  put(settings.replace('settings.json', 'sessions/x.json'), {})
  put(join(state, 'ctx', 'old.json'), {})
  put(join(state, 'measure', 'old.json'), {})
  utimesSync(join(state, 'measure', 'old.json'), new Date(2020, 0, 1), new Date(2020, 0, 1))
  put(tap, '#!/bin/sh\n')
  const r = go(['install', '--dry-run'], { platform: 'darwin' })
  assert.equal(r.code, 0)
  for (const line of [
    `  [dry-run] mkdir -p '${state}/measure'`, `  [dry-run] rm -rf '${state}/ctx'`, "  the tap's ctx/ removed", `  [dry-run] rm -f '${state}/measure/old.json'`,
    '  measure files pruned (past 90 days, no live session): 1', `  [dry-run] tier map created: ${state}/models.json`, `  [dry-run] server catalogue created: ${state}/mcp.json`,
    `  [dry-run] python3 -m venv ${state}/venv && pip install iterm2`, `  [dry-run] printf '{}\\n' > '${settings}'`, `  [dry-run] the opening of an orchestrator allowed: ${rule()}`,
    `  [dry-run] rm -f '${tap}'`, '  old pipeline files removed: 1', `  [dry-run] short command written: ${home}/.claude/commands/orchestrator-status.md`,
  ]) assert.ok(r.out.includes(`${line}\n`), line)
  assert.deepEqual([existsSync(settings), existsSync(join(state, 'ctx')), existsSync(tap), existsSync(join(state, 'models.json')), existsSync(join(home, '.claude', 'backups'))], [false, true, true, false, false])
  assert.deepEqual(r.ran, ['host-cli --version'])
})

test('the unwrap keeps the follower as written, and fills from the saved object only what the line lacks', () => {
  const line = (): unknown => (json(settings) as { statusLine?: unknown }).statusLine
  put(settings, { statusLine: { type: 'command', command: `${tap} /x/bar.sh`, padding: 0 }, other: 1 })
  assert.ok(go(['install']).out.includes('  statusLine.command → /x/bar.sh\n'))
  assert.deepEqual(json(settings), { statusLine: { type: 'command', command: '/x/bar.sh', padding: 0 }, other: 1, permissions: { allow: [rule()] } })

  put(settings, { statusLine: { type: 'command', command: '$HOME/.claude/claude-orchestrator/statusline-tap.sh $HOME/bar.sh' } })
  put(join(state, 'statusline.previous.json'), { type: 'command', command: '/elsewhere/bar.sh', padding: 2 })
  go(['install'])
  assert.equal(JSON.stringify(line()), '{"type":"command","command":"$HOME/bar.sh","padding":2}')
  assert.equal(existsSync(join(state, 'statusline.previous.json')), false)

  put(settings, { statusLine: { command: tap } })
  put(join(state, 'statusline.previous.json'), { type: 'command', command: '/x/saved.sh' })
  assert.ok(go(['uninstall']).out.includes('  statusLine restored from the saved object\n'))
  assert.deepEqual(line(), { type: 'command', command: '/x/saved.sh' })

  put(settings, { statusLine: { command: tap }, other: 1 })
  put(join(state, 'statusline.previous.json'), '[1]')
  assert.ok(go(['install']).out.includes('  statusLine removed (the tap was all it held)\n'))
  assert.equal(line(), undefined)

  put(settings, { statusLine: { command: '/x/other.sh' } })
  assert.ok(go(['install']).out.includes('  statusLine carries no tap, left untouched\n'))
  put(settings, { statusLine: 'text' })
  assert.ok(go(['install']).out.includes('  statusLine carries no tap, left untouched\n'))
})

test('a settings file that does not parse is said and left; the tap\'s files stay', () => {
  put(settings, '{"statusLine": {"command": "not json')
  put(tap, '#!/bin/sh\n')
  put(join(state, 'stop-gate.log'), 'old\n')
  const r = go(['install'])
  assert.equal(r.code, 0)
  assert.equal(r.err, `  ${settings} does not parse as JSON: the status line was not unwired — the tap's wiring, if it is in there, is left as it is; fix the file and run this again.\n`)
  assert.ok(r.out.includes('  settings.json does not parse: the opening rule is not written\n'))
  assert.ok(r.out.includes('  the status line may still run the tap: its files are kept\n'))
  assert.equal(readFileSync(settings, 'utf8'), '{"statusLine": {"command": "not json')
  assert.deepEqual([existsSync(tap), existsSync(join(state, 'stop-gate.log'))], [true, true])

  assert.ok(go(['uninstall', '--dry-run']).out.includes(`  [dry-run] empty ${state} but for the tap's copy and saved object\n`))
  const u = go(['uninstall'])
  assert.ok(u.out.includes(`  emptied ${state} but for the tap's copy and saved object: the status line may still run it\n`))
  assert.deepEqual(readdirSync(state), ['statusline-tap.sh'])
})

test('an empty settings file, and one whose allow list is no list, get no rule', () => {
  put(settings, '')
  const empty = go(['install'])
  assert.ok(empty.out.includes('  no statusLine to unwire\n') && empty.out.includes('  settings.json does not parse: the opening rule is not written\n'))
  for (const content of [{ permissions: { allow: 'Bash(ls)' } }, { permissions: 'x' }, [1], 'null']) {
    put(settings, content)
    const r = go(['install'])
    assert.equal(r.code, 0)
    assert.ok(r.out.includes(content === 'null' ? '  settings.json does not parse: the opening rule is not written\n' : '  permissions.allow in settings.json is not a list: the opening rule is not written\n'))
    assert.deepEqual(json(settings), content === 'null' ? null : content)
  }
  put(settings, { statusLine: { command: `${tap}  two-spaces` } })
  assert.ok(go(['install']).out.includes('  statusLine.command →  two-spaces\n'))
  put(settings, { statusLine: { command: `~/.claude/claude-orchestrator/statusline-tap.sh` } })
  assert.equal(afterTap('~/x', tap, home), undefined)
})

test('a rule granted an earlier version names this one; a launcher elsewhere keeps its rule', () => {
  const old = `Bash(${dirname(root)}/0.0.1-old${SUFFIX}`
  const elsewhere = `Bash(/elsewhere/x${SUFFIX}`
  put(settings, { permissions: { allow: ['Bash(ls)', old, elsewhere], deny: [] }, other: null })
  const r = go(['install'])
  assert.ok(r.out.includes(`  the opening of an orchestrator, allowed for an earlier version, now names this one: ${rule()}\n`))
  assert.equal(JSON.stringify(json(settings)), JSON.stringify({ permissions: { allow: ['Bash(ls)', elsewhere, rule()], deny: [] }, other: null }))
  put(settings, { permissions: null })
  go(['install'])
  assert.deepEqual(json(settings), { permissions: { allow: [rule()] } })
})

test('a measure file is pruned past 90 days unless a live session owns it; the old pipeline\'s files go', () => {
  const old = new Date(NOW.getTime() - 91 * 24 * 3600 * 1000)
  for (const id of ['s-gone', 's-dead', 's-live', 's-month', 's-fresh']) put(join(state, 'measure', `${id}.json`), {})
  put(join(state, 'measure', 'note.txt'), 'x')
  for (const id of ['s-gone', 's-dead', 's-live', 'note']) utimesSync(join(state, 'measure', id === 'note' ? 'note.txt' : `${id}.json`), old, old)
  const month = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000)
  utimesSync(join(state, 'measure', 's-month.json'), month, month)
  put(join(home, '.claude', 'sessions', '11.json'), { sessionId: 's-live' })
  put(join(home, '.claude', 'sessions', '12.json'), { sessionId: 's-dead' })
  put(join(home, '.claude', 'sessions', '13.json'), 'not json')
  put(join(home, '.claude', 'sessions', 'x.json'), { sessionId: 's-gone' })
  for (const f of ['ctx/old.json', 'statusline-tap.sh', 'statusline.previous.json', 'context-gate.log', 'stop-gate.log', 'stop-gate/a.heads', 'stop-gate/a.mheads']) put(join(state, f), 'old\n')
  const r = go(['install'], { alive: [11, 13] })
  assert.ok(r.out.includes("  the tap's ctx/ removed\n"))
  assert.ok(r.out.includes('  measure files pruned (past 90 days, no live session): 2\n'))
  assert.ok(r.out.includes('  old pipeline files removed: 5\n'))
  assert.deepEqual(readdirSync(join(state, 'measure')).sort(), ['note.txt', 's-fresh.json', 's-live.json', 's-month.json'])
  assert.deepEqual(readdirSync(state).sort(), ['mcp.json', 'measure', 'models.json', 'stop-gate'])
  assert.deepEqual(readdirSync(join(state, 'stop-gate')), ['a.mheads'])
})

test('the terminal tooling environment on macOS: usable, built, or said missing', () => {
  const lines = (machine: Machine): string => {
    const out = go(['install'], { platform: 'darwin', ...machine }).out
    return out.slice(out.indexOf('Terminal tooling environment\n') + 'Terminal tooling environment\n'.length, out.indexOf('  iTerm2 must'))
  }
  const venv = join(state, 'venv')
  assert.equal(lines({ succeeds: ['-c import iterm2'] }), `  environment already usable: ${venv}\n`)
  assert.equal(lines({ succeeds: ['python3', 'pip install'] }), `  environment ready: ${venv}\n`)
  assert.equal(lines({ succeeds: [] }), `  could not create ${venv}\n  could not install the terminal module into ${venv}\n  the tab tooling will refuse to run and say so; everything else works\n`)
  assert.equal(lines({ noPython: true }), '  python3 not found: the tab tooling will refuse to run and say so\n')
})

test('on a data root placed apart, the measure files go there, and an uninstall names that root and leaves it', () => {
  const data = join(home, 'shared', 'claude-orchestrator')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'data-root.json'), JSON.stringify({ version: 1, dir: data }))
  const r = go(['install'])
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes(`  measure directory ready: ${data}/measure\n`))
  assert.deepEqual([existsSync(join(data, 'measure')), existsSync(join(state, 'measure')), existsSync(join(state, 'models.json'))], [true, false, true])
  const dry = go(['uninstall', '--dry-run'])
  assert.ok(dry.out.includes(`  [dry-run] rm -rf ${state}\n  left ${data}, the data root ${state} placed: remove it by hand once no session writes there\n`), dry.out)
  const u = go(['uninstall'])
  assert.ok(u.out.includes(`  left ${data}, the data root ${state} placed: remove it by hand once no session writes there\n`), u.out)
  assert.deepEqual([existsSync(state), existsSync(join(data, 'measure'))], [false, true])
})

test('uninstall removes the state directory and the short commands, or says what it would', () => {
  go(['install'])
  const copy = join(home, '.claude', 'commands', 'orchestrator-status.md')
  const dry = go(['uninstall', '--dry-run'])
  assert.equal(dry.out, `  no statusLine to unwire\n  [dry-run] rm -rf ${state}\n  [dry-run] short command removed: ${copy}\n  Done. Restart your session.\n`)
  assert.deepEqual([existsSync(state), existsSync(copy)], [true, true])
  const r = go(['uninstall'])
  assert.deepEqual({ code: r.code, err: r.err }, { code: 0, err: '' })
  assert.equal(r.out, `  no statusLine to unwire\n  removed ${state} (measure files, the module's log with its rotation and lock, prompts, tier map)\n  short command removed: ${copy}\n  Done. Restart your session.\n`)
  assert.deepEqual([existsSync(state), existsSync(copy)], [false, false])
  assert.equal(go(['uninstall']).out, '  no statusLine to unwire\n  Done. Restart your session.\n')
  assert.equal(go(['uninstall', '-x']).code, 2)
})

test('a short command that cannot be written ends the install with its exit code', () => {
  put(join(home, '.claude', 'commands'), 'a file where the directory goes')
  const r = go(['install'])
  assert.equal(r.code, 1)
  assert.match(r.err, /^short-commands: /)
  assert.equal(r.out.includes('Done.'), false)
  rmSync(join(root, 'short-names.tsv'))
  assert.equal(go(['uninstall']).code, 1)
})
