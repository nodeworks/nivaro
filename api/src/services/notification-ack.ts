import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { detailColumn, parseDetail } from './notification-channels.js'

/** #2365 — acknowledge a notification that asked for it. Own rows only;
 *  stamps who/when in the row's detail and marks it read. The body of
 *  POST /notifications/:id/acknowledge, shared with the Teams card action.
 *  `req` is the HTTP request when there is one (activity caller columns). */
export async function acknowledgeNotification(
  _app: FastifyInstance,
  user: User,
  id: number,
  req?: FastifyRequest
): Promise<{ status: number; body: unknown }> {
  const userId = user.id
  const row = (await db('nivaro_notifications')
    .where({ id, recipient: userId })
    .first('id', 'detail')) as { id: number; detail: string | null } | undefined
  if (!row) return { status: 404, body: { error: 'Not found' } }
  const detail = parseDetail(row.detail)
  if (!detail?.ack_required)
    return {
      status: 400,
      body: { error: 'This notification does not ask for acknowledgement' }
    }
  const at = detail.ack_at ?? new Date().toISOString()
  if (!detail.ack_at) {
    await db('nivaro_notifications')
      .where({ id })
      .update({
        detail: detailColumn({ ...detail, ack_at: at, ack_by: String(userId) }),
        status: 'read',
        read_at: new Date()
      })
    await logActivity({
      action: 'notification-acknowledge',
      user: userId,
      collection: 'nivaro_notifications',
      item: String(id),
      req
    })
  }
  return { status: 200, body: { data: { id, ack: { required: true, at, by: String(userId) } } } }
}
