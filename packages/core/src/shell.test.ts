import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gitSubcommand, innerLine, readCommands, redirectsToFile, simpleCommands, stdinLines, unwrapPath } from './shell.ts'

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

  it('keeps a brace inside a word, and groups only a brace standing alone', () => {
    assert.deepEqual(commands('gh api repos/{owner}/x'), [['gh', 'api', 'repos/{owner}/x']])
    assert.deepEqual(commands('echo {a,b} x{y z}'), [['echo', '{a,b}', 'x{y', 'z}']])
    assert.deepEqual(commands('echo a}; { ls;}'), [['echo', 'a}'], ['ls']])
    assert.deepEqual(commands('{ git push; } | cat'), [['git', 'push'], ['cat']])
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

describe('stdin', () => {
  const stdins = (line: string): (readonly string[])[] => readCommands(line).map(c => c.stdin)

  it('keeps a here-string and a heredoc body as the text of the command that reads them', () => {
    assert.deepEqual(stdins(`bash <<< 'pkill x'`), [['pkill x']])
    assert.deepEqual(stdins('sh <<EOF\npkill x\nEOF'), [['pkill x']])
    assert.deepEqual(stdins('sh <<EOF\na\nb\nEOF\nls'), [['a\nb'], []])
    assert.deepEqual(stdins('sh <<-EOF\n\ta\n\tEOF'), [['a']])
  })

  it('carries what the earlier commands of a pipeline write, echo and printf by their words', () => {
    assert.deepEqual(stdins(`echo 'pkill x' | sh`), [[], ['pkill x']])
    assert.deepEqual(stdins(`echo -n a b | tr a b | sh`), [[], ['a b'], ['a b']])
    assert.deepEqual(stdins(`printf '%s\\n' 'pkill x' | sh`), [[], ['%s\\n', 'pkill x']])
    assert.deepEqual(stdins('cat <<EOF | sh\nbody\nEOF'), [['body'], ['body']])
    assert.deepEqual(stdins(`cat <<< x |& sh`), [['x'], ['x']])
    assert.deepEqual(stdins('ls a | sh'), [[], []])
  })

  it('carries nothing past a list separator or into a substitution', () => {
    assert.deepEqual(stdins(`echo 'pkill x'; sh`), [[], []])
    assert.deepEqual(stdins(`echo 'pkill x' && sh`), [[], []])
    assert.deepEqual(stdins(`echo 'pkill x' | cat; sh`), [[], ['pkill x'], []])
    assert.deepEqual(stdins(`echo "$(echo a | sh)"`), [[], ['a'], []])
  })
})

describe('stdinLines', () => {
  const lines = (line: string): (readonly string[])[] => readCommands(line).map(stdinLines)

  it('gives what a shell with no command string and no script file reads from its standard input', () => {
    assert.deepEqual(lines(`echo 'pkill x' | sh`), [[], ['pkill x']])
    assert.deepEqual(lines(`echo 'pkill x' | bash -s`), [[], ['pkill x']])
    assert.deepEqual(lines(`echo 'pkill x' | bash -`), [[], ['pkill x']])
    assert.deepEqual(lines(`echo 'pkill x' | bash -o pipefail`), [[], ['pkill x']])
    assert.deepEqual(lines(`echo 'pkill x' | bash --norc`), [[], ['pkill x']])
    assert.deepEqual(lines(`bash -s -- a <<< 'ls'`), [['ls']])
  })

  it('skips the value of --rcfile and --init-file, which is no script', () => {
    assert.deepEqual(lines(`bash --rcfile f <<< 'pkill x'`), [['pkill x']])
    assert.deepEqual(lines(`bash --init-file f <<< 'pkill x'`), [['pkill x']])
    assert.deepEqual(lines(`bash --rcfile f -s <<< 'pkill x'`), [['pkill x']])
    assert.deepEqual(lines(`bash --rcfile=f <<< 'pkill x'`), [['pkill x']])
    assert.deepEqual(lines(`bash --rcfile f script.sh <<< 'pkill x'`), [[]])
  })

  it('gives nothing for a shell that only parses (-n), alone or in a cluster', () => {
    assert.deepEqual(lines(`bash -n <<< 'pkill x'`), [[]])
    assert.deepEqual(lines(`bash -xn <<< 'pkill x'`), [[]])
    assert.deepEqual(lines(`echo 'pkill x' | sh -n`), [[], []])
    assert.deepEqual(lines(`bash +n <<< 'pkill x'`), [['pkill x']])
  })

  it('gives nothing for a shell whose -c has no command string to take', () => {
    assert.deepEqual(lines(`bash -c <<< 'pkill x'`), [[]])
    assert.deepEqual(lines(`echo 'pkill x' | sh -c`), [[], []])
    assert.deepEqual(lines(`bash -c -- <<< 'pkill x'`), [[]])
  })

  it('gives nothing for a shell given a command string or a script, or for another program', () => {
    assert.deepEqual(lines(`echo 'pkill x' | sh -c ls`), [[], []])
    assert.deepEqual(lines(`echo 'pkill x' | sh script.sh`), [[], []])
    assert.deepEqual(lines(`echo 'pkill x' | cat`), [[], []])
  })
})

describe('innerLine', () => {
  it('gives the line a shell runs with -c, or eval runs', () => {
    assert.equal(innerLine(['sh', '-c', '--', 'ls']), 'ls')
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

describe('unwrapPath', () => {
  it('skips a wrapper written with its directory, with its options and assignments', () => {
    assert.deepEqual(unwrapPath(['/usr/bin/env', 'bash', '-c', 'ls']), { argv: ['bash', '-c', 'ls'], wrappers: ['env'], lookup: false })
    assert.deepEqual(unwrapPath(['/usr/bin/env', '-u', 'X', 'FOO=1', 'bash']), { argv: ['bash'], wrappers: ['env'], lookup: false })
    assert.deepEqual(unwrapPath(['/usr/bin/sudo', '-u', 'root', '/usr/bin/xargs', 'kill']), { argv: ['kill'], wrappers: ['sudo', 'xargs'], lookup: false })
    assert.deepEqual(unwrapPath(['/usr/bin/timeout', '5', 'sh']), { argv: ['sh'], wrappers: ['timeout'], lookup: false })
    assert.deepEqual(unwrapPath(['/usr/bin/command', '-v', 'pkill']).lookup, true)
  })

  it('leaves a command that is no wrapper written with a directory as it is', () => {
    assert.deepEqual(unwrapPath(['bash', '-c', 'ls']), { argv: ['bash', '-c', 'ls'], wrappers: [], lookup: false })
    assert.deepEqual(unwrapPath(['/bin/bash', '-c', 'ls']), { argv: ['/bin/bash', '-c', 'ls'], wrappers: [], lookup: false })
    assert.deepEqual(unwrapPath(['env', 'bash']), { argv: ['env', 'bash'], wrappers: [], lookup: false })
    assert.deepEqual(unwrapPath([]), { argv: [], wrappers: [], lookup: false })
  })

  it('does not change what readCommands returns for a wrapper written with its directory', () => {
    assert.deepEqual(readCommands('/usr/bin/env bash').map(c => [...c.argv]), [['/usr/bin/env', 'bash']])
  })
})
