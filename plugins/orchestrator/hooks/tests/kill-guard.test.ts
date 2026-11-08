// hooks/tests/kill-guard.test.ts
// The kill guard: what the tokeniser reads as a kill by name or pattern, the
// decision a launched session gets, and the wiring that serves it — the Bash
// handler's deny, the tool never asked. A session kills only what it started, by
// the pid it recorded in a file; `kill <pid>`, `kill $pid` and `kill $(cat <file>)`
// are that, and pass.
import { expect, test } from 'claude-code/testing'
import { guardFallback, killDecision, register as registerGuards } from '../guards.ts'
import { detectPatternKills } from '../tokenizer.ts'
import { logLineOf } from './fakes.ts'

// Kills by name or pattern: the program is pkill or killall, or kill takes its pids
// from a command substitution or, through xargs, from a lister.
const refused = [
  'pkill -f vite',
  'pkill vite',
  'pkill -x sleep',
  `pkill -f "eval 'sleep 60'"`,
  'killall node',
  'killall -9 node',
  '/usr/bin/pkill -f vite',
  '/usr/bin/killall node',
  'sudo pkill -f vite',
  'sudo -u root killall node',
  'env FOO=1 pkill -f x',
  'FOO=1 pkill -f x',
  'nohup pkill -f x',
  'timeout 5 pkill -f x',
  'command pkill -f x',
  'exec pkill -f x',
  'git status && pkill -f vite',
  'git status; pkill -f vite',
  'false || pkill -f vite',
  'sleep 1 & pkill -f vite',
  'echo done\npkill -f vite',
  '(cd x && pkill -f vite)',
  '{ pkill -f vite; }',
  'echo "$(pkill -f vite)"',
  'echo `pkill -f vite`',
  'if pkill -f vite; then echo ok; fi',
  'pgrep node | xargs pkill',
  'echo x | pkill -f vite',
  'pkill -f vite 2>/dev/null',
  'pkill "-f" vite',
  'cat <<EOF\ntext\nEOF\npkill -f vite',
  'kill $(pgrep -f vite)',
  'kill -9 $(pgrep -f vite)',
  'kill -TERM $(pidof node)',
  'kill $(lsof -ti :3000)',
  'kill $(ps aux | grep vite | awk \'{print $2}\')',
  'kill "$(pgrep -f vite)"',
  'kill `pgrep -f vite`',
  'kill -9 `lsof -ti :3000`',
  '/bin/kill $(pgrep node)',
  'sudo kill $(pgrep node)',
  // Only `cat <one file>` is a recorded pid: anything else in a substitution is a lookup.
  'kill $(cat a | grep x)',
  'kill $(cat a; pgrep x)',
  'kill $(cat a && pgrep x)',
  'kill $(cat a b)',
  'kill $(cat -n a)',
  'kill $(cat *.pid)',
  'kill $(cat pids?.txt)',
  'kill $(cat)',
  'kill $(cat $(pgrep x))',
  'kill $(cat "$(pgrep x)")',
  'kill $(sudo cat a)',
  'kill $(ps aux)',
  'kill $(ps -ef | grep vite)',
  'kill $(cat a.pid) $(pgrep x)',
  'kill $(pgrep x) $(cat a.pid)',
  'kill "$(cat a | grep x)"',
  'kill `cat a | grep x`',
  'kill -9 $(cat a; pgrep x)',
  'pgrep node | xargs kill',
  'pgrep -f vite | xargs kill -9',
  'pgrep -f vite | xargs -r kill',
  'pidof node | xargs kill',
  'lsof -ti :3000 | xargs kill',
  'ps aux | xargs kill',
  'ps aux | grep vite | awk \'{print $2}\' | xargs kill -9',
  'pgrep node | sudo xargs kill',
  'pgrep node |\n  xargs kill',
  'pgrep node |& xargs kill',
  'pgrep node | xargs -n 1 kill',
  'pgrep node | xargs -I {} kill {}',
  '/usr/bin/pgrep node | xargs kill',
  'pgrep x | xargs -I % kill %',
  // The string a shell runs, or eval, is a command line of its own.
  `bash -c 'pkill x'`,
  'sh -c "killall node"',
  'bash -lc "pkill -f vite"',
  'eval "pkill x"',
  'eval pkill x',
  'timeout 5 bash -c "pkill -f vite"',
  `zsh -c 'pkill x'`,
  `dash -c 'killall node'`,
  `ksh -c 'pkill x'`,
  `/bin/bash -c 'pkill x'`,
  `sudo bash -c 'pkill x'`,
  `bash -x -c 'pkill x'`,
  `bash -o pipefail -c 'pkill x'`,
  `bash -euo pipefail -c 'pkill x'`,
  `bash -c 'echo ok; pkill x'`,
  `bash -c 'kill $(pgrep x)'`,
  `bash -c 'pgrep x | xargs kill'`,
  `echo x && bash -c 'pkill x'`,
  `bash -c "bash -c 'pkill x'"`,
  `xargs -I {} bash -c 'pkill x'`,
]

// Not kills: a recorded pid, a variable, a job, a liveness probe, a lister alone,
// and every word that is data — quotes, heredoc bodies, arguments of other programs.
const accepted = [
  'kill 1234',
  'kill -9 1234',
  'kill -TERM 1234 5678',
  'kill $pid',
  'kill "$pid"',
  'kill ${pid}',
  'kill -9 "$pid"',
  'kill %1',
  'kill -0 1234',
  'kill -0 $(pgrep -f vite)',
  'kill -l',
  'sleep 60 & pid=$!; kill $pid',
  // A pid kept in a file survives from one call to the next: `cmd & echo $! > f`, then `kill $(cat f)`.
  'kill $(cat /tmp/pids)',
  'kill $(cat server.pid)',
  'kill "$(cat /tmp/x.pid)"',
  'kill `cat server.pid`',
  'kill -9 $(cat server.pid)',
  'kill -TERM $(cat f.pid)',
  'kill -s TERM $(cat f.pid)',
  'kill $(cat $PIDFILE)',
  'kill "$(cat "$PIDFILE")"',
  'kill $(cat ~/run/x.pid)',
  "kill $(cat 'my server.pid')",
  'sudo kill $(cat server.pid)',
  'kill $(cat a.pid) $(cat b.pid)',
  'kill $(cat a.pid) 1234',
  'echo $(cat f.pid); kill 1234',
  'cmd & echo $! > f.pid',
  'pgrep -f vite',
  'pgrep node | wc -l',
  'pgrep node | head -1',
  'ps aux | grep vite',
  'pidof node',
  'lsof -ti :3000',
  'echo "pkill -f x"',
  "echo 'killall node'",
  'git commit -m "stop using pkill -f vite"',
  'git commit -m "fix: kill $(pgrep x) is refused"',
  'gh pr create --body "pkill and killall are refused"',
  'grep pkill file',
  'grep -rn killall hooks/',
  'cat file | grep pkill',
  'man pkill',
  'which pkill',
  'type killall',
  'echo pkill',
  'git commit -F - <<\'EOF\'\npkill -f vite\nkill $(pgrep x)\nEOF',
  'cat <<EOF\npkill -f vite\nEOF',
  'git status # pkill -f vite',
  'echo $((1 << 2)) && kill 1234',
  'ls pkill-guard/',
  'xargs echo',
  'pgrep node | xargs echo',
  'cat pids | xargs kill',
  'echo 1234 | xargs kill',
  'pgrep node; xargs kill',
  'pgrep node || xargs kill',
  'pgrep node\nkill 1234',
  'echo $(pgrep node)',
  'git status',
  '',
  // The lister is read only from the pipe the kill is in: another separator, or a
  // kill with no xargs, takes no pid from it.
  'pgrep x | cat; xargs kill',
  'pgrep x; echo | xargs kill',
  'pgrep x | kill 5',
  // A shell string with no kill by pattern, and a shell with no string to run.
  `bash -c 'kill $pid'`,
  `bash -c 'echo pkill'`,
  `bash -c 'kill 1234'`,
  'bash script.sh',
  `bash script.sh -c 'pkill x'`,
  `bash -o pipefail script.sh -c 'pkill x'`,
  'bash -c',
  'eval',
  'eval "echo pkill"',
  'eval kill 1234',
  // A lookup finds the program and runs nothing.
  'command -v pkill',
  'command -V killall',
  'command -pv pkill',
  'command -v pkill >/dev/null && echo found',
]

test('every kill by name or pattern is read as one, with a reason', () => {
  for (const c of refused) expect(detectPatternKills(c), c).not.toEqual([])
})

test('a kill by pid, a variable, a job, a probe and every word that is data pass', () => {
  for (const c of accepted) expect(detectPatternKills(c), c).toEqual([])
})

test('each kill found names itself once', () => {
  expect(detectPatternKills('pkill -f a; pkill -f b')).toEqual(['pkill'])
  expect(detectPatternKills('pkill -f a; killall b')).toEqual(['pkill', 'killall'])
  expect(detectPatternKills('kill $(pgrep a); pgrep b | xargs kill')).toHaveLength(2)
})

test('a kill in a pipeline reads the lister before it, not one behind another separator', () => {
  expect(detectPatternKills('pgrep a | xargs kill')).not.toEqual([])
  expect(detectPatternKills('pgrep a && xargs kill')).toEqual([])
  expect(detectPatternKills('pgrep a & xargs kill')).toEqual([])
})

test('the string of a shell -c and of eval is read for kills, its reasons joined to the line\'s', () => {
  expect(detectPatternKills(`bash -c 'pkill x'`)).toEqual(['pkill'])
  expect(detectPatternKills('eval "killall node"')).toEqual(['killall'])
  expect(detectPatternKills(`pkill a; bash -c 'killall b'`)).toEqual(['pkill', 'killall'])
  expect(detectPatternKills(`pkill a; sh -c 'pkill b'`)).toEqual(['pkill'])
  expect(detectPatternKills(`bash -c 'kill $(pgrep x)'`)).toEqual(['kill of a command substitution'])
})

test('a shell string nested four deep is still read', () => {
  const nest = (inner: string) => `bash -c "${inner.replace(/(["\\$`])/g, '\\$1')}"`
  const four = nest(nest(nest(nest('pkill x'))))
  expect(detectPatternKills(four)).toEqual(['pkill'])
})

test('a lookup with command -v or -V runs nothing, a command that runs still reads', () => {
  expect(detectPatternKills('command -v pkill')).toEqual([])
  expect(detectPatternKills('command -V killall')).toEqual([])
  expect(detectPatternKills('command -v pkill && pkill -f x')).toEqual(['pkill'])
  expect(detectPatternKills('command -p pkill -f x')).toEqual(['pkill'])
})

test('a substitution in one command does not make the next one a kill', () => {
  expect(detectPatternKills('echo $(date); kill 1234')).toEqual([])
  expect(detectPatternKills('kill 1234; echo $(date)')).toEqual([])
})

test('a pid kept in a file is a recorded pid, any other substitution is a lookup', () => {
  expect(detectPatternKills('kill $(cat server.pid)')).toEqual([])
  expect(detectPatternKills('kill "$(cat /tmp/x.pid)"')).toEqual([])
  expect(detectPatternKills('kill $(pgrep x)')).toEqual(['kill of a command substitution'])
  expect(detectPatternKills('kill $(cat a | grep x)')).toEqual(['kill of a command substitution'])
  expect(detectPatternKills('kill $(cat a.pid) $(pgrep x)')).toEqual(['kill of a command substitution'])
  expect(detectPatternKills('pgrep x | xargs kill $(cat f.pid)')).toEqual(['kill fed through xargs by pgrep'])
  expect(detectPatternKills('bash -c \'kill $(cat f.pid)\'')).toEqual([])
})

// Kills wider than one process: -1 is every process of the user, 0 the caller's process
// group, a negative number a whole group. The signal comes first (-9, -TERM, -s TERM,
// -n 9), `--` ends the options, and what follows is a target.
const wide = [
  'kill -9 -1',
  'kill -- -1',
  'kill 0',
  'kill -TERM -$$',
  'kill -1',
  'kill -KILL -1',
  'kill -SIGKILL -1',
  'kill -s TERM -1',
  'kill -s 9 -1',
  'kill -n 9 -1',
  'kill -9 -- -1',
  'kill -s TERM -- -1',
  'kill -- 0',
  'kill -9 0',
  'kill -TERM 0',
  'kill -1 -1',
  'kill 1234 -1',
  'kill -9 1234 0',
  'kill -9 -1234',
  'kill -- -1234',
  'kill -s TERM -1234',
  'kill -9 -$$',
  'kill -9 -$pgid',
  'kill -9 -${pgid}',
  'kill -9 -"$pgid"',
  'kill -9 -"$$"',
  'kill -TERM -$pgid',
  'kill -9 -$(cat pgid.pid)',
  '/bin/kill -9 -1',
  'sudo kill -9 -1',
  'env kill -9 -1',
  'kill -9 -1 2>/dev/null',
  'echo x; kill 0',
  'git status && kill -9 -1',
  '(kill -9 -1)',
  'echo x | xargs kill -9 -1',
  "bash -c 'kill -9 -1'",
  'eval "kill -- -1"',
  'kill -9 $(cat f.pid) -1',
  'kill -TERM -1 1234',
]

// One process, or a probe, or a list of signals: none of them wide.
const narrow = [
  'kill -9 1234',
  'kill -s TERM 1234',
  'kill -n 9 1234',
  'kill -- 1234',
  'kill -9 -- 1234',
  'kill -TERM $(cat f.pid)',
  'kill -TERM -s',
  'kill -1 1234',
  'kill -HUP 1234 5678',
  'kill 1',
  'kill 10',
  'kill 100 200',
  'kill -9 %1',
  'kill $pid',
  'kill -9 "$pid"',
  'kill -0 -1',
  'kill -0 0',
  'kill -l',
  'kill -L',
  'kill -l 9',
  'kill -9',
  'kill',
  'echo kill -9 -1',
  'echo "kill 0"',
  'git commit -m "kill -9 -1 is refused"',
  'grep -- -1 file',
  'ls -1',
  'sleep 0',
  'bash -c "kill -9 1234"',
  'kill -9 -s',
]

test('a kill of every process or of a process group is read as one, with a reason', () => {
  for (const c of wide) expect(detectPatternKills(c), c).toEqual(['kill of all processes or a process group'])
})

test('a kill of one process, a probe and a list of signals are not wide', () => {
  for (const c of narrow) expect(detectPatternKills(c), c).toEqual([])
})

test('a wide kill and a kill by lookup name themselves each', () => {
  expect(detectPatternKills('kill -9 -1 $(pgrep x)')).toEqual(['kill of a command substitution', 'kill of all processes or a process group'])
  expect(detectPatternKills('kill -9 -1; kill 0')).toEqual(['kill of all processes or a process group'])
  expect(detectPatternKills('pgrep x | xargs kill -9 -1')).toEqual(['kill fed through xargs by pgrep', 'kill of all processes or a process group'])
})

// The decision: nothing in a session the launcher did not mark, a refusal in a
// marked one.
const DENY_START = 'kill refused: this session was spawned by the launcher'

test('a marked session refuses a kill by pattern and names the pid it should keep', () => {
  const d = killDecision('1', 'pkill -f vite')
  expect(d?.deny).toContain(DENY_START)
  expect(d?.deny.startsWith(DENY_START)).toBe(true)
  expect(d?.deny).toContain('cmd & echo $! > <file>')
  expect(d?.deny).toContain('kill $(cat <file>)')
  expect(d?.deny).toContain('Seen: pkill.')
})

test('the deny text is the contract, reasons spliced', () => {
  expect(killDecision('1', 'pkill -f a; killall b')?.deny).toBe(
    'kill refused: this session was spawned by the launcher, and it kills only what it started, by the pid it recorded in a file (start it with `cmd & echo $! > <file>`, end it with `kill $(cat <file>)`). A kill by name or pattern can end other sessions\' processes. Seen: pkill, killall.',
  )
})

test('an unmarked session and a kill by pid both pass', () => {
  expect(killDecision(undefined, 'pkill -f vite')).toBeNull()      // the operator's own sessions
  expect(killDecision(null, 'killall node')).toBeNull()
  expect(killDecision('', 'pkill -f vite')).toBeNull()
  expect(killDecision('1', 'kill 1234')).toBeNull()
  expect(killDecision('1', 'kill $pid')).toBeNull()
  expect(killDecision('1', 'echo "pkill -f x"')).toBeNull()
  expect(killDecision('1', '')).toBeNull()
})

test('a mark never read refuses a kill by pattern with the reason the guard did not finish', () => {
  const d = guardFallback(undefined, 'pkill -f vite', 'the marker cannot be read')
  expect(d?.deny).toContain('kill refused')
  expect(d?.deny).toContain('the marker cannot be read')
  expect(d?.deny).toContain('Seen: pkill')
  expect(guardFallback(undefined, 'kill 1234', 'the marker cannot be read')).toBeNull()
  expect(guardFallback(undefined, 'kill $(cat server.pid)', 'the marker cannot be read')).toBeNull()
  expect(guardFallback(undefined, 'kill -9 -1', 'the marker cannot be read')?.deny).toContain('Seen: kill of all processes or a process group')
  expect(guardFallback(undefined, 'git status', 'the marker cannot be read')).toBeNull()
})

test('a mark as last read decides the fallback: closed when marked, open when the operator\'s own', () => {
  expect(guardFallback('1', 'pkill -f vite', 'x')?.deny).toContain(DENY_START)
  expect(guardFallback(null, 'pkill -f vite', 'x')).toBeNull()
})

// The wiring half: the whole of the reduced $ faked.
const HOME = '/tmp/h'

function fakeDollar(setup: { spawned?: string; noEnv?: boolean }): { dollar: any; written: string[] } {
  const written: string[] = []
  const env = { HOME, ...(setup.spawned === undefined ? {} : { ORCHESTRATOR_SPAWNED: setup.spawned }) }
  const dollar = {
    env: {
      get: async (name: string) => {
        if (name === 'ORCHESTRATOR_SPAWNED' && setup.noEnv) throw new Error('the marker cannot be read')
        return env[name]
      },
    },
    fs: {
      read: async (p: string) => { throw new Error(`unread: ${p}`) },
      write: async () => undefined,
    },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) written.push(line)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, written }
}

function mounted(): { handlers: Record<string, Function> } {
  const handlers: Record<string, Function> = {}
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  return { handlers }
}

const bashCall = (command: string) => ({ tool: 'Bash', tool_use_id: 't1', command })

async function callBash(handler: Function, dollar: any, e: object) {
  let passedThrough: unknown = null
  const answer = await handler(dollar, e, (x: unknown) => { passedThrough = x; return x })
  return { answer, passedThrough }
}

test("a marked session's kill by pattern is denied, the tool never asked", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ spawned: '1' })
  for (const c of ['pkill -f vite', 'killall node', 'kill $(pgrep -f vite)', 'pgrep node | xargs kill']) {
    const { answer, passedThrough } = await callBash(handlers['tool.call'], dollar, bashCall(c))
    expect((answer as any).deny, c).toContain(DENY_START)
    expect(passedThrough, c).toBeNull()
  }
})

test("a marked session's wide kill is denied, the tool never asked", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ spawned: '1' })
  for (const c of ['kill -9 -1', 'kill -- -1', 'kill 0', 'kill -TERM -$$']) {
    const { answer, passedThrough } = await callBash(handlers['tool.call'], dollar, bashCall(c))
    expect((answer as any).deny, c).toContain(DENY_START)
    expect((answer as any).deny, c).toContain('Seen: kill of all processes or a process group.')
    expect(passedThrough, c).toBeNull()
  }
})

test("a marked session's kill by pid reaches the tool untouched", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ spawned: '1' })
  for (const c of ['kill 1234', 'kill $pid', 'kill -0 $(pgrep x)', 'kill $(cat server.pid)', 'kill -TERM "$(cat /tmp/x.pid)"', 'kill -9 1234']) {
    const e = bashCall(c)
    const { answer, passedThrough } = await callBash(handlers['tool.call'], dollar, e)
    expect(passedThrough, c).toBe(e)
    expect(answer, c).toBe(e)
  }
})

test("an unmarked session's kill by pattern reaches the tool untouched", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({})                       // no marker: the operator's own session
  const e = bashCall('pkill -f vite')
  const { answer, passedThrough } = await callBash(handlers['tool.call'], dollar, e)
  expect(passedThrough).toBe(e)
  expect(answer).toBe(e)
})

test("a marked session's forced push reaches the tool: the forge refuses it, not a reading of its text", async () => {
  const { handlers } = mounted()
  const { dollar } = fakeDollar({ spawned: '1' })
  const e = bashCall('git push --force origin main')
  const { answer, passedThrough } = await callBash(handlers['tool.call'], dollar, e)
  expect(passedThrough).toBe(e)
  expect(answer).toBe(e)
})

test('a handler that cannot read its marker refuses a kill by pattern alone, with the reason', async () => {
  const { handlers } = mounted()
  const { dollar, written } = fakeDollar({ noEnv: true })
  const killed = await callBash(handlers['tool.call'], dollar, bashCall('pkill -f vite'))
  expect((killed.answer as any).deny).toContain('kill refused')
  expect((killed.answer as any).deny).toContain('the marker cannot be read')
  expect(killed.passedThrough).toBeNull()
  expect(written.length).toBe(1)
  const e = bashCall('kill 1234')
  const byPid = await callBash(handlers['tool.call'], dollar, e)
  expect(byPid.answer).toBe(e)
})

// The registered net: a re-entered call, or one past its budget, decides on the mark
// the guard read last.
function mountedNet(): { body: Function; net: Function } {
  let body: Function = () => undefined
  let net: Function = () => undefined
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const isBash = args[0] === 'tool.call'
    if (isBash) body = args[args.length - 1] as Function
    return { catch: (handler: Function) => { if (isBash) net = handler } }
  })
  return { body, net }
}

test("the net refuses a spawned session's kill by pattern when the guard could not finish", async () => {
  const { body, net } = mountedNet()
  const marked = fakeDollar({ spawned: '1' })
  await callBash(body, marked.dollar, bashCall('git status'))
  const failed: any = (x: unknown) => x
  failed.called = false
  failed.error = { kind: 'budget', message: 'the hook ran past its budget' }
  const refused = await net(marked.dollar, bashCall('pkill -f vite'), failed)
  expect(refused.deny).toContain(DENY_START)
  const e = bashCall('kill 1234')
  expect(await net(marked.dollar, e, failed)).toBe(e)
})

test("the net lets an operator's own session kill by pattern when the guard could not finish", async () => {
  const { body, net } = mountedNet()
  const own = fakeDollar({})
  await callBash(body, own.dollar, bashCall('git status'))
  const failed: any = (x: unknown) => x
  failed.called = false
  failed.error = { kind: 'budget', message: 'the hook ran past its budget' }
  const e = bashCall('pkill -f vite')
  expect(await net(own.dollar, e, failed)).toBe(e)
})
