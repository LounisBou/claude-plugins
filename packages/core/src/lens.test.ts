import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findingCounts, findingId, lensDescription, lensSlug, parseFindingId, parseLensDescription, parseLensFindings, withFindingIds } from './lens.ts'

const ANSWER = [
  'Read the diff and the two files it names.',
  '[important] src/a.ts:12 — the lock is released before the write — line 14 writes after unlock()',
  '- [critical] `src/b.ts:3` — the token reaches the log — logger.info(token)',
  '[minor] README.md:40-42 — the example names a removed flag — --legacy',
  '[bogus] src/c.ts:1 — not a severity — x',
  '[minor] no location — a claim — evidence',
].join('\n')

describe('lens readers', () => {
  it('a lens name is a slug: lower case, words joined by a dash', () => {
    assert.equal(lensSlug('Silent failures'), 'silent-failures')
    assert.equal(lensSlug(' Spec conformity! '), 'spec-conformity')
    assert.equal(lensSlug('***'), undefined)
  })

  it('the description a launcher gives a reader names its lens, its pull request and its range, and reads back', () => {
    const text = lensDescription({ lens: 'Silent failures', repo: 'acme/thing', pr: 12, base: 'origin/main', head: '0123456789abcdef' })
    assert.equal(text, 'lens silent-failures acme/thing#12 origin/main..0123456789ab')
    assert.deepEqual(parseLensDescription(text), { lens: 'silent-failures', repo: 'acme/thing', pr: 12, base: 'origin/main', head: '0123456789ab' })
    assert.equal(parseLensDescription('Lens: correctness'), undefined)
    assert.equal(parseLensDescription('lens x acme/thing#0 a..b'), undefined)
  })

  it('a finding line reads as its severity, file, line and claim; a line of another shape is none', () => {
    assert.deepEqual(parseLensFindings(ANSWER), [
      { severity: 'important', file: 'src/a.ts', line: 12, claim: 'the lock is released before the write' },
      { severity: 'critical', file: 'src/b.ts', line: 3, claim: 'the token reaches the log' },
      { severity: 'minor', file: 'README.md', line: 40, claim: 'the example names a removed flag' },
    ])
    assert.deepEqual(findingCounts(parseLensFindings(ANSWER)), { critical: 1, important: 1, minor: 1 })
    assert.deepEqual(findingCounts(parseLensFindings('no findings: read the diff')), { critical: 0, important: 0, minor: 0 })
  })

  it('the finding lines real readers write are read: a location marked `~`, a range, words after the location, a bold or bare severity, a pipe', () => {
    const real = [
      '[important] plugins/github/hooks/register.ts:1338 — Nothing tests how `kept` is filled after a restart — If the block is removed, every pull request goes back',
      '- [important] scripts/deploy.test.ts:~337 — the doc promises that one failing configuration does not hold back the others — the only failure test',
      '[critical] plugins/orchestrator/skills/orchestrator/scripts/workspace.ts:1175-1195 (`sweepOne`) — ruling 5 says `--keep-checkout` keeps the checkout — the check sits after',
      '[important] iterm_agent.py:3829 and 3831 — `home_client_of_pane` drops the cause on every failure — close ends in a generic message',
      '**[important]** src/x.ts:9 — the bold severity — evidence',
      'important | test/test_dead_tcp.c:554 (guard at IP_Commands.c:245) | The test claims too much | it checks one socket',
      'minor state_machine.c:553 — SET_TMR1S_IE(1) is unconditional — It re-enables TMR4IE',
    ].join('\n')
    assert.deepEqual(parseLensFindings(real).map(f => [f.severity, f.file, f.line, f.claim]), [
      ['important', 'plugins/github/hooks/register.ts', 1338, 'Nothing tests how `kept` is filled after a restart'],
      ['important', 'scripts/deploy.test.ts', 337, 'the doc promises that one failing configuration does not hold back the others'],
      ['critical', 'plugins/orchestrator/skills/orchestrator/scripts/workspace.ts', 1175, 'ruling 5 says `--keep-checkout` keeps the checkout'],
      ['important', 'iterm_agent.py', 3829, '`home_client_of_pane` drops the cause on every failure'],
      ['important', 'src/x.ts', 9, 'the bold severity'],
      ['important', 'test/test_dead_tcp.c', 554, 'The test claims too much'],
      ['minor', 'state_machine.c', 553, 'SET_TMR1S_IE(1) is unconditional'],
    ])
    // A bullet of `*`, a file in backticks, a severity in capitals.
    assert.deepEqual(parseLensFindings('* [Critical] `src/y.ts:4` (the loop) — the claim — evidence\nIMPORTANT | src/z.ts:5 | another claim').map(f => [f.severity, f.file, f.line, f.claim]), [
      ['critical', 'src/y.ts', 4, 'the claim'],
      ['important', 'src/z.ts', 5, 'another claim'],
    ])
    // The claim is what follows the separator, whatever the shape; a pipe inside a dash line's claim stays in it, as in the contract's own shape.
    assert.deepEqual(parseLensFindings('[important] src/a.ts:12 (sym) — a | b — c').map(f => f.claim), ['a | b'])
    assert.deepEqual(parseLensFindings('**important** src/x.ts:9 — bold bare — e').map(f => f.claim), ['bold bare'])
    // No separator right after the location: the evidence is not taken for the claim, and a time is no location.
    assert.deepEqual(parseLensFindings('[important] src/a.ts:12: the claim — the evidence\nimportant src/a.ts:12 the claim — the evidence\nImportant 10:30 — standup moved'), [])
    // Prose that merely starts with a severity word, or a bracket with no location, is no finding.
    assert.deepEqual(parseLensFindings('Important: read the diff first\n[important] no location — a claim\nminor typos only'), [])
    // A line the contract's shape reads keeps its reading, so its id does not move.
    assert.deepEqual(parseLensFindings('[important] src/a.ts:12 — a | b — c').map(f => f.claim), ['a | b'])
  })

  it('a line whose severity comes last is a finding of that severity, its claim the fields between the location and the severity', () => {
    // The hand-backs of the claude-plugins#589 review's readers, asked for `<file>:<line> — <title> — <evidence> — <severity>`.
    const real = [
      'register.test.ts:1773 — "No re-run" and "retarget before gate" are not asserted — `walked` keeps only merges and `pr-update`, so the order is never read. Assert the `pr-gate` runs in the sequence too. — important',
      '',
      'register.test.ts:1742 — Existing assertions: none changed. The `stubMod` signature changes only add optional parameters with defaults equal to the old behaviour. No finding under review-verdict check 13. — minor',
      'plugins/github/engine/ghlib/stack.py:285 (order/_workflow_texts) — the workflow files are read at the bottom\'s base ref — A pull_request workflow runs from the merge ref of the PR. It is a heuristic and the fallback is bottom-up. — minor',
      'plugins/github/engine/ghlib/stack.py:93-111 (members, up traversal) — traversal starts only at the named PR — nothing warns the caller. — minor',
      'plugins/github/hooks/register.ts:2202 — The retarget (`runGh pr-update base`) ignores an `ask` rule on pr-update — The pre-pass at lines 2187-2190 only stops on `deny`. — important',
    ].join('\n')
    assert.deepEqual(parseLensFindings(real).map(f => [f.severity, f.file, f.line]), [
      ['important', 'register.test.ts', 1773],
      ['minor', 'register.test.ts', 1742],
      ['minor', 'plugins/github/engine/ghlib/stack.py', 285],
      ['minor', 'plugins/github/engine/ghlib/stack.py', 93],
      ['important', 'plugins/github/hooks/register.ts', 2202],
    ])
    assert.equal(parseLensFindings(real)[3]?.claim, 'traversal starts only at the named PR — nothing warns the caller.')
    assert.equal(parseLensFindings(real)[0]?.claim.endsWith('Assert the `pr-gate` runs in the sequence too.'), true)
    assert.deepEqual(findingCounts(parseLensFindings(real)), { critical: 0, important: 2, minor: 3 })
    // The severity is the last field alone, in any case, with brackets, backticks or bold; a bullet and a file in backticks as elsewhere.
    assert.deepEqual(parseLensFindings('- `src/a.ts:12` — the claim — the evidence — [Critical]\nsrc/b.ts:3 — c — e — **IMPORTANT**\nsrc/c.ts:4 — c — e — `minor`').map(f => [f.severity, f.file, f.line, f.claim]), [
      ['critical', 'src/a.ts', 12, 'the claim — the evidence'],
      ['important', 'src/b.ts', 3, 'c — e'],
      ['minor', 'src/c.ts', 4, 'c — e'],
    ])
    // A line that ends in one of the words without a location at its start is no finding, nor is one whose last field says more than the word.
    assert.deepEqual(parseLensFindings('The review is done, nothing — minor\nSee the notes — important\nThe risk is critical\nsrc/a.ts:12 — the claim — a minor one\nsrc/a.ts:12 — the claim — minor issue\nsrc/a.ts:12 — minor').length, 0)
    // The leading shape keeps its reading, its claim and so its id, even when its evidence ends in a severity.
    const lead = parseLensFindings('[important] src/a.ts:12 — the lock is released — the impact is minor')
    assert.deepEqual(lead.map(f => [f.severity, f.claim]), [['important', 'the lock is released']])
    // A trailing line gets its id once, and the ids read back from the marked answer are the same.
    const marked = withFindingIds(real, 'tests')
    assert.equal(withFindingIds(marked, 'tests'), marked)
    assert.deepEqual(parseLensFindings(marked), parseLensFindings(real))
    assert.equal(marked.split('\n')[0]?.endsWith(` — id ${findingId('tests', 'register.test.ts', 1773, parseLensFindings(real)[0]?.claim ?? '')}`), true)
  })

  it('a finding id is stable over lens, file, line and claim (case and spacing of the claim aside), and names its lens', () => {
    const id = findingId('correctness', 'src/a.ts', 12, 'the lock is released before the write')
    assert.match(id, /^correctness:[0-9a-f]{10}$/)
    assert.equal(findingId('correctness', 'src/a.ts', 12, '  The lock is   released before the write '), id)
    assert.notEqual(findingId('tests', 'src/a.ts', 12, 'the lock is released before the write'), id)
    assert.notEqual(findingId('correctness', 'src/a.ts', 13, 'the lock is released before the write'), id)
    assert.notEqual(findingId('correctness', 'src/a.ts', 12, 'the lock is held'), id)
    assert.deepEqual(parseFindingId(`see ${id} there`), { id, lens: 'correctness' })
    assert.equal(parseFindingId('no id'), undefined)
  })

  it('a reader\'s answer gets each finding line\'s id at its end; the rest of the answer is kept as it came', () => {
    const marked = withFindingIds(ANSWER, 'correctness')
    const lines = marked.split('\n')
    assert.equal(lines[0], 'Read the diff and the two files it names.')
    assert.equal(lines[1], `[important] src/a.ts:12 — the lock is released before the write — line 14 writes after unlock() — id ${findingId('correctness', 'src/a.ts', 12, 'the lock is released before the write')}`)
    assert.equal(lines[4], '[bogus] src/c.ts:1 — not a severity — x')
    // Marked twice, a line keeps one id; the ids read back from the marked answer are the same.
    assert.equal(withFindingIds(marked, 'correctness'), marked)
    assert.deepEqual(parseLensFindings(marked), parseLensFindings(ANSWER))
  })
})
