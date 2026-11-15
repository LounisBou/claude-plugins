// hooks/tests/mode-dialog.test.ts
// An orchestrator never asks its mode by dialog: a successor reads it from its brief, and the
// question, when no brief carries one, follows the method's format and the decision round. A
// dialog in the session's own tab reaches neither the coordinator's pane nor a `waiting:`
// line, so the operator is never told a session is blocked on him.
import { expect, test } from 'claude-code/testing'
import { asksTheMode } from '../mode-dialog.ts'
import { register as registerGuards } from '../guards.ts'
import { journalled, logLineOf } from './fakes.ts'

const modeDialog = {
  tool: 'AskUserQuestion',
  tool_use_id: 'q1',
  questions: [{
    header: 'Mode',
    question: 'Which mode does this orchestrator run in?',
    multiSelect: false,
    options: [{ label: 'build (Recommended)', description: 'a spec delivered as pull requests' }, { label: 'investigate', description: 'debugging' }],
  }],
}
const otherDialog = {
  tool: 'AskUserQuestion',
  tool_use_id: 'q2',
  questions: [{ header: 'Library', question: 'Which date library?', multiSelect: false, options: [{ label: 'dayjs', description: 'small' }, { label: 'luxon', description: 'rich' }] }],
}

test('a dialog offering build and investigate as a mode is the mode question', () => {
  expect(asksTheMode(modeDialog)).toBe(true)
  expect(asksTheMode(otherDialog)).toBe(false)
  expect(asksTheMode({ tool: 'AskUserQuestion' })).toBe(false)
  expect(asksTheMode({ tool: 'AskUserQuestion', questions: [{ question: 'Build or investigate?', options: [] }] })).toBe(false)
})

function fakeDollar(launchName: string | null): any {
  const env: Record<string, string> = { HOME: '/tmp/h', ORCHESTRATOR_HOST_CLI: 'hostcli' }
  return {
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    session: { id: async () => 'a1b2c3' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => { throw new Error(`unread: ${p}`) },
      write: async () => undefined,
      stat: async () => { throw new Error('ENOENT') },
      list: async () => [],
      exists: async () => false,
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (logLineOf(argv) !== null) return { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'sh' && String(argv[2] ?? '').startsWith('ps ')) return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') {
          return { exitCode: 0, stdout: launchName ? `  501 hostcli --name ${launchName}\n` : '  501 hostcli\n', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
}

function mounted(): { guard: Function; matcher: any } {
  let guard: Function = () => undefined
  let matcher: any
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const handler = args[args.length - 1] as Function
    if (args.length === 3 && (args[1] as any).tool === 'AskUserQuestion') {
      guard = handler
      matcher = args[1]
    }
    return { catch: () => undefined }
  })
  return { guard, matcher }
}

async function call(guard: Function, dollar: any, e: object) {
  let passed: unknown = null
  const answer = await guard(dollar, e, (x: unknown) => { passed = x; return x })
  return { answer, passed }
}

test('the guard mounts on the dialog tool', () => {
  expect(mounted().matcher).toEqual({ tool: 'AskUserQuestion' })
})

test("an orchestrator's dialog for its mode is let through, with one escape in the journal", async () => {
  const { guard } = mounted()
  const fx = journalled(fakeDollar('Orch: belt'))
  const out = await call(guard, fx.dollar, modeDialog)
  expect(out.passed).toBe(modeDialog)
  expect(out.answer).toBe(modeDialog)
  expect(fx.journal()).toEqual(['escape orchestrator.mode.dialog'])
})

test("an orchestrator's other dialog, and any other session's mode dialog, pass", async () => {
  const { guard } = mounted()
  for (const [name, e] of [['Orch: belt', otherDialog], [null, modeDialog], ['Agent: x', modeDialog]] as const) {
    const out = await call(guard, fakeDollar(name), e)
    expect(out.answer).toBe(out.passed)
  }
})

// A session others wait on never asks in a dialog (method:lifecycle, « Questions to the operator »):
// while a coordinator runs, an orchestrator's or the coordinator's dialog is observed: it opens, and
// the journal holds one escape.
function withCoordinator(launchName: string | null): any {
  const dollar = fakeDollar(launchName)
  const record = '/tmp/h/.claude/claude-orchestrator/coordinator.json'
  return { ...dollar, fs: { ...dollar.fs, read: async (p: string) => {
    if (p === record) return JSON.stringify({ name: 'Coord: ops [abc]', tty: '/dev/ttys9' })
    throw new Error(`unread: ${p}`)
  } } }
}

test('while a coordinator runs, an orchestrator\'s or the coordinator\'s dialog is let through with one escape; an agent\'s passes with none', async () => {
  const { guard } = mounted()
  for (const name of ['Orch: belt', 'Coord: ops']) {
    const fx = journalled(withCoordinator(name))
    const out = await call(guard, fx.dollar, otherDialog)
    expect(out.passed).toBe(otherDialog)
    expect(fx.journal()).toEqual(['escape orchestrator.dialog.waited-on'])
  }
  const fx = journalled(withCoordinator('Agent: x'))
  const agent = await call(guard, fx.dollar, otherDialog)
  expect(agent.answer).toBe(agent.passed)
  expect(fx.journal()).toEqual([])
})
