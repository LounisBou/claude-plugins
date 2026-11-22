import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The shell file as a real shell runs it: the profile sources it, the shell is interactive and a
// login shell on a terminal (a pseudo-terminal stands in) or it is not.
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'shell', 'claude-plugins.sh')
const NAMES = (/^\s*unset ((?:[A-Z_]+ ?)+)$/m.exec(readFileSync(FILE, 'utf8'))?.[1] ?? '').trim().split(' ')
const PROBE = 'echo "${CLAUDECODE-gone}|${CLAUDE_CODE_SESSION_ATTENDED-gone}|${CLAUDE_CONFIG_DIR-gone}"'
const KEPT = '1|1|/acct'
const GONE = 'gone|gone|/acct'

// Runs a shell with a profile that sources the file; `tty` gives it a terminal on its stdin.
const PTY = `
import os, pty, subprocess, sys
env = dict(os.environ)
argv = sys.argv[2:]
if sys.argv[1] == "tty":
    master, slave = pty.openpty()
    out = subprocess.run(argv, stdin=slave, capture_output=True, text=True, env=env).stdout
else:
    out = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env).stdout
print(out.strip().splitlines()[-1] if out.strip() else "")
`

function available(shell: string): boolean {
  return spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
}
const python = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

function probe(shell: string, flags: string[], tty: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'shellfile-'))
  try {
    const source = `[ -r '${FILE}' ] && . '${FILE}'\n`
    writeFileSync(join(home, '.zshrc'), source)
    writeFileSync(join(home, '.bashrc'), source)
    // A login bash reads the profile, not .bashrc: the usual profile hands over to it.
    writeFileSync(join(home, '.bash_profile'), '[ -r ~/.bashrc ] && . ~/.bashrc\n')
    mkdirSync(join(home, 'bin'))
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home, CLAUDE_CONFIG_DIR: '/acct' }
    for (const name of NAMES) env[name] = '1'
    const ran = spawnSync('python3', ['-I', '-c', PTY, tty ? 'tty' : 'pipe', shell, ...flags, PROBE], { env, encoding: 'utf8' })
    return ran.stdout.trim()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const SHELLS = ['/bin/bash', '/bin/zsh', 'bash', 'zsh'].filter((s, i, all) => available(s) && all.indexOf(s) === i)

test('the file names the same nine variables as the launcher, which unsets them in its own tab', () => {
  const launcher = readFileSync(join(dirname(FILE), '..', 'skills', 'iterm-agents', 'scripts', 'iterm_agent.py'), 'utf8')
  const tuple = /^NESTING_ENV = \(([^)]*)\)/m.exec(launcher)?.[1] ?? ''
  assert.deepEqual(NAMES, [...tuple.matchAll(/"([A-Z_]+)"/g)].map(m => m[1]))
  assert.equal(NAMES.length, 9)
  assert.ok(NAMES.includes('CLAUDECODE') && NAMES.includes('CLAUDE_CODE_SESSION_ATTENDED'))
  assert.equal(NAMES.includes('CLAUDE_CONFIG_DIR'), false)
})

for (const shell of SHELLS) {
  const options = { skip: !python && 'no python3 for the terminal' }
  test(`${shell}: an interactive login shell on a terminal drops the marks, keeps the account`, options, () => {
    assert.equal(probe(shell, ['-l', '-i', '-c'], true), GONE)
  })
  test(`${shell}: a non-interactive shell keeps them`, options, () => {
    assert.equal(probe(shell, ['-l', '-c'], true), KEPT)
    assert.equal(probe(shell, ['-c'], true), KEPT)
  })
  test(`${shell}: an interactive login shell with no terminal keeps them`, options, () => {
    assert.equal(probe(shell, ['-l', '-i', '-c'], false), KEPT)
  })
  test(`${shell}: an interactive shell that is not a login shell keeps them`, options, () => {
    assert.equal(probe(shell, ['-i', '-c'], true), KEPT)
  })
}

test('the file is left sourced without leaving a variable or a function behind', { skip: !available('bash') && 'no bash' }, () => {
  const ran = spawnSync('bash', ['-c', `. '${FILE}'; set | grep -c '[_]claude_plugins'`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  assert.equal(ran.stdout.trim(), '0')
  assert.equal(existsSync(FILE), true)
})
