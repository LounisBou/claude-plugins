import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { diffFiles, main, modelOf, tierOf, UNBOUND } from './lens-model.ts'

test('prose alone is read lightly, a prompt or code is read at the default, a guard, a consent, data or a migration deeply', () => {
  assert.equal(tierOf(['docs/architecture.md', 'README.md', 'plugins/a/docs/design.md', 'notes.txt']), 'light')
  assert.equal(tierOf(['plugins/a/skills/x/SKILL.md']), 'standard')
  assert.equal(tierOf(['docs/a.md', 'plugins/a/hooks/relay.ts']), 'standard')
  assert.equal(tierOf(['plugins/a/templates/brief.md']), 'standard')
  for (const file of ['plugins/a/hooks/models-guard.ts', 'src/auth/login.ts', 'db/migrations/001_x.php', 'dump.sql', 'plugins/a/consent-words.ts', 'src/Security/Voter.php', 'config/credentials.json'])
    assert.equal(tierOf(['docs/a.md', file]), 'deep', file)
  assert.equal(tierOf(['plugins/a/.claude-plugin/plugin.json', 'src/author-list.ts']), 'standard')
  assert.equal(tierOf([]), 'standard')
})

function repo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lens-model-')))
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'base.txt'), 'x')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'work')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git('add', '-f', '.')
  git('commit', '-q', '-m', 'work')
  return dir
}

function run(argv: string[]): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  const code = main(argv, { out: t => { out += t }, err: t => { err += t } })
  return { code, out, err }
}

test('the model is the one the tier map binds to the diff\'s tier, host-default when the tier is unbound, and a map that does not read is refused', () => {
  const docs = repo({ 'docs/a.md': 'a' })
  const guard = repo({ 'docs/a.md': 'a', 'hooks/draft-guard.ts': 'b' })
  const maps = mkdtempSync(join(tmpdir(), 'lens-model-map-'))
  const saved = process.env['ORCHESTRATOR_MODELS_MAP']
  try {
    process.env['ORCHESTRATOR_MODELS_MAP'] = join(maps, 'models.json')
    writeFileSync(join(maps, 'models.json'), '{"light": "small-model/medium", "deep": {"model": "big-model", "effort": "high"}}')
    assert.deepEqual(run(['--dir', docs, '--base', 'main']), { code: 0, out: 'small-model\n', err: '' })
    assert.equal(run(['--dir', guard, '--base', 'main', '--head', 'work']).out, 'big-model\n')
    assert.equal(run(['--dir', docs, '--base', 'nowhere']).out, `${UNBOUND}\n`)
    assert.equal(modelOf('standard'), UNBOUND)
    assert.equal(modelOf('light'), 'small-model')
    writeFileSync(join(maps, 'models.json'), 'not json')
    assert.match(run(['--dir', docs, '--base', 'main']).err, /^lens-model: resolve-tier: .*does not read as a tier map/)
    rmSync(join(maps, 'models.json'))
    assert.equal(run(['--dir', docs, '--base', 'main']).out, `${UNBOUND}\n`)
    assert.deepEqual(diffFiles(docs, 'main', 'work'), ['docs/a.md'])
    assert.deepEqual(diffFiles(docs, 'nowhere', 'work'), [])
  } finally {
    if (saved === undefined) delete process.env['ORCHESTRATOR_MODELS_MAP']
    else process.env['ORCHESTRATOR_MODELS_MAP'] = saved
    for (const dir of [docs, guard, maps]) rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown flag or a flag with no value is refused with the usage', () => {
  assert.match(run(['--model', 'a-model']).err, /^lens-model: bad argument --model \(usage: lens-model\.sh/)
  assert.equal(run(['--base']).code, 2)
  assert.equal(run(['--base', '--head', 'x']).code, 2)
})
