/**
 * One search's time budget (routes/global-search.ts). Every part of a search —
 * each big collection's scan, the exact-id pass, people, notes, files… — runs
 * under it: a part still going at the deadline is cancelled (its statement is
 * stopped on the server, services/bounded-sql.ts) and answers empty, and its
 * name is kept so the answer can say it is partial. An exact id hit shortens
 * the deadline: the answer is known, the remaining scans get a short grace.
 *
 * At most `concurrency` statements of one search hold a pool connection at a
 * time (the rest queue), so one search never takes the pool.
 */

import { boundedRaw, StatementCancelled } from './bounded-sql.js'

const MIN_STATEMENT_MS = 50

export class SearchBudget {
  private deadline: number
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = 0
  private readonly queue: Array<() => void> = []
  /** Parts that ran out of time (collection names or part labels). */
  readonly timedOut = new Set<string>()

  constructor(
    totalMs: number,
    private readonly concurrency = 4,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = this.now() + Math.max(0, totalMs)
    this.arm()
  }

  /** Aborts at the deadline. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  remaining(): number {
    return Math.max(0, this.deadline - this.now())
  }

  expired(): boolean {
    return this.controller.signal.aborted || this.remaining() <= 0
  }

  /** Bring the deadline in to at most `ms` from now (never pushes it out). */
  shorten(ms: number): void {
    const next = this.now() + Math.max(0, ms)
    if (next >= this.deadline) return
    this.deadline = next
    this.arm()
  }

  /** Stop everything still running (the answer is complete or abandoned). */
  finish(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.controller.signal.aborted) this.controller.abort()
    for (const next of this.queue.splice(0)) next()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => {
      if (!this.controller.signal.aborted) this.controller.abort()
      for (const next of this.queue.splice(0)) next()
    }, this.remaining())
    // Never keeps the process alive on its own.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }

  /**
   * Run one part: `fallback` when the budget is spent before it starts or while it
   * runs (the label is then recorded in `timedOut`). Errors other than the budget's
   * own cancellation propagate.
   */
  async run<T>(label: string, fallback: T, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.expired()) {
      this.timedOut.add(label)
      return fallback
    }
    const signal = this.signal
    let onAbort: (() => void) | undefined
    const stopped = new Promise<typeof CUT>((resolve) => {
      onAbort = () => resolve(CUT)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const out = await Promise.race([fn(signal), stopped])
      if (out === CUT) {
        this.timedOut.add(label)
        return fallback
      }
      return out as T
    } catch (e) {
      if (e instanceof StatementCancelled || signal.aborted) {
        this.timedOut.add(label)
        return fallback
      }
      throw e
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  /** One read statement under the budget: queued for a slot, cancelled on the server at
   *  the deadline. Throws StatementCancelled when cut (callers use `run` around it). */
  async query<T = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[],
    opts: { native?: boolean } = {}
  ): Promise<T[]> {
    return this.slot(async () => {
      if (this.expired()) throw new StatementCancelled('timeout')
      return boundedRaw<T>(sql, bindings, {
        timeoutMs: Math.max(MIN_STATEMENT_MS, this.remaining()),
        signal: this.signal,
        native: opts.native
      })
    })
  }
}

const CUT = Symbol('budget-cut')
