import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultsOf, LAUNCHER_ARGS_VERSION, LauncherArgsError, parseLauncherArgs } from './launcher.ts'
import { spawnArgv } from './orchestration.ts'

const refused = (command: string, words: string[]): string => {
  try {
    parseLauncherArgs(command, words)
  } catch (error) {
    if (error instanceof LauncherArgsError) return `${error.code} ${error.message}`
    throw error
  }
  return 'read'
}

describe('the launcher argument set', () => {
  it('reads values, flags, negations and lists by their request key, defaults filled', () => {
    const request = parseLauncherArgs('spawn', ['--dir', '/w', '--title=Agent: a', '--no-verify', '--mcp', 'a', '--mcp', 'b', '--trust'])
    assert.equal(request.version, LAUNCHER_ARGS_VERSION)
    assert.equal(request.options['dir'], '/w')
    assert.equal(request.options['title'], 'Agent: a')
    assert.equal(request.options['verify'], false)
    assert.equal(request.options['remote_control'], true)
    assert.deepEqual(request.options['mcp'], ['a', 'b'])
    assert.equal(request.options['trust'], true)
    assert.equal(request.options['mode'], 'auto')
    assert.equal(request.options['gate_tokens'], null)
  })

  it('takes a unique prefix for its flag, and refuses an ambiguous one', () => {
    assert.equal(parseLauncherArgs('spawn', ['--no-ver']).options['verify'], false)
    assert.equal(parseLauncherArgs('spawn', ['--title', 'x']).options['title'], 'x')
    assert.match(refused('spawn', ['--ti', 'x']), /^2 spawn: error: ambiguous option: --ti could match --tier, --title, --title-free/)
  })

  it('refuses a missing value, an unknown word, a bad integer, a value on a flag', () => {
    assert.equal(refused('spawn', ['--title']), '2 spawn: error: argument --title: expected one argument')
    assert.equal(refused('spawn', ['--title', '--evil']), '2 spawn: error: argument --title: expected one argument')
    assert.equal(parseLauncherArgs('spawn', ['--title=--evil']).options['title'], '--evil')
    assert.equal(refused('spawn', ['--bogus']), '1 spawn: unknown option --bogus')
    assert.equal(refused('spawn', ['stray']), '1 spawn: unknown option stray')
    assert.equal(refused('screen', ['--lines', 'x']), "2 screen: error: argument --lines: invalid int value: 'x'")
    assert.equal(parseLauncherArgs('screen', ['--lines', '7']).options['lines'], 7)
    assert.equal(refused('spawn', ['--trust=yes']), "2 spawn: error: argument --trust: ignored explicit argument 'yes'")
    assert.equal(refused('nope', []).startsWith('1 usage: iterm-agent.sh'), true)
  })

  it('ignores what a lenient command does not know, and reads positionals and raw words', () => {
    assert.equal(parseLauncherArgs('close', ['--tty', '/dev/ttys1', '--what']).options['tty'], '/dev/ttys1')
    assert.equal(parseLauncherArgs('close', []).options['expect'], null)
    assert.equal(parseLauncherArgs('trust', ['prune', '--apply']).options['action'], 'prune')
    assert.equal(refused('trust', ['prune', 'more']), '1 trust: usage: trust prune [--apply]')
    assert.deepEqual(parseLauncherArgs('resolve-tier', ['--odd']).words, ['--odd'])
    assert.match(refused('resolve-tier', []), /^1 resolve-tier: exactly one tier/)
    assert.match(refused('pair', ['x']), /^1 pair: takes no argument/)
    assert.deepEqual(parseLauncherArgs('close', ['--', '--tty']).options['tty'], '')
  })

  it('reads a rotation\'s other words as its spawn, keeping what the spawn refuses for it to refuse', () => {
    const request = parseLauncherArgs('rotate', ['--tier', 'light', '--old-tty', '/dev/ttys1', '--dir', '/w', '--odd'])
    assert.equal(request.options['old_tty'], '/dev/ttys1')
    assert.equal(request.rest?.command, 'spawn')
    assert.equal(request.rest?.options['tier'], 'light')
    assert.deepEqual(request.rest?.unknown, ['--odd'])
    assert.deepEqual(defaultsOf('rotate'), { old_tty: '', expect: '', force: false })
  })

  it('holds every flag core\'s spawn line types', () => {
    const argv = spawnArgv('/l', { dir: '/w', title: 'Agent: a', prompt: 'p', rightOf: 'self', resident: true, keepTools: ['mcp__bugs-bot'] })
    const request = parseLauncherArgs('spawn', argv.slice(2))
    assert.equal(request.options['right_of'], 'self')
    assert.equal(request.options['resident'], true)
    assert.deepEqual(request.options['keep_tool'], ['mcp__bugs-bot'])
  })
})
