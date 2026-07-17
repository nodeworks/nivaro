import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { applyWorkspaceScope } from '../services/items.js'
import { applyRowFilter, getRowFilter } from '../services/permissions.js'
import { getAiCollectionSettings } from './ai-validation.js'
import type { HookContext } from './registry.js'
import { hooks } from './registry.js'

// ---------------------------------------------------------------------------
// Aggregate cap validation — `sum_cap` rules
//
// A `sum_cap` rule is a typed entry inside the same
// `nivaro_ai_collection_settings.validation_rules` array used by AI content
// validation (see ai-validation.ts). It caps the sum of `sum_field` across
// rows sharing a `group_by` value against a value read off the related
// parent record — the parent collection is resolved via the M2O relation
// named by `cap.relation` (a field on this collection) through
// `nivaro_relations`.
//
// 'block' severity throws CapValidationError (422, structured violations,
// forwarded to clients via the server.ts error handler); 'warn' notifies the
// acting user without stopping the write — mirroring the AI soft-notify path.
// ---------------------------------------------------------------------------

export interface SumCapRule {
  type: 'sum_cap'
  severity: 'block' | 'warn'
  sum_field: string
  group_by: string
  cap: { relation: string; field: string }
  message: string
}

export function isSumCapRule(raw: unknown): raw is SumCapRule {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  if (r.type !== 'sum_cap') return false
  if (r.severity !== 'block' && r.severity !== 'warn') return false
  if (typeof r.sum_field !== 'string' || !r.sum_field) return false
  if (typeof r.group_by !== 'string' || !r.group_by) return false
  if (typeof r.message !== 'string') return false
  if (!r.cap || typeof r.cap !== 'object') return false
  const cap = r.cap as Record<string, unknown>
  if (typeof cap.relation !== 'string' || !cap.relation) return false
  if (typeof cap.field !== 'string' || !cap.field) return false
  return true
}

export interface CapViolation {
  rule: string
  field: string
  explanation: string
}

export class CapValidationError extends Error {
  statusCode = 422
  code = 'VALIDATION_CAP_EXCEEDED'
  violations: CapViolation[]

  constructor(violations: CapViolation[]) {
    super(
      `Aggregate cap exceeded: ${violations
        .map((v) => v.explanation)
        .join('; ')
        .slice(0, 1000)}`
    )
    this.violations = violations
  }
}

let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

// Mirrors ai-validation.ts's soft-notify path: an in-app notification for the
// acting user, never blocking the write.
async function notifyValidationWarning(
  recipient: string,
  subject: string,
  message: string,
  collection: string,
  item: string | null
) {
  const now = new Date()
  try {
    const rows = (await db('nivaro_notifications')
      .insert({
        recipient,
        subject,
        status: 'inbox',
        timestamp: now,
        sender: null,
        message: message.slice(0, 500),
        collection,
        item
      })
      .returning('*')) as unknown as Array<{ id: number } | undefined>

    if (_app?.io) {
      emitNotification(_app.io, recipient, {
        id: rows[0]?.id ?? null,
        subject,
        message: message.slice(0, 200),
        collection,
        item,
        sender: null,
        timestamp: now
      })
    }
  } catch (err) {
    console.error({ err, recipient, collection }, 'Aggregate cap warning notification failed')
  }
}

/** Resolve the parent collection of an M2O field via nivaro_relations. */
async function resolveM2oParent(collection: string, field: string): Promise<string | null> {
  const rel = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .whereNull('junction_field')
    .first()) as { one_collection: string | null } | undefined
  return rel?.one_collection ?? null
}

/**
 * Evaluate one sum_cap rule against a create/update payload.
 * NULL group value or NULL parent cap both skip silently (nothing to cap
 * against). Throws CapValidationError for 'block' severity when the running
 * total exceeds the cap; 'warn' severity notifies the acting user instead.
 *
 * Scoping: before-hooks run ahead of items.ts's own workspace/row-filter scoped
 * previousData fetch (see updateOne, services/items.ts:1690-1698), so this hook
 * must derive and apply the SAME scope itself — otherwise an update targeting
 * another workspace's row id would reach the cap arithmetic (and leak a 422
 * vs. 404 boolean oracle, plus the cap/total amounts) before the write path's
 * own 404 check ever runs. The current-row fetch mirrors updateOne exactly
 * (applyWorkspaceScope + getRowFilter/applyRowFilter, keyed off
 * ctx.req.workspaceId + ctx.user) so its visibility matches the write path's
 * own 404 semantics. The SUM query is workspace-scoped only — see the comment
 * at its call site for why the row filter must NOT apply there.
 */
export async function evaluateSumCapRule(rule: SumCapRule, ctx: HookContext): Promise<void> {
  const payload = ctx.payload ?? {}
  const currentId = ctx.action === 'update' ? ctx.keys?.[0] : undefined
  const workspaceId = ctx.req?.workspaceId ?? undefined
  const rowFilter = ctx.user ? await getRowFilter(ctx.user, ctx.action, ctx.collection) : null

  let currentRow: Record<string, unknown> | undefined
  if (currentId != null) {
    const currentRowQuery = db(ctx.collection).where({ id: currentId })
    await applyWorkspaceScope(currentRowQuery, ctx.collection, workspaceId)
    if (rowFilter)
      applyRowFilter(currentRowQuery, rowFilter, ctx.user as NonNullable<typeof ctx.user>)
    currentRow = (await currentRowQuery.first()) as Record<string, unknown> | undefined
    // Invisible under this scope — the write path's own previousData fetch
    // (run right after this hook) will 404. Never throw or leak from here.
    if (!currentRow) return
  }

  const groupValue = payload[rule.group_by] ?? currentRow?.[rule.group_by] ?? null
  if (groupValue == null) return

  const incomingRaw = payload[rule.sum_field] ?? currentRow?.[rule.sum_field] ?? 0
  const incoming = Number(incomingRaw ?? 0)

  // Workspace-scoped only — NOT row-filtered. The cap is a data-integrity
  // constraint over the whole group within the workspace; a caller's
  // visibility filter (e.g. `owner = $CURRENT_USER`) must not narrow the
  // group total, or the cap silently becomes per-user instead of per-group
  // and a genuinely over-cap group sails through. The SUM result itself is
  // never returned to the caller, only folded into the violation explanation
  // (or the pass/fail decision) — acceptable to compute over rows the caller
  // can't otherwise see.
  const sumQuery = db(ctx.collection).where(rule.group_by, groupValue as never)
  await applyWorkspaceScope(sumQuery, ctx.collection, workspaceId)
  if (currentId != null) sumQuery.whereNot({ id: currentId })
  const sumRow = (await sumQuery.sum(`${rule.sum_field} as v`).first()) as
    | { v: string | number | null }
    | undefined
  const existingSum = Number(sumRow?.v ?? 0)
  const total = existingSum + incoming

  // nivaro_relations is global schema metadata, not workspace data — left unscoped.
  const parentCollection = await resolveM2oParent(ctx.collection, rule.cap.relation)
  if (!parentCollection) return

  // Reading the parent row, not writing it — 'read' is the right action here
  // (matches readOne's own getRowFilter(user, 'read', collection) call).
  const parentRowFilter = ctx.user ? await getRowFilter(ctx.user, 'read', parentCollection) : null
  const parentQuery = db(parentCollection).where({ id: groupValue }).select(rule.cap.field)
  await applyWorkspaceScope(parentQuery, parentCollection, workspaceId)
  if (parentRowFilter)
    applyRowFilter(parentQuery, parentRowFilter, ctx.user as NonNullable<typeof ctx.user>)
  const parentRow = (await parentQuery.first()) as Record<string, unknown> | undefined
  // Parent row invisible under this scope — same as a NULL cap: skip silently.
  const capRaw = parentRow?.[rule.cap.field]
  if (capRaw == null) return
  const cap = Number(capRaw)

  if (total <= cap) return

  const explanation = `${rule.message} (${total} exceeds cap of ${cap})`

  if (rule.severity === 'block') {
    throw new CapValidationError([{ rule: 'sum_cap', field: rule.sum_field, explanation }])
  }

  if (ctx.user?.id) {
    const item = currentId != null ? String(currentId) : null
    await notifyValidationWarning(
      ctx.user.id,
      `Aggregate cap warning: ${ctx.collection}`,
      explanation,
      ctx.collection,
      item
    ).catch(() => {})
  }
}

export function registerAggregateCapHooks() {
  const evaluate = async (ctx: HookContext) => {
    if (ctx.collection.startsWith('nivaro_')) return
    if (!ctx.payload) return

    const settings = await getAiCollectionSettings(ctx.collection).catch(() => null)
    if (!settings) return

    const rules = settings.validation_rules.filter(isSumCapRule)
    if (rules.length === 0) return

    for (const rule of rules) {
      await evaluateSumCapRule(rule, ctx)
    }
  }

  hooks.before('*', 'create', evaluate)
  hooks.before('*', 'update', evaluate)
}
