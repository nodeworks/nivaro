import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { type AnomalyResult, evaluateAnomalyAlert } from '../services/anomaly.js'
import { hooks } from './registry.js'

let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

interface AlertDefinition {
  id: number
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit: string
  cooldown_minutes: number
  filters: string | null
  is_active: boolean
  detection_type: string // 'threshold' | 'anomaly'
  sensitivity: number | null // stddev multiplier for anomaly detection
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function checkCondition(numVal: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case 'gt':
      return numVal > threshold
    case 'gte':
      return numVal >= threshold
    case 'lt':
      return numVal < threshold
    case 'lte':
      return numVal <= threshold
    case 'eq':
      return numVal === threshold
    case 'neq':
      return numVal !== threshold
    case 'change_pct':
      return Math.abs(numVal) >= threshold
    default:
      return false
  }
}

async function notifyAlertSubscribers(
  def: AlertDefinition,
  item: string,
  fieldValue: string,
  detail?: string
) {
  const subs = await db('nivaro_alert_subscriptions as s')
    .join('nivaro_users as u', 's.user', 'u.id')
    .where({ 's.alert_definition': def.id })
    .select('s.user', 's.notify_inapp', 's.notify_email', 'u.email')

  const now = new Date()
  const subject = `Alert: ${def.name}`
  const message =
    detail ??
    `${def.field} = ${fieldValue} (${def.operator} ${def.threshold}) in ${def.collection} item ${item}`

  for (const sub of subs) {
    if (sub.notify_inapp) {
      try {
        const rows = await db('nivaro_notifications')
          .insert({
            recipient: sub.user,
            subject,
            status: 'inbox',
            timestamp: now,
            sender: null,
            message: message.slice(0, 500),
            collection: def.collection,
            item
          })
          .returning('*')

        const notif = Array.isArray(rows) ? rows[0] : null

        if (_app?.io) {
          emitNotification(_app.io, sub.user as string, {
            id: notif?.id ?? null,
            subject,
            message: message.slice(0, 200),
            collection: def.collection,
            item,
            sender: null,
            timestamp: now
          })
        }
      } catch {
        // non-fatal
      }
    }
  }
}

function anomalyDetail(def: AlertDefinition, res: AnomalyResult, item: string): string {
  return (
    `${def.field} = ${res.value} is anomalous in ${def.collection} item ${item} ` +
    `(mean ${res.mean.toFixed(2)}, stddev ${res.stddev.toFixed(2)}, z-score ${res.zscore.toFixed(2)})` +
    (res.explanation ? ` — ${res.explanation}` : '')
  )
}

/**
 * Cooldown-gated trigger: logs the alert and notifies subscribers.
 * Returns true when the alert actually fired (not suppressed by cooldown).
 */
async function fireAlert(
  def: AlertDefinition,
  collection: string,
  itemId: string,
  fieldValue: string,
  detail?: string
): Promise<boolean> {
  const cooldownMs = def.cooldown_minutes * 60 * 1000
  const recent = await db('nivaro_alert_log')
    .where({ alert_definition: def.id, item: itemId })
    .andWhere('triggered_at', '>', new Date(Date.now() - cooldownMs))
    .first()
  if (recent) return false

  await db('nivaro_alert_log').insert({
    alert_definition: def.id,
    collection,
    item: itemId,
    field_value: String(fieldValue).slice(0, 500),
    triggered_at: new Date()
  })

  await notifyAlertSubscribers(def, itemId, String(fieldValue), detail)
  return true
}

/**
 * Evaluate alert definitions scoped to a single collection + record.
 * Used by after-create/update hooks (fire-and-forget).
 */
export async function evaluateAlertsForCollection(
  collection: string,
  record: Record<string, unknown> | null,
  itemId: string | null
) {
  if (!record || !itemId) return

  const defs = await db('nivaro_alert_definitions')
    .where({ collection, is_active: true })
    .select<AlertDefinition[]>('*')

  for (const def of defs) {
    try {
      const rawVal = record[def.field]
      if (rawVal == null) continue
      const numVal = parseFloat(String(rawVal))
      if (isNaN(numVal)) continue

      if (def.detection_type === 'anomaly') {
        const res = await evaluateAnomalyAlert(def, { value: numVal, item: itemId })
        if (!res?.anomalous) continue
        await fireAlert(def, collection, itemId, String(rawVal), anomalyDetail(def, res, itemId))
        continue
      }

      if (!checkCondition(numVal, def.operator, def.threshold)) continue

      await fireAlert(def, collection, itemId, String(rawVal))
    } catch {
      // non-fatal per-def failure
    }
  }
}

/**
 * Full evaluation across all active alert definitions and all matching records.
 * Used by POST /alerts/evaluate and the scheduled cron.
 */
export async function evaluateAlerts(): Promise<number> {
  const defs = await db('nivaro_alert_definitions')
    .where({ is_active: true })
    .select<AlertDefinition[]>('*')

  let triggered = 0

  for (const def of defs) {
    try {
      // Anomaly definitions compare the latest value against recent history
      if (def.detection_type === 'anomaly') {
        const res = await evaluateAnomalyAlert(def)
        if (res?.anomalous && res.item) {
          const fired = await fireAlert(
            def,
            def.collection,
            res.item,
            String(res.value),
            anomalyDetail(def, res, res.item)
          )
          if (fired) triggered++
        }
        continue
      }

      const filters = parseJson<Record<string, unknown>>(def.filters) ?? {}

      let query = db(def.collection).select('*')
      for (const [key, val] of Object.entries(filters)) {
        query = query.where(key, val as string)
      }
      const records = await query

      for (const record of records) {
        const rawVal = record[def.field]
        if (rawVal == null) continue
        const numVal = parseFloat(String(rawVal))
        if (isNaN(numVal)) continue

        if (!checkCondition(numVal, def.operator, def.threshold)) continue

        const itemId = String(record.id ?? record[Object.keys(record)[0]])
        const fired = await fireAlert(def, def.collection, itemId, String(rawVal))
        if (fired) triggered++
      }
    } catch (err) {
      console.warn(`[alerts] evaluation failed for definition ${def.id}:`, err)
    }
  }

  return triggered
}

export function registerAlertHooks() {
  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const itemId = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
    evaluateAlertsForCollection(
      ctx.collection,
      ctx.result as Record<string, unknown> | null,
      itemId
    ).catch(() => {})
  })

  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const itemId = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
    evaluateAlertsForCollection(
      ctx.collection,
      ctx.result as Record<string, unknown> | null,
      itemId
    ).catch(() => {})
  })
}
