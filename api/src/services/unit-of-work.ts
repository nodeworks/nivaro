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
 *
 * A DETACHED effect is one the writer never waited for before units existed
 * (an "after" event flow — "async, post-save processing"): it is held and
 * dropped with the unit like any other, but once the unit commits it only
 * STARTS in its turn and the unit returns without it. Running every queued
 * effect to the end made a create answer only after its event flows' partner
 * calls had come back (production 2026-11-12: an inventory request create
 * averaged 2.3 s, 1.5 s of it one flow's push to a partner that nothing in
 * the answer or the next page read depends on).
 */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import { runInBackgroundPool } from '../db/pool-context.js'
import { getTenantId } from '../db/tenant-context.js'

export interface EffectOptions {
  /**
   * The writer does not wait for this effect. Inside a unit it starts when
   * the unit commits — after every effect queued before it has finished and
   * after the detached effects before it (one at a time, so a batch never
   * fans them out) — on the background pool, and the unit returns without
   * it. Outside a unit it runs at once like any effect. Only for work that
   * records its own outcome and that neither the caller's answer nor the next
   * read of the record depends on.
   */
  detached?: boolean
}

interface Effect {
  label: string
  run: () => Promise<unknown> | unknown
  detached?: boolean
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
export function deferEffect(
  label: string,
  run: () => Promise<unknown> | unknown,
  opts?: EffectOptions
): Promise<void> {
  const unit = als.getStore()
  if (!unit) return runEffect({ label, run })
  if (!unit.discarded) unit.effects.push({ label, run, detached: opts?.detached === true })
  return Promise.resolve()
}

/**
 * Detached effects across units.
 *
 * Inside one unit they run one at a time, but a loop of creates (an import, an
 * inbound feed, a flow that creates rows) opens a unit per row, so without a
 * limit every row's detached effect starts at once: N partner calls together
 * on the small background pool, where each create used to wait for its own.
 * - At most DETACHED_SLOTS run at once per tenant; the rest wait their turn in
 *   the order their units committed.
 * - Once DETACHED_BACKLOG are waiting, a committing unit runs its detached
 *   effects ITSELF and waits for them, exactly as every writer did before
 *   effects could detach. A bulk load therefore cannot outrun its effects
 *   without bound (in memory or against the partner), and no writer ever
 *   queues behind other writers' effects: a partner that hangs slows the
 *   writes that call it, never every write of the tenant.
 * - A run that has not finished after DETACHED_SLOT_MS gives its slot to the
 *   next one (it carries on and still records its own outcome), so runs that
 *   hang cannot hold the lane for good.
 * - A waiting effect runs in the async context of the unit that queued it (its
 *   tenant, its request), not of whichever effect freed the slot.
 * - What is queued or running is counted, so shutdown can wait for it
 *   (drainDetachedEffects) instead of dropping runs nothing recorded yet.
 */
export const DETACHED_SLOTS = 2
export const DETACHED_BACKLOG = 20
export const DETACHED_SLOT_MS = 30_000

interface DetachedLane {
  running: number
  waiting: Array<() => void>
}
const lanes = new Map<string, DetachedLane>()
let detachedOut = 0

/** Detached effects queued or running in this process (all tenants). */
export function detachedEffectsPending(): number {
  return detachedOut
}

/**
 * Wait up to `timeoutMs` for the detached effects in flight to finish; answers
 * how many were still out. For shutdown: the writers already got their answer.
 */
export async function drainDetachedEffects(timeoutMs: number): Promise<{ left: number }> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (detachedOut > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))))
  }
  return { left: detachedOut }
}

function laneFor(key: string): DetachedLane {
  let lane = lanes.get(key)
  if (!lane) {
    lane = { running: 0, waiting: [] }
    lanes.set(key, lane)
  }
  return lane
}

/**
 * Start `e` when its tenant has a free slot. Resolves when it has finished, or
 * when it has held its slot for DETACHED_SLOT_MS (the next effect of its unit
 * then starts; this one carries on).
 */
function runDetached(e: Effect): Promise<void> {
  const key = getTenantId() ?? ''
  const lane = laneFor(key)
  // Bound now, while the queuing unit's context is still the current one.
  const work = AsyncResource.bind(() => runInBackgroundPool(() => runEffect(e)))
  detachedOut++
  return new Promise<void>((resolve) => {
    const go = () => {
      lane.running++
      let freed = false
      const free = () => {
        if (freed) return
        freed = true
        lane.running--
        resolve()
        const next = lane.waiting.shift()
        if (next) next()
        else if (lane.running === 0 && lanes.get(key) === lane) lanes.delete(key)
      }
      const limit = setTimeout(() => {
        console.warn(
          `[unit-of-work] detached effect ${e.label} is still running after ${DETACHED_SLOT_MS / 1000}s: its slot goes to the next one`
        )
        free()
      }, DETACHED_SLOT_MS)
      limit.unref?.()
      // runEffect never rejects, so this chain needs no catch of its own.
      void work().then(() => {
        clearTimeout(limit)
        detachedOut--
        free()
      })
    }
    if (lane.running < DETACHED_SLOTS) go()
    else lane.waiting.push(go)
  })
}

/**
 * Run a committed unit's effects in the order they were queued. The unit
 * waits for each plain effect; a detached one is started in its turn (behind
 * the detached effects before it, and when its tenant has a free slot) and
 * left to finish on the background pool. With a deep backlog the unit runs
 * its detached effects itself, like plain ones.
 */
async function releaseEffects(queued: Effect[]): Promise<void> {
  const crowded = (lanes.get(getTenantId() ?? '')?.waiting.length ?? 0) >= DETACHED_BACKLOG
  let detachedTail: Promise<void> | null = null
  for (const e of queued) {
    if (!e.detached || crowded) {
      await runEffect(e)
      continue
    }
    const start = () => runDetached(e)
    detachedTail = detachedTail ? detachedTail.then(start) : start()
  }
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
  if (!unit.discarded) await releaseEffects(unit.effects.splice(0))
  return result
}

/** `runUnit` for callers with nothing to discard by hand: a throw drops the
 *  effects, a return releases them. */
export function withUnitOfWork<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runUnit(label, () => fn())
}
