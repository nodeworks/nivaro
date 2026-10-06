/**
 * Acting-for stamp (#645). When a person moves a record as the DELEGATE of an
 * out-of-office owner of the step — and is not an owner of that step in their
 * own right — the history row names the owner they acted for
 * (`nivaro_workflow_history.on_behalf_of`, migration 395).
 *
 * "Owner of the step" = the RAW owner set of the state the record is leaving
 * (owner groups + instance owners + fallback field, BEFORE the out-of-office →
 * delegate substitution — resolveStateOwnersBatch `skipDelegation`). The
 * delegation rule is the engine's own (pipeline-engine resolveActiveDelegate):
 * the principal is out of office and the delegation has not expired.
 */
import { db } from '../db/index.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'

const idKey = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * Pure: who the actor acted for. `principals` = users whose ACTIVE delegate is
 * the actor (oldest first); `rawOwnerIds` = the step's owners before
 * delegation. Null when the actor owns the step themselves, or none of the
 * people they cover owns it.
 */
export function pickOnBehalfOf(
  actorId: string | null | undefined,
  principals: string[],
  rawOwnerIds: string[]
): string | null {
  if (!actorId || principals.length === 0) return null
  const owners = new Set(rawOwnerIds.map(idKey))
  if (owners.has(idKey(actorId))) return null
  return principals.find((p) => owners.has(idKey(p))) ?? null
}

/** The out-of-office owner `actorId` is standing in for on this step, or null.
 *  Best-effort: any failure reads as "not acting for anyone". */
export async function resolveOnBehalfOf(args: {
  actorId: string | null | undefined
  stateId: string | null | undefined
  instanceId: string
  collection: string
  item: string
}): Promise<string | null> {
  const { actorId, stateId } = args
  if (!actorId || !stateId) return null
  try {
    const now = new Date()
    const rows = (await db('nivaro_users')
      .where({ delegate_id: actorId, is_out_of_office: true })
      .where((q) => q.whereNull('delegate_expires_at').orWhere('delegate_expires_at', '>', now))
      .orderBy('id')
      .limit(50)
      .select('id')) as Array<{ id: string }>
    if (rows.length === 0) return null
    const owners = await resolveStateOwnersBatch(
      [
        {
          key: 'step',
          stateId,
          instanceId: args.instanceId,
          collection: args.collection,
          itemId: args.item
        }
      ],
      db,
      { skipDelegation: true }
    )
    return pickOnBehalfOf(
      actorId,
      rows.map((r) => String(r.id)),
      (owners.get('step') ?? []).map((o) => String(o.id))
    )
  } catch {
    return null
  }
}

/** "Kim Lee, for Beth Ross" — the display the history, timeline and emails share. */
export function actingForLabel(actor: string | null, principal: string | null): string | null {
  if (!actor) return principal ? `for ${principal}` : null
  return principal ? `${actor}, for ${principal}` : actor
}
