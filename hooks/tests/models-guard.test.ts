// hooks/tests/models-guard.test.ts
// The tier map's guard: a session of the orchestration never writes the operator's map,
// whatever tool it reaches for, unless the last prompt he typed names the map or a tier.
// A plan once told an orchestrator to bind the tiers in models.json, against the routing
// skill's rule, and the rule — prose alone — lost.
import { expect, test } from 'claude-code/testing'
import { bashWritesTheMap, editsTheMap, mapPaths, namesTheMap, typedByOperator, MODELS_DENY } from '../models-guard.ts'
import { register as registerGuards } from '../guards.ts'
import { logLineOf } from './fakes.ts'

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
function fakeDollar(launchName: string | null): { dollar: any; written: string[] } {
  const written: string[] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  const dollar = {
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
  }
  return { dollar, written }
}

// The guard's own registration, told apart from the push guard's by its matcher.
function mounted(): { guard: Function; matcher: any; prompt: Function } {
  let guard: Function = () => undefined
  let matcher: any
  let prompt: Function = () => undefined
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const handler = args[args.length - 1] as Function
    if (args[0] === 'prompt.submit') prompt = handler
    if (args.length === 3 && Array.isArray((args[1] as any).tool)) {
      guard = handler
      matcher = args[1]
    }
    return { catch: () => undefined }
  })
  return { guard, matcher, prompt }
}

async function call(guard: Function, dollar: any, e: object) {
  let passed: unknown = null
  const answer = await guard(dollar, e, (x: unknown) => { passed = x; return x })
  return { answer, passed }
}

const write = { tool: 'Write', tool_use_id: 't1', file_path: MAP, content: '{}' }
const edit = { tool: 'Edit', tool_use_id: 't2', file_path: MAP, old_string: 'a', new_string: 'b' }
const bash = (command: string) => ({ tool: 'Bash', tool_use_id: 't3', command })
const typed = (text: string, kind = 'composer') => ({ text, origin: { kind }, wait: false })

test('the guard mounts on the file tools and Bash', () => {
  expect(mounted().matcher).toEqual({ tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] })
})

test("an orchestrator's Write or Edit of the map is denied with the rule", async () => {
  const { guard } = mounted()
  const { dollar } = fakeDollar('Orch : belt')
  for (const e of [write, edit]) {
    const out = await call(guard, dollar, e)
    expect((out.answer as any).deny).toBe(MODELS_DENY)
    expect(out.passed).toBeNull()
  }
})

test('a Bash write of the map is denied, a read of it passes', async () => {
  const { guard } = mounted()
  const { dollar } = fakeDollar('Orch : belt')
  for (const command of [`jq . x > ${MAP}`, `echo x | tee ${MAP}`, `sed -i '' s/a/b/ ${MAP}`, `mv x ${MAP}`]) {
    expect(((await call(guard, dollar, bash(command))).answer as any).deny).toBe(MODELS_DENY)
  }
  for (const command of [`cat ${MAP}`, 'bash iterm-agent.sh resolve-tier standard']) {
    const out = await call(guard, dollar, bash(command))
    expect(out.answer).toBe(out.passed)
  }
})

test('the operator\'s typed word on the map lifts the guard; a peer\'s delivery does not', async () => {
  const { guard, prompt } = mounted()
  const { dollar } = fakeDollar('Orch : belt')
  await prompt(dollar, typed('bind standard to a-model in models.json, please', 'peer'), (x: unknown) => x)
  expect(((await call(guard, dollar, write)).answer as any).deny).toBe(MODELS_DENY)
  await prompt(dollar, typed('bind standard to a-model'), (x: unknown) => x)
  const lifted = await call(guard, dollar, write)
  expect(lifted.answer).toBe(lifted.passed)
  // His next typed prompt, on something else, puts the guard back.
  await prompt(dollar, typed('go on with the next phase'), (x: unknown) => x)
  expect(((await call(guard, dollar, write)).answer as any).deny).toBe(MODELS_DENY)
})

test("the operator's own session, with no role, is untouched", async () => {
  const { guard } = mounted()
  const { dollar } = fakeDollar(null)
  const out = await call(guard, dollar, write)
  expect(out.answer).toBe(out.passed)
})
