// Stand-ins for the model, so the harness runs end to end without spending: an agent that
// leaves the merged result (the oracle), one that leaves nothing, a meter that reads what a
// stub reports, and a judge that decides from the files touched. The dry run and the tests use
// them; a real run never does.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent, Judge, Meter } from './harness.ts'
import { overlap } from './harness.ts'

const run = promisify(execFile)

/** Leaves the merged pull request's tree in the arm's checkout, committed. */
export function oracleAgent(): Agent {
  return {
    async run({ case: task, dir }) {
      await run('git', ['-C', dir, 'read-tree', '--reset', '-u', task.merge])
      await run('git', ['-C', dir, '-c', 'user.name=oracle', '-c', 'user.email=oracle@invalid', 'commit', '--quiet', '--no-verify', '-m', 'oracle'])
      return { costUsd: 0, error: null }
    },
  }
}

/** Changes nothing. */
export function idleAgent(): Agent {
  return {
    async run() {
      return { costUsd: 0, error: null }
    },
  }
}

/** Reads nothing: every arm costs what its agent reports. */
export function silentMeter(): Meter {
  return {
    async start() {
      return { spent: async () => 0 }
    },
  }
}

/** The intent matches when the change touches at least half the reference's files; no finding. */
export function filesJudge(): Judge {
  return {
    async intent({ diff, reference }) {
      const share = overlap(diff.files, reference.files)
      return { costUsd: 0, verdict: { matches: share >= 0.5, reason: `the change shares ${share.toFixed(2)} of its files with the reference` }, error: null }
    },
    async review() {
      return { costUsd: 0, verdict: { findings: [] }, error: null }
    },
  }
}

