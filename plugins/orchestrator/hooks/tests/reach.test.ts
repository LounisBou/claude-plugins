// hooks/tests/reach.test.ts
// The destinations a machine learns of itself (reach.ts): its user at its router's internet address,
// at its local ones and at its `.local` name, in that order; learnt once per bound; a read that fails
// gives none of its part; nothing of another shape travels.
import { expect, test } from 'claude-code/testing'
import { UPNP_ARGV, REACH_EVERY_MS, addressOf, forgetReach, reachFrom, reachOf } from '../reach.ts'
import { hostOf } from '../../core/capture.ts'

function host(answers: Record<string, string | 'fails'>, user = 'geo') {
  const runs: string[][] = []
  const dollar = hostOf({
    env: { get: async (name: string) => (name === 'USER' ? user : undefined) },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push([...argv])
        const answer = answers[argv[0] === 'ipconfig' ? argv[2]! : argv[0]!]
        if (answer === 'fails') throw new Error('timed out')
        return answer === undefined ? { exitCode: 1, stdout: '', stderr: 'none' } : { exitCode: 0, stdout: `${answer}\n`, stderr: '' }
      },
    },
  })
  return { dollar, runs }
}

test('the router\'s address comes first, then the local ones, then the .local name, each once', async () => {
  forgetReach()
  const fx = host({ python3: '203.0.113.7', en0: '192.168.1.20', en1: '192.168.1.20' })
  expect(await reachOf(fx.dollar, 'mini-tech2', 1000)).toEqual(['geo@203.0.113.7', 'geo@192.168.1.20', 'geo@mini-tech2.local'])
  expect(fx.runs[0]).toEqual([...UPNP_ARGV])
  forgetReach()
})

test('learnt once per bound, learnt again after it', async () => {
  forgetReach()
  const fx = host({ python3: '203.0.113.7' })
  await reachOf(fx.dollar, 'm1', 1000)
  await reachOf(fx.dollar, 'm1', 1000 + REACH_EVERY_MS - 1)
  expect(fx.runs.length).toBe(3)
  await reachOf(fx.dollar, 'm1', 1000 + REACH_EVERY_MS)
  expect(fx.runs.length).toBe(6)
  forgetReach()
})

test('a router that does not answer, or a read that throws, leaves the other destinations', async () => {
  forgetReach()
  const fx = host({ python3: 'fails', en0: 'not an address' })
  expect(await reachOf(fx.dollar, 'm1', 1000)).toEqual(['geo@m1.local'])
  forgetReach()
})

test('nothing of another shape travels: a user, an address, an unknown machine', () => {
  expect(reachFrom('-oProxy', 'm1', '203.0.113.7', [])).toEqual([])
  expect(reachFrom('geo', 'unknown', null, [null])).toEqual([])
  expect([addressOf('203.0.113.7\n'), addressOf('256.1.1.1'), addressOf('1.2.3.4 5.6.7.8'), addressOf('')]).toEqual(['203.0.113.7', null, null, null])
})
