/**
 * One search's time budget (routes/global-search.ts). Every part of a search —
 * each big collection's scan, the exact-id pass, people, notes, files… — runs
 * under it: a part still going at the deadline is cancelled (its statement is
 * stopped on the server, services/bounded-sql.ts) and answers empty, and its
 * name is kept so the answer can say it is partial. An exact id hit shortens
 * the deadline: the answer is known, the remaining scans get a short grace.
 *
 * At most `concurrency` statements of one search hold a pool connection at a
 * time (the rest queue), so one search never takes the pool. Two things keep an
 * exact record match from being starved (army 7 b16 N1: a project number answered
 * nothing 2 of 3 times on a quiet staging — the notes / files scans took every
 * slot while the record half was still planning, and the exact-id seek waited
 * behind them until the deadline cut it):
 *
 * - **Priority.** A queued statement with a higher `priority` gets the next free
 *   slot first (FIFO within one priority). Global search: exact ids 2, record
 *   scans 1, everything else 0.
 * - **One reserved slot** for `reserved` statements (the exact-id seeks — cheap
 *   index seeks), so they never wait behind running scans: at most
 *   `concurrency + 1` statements, the extra one only ever a reserved one.
 * - **A floor** (`runQuery` with `floorMs`): the part may run until the later of
 *   the deadline and its own start + floor, so a seek that started late is not cut
 *   by a deadline it could not have met. Ending the search (`finish`) still stops it.
 */

import { boundedRaw, StatementCancelled } from './bounded-sql.js'

const MIN_STATEMENT_MS = 50
/** Slots only `reserved` statements may use, beyond `concurrency`. */
const RESERVED_SLOTS = 1

type SlotKind = 'normal' | 'reserved'

interface Waiter {
  priority: number
  seq: number
  reserved: boolean
  grant: (kind: SlotKind | null) => void
}

export interface BudgetQueryOpts {
  native?: boolean
  /** Higher is served first from the queue (default 0). */
  priority?: number
  /** May use the reserved slot (cheap seeks only). */
  reserved?: boolean
}

export class SearchBudget {
  private deadline: number
  private readonly controller = new AbortController()
  /** Aborted only by finish(): floored parts outlive the deadline, never the search. */
  private readonly finished = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = 0
  private reservedActive = 0
  private seq = 0
  private readonly waiters: Waiter[] = []
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

  /** Statements holding a slot right now (tests and diagnostics). */
  running(): number {
    return this.active + this.reservedActive
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
    if (!this.finished.signal.aborted) this.finished.abort()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => {
      if (!this.controller.signal.aborted) this.controller.abort()
    }, this.remaining())
    // Never keeps the process alive on its own.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private freeKind(reserved: boolean): SlotKind | null {
    if (this.active < this.concurrency) return 'normal'
    if (reserved && this.reservedActive < RESERVED_SLOTS) return 'reserved'
    return null
  }

  private take(kind: SlotKind): void {
    if (kind === 'normal') this.active++
    else this.reservedActive++
  }

  /** Hand free slots to the waiters, highest priority first (FIFO within one). */
  private pump(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i]
      const kind = this.freeKind(w.reserved)
      if (!kind) {
        i++
        continue
      }
      this.waiters.splice(i, 1)
      this.take(kind)
      w.grant(kind)
    }
  }

  /**
   * Hold one slot while `fn` runs. Cut (StatementCancelled) when `signal` aborts
   * while waiting — the waiter leaves the queue, so the cap is never exceeded.
   */
  private async slot<T>(
    fn: () => Promise<T>,
    signal: AbortSignal,
    priority = 0,
    reserved = false
  ): Promise<T> {
    if (signal.aborted) throw new StatementCancelled('timeout')
    let kind = this.waiters.length === 0 ? this.freeKind(reserved) : null
    // A reserved statement may take the reserved slot even while others queue.
    if (!kind && reserved && this.reservedActive < RESERVED_SLOTS) kind = 'reserved'
    if (kind) this.take(kind)
    else {
      kind = await new Promise<SlotKind | null>((resolve) => {
        const w: Waiter = {
          priority,
          seq: this.seq++,
          reserved,
          grant: (k) => {
            signal.removeEventListener('abort', onAbort)
            resolve(k)
          }
        }
        const onAbort = () => {
          const i = this.waiters.indexOf(w)
          if (i >= 0) this.waiters.splice(i, 1)
          resolve(null)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // Highest priority first, FIFO within a priority.
        let at = this.waiters.findIndex(
          (o) => o.priority < priority || (o.priority === priority && o.seq > w.seq)
        )
        if (at < 0) at = this.waiters.length
        this.waiters.splice(at, 0, w)
      })
      if (!kind) throw new StatementCancelled('timeout')
    }
    const held = kind
    try {
      return await fn()
    } finally {
      if (held === 'normal') this.active--
      else this.reservedActive--
      this.pump()
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
    opts: BudgetQueryOpts = {}
  ): Promise<T[]> {
    return this.slot(
      async () => {
        if (this.expired()) throw new StatementCancelled('timeout')
        return boundedRaw<T>(sql, bindings, {
          timeoutMs: Math.max(MIN_STATEMENT_MS, this.remaining()),
          signal: this.signal,
          native: opts.native
        })
      },
      this.signal,
      opts.priority ?? 0,
      opts.reserved === true
    )
  }

  /**
   * One statement as its own part (run + query in one): `[]` when cut, the label then
   * in `timedOut`. With `floorMs` it may run until the later of the deadline and its
   * own start + floor — an exact-id seek that started late still finishes; `finish()`
   * stops it like any other. Errors other than the cut propagate.
   */
  async runQuery<T = Record<string, unknown>>(
    label: string,
    sql: string,
    bindings: readonly unknown[],
    opts: BudgetQueryOpts & { floorMs?: number } = {}
  ): Promise<T[]> {
    const floor = Math.max(0, opts.floorMs ?? 0)
    if (!floor) {
      return this.run(label, [] as T[], () => this.query<T>(sql, bindings, opts))
    }
    if (this.finished.signal.aborted) {
      this.timedOut.add(label)
      return []
    }
    const until = Math.max(this.deadline, this.now() + floor)
    const part = new AbortController()
    const stop = () => {
      if (!part.signal.aborted) part.abort()
    }
    this.finished.signal.addEventListener('abort', stop, { once: true })
    // The wait for a slot is capped by the request-time floor; once the slot is granted
    // the floor restarts at the statement's own start, as documented above.
    let timer = setTimeout(stop, Math.max(0, until - this.now()))
    ;(timer as { unref?: () => void }).unref?.()
    try {
      return await this.slot(
        async () => {
          if (part.signal.aborted) throw new StatementCancelled('timeout')
          clearTimeout(timer)
          const runUntil = Math.max(this.deadline, this.now() + floor)
          timer = setTimeout(stop, Math.max(0, runUntil - this.now()))
          ;(timer as { unref?: () => void }).unref?.()
          const left = runUntil - this.now()
          if (left <= 0) throw new StatementCancelled('timeout')
          return boundedRaw<T>(sql, bindings, {
            timeoutMs: Math.max(MIN_STATEMENT_MS, left),
            signal: part.signal,
            native: opts.native
          })
        },
        part.signal,
        opts.priority ?? 0,
        opts.reserved === true
      )
    } catch (e) {
      if (e instanceof StatementCancelled || part.signal.aborted) {
        this.timedOut.add(label)
        return []
      }
      throw e
    } finally {
      clearTimeout(timer)
      this.finished.signal.removeEventListener('abort', stop)
    }
  }
}

const CUT = Symbol('budget-cut')
