import { noteUsersDeactivated } from '../services/inactive-people-notice.js'
import { hooks } from './registry.js'

/**
 * A person suspended or redacted through the generic items service (an administrator editing
 * nivaro_users there) tells the administrators too — the same one-notice-per-batch path the
 * Users page, directory sync, offboarding and retention use.
 */
export function registerInactivePeopleHooks() {
  hooks.after('nivaro_users', 'update', async (ctx) => {
    const id = ctx.keys?.[0]
    if (id == null || !ctx.payload) return
    const prev = (ctx.previousData ?? {}) as Record<string, unknown>
    const suspendedNow =
      ctx.payload.status === 'suspended' && String(prev.status ?? 'active') !== 'suspended'
    const redactedNow = ctx.payload.is_redacted === true && !prev.is_redacted
    if (!suspendedNow && !redactedNow) return
    noteUsersDeactivated([id], {
      reason: 'admin',
      actor: ctx.user?.id ?? null,
      verb: redactedNow ? 'redacted' : 'suspended'
    })
  })
}
