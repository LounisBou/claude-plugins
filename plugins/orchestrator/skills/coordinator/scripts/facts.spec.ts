import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  readonly forge?: Record<string, string | RunResult>
  readonly workspace?: string | RunResult
  readonly ps?: RunResult
  readonly lsof?: RunResult
  readonly paneps?: RunResult
}

/** A stand-in for git, the workspace listing, the forge, ps and lsof. */
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
    const answer = w.forge?.[args[0] ?? ''] ?? w.forge?.[options?.cwd ?? '']
    if (answer !== undefined) return typeof answer === 'string' ? ok(answer) : answer
    return fail(1, `the forge does not know ${args[0] ?? options?.cwd ?? ''}`)
  }
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
  return { f, dir }
}

function run(f: Fixture, ...argv: string[]): number {
  return main(f.ctx, argv)
}

describe('repositoryOf', () => {
  it('reads one remote reached over each protocol as one repository', () => {
    assert.equal(repositoryOf('git@forge.example:o/app.git'), 'forge.example/o/app')
    assert.equal(repositoryOf('https://forge.example/o/app.git'), 'forge.example/o/app')
    assert.equal(repositoryOf('ssh://git@forge.example/o/app/'), 'forge.example/o/app')
    assert.equal(repositoryOf('git+ssh://u@forge.example/o/app'), 'forge.example/o/app')
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

/** The suite's world: one source tree, checkouts of o/app and o/other, briefs, a forge. */
function bench(over: { ps?: string; cwds?: string; world?: Partial<World>; env?: Record<string, string> } = {}): Setup & { readonly t: Record<string, string> } {
  const t: Record<string, string> = {}
  const s = setup(d => {
    t['src'] = d('src/app'); t['a1'] = d('ws/app/a1'); t['b1'] = d('ws/app/b1'); t['c1'] = d('ws/app/c1'); t['idle'] = d('ws/app/idle')
    t['o1'] = d('ws/other/o1'); t['o2'] = d('ws/other/o2'); t['n1'] = d('ws/none/n1'); t['briefs'] = d('briefs')
    writeFileSync(join(t['briefs'], 'a1.md'), 'The phase.\n\n- Your orchestrator is the session **`Orch: alpha [aaa111]`** — that exact name.\n')
    writeFileSync(join(t['briefs'], 'c1.md'), 'A brief that names no orchestrator.\n')
    const app = { origin: 'git@forge.example:o/app.git' }
    const repos: Record<string, Repo> = {
      [t['src']]: { branch: 'main', ...app }, [t['a1']]: { branch: 'feat/x', origin: 'https://forge.example/o/app.git' },
      [t['b1']]: { branch: 'feat/x', ...app }, [t['c1']]: { branch: 'feat/y', origin: 'ssh://git@forge.example/o/app' },
      [t['idle']]: { branch: 'feat/w', ...app }, [t['o1']]: { branch: 'feat/x', origin: 'git@forge.example:o/other.git' },
      [t['o2']]: { branch: 'feat/o', origin: 'git@forge.example:o/other.git' }, [t['n1']]: { branch: 'feat/x', origin: 'git@forge.example:o/none.git' },
    }
    const b = t['briefs']
    return {
      world: {
        repos,
        workspace: [t['a1'], t['b1'], t['c1'], t['idle'], t['o1'], t['o2'], t['n1'], '', join(t['briefs'])].map(p => `${p}   | x | y`).join('\n') + '\n',
        forge: { [t['src']]: '7 feat/x same\n8 feat/y same\n9 feat/z same\n10 feat/w same\nnoise\n', [t['o1']]: '' },
        ...over.world,
      },
      env: { COORDINATOR_FORGE: '/stand-in/forge', ...over.env },
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
      `session 100 | ttys100 | Orch: alpha | Orch: alpha | forge.example/o/app | main | ${src}`,
      `session 101 | ttys101 | Agent: a1 | Orch: alpha [aaa111] | forge.example/o/app | feat/x | ${a1}`,
      `session 102 | ttys102 | Agent: b1 | Orch: beta [bbb222] | forge.example/o/app | feat/x | ${b1}`,
      `session 103 | ttys103 | Agent: c1 | unknown | forge.example/o/app | feat/y | ${c1}`,
      `session 106 | ttys106 | Agent: o1 | Orch: gamma [ccc333] | forge.example/o/other | feat/x | ${o1}`,
      `checkout ${a1} | forge.example/o/app | feat/x`,
      `checkout ${b1} | forge.example/o/app | feat/x`,
      `checkout ${c1} | forge.example/o/app | feat/y`,
      `checkout ${idle} | forge.example/o/app | feat/w`,
      `checkout ${o1} | forge.example/o/other | feat/x`,
      `checkout ${o2} | forge.example/o/other | feat/o`,
      `heavy 200 | ${src} | bash ./tests/run-tests.sh`,
      `heavy 300 | ${a1} | timeout 595 /usr/bin/hostcli plugin eval . --case x`,
      `collision checkouts | forge.example/o/app | feat/x | ${a1}, ${b1}`,
      'collision sessions | forge.example/o/app | feat/x | 101 Agent: a1, 102 Agent: b1',
      'collision heavy | 200, 300',
      'collision pr | forge.example/o/app#7 | feat/x | Orch: alpha [aaa111], Orch: beta [bbb222]',
      `unread checkout ${t['briefs']}: not a git tree`,
    ])
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
    assert.ok(f.out.includes(`session 100 | ttys100 | Orch: alpha | Orch: alpha | - | - | -`))
  })

  it('says a forge and a process table it could not read', () => {
    const { f, t } = bench({ world: { forge: {} } })
    assert.equal(run(f, 'facts'), 2)
    assert.ok(f.out.includes(`unread forge forge.example/o/app: the forge does not know ${t['src']}`))
    assert.ok(f.out.includes(`unread forge forge.example/o/other: the forge does not know ${t['o1']}`))
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
    assert.deepEqual(withLsof.out, [`session 7 | ttys7 | Agent: s | unknown | h/o/r | m | ${dir('r')}`, 'unread directories: lsof failed: exit 1', 'unread forge h/o/r: the forge does not know pr'])
    const noLsof = fixture({ env: { ...f.ctx.env, PATH: dir('empty') }, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(noLsof, 'facts'), 2)
    assert.ok(noLsof.out.includes('unread directories: lsof is missing'))
    const noPs = fixture({ env: { ...f.ctx.env, ORCHESTRATOR_HOST_CLI: '' }, run: () => fail(1, '') })
    assert.equal(run(noPs, 'facts'), 2)
    assert.ok(noPs.out.includes('unread processes: ps failed'))
    assert.ok(noPs.out.some(l => l.startsWith("unread sessions: the host's name is unknown")))
  })

  it('reads the forge with gh in the tree when no stand-in is given', () => {
    const calls: string[] = []
    const { f, dir } = setup(d => ({
      world: { repos: { [d('r')]: { branch: 'feat/a', origin: 'h:o/r' } }, workspace: '', forge: { [d('r')]: '5 feat/a same\n' } },
      ps: '7 1 ttys7 hostcli --name Orch: r\n', cwds: `7 ${d('r')}\n`,
    }))
    const spy = fixture({ env: f.ctx.env, run: (c, a, o) => { calls.push(`${c} ${o?.cwd ?? ''}`); return f.ctx.run(c, a, o) } })
    assert.equal(run(spy, 'owners'), 0)
    assert.deepEqual(spy.out, [`pr h/o/r#5 | feat/a | Orch: r | session 7 in ${dir('r')}`])
    assert.ok(calls.includes(`gh ${dir('r')}`))
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
    put('remote', 'far', JSON.stringify({ name: 'Orch: far', machine: 'bench', waiting: 'operator', blocks: 'b', waiting_since: fresh, updated_at: fresh, context_tokens: 5, context_percent: 1, repo: 'o/app', prs: ['o/app#7', 'o/app#9', 'o/app#99', 'o/gone#5'] }))
    put('remote', 'near', JSON.stringify({ name: 'Orch: near', machine: 'lab', waiting: 'done', updated_at: fresh, prs: ['o/gone#5', 'nohash'] }))
    put('remote', 'quiet', JSON.stringify({ name: 'Orch: quiet', machine: 'lab', updated_at: fresh }))
    put('remote', 'old', JSON.stringify({ name: 'Orch: old', updated_at: '2020-01-01T00:00:00Z' }))
    put('remote', 'local', JSON.stringify({ name: 'Orch: alpha', updated_at: fresh }))
    put('remote', 'empty', '')
    put('remote', 'bad', 'not json')
    put('remote', 'far.tmp-1', 'half')
    assert.equal(run(f, 'facts'), 2)
    const lines = f.out.filter(l => /^(waiting|unattended|remote|collision pr|unread remote)/.test(l))
    assert.deepEqual(lines, [
      'waiting Orch: alpha | operator since S | blocks: phase 3',
      'waiting Orch: d | done since ?',
      'unattended Orch: alpha | PR délaissées : o/app#9',
      `remote Orch: far | on bench | updated ${fresh} | context 5 (1%) | repository o/app | prs o/app#7, o/app#9, o/app#99, o/gone#5 | operator since ${fresh} | blocks: b`,
      `remote Orch: near | on lab | updated ${fresh} | context 0 (0%) | repository none | prs o/gone#5, nohash | done since ?`,
      `remote Orch: quiet | on lab | updated ${fresh} | context 0 (0%) | repository none | prs none | working`,
      'collision pr | forge.example/o/app#7 | feat/x | Orch: alpha [aaa111], Orch: beta [bbb222], Orch: far',
      'collision pr | o/gone#5 | - | Orch: far, Orch: near',
      `unread remote ${join(f.ctx.env['ORCHESTRATOR_MODULE_DIR'] ?? '', 'store', 'remote', 'bad')}: not a JSON row`,
    ])
    assert.ok(NOW.getTime() > Date.parse(fresh))

    const owners = fixture({ env: f.ctx.env, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(owners, 'owners'), 2)
    assert.deepEqual(owners.out.filter(l => l.includes('remote on')), [
      `pr forge.example/o/app#9 | feat/z | Orch: far | remote on bench, updated ${fresh}`,
      `pr o/gone#5 | - | Orch: far | remote on bench, updated ${fresh}, not read on the forge here`,
      `pr o/gone#5 | - | Orch: near | remote on lab, updated ${fresh}, not read on the forge here`,
      `pr #nohash | - | Orch: near | remote on lab, updated ${fresh}, not read on the forge here`,
    ])
  })

  it('refuses an argument', () => {
    const f = fixture()
    assert.equal(run(f, 'facts', 'x'), 1)
    assert.equal(run(f, 'owners', 'x'), 1)
    assert.deepEqual(f.err, ['coordinator: facts: unexpected argument x', 'coordinator: owners: unexpected argument x'])
  })
})

describe('owners', () => {
  it('traces each open pull request to its orchestrator, else says why it cannot', () => {
    const { f, t } = bench()
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out.filter(l => l.startsWith('pr ')), [
      `pr forge.example/o/app#7 | feat/x | Orch: alpha [aaa111] | session 101 in ${t['a1']}`,
      `pr forge.example/o/app#7 | feat/x | Orch: beta [bbb222] | session 102 in ${t['b1']}`,
      `pr forge.example/o/app#8 | feat/y | unknown | session 103 in ${t['c1']} names no orchestrator`,
      'pr forge.example/o/app#9 | feat/z | unknown | no checkout on feat/z',
      `pr forge.example/o/app#10 | feat/w | unknown | no session in ${t['idle']}`,
    ])
  })

  it('says unknown for an idle checkout beside a busy one, two orchestrators in one checkout, a fork, no head, an unread brief', () => {
    const t: Record<string, string> = {}
    const { f } = setup(d => {
      t['v1'] = d('ws/v1'); t['v2'] = d('ws/v2'); t['d1'] = d('ws/d1'); t['k'] = d('ws/k'); t['adir'] = d('adir')
      const amb = { origin: 'git@h:o/amb.git' }
      return {
        world: {
          repos: { [t['v1']]: { branch: 'feat/v', ...amb }, [t['v2']]: { branch: 'feat/v', ...amb }, [t['d1']]: { branch: 'feat/d', ...amb }, [t['k']]: { branch: 'feat/k', ...amb } },
          workspace: `${t['v2']}\n`,
          forge: { [t['d1']]: '11 feat/v same\n12 feat/d same\n13 feat/f fork:someone\n14 feat/g\n15 feat/k same\n' },
        },
        env: { COORDINATOR_FORGE: '/stand-in' },
        ps: ['130 1 t Your orchestrator is Orch: a [aaa]. --name Agent: v1', '131 1 t hostcli Your orchestrator is Orch: a [aaa]. --name Agent: d1',
          '132 1 t hostcli Your orchestrator is Orch: b [bbb]. --name Agent: d2', `133 1 t hostcli Read and execute ${t['adir']} --name Agent: k`].join('\n'),
        cwds: `131 ${t['d1']}\n132 ${t['d1']}\n133 ${t['k']}\n`,
      }
    })
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out, [
      `pr h/o/amb#11 | feat/v | unknown | no session in ${t['v2']}`,
      `pr h/o/amb#12 | feat/d | unknown | sessions 131, 132 in ${t['d1']} name different orchestrators: Orch: a [aaa], Orch: b [bbb]`,
      'pr h/o/amb#13 | feat/f | unknown | head branch in a fork, owned by someone',
      'pr h/o/amb#14 | feat/g | unknown | the forge gave no head repository',
      `pr h/o/amb#15 | feat/k | unknown | session 133 in ${t['k']}: brief ${t['adir']} cannot be read`,
      `unread brief ${t['adir']}: cannot be read`,
    ])
  })

  it('gives a sleeping orchestrator its unknown pull requests, and says a sleeping record it cannot read', () => {
    const { f } = bench()
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'sleeping.json'), JSON.stringify([
      { name: 'Orch: gamma', slept: '2026-10-13T10:00:00Z', prs: ['forge.example/o/app#9 feat/z', 'forge.example/o/app#9 again', 'forge.example/o/app#7 feat/x', 3] },
      { name: 'Orch: none' }, 'not a record', { name: {}, prs: ['forge.example/o/app#10 feat/w'] },
    ]))
    assert.equal(run(f, 'owners'), 2)
    assert.deepEqual(f.out.filter(l => l.includes('#9 ') || l.includes('#10 ')), [
      'pr forge.example/o/app#9 | feat/z | Orch: gamma | sleeping since 2026-10-13T10:00:00Z',
      `pr forge.example/o/app#10 | feat/w | unknown | no session in ${f.out.find(l => l.includes('#10 '))?.split('no session in ')[1] ?? ''}`,
    ])
    writeFileSync(join(f.state, 'sleeping.json'), 'not json')
    const broken = fixture({ env: f.ctx.env, run: (c, a, o) => f.ctx.run(c, a, o) })
    assert.equal(run(broken, 'owners'), 2)
    assert.ok(broken.out.includes(`unread sleeping: the sleeping record ${join(f.state, 'sleeping.json')} cannot be read: remove or repair it`))
  })
})
