// hooks/tests/tab-question.test.ts
// The question kept in sight in its sender's own tab: the band above the prompt shows an open
// operator entry of this very session until it is answered, closed or withdrawn, wherever that
// happened, and the clock that reads the round moves it within one tick.
import { expect, test } from 'claude-code/testing'
import { register as registerGauge } from '../gauge.ts'
import { registerTabBand } from '../supervision.ts'
import type { RoundEntry } from '../round.ts'

const HOME = '/tmp/h'
const ROUND = `${HOME}/.claude/claude-orchestrator/round`
const CHOICES = [
  { letter: 'A', text: 'merge it now' },
  { letter: 'B', text: 'wait a day' },
]

function entry(over: Partial<RoundEntry> = {}): RoundEntry {
  return {
    id: 'Orch-w-1005', from: 'Orch : w', session: 's-own', kind: 'operator', since: '2026-10-30T15:18:00.000Z',
    blocks: 'the deployment', question: 'Type these commands:\n\n    make deploy\n    make check', choices: [], recommendation: null,
    status: 'open', at: '2026-10-30T15:18:00.000Z', answer: null, ...over,
  }
}

// A session `id` with the gauge's band and the tab band mounted, its round a map of files.
function tab(id = 's-own') {
  const handlers: Record<string, Function[]> = {}
  const register = (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const name = args[0]
    ;(handlers[name] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  }
  registerGauge(register)
  registerTabBand(register)
  const files = new Map<string, string>()
  const timers: { ms: number; fn: () => void; cancelled: boolean; cancel(): void }[] = []
  const invalidated: string[] = []
  const logged: string[] = []
  // The round directory's modification time moves with every entry written; `gone` is no directory.
  const state = { mtime: 1, gone: false, lists: 0, idFails: null as string | null, idGate: null as Promise<void> | null, ids: 0 }
  const $ = {
    session: { id: async () => {
      state.ids++
      if (state.idGate) await state.idGate
      if (state.idFails) throw new Error(state.idFails)
      return id
    }, surfaces: async () => ['terminal'], usage: async () => ({ context: { tokens: 1, window: 100000, percent: 0 } }), model: async () => 'a-model' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    process: { run: async (argv: unknown) => { logged.push(JSON.stringify(argv)); return { exitCode: 0, stdout: '', stderr: '' } } },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return files.get(p) },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => {
        if (state.gone) throw new Error(`ENOENT: ${p}`)
        return { mtimeMs: state.mtime }
      },
      exists: async (p: string) => [...files.keys()].some(k => k === p || k.startsWith(`${p}/`)),
      list: async (dir: string) => (state.lists++, state.gone ? Promise.reject(new Error(`ENOENT: ${dir}`)) : [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false }))),
    },
    clock: {
      every: (ms: number, fn: () => void) => {
        const timer = { ms, fn, cancelled: false, cancel: () => { timer.cancelled = true } }
        timers.push(timer)
        return timer
      },
    },
    ui: {
      invalidate: (what: string) => { invalidated.push(what) },
      toast: () => undefined,
      resolve: (_e: unknown) => ({
        Box: (props: object) => ({ type: 'Box', props }),
        Text: (props: object) => ({ type: 'Text', props }),
      }),
    },
  }
  const put = (e: RoundEntry) => { state.mtime++; files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n') }
  const pass = (x: unknown) => ({ passed: x })
  const start = () => Promise.all(handlers['session.start'].map(h => h($, {}, pass)))
  const tick = async () => {
    timers.filter(t => !t.cancelled).forEach(t => t.fn())
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const band = async () => {
    const event = { surface: 'terminal', component: 'AbovePrompt', requestId: 'r', props: { hasSurvey: false } }
    const out = await handlers['ui.render'][0]($, event, pass)
    return JSON.stringify(out)
  }
  const end = () => Promise.all(handlers['session.end'].map(h => h($, { sessionId: id }, pass)))
  return { put, files, state, logged, start, tick, band, end, timers, invalidated }
}

test('an open question of this session is shown above its prompt, whole, with the Paris time it began', async () => {
  const fx = tab()
  fx.put(entry())
  await fx.start()
  await fx.tick()
  const drawn = await fx.band()
  expect(drawn).toContain('Question for you (since 16:18): the deployment')
  expect(drawn).toContain('make deploy')
  expect(drawn).toContain('make check')
})

test('a question with choices shows its choices, and the band is drawn before any measure', async () => {
  const fx = tab()
  fx.put(entry({ question: 'Merge it?\nA. merge it now\nB. wait a day', choices: CHOICES }))
  await fx.start()
  await fx.tick()
  const drawn = await fx.band()
  expect(drawn).toContain('A. merge it now')
  expect(drawn).toContain('B. wait a day')
})

test('the band goes once the entry is answered from the pane, within one tick', async () => {
  const fx = tab()
  const asked = entry()
  fx.put(asked)
  await fx.start()
  await fx.tick()
  expect(await fx.band()).toContain('Question for you')
  fx.put({ ...asked, status: 'answered', answer: { by: 'pane', text: 'done', at: '2026-10-30T15:30:00.000Z' } as RoundEntry['answer'] })
  fx.invalidated.length = 0
  await fx.tick()
  expect(fx.invalidated).toEqual(['ui.render'])
  expect(await fx.band()).not.toContain('Question for you')
})

test('the band goes once the entry is withdrawn or closed', async () => {
  for (const status of ['withdrawn', 'closed'] as const) {
    const fx = tab()
    const asked = entry()
    fx.put(asked)
    await fx.start()
    await fx.tick()
    fx.put({ ...asked, status })
    await fx.tick()
    expect(await fx.band()).not.toContain('Question for you')
  }
})

test('another session\'s question is not shown in this tab', async () => {
  const fx = tab('s-other')
  fx.put(entry())
  await fx.start()
  await fx.tick()
  expect(await fx.band()).not.toContain('Question for you')
})

test('a tick that sees the same entry redraws nothing, and the clock stops with the session', async () => {
  const fx = tab()
  fx.put(entry())
  await fx.start()
  await fx.tick()
  fx.invalidated.length = 0
  await fx.tick()
  expect(fx.invalidated).toEqual([])
  await fx.end()
  expect(fx.timers.every(t => t.cancelled)).toBe(true)
})

test('a tick whose read throws leaves the round unseen: the next tick, the directory unchanged, reads again', async () => {
  const fx = tab()
  fx.put(entry())
  fx.state.idFails = 'no session id yet'
  await fx.start()
  await fx.tick()
  expect(await fx.band()).not.toContain('Question for you')
  fx.state.idFails = null
  await fx.tick()
  expect(await fx.band()).toContain('Question for you')
})

test('with no round directory the read is done once, not at every tick', async () => {
  const fx = tab()
  fx.state.gone = true
  await fx.start()
  await fx.tick()
  await fx.tick()
  await fx.tick()
  expect(fx.state.lists).toBe(1)
  fx.state.gone = false
  fx.put(entry())
  await fx.tick()
  expect(await fx.band()).toContain('Question for you')
  expect(fx.state.lists).toBe(2)
})

test('the same failure is logged once, a different one again', async () => {
  const fx = tab()
  fx.put(entry())
  fx.state.idFails = 'boom'
  await fx.start()
  await fx.tick()
  await fx.tick()
  expect(fx.logged.filter(line => line.includes('tab band: boom')).length).toBe(1)
  fx.state.idFails = 'bang'
  await fx.tick()
  expect(fx.logged.filter(line => line.includes('tab band: bang')).length).toBe(1)
})

test('an open question is shown at the session start, without waiting for a clock tick', async () => {
  const fx = tab()
  fx.put(entry())
  await fx.start()
  expect(await fx.band()).toContain('Question for you (since 16:18): the deployment')
})

test('a tick still running when the next fires is skipped, not run beside it', async () => {
  const fx = tab()
  fx.put(entry())
  let release: () => void = () => undefined
  fx.state.idGate = new Promise<void>(resolve => { release = resolve })
  const started = fx.start()
  await fx.tick()
  await fx.tick()
  expect(fx.state.ids).toBe(1)
  release()
  await started
  fx.state.idGate = null
  expect(await fx.band()).toContain('Question for you')
})

test('while the directory\'s modification time is unchanged the round is not read again, and a write reads it', async () => {
  const fx = tab()
  fx.put(entry())
  await fx.start()
  await fx.tick()
  await fx.tick()
  expect(fx.state.lists).toBe(1)
  fx.put(entry({ id: 'Orch-w-1006', status: 'withdrawn' }))
  await fx.tick()
  expect(fx.state.lists).toBe(2)
})
