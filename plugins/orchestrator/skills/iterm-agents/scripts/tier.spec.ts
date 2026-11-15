import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelsMapOf, Refused, resolveTier, resolveTierPair, stateDirOf, versionedWarning, type TierDeps } from './tier.ts'

const deps = (map: string | null, env: Record<string, string> = {}): TierDeps & { warned: string[] } => {
  const warned: string[] = []
  return { env, read: () => map, warn: line => warned.push(line), warned }
}

const refusal = (tier: string, d: TierDeps): string => {
  try {
    resolveTierPair(tier, '/m.json', d)
  } catch (error) {
    if (error instanceof Refused) return error.message
    throw error
  }
  return 'resolved'
}

describe('a tier\'s binding', () => {
  it('reads a model, a model with its effort, or an object', () => {
    const map = JSON.stringify({ deep: 'a/high', standard: { model: 'b', effort: 'low' }, light: 'c' })
    assert.equal(resolveTier('deep', '/m.json', deps(map)), 'a/high')
    assert.equal(resolveTier('standard', '/m.json', deps(map)), 'b/low')
    assert.equal(resolveTier('light', '/m.json', deps(map)), 'c')
    assert.equal(resolveTier('deep', '/m.json', deps(map, { ORCHESTRATOR_TIER_DEEP: 'z' })), 'z')
    assert.deepEqual(resolveTierPair('deep', '/m.json', deps(null)), { model: '', effort: '' })
    assert.equal(resolveTier('deep', '/m.json', deps('{"deep":""}')), '')
    assert.equal(resolveTier('deep', '/m.json', deps('{"deep":5}')), '5')
    assert.equal(resolveTier('deep', '/m.json', deps('{"deep":true}')), 'True')
    assert.equal(resolveTier('deep', '/m.json', deps('{"deep":["x"]}')), '["x"]')
  })

  it('refuses an unknown tier, a map that does not read, an object without a model, an unknown effort', () => {
    assert.match(refusal('deepest', deps(null)), /unknown tier: deepest/)
    assert.match(refusal('deep', deps('{')), /\/m.json does not read as a tier map/)
    assert.match(refusal('deep', deps('[]')), /does not read as a tier map/)
    assert.match(refusal('deep', deps('{"deep":{"effort":"low"}}')), /bound to an object without a model/)
    assert.match(refusal('deep', deps('{"deep":"a/huge"}')), /unknown effort: huge/)
  })

  it('says a versioned model and the alias to bind instead, its variant kept', () => {
    assert.match(versionedWarning('deep', 'a-model-5-5[1m]') ?? '', /alias model\[1m\] instead/)
    assert.equal(versionedWarning('deep', 'model'), null)
    assert.equal(versionedWarning('deep', '5-5'), null)
    const d = deps('{"deep":"a-model-4-5-20250101"}')
    resolveTierPair('deep', '/m.json', d)
    assert.equal(d.warned.length, 1)
  })

  it('finds the map in the state directory unless named', () => {
    assert.equal(stateDirOf({}, '/h'), '/h/.claude/claude-orchestrator')
    assert.equal(stateDirOf({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c/claude-orchestrator')
    assert.equal(modelsMapOf({ ORCHESTRATOR_STATE_DIR: '/s' }, '/h'), '/s/models.json')
    assert.equal(modelsMapOf({ ORCHESTRATOR_MODELS_MAP: '/x.json' }, '/h'), '/x.json')
  })
})
