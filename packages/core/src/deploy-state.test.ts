import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deployedAt, installedOver, parseDeployState } from './deploy-state.ts'

const OWN = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

function state(history: readonly string[], pending = false): string {
  return JSON.stringify({ version: 1, repo: 'owner/name', marketplace: 'lounisbou', history: history.map(commit => ({ commit, at: '2026-01-01T00:00:00Z' })), skipped: [], pending, plugins: {} })
}

describe('the deployed commit of a plugin root', () => {
  it('is read from a deploy directory, with the state file beside it', () => {
    assert.deepEqual(deployedAt(`/cfg/deploys/lounisbou/${OWN}/plugins/orchestrator`), { commit: OWN, state: '/cfg/deploys/lounisbou/installed.json' })
    assert.deepEqual(deployedAt(`/cfg/deploys/lounisbou/${OWN}`), { commit: OWN, state: '/cfg/deploys/lounisbou/installed.json' })
  })

  it('is none outside a deploy directory', () => {
    assert.equal(deployedAt('/cfg/plugins/cache/lounisbou/orchestrator/1.2.3'), null)
    assert.equal(deployedAt('/cfg/deploys/lounisbou/current/plugins/orchestrator'), null)
    assert.equal(deployedAt(`/cfg/deploys/elsewhere/${OWN}/plugins/orchestrator`), null)
    assert.equal(deployedAt(''), null)
  })
})

describe('the commit installed over a session\'s own', () => {
  it('is none when the session runs the installed commit', () => {
    assert.equal(installedOver(OWN, parseDeployState(state([OWN]))), null)
  })

  it('is the installed commit when it is another', () => {
    assert.equal(installedOver(OWN, parseDeployState(state([NEWER, OWN]))), NEWER)
  })

  it('is none while the plugins are still to update to it', () => {
    assert.equal(installedOver(OWN, parseDeployState(state([NEWER, OWN], true))), null)
  })
})
