import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gitSubcommand, innerLine, readCommands, redirectsToFile, simpleCommands } from './shell.ts'

const commands = (line: string): string[][] => simpleCommands(line)

describe('simpleCommands', () => {
  it('splits a line into its simple commands, quotes removed', () => {
    assert.deepEqual(commands(`git commit -m "a; b" && echo 'x y' | wc -l; ls`), [['git', 'commit', '-m', 'a; b'], ['echo', 'x y'], ['wc', '-l'], ['ls']])
  })

  it('skips assignments, reserved words and wrappers with their options', () => {
    assert.deepEqual(commands('FOO=1 env -u X sudo -u root timeout -s 9 5 git push'), [['git', 'push']])
    assert.deepEqual(commands('if true; then nice -n 5 make; fi'), [['true'], ['make'], ['fi']])
  })

  it('reads a heredoc body and a comment as data', () => {
    assert.deepEqual(commands("cat <<'EOF' > f\ngit push --force\nEOF\necho done # git push -f"), [['cat'], ['echo', 'done']])
    assert.deepEqual(commands('cat <<-X\n\tgit push\n\tX\nls'), [['cat'], ['ls']])
  })

  it('reads a command substitution as a command of its own, leaving an empty word in its place', () => {
    assert.deepEqual(commands('echo "$(git rev-parse HEAD)" `date`'), [['git', 'rev-parse', 'HEAD'], ['date'], ['echo', '', '']])
  })

  it('reads the argument of a shell -c again, one level deep', () => {
    assert.deepEqual(commands(`bash -euo pipefail -c 'git push -f origin x'`), [['bash', '-euo', 'pipefail', '-c', 'git push -f origin x'], ['git', 'push', '-f', 'origin', 'x']])
    assert.deepEqual(commands('sh script.sh'), [['sh', 'script.sh']])
    assert.deepEqual(commands(`eval "git push -f"`), [['eval', 'git push -f'], ['git', 'push', '-f']])
  })

  it('keeps {} as a word, so a wrapper option taking it does not swallow the program', () => {
    assert.deepEqual(commands('pgrep x | xargs -I {} kill {}'), [['pgrep', 'x'], ['kill', '{}']])
    assert.deepEqual(commands('{ ls; }'), [['ls']])
  })

  it('skips arithmetic and the targets of redirections and here-strings', () => {
    assert.deepEqual(commands('echo $((1 << 2)) 2>&1 > out <<< in; (cd x && ls)'), [['echo', '', '2'], ['cd', 'x'], ['ls']])
  })

  it('keeps escapes and ANSI quotes as text', () => {
    assert.deepEqual(commands(`echo a\\ b "q\\"x" $'c'`), [['echo', 'a b', 'q"x', 'c']])
  })
})

describe('readCommands', () => {
  it('gives each substitution the commands it held, before the command that holds it', () => {
    const [inner, outer] = readCommands('kill $(cat a.pid)')
    assert.deepEqual(inner?.argv, ['cat', 'a.pid'])
    assert.deepEqual(outer?.argv, ['kill'])
    assert.deepEqual(outer?.substitutions.map(held => held.map(c => c.argv)), [[['cat', 'a.pid']]])
  })

  it('names the programs that fed the pipe, and none past a list separator', () => {
    const piped = (line: string): (readonly string[])[] => readCommands(line).map(c => c.piped)
    assert.deepEqual(piped('/usr/bin/pgrep x | grep y |& xargs kill'), [[], ['pgrep'], ['pgrep', 'grep']])
    assert.deepEqual(piped('pgrep x || xargs kill; a | b && c'), [[], [], [], ['a'], []])
  })

  it('names the wrappers it skipped and a lookup that runs nothing', () => {
    const [sudo, lookup, run] = readCommands('sudo -u r xargs -n 1 kill; command -v pkill; command -p pkill')
    assert.deepEqual([sudo?.argv, sudo?.wrappers, sudo?.lookup], [['kill'], ['sudo', 'xargs'], false])
    assert.deepEqual([lookup?.argv, lookup?.lookup], [['pkill'], true])
    assert.deepEqual([run?.argv, run?.lookup], [['pkill'], false])
  })
})

describe('innerLine', () => {
  it('gives the line a shell runs with -c, or eval runs', () => {
    assert.equal(innerLine(['bash', '-o', 'pipefail', '-c', 'ls']), 'ls')
    assert.equal(innerLine(['/bin/dash', '-lc', 'ls']), 'ls')
    assert.equal(innerLine(['ksh', '+o', 'x', '-c', 'ls']), 'ls')
    assert.equal(innerLine(['eval', 'kill', '1']), 'kill 1')
  })

  it('gives nothing for a script, a bare eval or another program', () => {
    assert.equal(innerLine(['sh', 'script.sh']), undefined)
    assert.equal(innerLine(['eval']), undefined)
    assert.equal(innerLine(['echo', '-c', 'ls']), undefined)
    assert.equal(innerLine([]), undefined)
  })
})

describe('gitSubcommand', () => {
  it('finds the subcommand past git global options that take a value', () => {
    assert.deepEqual(gitSubcommand(['git', '-C', '/r', '-c', 'k=v', '--no-pager', 'push']), { at: 6 })
    assert.deepEqual(gitSubcommand(['/usr/bin/git', 'status']), { at: 1 })
  })

  it('finds nothing for another command or a bare git', () => {
    assert.equal(gitSubcommand(['gh', 'pr']), undefined)
    assert.equal(gitSubcommand(['git', '--version']), undefined)
    assert.equal(gitSubcommand([]), undefined)
  })
})

describe('redirectsToFile', () => {
  it('sees a write into a file, and not a stream, /dev/null or a quoted >', () => {
    for (const line of ['git diff > out.txt', 'echo a >> notes.md', 'cmd >| f', 'x 2> err.log', 'a && b>f']) assert.equal(redirectsToFile(line), true, line)
    for (const line of ['git diff 2>&1', 'cmd > /dev/null 2>&1', 'cmd 2>/dev/null', 'echo "a > b"', "grep '>' f", 'echo a\\>b', 'cmd >&2']) assert.equal(redirectsToFile(line), false, line)
  })
})
