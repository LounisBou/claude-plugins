import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLauncherArgs } from '../../../core/launcher.ts'
import { AUDIT_NAME_SHAPE, prepared, prepareSpawn, Refused, TITLE_SHAPE, type PrepDeps } from './spawn-prep.ts'

const deps = (over: Partial<PrepDeps> = {}): PrepDeps & { warned: string[]; ran: string[][] } => {
  const warned: string[] = []
  const ran: string[][] = []
  return {
    env: {}, cwd: '/c', lint: '/lint.sh', warned, ran, home: '/h',
    read: path => (path === '/h/.claude/claude-orchestrator/models.json' ? '{"light":"m-1-2/low"}' : null),
    isDir: path => path === '/w', isFile: path => path === 'b.md',
    run: async argv => {
      ran.push([...argv])
      return { status: 1, stdout: ' finding \n', stderr: '' }
    },
    warn: line => warned.push(line),
    ...over,
  }
}

const spawnOf = (...words: string[]) => parseLauncherArgs('spawn', ['--dir', '/w', ...words]).options

async function refusal(words: string[], over: Partial<PrepDeps> = {}): Promise<string> {
  try {
    await prepareSpawn(spawnOf(...words), deps(over))
  } catch (error) {
    if (error instanceof Refused) return error.message
    throw error
  }
  return 'prepared'
}

describe('a spawn prepared from its line', () => {
  it('normalizes the title, the tool names and the gate', async () => {
    const o = await prepareSpawn(spawnOf('--title', 'Agent : a', '--keep-tool', ' X ', '--drop-tool', 'Y', '--gate-tokens', '5', '--prompt', 'p'), deps())
    assert.equal(o['title'], 'Agent: a')
    assert.deepEqual(o['keep_tool'], ['X'])
    assert.equal(o['gate_tokens'], 5)
    assert.equal(o['brief_prompt'], '')
    assert.equal(o['start_brief'], '')
  })

  it('builds the brief\'s prompt with the gate, and says the lint\'s findings', async () => {
    const d = deps()
    const o = await prepareSpawn(spawnOf('--title', 'Agent: a', '--brief', 'b.md', '--orchestrator', 'Orch: f', '--gate-tokens', '9'), d)
    assert.equal(o['brief_prompt'], 'Read and execute /c/b.md. Your orchestrator is Orch: f. Your context gate is the smaller of 9 tokens and 80'
      + ' % of the reported window.')
    assert.equal(o['lint_verdict'], 'finding')
    assert.equal(o['start_brief'], '/c/b.md')
    assert.deepEqual(d.warned, ['spawn: warning: brief-lint found findings in /c/b.md', 'finding'])
    assert.equal(d.ran[0]?.at(-1), '/c/b.md')
  })

  it('refuses each line that cannot be launched, in the order a reader meets them', async () => {
    const cases: [string[], RegExp][] = [
      [['--keep-tool', ' '], /--keep-tool needs a tool name/],
      [['--keep-tool', 'X', '--drop-tool', 'X'], /'X' is given to both/],
      [['--gate-tokens', '0'], /--gate-tokens must be a positive integer/],
      [['--left-of', 'a', '--right-of', 'b'], /mutually exclusive/],
      [['--resident', '--successor'], /--resident marks an agent/],
      [['--coordinator-successor', '--tier', 'deep'], /--tier is not a coordinator-successor's/],
      [['--coordinator-successor'], /needs --title "Coord: <subject>"/],
      [['--coordinator-successor', '--title', 'Coord:  x'], /the coordinator's title reads/],
      [['--title', 'Coord: c'], /a "Coord:" title is the coordinator's/],
      [['--wake', '--tier', 'deep'], /--tier is not a wake's/],
      [['--wake', '--title', 'Orch: w [ab1]'], /--wake needs the recorded name/],
      [['--wake', '--title', 'Orch: w', '--model', 'm'], /--wake takes the recorded model/],
      [['--resume', 'x'], /--resume is a wake's/],
      [['--wake', '--title', 'Orch: w', '--resume', 'a b'], /--resume needs a session id/],
      [['--open', '--title', 'Orch: o', '--plan', '3'], /--plan is 1, 2 or auto/],
      [['--plan', '2'], /--plan routes an orchestrator at its birth/],
      [['--successor', '--plan', '2'], /--plan routes an orchestrator at its birth/],
      [['--open', '--brief', 'b'], /--brief is not an opening's/],
      [['--open', '--model', 'm'], /an opening types the model/],
      [['--open', '--title', 'x'], /--open needs the new orchestrator's name/],
      [['--auditor', '--tier', 'deep'], /--tier is not an auditor's/],
      [['--auditor', '--of', 'x'], /--of names the audited orchestrator's tty/],
      [['--auditor', '--model', 'm'], /an auditor takes --model and --effort together/],
      [['--auditor'], /--auditor needs --title/],
      [['--auditor', '--title', 'Agent: a'], /an auditor's title reads/],
      [['--of', 'self'], /it is an auditor's, with --auditor/],
      [['--title', 'Audit neutre : x'], /an audit title is an auditor's/],
      [['--successor', '--left-of', 'a'], /--successor names its own anchor/],
      [['--successor', '--title-free'], /a successor is named after its caller/],
      [['--title', 'Orch: o', '--left-of', 'a'], /an orchestrator's title is a successor's/],
      [['--title', 'Orch: o'], /an orchestrator's tab is opened only/],
      [['--prompt', 'p', '--prompt-file', 'f'], /--prompt and --prompt-file are exclusive/],
      [['--successor', '--brief', 'b.md'], /--successor takes its prompt, not --brief/],
      [['--brief', 'b.md', '--prompt', 'p'], /--brief and --prompt\/--prompt-file/],
      [['--brief', 'b.md'], /--brief without --orchestrator/],
      [['--brief', 'nope.md', '--orchestrator', 'o'], /brief not found: nope.md/],
      [[], /no startup prompt/],
      [['--prompt', 'p', '--tier', 'deep', '--model', 'm'], /--tier and --model are mutually exclusive/],
      [['--prompt', 'p', '--inherit-model', '--tier', 'deep'], /--inherit-model is exclusive/],
      [['--prompt', 'p', '--inherit-model', '--effort', 'low'], /drop --effort/],
      [['--prompt', 'p', '--effort', 'huge'], /unknown effort: huge/],
    ]
    for (const [words, expected] of cases) assert.match(await refusal(words), expected, words.join(' '))
    assert.match(await refusal(['--open', '--title', 'Orch: o'], { env: { ORCHESTRATOR_SELF_TTY: '/dev/ttys1' } }), /--open reads its caller/)
    assert.equal(await refusal(['--title', 'Agent: a', '--tier', 'light', '--prompt', 'p', '--resume', 'abc-123']), 'prepared')
    assert.match(await refusal(['--title', 'Agent: a', '--prompt', 'p', '--resume', 'a b']), /--resume needs a session id/)
    assert.match(await refusal(['--prompt', 'p'], { isDir: () => false }), /directory not found: \/w/)
    assert.equal(await refusal(['--prompt', 'p', '--tier', 'light']), 'prepared')
    assert.match(await refusal(['--prompt', 'p', '--tier', 'deepest']), /resolve-tier: unknown tier: deepest/)
    const d = deps()
    assert.deepEqual((await prepareSpawn(spawnOf('--prompt', 'p', '--tier', 'light'), d))['tier_bound'], ['m-1-2', 'low'])
    assert.match(d.warned[0] ?? '', /tier light is bound to the versioned identifier m-1-2, .* alias m instead/)
    assert.equal((await prepareSpawn(spawnOf('--prompt', 'p'), d))['tier_bound'], null)
  })

  it('holds a title to the shape core names, and a read auditor\'s name to its qualified form', () => {
    assert.equal(TITLE_SHAPE.test('Agent: a'), true)
    assert.equal(TITLE_SHAPE.test('Audit: a'), false)
    assert.equal(TITLE_SHAPE.test('Agent: a\n'), false)
    assert.equal(AUDIT_NAME_SHAPE.test('Audit neutre : x'), true)
  })

  it('reads a rotation\'s own refusals before its spawn\'s, and leaves other commands as they are', async () => {
    const rotation = async (words: string[]): Promise<string> => {
      try {
        await prepared(parseLauncherArgs('rotate', words), deps())
      } catch (error) {
        if (error instanceof Refused) return error.message
        throw error
      }
      return 'prepared'
    }
    assert.equal(await rotation(['--dir', '/w']), 'rotate: --old-tty is required')
    assert.match(await rotation(['--old-tty', 't', '--successor']), /--successor is not a rotation's/)
    assert.match(await rotation(['--old-tty', 't', '--no-verify']), /--no-verify is not a rotation's/)
    assert.equal(await rotation(['--old-tty', 't', '--odd']), 'spawn: unknown option --odd')
    assert.equal(await rotation(['--old-tty', 't', '--dir', '/w', '--prompt', 'p']), 'prepared')
    const done = await prepared(parseLauncherArgs('rotate', ['--old-tty', 't', '--dir', '/w', '--prompt', 'p', '--title', 'Agent : r']), deps())
    assert.equal(done.rest?.options['title'], 'Agent: r')
    assert.equal(done.rest?.unknown, undefined)
    const close = parseLauncherArgs('close', ['--tty', 't'])
    assert.equal(await prepared(close, deps()), close)
    assert.equal((await prepared(parseLauncherArgs('spawn', ['--dir', '/w', '--prompt', 'p']), deps())).options['gate_tokens'], 0)
  })
})
