import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  entryQuestions, fencedLines, machineLine, markRow, nextRow, numberOfLine, openFence, outsideFences, parseChoices, parseState, questionBody,
  questionParts, questionShape, reportStatus, twoDigits,
} from './method.ts'

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

const SHAPED = [
  'Decision noted: B.',
  '',
  '**Question 5 sur 6**',
  '_Sujet_ : the numbering',
  '_Contexte_ : the pane shows « 1 sur 1 ».',
  'Two numbers for one question.',
  '_Question_ : which one?',
  '_Propositions_ :',
  '- **A** : the sender\'s',
  '- **B** : the pane\'s',
  '_Recommandation de l\'orchestrateur_ : A — one numbering',
  '',
  'You decide: A or B?',
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

  it('drops the choice lines and the recommendation from the body only when the choices were read', () => {
    const { choices } = parseChoices(DECIDE)
    assert.equal(questionBody({ question: DECIDE, choices }), [
      'Question 1 of 1 — merge the scraper pull request now?',
      '_Context._ It is green and reviewed.',
      'You decide: A, B or C?',
    ].join('\n'))
    assert.equal(questionBody({ question: 'Merge it?\n- **A** : alone\n', choices: [] }), 'Merge it?\n- **A** : alone')
    const question = 'Merge it?\n- **A** : one\n- **B** : two\n_Recommandation de l\'orchestrateur_ : B — the reason'
    assert.equal(parseChoices(question).recommendation, 'B')
    assert.equal(questionBody({ question, choices: parseChoices(question).choices }), 'Merge it?')
  })
})

describe('the question block', () => {
  it('reads the sender\'s numbering of a wholly bold line holding two numbers', () => {
    assert.equal(numberOfLine('**Question 2 of 3**'), 'Question 2 of 3')
    assert.equal(numberOfLine('  **Question 5 sur 6**  '), 'Question 5 sur 6')
    assert.equal(numberOfLine('**Question 3/4**'), 'Question 3/4')
    assert.equal(numberOfLine('**Important**'), null)
    assert.equal(numberOfLine('**Version 1.2**'), null)
    assert.equal(numberOfLine('**3 sur 4**'), null)
    assert.equal(numberOfLine('Question 1 of 2'), null)
  })

  it('gives the number, the labelled fields as written and the recommendation, nothing else', () => {
    const { choices } = parseChoices(SHAPED)
    assert.deepEqual(questionShape(SHAPED, choices), {
      number: 'Question 5 sur 6',
      fields: [
        { label: 'Sujet', separator: ' : ', text: 'the numbering' },
        { label: 'Contexte', separator: ' : ', text: 'the pane shows « 1 sur 1 ».\nTwo numbers for one question.' },
        { label: 'Question', separator: ' : ', text: 'which one?' },
        { label: 'Propositions', separator: ' : ', text: '' },
      ],
      recommendation: { label: 'Recommandation de l\'orchestrateur', separator: ' : ', text: 'A — one numbering' },
    })
  })

  it('reads the fields by their shape in any language, the separator as written', () => {
    const english = '**Question 2 of 3**\n_Subject_: the merge\n_Question_: merge it?\n- **A** : yes\n- **B** : no\n_Recommendation_: B'
    const shape = questionShape(english, parseChoices(english).choices)!
    assert.equal(shape.number, 'Question 2 of 3')
    assert.deepEqual(shape.fields.map(f => `${f.label}${f.separator}${f.text}`), ['Subject: the merge', 'Question: merge it?'])
    assert.deepEqual(shape.recommendation, { label: 'Recommendation', separator: ': ', text: 'B' })
  })

  it('has no number without a numbering line, and no recommendation from a field that names no letter', () => {
    const plain = '_Sujet_ : x\n_Question_ : y ?'
    assert.equal(questionShape(plain, [])!.number, null)
    assert.equal(questionShape(`**Important**\n${plain}`, [])!.number, null)
    const question = '_Question_ : y ?\n- **A** : one\n- **B** : two\n_Note_ : a cheap one\n_Recommandation_ : B\n_Autre_ : A'
    const shape = questionShape(question, parseChoices(question).choices)!
    assert.deepEqual(shape.fields.map(f => f.label), ['Question'])
    assert.deepEqual(shape.recommendation, { label: 'Recommandation', separator: ' : ', text: 'B' })
  })

  it('takes a free answer opening on the article A for no recommendation', () => {
    const five = [
      '**Question 2 of 3**', '_Subject_ : the release', '_Choices_ :',
      '- **A** : merge now', '- **B** : wait a day',
      '_Free answer_ : A different answer, in your own words.',
      '_Recommendation_ : B — one more review',
    ].join('\n')
    assert.match(questionShape(five, parseChoices(five).choices)!.recommendation!.text, /^B — /)
    const without = five.split('\n').slice(0, -1).join('\n')
    assert.equal(questionShape(without, parseChoices(without).choices)!.recommendation, null)
  })

  it('is no shaped question without a labelled field before its choices', () => {
    assert.equal(questionShape(DECIDE, parseChoices(DECIDE).choices), null)
    assert.equal(questionShape('Merge it?', []), null)
    assert.equal(questionShape('Question 1 of 1 — **merge** it?\n_Context._ The review is green.', []), null)
  })

  it('splits an entry of two numbered questions at each numbering line, the first keeping what precedes it', () => {
    const parts = questionParts(`Recorded: B.\n\n${TWO_QUESTIONS}`)
    assert.equal(parts.length, 2)
    assert.ok(parts[0]!.startsWith('Recorded: B.'))
    assert.ok(parts[0]!.includes('**Question 3 sur 4**'))
    assert.ok(!parts[0]!.includes('Question 4 sur 4'))
    assert.ok(parts[1]!.startsWith('**Question 4 sur 4**'))
    assert.deepEqual(questionParts('**Question 5 of 6**\n_Question_ : which?'), ['**Question 5 of 6**\n_Question_ : which?'])
    assert.deepEqual(questionParts('Merge it?'), ['Merge it?'])
  })

  it('does not split at two bold lines that are no numbering', () => {
    const text = '**Version 1.2**\n_Subject_ : a\n**Version 1.3**\n_Subject_ : b'
    assert.deepEqual(questionParts(text), [text])
    assert.equal(questionShape(text, [])!.number, null)
    assert.equal(questionParts('**Question 3/4**\n_Subject_ : a\n**Question 4/4**\n_Subject_ : b').length, 2)
    assert.equal(questionParts('**3 sur 4**\n_Subject_ : a\n**4 sur 4**\n_Subject_ : b').length, 1)
  })

  it('gives each of several questions its own choices, recommendation and number, whatever the entry recorded', () => {
    const stale = [{ letter: 'A', text: 'stale one' }, { letter: 'B', text: 'stale two' }]
    const parts = entryQuestions({ question: TWO_QUESTIONS, choices: stale, recommendation: 'B' })
    assert.deepEqual(parts.map(part => [part.number, part.choices.map(c => c.text), part.recommendation]), [
      ['Question 3 sur 4', ['1.15.0', '2.0.0'], 'A'],
      ['Question 4 sur 4', ['one per module', 'one at the end'], 'B'],
    ])
    const shape = questionShape(parts[1]!.question, parts[1]!.choices)!
    assert.deepEqual(shape.fields.map(f => f.label), ['Sujet', 'Question', 'Choix'])
  })

  it('keeps the choices an entry of one question recorded', () => {
    const choices = [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }]
    assert.deepEqual(entryQuestions({ question: 'Merge it?', choices, recommendation: 'B' }), [
      { question: 'Merge it?', number: null, choices, recommendation: 'B' },
    ])
  })

  it('records the first question\'s choices as an entry\'s, the others read from their text', () => {
    assert.deepEqual(parseChoices(TWO_QUESTIONS).choices.map(c => c.text), ['1.15.0', '2.0.0'])
    assert.equal(parseChoices(TWO_QUESTIONS).recommendation, 'A')
  })
})

describe('the code fences a message is read outside of', () => {
  const BLOCK = ['**Question 1 of 1**', '_Subject_ : a thing'].join('\n')

  it('drops a fenced block, whatever its marker, and keeps the text around it', () => {
    assert.equal(outsideFences(`before\n\`\`\`\n${BLOCK}\n\`\`\`\nafter`), 'before\nafter')
    assert.equal(outsideFences(`before\n~~~\n${BLOCK}\n~~~\nafter`), 'before\nafter')
    assert.equal(outsideFences('no fence'), 'no fence')
  })

  it('closes a fence only on its own marker, at least as long as the opening one', () => {
    assert.equal(outsideFences(['````', BLOCK, '```', '````', 'after'].join('\n')), 'after')
    assert.equal(outsideFences(['```', '~~~', BLOCK, '```', 'after'].join('\n')), 'after')
    assert.equal(outsideFences(['```', 'closed ``` on a text line', '```', 'after'].join('\n')), 'after')
  })

  it('runs a fence never closed to the end, and says which marker is open', () => {
    assert.equal(outsideFences(`before\n\`\`\`\n${BLOCK}`), 'before')
    assert.equal(openFence(`before\n\`\`\`\n${BLOCK}`), '```')
    assert.equal(openFence('````\ntext\n```'), '````')
    assert.equal(openFence(`\`\`\`\n${BLOCK}\n\`\`\`\nafter`), null)
  })

  it('says which lines are fence lines or inside a fenced block', () => {
    assert.deepEqual(fencedLines('a\n```\nb\n```\nc'), [false, true, true, true, false])
  })
})
