import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'

/**
 * Personal reminders (nivaro_reminders, migration 214) — set by the chat
 * assistant's set_reminder tool or POST /reminders.
 *
 * Two deliverers, one claim: the `chat-reminders` sweep (every 20 seconds, on
 * the deployed instance) and a timer the request that set a near-term
 * reminder arms in its own process. The timer is what makes "remind me in a
 * minute" work on a dev laptop, where scheduled jobs never tick, and it lands
 * on the second rather than the next sweep. Whichever gets there first claims
 * the row (`sent` flipped only where it is still false), so nobody is
 * reminded twice.
 */

interface ReminderRow {
  id: number
  user: string
  note: string
  room: string | null
  remind_at: Date | string
}

/** Longest wait a timer is armed for — anything later is the sweep's job
 *  (a process restart drops timers; the sweep never forgets). */
const TIMER_HORIZON_MS = 6 * 60 * 60_000

export async function createReminder(
  app: FastifyInstance,
  input: { user: string; note: string; remindAt: Date; room?: string | null }
): Promise<number | null> {
  const [inserted] = await db('nivaro_reminders')
    .insert({
      user: input.user,
      note: input.note,
      room: input.room ?? null,
      remind_at: input.remindAt,
      sent: false,
      created_at: new Date()
    })
    .returning('id')
  const id =
    typeof inserted === 'object' && inserted !== null
      ? Number((inserted as { id: number }).id)
      : Number(inserted)
  if (Number.isFinite(id)) armReminderTimer(app, id, input.remindAt)
  return Number.isFinite(id) ? id : null
}

export function armReminderTimer(app: FastifyInstance, id: number, at: Date): void {
  const wait = at.getTime() - Date.now()
  if (wait > TIMER_HORIZON_MS) return
  const t = setTimeout(
    () => {
      void deliverReminderById(app, id).catch((err) =>
        app.log.warn({ err, reminder: id }, 'reminder timer delivery failed')
      )
    },
    Math.max(0, wait)
  )
  t.unref?.()
}

export async function deliverDueReminders(app: FastifyInstance): Promise<number> {
  const due = (await db('nivaro_reminders')
    .where('sent', false)
    .where('remind_at', '<=', new Date())
    .orderBy('remind_at')
    .limit(50)) as ReminderRow[]
  let n = 0
  for (const r of due) if (await deliver(app, r)) n++
  return n
}

async function deliverReminderById(app: FastifyInstance, id: number): Promise<void> {
  const r = (await db('nivaro_reminders').where({ id, sent: false }).first()) as
    | ReminderRow
    | undefined
  if (!r) return
  // The reminder may have been moved later since the timer was armed.
  if (new Date(r.remind_at).getTime() > Date.now() + 1000) {
    armReminderTimer(app, id, new Date(r.remind_at))
    return
  }
  await deliver(app, r)
}

async function deliver(app: FastifyInstance, r: ReminderRow): Promise<boolean> {
  // Claim first: only one deliverer flips false → true.
  const claimed = Number(
    await db('nivaro_reminders').where({ id: r.id, sent: false }).update({ sent: true })
  )
  if (!claimed) return false
  try {
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, String(r.user), {
      subject: 'Reminder',
      message: r.note,
      sender: null,
      category: 'system',
      why: 'You asked to be reminded about this.'
    })
    // Set from a direct conversation with the assistant: it says so there
    // too, where the person asked. A reminder asked for in a shared channel
    // stays a personal notification — the room does not need to hear it.
    if (r.room?.startsWith('dm:')) {
      const { postBotMessage } = await import('./chat-bot.js')
      await postBotMessage(app, r.room, `⏰ Reminder: ${r.note}`)
    }
    return true
  } catch (err) {
    // Give it back to the sweep rather than dropping it.
    await db('nivaro_reminders')
      .where({ id: r.id })
      .update({ sent: false })
      .catch(() => {})
    app.log.warn({ err, reminder: r.id }, 'reminder delivery failed')
    return false
  }
}
