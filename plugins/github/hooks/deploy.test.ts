// The deploy list's pure part: the file's shape, what a declaration recognises in a Bash line or a
// Skill call, and the refusal of a deploy the list does not grant.
import { expect, test } from 'claude-code/testing'
import { bashDeploys, deployRefusal, envOf, firstRefusal, granted, parseDeclared, parseDeployList, skillDeploys, type Declared } from './deploy.ts'

const INFRA = 'acme/infra'
const DECLARED: Declared[] = [
  { repo: INFRA, kind: 'command', argv: ['composer', 'deploy:api:prod'], env: 'prod' },
  { repo: INFRA, kind: 'command', argv: ['composer', 'deploy:api:staging'], env: 'staging' },
  { repo: INFRA, kind: 'script', path: 'scripts/deploy.sh' },
  { repo: 'acme/site', kind: 'workflow', workflow: 'deploy.yml', input: 'environment' },
  { repo: INFRA, kind: 'skill', name: 'acme-deploy-prod', env: 'prod' },
]
const LIST = { grants: [{ repo: INFRA, env: 'staging' as const }], declared: DECLARED }

test('the environments are read by name, production and prod alike', () => {
  expect(['dev', 'Staging', 'production', 'PROD', 'stage'].map(envOf)).toEqual(['dev', 'staging', 'prod', 'prod', 'staging'])
  expect([envOf('qa'), envOf(3), envOf(undefined)]).toEqual([undefined, undefined, undefined])
})

test('a list file keeps its shape: grants by repository and environment, declarations by kind', () => {
  const file = {
    repositories: [{ repo: INFRA, env: 'prod' }],
    commands: [{ repo: INFRA, kind: 'skill', name: '/acme-deploy-prod', env: 'production' }],
    other: 1,
  }
  expect(parseDeployList(file)).toEqual({
    grants: [{ repo: INFRA, env: 'prod' }],
    declared: [{ repo: INFRA, kind: 'skill', name: 'acme-deploy-prod', env: 'prod' }],
  })
  expect(parseDeployList({})).toEqual({ grants: [], declared: [] })
})

test('a malformed list file is refused with what is wrong, not read in part', () => {
  const bad: unknown[] = [
    [], { repositories: ['acme/infra'] }, { repositories: [{ repo: INFRA }] }, { repositories: [{ repo: 'infra', env: 'prod' }] },
    { repositories: [{ repo: INFRA, env: 'production' }] }, { commands: [{ repo: INFRA, kind: 'cron' }] },
  ]
  for (const raw of bad) expect(typeof parseDeployList(raw), JSON.stringify(raw)).toBe('string')
})

test('a declaration names what its kind needs and nothing else is accepted', () => {
  expect(parseDeclared({ repo: INFRA, kind: 'command', argv: ['composer', 'x'], env: 'prod' })).toEqual({ repo: INFRA, kind: 'command', argv: ['composer', 'x'], env: 'prod' })
  expect(parseDeclared({ repo: INFRA, kind: 'script', path: 'a.sh' })).toEqual({ repo: INFRA, kind: 'script', path: 'a.sh' })
  expect(parseDeclared({ repo: INFRA, kind: 'workflow', workflow: 'd.yml', input: 'environment' })).toEqual({ repo: INFRA, kind: 'workflow', workflow: 'd.yml', input: 'environment' })
  for (const raw of [
    null, { kind: 'script', path: 'a.sh' }, { repo: INFRA, kind: 'command', argv: [], env: 'prod' }, { repo: INFRA, kind: 'command', argv: ['x'] },
    { repo: INFRA, kind: 'script' }, { repo: INFRA, kind: 'workflow', workflow: 'd.yml' }, { repo: INFRA, kind: 'skill', name: 'x' },
  ]) expect(typeof parseDeclared(raw), JSON.stringify(raw)).toBe('string')
})

test('a command declared by its first words is a deploy of its environment, wherever it sits on the line', () => {
  expect(bashDeploys('composer deploy:api:prod -- 1.2.3', DECLARED)).toEqual([{ repo: INFRA, env: 'prod', what: 'composer deploy:api:prod' }])
  expect(bashDeploys('cd ~/infra && git pull && /usr/local/bin/composer deploy:api:staging > out.log 2>&1', DECLARED).map((d) => d.env)).toEqual(['staging'])
  expect(bashDeploys('bash -c "composer deploy:api:prod"', DECLARED).map((d) => d.env)).toEqual(['prod'])
  expect(bashDeploys('composer install', DECLARED)).toEqual([])
  expect(bashDeploys('echo composer deploy:api:prod', DECLARED)).toEqual([])
})

test('a declared script is a deploy whether run alone or under an interpreter, its environment the later word that names one', () => {
  expect(bashDeploys('./scripts/deploy.sh staging', DECLARED)).toEqual([{ repo: INFRA, env: 'staging', what: 'scripts/deploy.sh' }])
  expect(bashDeploys('bash /home/me/infra/scripts/deploy.sh production api', DECLARED).map((d) => d.env)).toEqual(['prod'])
  expect(bashDeploys('./scripts/deploy.sh api', DECLARED).map((d) => d.env)).toEqual([undefined])
  expect(bashDeploys('cat scripts/deploy.sh', DECLARED)).toEqual([])
  expect(bashDeploys('./scripts/redeploy.sh prod', DECLARED)).toEqual([])
})

test('a declared workflow is a deploy of the value its environment input is given', () => {
  const run = (line: string) => bashDeploys(line, DECLARED).map((d) => [d.repo, d.env])
  expect(run('gh workflow run deploy.yml -f environment=prod')).toEqual([['acme/site', 'prod']])
  expect(run('gh -R acme/site workflow run .github/workflows/deploy.yml --field environment=staging -f tag=1')).toEqual([['acme/site', 'staging']])
  expect(run('gh workflow run deploy.yml --raw-field=environment=production')).toEqual([['acme/site', 'prod']])
  expect(run('gh workflow run deploy.yml')).toEqual([['acme/site', undefined]])
  expect(run('gh workflow run deploy.yml -f environment=qa')).toEqual([['acme/site', undefined]])
  expect(run('gh workflow run build.yml -f environment=prod')).toEqual([])
  expect(run('gh workflow list')).toEqual([])
})

test('a skill is a deploy by its name, a slash or a plugin prefix aside', () => {
  const found = [{ repo: INFRA, env: 'prod', what: 'skill acme-deploy-prod' }]
  expect(skillDeploys('acme-deploy-prod', DECLARED)).toEqual(found)
  expect(skillDeploys('/acme-deploy-prod', DECLARED)).toEqual(found)
  expect(skillDeploys('acme:acme-deploy-prod', DECLARED)).toEqual(found)
  expect(skillDeploys('acme-deploy-prod-notes', DECLARED)).toEqual([])
  expect(skillDeploys('norms:check', DECLARED)).toEqual([])
})

test('the list grants a repository and an environment together, the repository without regard to case', () => {
  expect(granted(LIST, 'ACME/Infra', 'staging')).toBe(true)
  expect(granted(LIST, INFRA, 'prod')).toBe(false)
  expect(granted(LIST, 'acme/other', 'staging')).toBe(false)
})

test('a deploy the list does not grant is refused in one line naming how the operator adds it', () => {
  const line = firstRefusal(LIST, bashDeploys('composer deploy:api:prod', DECLARED))
  expect(line).toBe('github: composer deploy:api:prod refused: acme/infra is not in the deploy list for prod; only the operator adds it, with mcp__github__gh auto-deploy-set'
    + ' {"repo": "acme/infra", "env": "prod", "on": true, "words": "<their recorded answer naming auto-deploy, verbatim>"}.')
  expect(line).not.toContain('\n')
  expect(firstRefusal(LIST, bashDeploys('composer deploy:api:staging', DECLARED))).toBeUndefined()
  expect(firstRefusal(LIST, [])).toBeUndefined()
})

test('a deploy whose environment the call does not give is refused, as no listed environment covers it', () => {
  const line = firstRefusal(LIST, bashDeploys('./scripts/deploy.sh api', DECLARED))
  expect(line).toContain('its environment is none of dev, staging, prod')
  expect(deployRefusal({ repo: INFRA, env: undefined, what: 'x' })).toBe(line?.replace('scripts/deploy.sh', 'x'))
})
