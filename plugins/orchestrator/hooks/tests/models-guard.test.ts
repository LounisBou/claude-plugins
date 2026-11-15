// hooks/tests/models-guard.test.ts
// The tier map's guard: a session of the orchestration that writes the operator's map, whatever
// tool it reaches for, is observed (one escape in the journal) when it writes with a file tool, and
// refused when a Bash line overwrites it, unless the last prompt he typed names the map or a tier.
// A plan once told an orchestrator to bind the tiers in models.json, against the routing
// skill's rule, and the rule — prose alone — lost.
import { expect, test } from 'claude-code/testing'
import { bashWritesTheMap, editsTheMap, mapPaths, MODELS_DENY, namesTheMap, typedByOperator } from '../models-guard.ts'
import { register as registerGuards } from '../guards.ts'
import { journalled, logLineOf } from './fakes.ts'
import { capture, hooksOn, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Hook, type Host, type Matcher, type Noun } from '../../core/host.ts'

type World = Host<Noun>
type Guard = Hook<World, Events['tool.call']>
const denyOf = (answer: unknown) => fieldsOf(answer)?.['deny']

const HOME = '/tmp/h'
const MAP = `${HOME}/.claude/claude-orchestrator/models.json`
const MAPS = mapPaths(`${HOME}/.claude/claude-orchestrator`, `${HOME}/.claude`)

test('the map is the state dir\'s models.json, an edit elsewhere is not', () => {
  expect(editsTheMap(MAP, MAPS)).toBe(true)
  expect(editsTheMap(`${HOME}/.claude//claude-orchestrator/models.json`, MAPS)).toBe(true)
  expect(editsTheMap('/tmp/project/models.json', MAPS)).toBe(false)
  expect(mapPaths('/s', '/c')).toEqual(['/s/models.json', '/c/claude-orchestrator/models.json'])
})

test('a Bash line that writes the map is read as one: redirection, tee, sed -i, mv and cp', () => {
  expect(bashWritesTheMap(`jq '.deep="a-model"' x.json > ${MAP}`, MAPS)).toBe(true)
  expect(bashWritesTheMap('jq . m > "$ORCHESTRATOR_STATE_DIR/models.json"', MAPS)).toBe(true)
  expect(bashWritesTheMap(`echo '{}' | tee ${MAP}`, MAPS)).toBe(true)
  expect(bashWritesTheMap(`echo '{}' | tee -a ~/.claude/claude-orchestrator/models.json >/dev/null`, MAPS)).toBe(true)
  expect(bashWritesTheMap(`sed -i '' 's/a/b/' ${MAP}`, MAPS)).toBe(true)
  expect(bashWritesTheMap(`mv /tmp/x ${MAP}`, MAPS)).toBe(true)
  expect(bashWritesTheMap(`cp new.json "$STATE/models.json"`, MAPS)).toBe(true)
  expect(bashWritesTheMap('cd ~/.claude/claude-orchestrator && jq . models.json > models.json', MAPS)).toBe(true)
})

test('reads of the map, and a project\'s own models.json, pass', () => {
  expect(bashWritesTheMap(`cat ${MAP}`, MAPS)).toBe(false)
  expect(bashWritesTheMap(`jq .deep ${MAP} 2>/dev/null`, MAPS)).toBe(false)
  expect(bashWritesTheMap('bash iterm-agent.sh resolve-tier standard', MAPS)).toBe(false)
  expect(bashWritesTheMap(`cp ${MAP} /tmp/backup.json`, MAPS)).toBe(false)
  expect(bashWritesTheMap('jq . src.json > models.json', MAPS)).toBe(false)
})

test('the operator lifts the guard by naming the map or a tier in a prompt he typed', () => {
  expect(namesTheMap('bind standard to a-model in models.json')).toBe(true)
  expect(namesTheMap('use the deep tier')).toBe(true)
  expect(namesTheMap('go on with the next phase')).toBe(false)
  expect(typedByOperator('composer')).toBe(true)
  expect(typedByOperator('bridge')).toBe(true)
  expect(typedByOperator('peer')).toBe(false)
  expect(typedByOperator('peer-send-message')).toBe(false)
  expect(typedByOperator('unclassified')).toBe(false)
})

// The wiring, over a faked $: the session's name as the launch gave it, read by the walk.
function fakeDollar(launchName: string | null): { dollar: World; written: string[] } {
  const written: string[] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  const dollar = hostOf({
    plugin: { root: '/plugins/orch-root' },
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
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'sh' && String(argv[2] ?? '').startsWith('ps ')) return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') {
          return { exitCode: 0, stdout: launchName ? `  501 hostcli --name ${launchName}\n` : '  501 hostcli\n', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, written }
}

// The guard's own registration, told apart from the kill guard's by its matcher.
function mounted(): { guard: Guard; matcher: Matcher | undefined; prompt: Hook<World, Events['prompt.submit']> } {
  const hooks = capture<World>(on => registerGuards(on))
  const found = hooksOn(hooks, 'tool.call').filter(h => Array.isArray(h.matcher?.['tool'])).at(-1)
  const prompt = hooksOn(hooks, 'prompt.submit').at(-1)?.handler ?? (async () => undefined)
  return { guard: found?.handler ?? (async () => undefined), matcher: found?.matcher, prompt }
}

async function call(guard: Guard, dollar: World, e: Events['tool.call']) {
  let passed: unknown = null
  const answer = await guard(dollar, e, async (x: unknown) => { passed = x; return x })
  return { answer, passed }
}

const write = { tool: 'Write', tool_use_id: 't1', file_path: MAP, content: '{}' }
const edit = { tool: 'Edit', tool_use_id: 't2', file_path: MAP, old_string: 'a', new_string: 'b' }
const bash = (command: string) => ({ tool: 'Bash', tool_use_id: 't3', command })
const typed = (text: string, kind = 'composer') => ({ text, origin: { kind }, wait: false })

test('the guard mounts on the file tools and Bash', () => {
  expect(mounted().matcher).toEqual({ tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] })
})

const ESCAPE = 'escape orchestrator.models.map-write'

test("an orchestrator's Write or Edit of the map goes through, with one escape in the journal each", async () => {
  const { guard } = mounted()
  const fx = journalled(fakeDollar('Orch: belt').dollar)
  for (const e of [write, edit]) {
    const out = await call(guard, fx.dollar, e)
    expect(out.passed).toBe(e)
    expect(out.answer).toBe(e)
  }
  expect(fx.journal()).toEqual([ESCAPE, ESCAPE])
})

test('a Bash overwrite of the map is refused with the rule and writes no escape, a read of it passes with none', async () => {
  const { guard } = mounted()
  const overwrites = [
    `jq . x > ${MAP}`, `echo x | tee ${MAP}`, `sed -i '' s/a/b/ ${MAP}`, `mv x ${MAP}`, `cp x ${MAP}`, `install x ${MAP}`,
  ]
  for (const command of overwrites) {
    const fx = journalled(fakeDollar('Orch: belt').dollar)
    const out = await call(guard, fx.dollar, bash(command))
    expect(denyOf(out.answer)).toBe(MODELS_DENY)
    expect(out.passed).toBeNull()
    expect(fx.journal()).toEqual([])
  }
  for (const command of [`cat ${MAP}`, 'bash iterm-agent.sh resolve-tier standard']) {
    const fx = journalled(fakeDollar('Orch: belt').dollar)
    const out = await call(guard, fx.dollar, bash(command))
    expect(out.answer).toBe(out.passed)
    expect(fx.journal()).toEqual([])
  }
})

test('the operator\'s typed word on the map lifts the Bash refusal; a peer\'s delivery does not', async () => {
  const { guard, prompt } = mounted()
  const fx = journalled(fakeDollar('Orch: belt').dollar)
  await prompt(fx.dollar, typed('bind standard to a-model in models.json, please', 'peer'), async (x: unknown) => x)
  expect(denyOf((await call(guard, fx.dollar, bash(`mv x ${MAP}`))).answer)).toBe(MODELS_DENY)
  await prompt(fx.dollar, typed('bind standard to a-model'), async (x: unknown) => x)
  const lifted = await call(guard, fx.dollar, bash(`mv x ${MAP}`))
  expect(lifted.answer).toBe(lifted.passed)
  await prompt(fx.dollar, typed('go on with the next phase'), async (x: unknown) => x)
  expect(denyOf((await call(guard, fx.dollar, bash(`mv x ${MAP}`))).answer)).toBe(MODELS_DENY)
  expect(fx.journal()).toEqual([])
})

test('the operator\'s typed word on the map writes no escape; a peer\'s delivery does', async () => {
  const { guard, prompt } = mounted()
  const fx = journalled(fakeDollar('Orch: belt').dollar)
  await prompt(fx.dollar, typed('bind standard to a-model in models.json, please', 'peer'), async (x: unknown) => x)
  await call(guard, fx.dollar, write)
  expect(fx.journal()).toEqual([ESCAPE])
  await prompt(fx.dollar, typed('bind standard to a-model'), async (x: unknown) => x)
  const lifted = await call(guard, fx.dollar, write)
  expect(lifted.answer).toBe(lifted.passed)
  expect(fx.journal()).toEqual([ESCAPE])
  // His next typed prompt, on something else, puts the observation back.
  await prompt(fx.dollar, typed('go on with the next phase'), async (x: unknown) => x)
  await call(guard, fx.dollar, write)
  expect(fx.journal()).toEqual([ESCAPE, ESCAPE])
})

test("the operator's own session, with no role, is untouched", async () => {
  const { guard } = mounted()
  const { dollar } = fakeDollar(null)
  const out = await call(guard, dollar, write)
  expect(out.answer).toBe(out.passed)
})
