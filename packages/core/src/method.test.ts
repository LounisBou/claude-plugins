import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { machineLine, markRow, nextRow, parseChoices, parseState, reportStatus, twoDigits } from './method.ts'

const STATE = `**Codename**: demo
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
  it('reads the header and the rows', () => {
    const state = parseState(STATE)
    assert.equal(state.codename, 'demo')
    assert.equal(state.base, 'abc1234')
    assert.deepEqual(state.rows.map(row => [row.phase, row.status, row.milestone]), [['01', 'done', '82525e4'], ['02', 'doing', '9f31a0c'], ['03', 'todo', '']])
    assert.equal(parseState('nothing here').codename, null)
  })

  it('names the first row not done, or none', () => {
    assert.equal(nextRow(parseState(STATE).rows)?.phase, '02')
    assert.equal(nextRow([{ phase: '01', title: 't', status: 'done', milestone: 'abc1' }]), null)
  })

  it('writes a number on two digits, and refuses what is not one', () => {
    assert.equal(twoDigits(3), '03')
    assert.equal(twoDigits('003'), '03')
    assert.equal(twoDigits('x'), null)
  })

  it('rewrites one row in place, a todo row without its milestone', () => {
    const done = markRow(STATE, 2, 'done', 'deadbee')
    assert.ok('text' in done)
    assert.match(done.text, /^\| 02 \| the core \| done \| deadbee \|$/m)
    assert.match(done.text, /^\| 01 \| the skeleton \| done \| 82525e4 \|$/m)
    const todo = markRow(STATE, '1', 'todo', 'abc1234')
    assert.ok('row' in todo)
    assert.equal(todo.row.milestone, '')
  })

  it('says what is wrong with a mark', () => {
    assert.deepEqual(markRow(STATE, 'x', 'done', 'abc1234'), { error: 'not a phase number: x' })
    assert.deepEqual(markRow(STATE, 2, 'finished', 'abc1234'), { error: 'status must be todo, doing or done, not finished' })
    assert.deepEqual(markRow(STATE, 2, 'done', 'HEAD'), { error: 'a done row needs a commit sha as its milestone, not "HEAD"' })
    assert.deepEqual(markRow(STATE, 9, 'done', 'abc1234'), { error: 'no row 09 in the state table' })
  })
})

describe('the report status', () => {
  it('reads the last non-empty line, with or without its reason', () => {
    assert.deepEqual(reportStatus('branch: feat/x\nstatus: done — all phases green\n\n'), { status: 'done', reason: 'all phases green' })
    assert.deepEqual(reportStatus('status: question'), { status: 'question', reason: '' })
    assert.deepEqual(reportStatus('status: blocked — gate red'), { status: 'blocked', reason: 'gate red' })
  })

  it('reads no status from another ending or another word', () => {
    assert.equal(reportStatus('status: done\nmore text'), null)
    assert.equal(reportStatus('status: DONE_WITH_CONCERNS'), null)
    assert.equal(reportStatus(''), null)
  })
})

describe('the status line, read the way a model writes it', () => {
  it('reads every dash, any case, and a colon after the word', () => {
    assert.deepEqual(reportStatus('status: blocked - the fixture is missing'), { status: 'blocked', reason: 'the fixture is missing' })
    assert.deepEqual(reportStatus('Status: Done -- all green'), { status: 'done', reason: 'all green' })
    assert.deepEqual(reportStatus('status: question – merge order'), { status: 'question', reason: 'merge order' })
    assert.deepEqual(reportStatus('status: done: PR 12'), { status: 'done', reason: 'PR 12' })
  })

  it('reads `waiting` while an agent\'s own background work runs', () => {
    assert.deepEqual(reportStatus('status: waiting — ci-watch 12'), { status: 'waiting', reason: 'ci-watch 12' })
    assert.deepEqual(reportStatus('status: waiting'), { status: 'waiting', reason: '' })
  })

  it('drops the markup around the line, and one closing period', () => {
    assert.deepEqual(reportStatus('PR 12, 40/40.\n**status: done — PR 12**'), { status: 'done', reason: 'PR 12' })
    assert.deepEqual(reportStatus('> status: done — ok.'), { status: 'done', reason: 'ok' })
    assert.deepEqual(reportStatus('- `status: question`'), { status: 'question', reason: '' })
  })

  it('reads no status from a word that only starts with one, nor from a machine line', () => {
    assert.equal(reportStatus('status: doneish'), null)
    assert.equal(reportStatus('waiting: operator — blocks: phase 3'), null)
    assert.equal(reportStatus('I keep working.'), null)
  })
})

describe('the last line a message ends on', () => {
  it('is the last non-empty line with its markup dropped', () => {
    assert.equal(machineLine('a report\n`waiting: operator — blocks: the report`.'), 'waiting: operator — blocks: the report')
    assert.equal(machineLine('> waiting: done'), 'waiting: done')
    assert.equal(machineLine('- *waiting: done*'), 'waiting: done')
    assert.equal(machineLine('Waiting:  operator – blocks: x'), 'Waiting:  operator – blocks: x')
    assert.equal(machineLine('waiting: operator-blocks: stand-by'), 'waiting: operator-blocks: stand-by')
    assert.equal(machineLine('text\n\n  \n'), 'text')
    assert.equal(machineLine(''), '')
  })
})

const DECIDE = [
  'Question 1 of 1 — merge the scraper pull request now?',
  '_Context._ It is green and reviewed.',
  '- **A** : merge it now — one click, the release goes out today',
  '- **B** : wait for the next review — a day lost, one more pair of eyes',
  '- **C** : close it — the work is dropped',
  '_Recommendation_ : A — it is green and nothing waits on it',
  'You decide: A, B or C?',
].join('\n')

const TWO_QUESTIONS = [
  '**Question 3 sur 4**',
  '_Sujet_ : version',
  '_Question_ : which number?',
  '_Choix_ :',
  '- **A** : 1.15.0',
  '- **B** : 2.0.0',
  '_Recommandation_ : A. The API is unchanged.',
  '',
  '**Question 4 sur 4**',
  '_Sujet_ : rhythm',
  '_Question_ : one release per module?',
  '_Choix_ :',
  '- **A** : one per module',
  '- **B** : one at the end',
  '_Recommandation_ : B. One bump per application.',
].join('\n')

describe('the lettered choices and the recommendation', () => {
  it('reads the choices of a question in the decide shape and its recommendation', () => {
    assert.deepEqual(parseChoices(DECIDE), {
      choices: [
        { letter: 'A', text: 'merge it now — one click, the release goes out today' },
        { letter: 'B', text: 'wait for the next review — a day lost, one more pair of eyes' },
        { letter: 'C', text: 'close it — the work is dropped' },
      ],
      recommendation: 'A',
    })
  })

  it('reads every separator the shape allows, five choices at most', () => {
    const question = ['* **A**. first', '- **B**) second', '  - **C** — third', '- **D** – fourth', '- **E** - fifth  ', '_Recommendation_ : C'].join('\n')
    assert.deepEqual(parseChoices(question).choices.map(c => [c.letter, c.text]), [['A', 'first'], ['B', 'second'], ['C', 'third'], ['D', 'fourth'], ['E', 'fifth']])
    assert.equal(parseChoices(question).recommendation, 'C')
    assert.equal(parseChoices('- **A**: one\n- **B**: two\n_Recommended._ B').recommendation, 'B')
    assert.equal(parseChoices('- **A**: one\n- **B**: two\n_Recommendation_ : B. one more review').recommendation, 'B')
    assert.equal(parseChoices('- **A**: one\n- **B**: two\n_Recommendation_: **A** — it ships today').recommendation, 'A')
  })

  it('reads no choice from a lone, unordered, repeated or sixth letter, nor from none', () => {
    for (const question of [
      '- **A** : the only one\n_Recommendation_ : A',
      '- **A** : one\n- **C** : two\n_Recommendation_ : A',
      '- **B** : one\n- **C** : two\n_Recommendation_ : B',
      '- **A** : one\n- **A** : two\n_Recommendation_ : A',
      '- **A** : 1\n- **B** : 2\n- **C** : 3\n- **D** : 4\n- **E** : 5\n- **F** : 6\n_Recommendation_ : A',
      'Merge it now?\n_Recommendation_ : A',
    ]) assert.deepEqual(parseChoices(question), { choices: [], recommendation: null })
  })

  it('names a recommendation only by its shape: a label, then a lone letter of a kept choice', () => {
    const choices = '- **A** : one\n- **B** : two\n'
    assert.equal(parseChoices(`${choices}_Context._ A new pane`).recommendation, null)
    assert.equal(parseChoices(`${choices}Recommendation: B`).recommendation, null)
    assert.equal(parseChoices(`${choices}_Context._ A new pane\n_Recommendation_ : B`).recommendation, 'B')
    assert.equal(parseChoices(`${choices}_Recommendation_ : C`).recommendation, null)
    assert.equal(parseChoices(`${choices}_Recommendation_ : D\n_Recommendation_ : B`).recommendation, null)
    assert.equal(parseChoices(`${choices}_Recommendation_ : a cheap one`).recommendation, null)
    assert.equal(parseChoices(`${choices}_Recommendation_ : B the cheapest`).recommendation, null)
    assert.equal(parseChoices(choices).recommendation, null)
  })

  it('reads a recommendation whose label holds several words', () => {
    const question = 'Merge it?\n- **A** : one\n- **B** : two\n_Recommandation de l\'orchestrateur_ : B — the reason'
    assert.equal(parseChoices(question).recommendation, 'B')
  })
})

// A turn end that restates the lettered choices in a prose summary above its question block: the
// real case of the succession brief, claude-code#46's question.
const RESTATED = [
  '**Question pour vous (claude-code#46, activation de la télémétrie).** La PR porte maintenant `Ready`. Je vous ai envoyé la question dans le volet de supervision :',
  '- **A, ma recommandation** : vous la sortez du brouillon et la squash-mergez sur GitHub maintenant.',
  '- **B** : je le fais après la prochaine release, sur votre « Accorder ».',
  '',
  '**Question 1 of 1**',
  '_Subject_ : sortie de brouillon et merge de claude-code#46',
  '_Question_ : Qui sort claude-code#46 de brouillon et la merge ?',
  '_Choices_ :',
  '- **A** : vous, sur GitHub, maintenant — cost: deux clics — gain: télémétrie active tout de suite',
  '- **B** : moi, après la release — cost: attendre — gain: aucun geste de votre part',
  '_Free answer_ : ou répondez avec vos mots',
  '_Recommendation_ : A — la PR est prête maintenant.',
].join('\n')

describe('a question whose choices a prose summary restates above it', () => {
  it('reads the choices of the question block only, each letter once, with its recommendation', () => {
    const read = parseChoices(RESTATED)
    assert.deepEqual(read.choices.map(c => [c.letter, c.text.split(' — ')[0]]), [
      ['A', 'vous, sur GitHub, maintenant'],
      ['B', 'moi, après la release'],
    ])
    assert.equal(read.recommendation, 'A')
  })
})

describe('the question block', () => {
  it('records the first question\'s choices as an entry\'s, the others read from their text', () => {
    assert.deepEqual(parseChoices(TWO_QUESTIONS).choices.map(c => c.text), ['1.15.0', '2.0.0'])
    assert.equal(parseChoices(TWO_QUESTIONS).recommendation, 'A')
  })
})

