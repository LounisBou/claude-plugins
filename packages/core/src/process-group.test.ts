import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInGroup, signalGroup } from './process-group.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'core-group-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

describe('process group', () => {
  it('resolves the exit status of a command, its environment added', async () => {
    const status = await runInGroup([process.execPath, '-e', 'process.exit(process.env.GROUP_X === "1" ? 3 : 4)'], ROOT, { GROUP_X: '1' }, new AbortController().signal)
    assert.equal(status, 3)
    assert.equal(await runInGroup(['/no/such/command'], ROOT, {}, new AbortController().signal), null)
  })

  it('stops the command and every process it started when the signal aborts', async () => {
    const pidFile = join(ROOT, 'grandchild.pid')
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => undefined); setTimeout(() => undefined, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => undefined, 60000)`
    const controller = new AbortController()
    const running = runInGroup([process.execPath, '-e', script], ROOT, {}, controller.signal)
    for (let k = 0; k < 100 && !existsSync(pidFile); k++) await sleep(50)
    await sleep(200)
    controller.abort()
    assert.equal(await running, null)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    for (let k = 0; k < 40 && alive(grandchild); k++) await sleep(50)
    const survived = alive(grandchild)
    if (survived) process.kill(grandchild, 'SIGKILL')
    assert.equal(survived, false)
  })

  it('signals nothing without a process', () => {
    assert.doesNotThrow(() => signalGroup(undefined, 'SIGTERM'))
  })
})
