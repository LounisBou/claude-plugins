import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { change, main } from './chains.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'chains-cli-'))
const file = (state: string, name: string): string => readFileSync(join(state, 'chains', `${name}.jsonl`), 'utf8')

const ran = (argv: string[]): { code: number; out: string; err: string } => {
  let out = ''
  let err = ''
  const code = main(argv, text => (out += text), text => (err += text))
  return { code, out, err }
}

describe('the chains command', () => {
  it('appends with or without an owner and the resident mark, in the launcher\'s format', () => {
    const state = scratch()
    assert.deepEqual(change(['append', state, '/dev/ttys900', '1', '/dev/ttys901', 'S-ME', 'resident']), { written: ['/dev/ttys900'], count: 1 })
    change(['append', state, '/dev/ttys900', '2', '/dev/ttys902', ''])
    assert.equal(file(state, 'ttys900'), '{"tab_id": "1", "tty": "/dev/ttys901", "owner": "S-ME", "resident": true}\n{"tab_id": "2", "tty": "/dev/ttys902", "owner": ""}\n')
  })

  it('drops, drops a tab everywhere, repoints and transfers, saying what it wrote', () => {
    const state = scratch()
    change(['append', state, '/dev/ttys900', '1', '/dev/ttys901', 'S-ME'])
    change(['append', state, '/dev/ttys900', '2', '/dev/ttys902', 'S-ME'])
    change(['append', state, '/dev/ttys900', '3', '/dev/ttys903', 'S-ME'])
    assert.deepEqual(change(['drop', state, '/dev/ttys900', '9']), { written: [], count: 0 })
    assert.deepEqual(change(['drop', state, '/dev/ttys900', '3']), { written: ['/dev/ttys900'], count: 0 })
    assert.deepEqual(change(['drop-tab', state, '2']), { written: ['/dev/ttys900'], count: 0 })
    assert.deepEqual(change(['repoint-tab', state, '1', '4', '/dev/ttys904']), { written: ['/dev/ttys900'], count: 1 })
    assert.deepEqual(change(['transfer', state, '/dev/ttys900', 'S-ME', '/dev/ttys950', 'S-NEW']), { written: ['/dev/ttys950'], count: 1 })
    assert.deepEqual(change(['transfer', state, '/dev/ttys800', '', '/dev/ttys950', 'S-NEW', 'merge']), { written: ['/dev/ttys950'], count: 0 })
    assert.equal(file(state, 'ttys950'), '{"tab_id": "4", "tty": "/dev/ttys904", "owner": "S-NEW"}\n')
  })

  it('prints its answer as one JSON line, a malformed line exit 2, a held lock exit 1', () => {
    const state = scratch()
    assert.deepEqual(ran(['append', state, '/dev/ttys1', '1', '/dev/ttys2', 'S']), { code: 0, out: '{"written":["/dev/ttys1"],"count":1}\n', err: '' })
    for (const bad of [[], ['nope', state], ['append', state, '/dev/t', '', '/dev/a', 'S'], ['append', '', '/dev/t', '1', '/dev/a', 'S'],
      ['append', state, '/dev/t', '1', '/dev/a', 'S', 'other'], ['drop', state, '/dev/t'], ['drop-tab', state], ['repoint-tab', state, '1', '2'],
      ['transfer', state, '', 'S', '/dev/b', 'S'], ['transfer', state, '/dev/a', 'S', '/dev/b', 'S', 'resident']]) {
      const result = ran(bad)
      assert.equal(result.code, 2, JSON.stringify(bad))
      assert.match(result.err, /^chains: /)
    }
    mkdirSync(join(state, 'chains'), { recursive: true })
    writeFileSync(join(state, 'chains', 'ttys7.jsonl.lock'), '1\n')
    const held = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./chains.ts', import.meta.url)),
      'drop', state, '/dev/ttys7', '1'], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(held.status, 1)
    assert.match(held.stderr, /stayed locked/)
  })
})
