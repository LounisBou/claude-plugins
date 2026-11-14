import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { cellKey, coveredCells, matrixOf, NO_SUITE, withoutCovered, type Platform } from './plugin-matrix.ts'
import { cellOfJob, decide, run, type Api, type Git } from './tested-tree.ts'

const REPO = 'acme/app'
const MERGE = 'm'.repeat(40)
const BASE = 'b'.repeat(40)
const HEAD = 'h'.repeat(40)
const TREE = 't'.repeat(40)
const TESTED_MERGE = 'c'.repeat(40)
const OTHER_TREE = 'o'.repeat(40)

interface World {
  /** The tree of the pushed commit. */
  tree?: string
  /** The pushed commit followed by its parents, as `git rev-list --parents` prints them. */
  parents?: string[]
  /** The tree of the merge commit the pull request run checked out. */
  tested?: string
  /** The second parent of that merge commit. */
  mergedHead?: string
  runs?: unknown
  jobs?: unknown
  /** What the log of the repository job holds. */
  log?: string
  /** The API path that rejects. */
  broken?: string
}

function job(name: string, conclusion = 'success'): { id: number, name: string, conclusion: string } {
  return { id: name.length, name, conclusion }
}

function pullRequestRun(conclusion = 'success'): Record<string, unknown> {
  return { id: 7, conclusion, head_sha: HEAD, path: '.github/workflows/ci.yml', pull_requests: [] }
}

function world(overrides: World = {}): { git: Git, api: Api, calls: string[] } {
  const calls: string[] = []
  const state: World = {
    tree: TREE,
    parents: [BASE, HEAD],
    tested: TREE,
    mergedHead: HEAD,
    runs: { workflow_runs: [pullRequestRun()] },
    jobs: { jobs: [job('repository rules'), job('alpha on ubuntu-latest'), job('beta on ubuntu-latest (part 2)'), job('ci')] },
    log: `Run actions/checkout@v5\n fetch origin +${TESTED_MERGE}:refs/remotes/pull/12/merge\n`,
    ...overrides,
  }
  const git: Git = (...args) => {
    calls.push(`git ${args.join(' ')}`)
    if (args[0] === 'rev-parse') return `${state.tree}\n`
    if (args[0] === 'rev-list') return `${MERGE} ${(state.parents ?? []).join(' ')}\n`
    throw new Error(`git ${args[0]} failed`)
  }
  const reach = (path: string): void => {
    calls.push(`api ${path}`)
    if (state.broken !== undefined && path.includes(state.broken)) throw new Error('HTTP 502')
  }
  const api: Api = {
    json: async path => {
      reach(path)
      if (path.includes('/git/commits/')) return { parents: [{ sha: BASE }, { sha: state.mergedHead }], tree: { sha: state.tested } }
      return path.includes('/jobs') ? state.jobs : state.runs
    },
    text: async path => {
      reach(path)
      return state.log ?? ''
    },
  }
  return { git, api, calls }
}

describe('the decision for a push to main', () => {
  it('skips what the run of the same tree passed', async () => {
    const { git, api } = world()
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, true)
    assert.deepEqual(decision.covered, ['alpha|ubuntu-latest|', 'beta|ubuntu-latest|2'])
    assert.match(decision.reason, /^skip what run 7 passed/)
  })

  it('reads the tree of the merge commit the checkout of the run fetched', async () => {
    const { git, api, calls } = world()
    await decide(MERGE, REPO, git, api)
    assert.ok(calls.includes(`api repos/${REPO}/git/commits/${TESTED_MERGE}`), calls.join('\n'))
  })

  it('runs everything when the tree differs from the tree tested', async () => {
    const { git, api } = world({ tested: OTHER_TREE })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.deepEqual(decision.covered, [])
    assert.match(decision.reason, /^run everything: tree tttttttt differs from the tree oooooooo/)
  })

  it('runs everything when the pull request run failed, whatever its tree', async () => {
    const { git, api } = world({ runs: { workflow_runs: [pullRequestRun('failure')] } })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.deepEqual(decision.covered, [])
    assert.match(decision.reason, /no successful pull request run/)
  })

  it('runs everything when the lookup of the runs fails', async () => {
    const { git, api } = world({ broken: '/actions/runs?' })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.deepEqual(decision.covered, [])
    assert.match(decision.reason, /the lookup failed \(HTTP 502\)/)
  })

  it('runs everything when the lookup of the jobs fails, even on an equal tree', async () => {
    const { git, api } = world({ broken: '/jobs' })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.deepEqual(decision.covered, [])
  })

  it('runs everything when the log of the run is gone', async () => {
    const { git, api } = world({ broken: '/logs' })
    assert.match((await decide(MERGE, REPO, git, api)).reason, /the lookup failed/)
  })

  it('runs everything when the log does not name the merge commit', async () => {
    const { git, api } = world({ log: 'nothing fetched here\n' })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.match(decision.reason, /names the tree it tested/)
  })

  it('runs everything when the commit the log names does not merge the run\'s head', async () => {
    const { git, api } = world({ mergedHead: 'x'.repeat(40) })
    assert.match((await decide(MERGE, REPO, git, api)).reason, /names the tree it tested/)
  })

  it('runs everything when the API answers something else than runs', async () => {
    const { git, api } = world({ runs: 'rate limited' })
    assert.match((await decide(MERGE, REPO, git, api)).reason, /^run everything: the lookup failed/)
  })

  it('runs everything for a commit that is not the merge of a pull request', async () => {
    const { git, api } = world({ parents: [BASE] })
    assert.match((await decide(MERGE, REPO, git, api)).reason, /is not the merge of a pull request/)
  })

  it('runs everything for a run of another workflow', async () => {
    const other = { ...pullRequestRun(), path: '.github/workflows/other.yml' }
    const { git, api } = world({ runs: { workflow_runs: [other] } })
    assert.equal((await decide(MERGE, REPO, git, api)).repository, false)
  })

  it('leaves out only the jobs that passed', async () => {
    const jobs = { jobs: [job('repository rules'), job('alpha on ubuntu-latest', 'failure'), job('beta on ubuntu-latest', 'cancelled'), job('gamma on ubuntu-latest')] }
    const { git, api } = world({ jobs })
    assert.deepEqual((await decide(MERGE, REPO, git, api)).covered, ['gamma|ubuntu-latest|'])
  })

  it('does not skip the repository rules when that job did not pass', async () => {
    const jobs = { jobs: [job('repository rules', 'failure'), job('alpha on ubuntu-latest')] }
    const { git, api } = world({ jobs })
    const decision = await decide(MERGE, REPO, git, api)
    assert.equal(decision.repository, false)
    assert.deepEqual(decision.covered, ['alpha|ubuntu-latest|'])
  })

  it('covers no cell that is not yet blocking, even when its job passed', async () => {
    const jobs = { jobs: [job('repository rules'), job('alpha on ubuntu-latest (not yet blocking)'), job('beta on ubuntu-latest')] }
    const { git, api } = world({ jobs })
    assert.deepEqual((await decide(MERGE, REPO, git, api)).covered, ['beta|ubuntu-latest|'])
  })

  it('finds the matching run among several', async () => {
    const second = { ...pullRequestRun(), id: 8 }
    const { git, api } = world({ runs: { workflow_runs: [pullRequestRun('failure'), second] } })
    assert.match((await decide(MERGE, REPO, git, api)).reason, /run 8 passed/)
  })
})

describe('the names of the jobs', () => {
  it('reads a plugin cell, its part and its platform', () => {
    assert.equal(cellOfJob('alpha on macos-latest'), 'alpha|macos-latest|')
    assert.equal(cellOfJob('orchestrator on ubuntu-latest (part 3)'), 'orchestrator|ubuntu-latest|3')
  })

  it('reads no cell in a job not yet blocking: its suite may have failed under a warning', () => {
    assert.equal(cellOfJob('drift on ubuntu-latest (not yet blocking)'), undefined)
  })

  it('reads no cell in the jobs that are not one', () => {
    assert.equal(cellOfJob('repository rules'), undefined)
    assert.equal(cellOfJob('ci'), undefined)
    assert.equal(cellOfJob('alpha on windows-latest'), undefined)
  })

  it('names a cell of the matrix as the job of that cell is named', () => {
    const [cell] = matrixOf(new Map([['alpha', new Set<Platform>(['ubuntu-latest'])]]), new Map([['alpha', 2]]))
    assert.ok(cell !== undefined)
    assert.equal(cellKey(cell), cellOfJob('alpha on ubuntu-latest (part 1)'))
  })
})

describe('the matrix of main without the cells already passed', () => {
  const matrix = matrixOf(new Map([['alpha', new Set<Platform>(['ubuntu-latest'])], ['beta', new Set<Platform>(['ubuntu-latest'])]]))
    .filter(cell => cell.os === 'ubuntu-latest')

  it('keeps every cell the run did not pass', () => {
    assert.deepEqual(withoutCovered(matrix, new Set(['alpha|ubuntu-latest|'])).map(cell => cell.plugin), ['beta'])
  })

  it('keeps every cell when nothing is covered', () => {
    assert.equal(withoutCovered(matrix, new Set()).length, 2)
  })

  it('leaves the cell without a suite when every cell is covered', () => {
    assert.deepEqual(withoutCovered(matrix, new Set(matrix.map(cellKey))), [{ plugin: NO_SUITE, os: 'ubuntu-latest', blocking: true }])
  })

  it('reads the covered keys as a JSON list and nothing else', () => {
    assert.deepEqual([...coveredCells('["alpha|ubuntu-latest|"]')], ['alpha|ubuntu-latest|'])
    assert.equal(coveredCells(undefined).size, 0)
    assert.equal(coveredCells('').size, 0)
    assert.equal(coveredCells('{"a":1}').size, 0)
    assert.equal(coveredCells('[1, null]').size, 0)
  })
})

describe('the workflow step', () => {
  it('is bounded: a hung lookup ends in two minutes and main runs everything', () => {
    const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    const step = /- id: tested\n(?:        .*\n)+/.exec(workflow)?.[0]
    assert.ok(step !== undefined, 'the tested step')
    assert.match(step, /\n {8}timeout-minutes: 2\n/)
    assert.match(step, /\n {8}continue-on-error: true\n/)
  })
})

describe('the step', () => {
  function outputIn(): string {
    return join(mkdtempSync(join(tmpdir(), 'tested-')), 'output')
  }

  it('writes the decision to the step output and prints it', async () => {
    const output = outputIn()
    const lines: string[] = []
    const { git, api } = world()
    const io = { out: (line: string) => lines.push(line), err: () => undefined, env: { GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: output } }
    assert.equal(await run('.', [MERGE], io, git, api), 0)
    assert.equal(readFileSync(output, 'utf8'), 'repository=true\ncovered=["alpha|ubuntu-latest|","beta|ubuntu-latest|2"]\n')
    assert.match(lines.join('\n'), /^tested-tree: skip what run 7 passed/)
  })

  it('runs everything, and still succeeds, without a repository to ask', async () => {
    const output = outputIn()
    const { git, api } = world()
    const io = { out: () => undefined, err: () => undefined, env: { GITHUB_OUTPUT: output } }
    assert.equal(await run('.', [MERGE], io, git, api), 0)
    assert.equal(readFileSync(output, 'utf8'), 'repository=false\ncovered=[]\n')
  })
})
