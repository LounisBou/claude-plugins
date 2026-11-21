import { strict as assert } from 'node:assert'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cacheDirOf, classify, content, dependents, field, findJobId, guards, jobsOf, main, needsOf, runOf, Unread, USAGE, type Deps } from './draft-guard.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'draft-guard-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const WF_CI = `name: CI
on: pull_request
jobs:
  wip-check:
    uses: ./.github/workflows/wip-check.yml
  tests:
    runs-on: ubuntu-latest
    steps:
      - run: make test
`
const WF_WIP = `name: wip-check
on:
  workflow_call:
jobs:
  wip-check:
    runs-on: ubuntu-latest
    steps:
      - name: Refuse a draft pull request
        run: |
          if [[ "\${{ github.event.pull_request.draft }}" == "true" ]]; then exit 1; fi
`
const WF_INLINE = `name: CI
jobs:
  draft-gate:
    name: "the gate"
    runs-on: u # pull_request.draft only in a comment here
    steps:
      - run: test "\${{ github.event.pull_request.draft }}" != "true"
  trailing:
    runs-on: u # pull_request.draft
  remote:
    uses: other/repo/.github/workflows/x.yml@v1
  'quoted':
    runs-on: u
other: x
`
const WF_NEEDS = `jobs:
  wip-check:
    uses: ./.github/workflows/wip-check.yml
  other:
    runs-on: u
  build:
    needs: wip-check
  lint:
    needs: [other, "wip-check"]
  deploy:
    runs-on: u
    needs:
      - other
      - wip-check   # the guard
    steps:
      - run: make deploy
  docs:
    needs: other
  spread:
    needs: [other,
      wip-check]
`

/** A fake `gh api`: the run and the files at their sha, every read counted. */
function api(files: Record<string, string>, runs: Record<string, [string, string]>): { gh: (argv: readonly string[]) => string; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    gh: argv => {
      calls.push(argv.join(' '))
      const url = argv[1] ?? ''
      const run = /actions\/runs\/(\d+)$/.exec(url)?.[1]
      if (run !== undefined) {
        const known = runs[run]
        if (known === undefined) throw new Unread('gh: HTTP 404')
        return JSON.stringify({ path: known[0], head_sha: known[1] })
      }
      const file = /contents\/(.*)\?ref=(.*)$/.exec(url)
      const text = file === null ? undefined : files[`${decodeURIComponent(file[1] ?? '')}@${file[2]}`]
      if (text === undefined) throw new Unread('gh: HTTP 404')
      return JSON.stringify({ content: Buffer.from(text).toString('base64'), encoding: 'base64' })
    },
  }
}

const link = (run: number | string): string => `https://github.com/acme/thing/actions/runs/${run}/job/9`
const check = (name: string, bucket: string, run: number | string | null): Record<string, string> =>
  ({ name, bucket, link: run === null ? 'https://ci.example.com/build/4' : link(run) })

const FILES = {
  '.github/workflows/ci.yml@r1': WF_CI,
  '.github/workflows/wip-check.yml@r1': WF_WIP,
  '.github/workflows/ci.yml@i1': WF_INLINE,
  '.github/workflows/ci.yml@n1': WF_NEEDS,
  '.github/workflows/wip-check.yml@n1': WF_WIP,
}
const RUNS: Record<string, [string, string]> = {
  555: ['.github/workflows/ci.yml', 'r1'],
  556: ['.github/workflows/ci.yml@refs/heads/main', 'i1'],
  558: ['.github/workflows/ci.yml', 'gone'],
  570: ['.github/workflows/ci.yml', 'n1'],
}

test('the workflow file: comments dropped, jobs by indentation, fields, needs in three forms', () => {
  assert.equal(content('  a: "x # y" # z'), '  a: "x # y"')
  assert.equal(content('# only'), '')
  assert.equal(content('a#b'), 'a#b')
  const jobs = jobsOf(WF_INLINE)
  assert.deepEqual([...jobs.keys()], ['draft-gate', 'trailing', 'remote', 'quoted'])
  assert.deepEqual(jobsOf('name: x\n'), new Map())
  assert.equal(field(jobs.get('draft-gate') ?? [], 'name'), 'the gate')
  assert.equal(field(['  x:'], 'name'), null)
  assert.equal(findJobId(jobs, 'the gate'), 'draft-gate')
  assert.equal(findJobId(jobs, 'nobody'), null)
  const needs = jobsOf(WF_NEEDS)
  const of = (id: string): string[] => needsOf(needs.get(id) ?? [])
  assert.deepEqual([of('build'), of('lint'), of('deploy'), of('docs'), of('spread'), of('other')],
    [['wip-check'], ['other', 'wip-check'], ['other', 'wip-check'], ['other'], [], []])
  assert.equal(runOf(link(7)), '7')
  assert.equal(runOf(undefined), null)
  assert.throws(() => runOf(7))
})

test('classify: an inline draft test, a local reusable workflow, and what is no guard', () => {
  const read = (files: Record<string, string>) => (path: string): string => {
    const text = files[path]
    if (text === undefined) throw new Unread('absent')
    return text
  }
  const ci = { 'ci.yml': WF_INLINE }
  assert.equal(classify('the gate', read(ci), 'ci.yml'), true)
  assert.equal(classify('trailing', read(ci), 'ci.yml'), false)
  assert.equal(classify('remote / x', read(ci), 'ci.yml'), false)
  assert.equal(classify('nobody', read(ci), 'ci.yml'), false)
  const reusable = { 'ci.yml': WF_CI, '.github/workflows/wip-check.yml': WF_WIP }
  assert.equal(classify('wip-check / wip-check', read(reusable), 'ci.yml'), true)
  assert.equal(classify('wip-check', read(reusable), 'ci.yml'), false)
  assert.equal(classify('wip-check / other', read(reusable), 'ci.yml'), false)
  assert.throws(() => classify('wip-check / wip-check', read({ 'ci.yml': WF_CI }), 'ci.yml'), Unread)
})

test('guards: the failing checks that are guards, each head classified once and cached', () => {
  const cache = join(dir, 'cache')
  const fake = api(FILES, RUNS)
  const checks = [check('wip-check / wip-check', 'fail', 555), check('tests', 'fail', 555), check('lint', 'pass', 555),
    check('the gate', 'fail', 556), check('wip-check / wip-check', 'cancel', 555), check('ext', 'fail', null),
    check('wip-check / wip-check', 'fail', 558), 'no object', { name: 'x', bucket: 'fail', link: 7 }, { bucket: 'fail', link: link(555) }]
  assert.deepEqual([...guards('acme/thing', checks, cache, fake.gh)].sort(), ['the gate', 'wip-check / wip-check'])
  assert.equal(fake.calls.filter(c => c.includes('/contents/.github/workflows/ci.yml?ref=r1')).length, 1)
  fake.calls.length = 0
  assert.deepEqual([...guards('acme/thing', checks.slice(0, 4), cache, fake.gh)].sort(), ['the gate', 'wip-check / wip-check'])
  assert.deepEqual(fake.calls, [])
  assert.deepEqual([...guards('acme/thing', { not: 'a list' }, cache, fake.gh)], [])
  fake.calls.length = 0
  guards('acme/thing', [check('wip-check / wip-check', 'fail', 558)], cache, fake.gh)
  assert.ok(fake.calls.length > 0, 'an unreadable file is not cached: it is read again')
})

test('the cache: an entry older than seven days removed when one is written, a fresh one kept', () => {
  const cache = join(dir, 'cache')
  mkdirSync(cache)
  writeFileSync(join(cache, 'old-entry'), '')
  writeFileSync(join(cache, 'fresh-entry'), '')
  writeFileSync(join(cache, 'run-x.json'), '[1]')
  utimesSync(join(cache, 'old-entry'), new Date('2020-01-01'), new Date('2020-01-01'))
  guards('acme/thing', [check('tests', 'fail', 555)], cache, api(FILES, RUNS).gh)
  assert.equal(existsSync(join(cache, 'old-entry')), false)
  assert.equal(existsSync(join(cache, 'fresh-entry')), true)
  assert.ok(readdirSync(cache).some(name => name.startsWith('workflow-')))
  writeFileSync(join(dir, 'file'), '')
  assert.deepEqual([...guards('acme/thing', [check('wip-check / wip-check', 'fail', 555)], join(dir, 'file'), api(FILES, RUNS).gh)], ['wip-check / wip-check'])
})

test('the cache, in the data root, writes through no link planted at a slot or at its temporary name', () => {
  const cache = join(dir, 'cache')
  guards('acme/thing', [check('tests', 'fail', 555)], cache, api(FILES, RUNS).gh)
  const slots = readdirSync(cache)
  assert.ok(slots.length > 0)
  rmSync(cache, { recursive: true })
  mkdirSync(cache)
  // The slots' names are known to any session: links toward a protected file planted under each, and under each `.tmp`.
  const target = join(dir, 'protected')
  writeFileSync(target, 'kept\n')
  for (const slot of slots) {
    symlinkSync(target, join(cache, slot))
    symlinkSync(target, join(cache, `${slot}.tmp`))
  }
  guards('acme/thing', [check('tests', 'fail', 555)], cache, api(FILES, RUNS).gh)
  assert.equal(readFileSync(target, 'utf8'), 'kept\n')
  for (const slot of slots) assert.equal(lstatSync(join(cache, slot)).isSymbolicLink(), false, `${slot} is the cache's own file`)
})

test('a cache directory planted as a link is no cache: nothing in its target is pruned or written', () => {
  const target = join(dir, 'protected')
  mkdirSync(target)
  writeFileSync(join(target, 'models.json'), '{}')
  utimesSync(join(target, 'models.json'), new Date('2020-01-01'), new Date('2020-01-01'))
  symlinkSync(target, join(dir, 'cache'))
  guards('acme/thing', [check('tests', 'fail', 555)], join(dir, 'cache'), api(FILES, RUNS).gh)
  assert.deepEqual(readdirSync(target), ['models.json'])
})

test('a run or a file that answers something else is unread', () => {
  const odd = (answer: string) => (): string => answer
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c1'), odd('not json'))], [])
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c2'), odd('[1]'))], [])
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c3'), odd('{"path": ""}'))], [])
  const boom = (): string => { throw new Error('boom') }
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c4'), boom)], [])
  const noContent = (argv: readonly string[]): string => (String(argv[1]).includes('/runs/') ? '{"path": "ci.yml", "head_sha": "s"}' : '{"content": 3}')
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c5'), noContent)], [])
  const badUtf8 = (argv: readonly string[]): string => (String(argv[1]).includes('/runs/') ? '{"path": "ci.yml", "head_sha": "s"}' : `{"content": "${Buffer.from([0xff, 0xfe]).toString('base64')}"}`)
  assert.deepEqual([...guards('a/b', [check('t', 'fail', 1)], join(dir, 'c6'), badUtf8)], [])
})

test('dependents: the passed checks whose job needs a guard of the same file and head', () => {
  const cache = join(dir, 'cache')
  const fake = api(FILES, RUNS)
  const guard = check('wip-check / wip-check', 'fail', 570)
  const checks = [guard, check('build', 'pass', 570), check('lint', 'pass', 570), check('deploy', 'pass', 570), check('docs', 'pass', 570),
    check('secrets', 'pass', null), check('build', 'pass', 558), check('nobody', 'pass', 570), check('tests', 'fail', 570), check('build', 'pass', 570), 'x', check('x', 'pending', 570)]
  assert.deepEqual(dependents('acme/thing', checks, ['wip-check / wip-check'], cache, fake.gh), ['build', 'lint', 'deploy'])
  assert.deepEqual(dependents('acme/thing', checks, [], cache, fake.gh), [])
  assert.deepEqual(dependents('acme/thing', null, ['wip-check / wip-check'], cache, fake.gh), [])
})

/** The command over a fake gh: `pr view` and `pr checks` from the answers, `api` from the fixtures. */
function cli(argv: string[], gate: string): string {
  const out: string[] = []
  const err: string[] = []
  const fake = api(FILES, RUNS)
  const deps: Deps = {
    io: { out: t => out.push(t), err: t => err.push(t) },
    cacheDir: join(dir, 'cache'),
    gh: args => {
      assert.equal(args[0], 'api')
      return fake.gh(args)
    },
    stdin: () => gate,
  }
  const code = main(argv, deps)
  return `${code}|${out.join('')}|${err.join('')}`
}

test('the command: usage, no gate answer, the gate\'s failing names that are no guard, and --dependents', () => {
  const checks = [check('wip-check / wip-check', 'fail', 570), check('tests', 'fail', 570), check('build', 'pass', 570), check('gone', 'fail', 570)]
  const gate = (draft: boolean): string => JSON.stringify({ draft, ci: { result: 'FAILURE', failed: ['wip-check / wip-check', 'tests', 'gone', 'legacy'], checks } })
  assert.equal(cli([], ''), `5||${USAGE}\n`)
  assert.equal(cli(['acme', '7'], ''), `5||${USAGE}\n`)
  assert.equal(cli(['acme/thing', 'x'], ''), `5||${USAGE}\n`)
  assert.equal(cli(['acme/thing', '7', '--other'], ''), `5||${USAGE}\n`)
  for (const answer of ['', 'not json', '[]', '{}', '{"draft": true}', '{"draft": true, "ci": {"failed": []}}', '{"draft": "yes", "ci": {"failed": [], "checks": []}}']) {
    assert.equal(cli(['acme/thing', '7'], answer), '5||draft_guard: stdin holds no pr-gate answer (draft, ci.failed, ci.checks)\n')
  }
  // The names are the gate's: a failed status (`legacy`) has no check run and is never a guard.
  assert.equal(cli(['acme/thing', '7'], gate(true)), '0|tests\ngone\nlegacy\n|')
  assert.equal(cli(['acme/thing', '7'], gate(false)), '0|wip-check / wip-check\ntests\ngone\nlegacy\n|')
  assert.equal(cli(['acme/thing', '7', '--dependents'], gate(true)), '0|build\n|')
  assert.equal(cli(['acme/thing', '7', '--dependents'], gate(false)), '0||')
  assert.equal(cacheDirOf({ ORCHESTRATOR_STATE_DIR: '/s' }), '/s/draft-guard')
  assert.equal(cacheDirOf({ CLAUDE_CONFIG_DIR: '/c' }), '/c/claude-orchestrator/draft-guard')
})

test('the cache follows the data root the protected root places', () => {
  const state = mkdtempSync(join(tmpdir(), 'draft-guard-'))
  writeFileSync(join(state, 'data-root.json'), JSON.stringify({ version: 1, dir: '/shared/o' }))
  assert.equal(cacheDirOf({ ORCHESTRATOR_STATE_DIR: state }), '/shared/o/draft-guard')
})
