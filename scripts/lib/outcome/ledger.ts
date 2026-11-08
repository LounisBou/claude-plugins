// What a run has spent, against its caps. An arm starts only when the run can still pay its
// whole case-and-arm cap, so every arm that runs is measured under the same cap and the run
// never passes its own. The arm's share is that cap less two judgments, kept for its grading.
import type { Caps } from './cases.ts'

export class Ledger {
  readonly caps: Caps
  #spent = 0

  constructor(caps: Caps) {
    this.caps = caps
  }

  get spent(): number {
    return this.#spent
  }

  /** An account for one arm of one case, or null when the run cannot pay the whole cap. */
  open(): Account | null {
    if (this.caps.runUsd - this.#spent < this.caps.caseArmUsd) return null
    return new Account(this.caps, usd => {
      this.#spent += usd
    })
  }
}

export class Account {
  readonly #caps: Caps
  readonly #record: (usd: number) => void
  #spent = 0

  constructor(caps: Caps, record: (usd: number) => void) {
    this.#caps = caps
    this.#record = record
  }

  get spent(): number {
    return this.#spent
  }

  /** What the arm itself may spend: the case-and-arm cap less two judgments. */
  get armUsd(): number {
    return this.#caps.caseArmUsd - 2 * this.#caps.judgeUsd
  }

  /** What the next judgment may spend; zero once the cap is reached. */
  get judgeUsd(): number {
    return Math.max(0, Math.min(this.#caps.judgeUsd, this.#caps.caseArmUsd - this.#spent))
  }

  charge(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error(`a charge must be a non-negative amount, not ${usd}`)
    this.#spent += usd
    this.#record(usd)
  }
}
