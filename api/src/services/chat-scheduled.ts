import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * Scheduled chat messages (#939). Written now, sent later through the same
 * send path as a live message — visibility is re-checked at send time, so a
 * person who lost access to the room by then does not post into it.
 *
 * Two deliverers, one claim (the reminders pattern): the per-minute sweep on
 * the deployed instance, and a timer the request arms in its own process for
 * anything within six hours (what makes it work on a dev laptop, where
 * scheduled jobs never tick). The status flip pending → sending is the claim.
 */

const TIMER_HORIZON_MS = 6 * 60 * 60_000

export async function scheduleChatMessage(
  app: FastifyInstance,
  input: {
    user: string
    room: string
    message: string
    attachments: string[]
    parentId: number | null
    sendAt: Date
  }
): Promise<number> {
  const [ins] = await db('nivaro_chat_scheduled')
    .insert({
      user: input.user,
      room: input.room,
      message: input.message,
      attachments: input.attachments.length ? JSON.stringify(input.attachments) : null,
      parent_id: input.parentId,
      send_at: input.sendAt,
      status: 'pending',
      created_at: new Date()
    })
    .returning('id')
  const id = Number(typeof ins === 'object' && ins !== null ? (ins as { id: number }).id : ins)
  armScheduledTimer(app, id, input.sendAt)
  return id
}

export function armScheduledTimer(app: FastifyInstance, id: number, at: Date): void {
  const wait = at.getTime() - Date.now()
  if (wait > TIMER_HORIZON_MS) return
  const t = setTimeout(() => void sendScheduled(app, id).catch(() => {}), Math.max(0, wait))
  t.unref?.()
}

export async function sendDueScheduled(app: FastifyInstance): Promise<number> {
  if (!(await db.schema.hasTable('nivaro_chat_scheduled').catch(() => false))) return 0
  const due = (await db('nivaro_chat_scheduled')
    .where({ status: 'pending' })
    .where('send_at', '<=', new Date())
    .orderBy('send_at')
    .limit(50)
    .pluck('id')) as number[]
  let n = 0
  for (const id of due) if (await sendScheduled(app, Number(id))) n++
  return n
}

async function sendScheduled(app: FastifyInstance, id: number): Promise<boolean> {
  const row = (await db('nivaro_chat_scheduled').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (row?.status !== 'pending') return false
  if (new Date(String(row.send_at)).getTime() > Date.now() + 1000) {
    armScheduledTimer(app, id, new Date(String(row.send_at)))
    return false
  }
  const claimed = Number(
    await db('nivaro_chat_scheduled').where({ id, status: 'pending' }).update({ status: 'sending' })
  )
  if (!claimed) return false
  try {
    const user = (await db('nivaro_users').where({ id: row.user }).first()) as User | undefined
    if (!user || (user as unknown as { status?: string }).status === 'suspended') {
      throw new Error('The sender’s account is not active')
    }
    const { postChatMessage } = await import('./chat-send.js')
    let attachments: string[] = []
    try {
      attachments = row.attachments ? (JSON.parse(String(row.attachments)) as string[]) : []
    } catch {
      attachments = []
    }
    const msg = await postChatMessage(
      app,
      { user },
      {
        room: String(row.room),
        message: String(row.message ?? ''),
        attachments,
        parentId: row.parent_id ? Number(row.parent_id) : null,
        clientId: `sched-${id}`
      }
    )
    await db('nivaro_chat_scheduled')
      .where({ id })
      .update({ status: 'sent', sent_message_id: msg.id, error: null })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db('nivaro_chat_scheduled')
      .where({ id })
      .update({ status: 'failed', error: message.slice(0, 500) })
      .catch(() => {})
    try {
      const { notifyUser } = await import('./notification-channels.js')
      await notifyUser(app, String(row.user), {
        subject: 'A scheduled message was not sent',
        message: `${message}. It is still in your Scheduled list — edit it or send it now.`,
        category: 'system',
        collection: '__chat__',
        item: String(row.room)
      })
    } catch {
      /* best-effort */
    }
    return false
  }
}
