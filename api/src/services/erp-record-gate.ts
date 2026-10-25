import type { FastifyRequest } from 'fastify'
import { assertInstanceAccess, InstanceAccessError } from './instance-guard.js'

/**
 * The record gate for integration routes that act on, or show, one record's
 * partner traffic — ERP submission history/attempts/retries, integration
 * event replays, record integration summaries, mail log, owner history.
 *
 * Those routes used to check only collection-level `can()`, so User Scopes,
 * row filters and the approval edit lock never applied (army3). This runs the
 * item-actions sequence instead:
 * - 'read'   → the record must be visible to the caller (readOne as them);
 * - 'update' → visible, updatable (canUpdateItem) and not edit-locked
 *              (assertNotEditLocked, approval lock included).
 *
 * Returns the refusal to send, or null when the caller may go on. A record the
 * caller cannot see reads as missing (404), never as forbidden. Admins pass.
 */
export async function recordRefusal(
  req: FastifyRequest,
  collection: string,
  item: string,
  action: 'read' | 'update'
): Promise<{ code: number; body: Record<string, unknown> } | null> {
  if (req.isAdmin) return null
  try {
    await assertInstanceAccess(req.user, false, collection, item, undefined, action)
  } catch (err) {
    if (err instanceof InstanceAccessError) {
      return err.statusCode === 404
        ? { code: 404, body: { error: 'Not found' } }
        : { code: 403, body: { error: 'Forbidden' } }
    }
    throw err
  }
  if (action === 'read') return null
  const { assertNotEditLocked, EditLockedError, EDIT_LOCKED } = await import('./edit-lock.js')
  try {
    await assertNotEditLocked(req.user, collection, { ids: [item] }, req)
  } catch (e) {
    const message =
      e instanceof EditLockedError
        ? e.message
        : 'Could not confirm you may change this record while it waits.'
    return { code: 403, body: { error: message, code: EDIT_LOCKED } }
  }
  return null
}

/** Boolean form for lists: true = the caller may read the record. */
export async function recordReadable(
  req: FastifyRequest,
  collection: string,
  item: string
): Promise<boolean> {
  return (await recordRefusal(req, collection, item, 'read')) === null
}
