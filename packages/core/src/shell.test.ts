import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gitSubcommand, redirectsToFile, simpleCommands } from './shell.ts'

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
  })

  it('skips arithmetic and the targets of redirections and here-strings', () => {
    assert.deepEqual(commands('echo $((1 << 2)) 2>&1 > out <<< in; (cd x && ls)'), [['echo', '', '2'], ['cd', 'x'], ['ls']])
  })

  it('keeps escapes and ANSI quotes as text', () => {
    assert.deepEqual(commands(`echo a\\ b "q\\"x" $'c'`), [['echo', 'a b', 'q"x', 'c']])
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
