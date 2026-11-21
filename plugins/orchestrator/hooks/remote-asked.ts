// hooks/remote-asked.ts
// A question asked with `ask` (question.ts) whose coordinator runs on another machine. Its owner is
// its asker's machine: every write made there pushes the object whole to the coordinator's machine
// on the event line (`asked`, remote-round.ts), which keeps it as a replica (the object with its
// `origin`) for the pane, and acknowledges it by its `seq`. The operator's answer given on the
// replica, in the pane or by the coordinator's `settle`, travels back as a `reply`: the owner applies
// it while the question is open and acknowledges it, or, settled first in its own tab, acknowledges
// it `already` and pushes its own state again. A push or a reply not acknowledged is sent again
// every ANSWER_RESEND_MS, ANSWER_SENDS times in all, then failed, said in the log and, for a reply,
// in the pane. The handlers' `$` is the supervision's.
import { roundEntryPath } from '../core/orchestration.ts'
import { updateOver } from '../core/store-io.ts'
import { dataDir, logLine, storeIo } from './module-io.ts'
import { messageOf, type Host } from './host.ts'
import { askedAsEntry, parseAsked, readAsked, type Asked } from './question.ts'
import { ALREADY_ANSWERED, ANSWER_RESEND_MS, ANSWER_SENDS, closesItself, coordinatorAddress, readSessions, sendToCoordinator, sessionKey, tellSettled } from './supervision.ts'
import { ASKED_LINE_CAP, qAckLine, qAskedLine, qReplyLine, type QAck, type QReply } from './remote-round.ts'
import { settledMessage } from './settle.ts'

type Replica = NonNullable<Asked['replica']>

// The nouns the pushes and the replies hold: the supervision's.
type Held = Host<'plugin' | 'env' | 'fs' | 'process' | 'clock' | 'session' | 'ui'>
// What a push alone holds: the send to the coordinator (supervision.ts sendToCoordinator) needs the session.
type Pushing = Host<'plugin' | 'env' | 'fs' | 'process' | 'clock' | 'session'>

async function pathOf($: Pushing, id: string): Promise<string> {
  return roundEntryPath(await dataDir($), id)
}

// The answers a replica sends its owner: those given on its own machine.
const REPLICA_ANSWERS: readonly string[] = ['pane', 'coordinator']

/**
 * The owner's object pushed to the coordinator on another machine, after a write made here: its
 * push state written back on it (`replica`) while its `seq` is still the one sent. A replica, or a
 * coordinator on this machine or none known, sends nothing. Never throws: a failure is a log line.
 */
export async function replicate($: Pushing, entry: Asked): Promise<void> {
  if (entry.origin !== undefined) return
  try {
    const coordinator = await coordinatorAddress($)
    if (!coordinator || coordinator.local) return
    const { replica: was, delivery: _delivery, ...object } = entry
    const attempts = (was?.seq === entry.seq ? was.attempts : 0) + 1
    const line = qAskedLine(object)
    let reason: string | null = null
    if (line === null) reason = `past the line's cap of ${ASKED_LINE_CAP} characters`
    else {
      const sent = await sendToCoordinator($, coordinator, line).catch((err: unknown) => ({ isDelivered: false, reason: messageOf(err) }))
      if (!sent?.isDelivered) reason = sent?.reason ?? 'no answer'
    }
    const replica: Replica = {
      seq: entry.seq, state: line === null ? 'failed' : 'sent', attempts, at: new Date().toISOString(), ...(reason !== null ? { reason } : {}),
    }
    if (reason !== null) await logLine($, 'question', `${entry.id} not pushed to the coordinator ${coordinator.name}: ${reason}`)
    // Written while the push it replaces is still there: an acknowledgment that landed during the send is kept.
    await updateOver(storeIo($), await pathOf($, entry.id), current => {
      const now = current === undefined ? null : parseAsked(current)
      const same = now !== null && now.origin === undefined && now.seq === entry.seq && JSON.stringify(now.replica ?? null) === JSON.stringify(was ?? null)
      return same ? `${JSON.stringify({ ...now, replica })}\n` : undefined
    })
    if (replica.state === 'sent') armResend($)
  } catch (err) {
    await logLine($, 'question', `${entry.id} not pushed: ${messageOf(err)}`)
  }
}

// One reading of the pushes not acknowledged, ANSWER_RESEND_MS after a push, armed once at a time:
// an asker waiting on its question ends no turn that would send it again.
let resendArmed = false
function armResend($: Pushing): void {
  if (resendArmed) return
  try {
    $.clock.after(ANSWER_RESEND_MS + 1000, () => resendTick($))
    resendArmed = true
  } catch {
    // A host with no timer: the turns' ends send them again.
  }
}

/** The module's timer forgotten, as at a module load: the next push arms one. */
export function forgetResendTimer(): void {
  resendArmed = false
}

// A push sent after the timer was armed is younger than ANSWER_RESEND_MS at its tick: armed again
// while any push still waits for its acknowledgment from a coordinator still on another machine.
async function resendTick($: Pushing): Promise<void> {
  resendArmed = false
  try {
    await resendReplicas($)
    const coordinator = await coordinatorAddress($)
    const waiting = (await readAsked($)).some(entry => entry.origin === undefined && entry.replica?.state === 'sent')
    if (waiting && coordinator !== null && !coordinator.local) armResend($)
  } catch (err) {
    await logLine($, 'question', `pushes: ${messageOf(err)}`)
  }
}

/**
 * The pushes not acknowledged, read at a turn's end on the owner's machine and by the timer each push
 * arms: one whose last send is
 * ANSWER_RESEND_MS old is sent again, or, sent ANSWER_SENDS times already, failed; an open question
 * never pushed, or changed since its last push, is pushed now.
 */
export async function resendReplicas($: Pushing, now: number = Date.now()): Promise<void> {
  const coordinator = await coordinatorAddress($)
  if (!coordinator || coordinator.local) return
  for (const entry of await readAsked($)) {
    if (entry.origin !== undefined) continue
    const replica = entry.replica
    if (replica === undefined ? entry.status === 'open' : replica.seq !== entry.seq) {
      await replicate($, entry)
      continue
    }
    if (replica?.state !== 'sent' || now - Date.parse(replica.at) < ANSWER_RESEND_MS) continue
    if (replica.attempts < ANSWER_SENDS) {
      await replicate($, entry)
      continue
    }
    const reason = `no acknowledgment after ${ANSWER_SENDS} sends`
    try {
      let written = false
      await updateOver(storeIo($), await pathOf($, entry.id), current => {
        const read = current === undefined ? null : parseAsked(current)
        written = read?.replica?.seq === replica.seq && read.replica.state === 'sent'
        return written ? `${JSON.stringify({ ...read, replica: { ...replica, state: 'failed', at: new Date().toISOString(), reason } })}\n` : undefined
      })
      if (written) await logLine($, 'question', `${entry.id} not pushed to the coordinator ${coordinator.name}: ${reason}`)
    } catch (err) {
      await logLine($, 'question', `${entry.id} push not failed: ${messageOf(err)}`)
    }
  }
}

/**
 * The owner's object received on the coordinator's machine, its line consumed whatever it holds: one
 * that parses is written as the replica, with where it came from, when its `seq` is newer than the
 * replica's, and acknowledged. An answer given here still on its way to the owner is kept over an
 * open push; a close the owner made is told to the coordinator here when it was shown the question.
 */
export async function receiveAsked($: Held, from: string, object: Record<string, unknown>): Promise<{ consumed: string }> {
  const asked = parseAsked(JSON.stringify(object))
  if (asked === null || asked.origin !== undefined || asked.replica !== undefined) {
    await logLine($, 'question', `a remote question asked with ask was refused (${String(object['id'])})`)
    return { consumed: 'orchestrator: a malformed remote question asked with ask, refused' }
  }
  let owned = false
  // Held in an object: what the store's callback sets is read after it.
  const seen: { written: Asked | null; closed: Asked | null } = { written: null, closed: null }
  try {
    await updateOver(storeIo($), await pathOf($, asked.id), current => {
      const held = current === undefined ? null : parseAsked(current)
      // A file here that is no replica of that machine's (this machine's own question, or one it cannot read) is never overwritten.
      // Any session of the owner's machine pushes, from its own address: the replica follows the last one.
      owned = current !== undefined && (held === null || held.origin === undefined || held.origin.machine !== asked.sender.machine)
      if (owned || (held !== null && held.seq >= asked.seq)) return undefined
      const pending = held?.delivery?.state === 'pending' || held?.delivery?.state === 'sent'
      const keeps = asked.status === 'open' && pending
      // Closed by its owner with another answer while the one given here was on its way: that one lost.
      const lost = pending && asked.status !== 'open' && !(asked.answer?.at === held!.answer?.at && asked.answer?.text === held!.answer?.text)
      const delivery = lost ? { ...held!.delivery!, state: 'failed' as const, at: new Date().toISOString(), reason: ALREADY_ANSWERED } : held?.delivery
      const { claimed: _claimed, ...unclaimed } = asked
      const next: Asked = {
        ...(keeps ? { ...unclaimed, status: held!.status, answer: held!.answer } : asked),
        origin: { machine: asked.sender.machine, address: from },
        ...(delivery !== undefined ? { delivery } : {}),
      }
      seen.written = next
      seen.closed = held?.status === 'open' && next.status !== 'open' && !REPLICA_ANSWERS.includes(next.answer?.by ?? '') ? next : null
      return `${JSON.stringify(next)}\n`
    })
  } catch (err) {
    await logLine($, 'question', `the replica of ${asked.id} not written: ${messageOf(err)}`)
    return { consumed: 'orchestrator: a remote question asked with ask, not written' }
  }
  if (owned) {
    await logLine($, 'question', `a remote push of ${asked.id} from ${asked.sender.machine} meets a question here that is no replica of that machine's, ignored`)
    return { consumed: 'orchestrator: a remote push of a question owned here, ignored' }
  }
  await ack($, from, { id: asked.id, seq: asked.seq, of: 'asked' })
  const done = seen.closed
  if (done !== null && done.answer !== null && await closesItself($, done.id)) {
    const text = done.status === 'withdrawn' ? `withdrawn: ${done.answer.text}` : done.answer.text
    await tellSettled($, [{ entry: askedAsEntry(done), answer: { text, by: done.answer.by, at: done.answer.at } }])
  }
  if (seen.written !== null) {
    await logLine($, 'question', `the replica of ${asked.id} from ${asked.sender.machine} now at ${asked.seq}`)
    $.ui.invalidate('ui.render')
  }
  return { consumed: 'orchestrator: a remote question asked with ask, replicated' }
}

/**
 * The coordinator's acknowledgment of a push, on the owner's machine: the push of that very `seq`
 * acknowledged. One from any other address than the coordinator's is consumed and written nowhere.
 */
export async function receiveAskedAck($: Held, from: string | null, ack: QAck): Promise<{ consumed: string }> {
  if (!await fromCoordinator($, from)) {
    await logLine($, 'question', `an acknowledgment of the push of ${ack.id} from ${from ?? 'no address'}, not the coordinator's, refused`)
    return { consumed: "orchestrator: an acknowledgment of a push from no coordinator, refused" }
  }
  let taken = false
  try {
    await updateOver(storeIo($), await pathOf($, ack.id), current => {
      const now = current === undefined ? null : parseAsked(current)
      if (now === null || now.origin !== undefined || now.replica?.seq !== ack.seq) return undefined
      const { reason: _reason, ...replica } = now.replica
      taken = true
      return `${JSON.stringify({ ...now, replica: { ...replica, state: 'acked', at: new Date().toISOString() } })}\n`
    })
  } catch (err) {
    await logLine($, 'question', `the acknowledgment of the push of ${ack.id} not written: ${messageOf(err)}`)
  }
  if (!taken) await logLine($, 'question', `an acknowledgment of the push of ${ack.id} at ${ack.seq} matches no push`)
  return { consumed: 'orchestrator: the acknowledgment of a push, recorded' }
}

/**
 * The operator's answer or the coordinator's withdrawal given on the replica's machine, received by
 * the owner: applied while the question is open (the new state pushed),
 * acknowledged, and told to its asker — this session's model, by the readable line that replaces the
 * marked one, or its asker's session by a message. Settled first here: acknowledged `already`, its
 * own state pushed again. The same reply received again is acknowledged again and told nowhere.
 * A reply from any other address than the coordinator's is consumed, applied nowhere, acknowledged
 * to nobody.
 */
export async function receiveReply($: Held, from: string, id: string, seq: number, reply: QReply): Promise<{ consumed: string } | { readable: string }> {
  if (!await fromCoordinator($, from)) {
    await logLine($, 'question', `a remote reply to ${id} from ${from}, not the coordinator's, refused`)
    return { consumed: 'orchestrator: a remote reply from no coordinator, refused' }
  }
  // Held in an object: what the store's callback sets is read after it.
  const seen: { held: Asked | null; applied: Asked | null } = { held: null, applied: null }
  try {
    await updateOver(storeIo($), await pathOf($, id), current => {
      const entry = current === undefined ? null : parseAsked(current)
      seen.held = entry
      if (entry === null || entry.origin !== undefined || entry.replica === undefined || entry.status !== 'open') return undefined
      const { claimed: _claimed, ...rest } = entry
      seen.applied = { ...rest, status: reply.status, answer: { text: reply.text, by: reply.by, at: reply.at, settler: reply.settler }, seq: entry.seq + 1 }
      return `${JSON.stringify(seen.applied)}\n`
    })
  } catch (err) {
    await logLine($, 'question', `the remote reply to ${id} not applied: ${messageOf(err)}`)
    return { consumed: 'orchestrator: a remote reply, not applied' }
  }
  const was = seen.held
  const done = seen.applied
  if (was === null || was.origin !== undefined || was.replica === undefined) {
    await logLine($, 'question', `a remote reply to ${id} matches no question asked here`)
    return { consumed: 'orchestrator: a remote reply to no question here, dropped' }
  }
  if (done === null) {
    const again = was.answer?.at === reply.at && was.answer.text === reply.text && was.answer.by === reply.by
    if (!again) await replicate($, was)
    await ack($, from, { id, seq, of: 'reply', ...(again ? {} : { already: true as const }) })
    if (!again) await logLine($, 'question', `a remote reply to ${id} crossed its close here: said already answered`)
    return { consumed: again ? 'orchestrator: a remote reply received already, acknowledged again' : 'orchestrator: a remote reply to a question settled here first, said already answered' }
  }
  await logLine($, 'question', `${id} ${done.status} on the coordinator's machine by ${reply.settler}`)
  await replicate($, done)
  await ack($, from, { id, seq, of: 'reply' })
  const text = settledMessage(done, { session: '', name: reply.settler, role: 'coordinator' })
  if (done.sender.session !== '' && done.sender.session === await $.session.id()) return { readable: text }
  try {
    const live = done.sender.session !== '' && sessionKey(done.sender.session) in await readSessions($)
    const sent = await $.session.send({ to: live ? { sessionId: done.sender.session } : done.sender.name, text })
    if (!sent?.isDelivered) await logLine($, 'question', `the remote answer to ${id} was not delivered to ${done.sender.name}: ${sent?.reason ?? 'no answer'}`)
  } catch (err) {
    await logLine($, 'question', `the remote answer to ${id} was not delivered to ${done.sender.name}: ${messageOf(err)}`)
  }
  return { consumed: 'orchestrator: a remote reply, applied and sent to its asker' }
}

/**
 * The owner's acknowledgment of a reply, on the replica's machine: delivered, or failed when it was
 * settled there first. One from any other address than the replica's origin is written nowhere.
 */
export async function receiveReplyAck($: Held, from: string | null, ack: QAck): Promise<{ consumed: string }> {
  let taken = false
  let foreign = false
  try {
    await updateOver(storeIo($), await pathOf($, ack.id), current => {
      const now = current === undefined ? null : parseAsked(current)
      foreign = now !== null && now.origin !== undefined && now.origin.address !== from
      if (foreign) return undefined
      const state = now?.delivery?.state
      // A failure said « already answered » stays: no plain acknowledgment answers a reply its owner did not apply.
      if (now === null || now.origin === undefined || (state !== 'pending' && state !== 'sent' && state !== 'failed') || (state === 'failed' && now.delivery!.reason === ALREADY_ANSWERED && !ack.already)) return undefined
      const { reason: _reason, ...delivery } = now.delivery!
      taken = true
      const at = new Date().toISOString()
      return `${JSON.stringify({ ...now, delivery: ack.already ? { ...delivery, state: 'failed', at, reason: ALREADY_ANSWERED } : { ...delivery, state: 'delivered', at } })}\n`
    })
  } catch (err) {
    await logLine($, 'question', `the acknowledgment of the reply to ${ack.id} not written: ${messageOf(err)}`)
  }
  if (foreign) await logLine($, 'question', `an acknowledgment of a reply to ${ack.id} from ${from ?? 'no address'}, not its owner's, refused`)
  else if (!taken) await logLine($, 'question', `an acknowledgment of a reply to ${ack.id} matches no reply sent`)
  else $.ui.invalidate('ui.render')
  return { consumed: "orchestrator: a reply's acknowledgment, recorded" }
}

/**
 * One send of the answer a replica holds to its owner, at the address its last push came from: the
 * delivery then written `sent` with one more attempt, the host's refusal kept as its reason, while
 * it is still the one this send moves. Answers the refusal, or null.
 */
export async function sendReply($: Held, id: string): Promise<string | null> {
  const path = await pathOf($, id)
  let read = ''
  try {
    read = String(await $.fs.read(path))
  } catch (err) {
    await logLine($, 'question', `the answer to ${id} not sent: its replica could not be read (${messageOf(err)})`)
    return `its replica could not be read: ${messageOf(err)}`
  }
  const entry = parseAsked(read)
  const was = entry?.delivery
  // Only an answer given here, still on its way: one its owner's close replaced is not sent back to it.
  if (entry === null || entry.origin === undefined || entry.answer === null || !REPLICA_ANSWERS.includes(entry.answer.by) || (was?.state !== 'pending' && was?.state !== 'sent')) {
    await logLine($, 'question', `the answer to ${id} not sent: no answer given here waits to go`)
    return 'no answer given here waits to go'
  }
  const reply: QReply = {
    status: entry.status === 'withdrawn' ? 'withdrawn' : 'answered', text: entry.answer.text,
    by: entry.answer.by === 'coordinator' ? 'coordinator' : 'pane', at: entry.answer.at, settler: entry.answer.settler,
  }
  let reason: string | null = null
  try {
    const sent = await $.session.send({ to: entry.origin.address, text: qReplyLine(id, entry.seq, reply) })
    if (!sent?.isDelivered) reason = sent?.reason ?? 'no answer'
  } catch (err) {
    reason = messageOf(err)
  }
  const delivery = { state: 'sent' as const, at: new Date().toISOString(), attempts: was.attempts + 1, ...(reason !== null ? { reason } : {}) }
  try {
    await updateOver(storeIo($), path, current => {
      const now = current === undefined ? null : parseAsked(current)
      return now?.delivery?.state === was.state && now.delivery.attempts === was.attempts ? `${JSON.stringify({ ...now, delivery })}\n` : undefined
    })
  } catch (err) {
    await logLine($, 'question', `the send of the answer to ${id} not written: ${messageOf(err)}`)
  }
  if (reason !== null) await logLine($, 'question', `the answer to ${id} was not delivered to ${entry.sender.name} on ${entry.origin.machine}: ${reason}`)
  return reason
}

/** The replicas' answers not acknowledged, read at each round wake: sent again ANSWER_RESEND_MS after the last send, then failed. */
export async function resendReplies($: Held, now: number = Date.now()): Promise<void> {
  for (const entry of await readAsked($)) {
    const delivery = entry.delivery
    if (entry.origin === undefined || (delivery?.state !== 'pending' && delivery?.state !== 'sent') || now - Date.parse(delivery.at) < ANSWER_RESEND_MS) continue
    try {
      if (delivery.attempts < ANSWER_SENDS) {
        await sendReply($, entry.id)
        continue
      }
      const reason = `no acknowledgment after ${ANSWER_SENDS} sends`
      let written = false
      await updateOver(storeIo($), await pathOf($, entry.id), current => {
        const read = current === undefined ? null : parseAsked(current)
        written = read?.delivery?.state === delivery.state && read.delivery.attempts === delivery.attempts
        return written ? `${JSON.stringify({ ...read, delivery: { state: 'failed', at: new Date().toISOString(), attempts: delivery.attempts, reason } })}\n` : undefined
      })
      if (!written) continue
      await logLine($, 'question', `the answer to ${entry.id} on ${entry.origin.machine} failed: ${reason}`)
      $.ui.invalidate('ui.render')
    } catch (err) {
      await logLine($, 'question', `the answer to ${entry.id} not sent again: ${messageOf(err)}`)
    }
  }
}

// The sender is the coordinator on another machine this one pushes to: the address it learnt.
async function fromCoordinator($: Held, from: string | null): Promise<boolean> {
  const coordinator = await coordinatorAddress($)
  return from !== null && coordinator !== null && !coordinator.local && coordinator.to === from
}

async function ack($: Held, to: string, ack: QAck): Promise<void> {
  try {
    const sent = await $.session.send({ to, text: qAckLine(ack) })
    if (!sent?.isDelivered) await logLine($, 'question', `the acknowledgment of the ${ack.of} of ${ack.id} was not delivered to ${to}: ${sent?.reason ?? 'no answer'}`)
  } catch (err) {
    await logLine($, 'question', `the acknowledgment of the ${ack.of} of ${ack.id} was not sent: ${messageOf(err)}`)
  }
}
