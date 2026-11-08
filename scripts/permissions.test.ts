import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { grantsPermission, listedInstallers, run, writesRule } from './permissions.ts'

const CONTRACTS = `# Contracts

## Installer permission rules

| Rule | Plugin | Validation the script performs |
|---|---|---|
| \`Bash(<install>/x.sh spawn *)\` | alpha | modes in an allowlist |
`

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'perm-'))
  for (const [path, text] of Object.entries({ 'docs/contracts.md': CONTRACTS, 'plugins/alpha/install.sh': '', 'plugins/beta/run.sh': '', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function check(root: string): { code: number; errors: string[] } {
  const errors: string[] = []
  const code = run(root, [], { out: () => {}, err: line => { errors.push(line) }, env: {} })
  return { code, errors }
}

describe('permissions', () => {
  it('reads a settings file as granting only when it holds permissions', () => {
    assert.equal(grantsPermission('{"permissions": {"allow": ["Bash(git merge:*)"]}}'), true)
    assert.equal(grantsPermission('{"permissions": {}}'), false)
    assert.equal(grantsPermission('{"statusLine": {}}'), false)
    assert.equal(grantsPermission('{'), false)
  })

  it('knows a write to the allow list in jq, Python and JavaScript', () => {
    assert.equal(writesRule(`jq '.permissions.allow = (.permissions.allow + [$r])'`), true)
    assert.equal(writesRule('data["permissions"]["allow"].append(rule)'), true)
    assert.equal(writesRule('settings.permissions.allow.push(rule)'), true)
    assert.equal(writesRule('perms.setdefault("allow", [])'), true)
    assert.equal(writesRule('jq -e \'(.permissions.allow // []) | any(.[]; . == $r)\''), false)
  })

  it('reads the plugins the installer rules table lists', () => {
    assert.deepEqual(listedInstallers(CONTRACTS), ['alpha'])
    assert.deepEqual(listedInstallers('# none'), [])
  })

  it('passes a listed installer, and refuses an unlisted one or a committed grant', () => {
    assert.deepEqual(check(repo({ 'plugins/alpha/install.sh': "jq '.permissions.allow = [$r]'" })), { code: 0, errors: [] })
    const unlisted = check(repo({ 'plugins/beta/run.sh': "jq '.permissions.allow = [$r]'", 'plugins/beta/tests/run-tests.sh': "jq '.permissions.allow = []'" }))
    assert.equal(unlisted.code, 1)
    assert.deepEqual(unlisted.errors, ['plugins/beta/run.sh: writes a permission rule, and beta has no row in the installer rules of docs/contracts.md'])
    const committed = check(repo({ 'plugins/beta/.claude/settings.json': '{"permissions": {"allow": ["Bash(gh pr merge:*)"]}}' }))
    assert.deepEqual(committed.errors, ['plugins/beta/.claude/settings.json: a committed settings file grants a permission'])
  })

  it('refuses a row naming a plugin that does not exist', () => {
    const root = repo({})
    writeFileSync(join(root, 'docs/contracts.md'), readFileSync(join(root, 'docs/contracts.md'), 'utf8').replace('| alpha |', '| gamma |'))
    assert.deepEqual(check(root).errors, ['docs/contracts.md: the installer rules list gamma, which is not a plugin'])
  })
})
