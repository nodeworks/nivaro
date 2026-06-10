import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { hooks } from './registry.js'

// Store app reference so the hook can emit socket notifications after startup.
let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

export function registerFieldWatchHooks() {
  hooks.after('*', 'update', async (ctx) => {
    // Require both previousData and the updated result to diff
    if (!ctx.previousData || !ctx.result || !ctx.keys?.[0]) return

    const collection = ctx.collection

    // Find active watches for this collection
    const watches = (await db('nivaro_field_watches')
      .where({ collection, is_active: true })
      .select('*')) as Array<{
      id: number
      name: string
      collection: string
      field: string
      is_active: boolean
      created_by: string | null
    }>

    if (watches.length === 0) return

    const item = String(ctx.keys[0])
    const prev = ctx.previousData as Record<string, unknown>
    const next = ctx.result as Record<string, unknown>
    const now = new Date()

    for (const watch of watches) {
      const field = watch.field
      const oldVal = prev[field]
      const newVal = next[field]

      // Only fire if value actually changed
      if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue

      // Get subscribers for this watch
      const subs = (await db('nivaro_field_watch_subscribers as s')
        .join('nivaro_users as u', 's.user', 'u.id')
        .where({ 's.watch': watch.id })
        .select('u.id', 'u.email', 'u.first_name', 'u.last_name')) as Array<{
        id: string
        email: string
        first_name: string | null
        last_name: string | null
      }>

      if (subs.length === 0) continue

      const message = `${field} changed from "${String(oldVal ?? '(empty)')}" to "${String(newVal ?? '(empty)')}"`
      const subject = `Field changed: ${field} on ${collection}`

      for (const sub of subs) {
        // Skip the user who made the change
        if (ctx.user?.id && sub.id === ctx.user.id) continue

        try {
          const [notif] = (await db('nivaro_notifications')
            .insert({
              recipient: sub.id,
              subject,
              status: 'inbox',
              timestamp: now,
              sender: ctx.user?.id ?? null,
              message: message.slice(0, 500),
              collection,
              item
            })
            .returning('*')) as unknown as [{ id: number } | undefined]

          if (_app?.io) {
            emitNotification(_app.io, sub.id, {
              id: notif?.id ?? null,
              subject,
              message: message.slice(0, 200),
              collection,
              item,
              sender: ctx.user?.id ?? null,
              timestamp: now
            })
          }
        } catch (err) {
          console.error({ err, watch: watch.id, sub: sub.id }, 'Field watch notification failed')
        }
      }
    }
  })
}
