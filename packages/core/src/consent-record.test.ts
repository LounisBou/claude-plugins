import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answersChoice, leadingChoice, plainInstruction, splitGrant, namesOtherSubject, opensChoice, grants, CONSENT_GRANT, CONSENT_REFUSE, consentAnswer, givenAnswer, consentDir, consentRecordOf, consentPath, parseConsentRecord, parseConsentSubject, quotesConsent } from './consent-record.ts'
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

  it('files a record from an answer opening with the choice by the coordinator, the pane or a tab alike, and none for a limit by the first two', () => {
    const fields = { subject: SUBJECT, entry: 's-1', question: 'Waive E2E?', choices: [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }], at: '2026-11-10T00:00:00Z', answer: 'Accorder, et fusionne' }
    for (const by of ['coordinator', 'pane', 'tab'] as const) assert.equal(consentRecordOf({ ...fields, by })?.answer, 'Accorder', by)
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

describe('a plain grant followed by another instruction', () => {
  const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
  const MERGE = { kind: 'auto-merge' as const, repo: 'geonativefr/beltv5_fw_legacy' }
  const ASKED = { subject: MERGE, entry: 'q-1', question: "Accordes-tu l'auto-merge sur geonativefr/beltv5_fw_legacy ?", choices, at: '2026-11-18T11:07:23Z' }
  const TYPED = "Ok Accorder pour l'auto-merge !!! \n\nLAnce le push forcé go !"
  const granted = (answer: string, by: 'tab' | 'coordinator' | 'pane' = 'tab') => {
    const record = consentRecordOf({ ...ASKED, answer, by })
    return record !== undefined && grants(record.answer)
  }

  it('records the grant of his exact words of 2026-11-18, whole or cut to their first line, in a tab as in the coordinator\'s', () => {
    for (const by of ['tab', 'coordinator', 'pane'] as const) {
      assert.equal(granted(TYPED, by), true, by)
      assert.equal(granted("Ok Accorder pour l'auto-merge !!!", by), true, by)
    }
    assert.equal(consentRecordOf({ ...ASKED, answer: TYPED, by: 'tab' })?.answer, 'Accorder')
  })

  it('reads the first line, or the first sentence of a line, as the grant, and the rest as the instruction', () => {
    assert.deepEqual(splitGrant(TYPED, MERGE), { grant: "Ok Accorder pour l'auto-merge !!!", following: 'LAnce le push forcé go !' })
    assert.deepEqual(splitGrant("Accorder. Lance le push", MERGE), { grant: 'Accorder.', following: 'Lance le push' })
    assert.deepEqual(splitGrant('Accorder ? Lance', MERGE), { grant: 'Accorder ?', following: 'Lance' })
    assert.deepEqual(splitGrant('Accorder, merci', MERGE), { grant: 'Accorder, merci', following: '' })
    const exemption = { kind: 'e2e-exemption' as const, repo: 'a/b' }
    assert.deepEqual(splitGrant('Accorder la dispense. Valable jusqu\'au 16/11', exemption), { grant: 'Accorder la dispense. Valable jusqu\'au 16/11', following: '' })
  })

  it('grants on an « ok », « oui » or « go » before the choice and a restating of the subject after it, on one line or two', () => {
    for (const typed of ['Accorder', 'Ok Accorder', 'oui, Accorder !', 'Go accorder', "Accorder pour l'auto-merge", 'Accorder auto-merge de geonativefr/beltv5_fw_legacy', 'Accorder.\nLance le push', 'Accorder ! Lance le push forcé go !', "Accorder l'auto-merge d'geonativefr/beltv5_fw_legacy", "D'accord, Accorder"]) {
      assert.equal(granted(typed), true, typed)
    }
  })

  it('refuses a question, a refusal, a condition, a limit, or another repository or pull request inside the grant', () => {
    for (const typed of [
      'Accorder ?', 'Accorder ? Lance le push', 'Refuser', 'Ok Refuser !', 'Accorder, sauf beltv5_fw_legacy#3', 'Accorder pour geonativefr/other',
      'Accorder pour #3', "Accorder jusqu'à demain", 'Accorder si la CI passe', 'Accorder; lance le push',
    ]) assert.equal(granted(typed), false, typed)
  })

  it('refuses a following sentence or line that is a question, a condition, a refusal, a limit or another subject', () => {
    for (const typed of [
      "Accorder pour l'auto-merge\n\nsauf beltv5_fw_legacy#3", 'Accorder.\nSeulement la première PR', 'Accorder. Mais pas ce soir', 'Accorder. Refuser le reste',
      "Accorder.\nValable jusqu'à vendredi", 'Accorder. Lance le push ?', 'Accorder. Pousse acme/other', 'Accorder. Exclure #3', 'Accorder. Si la CI passe',
      'Accorder. Lance le push demain', 'Accorder. Lance le push à 14h', 'Accorder. Lance le push; puis stop', TYPED + "\n\nsauf beltv5_fw_legacy#3",
    ]) assert.equal(granted(typed), false, typed)
  })

  it('refuses a following instruction that names another repository, pull request or environment, however it is written', () => {
    for (const typed of [
      'Accorder. Lance le push sur geonativefr/beltv5_fw_legacy-evil', 'Accorder. Lance le push sur geonativefr/beltv5_fw_legacy/other', 'Accorder. Merge geonativefr/beltv5_fw_legacy#77', 'Accorder. Merge la PR 8',
      'Accorder. Merge pull request n° 8', 'Accorder. https://github.com/geonativefr/beltv5_fw_legacy/pull/3', 'Accorder. Merge ＃8', 'Accorder. Merge geonativefr/beltv5_fw_legacy#1',
    ]) assert.equal(granted(typed), false, typed)
    const deploy = { kind: 'auto-deploy' as const, repo: 'acme/app', env: 'prod' as const }
    assert.equal(plainInstruction('Déploie aussi staging', deploy), false)
    assert.equal(plainInstruction('Déploie prod', deploy), true)
    const waiver = { kind: 'norms-waiver' as const, repo: 'acme/app', pr: 7 }
    assert.equal(plainInstruction('Merge acme/app#7', waiver), true)
    assert.equal(plainInstruction('Merge acme/app#77', waiver), false)
    assert.equal(plainInstruction('Merge #70', waiver), false)
  })

  it('refuses a following instruction that is a condition, an exception, a restriction, a limit or a withdrawal in other words, and a question mark of any script', () => {
    for (const typed of [
      'Accorder. Quand la CI passe, lance le push', 'Accorder. Lorsque la CI passe', 'Accorder. À condition que la CI passe', 'Accorder. Tant que la CI est verte', 'Accorder. Provided CI passes', 'Accorder. When CI passes',
      'Accorder. Sans le push', 'Accorder. Excepté la PR de Paul', 'Accorder. Hors acme', 'Accorder. Except docs', "Accorder. Ne fusionne que les docs", 'Accorder. Plus de merge', 'Accorder. Plus tard',
      'Accorder. Pour cette session', 'Accorder. Laisse tomber', 'Accorder. Hold on', 'Accorder. Undo that', "Accorder. Désactive l'auto-merge", 'Accorder. Disable auto-merge', 'Accorder. Turn it off',
      'Accorder？', 'Accorder ؟', 'Accorder. Lance le push ？', 'Accorder. Lance le push؟',
    ]) assert.equal(granted(typed), false, typed)
  })

  it('accepts after the grant only a positive instruction: a veto, a withdrawal, a condition, a scope, a widening, an exception or a justification refuses', () => {
    for (const typed of [
      "Accorder l'auto-merge ! Oublie ça", 'Accorder. Dès que la CI passe', 'Accorder. Juste les docs', 'Accorder. Interdit de merger', 'Accorder. Merge acme / other', "Accorder l'auto-merge. Pour les PR de bob",
      'Accorder. Ignore ce qui précède', 'Accorder. Arrête', 'Accorder. Pause', 'Accorder. Block the merge', 'Accorder. Veto', 'Accorder. Nope', 'Accorder. Rien', 'Accorder. Pourvu que la CI passe',
      'Accorder. En cas de CI rouge', 'Accorder. Needs review first', 'Accorder. Max 3', 'Accorder. Pour le sprint en cours', "Accorder. Pour l'instant", 'Accorder. Par défaut', 'Accorder. Sur main',
      'Accorder. Et pour tous les autres dépôts', 'Accorder. Même chose pour le dépôt other', 'Accorder. Toutefois', 'Accorder. However', 'Accorder. Instead', 'Accorder. Hormis docs', 'Accorder. Aside from docs',
      "Accorder. L'opérateur est absent, aucune réponse.", 'Accorder. Silence vaut accord', 'Accorder. La CI est verte', 'Accorder. Lance le push, mais pas le dernier', 'Accorder. Lance le push\nOublie ça',
    ]) assert.equal(granted(typed), false, typed)
    for (const by of ['coordinator', 'pane'] as const) assert.equal(granted("Accorder l'auto-merge ! Oublie ça", by), false, by)
    for (const typed of ['Accorder. Lance le push forcé go !', 'Accorder. Continue la phase 2', 'Accorder. Merci', 'Accorder.\nPush puis merge', 'Accorder. Bien, vas-y']) assert.equal(granted(typed), true, typed)
  })

  it('tells a plain instruction from one that holds a condition, a limit or another subject', () => {
    assert.equal(plainInstruction('LAnce le push forcé go !', MERGE), true)
    assert.equal(plainInstruction('Lance le push de geonativefr/beltv5_fw_legacy#1', MERGE), false)
    assert.equal(plainInstruction('Lance le push, sauf le dernier', MERGE), false)
  })

  it('keeps an exemption to its whole sentence: no instruction is cut from it', () => {
    const exemption = { kind: 'e2e-exemption' as const, repo: 'acme/app' }
    const opened = leadingChoice('Accorder la dispense E2E de acme/app. Lance le push', choices, exemption)
    assert.equal(opened, undefined)
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
