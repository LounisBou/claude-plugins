// hooks/observe.ts
// The module's journal (core's learning.ts): the one writer of its events. A guard that observes
// instead of refusing leaves one escape under its stable code, the refusal it would have answered
// as its evidence; a review pass leaves its agents' findings. Each event names
// the pull request the session works on once the module read it (`noteSubject`). Never throws: the
// journal is an observation, and a call whose line cannot be written goes through all the same.
import { configDirOf } from '../core/env.ts'
import { messageOf, type Host } from '../core/host.ts'
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { answerEvent, journalDir, learningEvent, subjectOf, type Known, type LearningEvent } from '../core/learning.ts'

export const PLUGIN = 'pr-review'
const SESSION = /^[A-Za-z0-9._-]{1,80}$/

export type JournalHost = Host<'env' | 'fs' | 'process' | 'session' | 'clock' | 'ui'>

// The journal is pruned once per process, at its first line.
let pruned = false

// The repository, the pull request and the head the session's review reads, as far as the module
// read them: every event written while they stand names them. Memory of the module, like the
// loop's state.
let subject: LearningEvent['subject'] = subjectOf({})

/** Names what the events written from now on are about; a field left out keeps what was read before. */
export function noteSubject(read: { repo?: unknown; pr?: unknown; head?: unknown }): void {
  subject = subjectOf({ ...subject, ...read })
}

export function notedSubject(): LearningEvent['subject'] {
  return subject
}

export function resetSubject(): void {
  subject = subjectOf({})
}

// The time as the contract writes it: to the second, in UTC.
const stampOf = (date: Date): string => date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')

// The journal's I/O over the host's nouns: files through `$.fs`, the rename and the removal through `$.process`.
function ioOf($: JournalHost): JournalIo {
  return {
    write: (path, text) => $.fs.write(path, text).then(() => undefined),
    read: (path) => $.fs.read(path).then((text) => String(text), () => undefined),
    run: (argv) => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: (path) => $.fs.stat(path).then((stat) => stat.mtimeMs, () => undefined),
    sleep: (ms) => $.clock.sleep(ms),
    now: Date.now,
    tag: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    list: (dir) => $.fs.list(dir).then((entries) => entries.map((entry) => String(entry.name)), () => []),
  }
}

/**
 * Writes the events `build` makes of what the module knows now: `known()` answers, for each event,
 * its time, a random part of its own, the subject noted and the session. An event the contract
 * refuses is not written, and is one line in the host's log, as a write that fails is.
 */
export async function journal($: JournalHost, build: (known: () => Known) => ReadonlyArray<LearningEvent | undefined>, now: () => Date = () => new Date()): Promise<void> {
  try {
    const config = configDirOf({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') }, (await $.env.get('HOME')) ?? '')
    const id = await Promise.resolve().then(() => $.session.id()).then((value) => String(value), () => '')
    const at = stampOf(now())
    const context = { session: SESSION.test(id) ? id : null, role: null }
    const built = build(() => ({ at, random: randomPart(), plugin: PLUGIN, subject, context }))
    const dir = journalDir(config, PLUGIN)
    for (const event of built) {
      if (event === undefined) continue
      const prune = !pruned
      pruned = true
      await appendEventOver(ioOf($), dir, event, at, prune)
    }
    const refused = built.filter((event) => event === undefined).length
    if (refused > 0) throw new Error(`${refused} event(s) break the journal's contract`)
  } catch (err) {
    // An observation that cannot be written is one line in the host's log; the call it describes goes through.
    try {
      $.ui.log(`pr-review: the journal could not be written or pruned: ${messageOf(err)}`)
    } catch {
      // A session with no log has nothing to tell.
    }
  }
}

export function observed($: JournalHost, code: string, now?: () => Date): Promise<void> {
  return journal($, (known) => {
    const { plugin, ...rest } = known()
    return [learningEvent({ ...rest, source: { plugin, code }, trust: 'computed', evidence: [{ type: 'refusal', code }], kind: 'escape' })]
  }, now)
}

/** The operator's own answer to a grant the module asked of them (`asked` names it): one event of their trust. */
export function answered($: JournalHost, asked: string, granted: boolean, now?: () => Date): Promise<void> {
  return journal($, (known) => [answerEvent({ ...known(), given: { asked, granted } })], now)
}

/**
 * Asks the operator to allow an act and answers what they chose, undefined when nobody answered (a
 * session with no one to ask, a dialog dismissed). Their own Allow or Deny is kept in the journal.
 */
export async function askAllow($: JournalHost, asked: string, question: string): Promise<boolean | undefined> {
  let answer: string
  try {
    answer = await $.ui.ask(question, ['Allow', 'Deny'])
  } catch {
    return undefined
  }
  if (answer !== 'Allow' && answer !== 'Deny') return undefined
  await answered($, asked, answer === 'Allow')
  return answer === 'Allow'
}
