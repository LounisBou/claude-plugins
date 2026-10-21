// hooks/tests/gauge-band.test.ts
import { expect, test } from 'claude-code/testing'
import { bandTree, currentReading, register as registerGauge } from '../gauge.ts'
import { logLineOf } from './fakes.ts'

test('below the gate the band shows the fill without warning color', () => {
  const tree = bandTree({ context_percent: 42, context_tokens: 42000, context_window: 100000, model: 'a-model', updated_at: 't' })
  expect(JSON.stringify(tree)).toContain('42%')
  expect(JSON.stringify(tree)).not.toContain('rotation')
})

test('past the gate the band names the rotation', () => {
  const tree = bandTree({ context_percent: 84, context_tokens: 84000, context_window: 100000, model: 'a-model', updated_at: 't' })
  expect(JSON.stringify(tree)).toContain('84%')
  expect(JSON.stringify(tree)).toContain('rotation gate')
})

test('a session nothing has measured yet draws no band', () => {
  // The other half of the nothing-drawn case: the usage fields are optional before the
  // first answered turn, so the reading stays null and the band is absent, not empty.
  expect(bandTree(null)).toBeNull()
  // A threshold the environment lowered is the band's too: it agrees with the gate line.
  const lowered = bandTree({ context_percent: 5, context_tokens: 53000, context_window: 1000000, model: 'a-model', updated_at: 't' }, { gateTokens: 1000 })
  expect(lowered?.past).toBe(true)
})

test('the band skips when nothing draws, and draws the fill when something does', async () => {
  const handlers: Record<string, Function> = {}
  // The fake stores the matcher it receives, not just the handler: a bare
  // two-argument registration would pass every test below while the engine
  // drew the band on every component it renders — the registration is pinned
  // to the one component the band belongs to.
  const matchers: Record<string, object | undefined> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    matchers[args[0]] = args.length === 3 ? args[1] : undefined
    return { catch: () => undefined }
  })
  expect(matchers['ui.render']).toEqual({ component: 'AbovePrompt' })
  let surfaces: readonly string[] = []
  const $ = {
    session: {
      usage: async () => ({ context: { tokens: 84000, window: 100000, percent: 84 } }),
      model: async () => 'a-model',
      id: async () => 's1',
      surfaces: async () => surfaces,
    },
    fs: { write: async () => undefined },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    ui: {
      toast: () => undefined,
      invalidate: () => undefined,
      resolve: (_e: unknown) => ({
        Box: (props: { flexDirection?: string; children?: unknown[] }) => ({ type: 'Box', props }),
        Text: (props: { color?: string; children?: string }) => ({ type: 'Text', props }),
      }),
    },
  }
  const through = (e: unknown) => ({ passed: e })
  const render = (e: object) => handlers['ui.render']($, e, through)

  // A session that draws nothing (a chat panel, a headless run) passes through
  // silently instead of throwing, whatever the reading is.
  const quiet = await render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false } })
  expect(quiet).toEqual({ passed: { surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false } } })

  // A measure fills the reading the band draws from.
  await handlers['session.measure']($, {}, (e: unknown) => e)
  expect(currentReading()).toMatchObject({ context_percent: 84 })

  surfaces = ['terminal']
  const tree = await render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r2', props: { hasSurvey: false } })
  expect(JSON.stringify(tree)).toContain('84%')
  expect(JSON.stringify(tree)).toContain('rotation gate')
  expect(JSON.stringify(tree)).toContain('warning')

  // The component's own contract: a survey holding the band wins, the hook yields.
  const held = await render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r3', props: { hasSurvey: true } })
  expect(held).toEqual({ passed: { surface: 'terminal', component: 'AbovePrompt', requestId: 'r3', props: { hasSurvey: true } } })
})

test('a session end that cannot purge the measure file is said, and blocks nothing', async () => {
  // The every-handler-logs rule: the end is never held on the store's own
  // failure, but the failure is not swallowed either — one line, the gauge's
  // own stamp naming the half that failed.
  const handlers: Record<string, Function> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  const written: string[] = []
  const $ = {
    session: { id: async () => 's1' },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    fs: {
      read: async () => '',
      write: async (p: string, text: string) => {
        throw new Error('EIO: the measure file cannot be written')
      },
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
  const e = { sessionId: 's1' }
  const answer = await handlers['session.end']($, e, (x: unknown) => x)
  expect(answer).toBe(e)
  expect(written.length).toBe(1)
  expect(written[0]).toContain('| gauge |')
  expect(written[0]).toContain('EIO')
})

// The band's drawing for a fill, through the registered render hook: every text piece with
// the colour and weight it is drawn with, so a test reads what the operator sees.
async function drawnBand(percent: number, tokens: number, window = 100000) {
  const handlers: Record<string, Function> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  const $ = {
    session: {
      usage: async () => ({ context: { tokens, window, percent } }),
      model: async () => 'a-model',
      id: async () => 's1',
      surfaces: async () => ['terminal'],
    },
    fs: { write: async () => undefined },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    ui: {
      toast: () => undefined,
      invalidate: () => undefined,
      resolve: (_e: unknown) => ({
        Box: (props: { flexDirection?: string; children?: unknown[] }) => ({ type: 'Box', props }),
        Text: (props: { color?: string; bold?: boolean; children?: unknown }) => ({ type: 'Text', props }),
      }),
    },
  }
  await handlers['session.measure']($, {}, (e: unknown) => e)
  const tree: any = await handlers['ui.render']($, { surface: 'terminal', component: 'AbovePrompt', requestId: 'r', props: { hasSurvey: false } }, (e: unknown) => ({ passed: e }))
  const pieces = (node: any): { text: string; color?: string; bold: boolean }[] => {
    if (typeof node === 'string') return [{ text: node, bold: false }]
    const kids = [node.props.children].flat().filter((kid: unknown) => kid !== undefined)
    if (node.type === 'Text' && kids.every((kid: unknown) => typeof kid === 'string')) {
      return [{ text: kids.join(''), color: node.props.color, bold: node.props.bold === true }]
    }
    return kids.flatMap(pieces)
  }
  return tree.props.children.map((line: any) => pieces(line))
}

test('below the gate the band line is the default text colour with the percentage in bold', async () => {
  const [line, ...rest] = await drawnBand(42, 42000)
  expect(rest).toEqual([])
  expect(line.map((p: any) => p.text).join('')).toBe('context 42% · 42,000/100,000')
  expect(line.some((p: any) => p.color !== undefined)).toBe(false)
  expect(line.filter((p: any) => p.bold).map((p: any) => p.text)).toEqual(['42%'])
})

test('past the gate the band line stays warning and bold, the gate line below it unchanged', async () => {
  const [line, gate] = await drawnBand(84, 84000)
  expect(line.map((p: any) => p.text).join('')).toBe('context 84% · 84,000/100,000')
  expect(line.every((p: any) => p.color === 'warning' && p.bold)).toBe(true)
  expect(gate).toEqual([{ text: 'rotation gate — succeed at the next quiet boundary', color: 'warning', bold: false }])
})
