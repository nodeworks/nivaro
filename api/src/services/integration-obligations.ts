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

export type ObligationTrigger = 'transition' | 'hook' | 'flow' | 'cron' | 'reconcile' | 'manual'

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
   *  row means "the partner does not have this", never "this happened".
   *  `epoch` (getObligationsEpoch) is the moment obligations started
   *  counting — a kind's own WHERE clause must exclude anything whose
   *  relevant moment (state entry, last edit, a link's created stamp — the
   *  kind decides which) predates it, or the first sweep against an
   *  existing database floods `missing` for every never-pushed record since
   *  the beginning of time. Required, not optional: a kind that ignores it
   *  is exactly the flooding this parameter exists to prevent. */
  expect(database: Knex, opts: { epoch: Date }): Promise<ExpectedObligation[]>
  /**
   * Phase 2 only: may the sweep re-fire a `missing` row by itself?
   *
   * OPT-IN, deliberately: absent or false means never. A re-fire repeats the
   * BYTES of an earlier request, so it is only ever correct for a kind whose
   * stored body cannot go stale (an id that is what it always was). A
   * state-carrying kind would re-assert an old state, and a kind a person is
   * supposed to trigger would act for them — both are worse than leaving the
   * row `missing` for someone to look at.
   */
  safe_to_refire?: boolean
  /**
   * This kind's obligation belongs to a PERSON — the send is theirs to make
   * (a button on the record), not the sweep's. Never auto-re-fired whatever
   * `safe_to_refire` says.
   */
  human?: boolean
  /**
   * The endpoint this kind's send goes to, as stored in
   * `nivaro_erp_submissions.payload.endpoint_path`. Required before the
   * sweep may re-fire anything: several kinds share one API, and "the most
   * recent request for this record" without an endpoint filter can just as
   * easily be a DIFFERENT push's body. A kind that cannot name its endpoint
   * is never re-fired.
   */
  endpoint_path?: string | null
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
    return typeof first === 'object' && first !== null
      ? Number(first.id)
      : Number(first ?? 0) || null
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

/** A flow that ended without sending: `halted_at` (migration 339) already
 *  names the op whose reject stopped the chain. Null when the flow ran to
 *  the end — there is then nothing to explain. */
export function flowHaltReason(haltedAt: string | null): string | null {
  const at = String(haltedAt ?? '').trim()
  if (at === '') return null
  return skipReason('flow_condition', at)
}

const apiNameCache = new Map<string, { name: string; at: number }>()
const API_NAME_TTL_MS = 60_000

/**
 * `TransitionActionDef.external_api` is `<id | name>`, so an action
 * configured by numeric id opens a context whose `api` is `"7"` — but every
 * registered kind, and the reconciliation sweep, key on the API's NAME.
 * Numeric input resolves to the row's name (60s cache); anything else passes
 * straight through, which covers both "already a name" and "an id that
 * resolves to nothing" — the latter simply matches no kind downstream.
 */
export async function resolveApiName(database: Knex, idOrName: string): Promise<string> {
  const s = String(idOrName ?? '').trim()
  if (s === '' || !/^\d+$/.test(s)) return s
  const cached = apiNameCache.get(s)
  if (cached && Date.now() - cached.at < API_NAME_TTL_MS) return cached.name
  try {
    const row = (await database('nivaro_external_apis')
      .where({ id: Number(s) })
      .first('name')) as { name: string } | undefined
    const name = row?.name ?? s
    apiNameCache.set(s, { name, at: Date.now() })
    return name
  } catch {
    return s
  }
}

let epochCache: { epoch: Date; at: number } | null = null
const EPOCH_CACHE_TTL_MS = 60_000

/**
 * The moment integration obligations "started counting" (migration 344,
 * `nivaro_settings.integration_obligations_epoch` — PATCH-allowlisted so an
 * admin may move it). Every registered kind's `expect()` must exclude
 * anything whose relevant moment predates this, or the first sweep against
 * an existing database floods `missing` for years of never-pushed history.
 *
 * A lookup failure, or a NULL column (should not happen after the migration
 * backfills it, but a fresh install racing the sweep before its own boot
 * finishes is possible), falls back to "now" — same direction as
 * `resolveApiName`'s catch-and-fall-back, and the SAFE failure mode here:
 * under-reporting for one cycle beats re-flooding the exact problem this
 * column exists to fix. 60s cache, same TTL and shape as `apiNameCache`.
 */
export async function getObligationsEpoch(database: Knex): Promise<Date> {
  if (epochCache && Date.now() - epochCache.at < EPOCH_CACHE_TTL_MS) return epochCache.epoch
  try {
    const row = (await database('nivaro_settings')
      .orderBy('id', 'asc')
      .first('integration_obligations_epoch')) as
      | { integration_obligations_epoch: Date | string | null }
      | undefined
    const epoch = row?.integration_obligations_epoch
      ? new Date(row.integration_obligations_epoch)
      : new Date()
    epochCache = { epoch, at: Date.now() }
    return epoch
  } catch {
    return new Date()
  }
}

/** For settings PATCH (an admin moved the epoch) and tests. */
export function bustObligationsEpochCache(): void {
  epochCache = null
}

/** The decision-point entry point: attribute the context to a kind and open
 *  a `pending` row. Returns null when no kind claims it — which is how an
 *  unregistered integration stays exactly as silent as it is today. */
export async function openObligationForTrigger(
  ctx: ObligationTriggerContext,
  opts: { trigger: ObligationTrigger; trigger_ref?: string | null; due_at?: Date }
): Promise<number | null> {
  const apiName = await resolveApiName(db, ctx.api)
  const resolvedCtx = apiName === ctx.api ? ctx : { ...ctx, api: apiName }
  const def = resolveKindForTrigger(resolvedCtx)
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

// ─── The board's per-API strip ─────────────────────────────────────────────

/** The order the board's strip reads in: what needs a person first. */
export const TILE_ORDER = ['overdue', 'failed', 'pending', 'skipped', 'sent', 'missing'] as const
export type ObligationTileOutcome = (typeof TILE_ORDER)[number]

/** Outcomes that mean the partner does not have it. Reads the same four
 *  values as OPEN_OUTCOMES today, but it is a different question — this one
 *  drives `oldest_unmet` on the board, not what the reconcile sweep may
 *  still rewrite. */
export const UNMET_OUTCOMES: ObligationOutcome[] = ['overdue', 'failed', 'missing', 'pending']

export interface ObligationTile {
  outcome: ObligationTileOutcome
  count: number
}

export interface ObligationApiSummary {
  api: string
  owner_user: string | null
  tiles: ObligationTile[]
  oldest_unmet: string | null
}

/** Grouped counts → the per-API strip. Every outcome is present with a count,
 *  including zero, so the strip has a fixed width and never reflows as
 *  numbers change. */
export function summariseObligations(
  rows: Array<{ api: string; outcome: string; c: number; oldest: Date | null }>,
  owners: Record<string, string | null>
): ObligationApiSummary[] {
  const byApi = new Map<string, ObligationApiSummary>()
  for (const r of rows) {
    let entry = byApi.get(r.api)
    if (!entry) {
      entry = {
        api: r.api,
        owner_user: owners[r.api] ?? null,
        tiles: TILE_ORDER.map((outcome) => ({ outcome, count: 0 })),
        oldest_unmet: null
      }
      byApi.set(r.api, entry)
    }
    const tile = entry.tiles.find((t) => t.outcome === r.outcome)
    if (tile) tile.count += Number(r.c) || 0
    if (r.oldest && (UNMET_OUTCOMES as string[]).includes(r.outcome)) {
      const iso = new Date(r.oldest).toISOString()
      if (!entry.oldest_unmet || iso < entry.oldest_unmet) entry.oldest_unmet = iso
    }
  }
  return [...byApi.values()]
}

// ─── Retention ──────────────────────────────────────────────────────────────

const PRUNE_BATCH = 5000
const PRUNE_MAX_BATCHES = 40

// ─── Ask AI ─────────────────────────────────────────────────────────────────

/** The ledger as the model should see it: the outcome and the SENTENCE, no
 *  ids or internal columns it could misread as a record key. Pure — the
 *  `integration_status` tool call fetches the rows, this only reshapes them,
 *  so it is unit-testable without a database. */
export function summariseObligationsForAi(
  rows: Array<{
    api: string
    kind: string
    outcome: string
    reason: string | null
    due_at: Date | string
    trigger: string
  }>
): Array<{
  api: string
  kind: string
  outcome: string
  reason: string | null
  due_at: string
  trigger: string
}> {
  return rows.map((r) => ({
    api: r.api,
    kind: r.kind,
    outcome: r.outcome,
    reason: r.reason ?? null,
    due_at: new Date(r.due_at).toISOString(),
    trigger: r.trigger
  }))
}

/** Retention: a landed obligation is history after 180 days. Deletes ONLY
 *  `sent` / `superseded` rows — `skipped` keeps its reason as the
 *  wrong-guard detector's evidence, and `failed` / `overdue` / `missing` /
 *  `pending` (OPEN_OUTCOMES) are NEVER pruned: an unanswered question does
 *  not expire, and `nivaro_erp_submissions.obligation_id` carries no FK
 *  specifically so this can delete without touching that table.
 *
 *  Batched like services/erp-retention.ts, so a first run over months of
 *  history never holds a lock for long; a batch that throws (lock
 *  contention) returns what was already committed rather than losing it. */
export async function pruneObligations(days = 180): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  let total = 0
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    let affected = 0
    try {
      const res = (await db.raw(
        `DELETE TOP (${PRUNE_BATCH}) FROM nivaro_integration_obligations
          WHERE created_at < ? AND outcome IN ('sent', 'superseded')`,
        [cutoff]
      )) as unknown
      affected =
        Number(
          typeof res === 'number'
            ? res
            : ((res as { rowCount?: number })?.rowCount ?? (res as number[])?.[0] ?? 0)
        ) || 0
    } catch {
      return total
    }
    total += affected
    if (affected < PRUNE_BATCH) break
  }
  return total
}
