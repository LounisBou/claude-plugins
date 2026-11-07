// hooks/tests/question-by-message.test.ts
// A question sent to the coordinator by message reaches no round: the SendMessage guard
// refuses it, whether the coordinator is the one registered on this machine (coordinator.json)
// or one a peer delivery taught (coordinator-learnt). A plain message to the coordinator, and a
// question to any other peer, go through.
import { expect, test } from 'claude-code/testing'
import { register as registerGuards } from '../guards.ts'
import { QUESTION_BY_MESSAGE } from '../one-question.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const COORD = 'Coord : ops [abc]'
const QUESTION = ['**Question 1 of 1**', '_Subject_ : the merge', '- **A** : yes', '- **B** : no'].join('\n')

function mountedSend(): Function {
  let handler: Function | null = null
  registerGuards((...args: [string, Function] | [string, object, Function]) => {
    if (args.length === 3 && (args[1] as any).tool === 'SendMessage') handler = args[2]
    return { catch: () => undefined }
  })
  return handler!
}

function dollar(files: Record<string, string>): { dollar: any; logs: string[] } {
  const logs: string[] = []
  return {
    logs,
    dollar: {
      session: { id: async () => 'a1b2c3' },
      env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
      fs: {
        read: async (p: string) => { if (p in files) return files[p]; throw new Error(`ENOENT: ${p}`) },
        list: async () => [],
        write: async () => undefined,
      },
      process: { run: async (argv: string[]) => { const line = logLineOf(argv); if (line !== null) logs.push(line); return { stdout: '', stderr: '', exitCode: 0 } } },
    },
  }
}

const REGISTERED = { [`${STATE}/coordinator.json`]: JSON.stringify({ name: COORD }) }
const LEARNT = { [`${STATE}/store/coordinator-learnt`]: JSON.stringify({ name: COORD, from: null, at: 'T' }) + '\n' }
const sent = async (e: any) => ({ result: { ran: e.tool } })
const send = (to: string, message: string) => ({ tool: 'SendMessage', to, message })

for (const [how, files] of [['registered on this machine', REGISTERED], ['learnt from a peer', LEARNT]] as const) {
  test(`a question sent to the coordinator ${how} is refused with the way to ask it`, async () => {
    const handler = mountedSend()
    const fx = dollar(files)
    const answer = await handler(fx.dollar, send(COORD, QUESTION), sent)
    expect(answer).toEqual({ deny: QUESTION_BY_MESSAGE })
    expect(answer.deny.startsWith('Ask it at the end of your own turn')).toBe(true)
    // The other face of the same wait: the machine line alone.
    const waiting = await handler(fx.dollar, send(COORD, 'blocked.\nwaiting: operator — blocks: the merge'), sent)
    expect(waiting).toEqual({ deny: QUESTION_BY_MESSAGE })
  })

  test(`a plain message to the coordinator ${how}, and a question to another peer, go through`, async () => {
    const handler = mountedSend()
    const fx = dollar(files)
    expect(await handler(fx.dollar, send(COORD, 'phase 2 merged.'), sent)).toEqual({ result: { ran: 'SendMessage' } })
    expect(await handler(fx.dollar, send('Agent : belt', QUESTION), sent)).toEqual({ result: { ran: 'SendMessage' } })
  })
}

test('a question quoted in a fence, or with no coordinator known, goes through', async () => {
  const handler = mountedSend()
  const quoted = ['an example:', '```', QUESTION, '```'].join('\n')
  expect(await handler(dollar(REGISTERED).dollar, send(COORD, quoted), sent)).toEqual({ result: { ran: 'SendMessage' } })
  expect(await handler(dollar({}).dollar, send(COORD, QUESTION), sent)).toEqual({ result: { ran: 'SendMessage' } })
})

test('the address match ignores the reference suffix on either side', async () => {
  const handler = mountedSend()
  const bareTo = await handler(dollar(REGISTERED).dollar, send('Coord : ops', QUESTION), sent)
  expect(bareTo).toEqual({ deny: QUESTION_BY_MESSAGE })
  const bareRecord = { [`${STATE}/coordinator.json`]: JSON.stringify({ name: 'Coord : ops' }) }
  const referencedTo = await handler(dollar(bareRecord).dollar, send(COORD, QUESTION), sent)
  expect(referencedTo).toEqual({ deny: QUESTION_BY_MESSAGE })
})

test('a wait that blocks nothing, sent to the coordinator, goes through', async () => {
  const handler = mountedSend()
  const out = await handler(dollar(REGISTERED).dollar, send(COORD, 'done.\nwaiting: operator — blocks: nothing'), sent)
  expect(out).toEqual({ result: { ran: 'SendMessage' } })
})
