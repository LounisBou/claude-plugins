// hooks/observe.ts
// What a guard of this module no longer refuses, it observes: the call goes through and one
// refusal event, under the guard's stable code, is written into the module's journal (core's
// learning contract, the writer the orchestrator's guards already use). Only the irreversible
// stays refused: a merge whose CI is not green or whose record failed, a force push, a deletion, a
// production target. An observer: a journal
// that cannot be written is one line in the log, and the call goes on.
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { journalDir, learningEvent } from '../core/learning.ts'
import { reasonOf, type Host } from '../core/host.ts'

export const PLUGIN = 'github'

// The stable code of each guard now observed.
export const OBSERVED = {
  records: 'github.records.write',
  exemption: 'github.exemption.write',
  exemptLabel: 'github.exempt-label.move',
  draftOpen: 'github.draft.open-out',
  draftLeave: 'github.draft.leave',
  writing: 'github.writing.rule',
  // An E2E pass or fail written with no run the record tool performed or observed: recorded as stated.
  e2eStated: 'github.record.e2e-stated',
} as const

// The stable code of each refusal that protects something: the call is refused and one refusal event of its code
// is journaled, as an observed guard's is. A refusal that only asks for a missing or malformed argument has none.
export const REFUSED = {
  // The Ready gate holds a merge, an undraft or a Ready label: a record failed, CI is not green, or readiness is unread.
  ready: 'github.ready.held',
  autoMergeList: 'github.auto-merge.list-write',
  autoDeployList: 'github.auto-deploy.list-touch',
  autoMergeSet: 'github.auto-merge.unproven',
  autoDeploySet: 'github.auto-deploy.unproven',
  deploy: 'github.deploy.unlisted',
  recordsDelete: 'github.records.delete',
  exemptionDelete: 'github.exemption.delete',
  net: 'github.net.blocked',
  // The record tool's refusals.
  recordKind: 'github.record.kind',
  recordPlan: 'github.record.plan-writer',
  recordAcceptance: 'github.record.acceptance-writer',
  recordPassOverFail: 'github.record.pass-over-fail',
  recordSelfReview: 'github.record.self-review',
  recordHead: 'github.record.off-head',
  recordDirty: 'github.record.dirty-checkout',
  recordUnverified: 'github.record.gate-unread',
  recordRuntime: 'github.record.runtime-not-applicable',
  recordUnquoted: 'github.record.unquoted-words',
  recordUnplanned: 'github.record.waiver-unplanned',
  // A run named for an E2E that the tool cannot perform or did not observe.
  recordE2eUnrun: 'github.record.e2e-unrun',
} as const

const SESSION = /^[A-Za-z0-9._-]{1,80}$/

// The time one observation may take: the call waits for it, so a journal that hangs (a held lock, a stuck write)
// costs the call this long at most.
export const OBSERVE_DEADLINE_MS = 3000

// Pruned once per process, at the first write, whatever its outcome: a prune that fails is not retried at every call.
let pruned = false

// A file that is not there: the only read failure that is no failure (core reads an absent file as empty).
const ABSENT = /ENOENT|no such file|not found/i

// The `code` a rejection carries, when it is an object that has one.
const codeOf = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined)

// Whether a call's answer is a promise, whose rejection can be caught.
export function isCatchable(value: unknown): value is { catch(handler: () => undefined): unknown } {
  return typeof value === 'object' && value !== null && 'catch' in value && typeof value.catch === 'function'
}

// The journal's I/O over the host's nouns: what core's store-io needs, run by the host.
function ioOf($: Host<'fs' | 'process' | 'clock'>): JournalIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    read: (path) => $.fs.read(path).then((text: unknown) => String(text), (err: unknown) => {
      if (ABSENT.test(String(codeOf(err) ?? '') + ' ' + reasonOf(err))) return undefined
      throw err
    }),
    run: (argv) => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: (path) => $.fs.stat(path).then((stat) => Number(stat.mtimeMs), () => undefined),
    sleep: (ms) => $.clock.sleep(ms),
    now: Date.now,
    tag: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    list: (dir) => $.fs.list(dir).then((entries) => entries.map((entry) => String(entry?.name ?? '')), () => []),
  }
}

/** Writes the refusal event of `code` into the journal under `config`; never throws. */
export async function observe($: Host<'fs' | 'process' | 'clock' | 'session' | 'ui'>, config: string | undefined, code: string): Promise<void> {
  try {
    if (!config) throw new Error('no configuration directory')
    const id = String(await $.session.id().catch(() => ''))
    const at = new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z')
    const event = learningEvent({
      kind: 'refusal', at, random: randomPart(), source: { plugin: PLUGIN, code }, context: { session: SESSION.test(id) ? id : null },
      evidence: [{ type: 'refusal', code }], trust: 'computed',
    })
    if (event === undefined) throw new Error('the event breaks the learning contract')
    const prune = !pruned
    pruned = true
    const deadline = new Promise<never>((_, reject) => {
      // A clock that cannot sleep sets no deadline.
      Promise.resolve().then(() => $.clock.sleep(OBSERVE_DEADLINE_MS)).then(() => reject(new Error('no answer in ' + OBSERVE_DEADLINE_MS + ' ms')), () => undefined)
    })
    await Promise.race([appendEventOver(ioOf($), journalDir(config, PLUGIN), event, at, prune), deadline])
  } catch (err: unknown) {
    try {
      const sent: unknown = $.ui.log('github: the observation ' + code + ' could not be journaled or the journal pruned: ' + reasonOf(err).trim())
      if (isCatchable(sent)) sent.catch(() => undefined)
    } catch {
      // Nowhere to say it: the call goes on.
    }
  }
}
