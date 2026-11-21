// hooks/tests/data-root.test.ts
// The two roots of the orchestrator's state as the module reads them (module-io.ts): the data the
// module writes follows the data root the protected root's data-root file names, and what decides
// who is trusted is read on the protected root alone, whatever the data root holds.
import { expect, test } from 'claude-code/testing'
import { hostOf } from '../../core/capture.ts'
import { DATA_ROOT_FILE } from '../../core/orchestration.ts'
import { writeMeasure } from '../gauge.ts'
import { dataDir, logLine, moduleDir, stateDir } from '../module-io.ts'
import { coordinatorRuns, writeDeck, writeSession } from '../supervision.ts'
import { holdsRecord } from '../wait.ts'
import { readTodos } from '../todo.ts'
import { todoPath } from '../todo-format.ts'
import { disk, logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const PROTECTED = `${HOME}/.claude/claude-orchestrator`
const DATA = '/tmp/shared/claude-orchestrator'
const rootFile = (dir: string): string => JSON.stringify({ version: 1, dir })

function hostOver(files: Map<string, string>, vars: Record<string, string> = {}) {
  const d = disk(files)
  const runs: (readonly string[])[] = []
  const $ = hostOf({
    plugin: { root: '/plugin' },
    env: { get: async (name: string) => ({ HOME, ...vars } as Record<string, string | undefined>)[name] },
    fs: {
      ...d.fs,
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
    session: { id: async () => 's1' },
    process: { run: async (argv: readonly string[]) => { runs.push(argv); return d.process.run(argv) } },
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
