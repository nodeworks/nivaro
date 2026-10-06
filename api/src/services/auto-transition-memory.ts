/**
 * Auto-transition failure memory (#1217, migration 396).
 *
 * An automatic transition whose blocking action fails (a partner refusing an
 * order push) stays eligible — its condition rules still pass — so the
 * after-write hook and the hourly sweep used to fire it again and again: one
 * refused MDSi request produced 192 failed submissions in four hours. Each
 * failure now leaves one row per (instance, transition): the error class and a
 * hash of what the transition's blocking actions would send. While that hash
 * is unchanged the engine leaves the transition alone and the record reads
 * "needs a person" (pipeline panel, Integrations console). Clearing:
 *  - the rendered payload changes (a record edit, a linked row) — the next
 *    evaluation sees a different hash, drops the memory and tries once more;
 *  - any transition lands on the instance (manual or auto);
 *  - a person retries — a manual transition attempt, a submission retry, a
 *    re-run of a push action;
 *  - a retryable class (transient / rate limited / auth) climbs the
 *    remediation ladder on its own: the same bytes are tried again at
 *    1, 5, 30, 120, 120 minutes, then held like any other failure.
 * The memory is consulted ONLY by runAutoTransitions — a manual transition is
 * never refused because of it.
 */
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

export const AUTO_FAILURE_TABLE = 'nivaro_auto_transition_failures'

export interface AutoTransitionFailure {
  id: number
  instance_id: string
  transition_id: string
  collection: string
  item: string
  transition_label: string | null
  error_class: string | null
  error: string | null
  payload_hash: string | null
  attempts: number
  first_failed_at: Date | string
  last_failed_at: Date | string
}

/** The engine's view of one held transition (what the panel + signal show). */
export interface HeldAutoTransition {
  transition_id: string
  transition_label: string | null
  error_class: string | null
  error: string | null
  attempts: number
  first_failed_at: string
  last_failed_at: string
  /** Retryable classes: when the ladder tries the same bytes again; null = held
   *  until something changes. */
  retry_at: string | null
}

/** Classes where sending the identical bytes again could plausibly work —
 *  mirrors integration-remediation RETRYABLE_CLASSES. */
const RETRYABLE = new Set(['transient', 'rate_limited', 'auth'])
/** Minutes between attempts (integration-remediation's ladder). */
const LADDER = [1, 5, 30, 120, 120]

export async function memoryAvailable(): Promise<boolean> {
  try {
    return await hasColumn(AUTO_FAILURE_TABLE, 'payload_hash')
  } catch {
    return false
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * A payload stamped with "now" to the second would never hash the same twice
 * and the memory would hold nothing. Datetimes collapse to their calendar day:
 * the day moving on IS a change (a delivery date recomputed), the clock
 * ticking is not.
 */
export function normalizeForHash(v: unknown): unknown {
  if (typeof v === 'string') {
    const m = ISO_DATETIME.exec(v)
    return m ? m[1] : v
  }
  if (Array.isArray(v)) return v.map(normalizeForHash)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = normalizeForHash((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** sha256 over what a transition's blocking actions would do: per action its
 *  index, endpoint, preview status and normalized body. */
export function hashBlockingPreview(
  previews: Array<{
    index: number
    endpoint_path: string | null
    status: string
    body: Record<string, unknown> | null
  }>
): string {
  const shape = previews.map((p) => ({
    i: p.index,
    e: p.endpoint_path ?? null,
    s: p.status,
    b: normalizeForHash(p.body ?? null)
  }))
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

/** When a retryable failure may try the same bytes again; null = never on its
 *  own (not retryable, or the ladder is spent). */
export function retryAtFor(
  errorClass: string | null,
  attempts: number,
  lastFailedAt: Date
): Date | null {
  if (!errorClass || !RETRYABLE.has(errorClass)) return null
  if (attempts >= LADDER.length) return null
  return new Date(lastFailedAt.getTime() + LADDER[Math.max(0, attempts - 1)] * 60_000)
}

export type AutoRetryDecision =
  /** Payload changed since the failure — forget it and try again. */
  | { action: 'retry-changed' }
  /** Same payload, but a retryable class whose ladder rung has come up. */
  | { action: 'retry-ladder' }
  /** Same payload, nothing new — leave the transition alone. */
  | { action: 'hold' }

export function decideAutoRetry(
  memory: Pick<
    AutoTransitionFailure,
    'payload_hash' | 'error_class' | 'attempts' | 'last_failed_at'
  >,
  currentHash: string | null,
  now: Date
): AutoRetryDecision {
  // No hash on either side means we cannot tell — hold rather than refire.
  if (memory.payload_hash && currentHash && memory.payload_hash !== currentHash) {
    return { action: 'retry-changed' }
  }
  const retryAt = retryAtFor(
    memory.error_class,
    Number(memory.attempts) || 1,
    new Date(memory.last_failed_at)
  )
  if (retryAt && retryAt.getTime() <= now.getTime()) return { action: 'retry-ladder' }
  return { action: 'hold' }
}

// ── Rendering the payload hash ──────────────────────────────────────────────

interface TransitionLike {
  id: string
  label: string
  actions: string | null
  to_state: string
}

/**
 * Hash what the transition's blocking actions would send right now — a
 * read-only render (previewErpActions sends nothing, writes nothing). The
 * state scope is the transition's own to_state every time, so the hash taken
 * at failure and the one taken at the next evaluation compare like for like.
 */
export async function blockingPayloadHash(
  transition: TransitionLike,
  instance: { collection: string; item: string }
): Promise<string | null> {
  try {
    const { previewErpActions } = await import('./workflow-actions.js')
    const state = (await db('nivaro_workflow_states').where({ id: transition.to_state }).first()) as
      | { key: string; label: string }
      | undefined
    const previews = await previewErpActions({
      transition,
      instance: { collection: instance.collection, item: String(instance.item) },
      newStateObj: state ?? null,
      userId: null
    })
    return hashBlockingPreview(previews.filter((p) => p.blocking))
  } catch {
    return null
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────

export async function getAutoFailure(
  instanceId: string,
  transitionId: string
): Promise<AutoTransitionFailure | null> {
  if (!(await memoryAvailable())) return null
  try {
    const row = (await db(AUTO_FAILURE_TABLE)
      .where({ instance_id: String(instanceId), transition_id: String(transitionId) })
      .first()) as AutoTransitionFailure | undefined
    return row ?? null
  } catch {
    return null
  }
}

export async function recordAutoFailure(opts: {
  instance: { id: string; collection: string; item: string }
  transition: { id: string; label: string }
  errorClass: string | null
  error: string | null
  payloadHash: string | null
}): Promise<void> {
  if (!(await memoryAvailable())) return
  const now = new Date()
  const key = { instance_id: String(opts.instance.id), transition_id: String(opts.transition.id) }
  const fields = {
    collection: opts.instance.collection,
    item: String(opts.instance.item),
    transition_label: opts.transition.label?.slice(0, 255) ?? null,
    error_class: opts.errorClass?.slice(0, 20) ?? null,
    error: opts.error?.slice(0, 2000) ?? null,
    payload_hash: opts.payloadHash,
    last_failed_at: now
  }
  try {
    const existing = (await db(AUTO_FAILURE_TABLE).where(key).first('id', 'attempts')) as
      | { id: number; attempts: number }
      | undefined
    if (existing) {
      await db(AUTO_FAILURE_TABLE)
        .where({ id: existing.id })
        .update({ ...fields, attempts: (Number(existing.attempts) || 1) + 1 })
    } else {
      await db(AUTO_FAILURE_TABLE).insert({ ...key, ...fields, attempts: 1, first_failed_at: now })
    }
  } catch (err) {
    // A racing twin inserted first (unique key) — fold into its row.
    try {
      await db(AUTO_FAILURE_TABLE)
        .where(key)
        .update({ ...fields, attempts: db.raw('attempts + 1') })
    } catch {
      console.warn('[auto-transition-memory] could not record failure:', err)
    }
  }
}

/** Forget failures — one transition, a whole instance, or every instance of a
 *  record. Best-effort: forgetting must never fail the action that asked. */
export async function clearAutoFailures(
  where: { instanceId: string; transitionId?: string } | { collection: string; item: string }
): Promise<number> {
  if (!(await memoryAvailable())) return 0
  try {
    const q = db(AUTO_FAILURE_TABLE)
    if ('instanceId' in where) {
      q.where({ instance_id: String(where.instanceId) })
      if (where.transitionId) q.where({ transition_id: String(where.transitionId) })
    } else {
      q.where({ collection: where.collection, item: String(where.item) })
    }
    return Number(await q.del()) || 0
  } catch {
    return 0
  }
}

function iso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

export function toHeld(row: AutoTransitionFailure): HeldAutoTransition {
  const retryAt = retryAtFor(
    row.error_class,
    Number(row.attempts) || 1,
    new Date(row.last_failed_at)
  )
  return {
    transition_id: String(row.transition_id),
    transition_label: row.transition_label,
    error_class: row.error_class,
    error: row.error,
    attempts: Number(row.attempts) || 1,
    first_failed_at: iso(row.first_failed_at),
    last_failed_at: iso(row.last_failed_at),
    retry_at: retryAt ? retryAt.toISOString() : null
  }
}

/** The held transitions on one instance (the pipeline panel's read). */
export async function heldForInstance(instanceId: string): Promise<HeldAutoTransition[]> {
  if (!(await memoryAvailable())) return []
  try {
    const rows = (await db(AUTO_FAILURE_TABLE)
      .where({ instance_id: String(instanceId) })
      .orderBy('first_failed_at', 'asc')) as AutoTransitionFailure[]
    return rows.map(toHeld)
  } catch {
    return []
  }
}

/**
 * Should the engine leave this auto transition alone? Answers from the memory
 * (one indexed read; nothing to render when the transition never failed).
 * A changed payload forgets the failure on the spot, so the record stops
 * reading "needs a person" the moment an edit makes the send different.
 */
export async function autoTransitionHeld(
  instance: { id: string; collection: string; item: string },
  transition: TransitionLike
): Promise<boolean> {
  const memory = await getAutoFailure(instance.id, transition.id)
  if (!memory) return false
  const hash = await blockingPayloadHash(transition, instance)
  const decision = decideAutoRetry(memory, hash, new Date())
  if (decision.action === 'retry-changed') {
    await clearAutoFailures({ instanceId: instance.id, transitionId: transition.id })
    return false
  }
  return decision.action === 'hold'
}
