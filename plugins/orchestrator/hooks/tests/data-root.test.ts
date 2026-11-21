// hooks/tests/data-root.test.ts
// The two roots of the orchestrator's state as the module reads them (module-io.ts): the data the
// module writes follows the data root the protected root's data-root file names, and what decides
// who is trusted is read on the protected root alone, whatever the data root holds.
import { expect, test } from 'claude-code/testing'
import { hostOf } from '../../core/capture.ts'
import { DATA_ROOT_FILE } from '../../core/orchestration.ts'
import { writeMeasure } from '../gauge.ts'
import { briefRowOf } from '../ledger.ts'
import { dataDir, logLine, moduleDir, stateDir } from '../module-io.ts'
import { coordinatorRuns, deleteSession, reportGate, writeDeck, writeSession } from '../supervision.ts'
import { holdsRecord } from '../wait.ts'
import { readTodos } from '../todo.ts'
import { todoPath } from '../todo-format.ts'
import { disk, logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const PROTECTED = `${HOME}/.claude/claude-orchestrator`
const DATA = '/tmp/shared/claude-orchestrator'
const rootFile = (dir: string): string => JSON.stringify({ version: 1, dir })

/*
 * `links`: links planted in the data root, each name toward its target. The host's plain write and
 * read follow a link; a rename onto one replaces it and `rm -f` removes it, as rename(2) and
 * unlink(2) do. `refuse`: the first words of the runs that exit 1. A send is delivered when the
 * launch names an orchestrator (ORCHESTRATOR_REPORTS_TO).
 */
function hostOver(files: Map<string, string>, vars: Record<string, string> = {}, links = new Map<string, string>(), refuse: string[] = []) {
  const d = disk(files)
  const runs: (readonly string[])[] = []
  const $ = hostOf({
    plugin: { root: '/plugin' },
    env: { get: async (name: string) => ({ HOME, ...vars } as Record<string, string | undefined>)[name] },
    fs: {
      ...d.fs,
      write: async (path: string, text: string) => d.fs.write(links.get(path) ?? path, text),
      read: async (path: string) => d.fs.read(links.get(path) ?? path),
      exists: async (path: string) => files.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)),
      // The entries right under `dir`, files and directories, as the host lists them.
      list: async (dir: string) => {
        const below = [...files.keys()].filter(key => key.startsWith(`${dir}/`)).map(key => key.slice(dir.length + 1))
        if (below.length === 0) throw new Error(`ENOENT: ${dir}`)
        const dirs = [...new Set(below.filter(key => key.includes('/')).map(key => key.split('/')[0] ?? ''))]
        return [
          ...below.filter(key => !key.includes('/')).map(name => ({ name, kind: 'file' as const, size: 0, isLink: false, mtimeMs: 1 })),
          ...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, isLink: false, mtimeMs: 1 })),
        ]
      },
    },
    session: { id: async () => 's1', send: async () => (vars['ORCHESTRATOR_REPORTS_TO'] ? { isDelivered: true } : { isDelivered: false, reason: 'nobody' }) },
    prompt: { submit: async () => undefined },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push(argv)
        if (refuse.includes(argv[0] ?? '')) return { exitCode: 1, stdout: '', stderr: '' }
        if (argv[0] === 'mv') links.delete(String(argv[3]))
        if (argv[0] === 'rm') for (const path of argv.slice(2)) links.delete(path)
        return d.process.run(argv)
      },
    },
    clock: d.clock,
  })
  return { $, runs }
}

test('with no data-root file the data stays on the protected root', async () => {
  const { $ } = hostOver(new Map())
  expect(await stateDir($)).toBe(PROTECTED)
  expect(await dataDir($)).toBe(PROTECTED)
  expect(await moduleDir($)).toBe(PROTECTED)
})

test('the data root is the one the protected root names, never one a file in the data root names', async () => {
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [`${DATA}/${DATA_ROOT_FILE}`, rootFile('/tmp/elsewhere')]])
  const { $ } = hostOver(files)
  expect(await stateDir($)).toBe(PROTECTED)
  expect(await dataDir($)).toBe(DATA)
  expect(await moduleDir($)).toBe(DATA)
})

test('a data-root file that names no absolute directory leaves the data on the protected root', async () => {
  for (const text of ['{', JSON.stringify({ version: 2, dir: DATA }), rootFile('relative/dir'), rootFile('/x\ny')]) {
    const { $ } = hostOver(new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, text]]))
    expect(await dataDir($)).toBe(PROTECTED)
  }
})

test('the harness variables keep their reach: the state override names the protected root, the module override its own files', async () => {
  const files = new Map([[`/tmp/state/${DATA_ROOT_FILE}`, rootFile('/tmp/state-data')], [`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)]])
  const { $ } = hostOver(files, { ORCHESTRATOR_STATE_DIR: '/tmp/state' })
  expect(await stateDir($)).toBe('/tmp/state')
  expect(await dataDir($)).toBe('/tmp/state-data')
  expect(await moduleDir($)).toBe(DATA)
  const sandboxed = hostOver(files, { ORCHESTRATOR_MODULE_DIR: '/tmp/mod' })
  expect(await moduleDir(sandboxed.$)).toBe('/tmp/mod')
})

test('the module writes its measure, its row and its log under the data root, nothing under the protected one', async () => {
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)]])
  const { $, runs } = hostOver(files)
  await writeMeasure($, 's1', { context_tokens: 1, context_window: 2, context_percent: 3, model: 'm', updated_at: 't' })
  await writeSession($, 's1', { role: 'agent', context_percent: 3 })
  await logLine($, 'test', 'a line')
  expect(files.has(`${DATA}/measure/s1.json`)).toBe(true)
  expect(files.has(`${DATA}/store/sessions/s1`)).toBe(true)
  const log = runs.find(argv => logLineOf(argv) !== null)
  expect(log?.[2]).toBe(`${DATA}/hooks-module.log`)
  expect([...files.keys()].filter(path => path.startsWith(`${PROTECTED}/`))).toEqual([`${PROTECTED}/${DATA_ROOT_FILE}`])
})

test('the coordinator\'s record is read on the protected root: one planted in the data root names no coordinator', async () => {
  const record = JSON.stringify({ name: 'Coord: c', tty: '/dev/ttys001', started: 't', pid: '' })
  const planted = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [`${DATA}/coordinator.json`, record]])
  expect(await coordinatorRuns(hostOver(planted).$)).toBe(false)
  const kept = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [`${PROTECTED}/coordinator.json`, record]])
  // A record naming no pid cannot be told gone: it counts as live, read where it belongs.
  expect(await coordinatorRuns(hostOver(kept).$)).toBe(true)
})

test('an agent\'s launch file is read under the protected root: one planted in the data root names no brief', async () => {
  const launch = (brief: string): string => `#!/bin/sh\nexport ORCHESTRATOR_BRIEF=${brief} && run\n`
  const row = (id: number): string => `# b\n\nYou are the implementer of row ${id} of the dispatch record.\n`
  const name = 'launch-Agent--a-1700000000000.sh'
  const files = new Map([
    [`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)],
    [`${DATA}/prompts/${name}`, launch('/b/planted.md')], ['/b/planted.md', row(666)],
  ])
  expect(await briefRowOf(hostOver(files).$, 'Agent: a')).toBeUndefined()
  files.set(`${PROTECTED}/prompts/${name}`, launch('/b/real.md'))
  files.set('/b/real.md', row(57))
  expect(await briefRowOf(hostOver(files).$, 'Agent: a')).toEqual({ row: 57, dir: '/b' })
})

test('a holder\'s to-do list is read under the data root, never one left on the protected root', async () => {
  const item = (label: string): string => `${JSON.stringify({ v: 1, id: 1, opened: '2026-11-21T09:00:00Z', label, state: 'open', verdict: '', words: 'w', said_at: '2026-11-21T09:00:00Z', from: 'Orch: o', agent: 'Agent: a' })}\n`
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [todoPath(DATA, 'Orch: o'), item('shared')], [todoPath(PROTECTED, 'Orch: o'), item('stale')]])
  expect((await readTodos(hostOver(files).$, 'Orch: o')).map(one => one.label)).toEqual(['shared'])
})

test('the deck is written under the data root, from the chains and the round there and the sleepers\' record of the protected root', async () => {
  const sleeper = (name: string): string => JSON.stringify([{ name, slept: '2026-11-21T09:00:00Z', dir: '/w', prs: [] }])
  const entry = (id: string, from: string): string => `${JSON.stringify({ id, from, session: 's1', kind: 'operator', since: '2026-11-21T09:00:00Z', blocks: 'b', question: 'q?', choices: [], recommendation: null, status: 'open', at: '2026-11-21T09:00:00Z', answer: null })}\n`
  const files = new Map([
    [`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)],
    [`${PROTECTED}/sleeping.json`, sleeper('Orch: kept')], [`${DATA}/sleeping.json`, sleeper('Orch: planted')],
    [`${DATA}/round/x.json`, entry('x', 'Orch: shared')], [`${PROTECTED}/round/y.json`, entry('y', 'Orch: stale')],
    [`${DATA}/chains/ttys003.jsonl`, '{"tab_id":"t1","tty":"/dev/ttys005","owner":"o1"}\n'],
  ])
  const { $ } = hostOver(files)
  await writeDeck($)
  const deck = JSON.parse(files.get(`${DATA}/deck.json`) ?? 'null')
  expect(files.has(`${PROTECTED}/deck.json`)).toBe(false)
  expect(deck.sleeping.map((one: { name: string }) => one.name)).toEqual(['Orch: kept'])
  expect(deck.round.open).toBe(1)
})

test('the stop gate holds a done on the open rows of a record the data root\'s registry names, not one left on the protected root', async () => {
  const record = '/briefs/o/dispatch-record.jsonl'
  const base = (): Map<string, string> => new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [record, `${JSON.stringify({ id: 1, state: 'open', label: 'a row' })}\n`]])
  const run = async (files: Map<string, string>): Promise<string | null> => {
    const { $ } = hostOver(files)
    await writeSession($, 's1', { role: 'orchestrator', name: 'Orch: o' })
    return holdsRecord($, { kind: 'done', blocks: 'nothing' })
  }
  const shared = base()
  shared.set(`${DATA}/records/s1`, `${record}\n`)
  expect(await run(shared)).not.toBe(null)
  const stale = base()
  stale.set(`${PROTECTED}/records/s1`, `${record}\n`)
  expect(await run(stale)).toBe(null)
})

// The fixed names the module writes in the data root, where any session may plant a link toward a
// protected file: each is put in place by a rename, so the link is replaced and its target untouched.
const TARGET = `${PROTECTED}/config.json`
const KEPT = '{"modes":{"Agent":"auto"}}\n'
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('the gate mark is put in place by a rename: a link planted at it leaves its target untouched, under the gate and over it', async () => {
  const gate = `${DATA}/store/gates/s1`
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [TARGET, KEPT]])
  const links = new Map([[gate, TARGET]])
  const { $ } = hostOver(files, { ORCHESTRATOR_CONTEXT_GATE_TOKENS: '200000' }, links)
  // Under the gate a mark read is cleared: through the link, the protected file would be emptied.
  await reportGate($, 's1', 'Agent: a', '/dev/ttys005', { context_tokens: 1000, context_percent: 1, context_window: 1000000 })
  expect(files.get(TARGET)).toBe(KEPT)
  expect(links.has(gate)).toBe(false)
  expect(files.get(gate)).toBe('')
  // Over it, a link planted again toward an empty protected file reads as no mark: the agent told,
  // its mark lands on the gate's own name, never in that file.
  const empty = `${PROTECTED}/prompts/launch-Agent--a-1700000000000.sh`
  files.set(empty, '')
  links.set(gate, empty)
  files.delete(gate)
  await reportGate($, 's1', 'Agent: a', '/dev/ttys005', { context_tokens: 210000, context_percent: 21, context_window: 1000000 })
  await settled()
  expect(files.get(empty)).toBe('')
  expect(files.get(gate)).toBe('told\n')
})

test('the gate mark of a report delivered to the orchestrator is put in place by a rename: a link planted at it leaves its target untouched', async () => {
  const gate = `${DATA}/store/gates/s1`
  const empty = `${PROTECTED}/prompts/launch-Agent--a-1700000000000.sh`
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [empty, ''], [`${HOME}/.claude/sessions/1.json`, JSON.stringify({ sessionId: 's-orch', name: 'Orch: o', startedAt: 1 })]])
  const { $ } = hostOver(files, { ORCHESTRATOR_CONTEXT_GATE_TOKENS: '200000', ORCHESTRATOR_REPORTS_TO: 'Orch: o [a1b2c3]' }, new Map([[gate, empty]]))
  await reportGate($, 's1', 'Agent: a', '/dev/ttys005', { context_tokens: 210000, context_percent: 21, context_window: 1000000 })
  await settled()
  expect(files.get(empty)).toBe('')
  expect(files.get(gate)).toBe('reported\n')
})

test('a session end whose remove fails empties its row by a rename: a link planted at the row leaves its target untouched', async () => {
  const row = `${DATA}/store/sessions/s1`
  const files = new Map([[`${PROTECTED}/${DATA_ROOT_FILE}`, rootFile(DATA)], [TARGET, KEPT]])
  const { $ } = hostOver(files, {}, new Map([[row, TARGET]]), ['rm'])
  await deleteSession($, 's1')
  expect(files.get(TARGET)).toBe(KEPT)
  expect(files.get(row)).toBe('')
})
