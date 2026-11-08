import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  isTemporary, lockOf, removeArgv, renameArgv, staleTemporaries, STALE_MS, takeLockArgv, temporaryOf, updateOver, withLockOver, writeAtomicOver,
  type StoreIo,
} from './store-io.ts'
import { withLock, writeAtomic } from './store.ts'

// The I/O a hooks module hands in, played by this machine's own processes: the commands the
// store runs are the ones a real shell answers.
function realIo(now: () => number = Date.now): StoreIo & { runs: string[][] } {
  const runs: string[][] = []
  let count = 0
  return {
    runs,
    write: async (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    read: async path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    run: async argv => {
      runs.push([...argv])
      const ran = spawnSync(argv[0] ?? 'false', argv.slice(1), { encoding: 'utf8' })
      return { exitCode: ran.status ?? 1, stderr: ran.stderr }
    },
    mtimeMs: async path => (existsSync(path) ? statSync(path).mtimeMs : undefined),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now,
    tag: () => `t${++count}`,
  }
}

const scratch = () => mkdtempSync(join(tmpdir(), 'store-io-'))

describe('store over an injected I/O', () => {
  it('shares the lock and temporary names of the node store', () => {
    assert.equal(lockOf('/a/b.json'), '/a/b.json.lock')
    assert.equal(temporaryOf('/a/b.json', 'x'), '/a/b.json.tmp-x')
    assert.ok(isTemporary('b.json.tmp-x'))
    assert.ok(!isTemporary('b.json'))
    const dir = scratch()
    writeAtomic(join(dir, 'f'), 'node')
    assert.deepEqual(readdirSync(dir), ['f'])
  })

  it('writes in one rename and leaves no temporary file', async () => {
    const dir = scratch()
    const io = realIo()
    await writeAtomicOver(io, join(dir, 'f.json'), '{"a":1}\n')
    assert.equal(readFileSync(join(dir, 'f.json'), 'utf8'), '{"a":1}\n')
    assert.deepEqual(readdirSync(dir), ['f.json'])
    assert.deepEqual(io.runs, [renameArgv(join(dir, 'f.json.tmp-t1'), join(dir, 'f.json'))])
  })

  it('removes its temporary file when the rename fails', async () => {
    const dir = scratch()
    const real = realIo()
    const io: StoreIo = { ...real, run: async argv => (argv[0] === 'mv' ? { exitCode: 1, stderr: 'mv: refused\n' } : real.run(argv)) }
    await assert.rejects(writeAtomicOver(io, join(dir, 'f.json'), 'x'), /could not be renamed into place: mv: refused/)
    assert.deepEqual(readdirSync(dir), [])
    assert.deepEqual(real.runs.at(-1), removeArgv(join(dir, 'f.json.tmp-t1')))
  })

  it('removes its temporary file when the write itself fails', async () => {
    const io = { ...realIo(), write: async () => { throw new Error('disk full') } }
    await assert.rejects(writeAtomicOver(io, '/nowhere/f', 'x'), /disk full/)
  })

  it('takes the lock in a directory not made yet, and releases it', async () => {
    const dir = join(scratch(), 'deep', 'er')
    const io = realIo()
    const seen = await withLockOver(io, join(dir, 'f'), async () => existsSync(join(dir, 'f.lock')))
    assert.equal(seen, true)
    assert.equal(existsSync(join(dir, 'f.lock')), false)
    assert.deepEqual(io.runs[0], takeLockArgv(join(dir, 'f.lock')))
  })

  it('releases the lock when the work throws', async () => {
    const dir = scratch()
    await assert.rejects(withLockOver(realIo(), join(dir, 'f'), async () => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(join(dir, 'f.lock')), false)
  })

  it('is excluded by the node store\'s lock of the same path', async () => {
    const dir = scratch()
    const path = join(dir, 'f')
    // The node store holds it: the async side polls and gives up.
    const io = realIo()
    let held = false
    withLock(path, () => { held = existsSync(lockOf(path)) })
    assert.ok(held)
    writeFileSync(lockOf(path), `${process.pid}\n`)
    await assert.rejects(withLockOver(io, path, async () => 'never', { tries: 2, pollMs: 1 }), /stayed locked/)
    assert.equal(io.runs.filter(argv => argv[0] === 'sh').length, 3)
  })

  it('takes over a lock left by a holder that died', async () => {
    const dir = scratch()
    const path = join(dir, 'f')
    writeFileSync(lockOf(path), '99999\n')
    const old = (Date.now() - STALE_MS - 5_000) / 1000
    utimesSync(lockOf(path), old, old)
    assert.equal(await withLockOver(realIo(), path, async () => 'mine'), 'mine')
  })

  it('updates under the lock, and writes nothing when the change answers undefined', async () => {
    const dir = scratch()
    const path = join(dir, 'n')
    const io = realIo()
    assert.equal(await updateOver(io, path, current => `${Number(current ?? 0) + 1}`), '1')
    assert.equal(await updateOver(io, path, current => `${Number(current ?? 0) + 1}`), '2')
    assert.equal(await updateOver(io, path, () => undefined), undefined)
    assert.equal(readFileSync(path, 'utf8'), '2')
  })

  it('keeps every update of writers racing on one file', async () => {
    const dir = scratch()
    const path = join(dir, 'n')
    const io = realIo()
    // Each change yields to the others between its read and its write.
    const slow: StoreIo = { ...io, read: async p => { const text = await io.read(p); await new Promise(r => setTimeout(r, 1)); return text } }
    await Promise.all(Array.from({ length: 5 }, () => updateOver(slow, path, current => `${Number(current ?? 0) + 1}`)))
    assert.equal(readFileSync(path, 'utf8'), '5')
  })

  it('names the temporary files a dead writer left, never a record or a fresh write', () => {
    const now = 100_000
    const entries = [
      { name: 'a', kind: 'file', mtimeMs: 0 },
      { name: 'a.tmp-1', kind: 'file', mtimeMs: now - STALE_MS - 1 },
      { name: 'b.tmp-2', kind: 'file', mtimeMs: now - 10 },
      { name: 'c.tmp-3', kind: 'dir', mtimeMs: 0 },
      { name: 'd.tmp-4', kind: 'file' },
    ]
    assert.deepEqual(staleTemporaries('/s', entries, now), ['/s/a.tmp-1', '/s/d.tmp-4'])
  })
})
