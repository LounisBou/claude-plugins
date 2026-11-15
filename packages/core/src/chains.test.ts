import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  appendChain, chainOwned, chainPath, chainText, chainTtyOf, chainTtys, changeChain, dropFromChain, dropTabEverywhere, parseChain, readChain,
  repointTab, transferChain, type ChainEntry,
} from './chains.ts'
import { lockOf } from './store-io.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'chains-'))
const entry = (tab: string, tty: string, owner = 'S', resident = false): ChainEntry => ({ tab_id: tab, tty, owner, resident })
const tabs = (state: string, tty: string): string[] => readChain(state, tty).map(e => e.tab_id)

describe('the chain format', () => {
  it('writes the lines the launcher\'s Python writer wrote', () => {
    assert.equal(
      chainText([entry('1', '/dev/ttys001', 'S-A'), entry('2', '/dev/ttys002', '', true)]),
      '{"tab_id": "1", "tty": "/dev/ttys001", "owner": "S-A"}\n{"tab_id": "2", "tty": "/dev/ttys002", "owner": "", "resident": true}\n',
    )
    assert.equal(chainText([entry('é', 't', 'a"b')]), '{"tab_id": "\\u00e9", "tty": "t", "owner": "a\\"b"}\n')
  })

  it('reads either spacing, drops an entry without tab or tty, and empties on a line that is no JSON', () => {
    const text = '{"tab_id":"1","tty":"/dev/a","owner":"S","resident":true}\n\n[1]\n{"tab_id":"","tty":"x"}\n{"tab_id":"3","tty":""}\n{"tab_id":"4","tty":"/dev/d","owner":7}\n'
    assert.deepEqual(parseChain(text), [entry('1', '/dev/a', 'S', true), entry('4', '/dev/d', '')])
    assert.deepEqual(parseChain(`${text}{"tab_id":`), [])
    assert.deepEqual(parseChain(undefined), [])
    assert.deepEqual(parseChain(chainText(parseChain(text))), parseChain(text))
  })

  it('names the file after the tty and back', () => {
    assert.equal(chainPath('/s', '/dev/ttys004'), '/s/chains/ttys004.jsonl')
    assert.equal(chainPath('/s', 'ttys004'), '/s/chains/ttys004.jsonl')
    assert.equal(chainTtyOf('ttys004.jsonl'), '/dev/ttys004')
    assert.equal(chainTtyOf('.jsonl'), undefined)
    assert.equal(chainTtyOf('ttys004.jsonl.tmp-1'), undefined)
  })

  it('keeps the entries of one owner, every entry with none known', () => {
    const all = [entry('1', 'a', 'S-A'), entry('2', 'b', 'S-B')]
    assert.deepEqual(chainOwned(all, 'S-B'), [all[1]])
    assert.deepEqual(chainOwned(all, ''), all)
  })
})

describe('chain changes through the store', () => {
  it('appends, drops and leaves a chain unchanged when nothing names the tab', () => {
    const state = scratch()
    appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901'))
    appendChain(state, '/dev/ttys900', entry('2', '/dev/ttys902'))
    assert.equal(dropFromChain(state, '/dev/ttys900', ['9']), false)
    assert.equal(dropFromChain(state, '/dev/ttys900', []), false)
    assert.equal(dropFromChain(state, '/dev/ttys900', ['1']), true)
    assert.deepEqual(tabs(state, '/dev/ttys900'), ['2'])
    assert.equal(changeChain(state, '/dev/ttys900', () => undefined), undefined)
  })

  it('drops and repoints a tab in every chain', () => {
    const state = scratch()
    appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901', 'S', true))
    appendChain(state, '/dev/ttys800', entry('1', '/dev/ttys901'))
    appendChain(state, '/dev/ttys800', entry('5', '/dev/ttys905'))
    writeFileSync(join(state, 'chains', 'notes.txt'), 'x')
    assert.deepEqual(chainTtys(state), ['/dev/ttys800', '/dev/ttys900'])
    assert.deepEqual(repointTab(state, '1', '2', '/dev/ttys902'), { count: 2, written: ['/dev/ttys800', '/dev/ttys900'] })
    assert.deepEqual(readChain(state, '/dev/ttys900'), [entry('2', '/dev/ttys902', 'S', true)])
    assert.deepEqual(repointTab(state, 'none', '3', '/dev/x'), { count: 0, written: [] })
    assert.deepEqual(dropTabEverywhere(state, '5'), ['/dev/ttys800'])
    assert.deepEqual(chainTtys(scratch()), [])
  })

  it('transfers the predecessor\'s own entries, replacing or merging with the successor\'s file', () => {
    const state = scratch()
    appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901', 'S-ME', true))
    appendChain(state, '/dev/ttys900', entry('9', '/dev/ttys909', 'S-OTHER'))
    appendChain(state, '/dev/ttys950', entry('7', '/dev/ttys907', 'S-STALE'))
    assert.equal(transferChain(state, '/dev/ttys900', 'S-ME', '/dev/ttys950', 'S-NEW'), 1)
    assert.equal(existsSync(chainPath(state, '/dev/ttys900')), false)
    assert.deepEqual(readChain(state, '/dev/ttys950'), [entry('1', '/dev/ttys901', 'S-NEW', true)])
    appendChain(state, '/dev/ttys800', entry('1', '/dev/ttys901', 'S-OLD'))
    appendChain(state, '/dev/ttys800', entry('3', '/dev/ttys903', 'S-OLD'))
    assert.equal(transferChain(state, '/dev/ttys800', 'S-OLD', '/dev/ttys950', 'S-NEW', true), 2)
    assert.deepEqual(tabs(state, '/dev/ttys950'), ['1', '3'])
    assert.equal(transferChain(state, '/dev/ttys950', 'S-NEW', '/dev/ttys950', 'S-NEW'), 2)
    assert.deepEqual(tabs(state, '/dev/ttys950'), ['1', '3'])
  })

  it('reads an unreadable chain as empty', () => {
    const state = scratch()
    mkdirSync(chainPath(state, '/dev/ttys1'), { recursive: true })
    assert.deepEqual(readChain(state, '/dev/ttys1'), [])
  })
})

describe('the chain store under attack', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const appender = (state: string, tab: string): Promise<number> =>
    new Promise(resolve => {
      const code = `import { appendChain } from ${JSON.stringify(join(here, 'chains.ts'))}
appendChain(${JSON.stringify(state)}, '/dev/ttys900', { tab_id: ${JSON.stringify(tab)}, tty: '/dev/t${tab}', owner: 'S', resident: false }, { waitMs: 20000 })`
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], { stdio: 'ignore' })
      child.on('exit', status => resolve(status ?? 1))
    })

  it('loses no append of twelve processes writing one chain at once', async () => {
    const state = scratch()
    const all = Array.from({ length: 12 }, (_, i) => String(i))
    const codes = await Promise.all(all.map(tab => appender(state, tab)))
    assert.deepEqual(codes, all.map(() => 0))
    assert.deepEqual(tabs(state, '/dev/ttys900').sort(), [...all].sort())
    assert.deepEqual(readdirSync(join(state, 'chains')), ['ttys900.jsonl'])
  })

  it('leaves the chain whole when a write fails before its rename, and no temporary file', { skip: process.getuid?.() === 0 }, () => {
    const state = scratch()
    appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901'))
    const before = readFileSync(chainPath(state, '/dev/ttys900'), 'utf8')
    const dir = join(state, 'chains')
    chmodSync(dir, 0o500)
    try {
      assert.throws(() => appendChain(state, '/dev/ttys900', entry('2', '/dev/ttys902'), { waitMs: 50 }))
    } finally {
      chmodSync(dir, 0o700)
    }
    assert.equal(readFileSync(chainPath(state, '/dev/ttys900'), 'utf8'), before)
    assert.deepEqual(readdirSync(dir), ['ttys900.jsonl'])
  })

  it('reads a torn file as no chain, and the next write replaces it whole', () => {
    const state = scratch()
    mkdirSync(join(state, 'chains'), { recursive: true })
    writeFileSync(chainPath(state, '/dev/ttys900'), '{"tab_id": "1", "tty": "/dev/ttys901", "owner": "S"}\n{"tab_id": "2", "tt')
    assert.deepEqual(readChain(state, '/dev/ttys900'), [])
    appendChain(state, '/dev/ttys900', entry('3', '/dev/ttys903'))
    assert.equal(readFileSync(chainPath(state, '/dev/ttys900'), 'utf8'), chainText([entry('3', '/dev/ttys903')]))
  })

  it('waits for a held lock, gives up past its wait, and takes over a dead holder\'s', () => {
    const state = scratch()
    const lock = lockOf(chainPath(state, '/dev/ttys900'))
    mkdirSync(join(state, 'chains'), { recursive: true })
    writeFileSync(lock, '1\n')
    assert.throws(() => appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901'), { waitMs: 50 }), /stayed locked/)
    assert.equal(existsSync(chainPath(state, '/dev/ttys900')), false)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    appendChain(state, '/dev/ttys900', entry('1', '/dev/ttys901'), { waitMs: 50 })
    assert.deepEqual(tabs(state, '/dev/ttys900'), ['1'])
    assert.equal(existsSync(lock), false)
  })
})
