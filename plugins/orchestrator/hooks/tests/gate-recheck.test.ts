// hooks/tests/gate-recheck.test.ts
// The Ready gate re-checked on the pull requests an open question of the session names: once per
// new install and once per hour, the session told in one line when the gate now reads Ready.
import { expect, test } from 'claude-code/testing'
import { isDue, questionPrs, recheck, saysReady, readyText, RECHECK_EVERY_MS, type Checked } from '../gate-recheck.ts'
import { hostOf } from '../../core/capture.ts'

const STATE = '/state'
const OWN = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)
const ROOT = `/cfg/deploys/lounisbou/${OWN}/plugins/orchestrator`
const ASKED_AT = Date.parse('2026-11-15T12:00:00Z')

const question = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 2, id, subject: 'gate of acme/infra#219', context: 'The Ready gate refused acme/infra#219: CI red on a flaky job.', ask: 'Do I rerun it?',
  choices: [], recommended: null, why: null, blocks: 'the merge', status: 'open', at: new Date(ASKED_AT).toISOString(), answer: null,
  sender: { session: 's-orch', name: 'Orch: infra', role: 'orchestrator', machine: 'here' }, seq: 1, ...extra,
})

const installed = (commit: string) => JSON.stringify({ version: 1, repo: 'o/n', marketplace: 'lounisbou', history: [{ commit, at: '2026-11-15T11:00:00Z' }], skipped: [], pending: false, plugins: {} })

function world(answer: () => unknown) {
  const files = new Map<string, string>([
    [`${STATE}/round/q1.json`, question('q1')],
    [`${STATE}/round/q2.json`, question('q2', { status: 'answered', answer: { text: 'A', by: 'tab', at: 't', settler: 'x' } })],
    [`${STATE}/round/q3.json`, question('q3', { sender: { session: 's-other', name: 'Orch: web', role: 'orchestrator', machine: 'here' } })],
    ['/cfg/deploys/lounisbou/installed.json', installed(OWN)],
  ])
  const calls: unknown[] = []
  const prompts: string[] = []
  let now = ASKED_AT + 60_000
  const $ = hostOf({
    plugin: { root: ROOT },
    env: { get: async (name: string) => (name === 'ORCHESTRATOR_STATE_DIR' ? STATE : name === 'HOME' ? '/home' : undefined) },
    fs: {
      read: async (p: string) => { const text = files.get(p); if (text === undefined) throw new Error('ENOENT'); return text },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
    },
    clock: { now: async () => now },
    tool: { call: async (input: unknown) => { calls.push(input); return answer() } },
    prompt: { submit: async (input: { text: string }) => { prompts.push(input.text); return undefined } },
  })
  return { $, files, calls, prompts, at: (ms: number) => { now = ms } }
}

test('the pull requests a question names in its text, once each', () => {
  expect(questionPrs({ subject: 'acme/infra#219 and acme/app#3', context: 'acme/infra#219 again', ask: 'ok?' }))
    .toEqual([{ repo: 'acme/infra', pr: 219 }, { repo: 'acme/app', pr: 3 }])
  expect(questionPrs({ subject: 'no pull request', context: '#12 alone', ask: 'ok?' })).toEqual([])
})

test('a check is due after an hour or under a new install, never once Ready was told', () => {
  const last: Checked = { at: 0, install: OWN, told: false }
  expect(isDue(last, RECHECK_EVERY_MS - 1, OWN)).toBe(false)
  expect(isDue(last, RECHECK_EVERY_MS, OWN)).toBe(true)
  expect(isDue(last, 1, NEWER)).toBe(true)
  expect(isDue({ ...last, told: true }, RECHECK_EVERY_MS, NEWER)).toBe(false)
})

test('only github\'s ready line reads Ready', () => {
  expect(saysReady({ result: 'ready' })).toBe(true)
  expect(saysReady({ result: 'created Ready\nready (unchanged)' })).toBe(true)
  expect(saysReady({ result: 'github: acme/infra#219 carries Not Ready at 0123456, Ready not put: not ready. Missing: review.' })).toBe(false)
  expect(saysReady({ result: 'ready', isError: true })).toBe(false)
  expect(saysReady(null)).toBe(false)
})

test('the gate is run on the session\'s own open question after an hour and under a new install, and Ready is told once', async () => {
  let ready = false
  const w = world(() => ({ result: ready ? 'ready' : 'github: acme/infra#219 carries Not Ready at 0123456, Ready not put: not ready. Missing: ci.' }))
  const checked = new Map<string, Checked>()
  // First seen: nothing run; the answered question and another session's are never read.
  expect(await recheck(w.$, 's-orch', checked)).toEqual([])
  expect(w.calls).toEqual([])
  expect([...checked.keys()]).toEqual(['q1|acme/infra#219'])
  // An hour after it was asked: the gate runs, not ready yet.
  w.at(ASKED_AT + RECHECK_EVERY_MS)
  expect(await recheck(w.$, 's-orch', checked)).toEqual([])
  expect(w.calls).toEqual([{ tool: 'mcp__github__gh', command: 'pr-readiness', args: { pr: 219, state: 'ready' }, repo: 'acme/infra' }])
  // A new install makes it due at once.
  w.files.set('/cfg/deploys/lounisbou/installed.json', installed(NEWER))
  ready = true
  w.at(ASKED_AT + RECHECK_EVERY_MS + 60_000)
  const line = readyText({ id: 'q1', subject: 'gate of acme/infra#219' }, { repo: 'acme/infra', pr: 219 })
  expect(await recheck(w.$, 's-orch', checked)).toEqual([line])
  expect(w.prompts).toEqual([line])
  expect(line).toContain('settle it withdrawn')
  // Told once.
  w.at(ASKED_AT + 3 * RECHECK_EVERY_MS)
  expect(await recheck(w.$, 's-orch', checked)).toEqual([])
  expect(w.calls).toHaveLength(2)
  // A question no longer open is forgotten.
  w.files.delete(`${STATE}/round/q1.json`)
  await recheck(w.$, 's-orch', checked)
  expect(checked.size).toBe(0)
})
