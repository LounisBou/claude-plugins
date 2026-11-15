// hooks/observe.ts
// What a guard of this module no longer refuses, it observes: the call goes through and one
// refusal event, under the guard's stable code, is written into the module's journal (core's
// learning contract, the writer the orchestrator's guards already use). Only the irreversible
// stays refused: a merge, a force push, a deletion, a production target. An observer: a journal
// that cannot be written is one line in the log, and the call goes on.
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { journalDir, learningEvent } from '../core/learning.ts'

export const PLUGIN = 'github'

// The stable code of each guard now observed.
export const OBSERVED = {
  records: 'github.records.write',
  exemption: 'github.exemption.write',
  exemptLabel: 'github.exempt-label.move',
  draftOpen: 'github.draft.open-out',
  draftLeave: 'github.draft.leave',
  writing: 'github.writing.rule',
} as const

const SESSION = /^[A-Za-z0-9._-]{1,80}$/

// The time one observation may take: the call waits for it, so a journal that hangs (a held lock, a stuck write)
// costs the call this long at most.
export const OBSERVE_DEADLINE_MS = 3000

// Pruned once per process, at the first write, whatever its outcome: a prune that fails is not retried at every call.
let pruned = false

// A file that is not there: the only read failure that is no failure (core reads an absent file as empty).
const ABSENT = /ENOENT|no such file|not found/i

// The journal's I/O over the host's nouns: what core's store-io needs, run by the host.
function ioOf($: any): JournalIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    read: (path) => $.fs.read(path).then((text: unknown) => String(text), (err: any) => {
      if (ABSENT.test(String(err?.code ?? '') + ' ' + String(err?.message ?? err))) return undefined
      throw err
    }),
    run: (argv) => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: (path) => $.fs.stat(path).then((stat: any) => Number(stat.mtimeMs), () => undefined),
    sleep: (ms) => $.clock.sleep(ms),
    now: Date.now,
    tag: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    list: (dir) => $.fs.list(dir).then((entries: any[]) => entries.map((entry) => String(entry?.name ?? '')), () => []),
  }
}

/** Writes the refusal event of `code` into the journal under `config`; never throws. */
export async function observe($: any, config: string | undefined, code: string): Promise<void> {
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
  } catch (err: any) {
    try {
      const sent = $.ui.log('github: the observation ' + code + ' could not be journaled or the journal pruned: ' + String(err?.message ?? err).trim())
      if (sent && typeof sent.catch === 'function') sent.catch(() => undefined)
    } catch {
      // Nowhere to say it: the call goes on.
    }
  }
}
