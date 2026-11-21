// hooks/tests/data-root.test.ts
// The two roots of the orchestrator's state as the module reads them (module-io.ts): the data the
// module writes follows the data root the protected root's data-root file names, and what decides
// who is trusted is read on the protected root alone, whatever the data root holds.
import { expect, test } from 'claude-code/testing'
import { hostOf } from '../../core/capture.ts'
import { DATA_ROOT_FILE } from '../../core/orchestration.ts'
import { writeMeasure } from '../gauge.ts'
import { dataDir, logLine, moduleDir, stateDir } from '../module-io.ts'
import { coordinatorRuns, writeSession } from '../supervision.ts'
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
    fs: { ...d.fs, exists: async (path: string) => files.has(path), list: async () => [] },
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
