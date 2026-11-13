/**
 * Two cheap facts the record header asks about (Rob 2026-11-13):
 *
 * - ownerSetupFor: does the record's pipeline have ANY owner setup — owner
 *   groups on its states, owner dimensions on a binding of its template, an
 *   owner fallback field, or an owner added to this record by hand? Without
 *   any, the header's automatic Owners tile would only ever say "—", so the
 *   record page leaves it out (`owners_configured` on GET
 *   /pipelines/instance/:collection/:item).
 * - collectionHasPartnerIntegration: can anything from this collection go to
 *   a partner — a registered obligation kind for it, or a transition on its
 *   pipeline with an erp_submit push? Without one (and nothing sent from the
 *   record) the header's External requests chip stays out
 *   (`partner_integration` on GET /integration-obligations/record/...).
 *
 * Both are one EXISTS-style read per template / collection, remembered for a
 * minute per tenant (bustOwnerGroupCache and pipeline edits bust it). A failed
 * check answers yes: the header shows what it always showed.
 */
import { db } from '../db/index.js'
import { allObligationKinds } from './integration-obligations.js'
import { currentTenantKey } from './tenant-rooms.js'

const TTL_MS = 60_000
const ownerSetup = new Map<string, { value: boolean; at: number }>()
const partnerPush = new Map<string, { value: boolean; at: number }>()

export function bustRecordHeaderSignals(): void {
  ownerSetup.clear()
  partnerPush.clear()
}

async function remembered(
  cache: Map<string, { value: boolean; at: number }>,
  key: string,
  read: () => Promise<boolean>
): Promise<boolean> {
  const k = `${currentTenantKey()}\u0000${key}`
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await read()
  cache.set(k, { value, at: Date.now() })
  return value
}

const rowsOf = (res: unknown): Array<Record<string, unknown>> =>
  Array.isArray(res) ? (res as Array<Record<string, unknown>>) : []
const truthy = (v: unknown) => v === 1 || v === true || v === '1'

export async function ownerSetupFor(opts: {
  template: string
  instanceId?: string | null
  fallbackField?: string | null
}): Promise<boolean> {
  if (typeof opts.fallbackField === 'string' && opts.fallbackField.trim() !== '') return true
  try {
    const template = String(opts.template)
    const configured = await remembered(ownerSetup, template.toUpperCase(), async () => {
      const res = await db.raw(
        `SELECT CASE WHEN EXISTS (
             SELECT 1 FROM nivaro_pipeline_owner_groups g
             JOIN nivaro_workflow_states s ON s.id = g.state
             WHERE s.template = ?)
           OR EXISTS (
             SELECT 1 FROM nivaro_pipeline_owner_dimensions d
             JOIN nivaro_workflow_bindings b ON b.id = d.binding
             WHERE b.template = ?)
           THEN 1 ELSE 0 END AS has_setup`,
        [template, template]
      )
      return truthy(rowsOf(res)[0]?.has_setup)
    })
    if (configured || !opts.instanceId) return configured
    // Owners added by hand to this record (the pipeline panel's Add owner).
    const manual = await db.raw(
      `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM nivaro_pipeline_instance_owners WHERE instance = ?)
         THEN 1 ELSE 0 END AS manual`,
      [String(opts.instanceId)]
    )
    return truthy(rowsOf(manual)[0]?.manual)
  } catch {
    return true
  }
}

function hasPush(actions: unknown): boolean {
  try {
    const parsed = typeof actions === 'string' ? JSON.parse(actions) : actions
    return (
      Array.isArray(parsed) &&
      parsed.some((a) => !!a && typeof a === 'object' && a.type === 'erp_submit')
    )
  } catch {
    return false
  }
}

export async function collectionHasPartnerIntegration(collection: string): Promise<boolean> {
  if (allObligationKinds().some((k) => k.collection === collection)) return true
  try {
    return await remembered(partnerPush, collection, async () => {
      // LIKE narrows to the few transitions that mention it; the parse decides.
      const res = await db.raw(
        `SELECT t.actions FROM nivaro_workflow_transitions t
         JOIN nivaro_workflow_bindings b ON b.template = t.template
         WHERE b.collection = ? AND t.actions LIKE ?`,
        [collection, '%erp_submit%']
      )
      return rowsOf(res).some((r) => hasPush(r.actions))
    })
  } catch {
    return true
  }
}
