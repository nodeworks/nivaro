import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { peopleWith } from './flags.js'
import {
  pinKey,
  shortId,
  WATCH_ALERTS_MAX,
  WATCH_ALERTS_PER_RECORD,
  type WatchAlert,
  type WatchListPrefs
} from './store.js'
import { updateWatchList } from './user-store.js'

/**
 * Alert rules on a pinned record (rt6 #5): "tell me when it reaches <step>", "when <field>
 * changes", "when it's overdue" — once or every time. Stored with the person's watch list
 * (store.ts `alerts`); fired through notifyUser in the person's own category (`watch_list`, so
 * Profile → Notification rules can tune them).
 *
 *   step     — at the end of a move (where an automatic chain comes to rest), from
 *              workflow-transitions.ts → onWatchTransition (services/watch-list/transitions.ts)
 *   field    — the after-update hook (hooks/watch-list.ts), from the write's previous row
 *   overdue  — a 5-minute pass (cron `watch-list-overdue`) over only the records that have such
 *              a rule; one alert per breach (`due` remembers which due time fired)
 *
 * Never for the person's own change. Every alert is judged as the recipient first: the record
 * must still be theirs to open, and a field rule needs read access to that field.
 */

export const WATCH_CATEGORY = 'watch_list' as const

export interface AlertEntry {
  user: string
  alert: WatchAlert
}

export type AlertInput = {
  collection: unknown
  id: unknown
  kind: unknown
  step?: unknown
  field?: unknown
  label?: unknown
  repeat?: unknown
}

/** Add a rule to a person's list (the record must be pinned). Pure. */
export function addAlert(
  list: WatchListPrefs,
  input: AlertInput,
  now: Date = new Date()
):
  | { ok: true; list: WatchListPrefs; alert: WatchAlert }
  | { ok: false; code: string; message: string } {
  const c = String(input.collection ?? '')
  const rid = String(input.id ?? '')
  if (!list.pins.some((p) => pinKey(p.c, p.id) === pinKey(c, rid)))
    return {
      ok: false,
      code: 'NOT_PINNED',
      message: 'Pin the record to your watch list first, then add an alert to it'
    }
  const kind = input.kind
  if (kind !== 'step' && kind !== 'field' && kind !== 'overdue')
    return { ok: false, code: 'BAD_ALERT', message: 'Choose what to be told about' }
  const alert: WatchAlert = {
    id: shortId(8),
    c,
    rid,
    kind,
    repeat: input.repeat === true,
    at: now.toISOString()
  }
  if (kind === 'step') {
    if (typeof input.step !== 'string' || !input.step.trim())
      return { ok: false, code: 'BAD_ALERT', message: 'Choose a step' }
    alert.step = input.step.trim()
  }
  if (kind === 'field') {
    if (typeof input.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.field))
      return { ok: false, code: 'BAD_ALERT', message: 'Choose a field' }
    alert.field = input.field
  }
  if (typeof input.label === 'string' && input.label.trim())
    alert.label = input.label.trim().slice(0, 120)
  const same = list.alerts.filter((a) => a.c === c && a.rid === rid)
  if (
    same.some(
      (a) =>
        a.kind === alert.kind &&
        (a.step ?? '') === (alert.step ?? '') &&
        (a.field ?? '') === (alert.field ?? '')
    )
  )
    return { ok: false, code: 'ALERT_EXISTS', message: 'You already have that alert' }
  if (same.length >= WATCH_ALERTS_PER_RECORD)
    return {
      ok: false,
      code: 'ALERTS_FULL',
      message: `A record holds ${WATCH_ALERTS_PER_RECORD} alerts. Remove one to add another.`
    }
  if (list.alerts.length >= WATCH_ALERTS_MAX)
    return {
      ok: false,
      code: 'ALERTS_FULL',
      message: `You have ${WATCH_ALERTS_MAX} alerts. Remove one to add another.`
    }
  return { ok: true, list: { ...list, alerts: [...list.alerts, alert] }, alert }
}

export function removeAlert(
  list: WatchListPrefs,
  alertId: string
): { list: WatchListPrefs; changed: boolean } {
  const alerts = list.alerts.filter((a) => a.id !== alertId)
  return { list: { ...list, alerts }, changed: alerts.length !== list.alerts.length }
}

/** Every rule by record ("c:id"), from the people who have any. Pure. */
export function indexAlerts(people: Map<string, WatchListPrefs>): Map<string, AlertEntry[]> {
  const out = new Map<string, AlertEntry[]>()
  for (const [user, list] of people) {
    for (const alert of list.alerts) {
      const k = pinKey(alert.c, alert.rid)
      const arr = out.get(k)
      if (arr) arr.push({ user, alert })
      else out.set(k, [{ user, alert }])
    }
  }
  return out
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** Field rules a write sets off: the field changed, and not by the person. Pure. */
export function fieldAlertsToFire(
  entries: AlertEntry[],
  changed: Set<string>,
  actorId: string | null | undefined
): AlertEntry[] {
  return entries.filter(
    (e) =>
      e.alert.kind === 'field' &&
      !!e.alert.field &&
      changed.has(e.alert.field) &&
      !sameId(e.user, actorId)
  )
}

/** Step rules a move sets off: it arrived on the step, and not by the person's own move. Pure. */
export function stepAlertsToFire(
  entries: AlertEntry[],
  stateKey: string | null | undefined,
  actorId: string | null | undefined
): AlertEntry[] {
  if (!stateKey) return []
  return entries.filter(
    (e) =>
      e.alert.kind === 'step' &&
      String(e.alert.step ?? '').toLowerCase() === String(stateKey).toLowerCase() &&
      !sameId(e.user, actorId)
  )
}

/**
 * Overdue rules to fire: the record's clock is past due and this breach (its due time) has not
 * been told yet. Pure.
 */
export function overdueAlertsToFire(
  entries: AlertEntry[],
  sla: Record<string, { status: string | null; due_at: string | null } | undefined>,
  now: number = Date.now()
): Array<AlertEntry & { due: string }> {
  const out: Array<AlertEntry & { due: string }> = []
  for (const e of entries) {
    if (e.alert.kind !== 'overdue') continue
    const s = sla[e.alert.rid]
    if (!s?.due_at) continue
    const due = new Date(s.due_at).getTime()
    if (!Number.isFinite(due)) continue
    const past = s.status === 'breached' || due <= now
    if (!past) continue
    const dueIso = new Date(due).toISOString()
    if (e.alert.due === dueIso) continue
    out.push({ ...e, due: dueIso })
  }
  return out
}

/** After a rule fired: a once-rule goes, an every-time rule remembers when (and which due). */
export function afterFiring(
  list: WatchListPrefs,
  alertId: string,
  now: Date,
  due?: string
): WatchListPrefs | null {
  const a = list.alerts.find((x) => x.id === alertId)
  if (!a) return null
  if (!a.repeat) return { ...list, alerts: list.alerts.filter((x) => x.id !== alertId) }
  return {
    ...list,
    alerts: list.alerts.map((x) =>
      x.id === alertId ? { ...x, fired: now.toISOString(), ...(due ? { due } : {}) } : x
    )
  }
}

/** Subject + message for one alert. Pure. */
export function alertText(
  alert: WatchAlert,
  title: string,
  extra: { stepLabel?: string | null; fieldLabel?: string | null; actorName?: string | null } = {}
): { subject: string; message: string } {
  if (alert.kind === 'step') {
    const step = extra.stepLabel || alert.label || alert.step || 'the step'
    return {
      subject: `Watch list: ${title} reached ${step}`,
      message: `${title} moved to ${step}${extra.actorName ? ` (${extra.actorName})` : ''}.${
        alert.repeat ? '' : ' This alert was set to tell you once, so it is now off.'
      }`
    }
  }
  if (alert.kind === 'field') {
    const field = extra.fieldLabel || alert.label || alert.field || 'A field'
    return {
      subject: `Watch list: ${field} changed on ${title}`,
      message: `${extra.actorName ?? 'Someone'} changed ${field} on ${title}.${
        alert.repeat ? '' : ' This alert was set to tell you once, so it is now off.'
      }`
    }
  }
  return {
    subject: `Watch list: ${title} is overdue`,
    message: `${title} has passed its due time on its current step.${
      alert.repeat ? '' : ' This alert was set to tell you once, so it is now off.'
    }`
  }
}

// ── Firing ────────────────────────────────────────────────────────────────────

async function loadPerson(userId: string): Promise<User | null> {
  const u = (await db('nivaro_users')
    .where({ id: userId })
    .first()
    .catch(() => undefined)) as (User & Record<string, unknown>) | undefined
  if (!u) return null
  if (u.status && String(u.status) !== 'active') return null
  if (u.is_redacted) return null
  return u
}

/** The record's name as this person reads it. */
async function titleFor(user: User, collection: string, id: string): Promise<string> {
  try {
    const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(user, [{ collection, id }])
    const l = labels[pinKey(collection, id)]
    if (l) return l
  } catch {
    /* fall through */
  }
  return `#${id}`
}

/**
 * Tell one person about one rule, as them. Returns true when told. A one-shot rule is removed
 * and an every-time rule stamped — either way the person's tabs hear `prefs:changed`.
 */
export async function fireAlert(
  app: FastifyInstance | null,
  entry: AlertEntry,
  ctx: {
    event: 'update' | 'transition'
    stepLabel?: string | null
    actorName?: string | null
    due?: string
    now?: Date
  }
): Promise<boolean> {
  if (!app) return false
  const { alert } = entry
  const user = await loadPerson(entry.user)
  if (!user) return false
  const { recipientView } = await import('../../hooks/notification-subscriptions.js')
  const view = await recipientView(entry.user, alert.c, alert.rid, ctx.event)
  if (!view) return false
  let fieldLabel: string | null = null
  if (alert.kind === 'field' && alert.field) {
    if (!(await view.reads(alert.field))) return false
    try {
      const { getFields } = await import('../collections.js')
      const f = (
        (await getFields(alert.c)) as Array<{ field: string; label?: string | null }>
      ).find((x) => x.field === alert.field)
      fieldLabel = (f?.label ?? '').trim() || null
    } catch {
      /* the stored label answers */
    }
  }
  const title = await titleFor(view.user, alert.c, alert.rid)
  const text = alertText(alert, title, {
    stepLabel: ctx.stepLabel,
    fieldLabel,
    actorName: ctx.actorName
  })
  const { notifyUser } = await import('../notification-channels.js')
  await notifyUser(app, entry.user, {
    subject: text.subject,
    message: text.message,
    collection: alert.c,
    item: alert.rid,
    category: WATCH_CATEGORY as never,
    always_inbox: true,
    why: 'you set an alert on this record in your watch list',
    source: { kind: 'watch_alert', label: 'Watch list alert', id: alert.id }
  })
  const now = ctx.now ?? new Date()
  await updateWatchList(entry.user, (l) => afterFiring(l, alert.id, now, ctx.due)).catch(() => null)
  return true
}

/** The rules on one record (from the people who have any). */
export async function alertsOnRecord(collection: string, id: string): Promise<AlertEntry[]> {
  const people = await peopleWith('wl_alerts')
  if (people.size === 0) return []
  return indexAlerts(people).get(pinKey(collection, id)) ?? []
}

/** Which collections have any rule at all (a cheap gate for the write hook). */
export async function collectionsWithAlerts(): Promise<Set<string>> {
  const people = await peopleWith('wl_alerts')
  const out = new Set<string>()
  for (const list of people.values()) for (const a of list.alerts) out.add(a.c)
  return out
}

async function actorName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const r = (await db('nivaro_users')
    .where({ id: userId })
    .first('first_name', 'last_name', 'is_redacted')
    .catch(() => undefined)) as
    | { first_name: string | null; last_name: string | null; is_redacted?: unknown }
    | undefined
  if (!r) return null
  if (r.is_redacted) return 'Former user'
  return `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null
}

/** The write hook's half: field rules on this record, from the previous and new row. */
export async function runFieldAlerts(
  app: FastifyInstance | null,
  args: {
    collection: string
    item: string
    previous: Record<string, unknown>
    next: Record<string, unknown>
    actorId: string | null
  }
): Promise<number> {
  const entries = await alertsOnRecord(args.collection, args.item)
  if (entries.length === 0) return 0
  const changed = new Set<string>()
  for (const e of entries) {
    const f = e.alert.field
    if (!f || !(f in args.next)) continue
    if (JSON.stringify(args.previous[f] ?? null) !== JSON.stringify(args.next[f] ?? null))
      changed.add(f)
  }
  const fire = fieldAlertsToFire(entries, changed, args.actorId)
  if (fire.length === 0) return 0
  const name = await actorName(args.actorId)
  let n = 0
  for (const e of fire)
    if (await fireAlert(app, e, { event: 'update', actorName: name }).catch(() => false)) n++
  return n
}

/** The move's half: step rules for the step the record came to rest on. */
export async function runStepAlerts(
  app: FastifyInstance | null,
  args: {
    collection: string
    item: string
    stateKey: string | null
    stateLabel: string | null
    actorId: string | null
  }
): Promise<number> {
  const entries = await alertsOnRecord(args.collection, args.item)
  const fire = stepAlertsToFire(entries, args.stateKey, args.actorId)
  if (fire.length === 0) return 0
  const name = await actorName(args.actorId)
  let n = 0
  for (const e of fire)
    if (
      await fireAlert(app, e, {
        event: 'transition',
        stepLabel: args.stateLabel,
        actorName: name
      }).catch(() => false)
    )
      n++
  return n
}

/** The 5-minute pass: overdue rules, per collection, one SLA batch each. */
export async function runOverdueAlerts(
  app: FastifyInstance | null,
  now: Date = new Date()
): Promise<{ checked: number; fired: number }> {
  const people = await peopleWith('wl_alerts')
  const byCollection = new Map<string, AlertEntry[]>()
  for (const [user, list] of people)
    for (const alert of list.alerts) {
      if (alert.kind !== 'overdue') continue
      const arr = byCollection.get(alert.c)
      if (arr) arr.push({ user, alert })
      else byCollection.set(alert.c, [{ user, alert }])
    }
  let checked = 0
  let fired = 0
  const { pickedInstances } = await import('./rows.js')
  const { computeStatusBatch } = await import('../../routes/sla.js')
  for (const [collection, entries] of byCollection) {
    const ids = [...new Set(entries.map((e) => e.alert.rid))]
    checked += ids.length
    const insts = (await pickedInstances(collection, ids)).filter((i) => !i.completed_at)
    if (insts.length === 0) continue
    const batch = (await computeStatusBatch(
      collection,
      insts.map((i) => String(i.item)),
      insts.map((i) => ({
        id: i.id,
        item: String(i.item),
        current_state: i.current_state,
        template: i.template,
        started_at: i.started_at ?? new Date(0)
      })) as never
    ).catch(() => ({}))) as Record<string, Record<string, unknown>>
    const sla: Record<string, { status: string | null; due_at: string | null }> = {}
    for (const [item, s] of Object.entries(batch)) {
      const due = s.due_at ? new Date(s.due_at as string) : null
      sla[item] = {
        status: (s.status as string | null) ?? null,
        due_at: due && Number.isFinite(due.getTime()) ? due.toISOString() : null
      }
    }
    for (const e of overdueAlertsToFire(entries, sla, now.getTime()))
      if (await fireAlert(app, e, { event: 'transition', due: e.due, now }).catch(() => false))
        fired++
  }
  return { checked, fired }
}

/** What the alert form offers for one record: its pipeline's steps and the readable fields. */
export async function alertOptions(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string
): Promise<{
  steps: Array<{ key: string; label: string; color: string | null }>
  fields: Array<{ field: string; label: string }>
  has_deadline: boolean
}> {
  const { pickedInstances } = await import('./rows.js')
  const insts = await pickedInstances(collection, [id])
  const inst = insts[0]
  let steps: Array<{ key: string; label: string; color: string | null }> = []
  if (inst?.template) {
    const rows = (await db('nivaro_workflow_states')
      .where({ template: inst.template })
      .orderBy('sort', 'asc')
      .select('key', 'label', 'color')
      .catch(() => [])) as Array<{ key: string; label: string | null; color: string | null }>
    steps = rows.map((r) => ({ key: r.key, label: r.label || r.key, color: r.color ?? null }))
  }
  const { getFields } = await import('../collections.js')
  const all = (await getFields(collection).catch(() => [])) as Array<{
    field: string
    label?: string | null
    hidden?: boolean | null
    special?: string[] | string | null
    type?: string | null
  }>
  let allowed: Set<string> | null = null
  if (!isAdmin) {
    const { getAllowedFields } = await import('../permissions.js')
    const list = await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
    allowed = list == null || list.includes('*') ? null : new Set(list)
  }
  const fields = all
    .filter((f) => {
      if (f.hidden || f.field === 'id') return false
      const special = Array.isArray(f.special) ? f.special.join(',') : String(f.special ?? '')
      if (/(date|user)-(updated|created)|o2m|m2m|m2a|alias|no-data/.test(special)) return false
      if (f.type === 'alias') return false
      return !allowed || allowed.has(f.field)
    })
    .map((f) => ({
      field: f.field,
      label:
        String(f.label ?? '').trim() ||
        f.field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
    }))
    .sort((a, z) => a.label.localeCompare(z.label))
  return { steps, fields, has_deadline: !!inst && !inst.completed_at }
}
