// The ready guard's pure decisions: which command is an act, which push moves
// which branch, and what a pull request misses at its head.
import { expect, test } from 'claude-code/testing'
import {
  bashActs, bashLabellings, bashPushes, ciUndraft, createdPr, gateReadyLine, missingItems, parseGate, reviewAccepted, pushOf, toolAct, toolLabelling, touchesRecords, onlyReads, writesRecords,
  recordKindFor, producerSlug, kindRefusal, RECORDS_REFUSAL, autoMergeRefusal, notReadyRefusal, labelMove, leaveDraftRefusal,
  type Gate, type RecordFile,
} from './ready.ts'
import { acceptanceDetail, producersOf } from '../core/pr-record.ts'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

function gate(over: Partial<Gate> = {}, ci: Partial<Gate['ci']> = {}): Gate {
  return {
    repo: 'acme/thing', pr: 12, state: 'open', draft: false, head: HEAD, labels: ['Not Ready'],
    ci: { result: 'SUCCESS', failed: [], running: 0, skipped: [], total: 1, ...ci },
    ...over,
  }
}

function record(kind: string, result: string, at = '2026-11-01T10:00:00Z', over: Record<string, unknown> = {}): RecordFile {
  const stamp = at.replace(/[-:]/g, '')
  const body = { v: 1, repo: 'acme/thing', pr: 12, head: HEAD, kind, result, producer: 'p-' + kind, detail: '', session: '', at, ...over }
  return { name: kind + '.' + stamp + '.p-' + kind + '.json', text: JSON.stringify(body) }
}

const ALL = [record('review', 'pass'), record('norms', 'pass'), record('e2e', 'pass')]

test('the three at the head leave nothing missing', () => {
  expect(missingItems(gate(), ALL)).toEqual([])
})

// Norms is on demand: no norms record at the head is not missing, a failed one still is (below).
test('a pull request with no norms record at its head is ready on the rest', () => {
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('norms')))).toEqual([])
})

test('each missing condition is named alone', () => {
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('review')))).toEqual(['review: no record at 0123456'])
  expect(missingItems(gate(), ALL.filter((r) => !r.name.startsWith('e2e')))).toEqual(['e2e: no record at 0123456'])
  expect(missingItems(gate({}, { result: 'FAILURE', failed: ['lint', 'test'] }), ALL)).toEqual(['CI failed: lint, test'])
  expect(missingItems(gate({}, { result: 'PENDING', running: 1 }), ALL)).toEqual(['CI still running'])
})

test('a later fail overrides an earlier pass, and names its producer and detail', () => {
  const files = [...ALL, record('norms', 'fail', '2026-11-01T11:00:00Z', { producer: 'norms', detail: '2 findings open' })]
  expect(missingItems(gate(), files)).toEqual(['norms: fail at 0123456 by norms, 2 findings open'])
  const back = [...files, record('norms', 'pass', '2026-11-01T12:00:00Z')]
  expect(missingItems(gate(), back)).toEqual([])
})

test('an e2e waiver is accepted, a waived review is not', () => {
  const waived = [record('review', 'pass'), record('norms', 'pass'), record('e2e', 'waived', undefined, { detail: 'waived 2026-11-02' })]
  expect(missingItems(gate(), waived)).toEqual([])
  const review = [record('review', 'waived'), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), review)).toEqual(['review: waived at 0123456 by p-review'])
})

// A failed review, then the orchestrator's acceptance with the points it set aside, with norms and E2E passed.
const FAILED = record('review', 'fail', '2026-11-01T11:00:00Z', { producer: 'pr-review', detail: '2 Important' })
const SET_ASIDE = acceptanceDetail([{ point: 'a.ts:3', reason: 'out of scope' }])
const accepted = (at = '2026-11-01T12:00:00Z') => record('review', 'accepted', at, { producer: 'orchestrator', detail: SET_ASIDE })
const PASSED_OTHERS = [record('norms', 'pass'), record('e2e', 'pass')]

test('the orchestrator\'s acceptance passes the review over a failed one or on its own, and the gate names it', () => {
  for (const files of [[FAILED, accepted(), ...PASSED_OTHERS], [accepted(), ...PASSED_OTHERS]]) {
    expect(missingItems(gate(), files)).toEqual([])
    expect(reviewAccepted(gate(), files)).toBe(SET_ASIDE)
  }
  expect(gateReadyLine('acme/thing', 12, HEAD, false, SET_ASIDE))
    .toBe('github: acme/thing#12 Ready at 0123456: review accepted by the orchestrator (' + SET_ASIDE
      + '), passed E2E and green CI hold at its head.')
  expect(reviewAccepted(gate(), ALL)).toBeUndefined()
})

test('a later failed review overrides an acceptance', () => {
  const later = [accepted(), record('review', 'fail', '2026-11-01T13:00:00Z'), ...PASSED_OTHERS]
  expect(missingItems(gate(), later)[0]).toContain('review: fail at 0123456')
  expect(reviewAccepted(gate(), later)).toBeUndefined()
})

test('a record of another head, repository or pull request is skipped and named', () => {
  const files = [
    record('review', 'pass', undefined, { head: OTHER }), record('norms', 'pass'), record('e2e', 'pass'),
  ]
  expect(missingItems(gate(), files)).toEqual(['review: no record at 0123456', 'unreadable record ' + files[0].name])
  const pr = [record('review', 'pass', undefined, { pr: 13 }), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), pr)[1]).toBe('unreadable record ' + pr[0].name)
  const repo = [record('review', 'pass', undefined, { repo: 'acme/other' }), record('norms', 'pass'), record('e2e', 'pass')]
  expect(missingItems(gate(), repo)[1]).toBe('unreadable record ' + repo[0].name)
})

test('a file that does not parse, or names another kind than its file, is named', () => {
  const noE2e = ALL.filter((r) => !r.name.startsWith('e2e'))
  const files = [...noE2e, { name: 'review.20261101T120000Z.x.json', text: '{not json' }]
  expect(missingItems(gate(), files)).toEqual(['e2e: no record at 0123456', 'unreadable record review.20261101T120000Z.x.json'])
  const misnamed = { name: 'norms.20261101T120000Z.x.json', text: record('review', 'fail').text }
  expect(missingItems(gate(), [...noE2e, misnamed])).toEqual(['e2e: no record at 0123456', 'unreadable record norms.20261101T120000Z.x.json'])
})

test('an unreadable file beside the three accepted records does not block', () => {
  const bad = { name: 'review.20261101T120000Z.x.json', text: '{not json' }
  expect(missingItems(gate(), [...ALL, bad])).toEqual([])
})

test('an unreadable file is named when a kind is missing too', () => {
  const bad = { name: 'e2e.20261101T120000Z.x.json', text: '{not json' }
  const files = [...ALL.filter((r) => !r.name.startsWith('e2e')), bad]
  expect(missingItems(gate(), files)).toEqual(['e2e: no record at 0123456', 'unreadable record ' + bad.name])
  expect(notReadyRefusal('pr-merge', 'acme/thing', 12, HEAD, missingItems(gate(), files)))
    .toContain('Missing: e2e: no record at 0123456, unreadable record ' + bad.name + '.')
})

test('no check at all is not green: CI has not started', () => {
  expect(missingItems(gate({}, { result: 'PENDING', total: 0, running: 0 }), ALL)).toEqual(['CI still running'])
})

test('a skipped check is not green, and says so', () => {
  expect(missingItems(gate({}, { result: 'PENDING', skipped: ['test'], running: 0 }), ALL)).toEqual(['CI did not run: test skipped'])
})

test('the gate\'s share leaves CI to GitHub, which holds it as a required check', () => {
  const red = gate({}, { result: 'FAILURE', failed: ['lint'] })
  expect(missingItems(red, ALL, undefined, {}, [], 'gate')).toEqual([])
  expect(missingItems(red, ALL, undefined, {}, [], 'github')).toEqual(['CI failed: lint'])
  const noReview = ALL.filter((r) => !r.name.startsWith('review'))
  expect(missingItems(red, noReview, undefined, {}, [], 'gate')).toEqual(['review: no record at 0123456'])
  expect(missingItems(red, noReview, undefined, {}, [], 'github')).toEqual(['CI failed: lint'])
  expect(missingItems(gate({ state: 'closed' }, { result: 'PENDING', running: 1 }), ALL, undefined, {}, [], 'gate')).toEqual(['the pull request is closed'])
})

test('a closed pull request and a moved head are named first', () => {
  expect(missingItems(gate({ state: 'closed' }), ALL)).toEqual(['the pull request is closed'])
  expect(missingItems(gate(), ALL, OTHER)).toEqual(['the head moved: ' + OTHER + ' given, ' + HEAD + ' on GitHub'])
  expect(missingItems(gate(), ALL, HEAD.toUpperCase())).toEqual([])
})

test('pr-gate\'s answer is read, a malformed one throws', () => {
  expect(parseGate(JSON.stringify(gate())).head).toBe(HEAD)
  expect(() => parseGate('ok')).toThrow()
  expect(() => parseGate('{"head": "abc"}')).toThrow()
})

test('a CI undraft is a Not Ready pull request none of whose checks has passed yet', () => {
  expect(ciUndraft(gate({}, { result: 'PENDING', running: 1 }))).toBe(true)
  expect(ciUndraft(gate({}, { result: 'PENDING', skipped: ['test'] }))).toBe(true)
  expect(ciUndraft(gate({}, { result: 'FAILURE', failed: ['guard'] }))).toBe(true)
  expect(ciUndraft(gate({ labels: ['not ready'] }, { result: 'PENDING', running: 1 }))).toBe(true)
  expect(ciUndraft(gate())).toBe(false)
  expect(ciUndraft(gate({ labels: [] }, { result: 'PENDING', running: 1 }))).toBe(false)
  expect(ciUndraft(gate({ labels: ['Ready'] }, { result: 'PENDING', running: 1 }))).toBe(false)
  // A check of the head already passed: its CI ran, and a red one is no reason to leave draft.
  expect(ciUndraft(gate({}, { result: 'FAILURE', failed: ['test'], total: 2 }))).toBe(false)
  expect(ciUndraft(gate({}, { result: 'PENDING', running: 1, total: 2 }))).toBe(false)
})

test('the Bash merges and undrafts are recognised with their repository and pull request', () => {
  expect(bashActs('gh pr merge 12 -R o/r --squash')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr merge https://github.com/o/r/pull/12')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr merge 12 --repo=o/r --auto --match-head-commit ' + HEAD))
    .toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12, sha: HEAD }])
  expect(bashActs('gh -R github.com/o/r pr ready 3')).toEqual([{ kind: 'undraft', name: 'gh pr ready', repo: 'o/r', pr: 3 }])
  expect(bashActs('gh pr ready feat -R o/r')).toEqual([{ kind: 'undraft', name: 'gh pr ready', repo: 'o/r', branch: 'feat' }])
  expect(bashActs('gh pr ready')).toEqual([{ kind: 'undraft', name: 'gh pr ready' }])
  expect(bashActs('gh api -X PUT repos/o/r/pulls/12/merge')).toEqual([{ kind: 'merge', name: 'gh api', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh api graphql -f query=\'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}\''))
    .toEqual([{ kind: 'merge', name: 'gh api graphql', unnamed: true }])
  expect(bashActs('gh api graphql -f query=\'mutation{markPullRequestReadyForReview(input:{}){clientMutationId}}\'')[0].kind).toBe('undraft')
  expect(bashActs('gh api graphql -f query=\'mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}\'')[0].kind).toBe('merge')
  expect(bashActs('gh pr create -t t -b b')).toEqual([{ kind: 'create', name: 'gh pr create' }])
  expect(bashActs('gh pr create -d -t t -R o/r')).toEqual([{ kind: 'create-draft', name: 'gh pr create', repo: 'o/r' }])
  expect(bashActs('gh pr create --draft --label Ready')[0].kind).toBe('create-draft')
  expect(bashActs('gh pr ready 3 -R o/r --undo')).toEqual([{ kind: 'redraft', name: 'gh pr ready', repo: 'o/r', pr: 3 }])
})

test('a gh api merge whose pull request or repository is a shell expansion is an unreadable merge', () => {
  const unreadable = [{ kind: 'merge', name: 'gh api', unreadable: true }]
  for (const line of [
    'gh api repos/o/r/pulls/$PR/merge -X PUT',
    'gh api repos/o/r/pulls/${PR}/merge -X PUT',
    'gh api repos/$REPO/pulls/12/merge -X PUT',
    'gh api repos/o/r/pulls/$(gh pr list -q .[0].number)/merge -X POST',
    'gh api "repos/o/r/pulls/$(echo 12)/merge" -X POST',
    'gh api repos/o/r/pulls/$PR/merge -f merge_method=squash',
  ]) {
    expect(bashActs(line), line).toEqual(unreadable)
  }
  // A read, or another endpoint, is no merge.
  expect(bashActs('gh api repos/o/r/pulls/$PR/merge')).toEqual([])
  expect(bashActs('gh api repos/o/r/pulls/$PR/files -X POST')).toEqual([])
})

test('a merge or an undraft whose pull request is a command substitution is unreadable, never the current branch\'s', () => {
  const at = (kind: string, name: string, extra = {}) => [{ kind, name, repo: 'o/r', unreadable: true, ...extra }]
  expect(bashActs('gh pr merge $(gh pr list -q .[0].number) -R o/r')).toEqual(at('merge', 'gh pr merge'))
  expect(bashActs('gh pr merge `gh pr list -q .[0].number` -R o/r')).toEqual(at('merge', 'gh pr merge'))
  expect(bashActs('gh pr merge "$(cat number)" -R o/r')).toEqual(at('merge', 'gh pr merge', { branch: '' }))
  expect(bashActs('gh pr ready $(cat number) -R o/r')).toEqual(at('undraft', 'gh pr ready'))
  expect(bashActs('bash -c "gh pr merge \\$(cat number) -R o/r"')).toEqual(at('merge', 'gh pr merge'))
  // A substitution elsewhere in the line leaves a number the line shows readable.
  expect(bashActs('gh pr merge 12 -R o/r --body "$(cat body)"')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 12 }])
  expect(bashActs('gh pr merge -R o/r')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r' }])
})

test('gh pr ready --undo is read as gh reads a boolean flag: =false leaves draft', () => {
  expect(bashActs('gh pr ready 3 -R o/r --undo')[0].kind).toBe('redraft')
  expect(bashActs('gh pr ready 3 -R o/r --undo=true')[0].kind).toBe('redraft')
  expect(bashActs('gh pr ready 3 -R o/r --undo=false')).toEqual([{ kind: 'undraft', name: 'gh pr ready', repo: 'o/r', pr: 3 }])
  expect(bashActs('gh pr ready 3 -R o/r --undo --undo=0')[0].kind).toBe('undraft')
})

test('a GraphQL query the line does not show is an unread act, on every spelling of the endpoint', () => {
  const opaque = [{ kind: 'undraft', name: 'gh api graphql', unnamed: true, opaque: true }]
  for (const line of [
    'gh api graphql -F query=@mutation.graphql',
    'gh api /graphql --input body.json',
    'gh api https://api.github.com/graphql -f query="$Q"',
    'gh api graphql -f query="mutation { ${OP} }"',
    'gh api graphql -f query="$(cat q.graphql)"',
    'gh api graphql -F owner=o',
  ]) {
    expect(bashActs(line), line).toEqual(opaque)
  }
  for (const endpoint of ['graphql', '/graphql', 'https://api.github.com/graphql']) {
    expect(bashActs('gh api ' + endpoint + ' -f query=\'mutation{markPullRequestReadyForReview(input:{}){clientMutationId}}\''), endpoint)
      .toEqual([{ kind: 'undraft', name: 'gh api graphql', unnamed: true }])
  }
  // A variable the query declares is GraphQL's, not the shell's: the query is read.
  expect(bashActs('gh api graphql -F id=x -f query=\'query($id: ID!){node(id: $id){id}}\'')).toEqual([])
})

test('a Ready label put by hand is no act, on any route: the gate alone decides readiness', () => {
  for (const line of [
    'gh pr edit 12 -R o/r --add-label Ready',
    'gh issue edit 12 -R o/r --add-label bug,ready',
    'gh api --method POST repos/o/r/issues/12/labels -f \'labels[]=Ready\'',
    'python3 /p/engine/gh.py --repo o/r label-add 12 Ready',
    'python3 /p/engine/gh.py --repo o/r pr-readiness 12 ready',
    'gh api -X PATCH repos/o/r/issues/12 -f \'labels[]=Ready\'',
    'gh api --method PATCH repos/o/r/pulls/12 -f labels=\'["Ready"]\'',
    'gh api -X PATCH https://api.github.com/repos/o/r/issues/12 -f \'labels[]=Ready\'',
    'gh api -X PATCH repos/o/r/issues/12 --input body.json',
    'gh api https://api.github.com/repos/o/r/issues/12/labels -f labels=\'["bug","Ready"]\'',
    'gh api repos/o/r/issues/12/labels --input labels.json',
  ]) {
    expect(bashActs(line), line).toEqual([])
  }
  expect(toolAct('pr-readiness', { pr: 3, state: 'ready' })).toBeUndefined()
  expect(toolAct('label-add', { pr: 3, label: ['bug', 'READY'] })).toBeUndefined()
})

test('the engine fed on stdin from Bash is an act of its own, its request unread', () => {
  expect(bashActs('printf %s "$REQ" | python3 /p/engine/gh.py --stdin-json'))
    .toEqual([{ kind: 'merge', name: 'gh.py --stdin-json', stdin: true }])
  expect(bashActs('python3 /p/engine/gh.py --repo o/r pr-merge 12 -- --stdin-json')[0].kind).toBe('merge')
})

test('gh pr create --draft=false and --draft=0 open a pull request out of draft, --draft=true and a bare --draft a draft', () => {
  expect(bashActs('gh pr create --draft=false -t t')).toEqual([{ kind: 'create', name: 'gh pr create' }])
  expect(bashActs('gh pr create --draft=0 -t t -R o/r')).toEqual([{ kind: 'create', name: 'gh pr create', repo: 'o/r' }])
  expect(bashActs('gh pr create --draft=true -t t')).toEqual([{ kind: 'create-draft', name: 'gh pr create' }])
  expect(bashActs('gh pr create --draft -t t')).toEqual([{ kind: 'create-draft', name: 'gh pr create' }])
})

test('what only looks like an act is none', () => {
  for (const line of [
    'gh pr merge 12 -R o/r --disable-auto',
    'git commit -m "run gh pr merge later"',
    'echo gh pr ready 3',
    'gh pr edit 12 -R o/r --add-label "Not Ready"',
    'gh pr edit 12 -R o/r --remove-label Ready',
    'gh pr edit 12 -R o/r --title Ready',
    'gh api repos/o/r/pulls/12/merge',
    'gh api -X POST repos/o/r/issues/12/labels -f labels[]=bug',
    'gh api graphql -f query=\'query{viewer{login}}\'',
    'gh pr view 12',
    'cat <<EOF\ngh pr merge 1\nEOF',
  ]) {
    expect(bashActs(line), line).toEqual([])
  }
})

test('a text quoting a gh.py act is no act', () => {
  for (const line of [
    'echo "python3 engine/gh.py pr-merge 12 --repo o/r"',
    'cat <<EOF\npython3 engine/gh.py pr-merge 12 --repo o/r\nEOF',
    'git commit -m "stop running python3 engine/gh.py pr-merge 12 twice"',
    'gh pr comment 3 -b "run python3 engine/gh.py pr-ready 12 --repo o/r later"',
    'printf %s "python3 engine/gh.py label-add 12 Ready" > note.txt',
  ]) {
    expect(bashActs(line), line).toEqual([])
  }
})

test('an act inside bash -c is recognised', () => {
  expect(bashActs('bash -c \'gh pr merge 1 -R o/r\'')).toEqual([{ kind: 'merge', name: 'gh pr merge', repo: 'o/r', pr: 1 }])
})

test('the tool\'s acts are recognised', () => {
  expect(toolAct('pr-ready', { pr: 3 })).toEqual({ kind: 'undraft', name: 'pr-ready', pr: 3 })
  expect(toolAct('pr-merge', { pr: 3, sha: HEAD })).toEqual({ kind: 'merge', name: 'pr-merge', pr: 3, sha: HEAD })
  expect(toolAct('pr-readiness', { pr: 3, state: 'not-ready' })).toBeUndefined()
  expect(toolAct('label-add', { pr: 3, label: ['bug'] })).toBeUndefined()
  expect(toolAct('pr-create', { title: 't', draft: false })?.kind).toBe('create')
  expect(toolAct('pr-create', { title: 't', draft: true })?.kind).toBe('create-draft')
  expect(toolAct('pr-draft', { pr: 3 })?.kind).toBe('redraft')
  expect(toolAct('pr-comment', { pr: 3, body: 'Ready' })).toBeUndefined()
})

test('a push names its remote and the branches it moves', () => {
  expect(pushOf(['git', 'push', 'origin', 'feat'])).toEqual({ remote: 'origin', branches: ['feat'] })
  expect(pushOf(['git', 'push', 'https://github.com/o/r.git', 'HEAD:feat'])).toEqual({ remote: 'https://github.com/o/r.git', branches: ['feat'] })
  expect(pushOf(['git', 'push', '-u', 'origin', '+a:refs/heads/b', 'c'])).toEqual({ remote: 'origin', branches: ['b', 'c'] })
  expect(pushOf(['git', 'push', 'origin', 'HEAD'])).toEqual({ remote: 'origin', branches: [], current: 'branch' })
  expect(pushOf(['git', 'push', 'origin'])).toEqual({ remote: 'origin', branches: [], current: 'branch' })
  expect(pushOf(['git', 'push'])).toEqual({ branches: [], current: 'upstream' })
  expect(pushOf(['git', 'push', 'origin', ':gone'])).toEqual({ remote: 'origin', branches: [] })
  expect(pushOf(['git', 'push', '--tags', 'origin'])?.unsure).toContain('--tags')
  expect(pushOf(['git', '-C', '/x', 'push', 'origin', 'feat'])?.unsure).toContain('another checkout')
  expect(pushOf(['git', 'commit', '-m', 'push'])).toBeUndefined()
  expect(bashPushes('cd /x && git push origin feat').moves).toBe(true)
  expect(bashPushes('git push origin feat').pushes.length).toBe(1)
})

test('the pull request gh pr create printed is read from its URL', () => {
  expect(createdPr('https://github.com/o/r/pull/7\n')).toEqual({ repo: 'o/r', pr: 7 })
  expect(createdPr('Creating pull request\nhttps://github.com/o/r/pull/7')).toEqual({ repo: 'o/r', pr: 7 })
  expect(createdPr('nothing')).toBeUndefined()
})

test('a command naming the records or their writer is caught', () => {
  expect(touchesRecords('echo x > ~/.claude/pr-records/o/r/x.json')).toBe(true)
  expect(touchesRecords('python3 /p/engine/record.py --repo o/r')).toBe(true)
  expect(touchesRecords('ls ~/.claude/pr-records')).toBe(true)
  expect(touchesRecords('cat /cfg/records/x', '/cfg/records')).toBe(true)
  expect(touchesRecords('git status')).toBe(false)
})

test('a line of read-only commands without a redirection only reads', () => {
  for (const line of ['ls /d', 'cat /d/x | jq . | wc -l', 'grep -rn a /d 2>/dev/null', 'find /d -name "*.json"', 'cd /d && ls', 'echo x', 'ls /d | xargs cat']) {
    expect(onlyReads(line), line).toBe(true)
  }
  for (const line of [
    'rm /d/x', 'cat /d/x > /tmp/y', 'cat /d/x >> /tmp/y', 'tee /d/x', 'sed -i s/a/b/ /d/x', 'cp a /d/x', 'mv a /d/x', 'touch /d/x',
    'find /d -delete', 'find /d -exec rm {} +', 'find /d -fprint /d/x', 'ls /d | xargs rm', 'cd /d && rm x', 'bash -c "ls /d"',
    'python3 w.py', 'ls /d; rm x', 'echo $(rm /d/x)',
  ]) {
    expect(onlyReads(line), line).toBe(false)
  }
})

test('a line the shell reader cannot read is no read', () => {
  expect(onlyReads('ls {1..9}{1..9}{1..9}{1..9}')).toBe(false)
})

test('the records guard refuses a write into the records or their writer, never a read', () => {
  expect(writesRecords('ls ~/.claude/pr-records/o/r/' + HEAD + '/')).toBe(false)
  expect(writesRecords('cat /cfg/records/x | jq .', '/cfg/records')).toBe(false)
  expect(writesRecords('rm ~/.claude/pr-records/x')).toBe(true)
  expect(writesRecords('echo x > ~/.claude/pr-records/o/r/x.json')).toBe(true)
  expect(writesRecords('python3 /p/engine/record.py --repo o/r')).toBe(true)
  expect(writesRecords('git status')).toBe(false)
})

test('each producer plugin writes only its own kind, every other caller E2E', () => {
  expect(recordKindFor('pr-review')).toBe('review')
  expect(recordKindFor('orchestrator')).toBe('review')
  expect(recordKindFor('norms')).toBe('norms')
  expect(recordKindFor('engine')).toBe('e2e')
  expect(producerSlug('engine')).toBe('session-e2e')
  expect(producerSlug('pr-review')).toBe('pr-review')
})

test('the records refusals name only the producers the record contract declares', () => {
  for (const kind of ['review', 'norms']) {
    for (const producer of producersOf(kind)) {
      expect(RECORDS_REFUSAL).not.toContain(producer.plugin)
      expect(kindRefusal(kind, 'engine', 'e2e')).toContain(producer.plugin + ', ' + producer.tool)
    }
  }
  expect(kindRefusal('e2e', 'pr-review', 'review')).toBe('github: e2e records are written by their producer: pr-review writes review only.')
})

test('the refusals read as the guard documents them', () => {
  expect(notReadyRefusal('pr-merge', 'o/r', 12, HEAD, ['review: no record at 0123456', 'CI still running'])).toBe(
    'github: pr-merge refused on o/r#12 at 0123456: not ready. Missing: review: no record at 0123456, CI still running.'
    + ' What Ready needs is core\'s readiness contract (core/readiness.ts).')
  expect(autoMergeRefusal('merge', 'o/r', 12)).toBe(
    'github: gh pr merge refused on o/r: this repository is not in auto-merge, so a merge needs the'
    + ' operator\'s explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": 12} on o/r: it checks that'
    + ' the pull request is ready, then asks them in the conversation.')
})

test('leaving draft outside auto-merge is refused with one line, the same for each route', () => {
  expect(leaveDraftRefusal('pr-ready', 'o/r', 12)).toBe(
    'github: pr-ready refused on o/r: outside auto-merge, leaving draft is the operator\'s, on GitHub after their review,'
    + ' and Ready is put by the gate once the pull request is ready (pr-readiness {"pr": 12, "state": "ready"} reads them now).')
  expect(autoMergeRefusal('undraft', 'o/r', 12)).toBe(leaveDraftRefusal('gh pr ready', 'o/r', 12))
  expect(autoMergeRefusal('create', 'o/r')).toBe(leaveDraftRefusal('gh pr create', 'o/r'))
  expect(autoMergeRefusal('undraft', 'o/r', 12, 'gh.py pr-ready')).toBe(leaveDraftRefusal('gh.py pr-ready', 'o/r', 12))
})

test('the gate moves the label: Ready when the three hold, Not Ready back when Ready no longer holds', () => {
  expect(labelMove(gate(), [])).toBe('ready')
  expect(labelMove(gate({ labels: ['Ready'] }), [])).toBeUndefined()
  expect(labelMove(gate({ labels: ['Ready', 'Not Ready'] }), [])).toBe('ready')
  expect(labelMove(gate({ labels: [] }), [])).toBe('ready')
  expect(labelMove(gate({ labels: ['ready'] }), ['CI still running'])).toBe('not-ready')
  expect(labelMove(gate(), ['CI still running'])).toBeUndefined()
  // A closed or merged pull request keeps its labels.
  expect(labelMove(gate({ state: 'merged' }), [])).toBeUndefined()
  expect(labelMove(gate({ state: 'closed', labels: ['Ready'] }), ['the pull request is closed'])).toBeUndefined()
})

test('the labels a command puts on, takes off, renames or deletes are read with their repository', () => {
  expect(bashLabellings('gh pr edit 12 -R o/r --add-label a,b --remove-label c')).toEqual([{ name: 'gh pr edit', repo: 'o/r', labels: ['a', 'b', 'c'] }])
  expect(bashLabellings('gh issue create -l a')).toEqual([{ name: 'gh issue create', labels: ['a'] }])
  expect(bashLabellings('gh label edit old -R o/r --name new')).toEqual([{ name: 'gh label edit', repo: 'o/r', labels: ['old', 'new'] }])
  expect(bashLabellings('gh label clone src/x -R o/r')).toEqual([{ name: 'gh label clone', repo: 'o/r', labels: [], opaque: true }])
  expect(bashLabellings('python3 engine/gh.py --repo o/r label-remove 12 a')).toEqual([{ name: 'gh.py label-remove', repo: 'o/r', labels: ['a'] }])
  expect(bashLabellings("gh api repos/o/r/issues/12/labels -f 'labels[]=a'")).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['a'] }])
  expect(bashLabellings('gh api -X DELETE repos/o/r/issues/12/labels/no%2De2e')).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['no-e2e'] }])
  expect(bashLabellings('gh api -X DELETE repos/o/r/issues/12/labels')).toEqual([{ name: 'gh api', repo: 'o/r', labels: [], opaque: true }])
  expect(bashLabellings("gh api -X PATCH repos/o/r/labels/old -f new_name=a")).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['old', 'a'] }])
  expect(bashLabellings('gh api graphql -F query=@q.graphql')).toEqual([{ name: 'gh api graphql', labels: [], opaque: true }])
  for (const line of ['gh pr edit 12 --title t', 'gh api repos/o/r/issues/12/labels', 'gh pr view 12', "git commit -m 'gh pr edit 1 --add-label a'"]) {
    expect(bashLabellings(line), line).toEqual([])
  }
  expect(toolLabelling('label-add', { pr: 3, label: ['a', 'b'] })).toEqual({ name: 'label-add', labels: ['a', 'b'] })
  expect(toolLabelling('label-remove', { pr: 3, name: 'a' })).toEqual({ name: 'label-remove', labels: ['a'] })
  expect(toolLabelling('pr-comment', { pr: 3, body: 'a' })).toBeUndefined()
})

test('labels gh api reads from a file (-F name=@file) are opaque: any label may move', () => {
  expect(bashLabellings("gh api repos/o/r/issues/12/labels -F 'labels[]=@f'")).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['@f'], opaque: true }])
  expect(bashLabellings('gh api -X PATCH repos/o/r/pulls/12 -F labels[]=@f')).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['@f'], opaque: true }])
  expect(bashLabellings('gh api -X PATCH repos/o/r/labels/old -F new_name=@n')).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['old', '@n'], opaque: true }])
  // -f sends `@f` as it is: a label named so, read on the line.
  expect(bashLabellings("gh api repos/o/r/issues/12/labels -f 'labels[]=@f'")).toEqual([{ name: 'gh api', repo: 'o/r', labels: ['@f'] }])
})

// A check plan that requires norms keeps them as E2E is kept; with no plan, or a plan that does not, norms stay on demand.
test('a plan that requires norms makes a missing norms record missing', () => {
  const noNorms = ALL.filter((r) => !r.name.startsWith('norms'))
  expect(missingItems(gate(), noNorms, undefined, { required: ['norms'] })).toEqual(['norms: no record at 0123456'])
  expect(missingItems(gate(), noNorms, undefined, { required: ['e2e'] })).toEqual([])
})

test('with no plan nothing changes: norms on demand, E2E required', () => {
  expect(missingItems(gate(), [record('review', 'pass')], undefined, {})).toEqual(['e2e: no record at 0123456'])
})
