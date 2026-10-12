import { describe, expect, test } from 'claude-code/testing'
import {
  IDLE, armedBy, agentDecision, bandLine, bandOf, bashDecision, checkDeny, codenameOf, doctorText, editDecision,
  githubDecision, ignoreVerdict, isVerdict, markRow, modeOf, nextRow, onTurnEnd, onTyped, parseState,
  preflightLines, shellActions, silencesAttribution, simpleCommands, skillOf, skillText, stateLine,
  COMMITTED_IGNORED, GUARD_SKIPPED, LOCAL_NOT_IGNORED, PREFLIGHT_PASSED, type Guard, type Snapshot,
} from './core.ts'

// The same text as tests/fixtures/state-table.md, which tests/run-tests.sh
// reads with the close skill's own grep and sed lines: both parsers are pinned
// to one fixture and the suite fails when the two copies differ.
const FIXTURE = `**Codename**: demo
**Title**: A demo feature
**Branch**: feat/demo
**Bump**: minor
**Artifacts**: local
**Base**: abc1234

| phase | title | status | milestone |
|---|---|---|---|
| 01 | the skeleton | done | 82525e4 |
| 02 | the core | doing | 9f31a0c |
| 03 | the cycle | todo |  |
`

describe('the state file', () => {
  test('the header and the rows parse as the close skill reads them', () => {
    const s = parseState(FIXTURE)
    expect(s.codename).toBe('demo')
    expect(s.bump).toBe('minor')
    expect(s.base).toBe('abc1234')
    expect(s.artifacts).toBe('local')
    expect(s.rows.map(r => `${r.phase}:${r.status}:${r.milestone}`)).toEqual(['01:done:82525e4', '02:doing:9f31a0c', '03:todo:'])
    // close refuses while a row is todo or doing; the next phase is that row.
    expect(nextRow(s.rows)?.phase).toBe('02')
  })

  test('every row done leaves no next phase', () => {
    const done = FIXTURE.replace('| doing | 9f31a0c |', '| done | 9f31a0c |').replace('| todo |  |', '| done | 1234abc |')
    expect(nextRow(parseState(done).rows)).toBeNull()
  })

  test('a row is rewritten in place and the rest of the file is untouched', () => {
    const out = markRow(FIXTURE, 3, 'doing', 'deadbee')
    if ('error' in out) throw new Error(out.error)
    expect(out.row).toEqual({ phase: '03', title: 'the cycle', status: 'doing', milestone: 'deadbee' })
    expect(out.text).toBe(FIXTURE.replace('| 03 | the cycle | todo |  |', '| 03 | the cycle | doing | deadbee |'))
  })

  test('a todo row drops its milestone, a bad status or sha or row is refused', () => {
    const out = markRow(FIXTURE, '2', 'todo', '9f31a0c')
    if ('error' in out) throw new Error(out.error)
    expect(out.row.milestone).toBe('')
    expect(markRow(FIXTURE, 2, 'finished', 'abc1234')).toEqual({ error: 'status must be todo, doing or done, not finished' })
    expect('error' in markRow(FIXTURE, 2, 'done', 'HEAD')).toBe(true)
    expect(markRow(FIXTURE, 9, 'done', 'abc1234')).toEqual({ error: 'no row 09 in the state table' })
    expect(markRow(FIXTURE, 'x', 'done', 'abc1234')).toEqual({ error: 'not a phase number: x' })
  })
})

describe('the derivation', () => {
  test('the codename is what follows the first slash', () => {
    expect(codenameOf('feat/demo')).toBe('demo')
    expect(codenameOf('fix/a/b')).toBe('a/b')
    expect(codenameOf('main')).toBe('main')
  })

  test('only committed changes the mode', () => {
    expect(modeOf(null)).toBe('local')
    expect(modeOf('{"artifacts": "committed"}')).toBe('committed')
    expect(modeOf('{"artifacts": "local"}')).toBe('local')
    expect(modeOf('{ not json')).toBe('local')
  })

  test('the ignore guard answers with the skills\' own lines', () => {
    expect(ignoreVerdict('local', false, true, true)).toBe('ok')
    expect(ignoreVerdict('local', false, true, false)).toBe(LOCAL_NOT_IGNORED)
    expect(ignoreVerdict('local', false, false, true)).toBe(LOCAL_NOT_IGNORED)
    expect(ignoreVerdict('committed', false, false, false)).toBe('ok')
    expect(ignoreVerdict('committed', false, false, true)).toBe(COMMITTED_IGNORED)
    expect(ignoreVerdict('local', true, false, false)).toBe(GUARD_SKIPPED)
  })
})

describe('the preflight', () => {
  const repo = { inside: true, branch: 'main' }
  test('enabled and in a repository on a branch passes', () => {
    expect(preflightLines({ 'superpowers@claude-plugins-official': true }, repo)).toEqual([])
    expect(doctorText([], 'main')).toBe('ready: superpowers@claude-plugins-official enabled, git repository on main')
  })
  test('disabled, absent or unreadable names the plugin and its fix', () => {
    const lines = [
      'error: required plugin not installed or not enabled: superpowers@claude-plugins-official',
      'fix:   /plugin install superpowers@claude-plugins-official   then enable it in /plugin',
    ]
    expect(preflightLines({ 'superpowers@claude-plugins-official': false }, repo)).toEqual(lines)
    expect(preflightLines({}, repo)).toEqual(lines)
    expect(preflightLines(undefined, repo)).toEqual(lines)
    expect(preflightLines('nonsense', repo)).toEqual(lines)
  })
  test('outside a repository, or on no branch, names the repository', () => {
    const lines = ['error: not a git repository with a current branch', 'fix:   run this from inside a git repository, on a branch']
    expect(preflightLines({ 'superpowers@claude-plugins-official': true }, { inside: false, branch: '' })).toEqual(lines)
    expect(preflightLines({ 'superpowers@claude-plugins-official': true }, { inside: true, branch: '' })).toEqual(lines)
  })
  test('a failed preflight replaces the skill, a passed one leads it', () => {
    const failed = skillText('THE SKILL', ['error: x', 'fix:   y'], null)
    expect(failed).not.toContain('THE SKILL')
    expect(failed).toContain('error: x\nfix:   y')
    const passed = skillText('THE SKILL', [], 'State: s.')
    expect(passed.startsWith(PREFLIGHT_PASSED)).toBe(true)
    expect(passed.endsWith('\n\nTHE SKILL')).toBe(true)
    expect(passed).toContain('State: s.')
  })
  test('the state line names every derived value', () => {
    const s: Snapshot = {
      branch: 'feat/demo', codename: 'demo', docs: 'docs/features/demo', mode: 'local', guard: 'ok', head: 'fedcba9',
      clean: true, stateFile: 'present', state: parseState(FIXTURE), next: nextRow(parseState(FIXTURE).rows),
    }
    const line = stateLine(s)
    for (const part of ['branch feat/demo', 'docs docs/features/demo', 'artifacts local', 'ignore guard ok', 'bump minor', 'base abc1234', 'next phase 02 doing (milestone 9f31a0c)']) {
      expect(line).toContain(part)
    }
  })
})

describe('the shell reader', () => {
  test('words lose their quotes and commands split on operators', () => {
    expect(simpleCommands(`git commit -m "a; b" && echo 'x | y'`)).toEqual([['git', 'commit', '-m', 'a; b'], ['echo', 'x | y']])
  })

  test('the guarded commands are found wherever a command starts', () => {
    expect(shellActions('git push origin feat/x')).toEqual(['push'])
    expect(shellActions('git -C /repo push')).toEqual(['push'])
    expect(shellActions('git -c user.name=x --no-pager merge main')).toEqual(['merge'])
    expect(shellActions('cd /repo && git push')).toEqual(['push'])
    expect(shellActions('FOO=1 rtk git push')).toEqual(['push'])
    expect(shellActions('/usr/bin/git push')).toEqual(['push'])
    expect(shellActions('bash -c "git push origin x"')).toEqual(['push'])
    expect(shellActions('echo "$(git push)"')).toEqual(['push'])
    expect(shellActions('x=`git merge y`')).toEqual(['merge'])
    expect(shellActions('gh pr create --fill')).toEqual(['pr-create'])
    expect(shellActions('gh -R o/r pr merge 12 --squash')).toEqual(['pr-merge'])
    expect(shellActions('git add -A; git commit -m x')).toEqual(['stage', 'commit'])
    expect(shellActions('cat <<EOF\nhi\nEOF\ngit push')).toEqual(['push'])
  })

  // The false positives: text that names a guarded command without running it.
  test('a quoted, commented, piped-as-text or here-document mention is no command', () => {
    expect(shellActions('git commit -m "never git push here"')).toEqual(['commit'])
    expect(shellActions('git commit -m "Read the plan; git push stays the user\'s"')).toEqual(['commit'])
    expect(shellActions(`git commit -m 'one && gh pr create later'`)).toEqual(['commit'])
    expect(shellActions(`echo 'gh pr create'`)).toEqual([])
    expect(shellActions('git log --grep=push --format=%s | grep merge')).toEqual([])
    expect(shellActions('git merge-base HEAD main')).toEqual([])
    expect(shellActions('# later; git push\ngit status')).toEqual([])
    expect(shellActions(`git commit -F - <<'EOF'\nMerge the reader\n\ngit push is the user's\nEOF`)).toEqual(['commit'])
    expect(shellActions('gh pr view 12 && gh pr checks 12 && gh pr list')).toEqual([])
    expect(shellActions('git -C /repo status')).toEqual([])
    expect(shellActions('grep -rn "git push" skills/')).toEqual([])
  })
})

describe('the guards', () => {
  const phase = armedBy(IDLE, 'phase')
  const close = armedBy(IDLE, 'close')
  const checking = armedBy(IDLE, 'check')

  test('phase and close refuse a push, a merge and a pull request', () => {
    for (const g of [phase, close]) {
      for (const command of ['git push', 'git merge main', 'gh pr create', 'gh pr merge 3']) {
        expect(bashDecision(g, command)).toContain('stops at the branch')
      }
      expect(githubDecision(g, 'pr-create')).toContain('stops at the branch')
      expect(githubDecision(g, 'pr-merge')).toContain('stops at the branch')
      expect(githubDecision(g, 'pr-get')).toBeNull()
    }
    expect(bashDecision(phase, 'git push')).toContain('implement:phase')
    expect(bashDecision(close, 'git push')).toContain('implement:close')
  })

  test('nothing is refused while no skill is armed, or after feature or prepare took over', () => {
    for (const g of [IDLE, armedBy(phase, 'feature'), armedBy(phase, 'prepare')]) {
      expect(bashDecision(g, 'git push')).toBeNull()
      expect(githubDecision(g, 'pr-create')).toBeNull()
      expect(agentDecision(g, 'general-purpose')).toBeNull()
      expect(editDecision(g, 'Edit')).toBeNull()
    }
  })

  test('the user\'s own words release the refusal they name', () => {
    expect(bashDecision(onTyped(phase, 'ok, push the branch'), 'git push')).toBeNull()
    expect(bashDecision(onTyped(phase, 'ok, push the branch'), 'git merge main')).toContain('stops at the branch')
    expect(bashDecision(onTyped(phase, 'merge it into main'), 'git merge main')).toBeNull()
    expect(githubDecision(onTyped(close, 'open the PR'), 'pr-create')).toBeNull()
    expect(agentDecision(onTyped(phase, 'use a subagent for the tests'), 'general-purpose')).toBeNull()
    // Asked in the prompt that starts the skill, before the skill is armed.
    expect(bashDecision(armedBy(onTyped(IDLE, 'run implement:close, then push'), 'close'), 'git push')).toBeNull()
    // A later prompt that names nothing arms it again.
    expect(bashDecision(onTyped(onTyped(phase, 'push it'), 'continue'), 'git push')).toContain('stops at the branch')
  })

  test('an aborted turn releases everything, an answered one keeps a phase armed', () => {
    expect(onTurnEnd(phase, true)).toEqual(IDLE)
    expect(onTurnEnd(phase, false).outer).toBe('phase')
    expect(bashDecision(onTurnEnd(phase, false), 'git push')).toContain('stops at the branch')
  })

  test('a phase dispatches read-only search subagents only', () => {
    expect(agentDecision(phase, 'Explore')).toBeNull()
    expect(agentDecision(phase, 'general-purpose')).toContain('writes the work itself')
    expect(agentDecision(phase, undefined)).toContain('general-purpose refused')
    expect(agentDecision(close, 'general-purpose')).toBeNull()
  })

  test('a check refuses edits, staging and commits until its verdict', () => {
    expect(editDecision(checking, 'Edit')).toBe(checkDeny('Edit'))
    expect(bashDecision(checking, 'git add -A')).toContain('implement:check edits')
    expect(bashDecision(checking, 'git commit -m x')).toContain('implement:check edits')
    expect(bashDecision(checking, 'git log --oneline')).toBeNull()
    expect(editDecision(onTurnEnd(checking, false), 'Edit')).toBeNull()
  })

  test('a check inside a phase keeps the phase armed once it ends', () => {
    const nested = armedBy(phase, 'check')
    expect(nested.outer).toBe('phase')
    expect(editDecision(nested, 'Write')).not.toBeNull()
    const after: Guard = { ...nested, checking: false }
    expect(editDecision(after, 'Write')).toBeNull()
    expect(bashDecision(after, 'git push')).toContain('stops at the branch')
  })

  test('the user\'s words end a check, the slash command that starts it does not', () => {
    expect(onTyped(checking, '/implement:check HEAD~1..HEAD').checking).toBe(true)
    expect(onTyped(checking, 'stop, fix it').checking).toBe(false)
  })

  test('the verdict is the table and its verdict line together', () => {
    const table = '| check | evidence | result |\n|---|---|---|\n| 1 truncation | ok | PASS |\n'
    expect(isVerdict(`${table}\nPASS\nDONE`)).toBe(true)
    expect(isVerdict(`${table}\nFAIL: 5, 6\nDONE_WITH_CONCERNS`)).toBe(true)
    expect(isVerdict(table)).toBe(false)
    expect(isVerdict('PASS')).toBe(false)
  })

  test('the commit trailer is silenced while a committing skill is armed', () => {
    expect(silencesAttribution(phase)).toBe(true)
    expect(silencesAttribution(close)).toBe(true)
    expect(silencesAttribution(armedBy(IDLE, 'feature'))).toBe(true)
    expect(silencesAttribution(IDLE)).toBe(false)
    expect(silencesAttribution(armedBy(IDLE, 'prepare'))).toBe(false)
  })

  test('only the five skills are recognised, by their full name', () => {
    expect(skillOf('implement:phase')).toBe('phase')
    expect(skillOf('phase')).toBeNull()
    expect(skillOf('implement:install')).toBeNull()
    expect(skillOf('superpowers:brainstorming')).toBeNull()
  })
})

describe('the band', () => {
  const s: Snapshot = {
    branch: 'feat/demo', codename: 'demo', docs: 'docs/features/demo', mode: 'local', guard: 'ok', head: 'fedcba9',
    clean: true, stateFile: 'present', state: parseState(FIXTURE), next: nextRow(parseState(FIXTURE).rows),
  }
  test('it names the phase, its base and the head', () => {
    expect(bandLine(bandOf(s)!, 200)).toBe('implement:phase demo · phase 02/03 doing: the core · base 9f31a0c · head fedcba9')
  })
  test('it is cut to the width it is given', () => {
    expect(bandLine(bandOf(s)!, 20).length).toBe(20)
  })
  test('no state file, no band', () => {
    expect(bandOf({ ...s, state: null, next: null })).toBeNull()
  })
  test('every phase done says what comes next', () => {
    const done = parseState(FIXTURE.replace('| doing | 9f31a0c |', '| done | 9f31a0c |').replace('| todo |  |', '| done | 1234abc |'))
    expect(bandLine(bandOf({ ...s, state: done, next: null })!, 200)).toContain('all 03 phases done, implement:close is next')
  })
})
