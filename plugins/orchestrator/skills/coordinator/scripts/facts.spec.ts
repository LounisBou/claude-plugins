import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { RunOptions, RunResult } from './context.ts'
import { main } from './coordinator.ts'
import { briefOrchestrator, currentOrch, hostCli, procsOf, remoteRow, repositoryOf, treeOf, utcSeconds } from './facts.ts'
import { fixture, NOW, type Fixture } from './fixture.ts'

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' })
const fail = (status: number, stderr: string): RunResult => ({ status, stdout: '', stderr })

/** A git tree as the stand-in answers for it: its top, its branch (null: detached) and its origin (null: none). */
interface Repo {
  readonly branch: string | null
  readonly origin: string | null
  readonly broken?: 'top' | 'head' | 'origin'
}

interface World {
  readonly repos: Record<string, Repo>
  /** The machine's pull request file, by `owner/name`: its open pull requests, `<number> <head branch> <same|fork:owner>` a line. */
  readonly forge?: Record<string, string>
  readonly workspace?: string | RunResult
  readonly ps?: RunResult
  readonly lsof?: RunResult
  readonly paneps?: RunResult
}

/** A stand-in for git, the workspace listing, ps and lsof. */
function world(w: World): (command: string, args: readonly string[], options?: RunOptions) => RunResult {
  const repoOf = (dir: string): [string, Repo] | undefined =>
    Object.entries(w.repos).filter(([top]) => dir === top || dir.startsWith(`${top}/`)).sort((a, b) => b[0].length - a[0].length)[0]
  return (command, args, options) => {
    if (command === 'git') {
      const dir = args[1] ?? ''
      const found = repoOf(dir)
      const verb = args.slice(2).join(' ')
      if (found === undefined) return fail(128, `fatal: not a git repository (or any of the parent directories): .git\n`)
      const [top, repo] = found
      if (options?.env?.['LC_ALL'] !== 'C') return fail(99, 'git ran outside the C locale')
      if (verb === 'rev-parse --show-toplevel') return repo.broken === 'top' ? fail(128, 'fatal: the index is corrupt\nmore') : ok(`${top}\n`)
      if (verb === 'symbolic-ref --short -q HEAD') {
        if (repo.broken === 'head') return fail(128, 'fatal: bad HEAD')
        return repo.branch === null ? fail(1, '') : ok(`${repo.branch}\n`)
      }
      if (verb === 'remote get-url origin') {
        if (repo.broken === 'origin') return fail(128, 'fatal: bad config')
        return repo.origin === null ? fail(2, 'error: No such remote') : ok(`${repo.origin}\n`)
      }
    }
    if (command === 'bash' && args[1] === 'list') {
      const listed = w.workspace ?? ''
      return typeof listed === 'string' ? ok(listed) : listed
    }
    if (command === 'ps') return args[0] === '-p' ? (w.paneps ?? fail(1, '')) : (w.ps ?? fail(1, 'ps: no'))
    if (command === 'lsof') return w.lsof ?? fail(1, '')
    return fail(1, `no stand-in for ${command}`)
  }
}

/** The machine's pull request file holding `forge`'s repositories as read, their open pull requests. */
function prFile(forge: Record<string, string>): string {
  const prs = Object.entries(forge).flatMap(([repo, lines]) => lines.split('\n').flatMap(line => {
    const [n = '', head = '', where = 'same'] = line.trim().split(/\s+/)
    return /^\d+$/.test(n) ? [{ repo, pr: Number(n), state: 'OPEN', head, fork: where.startsWith('fork:') ? where.slice(5) : null }] : []
  }))
  return JSON.stringify({ v: 1, at: NOW.toISOString(), tried: NOW.toISOString(), viewer: 'me', repos: Object.keys(forge), unread: [], prs })
}

interface Setup {
  readonly f: Fixture
  readonly dir: (name: string) => string
}

/** A fixture whose directories are real (each git top is one) and whose commands answer from `w`. */
function setup(build: (dir: (name: string) => string) => { world: World; env?: Record<string, string>; ps?: string; cwds?: string }): Setup {
  const base = fixture()
  const root = realpathSync(base.root)
  const dir = (name: string): string => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  const built = build(dir)
  const env: Record<string, string> = { ORCHESTRATOR_HOST_CLI: '/usr/bin/hostcli', ORCHESTRATOR_WORKSPACES: dir('ws'), ORCHESTRATOR_MODULE_DIR: dir('module'), ...built.env }
  if (built.ps !== undefined) {
    writeFileSync(join(root, 'ps'), built.ps)
    env['COORDINATOR_PS_TABLE'] = join(root, 'ps')
  }
  if (built.cwds !== undefined) {
    writeFileSync(join(root, 'cwds'), built.cwds)
    env['COORDINATOR_CWDS'] = join(root, 'cwds')
  }
  const f = fixture({ env, run: world(built.world), here: join(root, 'skills', 'coordinator', 'scripts') })
  if (built.world.forge !== undefined) {
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'prs.json'), prFile(built.world.forge))
  }
  return { f, dir }
}

function run(f: Fixture, ...argv: string[]): number {
  return main(f.ctx, argv)
}

describe('repositoryOf', () => {
  it('reads one remote reached over each protocol as one repository', () => {
    assert.equal(repositoryOf('git@github.com:o/app.git'), 'github.com/o/app')
    assert.equal(repositoryOf('https://github.com/o/app.git'), 'github.com/o/app')
    assert.equal(repositoryOf('ssh://git@github.com/o/app/'), 'github.com/o/app')
    assert.equal(repositoryOf('git+ssh://u@github.com/o/app'), 'github.com/o/app')
  })
})

describe('procsOf', () => {
  const table = [
    '  100     1 ttys100 /usr/bin/hostcli --name Orch: a',
    '104 1 ?? /usr/bin/hostcli --print',
    '105 1 - hostcli --print',
    '106 1 ttys106 /usr/bin/vim x',
    '200 1 ttys100 bash ./tests/run-tests.sh',
    '201 200 ttys100 bash ./tests/run-tests.sh',
    '300 1 ttys101 timeout 595 /usr/bin/hostcli plugin eval . --case x',
    '301 300 ttys101 /usr/bin/hostcli plugin eval . --case x',
    '400 1 ttys102 /bin/zsh -c while pgrep -f run-tests.sh; do sleep 5; done',
    '401 400 ttys102 pgrep -f run-tests.sh',
    '500 1 ttys103 sh ./e2e.sh',
    '',
  ].join('\n')
  it('keeps the host sessions on a tty and each heavy run once, at its top', () => {
    assert.deepEqual(procsOf(table, 'hostcli'), [
      { kind: 'S', pid: '100', tty: 'ttys100', command: '/usr/bin/hostcli --name Orch: a' },
      { kind: 'H', pid: '200', tty: '', command: 'bash ./tests/run-tests.sh' },
      { kind: 'H', pid: '300', tty: '', command: 'timeout 595 /usr/bin/hostcli plugin eval . --case x' },
      { kind: 'H', pid: '500', tty: '', command: 'sh ./e2e.sh' },
    ])
  })
  it('finds no session when the host is unknown', () => {
    assert.equal(procsOf(table, '').filter(p => p.kind === 'S').length, 0)
  })
})

describe('treeOf', () => {
  it('reads the top, the repository and the branch, HEAD when detached and the top when no origin', () => {
    const { f, dir } = setup(d => ({ world: { repos: { [d('a')]: { branch: 'feat/x', origin: 'git@h:o/a.git' }, [d('b')]: { branch: null, origin: null } } } }))
    assert.deepEqual(treeOf(f.ctx, join(dir('a'), 'sub')), { kind: 'tree', top: dir('a'), repo: 'h/o/a', branch: 'feat/x' })
    assert.deepEqual(treeOf(f.ctx, dir('b')), { kind: 'tree', top: dir('b'), repo: dir('b'), branch: 'HEAD' })
    assert.deepEqual(treeOf(f.ctx, dir('c')), { kind: 'none' })
  })
  it('says which git call failed, on which tree', () => {
    const { f, dir } = setup(d => ({ world: { repos: {
      [d('t')]: { branch: 'm', origin: null, broken: 'top' }, [d('h')]: { branch: 'm', origin: null, broken: 'head' },
      [d('o')]: { branch: 'm', origin: null, broken: 'origin' }, [join(d('x'), 'gone')]: { branch: 'm', origin: null },
    } } }))
    assert.deepEqual(treeOf(f.ctx, dir('t')), { kind: 'error', message: `git failed on ${dir('t')}: fatal: the index is corrupt` })
    assert.deepEqual(treeOf(f.ctx, dir('h')), { kind: 'error', message: `git failed on ${dir('h')}: fatal: bad HEAD` })
    assert.deepEqual(treeOf(f.ctx, dir('o')), { kind: 'error', message: `git failed on ${dir('o')}: fatal: bad config` })
    const gone = join(dir('x'), 'gone')
    assert.deepEqual(treeOf(f.ctx, gone), { kind: 'error', message: `cannot enter ${gone}` })
  })
})

describe('hostCli and currentOrch', () => {
  it('reads the host from its variable, else from the launcher, else refuses', () => {
    const { f, dir } = setup(() => ({ world: { repos: {} } }))
    assert.equal(hostCli(f.ctx), 'hostcli')
    const bare = fixture({ here: join(dir('t'), 'skills', 'coordinator', 'scripts') })
    assert.throws(() => hostCli(bare.ctx), /the host's name is unknown: set ORCHESTRATOR_HOST_CLI/)
    mkdirSync(join(dir('t'), 'skills', 'iterm-agents', 'scripts'), { recursive: true })
    writeFileSync(join(dir('t'), 'skills', 'iterm-agents', 'scripts', 'iterm_agent.py'), 'import os\nHOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "/opt/hostcli")\n')
    assert.equal(hostCli(bare.ctx), 'hostcli')
  })
  it('writes the former shape the current way', () => {
    assert.equal(currentOrch('Orch : x'), 'Orch: x')
    assert.equal(currentOrch('Agent : x'), 'Agent : x')
  })
})

describe('briefOrchestrator', () => {
  it('reads the brief, relative from the session directory, else the startup prompt', () => {
    const { dir } = setup(() => ({ world: { repos: {} } }))
    writeFileSync(join(dir('s/notes'), 'rel.md'), 'x\nYour orchestrator is the session **`Orch : g [ccc333]`** here.\n')
    writeFileSync(join(dir('b'), 'empty.md'), 'The orchestrator is the session **``** and **`Orch: z [z]`**.\n')
    const unread: string[] = []
    assert.deepEqual(briefOrchestrator('hostcli Read and execute notes/rel.md.', dir('s'), unread), { orch: 'Orch: g [ccc333]', why: 'names no orchestrator' })
    assert.deepEqual(briefOrchestrator('hostcli Read and execute notes/rel.md', '', unread),
      { orch: 'unknown', why: 'its brief notes/rel.md is relative to a directory not read' })
    assert.deepEqual(briefOrchestrator(`hostcli Read and execute ${dir('b')}/empty.md. Your orchestrator is Orch: p [abc]; go`, '', unread),
      { orch: 'Orch: p [abc]', why: 'names no orchestrator' })
    assert.deepEqual(briefOrchestrator('hostcli', '', unread), { orch: 'unknown', why: 'names no orchestrator' })
    assert.deepEqual(unread, [])
  })
  it('says a brief that exists and cannot be read', () => {
    const { dir } = setup(() => ({ world: { repos: {} } }))
    const unread: string[] = []
    assert.deepEqual(briefOrchestrator(`hostcli Read and execute ${dir('adir')}`, '', unread), { orch: 'unknown', why: `brief ${dir('adir')} cannot be read` })
    assert.deepEqual(unread, [`brief ${dir('adir')}: cannot be read`])
  })
})

describe('remote rows', () => {
  it('reads a UTC time to the second, a fraction allowed', () => {
    assert.equal(utcSeconds('2026-10-18T10:06:07.123Z'), Date.UTC(2026, 9, 18, 10, 6, 7) / 1000)
    assert.equal(utcSeconds('soon'), undefined)
  })
  it('reads a row, an empty file as none, and refuses anything else', () => {
    assert.equal(remoteRow('  \n'), undefined)
    assert.throws(() => remoteRow('[]'), /not a JSON row/)
    assert.throws(() => remoteRow('{"name":"x","updated_at":"t","prs":"o/a#1"}'), /not a JSON row/)
    assert.throws(() => remoteRow('{"name":"x","updated_at":"t","machine":{}}'), /not a scalar/)
    assert.deepEqual(remoteRow('{"name":"x","updated_at":"t","context_tokens":false,"prs":["o/a#1",2,null,true]}'), {
      name: 'x', machine: '', updatedAt: 't', tokens: '0', percent: '0', repo: '', prs: 'o/a#1 2  true', waiting: '', blocks: '', since: '', at: undefined,
    })
  })
})

/** The suite's world: one source tree, checkouts of o/app and o/other, briefs, the machine's pull request file. */
function bench(over: { ps?: string; cwds?: string; world?: Partial<World>; env?: Record<string, string> } = {}): Setup & { readonly t: Record<string, string> } {
  const t: Record<string, string> = {}
  const s = setup(d => {
    t['src'] = d('src/app'); t['a1'] = d('ws/app/a1'); t['b1'] = d('ws/app/b1'); t['c1'] = d('ws/app/c1'); t['idle'] = d('ws/app/idle')
    t['o1'] = d('ws/other/o1'); t['o2'] = d('ws/other/o2'); t['n1'] = d('ws/none/n1'); t['briefs'] = d('briefs')
    writeFileSync(join(t['briefs'], 'a1.md'), 'The phase.\n\n- Your orchestrator is the session **`Orch: alpha [aaa111]`** — that exact name.\n')
    writeFileSync(join(t['briefs'], 'c1.md'), 'A brief that names no orchestrator.\n')
    const app = { origin: 'git@github.com:o/app.git' }
    const repos: Record<string, Repo> = {
      [t['src']]: { branch: 'main', ...app }, [t['a1']]: { branch: 'feat/x', origin: 'https://github.com/o/app.git' },
      [t['b1']]: { branch: 'feat/x', ...app }, [t['c1']]: { branch: 'feat/y', origin: 'ssh://git@github.com/o/app' },
      [t['idle']]: { branch: 'feat/w', ...app }, [t['o1']]: { branch: 'feat/x', origin: 'git@github.com:o/other.git' },
      [t['o2']]: { branch: 'feat/o', origin: 'git@github.com:o/other.git' }, [t['n1']]: { branch: 'feat/x', origin: 'git@github.com:o/none.git' },
    }
    const b = t['briefs']
    return {
      world: {
        repos,
        workspace: [t['a1'], t['b1'], t['c1'], t['idle'], t['o1'], t['o2'], t['n1'], '', join(t['briefs'])].map(p => `${p}   | x | y`).join('\n') + '\n',
        forge: { 'o/app': '7 feat/x same\n8 feat/y same\n9 feat/z same\n10 feat/w same\nnoise\n', 'o/other': '' },
        ...over.world,
      },
      env: { ...over.env },
      ps: over.ps ?? [
        `100 1 ttys100 /usr/bin/hostcli --model m Read and execute ${b}/orch.md --name Orch: alpha --remote-control Orch: alpha`,
        `101 1 ttys101 /usr/bin/hostcli Read and execute ${b}/a1.md. Your orchestrator is Orch: wrong [zzz999]. --name Agent: a1`,
        `102 1 ttys102 hostcli Read and execute ${b}/gone.md. Your orchestrator is Orch: beta [bbb222]; handshake first. --name Agent: b1`,
        `103 1 ttys103 /usr/bin/hostcli Read and execute ${b}/c1.md --name Agent: c1`,
        `106 1 ttys106 /usr/bin/hostcli Your orchestrator is Orch: gamma [ccc333]. --name Agent: o1`,
        '200 1 ttys100 bash ./tests/run-tests.sh',
        '300 1 ttys101 timeout 595 /usr/bin/hostcli plugin eval . --case x',
      ].join('\n') + '\n',
      cwds: over.cwds ?? `100 ${t['src']}\n101 ${t['a1']}\n102 ${t['b1']}\n103 ${t['c1']}\n106 ${t['o1']}\n200 ${t['src']}\n300 ${t['a1']}\n`,
    }
  })
  return { ...s, t }
}

describe('facts', () => {
  it('lists the sessions, checkouts and heavy runs, then the collisions, then what it could not read', () => {
    const { f, t } = bench()
    assert.equal(run(f, 'facts'), 2)
    const [src, a1, b1, c1, idle, o1, o2] = [t['src'], t['a1'], t['b1'], t['c1'], t['idle'], t['o1'], t['o2']]
    assert.deepEqual(f.out, [
      `session 100 | ttys100 | Orch: alpha | Orch: alpha | github.com/o/app | main | ${src} | -`,
      `session 101 | ttys101 | Agent: a1 | Orch: alpha [aaa111] | github.com/o/app | feat/x | ${a1} | -`,
      `session 102 | ttys102 | Agent: b1 | Orch: beta [bbb222] | github.com/o/app | feat/x | ${b1} | -`,
      `session 103 | ttys103 | Agent: c1 | unknown | github.com/o/app | feat/y | ${c1} | -`,
      `session 106 | ttys106 | Agent: o1 | Orch: gamma [ccc333] | github.com/o/other | feat/x | ${o1} | -`,
      `checkout ${a1} | github.com/o/app | feat/x`,
      `checkout ${b1} | github.com/o/app | feat/x`,
      `checkout ${c1} | github.com/o/app | feat/y`,
      `checkout ${idle} | github.com/o/app | feat/w`,
      `checkout ${o1} | github.com/o/other | feat/x`,
      `checkout ${o2} | github.com/o/other | feat/o`,
      `heavy 200 | ${src} | bash ./tests/run-tests.sh`,
      `heavy 300 | ${a1} | timeout 595 /usr/bin/hostcli plugin eval . --case x`,
      `collision checkouts | github.com/o/app | feat/x | ${a1}, ${b1}`,
      'collision sessions | github.com/o/app | feat/x | 101 Agent: a1, 102 Agent: b1',
      'collision heavy | 200, 300',
      'collision pr | github.com/o/app#7 | feat/x | Orch: alpha [aaa111], Orch: beta [bbb222]',
      `unread checkout ${t['briefs']}: not a git tree`,
    ])
  })

  it('says the plan each session runs on, read in its own environment', () => {
    const table = join(realpathSync(fixture().root), 'ps-env')
    writeFileSync(table, [
      '100 1 ttys100 /usr/bin/hostcli --name Orch: alpha TERM=x CLAUDE_CONFIG_DIR=/h/.claude-bis HOME=/h',
      '101 1 ttys101 /usr/bin/hostcli --name Agent: a1 TERM=x HOME=/h',
      '102 1 ttys102 /usr/bin/hostcli --name Agent: b1 CLAUDE_CONFIG_DIR=/h/.claude/',
      '106 1 ttys106 /usr/bin/hostcli --name Agent: o1 CLAUDE_CONFIG_DIR=/elsewhere',
      '',
    ].join('\n'))
    const { f } = bench({ env: { HOME: '/h', COORDINATOR_PS_ENV: table } })
    run(f, 'facts')
    const plans = f.out.filter(l => l.startsWith('session ')).map(l => l.split(' | ').slice(0, 1).concat(l.split(' | ').slice(-1)).join(' '))
    // 103 is not in the environment table: its plan is unread, said « - ».
    assert.deepEqual(plans, ['session 100 plan2', 'session 101 plan1', 'session 102 plan1', 'session 103 -', 'session 106 /elsewhere'])
  })

  it('says a plan table it cannot read, and keeps the sessions', () => {
    const { f } = bench({ env: { HOME: '/h', COORDINATOR_PS_ENV: '/no/such/env' } })
    assert.equal(run(f, 'facts'), 2)
    assert.ok(f.out.includes('unread plans: /no/such/env cannot be read'))
    assert.ok(f.out.some(l => l.startsWith('session 100 | ') && l.endsWith(' | -')))
  })

  it('says each source it could not read, keeps what it read, and exits 2', () => {
    const { f } = bench({ cwds: '', world: { forge: {}, workspace: fail(1, 'workspace: no root\nmore') } })
    assert.equal(run(f, 'facts'), 2)
    assert.deepEqual(f.out.filter(l => l.startsWith('unread ')), [
      'unread directory of session 100: no working directory read',
      'unread directory of session 101: no working directory read',
      'unread directory of session 102: no working directory read',
      'unread directory of session 103: no working directory read',
      'unread directory of session 106: no working directory read',
      'unread directory of heavy run 200: no working directory read',
      'unread directory of heavy run 300: no working directory read',
      'unread checkouts: workspace: no root',
    ])
    assert.ok(f.out.includes('heavy 200 | - | bash ./tests/run-tests.sh'))
    assert.ok(f.out.includes(`session 100 | ttys100 | Orch: alpha | Orch: alpha | - | - | - | -`))
  })

  it('checks: reports at first nothing, then only what is new since the last check, and waits for it with --every', () => {
    const { f, t } = bench()
    mkdirSync(f.state, { recursive: true })
    assert.equal(run(f, 'check'), 0)
    assert.deepEqual(f.out, [])
    assert.equal(run(f, 'check'), 0)
    assert.deepEqual(f.out, [])
    const ps = f.ctx.env['COORDINATOR_PS_TABLE'] ?? ''
    const newcomer = `107 1 ttys107 /usr/bin/hostcli --name Orch: delta\n`
    // Nothing new at the first reading: it sleeps, the newcomer arrives, the next reading ends it.
    const ctx = { ...f.ctx, sleep: (ms: number) => { f.slept.push(ms); writeFileSync(ps, readFileSync(ps, 'utf8') + newcomer); writeFileSync(f.ctx.env['COORDINATOR_CWDS'] ?? '', `107 ${t['src']}\n`, { flag: 'a' }) } }
    assert.equal(main(ctx, ['check', '--every', '5']), 0)
    const found = ['newcomer Orch: delta', 'collision sessions | github.com/o/app | main | 100 Orch: alpha, 107 Orch: delta']
    assert.deepEqual([f.out, f.slept], [found, [5000]])
    assert.equal(run(f, 'check'), 0)
    assert.deepEqual(f.out, found)
    assert.equal(run(f, 'check', '--every', 'soon'), 1)
    assert.deepEqual(f.err, ['coordinator: check: usage: check [--every <seconds>]'])
  })

  it('says a check record it cannot write, and still reports', () => {
    const { f } = bench()
    mkdirSync(join(f.state, 'coordinator-check.json'), { recursive: true })
    assert.equal(run(f, 'check'), 0)
    assert.deepEqual(f.err, [`coordinator: check: cannot record the findings in ${join(f.state, 'coordinator-check.json')}`])
  })

  it('says a repository the pull request file holds no reading of, and a process table it could not read', () => {
    const { f } = bench({ world: { forge: {} } })
    assert.equal(run(f, 'facts'), 2)
    assert.ok(f.out.includes("unread forge github.com/o/app: no current reading in the machine's pull request file"))
    assert.ok(f.out.includes("unread forge github.com/o/other: no current reading in the machine's pull request file"))
    writeFileSync(join(f.state, 'prs.json'), JSON.stringify({ v: 1, at: NOW.toISOString(), tried: NOW.toISOString(), error: 'HTTP 502', viewer: 'me', repos: ['o/app'], unread: [], prs: [] }))
    assert.equal(run(f, 'facts'), 2)
    assert.ok(f.out.includes("unread forge github.com/o/app: no current reading in the machine's pull request file"))
    const missing = fixture({ env: { ORCHESTRATOR_HOST_CLI: 'h', COORDINATOR_PS_TABLE: '/no/such/ps', ORCHESTRATOR_MODULE_DIR: '/no/module' } })
    assert.equal(run(missing, 'facts'), 2)
    assert.deepEqual(missing.out, ['unread processes: /no/such/ps cannot be read', 'unread checkouts: '])
  })

  it('reads ps and lsof when the suite gives no table, and says lsof failing or missing', () => {
    const { f, dir } = setup(d => ({
      world: { repos: { [d('r')]: { branch: 'm', origin: 'h:o/r' } }, ps: ok('  7 1 ttys7 hostcli --name Agent: s\n'), lsof: { status: 1, stdout: `p7\nfcwd\nn${d('r')}\n`, stderr: '' } },
    }))
    const bin = dir('bin')
    writeFileSync(join(bin, 'lsof'), '')
    chmodSync(join(bin, 'lsof'), 0o755)
    const withLsof = fixture({ env: { ...f.ctx.env, PATH: `:${bin}` }, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(withLsof, 'facts'), 2)
    assert.deepEqual(withLsof.out, [`session 7 | ttys7 | Agent: s | unknown | h/o/r | m | ${dir('r')} | plan1`, 'unread directories: lsof failed: exit 1', "unread forge h/o/r: not a GitHub repository, which the machine's pull request file holds alone"])
    const noLsof = fixture({ env: { ...f.ctx.env, PATH: dir('empty') }, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(noLsof, 'facts'), 2)
    assert.ok(noLsof.out.includes('unread directories: lsof is missing'))
    const noPs = fixture({ env: { ...f.ctx.env, ORCHESTRATOR_HOST_CLI: '' }, run: () => fail(1, '') })
    assert.equal(run(noPs, 'facts'), 2)
    assert.ok(noPs.out.includes('unread processes: ps failed'))
    assert.ok(noPs.out.some(l => l.startsWith("unread sessions: the host's name is unknown")))
  })

  it('reads the open pull requests in the machine\'s file, never the forge, and writes nothing beside it', () => {
    const calls: string[] = []
    const { f, dir } = setup(d => ({
      world: { repos: { [d('r')]: { branch: 'feat/a', origin: 'git@github.com:o/r.git' } }, workspace: '', forge: { 'o/r': '5 feat/a same\n' } },
      ps: '7 1 ttys7 hostcli --name Orch: r\n', cwds: `7 ${d('r')}\n`,
    }))
    const spy = fixture({ env: f.ctx.env, run: (c, a, o) => { calls.push(c); return f.ctx.run(c, a, o) } })
    assert.equal(run(spy, 'owners'), 0)
    assert.deepEqual(spy.out, [`pr github.com/o/r#5 | feat/a | Orch: r | session 7 in ${dir('r')}`])
    assert.ok(!calls.includes('gh'))
    assert.ok(!existsSync(join(f.state, 'prs.wanted')))
  })

  it('shows the live waits, the unattended lines and the fresh remote rows', () => {
    const { f } = bench()
    const module = f.ctx.env['ORCHESTRATOR_MODULE_DIR'] ?? ''
    const put = (sub: string, name: string, text: string) => {
      mkdirSync(join(module, 'store', sub), { recursive: true })
      writeFileSync(join(module, 'store', sub, name), text)
    }
    put('waits', 's-alpha', '{"name":"Orch: alpha","pid":"100","waiting":"operator","blocks":"phase 3","waiting_since":"S"}\n')
    put('waits', 's-done', '{"name":"Orch: d","pid":101,"waiting":"done"}\n')
    put('waits', 's-gone', '{"name":"Orch: gone","pid":"999","waiting":"operator"}\n')
    put('waits', 's-bad', 'not json\n{"name":{},"pid":"100","waiting":"done"}\n')
    put('waits', 's-alpha.tmp-1', '{"name":"Orch: alpha","pid":"100","waiting":"operator"}\n')
    put('sessions', 's-alpha', '{"role":"orchestrator","name":"Orch: alpha","pid":"100","unattended":{"line":"PR délaissées : o/app#9"}}\n')
    put('sessions', 's-none', '{"role":"orchestrator","pid":"100","unattended":{"line":null}}\n{"role":"orchestrator","name":[],"pid":"100","unattended":{"line":"x"}}\n')
    const fresh = '2026-10-18T10:00:00.000Z'
    put('remote-rows', 'far', JSON.stringify({ name: 'Orch: far', machine: 'bench', waiting: 'operator', blocks: 'b', waiting_since: fresh, updated_at: fresh, context_tokens: 5, context_percent: 1, repo: 'o/app', prs: ['o/app#7', 'o/app#9', 'o/app#99', 'o/gone#5'] }))
    put('remote-rows', 'near', JSON.stringify({ name: 'Orch: near', machine: 'lab', waiting: 'done', updated_at: fresh, prs: ['o/gone#5', 'nohash'] }))
    put('remote-rows', 'quiet', JSON.stringify({ name: 'Orch: quiet', machine: 'lab', updated_at: fresh }))
    put('remote-rows', 'old', JSON.stringify({ name: 'Orch: old', updated_at: '2020-01-01T00:00:00Z' }))
    put('remote-rows', 'local', JSON.stringify({ name: 'Orch: alpha', updated_at: fresh }))
    put('remote-rows', 'empty', '')
    put('remote-rows', 'bad', 'not json')
    put('remote-rows', 'far.tmp-1', 'half')
    assert.equal(run(f, 'facts'), 2)
    const lines = f.out.filter(l => /^(waiting|unattended|remote|collision pr|unread remote)/.test(l))
    assert.deepEqual(lines, [
      'waiting Orch: alpha | operator since S | blocks: phase 3',
      'waiting Orch: d | done since ?',
      'unattended Orch: alpha | PR délaissées : o/app#9',
      `remote Orch: far | on bench | updated ${fresh} | context 5 (1%) | repository o/app | prs o/app#7, o/app#9, o/app#99, o/gone#5 | operator since ${fresh} | blocks: b`,
      `remote Orch: near | on lab | updated ${fresh} | context 0 (0%) | repository none | prs o/gone#5, nohash | done since ?`,
      `remote Orch: quiet | on lab | updated ${fresh} | context 0 (0%) | repository none | prs none | working`,
      'collision pr | github.com/o/app#7 | feat/x | Orch: alpha [aaa111], Orch: beta [bbb222], Orch: far',
      'collision pr | o/gone#5 | - | Orch: far, Orch: near',
      `unread remote ${join(f.ctx.env['ORCHESTRATOR_MODULE_DIR'] ?? '', 'store', 'remote-rows', 'bad')}: not a JSON row`,
    ])
    assert.ok(NOW.getTime() > Date.parse(fresh))

    const owners = fixture({ env: f.ctx.env, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(owners, 'owners'), 2)
    assert.deepEqual(owners.out.filter(l => l.includes('remote on')), [
      `pr github.com/o/app#9 | feat/z | Orch: far | remote on bench, updated ${fresh}`,
      `pr o/gone#5 | - | Orch: far | remote on bench, updated ${fresh}, not read on the forge here`,
      `pr o/gone#5 | - | Orch: near | remote on lab, updated ${fresh}, not read on the forge here`,
      `pr #nohash | - | Orch: near | remote on lab, updated ${fresh}, not read on the forge here`,
    ])
  })

  it('says each line of an orchestrator\'s unattended reading as a fact of its own', () => {
    const { f } = bench()
    const module = f.ctx.env['ORCHESTRATOR_MODULE_DIR'] ?? ''
    mkdirSync(join(module, 'store', 'sessions'), { recursive: true })
    const two = 'Attend ton geste : o/app#4 (Ready), o/app#5 (en pause)\nEn anomalie : o/app#9 (sans agent depuis 2026-10-14T09:00Z)'
    writeFileSync(join(module, 'store', 'sessions', 's-alpha'), JSON.stringify({ role: 'orchestrator', name: 'Orch: alpha', pid: '100', unattended: { line: two } }) + '\n')
    assert.equal(run(f, 'facts'), 2)
    assert.deepEqual(f.out.filter(l => l.startsWith('unattended')), [
      'unattended Orch: alpha | Attend ton geste : o/app#4 (Ready), o/app#5 (en pause)',
      'unattended Orch: alpha | En anomalie : o/app#9 (sans agent depuis 2026-10-14T09:00Z)',
    ])
  })

  it('says each plan\'s quota from the files the status lines keep, the stale ones marked, the unreadable ones skipped', () => {
    const { f } = bench({ env: { HOME: '/Users/me' } })
    const put = (name: string, text: string) => {
      mkdirSync(join(f.state, 'quota'), { recursive: true })
      writeFileSync(join(f.state, 'quota', name), text)
    }
    const file = (account: string, config: string, five: number, at: string, seven?: number) => JSON.stringify({
      version: 1, account, config, five_hour: { used_percentage: five, resets_at: 1 }, ...(seven === undefined ? {} : { seven_day: { used_percentage: seven, resets_at: 2 } }), at,
    })
    put('a-two.json', file('a-two', '/Users/me/zeta', 12.4, '2026-10-18T10:00:00Z'))
    put('z-one.json', file('z-one', '/Users/me/alpha', 80.5, '2026-10-18T09:30:00Z', 33))
    put('torn.json', '{"version":1,')
    put('other.json', JSON.stringify({ version: 9 }))
    put('.config-x', 'a-one 1 - - - -')
    put('c.json.tmp-1', file('c', '/Users/me/alpha', 1, '2026-10-18T10:00:00Z'))
    assert.equal(run(f, 'facts'), 2)
    // The files lie in the order of their accounts (a-two, z-one); the lines, in the order of their plans.
    assert.deepEqual(f.out.filter(l => l.startsWith('quota')), [
      'quota /Users/me/alpha | 5h 81% | 7d 33% | read 2026-10-18T09:30:00Z (stale)',
      'quota /Users/me/zeta | 5h 12% | 7d - | read 2026-10-18T10:00:00Z',
    ])
  })

  it('says no quota line where no status line has kept one', () => {
    const { f } = bench()
    assert.equal(run(f, 'facts'), 2)
    assert.deepEqual(f.out.filter(l => l.startsWith('quota')), [])
  })

  it('refuses an argument', () => {
    const f = fixture()
    assert.equal(run(f, 'facts', 'x'), 1)
    assert.equal(run(f, 'owners', 'x'), 1)
    assert.deepEqual(f.err, ['coordinator: facts: unexpected argument x', 'coordinator: owners: unexpected argument x'])
  })
})

describe('roots', () => {
  it('prints the protected root, the data root its file names and the module directory, and the protected one when the file is refused', () => {
    const f = fixture()
    const data = join(f.root, 'data')
    mkdirSync(f.state)
    writeFileSync(join(f.state, 'data-root.json'), JSON.stringify({ version: 1, dir: data }))
    assert.equal(main(f.ctx, ['roots']), 0)
    assert.deepEqual(f.out.slice(0, 2), [`protected=${f.state}`, `data=${data}`])
    assert.match(f.out[2] ?? '', /^module=\//)
    const refused = fixture()
    mkdirSync(refused.state)
    writeFileSync(join(refused.state, 'data-root.json'), JSON.stringify({ version: 1, dir: '~/shared' }))
    assert.equal(main(refused.ctx, ['roots']), 0)
    assert.deepEqual(refused.out.slice(0, 2), [`protected=${refused.state}`, `data=${refused.state}`])
    assert.equal(main(refused.ctx, ['roots', 'x']), 1)
  })
})

describe('owners', () => {
  it('traces each open pull request to its orchestrator, else says why it cannot', () => {
    const { f, t } = bench()
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out.filter(l => l.startsWith('pr ')), [
      `pr github.com/o/app#7 | feat/x | Orch: alpha [aaa111] | session 101 in ${t['a1']}`,
      `pr github.com/o/app#7 | feat/x | Orch: beta [bbb222] | session 102 in ${t['b1']}`,
      `pr github.com/o/app#8 | feat/y | unknown | session 103 in ${t['c1']} names no orchestrator`,
      'pr github.com/o/app#9 | feat/z | unknown | no checkout on feat/z',
      `pr github.com/o/app#10 | feat/w | unknown | no session in ${t['idle']}`,
    ])
  })

  it('says unknown for an idle checkout beside a busy one, two orchestrators in one checkout, a fork, an unread brief', () => {
    const t: Record<string, string> = {}
    const { f } = setup(d => {
      t['v1'] = d('ws/v1'); t['v2'] = d('ws/v2'); t['d1'] = d('ws/d1'); t['k'] = d('ws/k'); t['adir'] = d('adir')
      const amb = { origin: 'git@github.com:o/amb.git' }
      return {
        world: {
          repos: { [t['v1']]: { branch: 'feat/v', ...amb }, [t['v2']]: { branch: 'feat/v', ...amb }, [t['d1']]: { branch: 'feat/d', ...amb }, [t['k']]: { branch: 'feat/k', ...amb } },
          workspace: `${t['v2']}\n`,
          forge: { 'o/amb': '11 feat/v same\n12 feat/d same\n13 feat/f fork:someone\n15 feat/k same\n' },
        },
        ps: ['130 1 t Your orchestrator is Orch: a [aaa]. --name Agent: v1', '131 1 t hostcli Your orchestrator is Orch: a [aaa]. --name Agent: d1',
          '132 1 t hostcli Your orchestrator is Orch: b [bbb]. --name Agent: d2', `133 1 t hostcli Read and execute ${t['adir']} --name Agent: k`].join('\n'),
        cwds: `131 ${t['d1']}\n132 ${t['d1']}\n133 ${t['k']}\n`,
      }
    })
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out, [
      `pr github.com/o/amb#11 | feat/v | unknown | no session in ${t['v2']}`,
      `pr github.com/o/amb#12 | feat/d | unknown | sessions 131, 132 in ${t['d1']} name different orchestrators: Orch: a [aaa], Orch: b [bbb]`,
      'pr github.com/o/amb#13 | feat/f | unknown | head branch in a fork, owned by someone',
      `pr github.com/o/amb#15 | feat/k | unknown | session 133 in ${t['k']}: brief ${t['adir']} cannot be read`,
      `unread brief ${t['adir']}: cannot be read`,
    ])
  })

  it('gives a sleeping orchestrator its unknown pull requests, and says a sleeping record it cannot read', () => {
    const { f } = bench()
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([
      { name: 'Orch: gamma', slept: '2026-10-13T10:00:00Z', prs: ['github.com/o/app#9 feat/z', 'github.com/o/app#9 again', 'github.com/o/app#7 feat/x', 3] },
      { name: 'Orch: none' }, 'not a record', { name: {}, prs: ['github.com/o/app#10 feat/w'] },
    ]))
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out.filter(l => l.includes('#9 ') || l.includes('#10 ')), [
      'pr github.com/o/app#9 | feat/z | Orch: gamma | sleeping since 2026-10-13T10:00:00Z',
      `pr github.com/o/app#10 | feat/w | unknown | no session in ${f.out.find(l => l.includes('#10 '))?.split('no session in ')[1] ?? ''}`,
    ])
    writeFileSync(join(f.state, 'sleeping.json'), 'not json')
    const broken = fixture({ env: f.ctx.env, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(broken, 'owners'), 2)
    assert.ok(broken.out.includes(`unread sleeping: the sleeping record ${join(f.state, 'sleeping.json')} cannot be read: remove or repair it`))
  })
})
