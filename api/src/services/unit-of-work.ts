/**
 * Unit of work for multi-row writes (#793).
 *
 * A create's outbound effects — webhooks, event flows, watch and subscription
 * notifications, auto-started pipelines and auto transitions, realtime
 * broadcasts — used to fire the moment the row landed. A nested create, an
 * import execute, a batch mutation or an atomic bulk write compensates a
 * later failure by deleting the rows it made, but those effects had already
 * gone out: a partner was pushed a record that no longer exists, a watcher
 * was mailed about it.
 *
 * `runUnit` opens a unit on the async context; `deferEffect` queues an effect
 * while one is open and runs it at once otherwise. When the unit's function
 * returns, the queued effects run in order (each on its own, a failure logged
 * and never rethrown); when it throws, or the caller discards the unit after
 * compensating, they are dropped. A unit opened inside another joins it — the
 * outermost decides — so a child create's effects wait for the whole batch.
 *
 * Row-bound hooks (rollups, integrity, queue materialization, activity) stay
 * inline: they describe the row itself and compensation reverses them by
 * deleting the row.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface Effect {
  label: string
  run: () => Promise<unknown> | unknown
}

interface Unit {
  label: string
  effects: Effect[]
  discarded: boolean
}

export interface UnitHandle {
  /** Drop every effect queued so far and everything queued later — call it
   *  after compensating a failure the unit's function does not throw for. */
  discard(): void
  /** Effects waiting on this unit, for a response or a log line. */
  pending(): number
}

const als = new AsyncLocalStorage<Unit>()

export function unitOfWorkOpen(): boolean {
  return als.getStore() !== undefined
}

async function runEffect(e: Effect): Promise<void> {
  try {
    await e.run()
  } catch (err) {
    console.warn(`[unit-of-work] effect ${e.label} failed:`, (err as Error)?.message ?? err)
  }
}

/**
 * Run an outbound effect now, or once the open unit of work commits. Awaiting
 * it outside a unit awaits the effect (the historic behaviour); inside a unit
 * it resolves at once.
 */
export function deferEffect(label: string, run: () => Promise<unknown> | unknown): Promise<void> {
  const unit = als.getStore()
  if (!unit) return runEffect({ label, run })
  if (!unit.discarded) unit.effects.push({ label, run })
  return Promise.resolve()
}

/**
 * Open a unit of work around `fn`. Nested inside another unit, `fn` simply
 * joins it (the handle's discard() then discards the outer unit too — an
 * atomic step inside a larger one fails the whole).
 */
export async function runUnit<T>(label: string, fn: (unit: UnitHandle) => Promise<T>): Promise<T> {
  const outer = als.getStore()
  if (outer) {
    return fn({
      discard: () => {
        outer.discarded = true
        outer.effects.length = 0
      },
      pending: () => outer.effects.length
    })
  }
  const unit: Unit = { label, effects: [], discarded: false }
  const handle: UnitHandle = {
    discard: () => {
      unit.discarded = true
      unit.effects.length = 0
    },
    pending: () => unit.effects.length
  }
  let result: T
  try {
    result = await als.run(unit, () => fn(handle))
  } catch (err) {
    unit.discarded = true
    unit.effects.length = 0
    throw err
  }
  if (!unit.discarded) {
    const queued = unit.effects.splice(0)
    for (const e of queued) await runEffect(e)
  }
  return result
}

/** `runUnit` for callers with nothing to discard by hand: a throw drops the
 *  effects, a return releases them. */
export function withUnitOfWork<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runUnit(label, () => fn())
}
