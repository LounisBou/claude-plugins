// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// Work given a deadline is cancelled when it passes: the work receives a signal, and nothing it
// does after the deadline may write. Abandoning a promise without cancelling it is how late
// writes landed after newer ones.

export class DeadlineExceeded extends Error {
  readonly ms: number

  constructor(ms: number) {
    super(`deadline of ${ms} ms passed`)
    this.name = 'DeadlineExceeded'
    this.ms = ms
  }
}

/** Runs `work` with a signal aborted at `ms`; rejects with DeadlineExceeded when the deadline wins. */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settled before the abort, so work that resolves on the signal never wins the race.
      const error = new DeadlineExceeded(ms)
      reject(error)
      controller.abort(error)
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}
