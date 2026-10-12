// hooks/tests/policy.test.ts
// The Iron Rules as decisions, with no engine: which words grant what, and
// which calls a walkthrough refuses. The false-positive cases the pull request
// lists are each pinned here, in both directions: a refusal the user may find
// strict, and a grant the matcher gives more loosely than the skill means.
import { expect, test } from 'claude-code/testing'
import { decide, grantsEdit, grantsResolve, grantsPublish, releases, runsGitPush, isScratch, scratchDirOf, endsWalkthrough } from '../policy.ts'

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const gh = (command: string, args: Record<string, unknown> = {}) => ({ tool: 'mcp__github__gh', command, args })
const bash = (command: string) => ({ tool: 'Bash', command })

test('start-review: only the word fix grants an edit', () => {
  for (const yes of ['fix', 'fix all', 'Fix.', 'ok, fix it']) expect(grantsEdit('start-review', yes)).toBe(true)
  for (const no of ['go ahead', 'yes', 'sure', 'makes sense', 'post', 'next', 'prefix', 'fixed?', '1', '3']) {
    expect(grantsEdit('start-review', no)).toBe(false)
  }
})

test('process-comments: options 1 and 3 and their aliases grant an edit', () => {
  for (const yes of ['1', '3', '1.', '3 please', 'f', 'fr', 'FR', 'fix', 'fix only', 'fix & resolve', 'fix and resolve', 'fix no resolve', 'fix resolve']) {
    expect(grantsEdit('process-comments', yes)).toBe(true)
  }
  for (const no of ['2', '4', '5', 'pass', 'pass & resolve', 'discuss', 'why', 'go ahead', 'p', 'pr']) {
    expect(grantsEdit('process-comments', no)).toBe(false)
  }
})

test('process-comments: options 1 and 4 and their aliases grant a resolve, fix no resolve does not', () => {
  for (const yes of ['1', '4', 'fr', 'pr', 'fix & resolve', 'fix resolve', 'fix and resolve', 'pass & resolve', 'resolve only', 'just resolve']) {
    expect(grantsResolve(yes)).toBe(true)
  }
  for (const no of ['2', '3', '5', 'fix only', 'fix no resolve', 'f', 'pass', 'next']) expect(grantsResolve(no)).toBe(false)
})

test('publishing needs the two words post now; end review and stop review release', () => {
  expect(grantsPublish('post now')).toBe(true)
  expect(grantsPublish('Post now please')).toBe(true)
  for (const no of ['post', 'post all', 'publish it', 'now post']) expect(grantsPublish(no)).toBe(false)
  expect(releases('end review')).toBe(true)
  expect(releases('ok, stop review now')).toBe(true)
  expect(releases('review ended')).toBe(false)
})

test('git push is read per command of a list, its subcommand after the global options', () => {
  for (const yes of ['git push', 'git push origin main', 'git -C /repo push', 'git -c a=b push', 'cd x && git push', 'FOO=1 git push', 'git status; git push -u origin x', 'env git push']) {
    expect(runsGitPush(yes)).toBe(true)
  }
  for (const no of ['git commit -m "push it later"', 'git log --grep=push', 'echo git push', 'gh pr create', 'git status', 'git pull', 'git stash push']) {
    expect(runsGitPush(no)).toBe(false)
  }
})

test('the scratch directory is never a code change, unless a path climbs out of it', () => {
  expect(isScratch('/tmp/claude-pr-review-12/comment-1.md')).toBe(true)
  expect(isScratch('/private/tmp/claude-pr-review-12/commit-2.msg')).toBe(true)
  expect(isScratch('/tmp/claude-pr-review-12/../../etc/hosts')).toBe(false)
  expect(isScratch('/tmp/claude-pr-review-12')).toBe(true)
  expect(isScratch('/repo/src/app.ts')).toBe(false)
  expect(isScratch('/tmp/claude-pr-reviewX/a')).toBe(false)
  expect(scratchDirOf('/tmp/claude-pr-review-12/comment-1.md')).toBe('/tmp/claude-pr-review-12')
  expect(scratchDirOf('/repo/a.ts')).toBeUndefined()
})

test('no walkthrough and auto-fix-loop refuse nothing', () => {
  for (const call of [edit('/repo/a.ts'), gh('pr-comment', { pr: 1 }), bash('git push')]) {
    expect(decide(null, call, '')).toBeNull()
    expect(decide('auto-fix-loop', call, '')).toBeNull()
  }
})

test('start-review: an edit outside the scratch directory waits for fix and the deny names it', () => {
  const reason = decide('start-review', edit('/repo/a.ts'), 'go ahead')
  expect(reason).toContain('"fix"')
  expect(reason).toContain('end review')
  expect(decide('start-review', edit('/repo/a.ts'), 'fix')).toBeNull()
  expect(decide('start-review', { tool: 'Write', file_path: '/tmp/claude-pr-review-3/comment-1.md', content: 'x' }, '')).toBeNull()
  expect(decide('start-review', { tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' }, 'next')).toContain('"fix"')
})

test('start-review: publication waits for post now, the pending review needs no word, reads always pass', () => {
  expect(decide('start-review', gh('pr-comment', { pr: 1, body: 'x' }), 'post')).toContain('"post now"')
  expect(decide('start-review', gh('pr-comment', { pr: 1, body: 'x' }), 'post now')).toBeNull()
  expect(decide('start-review', gh('review-submit', { pr: 1, event: 'COMMENT', comments: [] }), 'post now')).toBeNull()
  expect(decide('start-review', gh('review-submit', { pr: 1, event: 'COMMENT', comments: [] }), 'post')).toContain('post now')
  expect(decide('start-review', gh('review-pending-create', { pr: 1, comments: [] }), '')).toBeNull()
  expect(decide('start-review', gh('review-pending-add', { pr: 1 }), 'next')).toBeNull()
  expect(decide('start-review', gh('review-pending', { pr: 1 }), '')).toBeNull()
  expect(decide('start-review', gh('pr-get'), '')).toBeNull()
})

test('start-review: a review is never submitted with an event other than COMMENT, post now or not', () => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    expect(decide('start-review', gh('review-submit', { pr: 1, event }), 'post now')).toContain('never submitted')
  }
})

test('start-review: replies, resolutions and comment edits wait for post now', () => {
  for (const command of ['thread-reply', 'thread-resolve', 'comment-resolve', 'comment-edit', 'comment-delete']) {
    expect(decide('start-review', gh(command, { thread_id: 'T' }), 'yes')).toContain(command)
  }
})

test('process-comments: resolve waits for option 1 or 4, replies wait for post now', () => {
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), '3')).toContain('1 or 4')
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), '1')).toBeNull()
  expect(decide('process-comments', gh('comment-resolve', { node_id: 'IC' }), '4')).toBeNull()
  expect(decide('process-comments', gh('thread-reply', { thread_id: 'T', body: 'x' }), '1')).toContain('never posted')
  expect(decide('process-comments', gh('thread-reply', { thread_id: 'T', body: 'x' }), 'post now')).toBeNull()
  expect(decide('process-comments', gh('pr-issue-comments', { pr: 1 }), '')).toBeNull()
})

test('both walkthroughs refuse git push until the user says push', () => {
  for (const skill of ['start-review', 'process-comments'] as const) {
    expect(decide(skill, bash('git push origin main'), 'commit')).toContain('"push"')
    expect(decide(skill, bash('git push origin main'), 'ok push it')).toBeNull()
    expect(decide(skill, bash('git commit -F /tmp/claude-pr-review-1/commit-1.msg -- a.ts'), 'commit')).toBeNull()
  }
})

test('the resolver route is refused only while the github tool is listed', () => {
  const call = bash('GH_ROOT=$(python3 "/p/scripts/resolve_github.py") || exit 1')
  expect(decide('start-review', call, '', true)).toContain('mcp__github__gh')
  expect(decide('start-review', call, '', false)).toBeNull()
})

// False positives the pull request lists. Strict side: words a user may mean as
// consent that the skills define as no consent; each is refused, and the reason
// names the word that lifts it.
test('false positive (strict): consent in other words is refused, naming the word', () => {
  for (const words of ['please apply it', 'go ahead', 'yes', 'do it', 'sounds good', 'agreed']) {
    expect(decide('start-review', edit('/repo/a.ts'), words)).toContain('"fix"')
    expect(decide('process-comments', edit('/repo/a.ts'), words)).toContain('1 or 3')
  }
  expect(decide('start-review', gh('pr-comment', { pr: 1 }), 'publish it')).toContain('"post now"')
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), 'close the thread')).toContain('1 or 4')
  expect(decide('start-review', bash('git push'), 'ship it')).toContain('"push"')
})

// Loose side: the matcher reads words, not intent; these grant although the user
// may not have meant it. The skill's own rules still apply to the model.
test('false positive (loose): a word in a negation or an aside still grants', () => {
  expect(decide('start-review', edit('/repo/a.ts'), "don't fix this one")).toBeNull()
  expect(decide('start-review', gh('pr-comment', { pr: 1 }), 'do not post now')).toBeNull()
  expect(decide('start-review', bash('git push'), 'I will push later myself')).toBeNull()
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), 'why not resolve it?')).toBeNull()
})

test('the closing lines end a walkthrough, a translated heading does not', () => {
  expect(endsWalkthrough('start-review', 'x\n## Walkthrough complete\n\n### Kept')).toBe(true)
  expect(endsWalkthrough('start-review', '## Fin de la revue')).toBe(false)
  expect(endsWalkthrough('process-comments', 'Confirm: All PR comments have been addressed.')).toBe(true)
  expect(endsWalkthrough('auto-fix-loop', '## Walkthrough complete')).toBe(false)
})
