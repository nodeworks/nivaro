/**
 * The integration obligation ledger.
 *
 * An obligation is opened at the moment the condition that makes a partner
 * expect a message becomes true — NOT when a send is attempted. It is then
 * resolved with an outcome. `sent` is one good outcome; `skipped` with a
 * legitimate reason is another. The value is that the NO is written down,
 * because today an unmet guard, an unchanged payload signature, an empty
 * context and a rejected flow condition are all equally invisible.
 *
 * Core owns the shape. WHICH sends exist is data: an extension registers its
 * kinds, and a decision point core cannot attribute to a registered kind
 * writes nothing at all — so this file mentions no partner by name and an
 * install with no registrations behaves exactly as it did before.
 *
 * Nothing here throws. A ledger failure is bookkeeping lost, never a send
 * lost.
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'

export type ObligationOutcome =
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'pending'
  | 'overdue'
  | 'missing'
  | 'superseded'

export type ObligationTrigger =
  | 'transition'
  | 'hook'
  | 'flow'
  | 'cron'
  | 'reconcile'
  | 'manual'

/** Outcomes that still want something to happen. */
export const OPEN_OUTCOMES: ObligationOutcome[] = ['pending', 'failed', 'overdue', 'missing']

export interface ObligationTriggerContext {
  collection: string
  item: string
  api: string
  source: 'erp_submit' | 'flow' | 'hook' | 'cron' | 'manual'
  endpoint_path?: string | null
  transition_label?: string | null
  to_state_key?: string | null
  flow_name?: string | null
  /** The action's own declared shape — its context-query keys and skip gates.
   *  Two actions on one endpoint are told apart by this, because the rendered
   *  payload does not exist yet when the obligation must be opened (guards
   *  run after the open, so that a guard refusal is itself recorded). */
  action_context_keys?: string[]
  action_skip_unless_any?: string[]
  action_skip_when_empty?: string | null
}

export interface ExpectedObligation {
  item: string
  due_at: Date
  signature?: string | null
  detail?: string | null
}

export interface ObligationKindDef {
  api: string
  kind: string
  collection: string
  label: string
  /** Minutes after due_at before the sweep calls an unmet expectation overdue.
   *  Falls back to the API's skip_grace_minutes. */
  grace_minutes?: number
  matches?(ctx: ObligationTriggerContext): boolean
  /** Records the partner is BEHIND on, derived from data alone. A returned
   *  row means "the partner does not have this", never "this happened". */
  expect(database: Knex): Promise<ExpectedObligation[]>
  /** Phase 2 only: may the sweep re-fire a `missing` row by itself? */
  safe_to_refire?: boolean
}

const registry = new Map<string, ObligationKindDef>()
const keyOf = (api: string, kind: string) => `${api}::${kind}`

export function registerObligationKind(def: ObligationKindDef): void {
  registry.set(keyOf(def.api, def.kind), def)
}

export function clearObligationKinds(): void {
  registry.clear()
}

export function getObligationKind(api: string, kind: string): ObligationKindDef | undefined {
  return registry.get(keyOf(api, kind))
}

export function listObligationKinds(): Array<Omit<ObligationKindDef, 'expect' | 'matches'>> {
  return [...registry.values()].map(({ expect: _e, matches: _m, ...rest }) => rest)
}

export function allObligationKinds(): ObligationKindDef[] {
  return [...registry.values()]
}

/**
 * Which kind, if any, a decision point belongs to. A kind that declares a
 * `matches` predicate is preferred over a catch-all on the same collection —
 * several kinds routinely share one endpoint and only the specific one should
 * claim a decision it recognises.
 */
export function resolveKindForTrigger(ctx: ObligationTriggerContext): ObligationKindDef | null {
  const candidates = [...registry.values()].filter(
    (d) => d.api === ctx.api && d.collection === ctx.collection
  )
  if (candidates.length === 0) return null
  for (const d of candidates) {
    if (typeof d.matches === 'function') {
      try {
        if (d.matches(ctx)) return d
      } catch {
        /* a broken predicate never claims the decision */
      }
    }
  }
  return candidates.find((d) => typeof d.matches !== 'function') ?? null
}

function detailColumn(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null
  try {
    const s = JSON.stringify(detail)
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s
  } catch {
    return null
  }
}

let warned = false
function warnOnce(err: unknown): void {
  if (warned) return
  warned = true
  console.warn({ err }, 'integration obligations: ledger write failed (bookkeeping only)')
}

/** Open (or directly close) an obligation. Returns its id, or null when the
 *  ledger could not be written — every caller treats null as "no ledger". */
export async function recordObligation(opts: {
  api: string
  kind: string
  collection: string
  item: string | number
  trigger: ObligationTrigger
  trigger_ref?: string | null
  due_at?: Date
  outcome?: ObligationOutcome
  reason?: string | null
  detail?: unknown
}): Promise<number | null> {
  try {
    const now = new Date()
    const outcome = opts.outcome ?? 'pending'
    const closed = outcome === 'sent' || outcome === 'skipped' || outcome === 'superseded'
    const inserted = (await db('nivaro_integration_obligations')
      .insert({
        api: opts.api,
        kind: opts.kind,
        collection: opts.collection,
        item: String(opts.item),
        trigger: opts.trigger,
        trigger_ref: opts.trigger_ref?.slice(0, 200) ?? null,
        due_at: opts.due_at ?? now,
        outcome,
        reason: opts.reason?.slice(0, 500) ?? null,
        detail: detailColumn(opts.detail),
        resolved_at: closed ? now : null,
        created_at: now
      })
      .returning('id')) as Array<number | { id: number }>
    const first = inserted[0]
    // tedious hands an OBJECT back from .returning on this stack.
    return typeof first === 'object' && first !== null ? Number(first.id) : Number(first ?? 0) || null
  } catch (err) {
    warnOnce(err)
    return null
  }
}

/** Close an obligation with its outcome. A null id is a no-op, so callers
 *  never have to branch on whether the open succeeded. */
export async function resolveObligation(
  id: number | null,
  patch: {
    outcome: ObligationOutcome
    reason?: string | null
    submission_id?: number | null
    signature?: string | null
    resolved_by?: string | null
    detail?: unknown
  }
): Promise<void> {
  if (id == null) return
  try {
    const closed =
      patch.outcome === 'sent' || patch.outcome === 'skipped' || patch.outcome === 'superseded'
    const row: Record<string, unknown> = {
      outcome: patch.outcome,
      reason: patch.reason?.slice(0, 500) ?? null,
      resolved_at: closed ? new Date() : null
    }
    if (patch.submission_id !== undefined) row.submission_id = patch.submission_id
    if (patch.signature !== undefined) row.signature = patch.signature?.slice(0, 64) ?? null
    if (patch.resolved_by !== undefined) row.resolved_by = patch.resolved_by
    if (patch.detail !== undefined) row.detail = detailColumn(patch.detail)
    await db('nivaro_integration_obligations').where({ id }).update(row)
  } catch (err) {
    warnOnce(err)
  }
}

export type SkipReasonKind =
  | 'guard'
  | 'not_configured'
  | 'skip_when_empty'
  | 'skip_unless_any'
  | 'push_when'
  | 'template_error'
  | 'flow_condition'

/**
 * The one place a non-`sent` outcome is put into words. The board, the record
 * banner, the Notes thread and the digest all read this column, so wording
 * lives here rather than at six call sites that would drift apart.
 */
export function skipReason(kind: SkipReasonKind, detail: string): string {
  const d = String(detail ?? '').trim()
  const text =
    kind === 'guard'
      ? `guard unmet: ${d}`
      : kind === 'not_configured'
        ? `not configured: ${d} missing on the action`
        : kind === 'skip_when_empty'
          ? `skip_when_empty: ${d} empty`
          : kind === 'skip_unless_any'
            ? `skip_unless_any: none of ${d} is set`
            : kind === 'push_when'
              ? `push_when: ${d}`
              : kind === 'template_error'
                ? `payload template error: ${d}`
                : kind === 'flow_condition'
                  ? `flow condition rejected at "${d}"`
                  : `${kind}: ${d}`
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

/** The decision-point entry point: attribute the context to a kind and open
 *  a `pending` row. Returns null when no kind claims it — which is how an
 *  unregistered integration stays exactly as silent as it is today. */
export async function openObligationForTrigger(
  ctx: ObligationTriggerContext,
  opts: { trigger: ObligationTrigger; trigger_ref?: string | null; due_at?: Date }
): Promise<number | null> {
  const def = resolveKindForTrigger(ctx)
  if (!def) return null
  return recordObligation({
    api: def.api,
    kind: def.kind,
    collection: ctx.collection,
    item: ctx.item,
    trigger: opts.trigger,
    trigger_ref: opts.trigger_ref ?? null,
    due_at: opts.due_at,
    outcome: 'pending'
  })
}
