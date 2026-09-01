import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { businessHoursElapsed, getSlaSchedule } from '../services/business-hours.js'
import { resolveRecordZones } from '../services/sla-zones.js'
import { hooks } from './registry.js'

let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
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

    // current_state is the state uuid; rules are keyed by the state KEY
    // string — translate before matching or no rule ever matches.
    const stateRow = await db('nivaro_workflow_states')
      .where({ id: instance.current_state })
      .first()
    const stateKey = stateRow?.key ? String(stateRow.key) : null
    if (!stateKey) return

    const rule = await db('nivaro_sla_rules')
      .where({
        workflow_template: instance.template,
        state_key: stateKey,
        is_active: true
      })
      .first()
    if (!rule) return

    const historyEntry = await db('nivaro_workflow_history')
      .where({ instance: workflowInstanceId, to_state: instance.current_state })
      .orderBy('timestamp', 'desc')
      .first()
    if (!historyEntry) return

    const enteredAt = new Date(historyEntry.timestamp)
    const now = new Date()

    let elapsedHours: number
    if (rule.business_hours_only) {
      const base = await getSlaSchedule()
      const tz = (await resolveRecordZones(collection, [String(item)])).get(String(item))
      elapsedHours = businessHoursElapsed(enteredAt, now, tz ? { ...base, timeZone: tz } : base)
    } else {
      elapsedHours = (now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60)
    }

    const pctUsed = (elapsedHours / rule.duration_hours) * 100
    const status =
      pctUsed >= 100 ? 'breached' : pctUsed >= rule.warning_threshold_pct ? 'warning' : 'on_track'

    if (status === 'on_track') return

    if (status === 'warning' && !rule.notify_on_warning) return
    if (status === 'breached' && !rule.notify_on_breach) return

    const subject =
      status === 'breached' ? `SLA Breached: ${rule.name}` : `SLA Warning: ${rule.name}`
    const message = `Item ${item} in ${collection} has been in state "${stateKey}" for ${Math.round(elapsedHours)} hours (${Math.round(pctUsed)}% of ${rule.duration_hours}h SLA)`

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
