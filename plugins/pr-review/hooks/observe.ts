// hooks/observe.ts
// A guard of this module that observes instead of refusing: the call it once refused goes through,
// and the journal (core's learning.ts) holds one escape under the guard's stable code, the refusal
// it would have answered as its evidence. Never throws: the journal is an observation, and a call
// whose line cannot be written goes through all the same.
import { configDirOf } from '../core/env.ts'
import { appendEventOver, randomPart, type JournalIo } from '../core/journal.ts'
import { journalDir, learningEvent } from '../core/learning.ts'

const PLUGIN = 'pr-review'
const SESSION = /^[A-Za-z0-9._-]{1,80}$/

// The journal is pruned once per process, at its first line.
let pruned = false

// The time as the contract writes it: to the second, in UTC.
const stampOf = (date: Date): string => date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')

// The journal's I/O over the host's nouns: files through `$.fs`, the rename and the removal through `$.process`.
function ioOf($: any): JournalIo {
  return {
    write: (path, text) => $.fs.write(path, text),
    read: (path) => $.fs.read(path).then((text: unknown) => String(text), () => undefined),
    run: (argv) => $.process.run(argv, { timeoutMs: 5000 }),
    mtimeMs: (path) => $.fs.stat(path).then((stat: any) => stat.mtimeMs, () => undefined),
    sleep: (ms) => $.clock.sleep(ms),
    now: Date.now,
    tag: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    list: (dir) => $.fs.list(dir).then((entries: any[]) => entries.map((entry) => String(entry.name)), () => []),
  }
}

export async function observed($: any, code: string, now: () => Date = () => new Date()): Promise<void> {
  try {
    const config = configDirOf({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') }, (await $.env.get('HOME')) ?? '')
    const id: string = await $.session.id().catch(() => '')
    const at = stampOf(now())
    const event = learningEvent({
      at, random: randomPart(), source: { plugin: PLUGIN, code }, context: { session: SESSION.test(id) ? id : null, role: null },
      trust: 'computed', evidence: [{ type: 'refusal', code }], kind: 'escape',
    })
    if (event === undefined) throw new Error(`the code ${code} breaks the journal's contract`)
    const prune = !pruned
    pruned = true
    await appendEventOver(ioOf($), journalDir(config, PLUGIN), event, at, prune)
  } catch (err: any) {
    // An observation that cannot be written is one line in the host's log; the call it describes goes through.
    try {
      $.ui.log(`pr-review: the journal could not be written or pruned: ${String(err?.message ?? err)}`)
    } catch {
      // A session with no log has nothing to tell.
    }
  }
}
