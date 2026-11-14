// The health command's reader and report: the journals under a configuration directory, summarized
// over the contract's window, with no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditEvent, eventId, foldedText, journalDir, JOURNAL_FOLD_FILE, type LearningEvent } from '../../../core/learning.ts'
import { HEALTH_USAGE, readJournals, readRemovals, render, repoRootOf, run, summarize, undelivered, type Removal } from './health.ts'

const NOW = Date.parse('2026-11-14T10:00:00Z')
const DAY = 86_400_000
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().replace('.000Z', 'Z')

function event(plugin: string, daysAgo: number, change: Partial<LearningEvent> = {}, random = '0a1b2c3d'): LearningEvent {
  const at = iso(daysAgo)
  return {
    v: 1, id: eventId(at, random) ?? '', at, kind: 'refusal', source: { plugin, code: `${plugin}.ready.missing-review` },
    subject: { repo: null, pr: null, head: null },
    context: { role: null, mode: null, paths: [], languages: [], session: null },
    evidence: [], trust: 'computed', ...change,
  }
}

function write(config: string, plugin: string, e: LearningEvent): void {
  const dir = journalDir(config, plugin)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${e.id}.json`), JSON.stringify(e))
}

function scratch(work: (config: string) => void): void {
  const config = mkdtempSync(join(tmpdir(), 'learning-health-'))
  try {
    work(config)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

test('readJournals reads each plugin\'s own journal and counts what is not an event of the contract', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    write(config, 'norms', event('norms', 2))
    mkdirSync(journalDir(config, 'pr-review'), { recursive: true })
    writeFileSync(join(journalDir(config, 'norms'), 'broken.json'), '{ not json')
    writeFileSync(join(journalDir(config, 'norms'), 'foreign.json'), JSON.stringify({ ...event('norms', 3), command: 'git push' }))
    writeFileSync(join(journalDir(config, 'norms'), 'notes.txt'), 'not an event file')
    mkdirSync(join(config, 'projects'), { recursive: true })
    mkdirSync(join(config, 'Not A Plugin', 'journal'), { recursive: true })
    const journals = readJournals(config)
    assert.deepEqual(journals.map(j => [j.plugin, j.events.length, j.unreadable]), [['github', 1, 0], ['norms', 1, 2], ['pr-review', 0, 0]])
  })
})

test('readJournals recognises the fold file by its name: its counts are the folded events, it is never an unreadable file', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    const fold = join(journalDir(config, 'github'), JOURNAL_FOLD_FILE)
    writeFileSync(fold, foldedText([
      { signature: 'refusal:github.a.b', week: '2026-11-02', count: 4 },
      { signature: 'refusal:github.a.b', week: '2026-11-09', count: 3 },
    ]))
    const [journal] = readJournals(config)
    assert.deepEqual([journal?.events.length, journal?.folded, journal?.unreadable], [1, 7, 0])
    const s = summarize(readJournals(config), NOW)
    assert.deepEqual([s.folded, s.unreadable], [7, 0])
    assert.match(render(s), /7 older events folded into weekly counts/)
    writeFileSync(fold, 'garbled')
    const [broken] = readJournals(config)
    assert.deepEqual([broken?.folded, broken?.unreadable], [0, 1])
  })
})

test('render says nothing of a fold when there is none', () => {
  assert.doesNotMatch(render(summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 1)] }], NOW)), /folded/)
})

test('readJournals reads a configuration directory with no journal, or none at all', () => {
  scratch(config => {
    assert.deepEqual(readJournals(config), [])
    assert.deepEqual(readJournals(join(config, 'absent')), [])
  })
})

test('summarize counts the window\'s events by kind, refusals by code and findings by severity', () => {
  const journals = [
    { plugin: 'github', unreadable: 0, events: [
      event('github', 1), event('github', 2, {}, '00000001'),
      event('github', 3, { source: { plugin: 'github', code: 'github.ready.missing-e2e' } }, '00000002'),
      event('github', 40, {}, '00000003'),
    ] },
    { plugin: 'pr-review', unreadable: 1, events: [
      event('pr-review', 1, { kind: 'finding', source: { plugin: 'pr-review', code: 'pr-review.finding' }, evidence: [{ type: 'finding', severity: 'critical', file: 'a.ts' }] }),
      event('pr-review', 2, { kind: 'finding', source: { plugin: 'pr-review', code: 'pr-review.finding' }, evidence: [{ type: 'finding', severity: 'important', file: 'a.ts' }, { type: 'finding', severity: 'important', file: 'b.ts' }] }, '00000001'),
      event('pr-review', 2, { kind: 'answer', source: { plugin: 'pr-review', code: 'pr-review.push-ask' }, trust: 'operator' }, '00000002'),
      event('pr-review', 2, { kind: 'escape', source: { plugin: 'pr-review', code: 'pr-review.escape' } }, '00000003'),
    ] },
  ]
  const s = summarize(journals, NOW)
  assert.equal(s.plugins, 2)
  assert.equal(s.events, 7)
  assert.equal(s.older, 1)
  assert.equal(s.unreadable, 1)
  assert.deepEqual(s.kinds, { refusal: 3, finding: 2, answer: 1, escape: 1 })
  assert.deepEqual(s.refusals, [['github.ready.missing-review', 2], ['github.ready.missing-e2e', 1]])
  assert.deepEqual(s.findings, { critical: 1, important: 2 })
})

test('summarize puts the edge of the window inside it, and keeps refusal codes in order of count then name', () => {
  const at = (days: number, code: string, random: string) => event('github', days, { source: { plugin: 'github', code } }, random)
  const s = summarize([{ plugin: 'github', unreadable: 0, events: [at(30, 'github.b.x', '00000001'), at(31, 'github.c.x', '00000002'), at(1, 'github.a.x', '00000003')] }], NOW)
  assert.equal(s.events, 2)
  assert.equal(s.older, 1)
  assert.deepEqual(s.refusals, [['github.a.x', 1], ['github.b.x', 1]])
})

test('render says what the window holds, and what it does not read yet', () => {
  const s = summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 1)] }], NOW)
  const text = render(s)
  assert.match(text, /30 days/)
  assert.match(text, /github\.ready\.missing-review +1/)
  assert.match(text, /findings: 0 critical, 0 important/)
  assert.match(text, /not read yet/i)
})

test('render says plainly that no journal exists, and that unreadable files exist', () => {
  assert.match(render(summarize([], NOW)), /no journal/i)
  assert.match(render(summarize([{ plugin: 'norms', unreadable: 2, events: [] }], NOW)), /2 files? .*not .*contract/i)
})

test('run prints the report of the configuration directory, and refuses a call without one', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    const outs: string[] = []
    const errs: string[] = []
    const deps = { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l), now: () => NOW }
    assert.equal(run(['--config', config], deps), 0)
    assert.match(outs.join('\n'), /github\.ready\.missing-review +1/)
    assert.equal(run([], deps), 2)
    assert.equal(run(['--config'], deps), 2)
    assert.equal(run(['--config', config, 'extra'], deps), 2)
    assert.deepEqual(errs, [HEALTH_USAGE, HEALTH_USAGE, HEALTH_USAGE])
  })
})

test('an audit event, version 2 of the contract, is counted apart from version 1 and is never unreadable', () => {
  scratch(config => {
    const fact = { step: 'implement', edge: 'start', record: null, row: 1, result: null } as const
    for (const [daysAgo, random] of [[1, '00000001'], [40, '00000002']] as const) {
      const audit = auditEvent({ at: iso(daysAgo), random, kind: 'step', source: { plugin: 'orchestrator', code: 'orchestrator.dispatch.open' }, trust: 'computed', fact })
      assert.ok(audit)
      mkdirSync(journalDir(config, 'orchestrator'), { recursive: true })
      writeFileSync(join(journalDir(config, 'orchestrator'), `${audit.id}.json`), JSON.stringify(audit))
    }
    write(config, 'orchestrator', event('orchestrator', 1))
    const journals = readJournals(config)
    assert.deepEqual(journals.map(j => [j.plugin, j.events.length, j.audit?.length, j.unreadable]), [['orchestrator', 1, 2, 0]])
    const s = summarize(journals, NOW)
    assert.deepEqual([s.events, s.audit, s.older, s.unreadable], [1, 1, 1, 0])
    assert.match(render(s), /^1 audit events$/m)
  })
})

const silentCodes = (s: ReturnType<typeof summarize>) => s.silent.map(({ code, plugin, days }) => [code, plugin, days])

test('a guard code with refusals in the journals but none in the window is silent, with the days since its last refusal', () => {
  const at = (plugin: string, code: string, days: number, random: string, kind: LearningEvent['kind'] = 'refusal') => event(plugin, days, { kind, source: { plugin, code } }, random)
  const s = summarize([
    { plugin: 'github', unreadable: 0, events: [
      at('github', 'github.live.a', 1, '00000001'), at('github', 'github.live.a', 90, '00000002'),
      at('github', 'github.quiet.b', 45, '00000003'),
      at('github', 'github.quiet.c', 100, '00000004'), at('github', 'github.quiet.c', 60, '00000005'),
      at('github', 'github.edge.d', 30, '00000006'),
      at('github', 'github.edge.e', 31, '00000007'),
      at('github', 'github.found.f', 70, '00000008', 'finding'),
    ] },
    { plugin: 'norms', unreadable: 0, events: [at('norms', 'norms.old.g', 45, '00000009')] },
  ], NOW)
  assert.deepEqual(silentCodes(s), [['github.quiet.c', 'github', 60], ['github.quiet.b', 'github', 45], ['norms.old.g', 'norms', 45], ['github.edge.e', 'github', 31]])
})

test('no silent guard when every refusal code of the journals refused in the window, or when there is no refusal at all', () => {
  assert.deepEqual(summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 2), event('github', 50, {}, '00000001')] }], NOW).silent, [])
  assert.deepEqual(summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 50, { kind: 'escape' })] }], NOW).silent, [])
})

test('render lists each silent guard on one line, code then plugin then days silent, and says none otherwise', () => {
  const quiet = event('github', 45, { source: { plugin: 'github', code: 'github.quiet.b' } })
  const text = render(summarize([{ plugin: 'github', unreadable: 0, events: [quiet] }], NOW))
  assert.match(text, /^silent guards, proposed for removal \(no refusal in the 30 days\):$/m)
  assert.match(text, /^ {2}github\.quiet\.b +github +45 days silent$/m)
  const none = render(summarize([{ plugin: 'github', unreadable: 0, events: [event('github', 1)] }], NOW))
  assert.match(none, /^silent guards[^\n]*:\n {2}none$/m)
})

const RULINGS = [
  '# rulings',
  '- 2026-11-14T14:53:59Z (relayed verbatim) « a removal, said in prose » → decided, no fixed form',
  '- 2026-11-14T15:00:00Z « Retire the whole guard » — removal: plugins/github/hooks/ready-old.ts',
  '- 2026-11-14T15:01:00Z « Retire one function » — removal: plugins/github/hooks/ready.ts::oldCheck',
  '- 2026-11-14T15:02:00Z « Dot dot » — removal: ../outside.ts',
  '- 2026-11-14T15:03:00Z « Absolute » — removal: /etc/passwd',
  '- 2026-11-14T15:04:00Z « Two symbols » — removal: a.ts::one::two',
  '- 2026-11-14T15:05:00Z « Empty symbol » — removal: a.ts::',
  '- 2026-11-14T15:06:00Z « No hour » — removal: a.ts',
  '- 2026-11-14T15:07:00Z no words — removal: a.ts',
  '- 2026-11-14T15:08:00Z « Words with a » quote » — removal: plugins/x/y.md',
  '',
].join('\n')

function rulings(config: string, project: string, text: string): void {
  const dir = join(config, 'claude-orchestrator', 'briefs', project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rulings.md'), text)
}

test('readRemovals reads the fixed-form removal lines of every project\'s rulings, and nothing else', () => {
  scratch(config => {
    assert.deepEqual(readRemovals(config), [])
    rulings(config, 'claude-plugins', RULINGS.replace('2026-11-14T15:06:00Z', '2026-11-14T15:06'))
    rulings(config, 'other', '- 2026-11-13T09:00:00Z « Drop it » — removal: src/old.ts::legacy\n')
    mkdirSync(join(config, 'claude-orchestrator', 'briefs', 'empty'), { recursive: true })
    writeFileSync(join(config, 'claude-orchestrator', 'briefs', 'stray.md'), '- 2026-11-13T09:00:00Z « Stray » — removal: stray.ts\n')
    assert.deepEqual(readRemovals(config).map(r => [r.project, r.at, r.path, r.symbol]), [
      ['claude-plugins', '2026-11-14T15:00:00Z', 'plugins/github/hooks/ready-old.ts', null],
      ['claude-plugins', '2026-11-14T15:01:00Z', 'plugins/github/hooks/ready.ts', 'oldCheck'],
      ['claude-plugins', '2026-11-14T15:08:00Z', 'plugins/x/y.md', null],
      ['other', '2026-11-13T09:00:00Z', 'src/old.ts', 'legacy'],
    ])
  })
})

function repo(work: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'learning-repo-'))
  try {
    mkdirSync(join(root, '.git'))
    work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const removal = (path: string, symbol: string | null = null): Removal => ({ project: 'p', at: '2026-11-14T15:00:00Z', path, symbol })

test('undelivered keeps a removal whose path still exists, and one whose symbol is still in the file', () => {
  repo(root => {
    mkdirSync(join(root, 'plugins', 'github'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'github', 'ready.ts'), 'export function oldCheck() {}\nconst keep = oldCheckers\n')
    writeFileSync(join(root, 'plugins', 'github', 'gone.ts'), 'export const other = 1\n')
    const listed = undelivered([
      removal('plugins/github/ready.ts'),
      removal('plugins/github/absent.ts'),
      removal('plugins/github'),
      removal('plugins/github/ready.ts', 'oldCheck'),
      removal('plugins/github/ready.ts', 'oldChec'),
      removal('plugins/github/gone.ts', 'oldCheck'),
      removal('plugins/github/absent.ts', 'oldCheck'),
      removal('plugins/github', 'oldCheck'),
    ], root)
    assert.deepEqual(listed.map(r => [r.path, r.symbol]), [
      ['plugins/github/ready.ts', null], ['plugins/github', null], ['plugins/github/ready.ts', 'oldCheck'],
    ])
  })
})

test('undelivered reads a symbol as a whole word, with the characters of an identifier in it', () => {
  repo(root => {
    writeFileSync(join(root, 'a.ts'), 'const x$ = 1\nconst fooBar = 2\n')
    assert.deepEqual(undelivered([removal('a.ts', 'foo'), removal('a.ts', 'Bar'), removal('a.ts', 'x$'), removal('a.ts', 'fooBar')], root).map(r => r.symbol), ['x$', 'fooBar'])
  })
})

test('repoRootOf finds the repository a directory is in, and says when there is none', () => {
  repo(root => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    assert.equal(repoRootOf(join(root, 'a', 'b')), root)
    assert.equal(repoRootOf(root), root)
  })
  scratch(config => assert.equal(repoRootOf(config), undefined))
})

test('render lists each undelivered removal on one line, and says none when nothing is left', () => {
  const journals = [{ plugin: 'github', unreadable: 0, events: [event('github', 1)] }]
  const text = render(summarize(journals, NOW), [removal('plugins/github/ready.ts', 'oldCheck'), removal('plugins/x.ts')])
  assert.match(text, /^undelivered removals, decided and still in the code:$/m)
  assert.match(text, /^ {2}plugins\/github\/ready\.ts::oldCheck +decided 2026-11-14T15:00:00Z \(p\)$/m)
  assert.match(text, /^ {2}plugins\/x\.ts +decided 2026-11-14T15:00:00Z \(p\)$/m)
  assert.match(render(summarize(journals, NOW), []), /^undelivered removals[^\n]*:\n {2}none$/m)
  assert.doesNotMatch(render(summarize(journals, NOW)), /undelivered removals/)
})

test('with no journal the report keeps its one line, and adds the undelivered removals when there are some', () => {
  const none = summarize([], NOW)
  assert.equal(render(none, []), 'learning health: no journal found, no plugin writes learning events yet.')
  assert.match(render(none, [removal('plugins/x.ts')]), /^learning health: no journal found[^\n]*\nundelivered removals[^\n]*:\n {2}plugins\/x\.ts /)
})

test('run reports the removals of the rulings under the configuration directory that the repository of the working directory still holds', () => {
  scratch(config => repo(root => {
    write(config, 'github', event('github', 45))
    rulings(config, 'claude-plugins', RULINGS)
    mkdirSync(join(root, 'plugins', 'github', 'hooks'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'github', 'hooks', 'ready.ts'), 'export function oldCheck() {}\n')
    const outs: string[] = []
    const deps = { out: (l: string) => outs.push(l), err: () => undefined, now: () => NOW, cwd: () => join(root, 'plugins') }
    assert.equal(run(['--config', config], deps), 0)
    const text = outs.join('\n')
    assert.match(text, /^ {2}plugins\/github\/hooks\/ready\.ts::oldCheck +decided 2026-11-14T15:01:00Z \(claude-plugins\)$/m)
    assert.doesNotMatch(text, /ready-old\.ts/)
    assert.match(text, /^ {2}github\.ready\.missing-review +github +45 days silent$/m)
  }))
})

test('run says none for the removals when the working directory is in no repository', () => {
  scratch(config => {
    write(config, 'github', event('github', 1))
    rulings(config, 'claude-plugins', RULINGS)
    const outs: string[] = []
    assert.equal(run(['--config', config], { out: l => outs.push(l), err: () => undefined, now: () => NOW, cwd: () => config }), 0)
    assert.match(outs.join('\n'), /^undelivered removals[^\n]*:\n {2}none$/m)
  })
})
