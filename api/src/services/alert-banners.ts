import { db } from '../db/index.js'
import type { User } from '../types.js'
import { ACTIVITY_PATTERN_KIND } from './activity-pattern-gate.js'
import { CORE_EXT } from './core-switches.js'

/**
 * Threshold banners (realtime round 9, item 20): "Project 4471 just crossed 90%".
 *
 * A per-record alert definition (nivaro_alert_definitions, the Alert & Threshold engine) can be
 * switched to also show as a banner — on the record's page, and as a short list on any page
 * that hosts the collection banner (a budget console). A banner stands while the crossing is
 * recent (BANNER_DAYS) AND the value still holds, and goes for one person when they dismiss it.
 * A later crossing (a new alert-log row, after the definition's cooldown) shows again.
 *
 * Everything is read AS THE VIEWER: the records through readItems (row filters, User Scopes,
 * field permissions — a field they cannot read means no banner), the record names through
 * recordDisplayRefs. Which definitions show banners is a list of ids stored without a migration
 * as one `nivaro_extension_settings` row ('nivaro-core' / `alert_banners`), so promote:config
 * carries it. Dismissals live in the person's own preferences (`alert_banner_dismissed`).
 */

export const ALERT_BANNERS_KEY = 'alert_banners'
export const BANNER_DAYS = 7
export const DISMISS_PREF = 'alert_banner_dismissed'
const DISMISS_CAP = 300
const MAX_BANNERS = 50

interface DefRow {
  id: number
  name: string
  collection: string
  field: string
  operator: string
  threshold: number | string
  unit: string | null
  detection_type: string | null
  is_active: boolean | number
}

export interface AlertBanner {
  log_id: number
  definition_id: number
  name: string
  collection: string
  item: string
  /** "Project US201979" — as the viewer reads it. */
  record: string
  field: string
  operator: string
  threshold: number
  unit: string
  /** The value now, as the viewer reads it. */
  value: number | null
  triggered_at: string
  /** "just crossed 90%" / "dropped below 10%" — the verb phrase. */
  phrase: string
}

// ── Which definitions show banners ─────────────────────────────────────────

let memo: { at: number; ids: Set<number> } | null = null

export function parseBannerIds(value: unknown): Set<number> {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return new Set()
    }
  }
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))
}

export async function bannerDefinitionIds(): Promise<Set<number>> {
  if (memo && Date.now() - memo.at < 30_000) return memo.ids
  let ids = new Set<number>()
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: CORE_EXT, key: ALERT_BANNERS_KEY })
      .first('value')) as { value: string | null } | undefined
    ids = parseBannerIds(row?.value ?? null)
  } catch {
    ids = new Set()
  }
  memo = { at: Date.now(), ids }
  return ids
}

export async function setDefinitionBanner(defId: number, on: boolean): Promise<void> {
  memo = null
  const current = await bannerDefinitionIds()
  memo = null
  const next = new Set(current)
  if (on) next.add(defId)
  else next.delete(defId)
  const value = JSON.stringify([...next].sort((a, b) => a - b))
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key: ALERT_BANNERS_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: CORE_EXT,
      key: ALERT_BANNERS_KEY,
      value,
      updated_at: new Date()
    })
}

// ── Pure helpers (tested) ──────────────────────────────────────────────────

export function stillHolds(operator: string, value: number, threshold: number): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    case 'eq':
      return value === threshold
    case 'neq':
      return value !== threshold
    case 'change_pct':
      return Math.abs(value) >= threshold
    default:
      return false
  }
}

const fmtNum = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function withUnit(n: number, unit: string | null | undefined): string {
  const u = (unit ?? '').trim()
  if (!u || u === 'count') return fmtNum(n)
  // The alert editor stores 'percent' / 'dollar'; older rules hold the symbol itself.
  if (u === '%' || u === 'percent') return `${fmtNum(n)}%`
  if (u === '$' || u === 'USD' || u === 'dollar') return `$${fmtNum(n)}`
  return `${fmtNum(n)} ${u}`
}

/** "just crossed 90%" (within a day) / "crossed 90%" (older). Pure. */
export function bannerPhrase(
  operator: string,
  threshold: number,
  unit: string | null | undefined,
  triggeredAt: Date,
  now = Date.now()
): string {
  const recent = now - triggeredAt.getTime() < 24 * 3_600_000
  const t = withUnit(threshold, unit)
  const just = recent ? 'just ' : ''
  switch (operator) {
    case 'gt':
    case 'gte':
      return `${just}crossed ${t}`
    case 'lt':
    case 'lte':
      return `${just}dropped below ${t}`
    case 'eq':
      return `${just}reached ${t}`
    case 'change_pct':
      return `${just}moved by ${t} or more`
    default:
      return `${just}passed its ${t} line`
  }
}

/** `{{project_id}} - {{name}}` → `project_id` (plain top-level fields only). Pure. */
export function firstTemplateField(template: string | null | undefined): string | null {
  const m = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/.exec(template ?? '')
  return m ? m[1] : null
}

export function dismissedIds(prefs: Record<string, unknown> | null | undefined): Set<number> {
  const v = prefs?.[DISMISS_PREF]
  return new Set(Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [])
}

/** The preference value with one more dismissal (newest kept, capped). Pure. */
export function withDismissal(prefs: Record<string, unknown>, logId: number): number[] {
  const prev = Array.isArray(prefs[DISMISS_PREF]) ? (prefs[DISMISS_PREF] as unknown[]) : []
  const list = prev.map(Number).filter((n) => Number.isFinite(n) && n !== logId)
  list.push(logId)
  return list.slice(-DISMISS_CAP)
}

// ── Reads ──────────────────────────────────────────────────────────────────

const parsePrefs = (v: unknown): Record<string, unknown> => {
  if (!v) return {}
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

async function viewerPrefs(userId: string): Promise<Record<string, unknown>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences: unknown }
    | undefined
  return parsePrefs(row?.preferences)
}

/**
 * The banners `user` sees for `collection` — one record (`item`) or the whole collection
 * (newest first, capped). Nothing at all unless an admin switched a definition on.
 */
export async function alertBannersFor(
  user: User,
  collection: string,
  item: string | null,
  now = Date.now()
): Promise<AlertBanner[]> {
  if (!collection || collection.startsWith('nivaro_') || collection.startsWith('directus_'))
    return []
  const on = await bannerDefinitionIds()
  if (on.size === 0) return []
  const defs = (
    (await db('nivaro_alert_definitions')
      .where({ collection })
      .whereIn('id', [...on])
      .select(
        'id',
        'name',
        'collection',
        'field',
        'operator',
        'threshold',
        'unit',
        'detection_type',
        'is_active'
      )) as DefRow[]
  ).filter(
    (d) => (d.is_active === true || d.is_active === 1) && d.detection_type !== ACTIVITY_PATTERN_KIND
  )
  if (defs.length === 0) return []

  const since = new Date(now - BANNER_DAYS * 86_400_000)
  // The newest crossing per (definition, record) inside the window.
  const q = db('nivaro_alert_log')
    .where({ collection })
    .whereIn(
      'alert_definition',
      defs.map((d) => d.id)
    )
    .where('triggered_at', '>=', since)
    .groupBy('alert_definition', 'item')
    .select('alert_definition', 'item', db.raw('MAX(id) as id'))
  if (item != null) q.where('item', String(item))
  const latest = ((await q) as Array<{ alert_definition: number; item: string; id: number }>)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, MAX_BANNERS * 2)
  if (latest.length === 0) return []

  const prefs = await viewerPrefs(user.id)
  const dismissed = dismissedIds(prefs)
  const open = latest.filter((l) => !dismissed.has(Number(l.id)))
  if (open.length === 0) return []

  const logs = (await db('nivaro_alert_log')
    .whereIn(
      'id',
      open.map((l) => Number(l.id))
    )
    .select('id', 'alert_definition', 'item', 'triggered_at')) as Array<{
    id: number
    alert_definition: number
    item: string
    triggered_at: Date | string
  }>

  // Read the records as the viewer: only rows they can see, only fields they may read.
  const ids = [...new Set(logs.map((l) => String(l.item)))]
  // The record's name: its friendly id, else the first plain field of its display template —
  // read in the same viewer read as the values (a field they cannot read is just absent).
  const meta = (await db('nivaro_collections')
    .where({ collection })
    .first('display_template')
    .catch(() => null)) as { display_template: string | null } | null | undefined
  const nameField = firstTemplateField(meta?.display_template)
  const fields = [
    ...new Set(['id', ...defs.map((d) => d.field), ...(nameField ? [nameField] : [])])
  ]
  const { readItems } = await import('./items.js')
  let rows: Array<Record<string, unknown>> = []
  try {
    const res = await readItems(user, collection, {
      fields,
      filter: { id: { _in: ids } },
      limit: ids.length
    })
    rows = (res.data ?? []) as Array<Record<string, unknown>>
  } catch {
    return []
  }
  const byId = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))
  const { recordDisplayRefs } = await import('./record-display-ref.js')
  const refs = await recordDisplayRefs(collection, ids, { recipient: user.id })
  const { collectionNoun } = await import('./access-request-text.js')
  const { singular } = await import('./access-words.js')
  const noun = singular(await collectionNoun(collection))
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)

  const out: AlertBanner[] = []
  for (const l of logs.sort((a, b) => Number(b.id) - Number(a.id))) {
    const def = defs.find((d) => d.id === Number(l.alert_definition))
    const row = byId.get(String(l.item).toUpperCase())
    if (!def || !row || !Object.hasOwn(row, def.field)) continue
    const raw = row[def.field]
    const value = raw == null || raw === '' ? null : Number(raw)
    const threshold = Number(def.threshold)
    // Anomaly rules have no line to re-check; threshold rules show only while they still hold.
    if (def.detection_type !== 'anomaly') {
      if (value == null || Number.isNaN(value) || !stillHolds(def.operator, value, threshold))
        continue
    }
    const at = new Date(l.triggered_at)
    const friendly = refs.get(String(l.item))
    const named = nameField ? row[nameField] : null
    const ref =
      friendly && !friendly.startsWith('#')
        ? friendly
        : named != null && String(named).trim() !== '' && typeof named !== 'object'
          ? String(named).trim()
          : `#${l.item}`
    out.push({
      log_id: Number(l.id),
      definition_id: def.id,
      name: def.name,
      collection,
      item: String(l.item),
      record: `${Noun} ${ref}`,
      field: def.field,
      operator: def.operator,
      threshold,
      unit: def.unit ?? '',
      value: value != null && !Number.isNaN(value) ? value : null,
      triggered_at: at.toISOString(),
      phrase:
        def.detection_type === 'anomaly'
          ? 'looks unusual'
          : bannerPhrase(def.operator, threshold, def.unit, at, now)
    })
    if (out.length >= MAX_BANNERS) break
  }
  return out
}

/** One person hides one crossing. Only a crossing they can currently see may be dismissed. */
export async function dismissAlertBanner(user: User, logId: number): Promise<boolean> {
  const log = (await db('nivaro_alert_log').where({ id: logId }).first('collection', 'item')) as
    | { collection: string; item: string }
    | undefined
  if (!log) return false
  const visible = await alertBannersFor(user, log.collection, String(log.item))
  if (!visible.some((b) => b.log_id === logId)) return false
  const prefs = await viewerPrefs(user.id)
  const next = { ...prefs, [DISMISS_PREF]: withDismissal(prefs, logId) }
  await db('nivaro_users')
    .where({ id: user.id })
    .update({ preferences: JSON.stringify(next) })
  return true
}
