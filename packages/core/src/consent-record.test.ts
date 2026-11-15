import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answersChoice, leadingChoice, namesOtherSubject, opensChoice, grants, CONSENT_GRANT, CONSENT_REFUSE, consentAnswer, givenAnswer, consentDir, consentRecordOf, consentPath, parseConsentRecord, parseConsentSubject, quotesConsent } from './consent-record.ts'
import { kindFor, producersOf } from './pr-record.ts'

const RECORD = {
  v: 1, subject: { kind: 'e2e-waiver', repo: 'Owner/name', pr: 7 }, entry: 's1-abc',
  question: 'Waive E2E on name#7?', answer: 'yes, no E2E for this one, 2026-11-08', by: 'pane', at: '2026-11-08T00:00:00Z',
}

const SUBJECT = { kind: 'e2e-waiver' as const, repo: 'Acme/App', pr: 7 }
const LEADING = { subject: SUBJECT }

describe('consent records', () => {
  it('reads a record that keeps the contract', () => {
    assert.deepEqual(parseConsentRecord(RECORD), RECORD)
    for (const by of ['pane', 'coordinator', 'tab']) assert.equal(parseConsentRecord({ ...RECORD, by })?.by, by)
    assert.deepEqual(parseConsentSubject({ kind: 'auto-merge', repo: 'o/n' }), { kind: 'auto-merge', repo: 'o/n' })
    assert.deepEqual(parseConsentSubject({ kind: 'norms-waiver', repo: 'o/n', pr: 3 }), { kind: 'norms-waiver', repo: 'o/n', pr: 3 })
  })

  it('refuses a record or a subject that breaks any field of it', () => {
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { subject: null }, { subject: { kind: 'e2e-waiver', repo: 'o/n' } }, { subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 0 } }, { subject: { kind: 'norms-waiver', repo: 'o/n' } },
      { subject: { kind: 'auto-merge', repo: 'o/n', pr: 3 } }, { subject: { kind: 'merge', repo: 'o/n' } }, { subject: { kind: 'auto-merge', repo: 'o/..' } },
      { entry: '../x' }, { entry: 3 }, { question: 3 }, { answer: 'x'.repeat(20_001) }, { by: 'elsewhere' }, { at: 0 },
    ]
    for (const change of broken) assert.equal(parseConsentRecord({ ...RECORD, ...change }), undefined, JSON.stringify(change))
    for (const raw of [null, [], 'record']) assert.equal(parseConsentRecord(raw), undefined)
    assert.equal(parseConsentSubject([]), undefined)
  })

  it('files a record under its repository, the repository as GitHub compares it', () => {
    const record = parseConsentRecord(RECORD)!
    assert.equal(consentDir('/c', 'Owner/Name'), '/c/consents/owner/name')
    assert.equal(consentPath('/c', record), '/c/consents/owner/name/s1-abc.json')
  })

  it('takes a pressed choice for its text, and any other answer whole', () => {
    const choices = [{ letter: 'A', text: ' waive it on name#7 ' }, { letter: 'B', text: 'run it' }]
    assert.equal(consentAnswer('a : waive it on name#7', choices), 'waive it on name#7')
    assert.equal(consentAnswer('C', choices), '')
    assert.equal(consentAnswer('  go without it  ', choices), 'go without it')
  })

  it('takes a plain confirmation after « Accorder » for the choice, so that it grants', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    for (const answer of ['Accorder, merci', 'accorder et fusionner', 'ACCORDER — go !', 'Accorder. Merci, vas-y', 'Accorder pour acme/app#7', 'Accorder #7 merci']) {
      assert.equal(consentAnswer(answer, choices, LEADING), 'Accorder', answer)
    }
    for (const answer of ['Accorder, merci', 'accorder et fusionner', 'ACCORDER — go !', 'Accorder pour acme/app#7', 'Accorder #7 merci']) {
      assert.equal(grants(consentAnswer(answer, choices, LEADING)), true, answer)
      assert.equal(grants(consentAnswer(answer, choices)), false, answer)
    }
    for (const answer of ['Accorderai', 'Accorderé', 'Accordée', 'je dis Accorder', 'peut-être']) assert.equal(consentAnswer(answer, choices, LEADING), answer, answer)
  })

  it('records nothing for an answer that adds a limit, a condition, a question or another subject after « Accorder »: any word outside a plain confirmation', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }, { letter: 'C', text: 'Accorder sous conditions' }]
    for (const answer of [
      "Accorder la dispense et fusionner. Valable jusqu'au 16/11/2026 12h00", 'Accorder uniquement pour la PR 32', 'Accorder seulement le e2e', 'Accorder après la revue',
      'Accorder quand la CI est verte', 'Accorder pendant une heure', 'Accorder, attends mon feu vert', 'Accorder, wait for me', 'Accorder, annule', 'Accorder, stop',
      'Accorder, ne fais rien', 'Accorder; refuse', 'Accorder, par contre refuse le deploy', 'Accorder: refuse tout', 'Accorder ?', 'Accorder pas', 'Accorder jamais',
      'Accorder: non', 'Accorder ou refuser', 'Accorder (A) Refuser', 'Accorder (A) (B)', 'Accorder (B)', 'Accorder, mais pas avant lundi', 'Accorder sauf si la CI casse',
      'Accorder, sous conditions', 'Accorder pour acme/other#32', 'Accorder acme/other', 'Accorder pour #8 seulement', 'Accorder acme/app#77',
    ]) {
      assert.equal(leadingChoice(answer, choices, SUBJECT), undefined, answer)
      assert.equal(consentAnswer(answer, choices, LEADING), '', answer)
    }
    assert.equal(leadingChoice('Accorder sous conditions, merci', choices, SUBJECT)?.letter, 'C')
    assert.equal(leadingChoice('yes or no', [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'yes' }], SUBJECT), undefined)
    assert.equal(opensChoice('Accorder, mais', choices), true)
    assert.equal(opensChoice('peut-être', choices), false)
  })

  it('takes the limit of an exemption\'s answer that is the limit of the question, the same instant read in Paris time, and no other: its words kept whole', () => {
    const exemption = { kind: 'e2e-exemption' as const, repo: 'Acme/App' }
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    const sentence = "Accorder la dispense de app et fusionner les PRS. Dispense valable jusqu'au 16/11/2026 12h00 heure de Paris !"
    const asked = (until: string) => `Exempt acme/app from E2E until ${until}?`
    const given = (answer: string, question: string) => consentAnswer(answer, choices, { subject: exemption, question })
    assert.equal(given(sentence, asked('2026-11-16T11:00:00Z')), sentence)
    assert.equal(given("Accorder, valable jusqu'au 16/11/2026 11:00 UTC", asked('2026-11-16T11:00:00Z')), "Accorder, valable jusqu'au 16/11/2026 11:00 UTC")
    assert.equal(given("Accorder jusqu'au 2026-11-16T11:00:00Z, merci", asked('2026-11-16T11:00:00Z')), "Accorder jusqu'au 2026-11-16T11:00:00Z, merci")
    assert.equal(given("Accorder jusqu'au 16/07/2026 12h00 heure de Paris", asked('2026-07-16T10:00:00Z')), "Accorder jusqu'au 16/07/2026 12h00 heure de Paris")
    for (const until of ['2026-11-16T12:00:00Z', '2026-11-16T10:00:00Z', '2026-11-17T11:00:00Z']) assert.equal(given(sentence, asked(until)), '', until)
    assert.equal(given(sentence, 'Exempt acme/app from E2E?'), '')
    assert.equal(given(sentence.replace('de app', 'de lib/other'), asked('2026-11-16T11:00:00Z')), '')
    assert.equal(given(sentence.replace('jusqu\'au 16/11/2026 12h00', 'jusqu\'au 16/11/2026'), asked('2026-11-16T11:00:00Z')), '')
    assert.equal(given(`${sentence} Seulement le e2e`, asked('2026-11-16T11:00:00Z')), '')
  })

  it('takes no limit of an answer for a kind that expires nothing, even the question\'s own', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    const sentence = "Accorder, valable jusqu'au 16/11/2026 12h00 heure de Paris"
    const question = 'Allow it until 2026-11-16T11:00:00Z?'
    for (const subject of [{ kind: 'e2e-waiver' as const, repo: 'Acme/App', pr: 7 }, { kind: 'norms-waiver' as const, repo: 'Acme/App', pr: 7 }, { kind: 'auto-merge' as const, repo: 'Acme/App' }, { kind: 'auto-deploy' as const, repo: 'Acme/App', env: 'prod' as const }]) {
      assert.equal(consentAnswer(sentence, choices, { subject, question }), '', subject.kind)
    }
    assert.equal(consentAnswer('Accorder, merci', choices, { subject: { kind: 'auto-merge' as const, repo: 'Acme/App' }, question }), 'Accorder')
  })

  it('keeps whole the answer of an exemption that scopes it with a label or a path, and records nothing for a word that sets a limit or widens it', () => {
    const exemption = { kind: 'e2e-exemption' as const, repo: 'Acme/App' }
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    const given = (answer: string) => consentAnswer(answer, choices, { subject: exemption, question: 'Exempt acme/app from E2E?' })
    for (const answer of [
      'Accorder la dispense de app pour les PR avec le label no-e2e', 'Accorder la dispense de app pour les PR avec le label no-e2e, merci.', 'Accorder la dispense de app (paths docs/)',
      'Accorder la dispense de acme/app pour les PR avec les labels no-e2e, docs-only', 'Accorder la dispense de app pour les paths docs/ ou src/**/*.md', 'Accorder la dispense de app, labels no-e2e et paths docs/',
      'Accorder la dispense de app pour les PR avec le label "no-e2e".', 'Accorder la dispense de app, label no-e2e ou label wip',
    ]) assert.equal(given(answer), answer, answer)
    for (const answer of [
      'Accorder la dispense de app sauf pour docs/', 'Accorder la dispense de app sans le label no-e2e', "Accorder la dispense de app avec le label no-e2e jusqu'à demain",
      'Accorder la dispense de app avec le label no-e2e seulement demain', 'Accorder la dispense de app avec le label no-e2e, demain', 'Accorder la dispense de app sur docs/',
      'Accorder la dispense de app avec le label #8', 'Accorder la dispense de app avec le label no-e2e ?', 'Accorder la dispense de app avec le label no-e2e; refuse le reste',
      'Accorder la dispense de app uniquement le e2e', 'Accorder la dispense de app pour les PR avec le label no-e2e ou docs', 'Accorder la dispense de app pour les PR avec le label no-e2e et acme/other#3',
    ]) assert.equal(given(answer), '', answer)
  })

  it('keeps whole an exemption\'s grant that words the exemption as github reads it', () => {
    const exemption = { kind: 'e2e-exemption' as const, repo: 'Acme/App' }
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    for (const answer of [
      "Accorder l'exemption de app", 'Accorder la dérogation E2E sur app', 'Accorder exempt app', "Accorder l'exonération de app", "Accorder, app exonérée", 'Accorder la derogation de app',
      'Accorder, waive E2E on acme/app', 'Accorder la dispense de app',
    ]) assert.equal(consentAnswer(answer, choices, { subject: exemption }), answer, answer)
    for (const answer of ["Accorder l'exemption de app et jusqu'à lundi", 'Accorder la dérogation E2E sur app seulement', 'Accorder exempt app sauf docs/']) {
      assert.equal(consentAnswer(answer, choices, { subject: exemption }), '', answer)
    }
  })

  it('reads the words of an exemption only for an exemption: no other kind takes a scope or its exemption words', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    for (const subject of [{ kind: 'e2e-waiver' as const, repo: 'Acme/App', pr: 7 }, { kind: 'norms-waiver' as const, repo: 'Acme/App', pr: 7 }, { kind: 'auto-merge' as const, repo: 'Acme/App' }, { kind: 'auto-deploy' as const, repo: 'Acme/App', env: 'prod' as const }]) {
      for (const answer of ['Accorder la dispense de app pour les PR avec le label no-e2e', "Accorder l'exemption de app", 'Accorder la dérogation E2E sur app']) {
        assert.equal(consentAnswer(answer, choices, { subject }), '', `${subject.kind}: ${answer}`)
      }
    }
  })

  it('records « Refuser » for an exemption refused in words that name the repository, the exemption and its rules: github reads no refusal as a grant', () => {
    const exemption = { kind: 'e2e-exemption' as const, repo: 'Acme/App' }
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    for (const answer of ['Refuser la dispense de app', 'Refuser la dispense de app pour les PR avec le label no-e2e', "Refuser l'exemption de acme/app (paths docs/)"]) {
      assert.equal(consentAnswer(answer, choices, { subject: exemption, question: 'Exempt acme/app from E2E?' }), 'Refuser', answer)
      const record = consentRecordOf({ subject: exemption, entry: 'q-a', question: 'Exempt acme/app from E2E?', answer, choices, by: 'coordinator', at: '2026-11-15T10:00:00Z' })
      assert.equal(record?.answer, 'Refuser', answer)
    }
  })

  it('names another pull request or repository in the words, not the subject\'s own', () => {
    for (const typed of ['pour acme/other#32', 'acme/other', 'acme/app#8', '#8', 'pour #70']) assert.equal(namesOtherSubject(typed, SUBJECT), true, typed)
    for (const typed of ['pour acme/app#7', 'Acme/App', '#7', 'merci', "jusqu'au 16/11/2026"]) assert.equal(namesOtherSubject(typed, SUBJECT), false, typed)
    assert.equal(namesOtherSubject('acme/app#7 et acme/lib', SUBJECT), true)
    assert.equal(namesOtherSubject('acme/app and #7', { kind: 'auto-merge', repo: 'acme/app' }), true)
  })

  it('takes any words after « Refuser » for a refusal: it never widens a consent', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    for (const answer of ['Refuser, pas ce soir', 'Refuser — merci', 'refuser (A)', 'Refuser pour acme/other#32']) {
      assert.equal(consentAnswer(answer, choices, LEADING), 'Refuser', answer)
      assert.equal(grants(consentAnswer(answer, choices, LEADING)), false, answer)
    }
  })

  it('files a record from an answer opening with the choice only by the coordinator or the pane, never by a tab, and none for a limit', () => {
    const fields = { subject: SUBJECT, entry: 's-1', question: 'Waive E2E?', choices: [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }], at: '2026-11-10T00:00:00Z', answer: 'Accorder, et fusionne' }
    for (const by of ['coordinator', 'pane'] as const) assert.equal(consentRecordOf({ ...fields, by })?.answer, 'Accorder', by)
    assert.equal(consentRecordOf({ ...fields, by: 'tab' })?.answer, 'Accorder, et fusionne')
    for (const by of ['coordinator', 'pane'] as const) assert.equal(consentRecordOf({ ...fields, by, answer: 'Accorder jusqu\'au 16/11' }), undefined, by)
    assert.equal(consentRecordOf({ ...fields, by: 'tab', answer: 'Accorder jusqu\'au 16/11' })?.answer, 'Accorder jusqu\'au 16/11')
  })

  it('takes a choice pressed as its text then its letter in parentheses for its text, so that it grants', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    assert.equal(consentAnswer('Accorder (A)', choices), 'Accorder')
    assert.equal(consentAnswer(' accorder  (a) ', choices), 'Accorder')
    assert.equal(consentAnswer('Refuser (B)', choices), 'Refuser')
    assert.equal(grants(consentAnswer('Accorder (A)', choices)), true)
    assert.equal(consentAnswer('Accorder (B)', choices), 'Accorder (B)')
    assert.equal(answersChoice('Accorder (A)', choices)?.letter, 'A')
  })

  it('gives an answer as the choice its letter names, letter and text, or as his own words', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    assert.deepEqual(givenAnswer('A : Accorder', choices), { letter: 'A', text: 'Accorder' })
    assert.deepEqual(givenAnswer('b — refuse it', choices), { letter: 'B', text: 'Refuser' })
    assert.deepEqual(givenAnswer('B', choices), { letter: 'B', text: 'Refuser' })
    assert.deepEqual(givenAnswer('  I would wait a day  ', choices), { letter: null, text: 'I would wait a day' })
    assert.deepEqual(givenAnswer('C', choices), { letter: null, text: 'C' })
  })

  it('lets a quote rest on the record of its own subject only, its answer held whole', () => {
    const record = parseConsentRecord(RECORD)!
    const subject = { kind: 'e2e-waiver', repo: 'owner/NAME', pr: 7 } as const
    assert.ok(quotesConsent(record, subject, 'operator:  yes, no E2E\nfor this one, 2026-11-08'))
    assert.ok(!quotesConsent(record, { ...subject, pr: 8 }, RECORD.answer))
    assert.ok(!quotesConsent(record, { kind: 'auto-merge', repo: 'owner/name' }, RECORD.answer))
    assert.ok(!quotesConsent(record, { ...subject, repo: 'other/name' }, RECORD.answer))
    assert.ok(!quotesConsent(record, subject, 'yes, no E2E'))
    const short = parseConsentRecord({ ...RECORD, answer: 'yes' })!
    assert.ok(!quotesConsent(short, subject, 'yes'))
    const merge = parseConsentRecord({ ...RECORD, subject: { kind: 'auto-merge', repo: 'owner/name' }, answer: 'auto-merge name, yes' })!
    assert.ok(quotesConsent(merge, { kind: 'auto-merge', repo: 'OWNER/name' }, 'auto-merge name, yes'))
  })

  it('reads an E2E exemption of a repository, which names no pull request and carries no other subject', () => {
    assert.deepEqual(parseConsentSubject({ kind: 'e2e-exemption', repo: 'o/n' }), { kind: 'e2e-exemption', repo: 'o/n' })
    assert.equal(parseConsentSubject({ kind: 'e2e-exemption', repo: 'o/n', pr: 3 }), undefined)
    const words = 'no E2E on this repository, 2026-11-13'
    const exemption = parseConsentRecord({ ...RECORD, subject: { kind: 'e2e-exemption', repo: 'owner/name' }, answer: words })!
    assert.ok(quotesConsent(exemption, { kind: 'e2e-exemption', repo: 'OWNER/name' }, words))
    assert.ok(!quotesConsent(exemption, { kind: 'auto-merge', repo: 'owner/name' }, words))
    assert.ok(!quotesConsent(exemption, { kind: 'e2e-waiver', repo: 'owner/name', pr: 7 }, words))
  })

  it('reads an auto-deploy of a repository in one environment, which carries both and no pull request', () => {
    assert.deepEqual(parseConsentSubject({ kind: 'auto-deploy', repo: 'o/n', env: 'staging' }), { kind: 'auto-deploy', repo: 'o/n', env: 'staging' })
    for (const env of ['dev', 'staging', 'prod']) assert.ok(parseConsentSubject({ kind: 'auto-deploy', repo: 'o/n', env }))
    for (const bad of [{}, { env: 'production' }, { env: 3 }, { env: 'staging', pr: 3 }]) {
      assert.equal(parseConsentSubject({ kind: 'auto-deploy', repo: 'o/n', ...bad }), undefined, JSON.stringify(bad))
    }
    assert.equal(parseConsentSubject({ kind: 'auto-merge', repo: 'o/n', env: 'staging' }), undefined)
  })

  it('lets an auto-deploy quote rest on the record of its own environment only', () => {
    const words = 'auto-deploy name on staging, yes'
    const record = parseConsentRecord({ ...RECORD, subject: { kind: 'auto-deploy', repo: 'owner/name', env: 'staging' }, answer: words })!
    assert.ok(quotesConsent(record, { kind: 'auto-deploy', repo: 'OWNER/name', env: 'staging' }, words))
    assert.ok(!quotesConsent(record, { kind: 'auto-deploy', repo: 'owner/name', env: 'prod' }, words))
    assert.ok(!quotesConsent(record, { kind: 'auto-merge', repo: 'owner/name' }, words))
  })
})

describe('a consent record of a round answer', () => {
  const fields = {
    subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 3 }, entry: 's-1', question: 'Waive E2E?', answer: 'A : waive it, docs only',
    choices: [{ letter: 'A', text: 'waive it, docs only' }], by: 'pane' as const, at: '2026-11-08T00:00:00Z',
  }

  it('holds the answer as a quote must hold it', () => {
    assert.equal(consentRecordOf(fields)?.answer, 'waive it, docs only')
  })

  it('is none when there is nothing to quote, or the subject or the id breaks the contract', () => {
    assert.equal(consentRecordOf({ ...fields, answer: 'B' }), undefined)
    assert.equal(consentRecordOf({ ...fields, subject: { kind: 'e2e-waiver', repo: 'o/n' } }), undefined)
    assert.equal(consentRecordOf({ ...fields, entry: '../x' }), undefined)
  })
})

describe('the answer that grants', () => {
  it('is « Accorder » alone, case and spacing aside', () => {
    for (const answer of [CONSENT_GRANT, ' accorder ', 'ACCORDER']) assert.equal(grants(answer), true, answer)
  })

  it('is not « Refuser », a refusal in words, or an answer that only mentions the grant', () => {
    for (const answer of [CONSENT_REFUSE, 'ne pas passer thing en auto-merge', 'oui, thing passe en auto-merge', 'Accorder, mais pas ce soir', '']) assert.equal(grants(answer), false, answer)
  })
})

describe('words typed in the sender\'s own tab', () => {
  const choices = [{ letter: 'A', text: 'waive it, docs only' }, { letter: 'B', text: 'run the E2E' }]
  const [waive, run] = choices

  it('answers a choice by its letter alone, its letter set apart from nothing or its exact text, or its exact text alone', () => {
    for (const typed of ['A', ' a ', 'a)', 'A.', 'a) waive it, docs only', 'A — waive it,  docs only', 'A—waive it, docs only', 'a - WAIVE IT, docs only', 'waive it, docs only', '  WAIVE it,\n docs only ']) {
      assert.deepEqual(answersChoice(typed, choices), waive, typed)
    }
    for (const typed of ['b', 'B : run the e2e', 'RUN THE E2E']) assert.deepEqual(answersChoice(typed, choices), run, typed)
    for (const typed of ['waive it, docs only (A)', 'Waive it, docs only (a)', 'waive it, docs only  ( A )']) assert.deepEqual(answersChoice(typed, choices), waive, typed)
  })

  it('is no answer when it is anything else', () => {
    for (const typed of [
      '', 'C', 'C)', 'yes', 'go on with phase 2',
      'do not waive it, docs only', 'I say WAIVE IT, docs only, thanks', 'ok: waive it, docs only',
      'B waive it, docs only', 'B : waive it, docs only', 'A run the E2E', 'A - but not yet', 'A, but check the diff first', 'A go', 'a) yes',
      'waive it, docs only (B)', 'run the E2E (A)', 'yes (A)', '(A)',
    ]) assert.equal(answersChoice(typed, choices), undefined, typed)
    assert.equal(answersChoice('anything', []), undefined)
  })

  it('is no answer when a short choice text sits inside an unrelated prompt', () => {
    const short = [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }]
    assert.deepEqual(answersChoice('Yes', short), short[0])
    for (const typed of ['yes, and then rebase the branch on main', 'no idea, go on', 'B yes']) assert.equal(answersChoice(typed, short), undefined, typed)
  })

  it('files a record by the tab, a letter resolved to its text', () => {
    const fields = { subject: { kind: 'e2e-waiver', repo: 'o/n', pr: 3 }, entry: 's-1', question: 'Waive E2E?', choices, by: 'tab' as const, at: '2026-11-10T00:00:00Z' }
    assert.equal(consentRecordOf({ ...fields, answer: 'A' })?.by, 'tab')
    assert.equal(consentRecordOf({ ...fields, answer: 'A' })?.answer, 'waive it, docs only')
  })
})

describe('record producers', () => {
  it('gives each kind its declared producer, and any other caller the open kind', () => {
    assert.equal(kindFor('pr-review'), 'review')
    assert.equal(kindFor('norms'), 'norms')
    assert.equal(kindFor('engine'), 'e2e')
    assert.equal(kindFor('orchestrator'), 'review')
    assert.deepEqual(producersOf('review').map(p => p.plugin), ['pr-review', 'orchestrator'])
    assert.deepEqual(producersOf('e2e'), [])
  })
})
