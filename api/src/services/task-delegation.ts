import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { notifyUser } from './notification-channels.js'

/**
 * Task auto-delegation on OOO (#70): when a user goes out of office with a
 * working delegate, their OPEN tasks move to the delegate instead of sitting
 * for two weeks. One-way by design — coming back does not yank tasks back
 * (the delegate may be mid-way through them); reassignment is visible on each
 * task and in the activity log.
 */
export async function delegateOpenTasks(
  userId: string,
  app?: FastifyInstance
): Promise<number> {
  try {
    const user = (await db('nivaro_users')
      .where({ id: userId })
      .first('id', 'first_name', 'last_name', 'delegate_id', 'delegate_expires_at')) as
      | {
          first_name: string | null
          last_name: string | null
          delegate_id: string | null
          delegate_expires_at: Date | string | null
        }
      | undefined
    if (!user?.delegate_id) return 0
    if (
      user.delegate_expires_at &&
      new Date(user.delegate_expires_at).getTime() < Date.now()
    )
      return 0
    // The delegate must themselves be able to act.
    const delegate = (await db('nivaro_users')
      .where({ id: user.delegate_id })
      .first('id', 'status', 'is_out_of_office', 'is_redacted')) as
      | { id: string; status: string | null; is_out_of_office: boolean | number; is_redacted: boolean | number }
      | undefined
    if (!delegate || delegate.status === 'suspended' || delegate.is_redacted) return 0
    if (delegate.is_out_of_office) return 0

    const open = (await db('nivaro_tasks')
      .where({ assignee: userId, status: 'open' })
      .select('id', 'title', 'collection', 'item')) as Array<{
      id: number
      title: string
      collection: string | null
      item: string | null
    }>
    if (open.length === 0) return 0

    await db('nivaro_tasks')
      .whereIn(
        'id',
        open.map((t) => t.id)
      )
      .update({ assignee: user.delegate_id })

    const fromName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'a colleague'
    if (app) {
      await notifyUser(app, user.delegate_id, {
        subject: `${open.length} task${open.length === 1 ? '' : 's'} delegated to you`,
        message: `${fromName} is out of office — their open tasks were reassigned to you: ${open
          .slice(0, 5)
          .map((t) => t.title)
          .join(', ')}${open.length > 5 ? '…' : ''}`
      }).catch(() => {})
    }
    await logActivity({
      action: 'task-delegation',
      user: userId,
      comment: `${open.length} open task(s) → delegate ${user.delegate_id} (OOO)`
    })
    return open.length
  } catch (err) {
    // Delegation is best-effort — an OOO flip must never fail because of it.
    console.warn('[task-delegation] failed:', err instanceof Error ? err.message : err)
    return 0
  }
}
