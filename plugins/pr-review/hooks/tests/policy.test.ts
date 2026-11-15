// hooks/tests/policy.test.ts
// The Iron Rules as decisions, with no engine: which words grant what, and
// which calls a walkthrough notes or refuses. The false-positive cases the pull request
// lists are each pinned here, in both directions: a refusal the user may find
// strict, and a grant the matcher gives more loosely than the skill means.
import { expect, test } from 'claude-code/testing'
import { decide, pushQuestion, grantsEdit, grantsResolve, grantsPublish, releases, runsGitPush, isScratch, scratchDirOf, endsWalkthrough } from '../policy.ts'

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const gh = (command: string, args: Record<string, unknown> = {}) => ({ tool: 'mcp__github__gh', command, args })
const bash = (command: string) => ({ tool: 'Bash', command })

test('start-review: only the word fix grants an edit', () => {
  for (const yes of ['fix', 'fix all', 'Fix.', 'ok, fix it']) expect(grantsEdit('start-review', yes)).toBe(true)
  for (const no of ['go ahead', 'yes', 'sure', 'makes sense', 'post', 'next', 'prefix', 'fixed?', '1', '3', "don't fix this one", 'do not fix', 'why fix it', 'fix?', 'should I fix it?']) {
    expect(grantsEdit('start-review', no)).toBe(false)
  }
})

test('process-comments: options 1 and 3 and their aliases grant an edit', () => {
  for (const yes of ['1', '3', '1.', '3 please', 'f', 'fr', 'FR', 'fix', 'fix only', 'fix & resolve', 'fix and resolve', 'fix no resolve', 'fix resolve']) {
    expect(grantsEdit('process-comments', yes)).toBe(true)
  }
  for (const no of ['2', '4', '5', 'pass', 'pass & resolve', 'discuss', 'why', 'go ahead', 'p', 'pr', "don't fix", 'not 1', '1?']) {
    expect(grantsEdit('process-comments', no)).toBe(false)
  }
})

test('process-comments: options 1 and 4 and their aliases grant a resolve, fix no resolve does not', () => {
  for (const yes of ['1', '4', 'fr', 'pr', 'fix & resolve', 'fix resolve', 'fix and resolve', 'pass & resolve', 'resolve only', 'just resolve']) {
    expect(grantsResolve(yes)).toBe(true)
  }
  for (const no of ['2', '3', '5', 'fix only', 'fix no resolve', 'f', 'pass', 'next', "don't resolve", 'never resolve it', 'resolve?']) expect(grantsResolve(no)).toBe(false)
})

test('publishing needs the two words post now; end review and stop review release', () => {
  expect(grantsPublish('post now')).toBe(true)
  expect(grantsPublish('Post now please')).toBe(true)
  for (const no of ['post', 'post all', 'publish it', 'now post', "don't post now", 'why not post now', 'post now?']) expect(grantsPublish(no)).toBe(false)
  expect(grantsPublish('ok, post now.')).toBe(true)
  expect(releases('end review')).toBe(true)
  expect(releases('ok, stop review now')).toBe(true)
  expect(releases('review ended')).toBe(false)
  expect(releases("don't stop review")).toBe(false)
})

test('git push is read per command of a list, its subcommand after the global options', () => {
  for (const yes of ['git push', 'git push origin main', 'git -C /repo push', 'git -c a=b push', 'cd x && git push', 'FOO=1 git push', 'git status; git push -u origin x', 'env git push', 'sh -c "git push"', 'bash -lc "cd x && git push origin"', 'eval git push', 'eval "git push -f"']) {
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

// What a walkthrough does with a call: refused (an irreversible act), or let through and noted under
// the stable code the journal holds it by.
const refused = (v: ReturnType<typeof decide>) => (v?.irreversible ? v.reason : null)
const noted = (v: ReturnType<typeof decide>) => (v && !v.irreversible ? v.code : null)

test('no walkthrough and auto-fix-loop find nothing', () => {
  for (const call of [edit('/repo/a.ts'), gh('pr-comment', { pr: 1 }), bash('git push')]) {
    expect(decide(null, call, '')).toBeNull()
    expect(decide('auto-fix-loop', call, '')).toBeNull()
  }
})

test('start-review: an edit outside the scratch directory without fix is noted, never refused', () => {
  const v = decide('start-review', edit('/repo/a.ts'), 'go ahead')
  expect(noted(v)).toBe('pr-review.edit.ungranted')
  expect(refused(v)).toBeNull()
  expect(v?.reason).toContain('"fix"')
  expect(decide('start-review', edit('/repo/a.ts'), 'fix')).toBeNull()
  expect(decide('start-review', { tool: 'Write', file_path: '/tmp/claude-pr-review-3/comment-1.md', content: 'x' }, '')).toBeNull()
  expect(noted(decide('start-review', { tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' }, 'next'))).toBe('pr-review.edit.ungranted')
})

test('start-review: publication without post now is noted, the pending review needs no word, reads always pass', () => {
  expect(noted(decide('start-review', gh('pr-comment', { pr: 1, body: 'x' }), 'post'))).toBe('pr-review.publish.ungranted')
  expect(decide('start-review', gh('pr-comment', { pr: 1, body: 'x' }), 'post now')).toBeNull()
  expect(decide('start-review', gh('review-submit', { pr: 1, event: 'COMMENT', comments: [] }), 'post now')).toBeNull()
  expect(noted(decide('start-review', gh('review-submit', { pr: 1, event: 'COMMENT', comments: [] }), 'post'))).toBe('pr-review.publish.ungranted')
  expect(decide('start-review', gh('review-pending-create', { pr: 1, comments: [] }), '')).toBeNull()
  expect(decide('start-review', gh('review-pending-add', { pr: 1 }), 'next')).toBeNull()
  expect(decide('start-review', gh('review-pending', { pr: 1 }), '')).toBeNull()
  expect(decide('start-review', gh('pr-get'), '')).toBeNull()
})

test('start-review: a review submitted with an event other than COMMENT is refused, post now or not', () => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const v = decide('start-review', gh('review-submit', { pr: 1, event }), 'post now')
    expect(v?.code).toBe('pr-review.review-event.not-comment')
    expect(refused(v)).toContain('never submitted')
    expect(noted(v)).toBeNull()
  }
})

test('process-comments refuses a review submitted with an event other than COMMENT too, post now or not', () => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const v = decide('process-comments', gh('review-submit', { pr: 1, event }), 'post now')
    expect(v?.code).toBe('pr-review.review-event.not-comment')
    expect(refused(v)).toContain('process-comments: a review is never submitted')
    expect(noted(v)).toBeNull()
  }
  expect(decide('process-comments', gh('review-submit', { pr: 1, event: 'COMMENT' }), 'post now')).toBeNull()
  expect(noted(decide('process-comments', gh('review-submit', { pr: 1, event: 'COMMENT' }), '1'))).toBe('pr-review.reply.ungranted')
})

test('start-review: replies, resolutions and comment edits without post now are noted; a deleted comment is refused', () => {
  for (const command of ['thread-reply', 'thread-resolve', 'comment-resolve', 'comment-edit']) {
    const v = decide('start-review', gh(command, { thread_id: 'T' }), 'yes')
    expect(noted(v)).toBe('pr-review.reply.ungranted')
    expect(v?.reason).toContain(command)
  }
  const deleted = decide('start-review', gh('comment-delete', { node_id: 'C' }), 'yes')
  expect(deleted?.code).toBe('pr-review.comment-delete.ungranted')
  expect(refused(deleted)).toContain('comment-delete')
  expect(decide('start-review', gh('comment-delete', { node_id: 'C' }), 'post now')).toBeNull()
})

test('process-comments: resolve without option 1 or 4 and a reply without post now are noted; a deleted comment is refused', () => {
  expect(noted(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), '3'))).toBe('pr-review.resolve.ungranted')
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), '1')).toBeNull()
  expect(decide('process-comments', gh('comment-resolve', { node_id: 'IC' }), '4')).toBeNull()
  expect(noted(decide('process-comments', gh('thread-reply', { thread_id: 'T', body: 'x' }), '1'))).toBe('pr-review.reply.ungranted')
  expect(decide('process-comments', gh('thread-reply', { thread_id: 'T', body: 'x' }), 'post now')).toBeNull()
  expect(decide('process-comments', gh('pr-issue-comments', { pr: 1 }), '')).toBeNull()
  expect(refused(decide('process-comments', gh('comment-delete', { node_id: 'C' }), '1'))).toContain('comment-delete')
})

test('a push that rewrites nothing is noted; a forced or deleting push asks the user; words in a prompt grant none', () => {
  for (const skill of ['start-review', 'process-comments'] as const) {
    for (const plain of ['git push', 'git push origin main', 'git push -u origin HEAD', 'git -C /repo push --tags', 'git push origin HEAD:refs/heads/x', 'git add a && git push origin x']) {
      expect(pushQuestion(skill, bash(plain))).toBeNull()
      expect(noted(decide(skill, bash(plain), 'push'))).toBe('pr-review.push.ungranted')
    }
    for (const forced of ['git push -f', 'git push --force origin main', 'git push --force-with-lease', 'git push origin +main', 'git push origin :old', 'git push --delete origin old', 'git push --mirror', 'git push -fu origin x', 'git push origin $BRANCH', 'git status; git push --force', 'eval "git push -f"', 'git push origin $(echo +main)', 'git push `echo --force` origin main', 'echo --force | xargs git push origin main', 'git -c remote.origin.push=+HEAD push origin', 'sh -c "sh -c \'git push -f\'"', 'git push origin foo:', 'bash -c "git push origin $(echo -f)"',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD git push', 'GIT_CONFIG_PARAMETERS="\'remote.origin.push=+HEAD\'" git push origin',
      'env GIT_CONFIG_COUNT=1 git push', '/usr/bin/env git push', 'env git push origin main', 'export GIT_CONFIG_COUNT=1; git push', 'FOO=1 git push', 'bash -c "GIT_CONFIG_COUNT=1 git push"',
      'git push origin a; git push -f', 'git push origin a && git push origin $(echo b)']) {
      expect(pushQuestion(skill, bash(forced))).toContain('forced push now?')
      expect(decide(skill, bash(forced), 'push')).toBeNull()
    }
    expect(pushQuestion(skill, bash('git commit -F /tmp/claude-pr-review-1/commit-1.msg -- a.ts'))).toBeNull()
    expect(decide(skill, bash('git commit -F /tmp/claude-pr-review-1/commit-1.msg -- a.ts'), 'commit')).toBeNull()
  }
  expect(pushQuestion('auto-fix-loop', bash('git push -f'))).toBeNull()
  expect(pushQuestion(null, bash('git push -f'))).toBeNull()
})

test('the resolver route stays refused while the github tool is listed when its request names an irreversible command', () => {
  const route = (request: string) => bash(`GH_ROOT=$(python3 "/p/scripts/resolve_github.py") || exit 1\npython3 "$GH_ROOT/engine/gh.py" --stdin-json <<'REQ'\n${request}\nREQ`)
  for (const request of ['{"command": "comment-delete", "args": {"node_id": "C"}}', '{"command": "pr-merge", "args": {"pr": 3}}',
    '{"command": "review-submit", "args": {"pr": 3, "event": "APPROVE"}}', '{"command":"review-submit","args":{"event":"REQUEST_CHANGES"}}', '{"command": "review-submit", "args": {"event": "approve"}}']) {
    for (const skill of ['start-review', 'process-comments'] as const) {
      const v = decide(skill, route(request), 'post now', true)
      expect(v?.code).toBe('pr-review.resolver-route.irreversible')
      expect(refused(v)).toContain('cannot be taken back')
      expect(decide(skill, route(request), 'post now', false)).toBeNull()
    }
  }
  for (const request of ['{"command": "pr-get", "args": {"pr": 3}}', '{"command": "review-submit", "args": {"pr": 3, "event": "COMMENT"}}', '{"command": "thread-reply", "args": {}}']) {
    expect(noted(decide('start-review', route(request), '', true))).toBe('pr-review.resolver-route.listed')
  }
})

test('the resolver route is noted only while the github tool is listed', () => {
  const call = bash('GH_ROOT=$(python3 "/p/scripts/resolve_github.py") || exit 1')
  expect(noted(decide('start-review', call, '', true))).toBe('pr-review.resolver-route.listed')
  expect(decide('start-review', call, '', false)).toBeNull()
})

// False positives the pull request lists. Strict side: words a user may mean as
// consent that the skills define as no consent; each is noted, and the reason
// names the word that lifts it.
test('false positive (strict): consent in other words is noted, naming the word', () => {
  for (const words of ['please apply it', 'go ahead', 'yes', 'do it', 'sounds good', 'agreed']) {
    expect(decide('start-review', edit('/repo/a.ts'), words)?.reason).toContain('"fix"')
    expect(decide('process-comments', edit('/repo/a.ts'), words)?.reason).toContain('1 or 3')
  }
  expect(decide('start-review', gh('pr-comment', { pr: 1 }), 'publish it')?.reason).toContain('"post now"')
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), 'close the thread')?.reason).toContain('1 or 4')
  expect(pushQuestion('start-review', bash('git push -f'))).toContain('forced push now?')
})

// A grant is the command an answer starts with: a word in a negation, an aside or
// a question grants nothing.
test('a word in a negation, an aside or a question grants nothing', () => {
  expect(decide('start-review', edit('/repo/a.ts'), "don't fix this one")).not.toBeNull()
  expect(decide('start-review', gh('pr-comment', { pr: 1 }), 'do not post now')).not.toBeNull()
  expect(decide('process-comments', gh('thread-resolve', { thread_id: 'T' }), 'why not resolve it?')).not.toBeNull()
})

test('the closing lines end a walkthrough, a translated heading does not', () => {
  expect(endsWalkthrough('start-review', 'x\n## Walkthrough complete\n\n### Kept')).toBe(true)
  expect(endsWalkthrough('start-review', '## Fin de la revue')).toBe(false)
  expect(endsWalkthrough('process-comments', 'Confirm: All PR comments have been addressed.')).toBe(true)
  expect(endsWalkthrough('auto-fix-loop', '## Walkthrough complete')).toBe(false)
})
