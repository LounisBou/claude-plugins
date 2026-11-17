// hooks/tests/pr-file.test.ts
// The machine's pull request file: the one query for every repository the records name, its answer
// read, the change log, and the refresh over a faked $: one forge call per interval whatever the
// sessions reading it, a failed call keeping what was read before, a lock another session holds.
import { expect, test } from 'claude-code/testing'
import { changeLines, LOG_KEPT, parsePrAnswer, prQuery, refreshPrFile, reposToRead, trackedPrs, withEnded, withLogLines } from '../pr-file.ts'
import {
  ENDED_KEPT_MS, isFresh, parsePrFile, prFilePath, prLogPath, prsOfRepo, prWantedPath, PR_FILE_INTERVAL_MS, repoOfOrigin, wantedRepos, withWanted, type FilePr, type PrFile,
} from '../pr-file-format.ts'
import { logLineOf, lockRun, prQueryRun } from './fakes.ts'
import { hostOf } from '../../core/capture.ts'

const HOME = '/tmp/pr-file-home'
const STATE = `${HOME}/.claude/claude-orchestrator`
const RECORD = '/briefs/app/dispatch-record.jsonl'
const LIB_RECORD = '/briefs/lib/dispatch-record.jsonl'
const NOW = Date.parse('2026-11-17T16:00:00Z')

const ledger = (repo: string, pr: number) =>
  JSON.stringify({ v: 1, ledger: 'pr', repo, pr, status: 'working', agent: 'Agent: x', since: '2026-11-17T09:00:00Z', updated: '2026-11-17T09:00:00Z' })

function world(forge: Record<string, string | null> = { 'acme/app': JSON.stringify([{ number: 7 }, { number: 9 }]), 'acme/lib': '[]' }) {
  const files = new Map<string, string>([
    [`${STATE}/records/s-one`, `${RECORD}\n`],
    [`${STATE}/records/s-two`, `${RECORD}\n${LIB_RECORD}\n`],
    [RECORD, `${JSON.stringify({ id: 1, state: 'open', label: 'a row' })}\n${ledger('acme/app', 7)}\n${ledger('acme/app', 8)}\n`],
    [LIB_RECORD, `${ledger('acme/lib', 3)}\n`],
  ])
  const calls: string[][] = []
  const logs: string[] = []
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: 1, mtimeMs: Date.now() } },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!); return { exitCode: 0, stdout: '', stderr: '' } }
        if (argv[0] === 'rm') { for (const p of argv.slice(2)) files.delete(p); return { exitCode: 0, stdout: '', stderr: '' } }
        calls.push([...argv])
        return prQueryRun(argv, repo => forge[repo] ?? null, { 'acme/app': { 8: 'CLOSED' } }) ?? { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    },
  })
  const file = (): PrFile | undefined => parsePrFile(files.get(prFilePath(STATE)) ?? '')
  return { dollar, files, calls, logs, file }
}

test('the pull requests the records on the machine name are gathered by repository, every registry read once per record', async () => {
  const { dollar } = world()
  expect([...await trackedPrs(dollar, STATE)]).toEqual([['acme/app', [7, 8]], ['acme/lib', [3]]])
})

test('one query asks every repository its open pull requests and each recorded one by its number, with its checks', () => {
  const query = prQuery(new Map([['acme/app', [7, 8]], ['acme/lib', []]]))
  expect(query.startsWith('query{viewer{login} rateLimit{cost remaining} ')).toBe(true)
  expect(query).toContain('r0:repository(owner:"acme",name:"app"){open:pullRequests(states:OPEN,first:50,orderBy:{field:CREATED_AT,direction:DESC})')
  expect(query).toContain('n7:pullRequest(number:7)')
  expect(query).toContain('n8:pullRequest(number:8)')
  expect(query).toContain('r1:repository(owner:"acme",name:"lib")')
  expect(query.match(/statusCheckRollup/g)?.length).toBe(2)
})

test('the answer keeps every open pull request, the last ones ended, every recorded one and the fork a head comes from; a repository with no data is unread', () => {
  const node = (n: number, state: string, login: string, extra: object = {}) => ({
    number: n, state, isDraft: n === 9, createdAt: 't', headRefName: `b${n}`, headRefOid: 's', mergeable: 'MERGEABLE', author: { login }, labels: { nodes: [{ name: 'Ready' }, {}] }, ...extra,
  })
  const answer = parsePrAnswer(new Map([['acme/app', [8]], ['acme/lib', []]]), JSON.stringify({ data: {
    viewer: { login: 'me' }, rateLimit: { cost: 2 },
    r0: { open: { pageInfo: { hasNextPage: true }, nodes: [node(7, 'OPEN', 'me'), node(9, 'OPEN', 'someone', { isCrossRepository: true, headRepositoryOwner: { login: 'fan' } }), {}] }, ended: { nodes: [node(5, 'CLOSED', 'me')] }, n8: node(8, 'MERGED', 'someone', { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }) },
    r1: null,
  } }))
  expect(answer?.viewer).toBe('me')
  expect(answer?.cost).toBe(2)
  expect(answer?.repos).toEqual(['acme/app'])
  expect(answer?.unread).toEqual(['acme/lib'])
  expect(answer?.truncated).toEqual(['acme/app'])
  const common = { draft: false, sha: 's', createdAt: 't', labels: ['Ready'], mergeable: 'MERGEABLE' }
  expect(answer?.prs).toEqual([
    { repo: 'acme/app', pr: 5, state: 'CLOSED', head: 'b5', author: 'me', fork: null, ...common },
    { repo: 'acme/app', pr: 7, state: 'OPEN', head: 'b7', author: 'me', fork: null, ...common },
    { repo: 'acme/app', pr: 9, state: 'OPEN', head: 'b9', author: 'someone', fork: 'fan', ...common, draft: true },
    { repo: 'acme/app', pr: 8, state: 'MERGED', head: 'b8', author: 'someone', fork: null, ...common, ci: 'none' },
  ])
  expect(parsePrAnswer(new Map(), 'not json')).toBe(undefined)
  expect(parsePrAnswer(new Map(), '{"errors":[{"message":"rate limited"}]}')).toBe(undefined)
  expect(parsePrAnswer(new Map(), '{"data":{"viewer":null}}')).toBe(undefined)
})

const pr = (n: number, state: FilePr['state'], more: Partial<FilePr> = {}): FilePr =>
  ({ repo: 'acme/app', pr: n, state, draft: false, head: `b${n}`, sha: 's', author: 'me', createdAt: null, labels: [], mergeable: null, fork: null, ...more })

test('the change log says each state change once, one line each, and nothing on the first file', () => {
  const before: PrFile = { v: 1, at: 'x', tried: 'x', viewer: 'me', repos: ['acme/app'], unread: [], prs: [pr(7, 'OPEN', { draft: true, ci: 'pending' }), pr(8, 'OPEN'), pr(9, 'OPEN'), pr(10, 'CLOSED')] }
  const after = [pr(7, 'OPEN', { ci: 'success' }), pr(8, 'MERGED'), pr(10, 'OPEN'), pr(11, 'OPEN')]
  expect(changeLines(before, after, ['acme/app'], 'T')).toEqual([
    'T acme/app#7 ready for review', 'T acme/app#7 ci success', 'T acme/app#8 merged', 'T acme/app#10 reopened', 'T acme/app#11 opened', 'T acme/app#9 no longer open',
  ])
  expect(changeLines(before, after, [], 'T')).not.toContain('T acme/app#9 no longer open')
  expect(changeLines(undefined, after, ['acme/app'], 'T')).toEqual([])
  expect(withLogLines('a\nb\n', ['c'])).toBe('a\nb\nc\n')
  expect(withLogLines(Array.from({ length: LOG_KEPT }, (_, i) => `l${i}`).join('\n'), ['last']).split('\n').filter(Boolean).length).toBe(LOG_KEPT)
})

test('the file is fresh within its interval, and one that breaks the shape is none', () => {
  expect(isFresh(undefined, NOW)).toBe(false)
  const at = (iso: string) => parsePrFile(JSON.stringify({ v: 1, tried: iso, prs: [] }))
  expect(isFresh(at('2026-11-17T15:59:30Z'), NOW)).toBe(true)
  expect(isFresh(at('2026-11-17T15:59:00Z'), NOW)).toBe(false)
  expect(parsePrFile('{"v":2,"tried":"t","prs":[]}')).toBe(undefined)
  expect(parsePrFile('nope')).toBe(undefined)
  expect(parsePrFile('{"v":1,"tried":"t","prs":[{"repo":"a/b","pr":0,"state":"OPEN"},{"repo":"a/b","pr":3,"state":"OPEN"}]}')?.prs.map(p => p.pr)).toEqual([3])
})

test('two sessions reading in the same interval make one forge call; past the interval, one more, its changes on the log', async () => {
  const forge: Record<string, string | null> = { 'acme/app': JSON.stringify([{ number: 7 }, { number: 9 }]), 'acme/lib': '[]' }
  const { dollar, calls, file, files } = world(forge)
  await refreshPrFile(dollar, NOW)
  await refreshPrFile(dollar, NOW + 1000)
  expect(calls.length).toBe(1)
  expect(file()?.repos).toEqual(['acme/app', 'acme/lib'])
  expect(file()?.prs.map(p => [p.pr, p.state])).toEqual([[7, 'OPEN'], [9, 'OPEN'], [8, 'CLOSED'], [3, 'MERGED']])
  expect(file()?.cost).toBe(1)
  expect(files.has(prLogPath(STATE))).toBe(false)
  forge['acme/app'] = JSON.stringify([{ number: 7 }])
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(calls.length).toBe(2)
  expect(files.get(prLogPath(STATE))).toBe('2026-11-17T16:01:00Z acme/app#9 no longer open\n')
})

test('a failed call keeps the pull requests read before, says so on the log, and waits a whole interval before the next', async () => {
  const forge: Record<string, string | null> = { 'acme/app': JSON.stringify([{ number: 7 }]), 'acme/lib': '[]' }
  const { dollar, calls, file, files, logs } = world(forge)
  await refreshPrFile(dollar, NOW)
  forge['acme/app'] = null
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(file()?.prs.map(p => p.pr)).toEqual([7, 8, 3])
  expect(file()?.at).toBe('2026-11-17T16:00:00Z')
  expect(file()?.error).toBe('gh exited 1: HTTP 502')
  expect(files.get(prLogPath(STATE))).toBe('2026-11-17T16:01:00Z refresh failed: gh exited 1: HTTP 502\n')
  expect(logs.some(l => l.includes('refresh failed, the file kept: gh exited 1: HTTP 502'))).toBe(true)
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS + 1000)
  expect(calls.length).toBe(2)
})

test('a lock another session holds is its refresh: this one makes no call and logs nothing', async () => {
  const { dollar, calls, files, logs } = world()
  files.set(`${prFilePath(STATE)}.lock`, '1\n')
  await refreshPrFile(dollar, NOW)
  expect(calls).toEqual([])
  expect(logs).toEqual([])
})

test('a machine whose records name no pull request asks the forge nothing', async () => {
  const { dollar, calls, file, files } = world()
  files.delete(RECORD)
  files.delete(LIB_RECORD)
  await refreshPrFile(dollar, NOW)
  expect(calls).toEqual([])
  expect(file()?.repos).toEqual([])
})

test('a query the forge resolves in part is read for the rest: the repository it cannot resolve unread, its errors said once on the log', async () => {
  const forge: Record<string, string | null | undefined> = { 'acme/app': JSON.stringify([{ number: 7 }]), 'acme/lib': undefined }
  const { dollar, file, files } = world(forge as Record<string, string | null>)
  // world maps a missing answer to null; this one answers the unresolved repository as the forge does.
  const run = dollar.process.run
  dollar.process.run = async (argv, init) => prQueryRun(argv, repo => forge[repo], { 'acme/app': { 8: 'CLOSED' } }) ?? run(argv, init)
  await refreshPrFile(dollar, NOW)
  expect(file()?.repos).toEqual(['acme/app'])
  expect(file()?.unread).toEqual(['acme/lib'])
  expect(file()?.error).toBe(undefined)
  expect(file()?.prs.map(p => [p.pr, p.state])).toEqual([[7, 'OPEN'], [8, 'CLOSED']])
  expect(files.get(prLogPath(STATE))).toBe("2026-11-17T16:00:00Z read in part: gh exited 1: gh: Could not resolve to a Repository with the name 'acme/lib'.\n")
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(files.get(prLogPath(STATE))?.split('\n').filter(Boolean).length).toBe(1)
})

test('a pull request seen ended is stamped when first seen so, kept a week in the repositories read, then dropped', () => {
  const at = '2026-11-17T16:00:00Z'
  const before: PrFile = { v: 1, at, tried: at, viewer: 'me', repos: ['acme/app', 'acme/lib'], unread: [], prs: [
    pr(3, 'MERGED', { ended: '2026-11-15T00:00:00Z' }), pr(4, 'CLOSED', { ended: '2026-11-01T00:00:00Z' }), pr(6, 'MERGED', { repo: 'acme/lib', ended: '2026-11-15T00:00:00Z' }), pr(7, 'OPEN'),
  ] }
  const next = withEnded(before, [pr(7, 'MERGED'), pr(8, 'OPEN')], ['acme/app'], NOW, 'T')
  expect(next.map(p => [p.repo, p.pr, p.state, p.ended])).toEqual([
    ['acme/app', 7, 'MERGED', 'T'], ['acme/app', 8, 'OPEN', undefined], ['acme/app', 3, 'MERGED', '2026-11-15T00:00:00Z'],
  ])
  expect(withEnded(undefined, [pr(3, 'CLOSED')], ['acme/app'], NOW, 'T')[0]?.ended).toBe('T')
  expect(ENDED_KEPT_MS).toBe(7 * 24 * 3600 * 1000)
})

test('the repositories the checkouts want are read beside the records\', each wanted a week after it was last asked', async () => {
  const { dollar, files } = world()
  files.set(prWantedPath(STATE), withWanted('acme/old 2026-11-01T00:00:00.000Z\nacme/app 2026-11-17T00:00:00.000Z\n', ['acme/web'], NOW))
  expect(wantedRepos(files.get(prWantedPath(STATE)) ?? '', NOW)).toEqual(['acme/app', 'acme/web'])
  expect([...await reposToRead(dollar, STATE, NOW)]).toEqual([['acme/app', [7, 8]], ['acme/lib', [3]], ['acme/web', []]])
  expect(wantedRepos('not a repo 2026-11-17T00:00:00Z\nacme/x never\n', NOW)).toEqual([])
})

test('a GitHub origin names its repository in every form; the file answers for a repository only when its reading is current', () => {
  for (const url of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app', 'https://user@github.com/acme/app/']) expect(repoOfOrigin(url)).toBe('acme/app')
  expect(repoOfOrigin('https://gitlab.com/acme/app.git')).toBe(undefined)
  const file: PrFile = { v: 1, at: 'x', tried: 'x', viewer: 'me', repos: ['acme/app'], unread: [], prs: [pr(7, 'OPEN'), pr(1, 'OPEN', { repo: 'acme/lib' })] }
  expect(prsOfRepo(file, 'acme/app')?.map(p => p.pr)).toEqual([7])
  expect(prsOfRepo(file, 'acme/lib')).toBe(undefined)
  expect(prsOfRepo({ ...file, error: 'down' }, 'acme/app')).toBe(undefined)
  expect(prsOfRepo(undefined, 'acme/app')).toBe(undefined)
})

test('a file that cannot be written after the call still holds its try: a reader within the interval makes no second call', async () => {
  const { dollar, calls, file } = world()
  const run = dollar.process.run
  // The file written after the call does not land.
  dollar.process.run = async (argv, init) => {
    if (argv[0] === 'mv' && argv[3] === prFilePath(STATE) && calls.length > 0) return { exitCode: 1, stdout: '', stderr: 'disk full' }
    return run(argv, init)
  }
  await refreshPrFile(dollar, NOW)
  expect(calls.length).toBe(1)
  expect(file()?.tried).toBe('2026-11-17T16:00:00Z')
  await refreshPrFile(dollar, NOW + 1000)
  expect(calls.length).toBe(1)
})

test('a file that cannot be written makes no call, and says so on the log', async () => {
  const { dollar, calls, logs } = world()
  const run = dollar.process.run
  dollar.process.run = async (argv, init) => (argv[0] === 'mv' && argv[3] === prFilePath(STATE) ? { exitCode: 1, stdout: '', stderr: 'read-only' } : run(argv, init))
  await refreshPrFile(dollar, NOW)
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(calls).toEqual([])
  expect(logs.filter(l => l.includes('refresh failed') && l.includes('read-only')).length).toBe(2)
})

test('no pull request is said gone from an open list that ran past its page', async () => {
  const forge: Record<string, string | null> = { 'acme/app': JSON.stringify([{ number: 7 }, { number: 9 }]), 'acme/lib': '[]' }
  const { dollar, calls, files } = world(forge)
  await refreshPrFile(dollar, NOW)
  // The page now runs past 50: #9 is beyond it, not gone.
  forge['acme/app'] = JSON.stringify([{ number: 7 }])
  const run = dollar.process.run
  dollar.process.run = async (argv, init) => {
    const ran = await run(argv, init)
    return argv[0] === 'gh' ? { ...ran, stdout: String(ran.stdout).replace('"pageInfo":{"hasNextPage":false}', '"pageInfo":{"hasNextPage":true}') } : ran
  }
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(calls.length).toBe(2)
  expect(files.get(prLogPath(STATE))).toBe('2026-11-17T16:01:00Z acme/app open past 50: the rest unread\n')
})

test('two sessions refreshing at once make one forge call: the lock holds the second off', async () => {
  const { dollar, calls, file } = world()
  await Promise.all([refreshPrFile(dollar, NOW), refreshPrFile(dollar, NOW)])
  expect(calls.length).toBe(1)
  expect(file()?.repos).toEqual(['acme/app', 'acme/lib'])
})

test('a refresh another session made between the read and the lock counts: read again under the lock, no call', async () => {
  const { dollar, calls, files } = world()
  const run = dollar.process.run
  // The other session's refresh lands just before this one takes the lock.
  dollar.process.run = async (argv, init) => {
    if (lockRun(argv, new Map()) !== null) files.set(prFilePath(STATE), `${JSON.stringify({ v: 1, at: 'x', tried: '2026-11-17T16:00:00Z', prs: [] })}\n`)
    return run(argv, init)
  }
  await refreshPrFile(dollar, NOW + 1000)
  expect(calls).toEqual([])
})

test('a file read before whose next write fails after the call keeps its pull requests and its new try: no second call within the interval', async () => {
  const { dollar, calls, file } = world()
  await refreshPrFile(dollar, NOW)
  const run = dollar.process.run
  dollar.process.run = async (argv, init) => {
    if (argv[0] === 'mv' && argv[3] === prFilePath(STATE) && calls.length > 1) return { exitCode: 1, stdout: '', stderr: 'disk full' }
    return run(argv, init)
  }
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS)
  expect(calls.length).toBe(2)
  expect(file()?.tried).toBe('2026-11-17T16:01:00Z')
  expect(file()?.at).toBe('2026-11-17T16:00:00Z')
  expect(file()?.prs.length).toBeGreaterThan(0)
  await refreshPrFile(dollar, NOW + PR_FILE_INTERVAL_MS + 1000)
  expect(calls.length).toBe(2)
})
