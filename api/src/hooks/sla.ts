import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { hooks } from './registry.js'

let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

let _slaCfg: { start: number; end: number; days: Set<number>; cachedAt: number } | null = null

async function getSlaCfg() {
  const now = Date.now()
  if (_slaCfg && now - _slaCfg.cachedAt < 60_000) return _slaCfg
  const row = await db('nivaro_settings')
    .first('sla_business_day_start', 'sla_business_day_end', 'sla_business_days')
    .catch(() => null)
  const days = ((row?.sla_business_days as string | null) ?? '1,2,3,4,5')
    .split(',')
    .map(Number)
    .filter((n) => !Number.isNaN(n))
  _slaCfg = {
    start: (row?.sla_business_day_start as number | null) ?? 9,
    end: (row?.sla_business_day_end as number | null) ?? 17,
    days: new Set(days),
    cachedAt: now
  }
  return _slaCfg
}

async function businessHoursElapsed(from: Date, to: Date): Promise<number> {
  const cfg = await getSlaCfg()
  let hours = 0
  const current = new Date(from)
  while (current < to) {
    const day = current.getDay()
    const hour = current.getHours()
    if (cfg.days.has(day) && hour >= cfg.start && hour < cfg.end) hours++
    current.setHours(current.getHours() + 1)
  }
  return hours
}

/**
 * Called after a workflow state transition — checks SLA immediately.
 * Intended to be called from the workflow transition handling code, or
 * triggered externally (e.g. from a cron flow).
 */
export async function checkSlaForInstance(
  workflowInstanceId: string,
  collection: string,
  item: string
): Promise<void> {
  try {
    const instance = await db('nivaro_workflow_instances').where({ id: workflowInstanceId }).first()
    if (!instance || !instance.current_state) return

    const rule = await db('nivaro_sla_rules')
      .where({
        workflow_template: instance.template,
        state_key: instance.current_state,
        is_active: true
      })
      .first()
    if (!rule) return

    const historyEntry = await db('nivaro_workflow_history')
      .where({ instance: workflowInstanceId, to_state: instance.current_state })
      .orderBy('created_at', 'desc')
      .first()
    if (!historyEntry) return

    const enteredAt = new Date(historyEntry.created_at)
    const now = new Date()

    const elapsedHours = rule.business_hours_only
      ? await businessHoursElapsed(enteredAt, now)
      : (now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60)

    const pctUsed = (elapsedHours / rule.duration_hours) * 100
    const status =
      pctUsed >= 100 ? 'breached' : pctUsed >= rule.warning_threshold_pct ? 'warning' : 'on_track'

    if (status === 'on_track') return

    if (status === 'warning' && !rule.notify_on_warning) return
    if (status === 'breached' && !rule.notify_on_breach) return

    const subject =
      status === 'breached' ? `SLA Breached: ${rule.name}` : `SLA Warning: ${rule.name}`
    const message = `Item ${item} in ${collection} has been in state "${instance.current_state}" for ${Math.round(elapsedHours)} hours (${Math.round(pctUsed)}% of ${rule.duration_hours}h SLA)`

    const usersToNotify: string[] = []
    if (rule.escalation_user) usersToNotify.push(rule.escalation_user)

    for (const userId of usersToNotify) {
      const inserted = await db('nivaro_notifications')
        .insert({
          recipient: userId,
          subject,
          status: 'inbox',
          timestamp: now,
          sender: null,
          message: message.slice(0, 500),
          collection,
          item
        })
        .returning('*')

      const notif = Array.isArray(inserted) ? inserted[0] : null

      if (_app?.io) {
        emitNotification(_app.io, userId, {
          id: notif?.id ?? null,
          subject,
          message: message.slice(0, 200),
          collection,
          item,
          sender: null,
          timestamp: now
        })
      }
    }
  } catch (err) {
    console.warn('[sla] check failed:', err)
  }
}

export function registerSlaHooks() {
  hooks.after('*', 'create', async (_ctx) => {
    // intentionally empty — SLA is purely on-demand
  })
}
