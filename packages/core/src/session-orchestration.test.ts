import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { orchForm } from './names.ts'
import { ciGatePath, ciWatchLogName, ciWatchLogPath, recordsRegistryPath, registryNameOf, watchNumberOf } from './orchestration.ts'
import { sessionOrchestration } from './session-orchestration.ts'
import { claimOwner, createOnly, firstLineOf, releaseOwner } from './store.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'core-claim-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('session names', () => {
  it('reads an orchestrator name in the house shape', () => {
    assert.equal(orchForm('  Orch: build [a1b2c3] '), 'Orch: build')
    assert.equal(orchForm('Orch:build'), 'Orch: build')
    // The former shape, an owner file written before the change: the same orchestration.
    assert.equal(orchForm('Orch : build [a1b2c3]'), 'Orch: build')
    assert.equal(orchForm('Agent: x'), 'Agent: x')
    assert.equal(orchForm('Orch: a subject far longer than twenty-five'), 'Orch: a subject far longer than twenty-five')
  })

  it('names the session\'s orchestration from the newest host record of this session', () => {
    const sessions = join(dir, 'cfg', 'sessions')
    assert.equal(sessionOrchestration({ CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_CONFIG_DIR: join(dir, 'cfg') }), '')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, '1.json'), '{"sessionId":"s1","name":"Orch: old","updatedAt":5}')
    writeFileSync(join(sessions, '2.json'), '{"sessionId":"s1","name":"Orch: new [r1]","updatedAt":9}')
    writeFileSync(join(sessions, '3.json'), '{"sessionId":"s1","name":"Orch: older","updatedAt":7}')
    writeFileSync(join(sessions, '4.json'), 'not json')
    writeFileSync(join(sessions, '5.json'), '{"sessionId":"s2","name":"Agent: a"}')
    writeFileSync(join(sessions, '5b.json'), '[1]')
    mkdirSync(join(sessions, '6.json'))
    const env = { CLAUDE_CONFIG_DIR: join(dir, 'cfg') }
    assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's1' }), 'Orch: new')
    assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's2' }), '')
    assert.equal(sessionOrchestration(env), '')
    writeFileSync(join(sessions, '7.json'), '{"sessionId":"s1","name":"Orch: float","updatedAt":1.5}')
    assert.equal(sessionOrchestration({ ...env, CLAUDE_CODE_SESSION_ID: 's1' }), 'Orch: float')
  })
})

describe('owner claim', () => {
  it('creates a file only when nothing is there, and leaves no temporary behind', () => {
    const path = join(dir, 'r.owner')
    assert.equal(createOnly(path, 'Orch: a\n'), true)
    assert.equal(createOnly(path, 'Orch: b\n'), false)
    assert.equal(readFileSync(path, 'utf8'), 'Orch: a\n')
    assert.deepEqual(readdirSync(dir), ['r.owner'])
  })

  it('claims an absent or empty owner file, and reads back an owner already there', () => {
    const path = join(dir, 'r.owner')
    assert.deepEqual(claimOwner(path, '', orchForm), { owner: '', claimed: false })
    assert.equal(existsSync(path), false)
    assert.deepEqual(claimOwner(path, 'Orch: a', orchForm), { owner: 'Orch: a', claimed: true })
    assert.deepEqual(claimOwner(path, 'Orch: b', orchForm), { owner: 'Orch: a', claimed: false })
    writeFileSync(path, '')
    assert.deepEqual(claimOwner(path, 'Orch: b', orchForm), { owner: 'Orch: b', claimed: true })
    writeFileSync(path, 'Orch:c [r1]\n')
    assert.deepEqual(claimOwner(path, 'Orch: b', orchForm), { owner: 'Orch: c', claimed: false })
    assert.deepEqual(claimOwner(join(dir, 'plain'), ' me '), { owner: 'me', claimed: true })
  })

  it('reads no owner and claims nothing where the file cannot be written', { skip: process.getuid?.() === 0 }, () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      assert.deepEqual(claimOwner(join(locked, 'r.owner'), 'Orch: a', orchForm), { owner: '', claimed: false })
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  it('gives a claim back only while the file still names the claimer', () => {
    const path = join(dir, 'r.owner')
    writeFileSync(path, 'Orch: a\n')
    releaseOwner(path, 'Orch: b', orchForm)
    assert.equal(firstLineOf(path), 'Orch: a')
    releaseOwner(path, 'Orch: a', orchForm)
    assert.equal(existsSync(path), false)
    assert.equal(firstLineOf(path), '')
    assert.equal(firstLineOf(dir), '')
  })
})

describe('orchestration names', () => {
  it('names the records registry of a session', () => {
    assert.equal(registryNameOf('a b/c:d.e-f_g'), 'a_b_c_d.e-f_g')
    assert.equal(recordsRegistryPath('/s', 'x/y'), '/s/records/x_y')
  })

  it('names a ci-watch log and reads its number back', () => {
    assert.equal(ciWatchLogName(undefined, '7'), 'here-pr7.log')
    assert.equal(ciWatchLogName('o/r x', '7', true), 'o_r_x-pr7-base.log')
    assert.equal(ciWatchLogPath('/s', 'o/r', '12'), '/s/ci-watch/o_r-pr12.log')
    assert.equal(watchNumberOf(ciWatchLogName('o/r', '12')), '12')
    assert.equal(watchNumberOf(ciWatchLogName('o/r', '12', true)), null)
    assert.equal(watchNumberOf('notes.txt'), null)
  })

  it('names the gate reading ci-watch keeps for a pull request, whatever the case of its repository', () => {
    assert.equal(ciGatePath('/s', 'Owner/Repo', '12'), '/s/ci-gate/owner_repo-pr12.json')
    assert.equal(ciGatePath('/s', 'o/r x', '7'), '/s/ci-gate/o_r_x-pr7.json')
  })
})
