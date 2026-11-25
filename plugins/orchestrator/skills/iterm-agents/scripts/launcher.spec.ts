import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseLauncherArgs } from '../../../core/launcher.ts'
import { DATA_ROOT_FILE, DATA_ROOT_VERSION } from '../../../core/orchestration.ts'
import type { RowDeps } from './agent-row.ts'
import { main, prepDeps, requestOf, rowDeps, runAdapter } from './launcher.ts'

const io = (): { out: string[]; err: string[]; io: { out: (t: string) => void; err: (t: string) => void } } => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: t => out.push(t), err: t => err.push(t) } }
}

describe('the launcher entry', () => {
  it('reads a line into the request core\'s set makes', () => {
    assert.deepEqual(requestOf(['close', '--tty', '/dev/ttys1']), { request: parseLauncherArgs('close', ['--tty', '/dev/ttys1']) })
  })

  it('says a refusal with ERROR and 1, a malformed line as the parser does and 2', () => {
    assert.deepEqual(requestOf(['spawn', '--odd']), { said: 'ERROR: spawn: unknown option --odd', code: 1 })
    assert.deepEqual(requestOf(['spawn', '--title']), { said: 'spawn: error: argument --title: expected one argument', code: 2 })
    assert.deepEqual(requestOf([]), { said: `ERROR: ${'usage: iterm-agent.sh {list|spawn|verify|screen|resolve-tier|pair|close|move|rotate|trust|tools|home|home-release|takeover|bench-open} [options] (see header)'}`, code: 1 })
  })

  it('refuses a rotation whose spawn words are malformed in the rotation\'s words', () => {
    assert.deepEqual(requestOf(['rotate', '--old-tty', '/dev/ttys1', '--tier']), {
      said: "ERROR: rotate: refused: the spawn's options cannot be read (argument --tier: expected one argument): nothing was spawned", code: 1,
    })
  })

  it('prints the request when asked, and says a refusal without running anything', async () => {
    const shown = io()
    assert.equal(await main(['pair'], { ORCHESTRATOR_PRINT_REQUEST: '1' }, shown.io), 0)
    assert.deepEqual(JSON.parse(shown.out[0] ?? ''), { version: 1, command: 'pair', options: {}, words: [] })
    const refused = io()
    assert.equal(await main(['pair', 'x'], {}, refused.io), 1)
    assert.match(refused.err[0] ?? '', /^ERROR: pair: takes no argument/)
  })

  it('reads the files a spawn names from this process, and refuses a spawn before running anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-'))
    writeFileSync(join(dir, 'f'), '')
    const shown = io()
    const deps = prepDeps({}, shown.io)
    assert.deepEqual([deps.isDir(dir), deps.isFile(dir), deps.isFile(join(dir, 'f')), deps.isDir(join(dir, 'none'))], [true, false, true, false])
    deps.warn('w')
    assert.deepEqual(shown.err, ['w\n'])
    const refused = io()
    assert.equal(await main(['spawn', '--dir', dir], {}, refused.io), 1)
    assert.deepEqual(refused.err, ["ERROR: spawn: refused: no startup prompt: the host writes no transcript before a first prompt, so the session's mode cannot be read; give the brief with --prompt or --prompt-file\n"])
  })

  it('hands the adapter the request and answers its exit code, or a signal\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-'))
    const adapter = join(dir, 'adapter.sh')
    writeFileSync(adapter, 'printf "%s|%s" "$1" "$2" > "$(dirname "$0")/got"\n[ "$2" = kill ] && kill -TERM $$\nexit 3\n')
    const request = parseLauncherArgs('list', [])
    assert.equal(await runAdapter('/bin/sh', request, adapter), 3)
    assert.equal(readFileSync(join(dir, 'got'), 'utf8'), `--request|${JSON.stringify(request)}`)
    writeFileSync(adapter, 'kill -TERM $$\n')
    assert.equal(await runAdapter('/bin/sh', request, adapter), 128 + 15)
    assert.equal(await runAdapter(join(dir, 'no-such-python'), request, adapter), 1)
  })

  it('puts the agent a spawn launched on its row once the adapter succeeded, and only then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-'))
    const brief = join(dir, 'brief.md')
    writeFileSync(brief, 'Row: 355 X: y\n')
    writeFileSync(join(dir, 'record.jsonl'), '{"id":355,"state":"open"}\n')
    const state = join(dir, 'state')
    mkdirSync(join(state, 'records'), { recursive: true })
    writeFileSync(join(state, 'records', 'sess'), `${join(dir, 'record.jsonl')}\n`)
    const env = { CLAUDE_CODE_SESSION_ID: 'sess', ORCHESTRATOR_STATE_DIR: state }
    const line = ['spawn', '--dir', dir, '--model', 'm', '--effort', 'low', '--title', 'Agent: a', '--brief', brief, '--orchestrator', 'Orch: o']
    const said: string[][] = []
    const row = { ...rowDeps(env, io().io), run: async (argv: readonly string[]) => (said.push([...argv]), { status: 0, stdout: '', stderr: '' }) } as RowDeps
    const ok = async (): Promise<number> => 0
    assert.equal(await main(line, env, io().io, prepDeps(env, io().io), ok, row), 0)
    assert.deepEqual(said.map(argv => argv.slice(2)), [['agent', join(dir, 'record.jsonl'), '355', 'Agent: a']])
    said.length = 0
    assert.equal(await main(line, env, io().io, prepDeps(env, io().io), async () => 3, row), 3)
    assert.equal(await main(line, { ...env, ORCHESTRATOR_DRY_RUN: '1' }, io().io, prepDeps(env, io().io), ok, row), 0)
    assert.deepEqual(said, [])
  })

  it('writes the launcher\'s ledger lines in the hooks module\'s own log, in the data root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-'))
    const config = join(dir, 'config')
    mkdirSync(join(config, 'claude-orchestrator'), { recursive: true })
    writeFileSync(join(config, 'claude-orchestrator', DATA_ROOT_FILE), JSON.stringify({ version: DATA_ROOT_VERSION, dir: join(dir, 'data') }))
    await rowDeps({ CLAUDE_CONFIG_DIR: config }, io().io).log('acme/app#86 attached to Agent: a')
    await rowDeps({ CLAUDE_CONFIG_DIR: config, ORCHESTRATOR_MODULE_DIR: join(dir, 'module') }, io().io).log('elsewhere')
    assert.match(readFileSync(join(dir, 'data', 'hooks-module.log'), 'utf8'), /^\S+Z \| ledger \| acme\/app#86 attached to Agent: a\n$/)
    assert.match(readFileSync(join(dir, 'module', 'hooks-module.log'), 'utf8'), / \| ledger \| elsewhere\n$/)
  })
})
