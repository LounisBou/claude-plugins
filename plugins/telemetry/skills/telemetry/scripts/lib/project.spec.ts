// The repository a session's directory belongs to, read from real git: the same from the main
// working tree and from a worktree, the first remote when none is named origin, nothing without one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstRemoteUrl, remoteUrlsArgv, repositoryOf } from '../../../../hooks/collect.ts'

const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }

function run(argv: readonly string[], cwd: string): string {
  const [program = 'git', ...args] = argv
  const r = spawnSync(program, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, HOME: cwd } })
  assert.equal(r.status === 0 || argv.includes('--get-regexp'), true, `${argv.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** The repository the way the hooks module reads it when the host gave no remote. */
const repositoryAt = (dir: string): string | undefined => repositoryOf(firstRemoteUrl(run(remoteUrlsArgv(dir), dir)))

function scratch(work: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-project-')))
  try {
    work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function repository(root: string): string {
  const main = join(root, 'main')
  mkdirSync(main)
  run(['git', 'init', '--quiet', '-b', 'main'], main)
  run(['git', 'commit', '--quiet', '--allow-empty', '-m', 'first'], main)
  return main
}

test('a worktree names the same repository as the main working tree', () => {
  scratch(root => {
    const main = repository(root)
    run(['git', 'remote', 'add', 'origin', 'git@github.com:LounisBou/claude-plugins.git'], main)
    const worktree = join(root, 'wt')
    run(['git', 'worktree', 'add', '--quiet', '-b', 'topic', worktree], main)
    assert.equal(repositoryAt(main), 'LounisBou/claude-plugins')
    assert.equal(repositoryAt(worktree), 'LounisBou/claude-plugins')
  })
})

test('a repository whose only remote is not named origin gives its first remote', () => {
  scratch(root => {
    const main = repository(root)
    run(['git', 'remote', 'add', 'upstream', 'https://github.com/acme/tool.git'], main)
    run(['git', 'remote', 'add', 'other', 'https://github.com/acme/second.git'], main)
    assert.equal(repositoryAt(main), 'acme/tool')
  })
})

test('a repository without a remote names none: the project stays the directory', () => {
  scratch(root => {
    assert.equal(repositoryAt(repository(root)), undefined)
  })
})

test('firstRemoteUrl: the url of the first remote line, nothing for an empty answer', () => {
  assert.equal(firstRemoteUrl('remote.up.url https://h/o/n.git\nremote.x.url https://h/o/m.git\n'), 'https://h/o/n.git')
  assert.equal(firstRemoteUrl(''), undefined)
})
