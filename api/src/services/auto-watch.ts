import { db } from '../db/index.js'

/**
 * Auto-watch rules (#400): preferences.auto_watch {created, commented,
 * transitioned} — the actor is auto-subscribed to records they touch, via the
 * same per-record subscription shape RecordSubscribeButton creates (event_type
 * 'all' + filter_field 'id'), so the bell's subscribed state and unsubscribe
 * flow work unchanged. Fire-and-forget: watching must never break the write.
 */
export async function ensureAutoWatch(
  userId: string | undefined,
  collection: string,
  itemId: string | number | undefined,
  trigger: 'created' | 'commented' | 'transitioned'
): Promise<void> {
  if (!userId || !itemId || /^nivaro_/i.test(collection)) return
  try {
    const user = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences?: unknown }
      | undefined
    let prefs: Record<string, unknown> | null = null
    if (typeof user?.preferences === 'string') {
      try {
        prefs = JSON.parse(user.preferences)
      } catch {
        prefs = null
      }
    } else if (user?.preferences && typeof user.preferences === 'object') {
      prefs = user.preferences as Record<string, unknown>
    }
    const aw = (prefs?.auto_watch ?? null) as Record<string, boolean> | null
    if (!aw?.[trigger]) return
    const existing = await db('nivaro_notification_subscriptions')
      .where({ user: userId, collection, filter_field: 'id', filter_value: String(itemId) })
      .first('id')
    if (existing) return
    await db('nivaro_notification_subscriptions').insert({
      user: userId,
      collection,
      event_type: 'all',
      filter_field: 'id',
      filter_value: String(itemId),
      label: `Auto-watch (${trigger})`,
      is_active: true,
      digest_frequency: 'instant',
      created_at: new Date()
    })
  } catch {
    // best-effort
  }
}
