// When a pull request needs no E2E record: files that hold no runtime, and a repository's standing exemption.
import { expect, test } from 'claude-code/testing'
import {
  covers, exemptingLabels, exemptionLine, exemptionPath, globMatches, isRepoName, parseExemption, parsePrFiles, runtimeFiles, type Exemption,
} from './e2e-scope.ts'

const VERSION_ONLY = '@@ -2,3 +2,3 @@\n   "name": "github",\n-  "version": "0.19.4",\n+  "version": "0.19.5",\n   "author": {'

test('documentation, tests, CI configuration and prompt text hold no runtime', () => {
  const files = [
    'README.md', 'docs/architecture.md', 'docs/diagram.svg', 'plugins/orchestrator/skills/orchestrator/references/review.md',
    'plugins/github/tests/run-tests.sh', 'src/__tests__/a.ts', 'hooks/guard.test.ts', 'app/models/user_spec.rb', 'pkg/server_test.go',
    'tests/test_api.py', 'conftest.py', 'scripts/contracts.test.ts', '.github/workflows/ci.yml', 'ci/prompts.json', '.gitlab-ci.yml',
    'LICENSE', 'CHANGELOG', 'Jenkinsfile',
  ].map((filename) => ({ filename }))
  expect(runtimeFiles(files)).toEqual([])
})

test('code, configuration and dependencies hold runtime, and so does a file the diff does not show', () => {
  const files = [
    'hooks/register.ts', 'engine/record.py', 'package.json', 'requirements.txt', 'src/docs/handler.ts', 'plugins/github/hooks/hooks.json',
  ].map((filename) => ({ filename }))
  expect(runtimeFiles(files)).toEqual(files.map((f) => f.filename))
})

test('a plugin manifest whose diff only moves its version holds no runtime, any other change of it does', () => {
  const manifest = 'plugins/github/.claude-plugin/plugin.json'
  expect(runtimeFiles([{ filename: manifest, patch: VERSION_ONLY }, { filename: '.claude-plugin/marketplace.json', patch: VERSION_ONLY }])).toEqual([])
  expect(runtimeFiles([{ filename: manifest, patch: VERSION_ONLY + '\n+  "hooks": "./hooks/hooks.json",' }])).toEqual([manifest])
  expect(runtimeFiles([{ filename: manifest }])).toEqual([manifest])
  expect(runtimeFiles([{ filename: 'package.json', patch: VERSION_ONLY }])).toEqual(['package.json'])
})

test('a file moved out of the code holds runtime: its old path counts too', () => {
  expect(runtimeFiles([{ filename: 'docs/old.md', previous_filename: 'src/old.ts' }])).toEqual(['src/old.ts'])
  expect(runtimeFiles([{ filename: 'docs/new.md', previous_filename: 'docs/old.md' }])).toEqual([])
})

test('the files of a pull request are read from pr-files, and anything else is refused', () => {
  expect(parsePrFiles(JSON.stringify([{ filename: 'a.md', status: 'modified', patch: '+x' }, { filename: 'b.ts', previous_filename: 'c.ts' }])))
    .toEqual([{ filename: 'a.md', patch: '+x' }, { filename: 'b.ts', previous_filename: 'c.ts' }])
  for (const text of ['ok', '{}', '[{"name": "a.md"}]']) expect(() => parsePrFiles(text)).toThrow()
})

test('an empty list of files vouches for nothing: it is refused as an unreadable one', () => {
  expect(() => parsePrFiles('[]')).toThrow('pr-files answered no files')
})

test('a glob takes * within a directory, ** across them and a trailing / for a whole directory', () => {
  expect(globMatches('docs/**', 'docs/a/b.md')).toBe(true)
  expect(globMatches('docs/', 'docs/a/b.md')).toBe(true)
  expect(globMatches('*.md', 'a.md')).toBe(true)
  expect(globMatches('*.md', 'docs/a.md')).toBe(false)
  expect(globMatches('**/*.md', 'docs/a.md')).toBe(true)
  expect(globMatches('src/?.ts', 'src/a.ts')).toBe(true)
  expect(globMatches('src/?.ts', 'src/ab.ts')).toBe(false)
  expect(globMatches('a+b.md', 'aab.md')).toBe(false)
})

const EXEMPTION: Exemption = {
  v: 1, repo: 'acme/thing', exempt: true, paths: [], labels: [], detail: 'no E2E on thing, 2026-11-13', session: 's', at: '2026-11-13T10:00:00Z',
}

test('an exemption file keeps its shape or is none', () => {
  expect(parseExemption(EXEMPTION)).toEqual(EXEMPTION)
  for (const change of [{ v: 2 }, { repo: 'acme' }, { exempt: 'yes' }, { paths: 'docs/' }, { labels: [3] }, { detail: 4 }, { at: 0 }]) {
    expect(parseExemption({ ...EXEMPTION, ...change })).toBeUndefined()
  }
  expect(parseExemption(null)).toBeUndefined()
  expect(exemptionPath('/data', 'Acme/Thing')).toBe('/data/e2e-exempt/acme/thing.json')
})

test('an exemption with no rule covers every pull request, a revoked one none', () => {
  expect(covers(EXEMPTION, [], undefined)).toBe(true)
  expect(covers({ ...EXEMPTION, exempt: false }, [], undefined)).toBe(false)
})

test('an exemption with rules covers a pull request carrying one of its labels, or whose files all match its paths', () => {
  const ruled = { ...EXEMPTION, paths: ['docs/', '*.md'], labels: ['no-e2e'] }
  expect(covers(ruled, ['No-E2E'], undefined)).toBe(true)
  expect(covers(ruled, ['Not Ready'], [{ filename: 'docs/a.md' }, { filename: 'README.md' }])).toBe(true)
  expect(covers(ruled, ['Not Ready'], [{ filename: 'docs/a.md' }, { filename: 'src/a.ts' }])).toBe(false)
  expect(covers(ruled, ['Not Ready'], [{ filename: 'docs/a.md', previous_filename: 'src/a.ts' }])).toBe(false)
  expect(covers(ruled, ['Not Ready'], undefined)).toBe(false)
  expect(covers(ruled, ['Not Ready'], [])).toBe(false)
})

test('the line of an exemption names its repository, its day and the operator\'s words', () => {
  expect(exemptionLine(EXEMPTION)).toBe('E2E exemption of acme/thing, 2026-11-13: no E2E on thing, 2026-11-13')
  expect(exemptionLine({ ...EXEMPTION, paths: ['docs/'], labels: ['no-e2e'] }))
    .toBe('E2E exemption of acme/thing (labels no-e2e, paths docs/), 2026-11-13: no E2E on thing, 2026-11-13')
})

test('a repository named with a part made of dots only is no repository, and has no exemption file', () => {
  for (const repo of ['../auto-merge', 'o/..', './thing', 'o/.', '.../x']) {
    expect(isRepoName(repo)).toBe(false)
    expect(() => exemptionPath('/data', repo)).toThrow()
    expect(parseExemption({ ...EXEMPTION, repo })).toBeUndefined()
  }
  for (const repo of ['acme/thing', 'o/.github', 'o/a..b', '.o/x']) expect(isRepoName(repo)).toBe(true)
})

test('the labels of a list an exemption in force names, without regard to case', () => {
  const labelled = { ...EXEMPTION, labels: ['no-e2e'] }
  expect(exemptingLabels(labelled, ['bug', 'No-E2E'])).toEqual(['No-E2E'])
  expect(exemptingLabels(labelled, ['bug'])).toEqual([])
  expect(exemptingLabels({ ...labelled, exempt: false }, ['no-e2e'])).toEqual([])
  expect(exemptingLabels(undefined, ['no-e2e'])).toEqual([])
})
