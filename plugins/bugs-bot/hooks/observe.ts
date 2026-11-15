// hooks/observe.ts
// The module's journal (core's learning.ts): one `refusal` event under a stable code for each call
// the guard refuses to protect the group or the bot token. Never throws: the journal is an
// observation, and a refusal whose line cannot be written stands all the same.
import { configDirOf } from '../core/env.ts'
import { reasonOf, type Host } from '../core/host.ts'
import { appendEventOver, journalIoOf, randomPart } from '../core/journal.ts'
import { journalDir, learningEvent } from '../core/learning.ts'

export const PLUGIN = 'bugs-bot'

// The guard's refusals, by what they protect.
export const CODES = {
  // A post whose words a variable or a substitution leaves unknown.
  dynamic: 'bugs-bot.post.dynamic',
  // A post that names a pull request, a commit, a branch, a ticket, a path or a host.
  leak: 'bugs-bot.post.leak',
  // A call that reaches the bot token file.
  token: 'bugs-bot.token-file',
  // The guard failed, and its net refused a call that posts or may reach the token file.
  failed: 'bugs-bot.guard.failed',
} as const

export type RefusalCode = (typeof CODES)[keyof typeof CODES]

export type JournalHost = Host<'env' | 'fs' | 'process' | 'session' | 'clock' | 'ui'>

const SESSION = /^[A-Za-z0-9._-]{1,80}$/

// The journal is pruned once per process, at its first line.
let pruned = false

// The time as the contract writes it: to the second, in UTC.
const stampOf = (date: Date): string => date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')

/** Writes the one event of a refusal under `code`; a line that cannot be written is one line of the host's log. */
export async function refused($: JournalHost, code: RefusalCode, now: () => Date = () => new Date()): Promise<void> {
  try {
    const config = configDirOf({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') }, (await $.env.get('HOME')) ?? '')
    const id = await Promise.resolve().then(() => $.session.id()).then((value) => String(value), () => '')
    const at = stampOf(now())
    const event = learningEvent({
      at, random: randomPart(), source: { plugin: PLUGIN, code }, context: { session: SESSION.test(id) ? id : null },
      trust: 'computed', evidence: [{ type: 'refusal', code }], kind: 'refusal',
    })
    if (event === undefined) throw new Error(`the event of ${code} breaks the journal's contract`)
    const prune = !pruned
    pruned = true
    await appendEventOver(journalIoOf($), journalDir(config, PLUGIN), event, at, prune)
  } catch (err) {
    try {
      $.ui.log(`bugs-bot: the journal could not be written or pruned: ${reasonOf(err)}`)
    } catch {
      // A session with no log has nothing to tell.
    }
  }
}

/** The answer of a refused call, its event written first. */
export async function refuse($: JournalHost, code: RefusalCode, denial: string): Promise<{ deny: string }> {
  await refused($, code)
  return { deny: denial }
}
