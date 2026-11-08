import { db } from '../db/index.js'
import type { CMSField, User } from '../types.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { resolveDisplayValue } from './display-value.js'
import { labelFor } from './global-search.js'
import { readItems, readOne } from './items.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { collectionTitle } from './record-label-fallback.js'
import { attachRecordState, type RecordState } from './record-state.js'
import { userTimeZone } from './user-time.js'

/**
 * GET /global-search/preview (search program 2026-10-28, item 8): what the
 * palette's preview pane shows for one hit — label, pipeline state, current
 * owners and up to six fields — read AS THE CALLER. readOne answers null for a
 * row the caller cannot see (User Scopes, row filters) and throws for a
 * collection they cannot read: both are 404 here, never a hint that it exists.
 * Fields come from the caller's own row, so a withheld field is simply absent.
 */

export const PREVIEW_FIELDS = 6
const OWNER_CAP = 8

export interface SearchPreview {
  collection: string
  id: unknown
  label: string
  state?: { label: string; color: string | null }
  owners?: Array<{ id: string; name: string }>
  fields: Array<{ label: string; value: string }>
  updated_at?: string
  updated_by?: string
}

const SKIP = new Set(['id', 'user_created', 'user_updated', 'date_created', 'date_updated'])
const UPDATED_AT = ['date_updated', 'updated_at', 'modified_at', 'date_modified']
/** Housekeeping switches no reader looks a record up by (skip_forecast_cron, is_automated…). */
const INTERNAL_FLAG = /^(skip|is|has|disable|disabled|hide|no|allow)_|_(flag|cron|enabled)$/i
/** Internal keys (a composite "102-300137883-201943", a uuid, a sync key): never shown
 *  by the fallback — the record's own number already identifies it (army 9 b14). */
const INTERNAL_KEY = /^(key|uuid|guid)$|_(key|uuid|guid|hash)$/i

function parseList(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const templateFields = (t: string | null | undefined) =>
  [...(t ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_.]+)?\s*\}\}/g)].map((m) => m[1])

/** Which fields the pane shows, in order (pure; exported for tests): the layout's
 *  header fields, else the display template's, else the first visible fields —
 *  only ones present in the caller's row, never more than PREVIEW_FIELDS. */
export function previewFieldOrder(
  row: Record<string, unknown>,
  header: string[],
  template: string | null | undefined,
  fields: Array<{ field: string; hidden?: unknown; sort?: number | null }>
): string[] {
  const present = (f: string) => f in row && !SKIP.has(f)
  const visible = new Set(fields.filter((f) => !f.hidden).map((f) => f.field))
  const out: string[] = []
  const push = (f: string) => {
    if (out.length < PREVIEW_FIELDS && present(f) && !out.includes(f)) out.push(f)
  }
  for (const f of header) push(f)
  // A layout that names its header fields is the designer's choice: kept as is.
  const fromHeader = out.length > 0
  if (!fromHeader) for (const f of templateFields(template)) push(f)
  if (!fromHeader && out.length < 3) {
    for (const f of [...fields].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))) {
      // The fallback picks "the first visible fields": never a switch that is off, nor an
      // internal flag ("Skip Forecast Cron false" in the Cmd+K preview, army 6 L70).
      // Nor an internal key ("Key 102-300137883-201943"). A zero is a value ("Quantity 0")
      // and stays (Fable L8).
      if (row[f.field] === false || INTERNAL_FLAG.test(f.field) || INTERNAL_KEY.test(f.field))
        continue
      if (visible.has(f.field)) push(f.field)
    }
  }
  return out
}

const shown = (v: unknown): string | null => {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return null
  const s = String(v).trim()
  return s ? s.slice(0, 200) : null
}

type FieldMeta = Pick<CMSField, 'type'> &
  Partial<Pick<CMSField, 'field' | 'interface' | 'display' | 'options' | 'display_options'>>

const MONEY_NAME = /(amount|cost|price|total|tax|budget|spend|balance)/i
const T_DATE = new Set(['date'])
const T_DATETIME = new Set(['datetime', 'timestamp', 'datetime2', 'datetimeoffset', 'time'])
const T_NUMBER = new Set([
  'integer',
  'bigint',
  'biginteger',
  'int',
  'float',
  'decimal',
  'double',
  'numeric'
])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const opt = (o: Record<string, unknown> | null | undefined, k: string) =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined

/** "Oct 19, 2026" from a date-only string — never new Date('YYYY-MM-DD') (a day early west of UTC). */
function dayOf(y: string, m: string, d: string): string {
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`
}

function choiceText(f: FieldMeta, v: unknown): string | null {
  const choices = opt(f.options, 'choices')
  if (!Array.isArray(choices)) return null
  const hit = (choices as Array<{ text?: unknown; value?: unknown }>).find(
    (c) => c && String(c.value) === String(v)
  )
  if (!hit) return null
  const t = String(hit.text ?? hit.value ?? '')
  return t.startsWith('$t:') ? t.slice(3).replace(/_/g, ' ') : t
}

/** How a field formats a number: its own `format` option (currency/percent/number), else
 *  a decimal named like money. */
function numberFormat(f: FieldMeta): 'currency' | 'percent' | 'number' {
  const fmt = String(opt(f.options, 'format') ?? opt(f.display_options, 'format') ?? '')
  if (fmt === 'currency' || f.interface === 'input-currency') return 'currency'
  if (fmt === 'percent') return 'percent'
  const t = String(f.type ?? '').toLowerCase()
  if (
    (t === 'decimal' || t === 'float' || t === 'double' || t === 'numeric') &&
    MONEY_NAME.test(f.field ?? '')
  )
    return 'currency'
  return 'number'
}

/**
 * One stored value as the record page shows it (pure; exported for tests): dates
 * "Oct 19, 2026" (a midnight-UTC datetime is a date; any other time is written in the
 * reader's zone, 12-hour), switches Yes/No (or the field's own on/off labels), money
 * "$95,576.00", numbers with separators, choices by their text. Never an ISO stamp,
 * "false" or a bare 95576 (army 9 b14/b16).
 */
export function previewValue(
  f: FieldMeta | undefined,
  v: unknown,
  timeZone = 'America/New_York'
): string | null {
  if (v == null || v === '') return null
  if (!f) return shown(v)
  const t = String(f.type ?? '').toLowerCase()
  if (typeof v === 'boolean' || t === 'boolean' || t === 'bool' || t === 'bit') {
    const on = v === true || v === 1 || v === '1' || v === 'true'
    const label = opt(f.display_options, on ? 'labelOn' : 'labelOff')
    return typeof label === 'string' && label.trim() ? label.trim() : on ? 'Yes' : 'No'
  }
  if (typeof v === 'object' && !(v instanceof Date)) return null
  const choice = choiceText(f, v)
  if (choice) return choice
  if (T_DATE.has(t) || T_DATETIME.has(t) || v instanceof Date) {
    const iso = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString()) : String(v)
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(iso)
    if (!m) return shown(v)
    // Exactly UTC midnight is a stored calendar day — the record page's own rule
    // (packages/shared lib/utils.ts formatDate, lib/format-value.ts), so the preview and the
    // page never disagree by a day; any other time is converted to the reader's zone.
    const midnight = !m[4] || /^0+$/.test(`${m[4]}${m[5]}${m[6] ?? ''}${m[7] ?? ''}`)
    if (T_DATE.has(t) || midnight) return dayOf(m[1], m[2], m[3])
    const d = v instanceof Date ? v : new Date(iso)
    if (Number.isNaN(d.getTime())) return dayOf(m[1], m[2], m[3])
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).format(d)
    } catch {
      return dayOf(m[1], m[2], m[3])
    }
  }
  if (typeof v === 'number' || T_NUMBER.has(t)) {
    const n = Number(v)
    if (Number.isFinite(n) && String(v).trim() !== '') {
      const kind = numberFormat(f)
      if (kind === 'currency') {
        const cur = String(opt(f.options, 'currency') ?? 'USD')
        try {
          return n.toLocaleString('en-US', {
            style: 'currency',
            currency: /^[A-Z]{3}$/.test(cur) ? cur : 'USD'
          })
        } catch {
          return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
        }
      }
      if (kind === 'percent') return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
      return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    }
  }
  const s = shown(v)
  if (!s) return null
  // Rich text: tags out.
  return /<[a-z][\s\S]*>/i.test(s)
    ? s
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null
    : s
}

/** A many-to-one value's label: the field's own template first ("{{id}}" on a funding year
 *  IS the year), else the target's display template, else its usual name columns. Null when
 *  nothing names it — never the collection title ("Funding Year: Funding Years", army 9 b16). */
export function relationLabel(
  hit: Record<string, unknown>,
  fieldTemplate: string | null | undefined,
  targetTemplate: string | null | undefined
): string | null {
  for (const t of [fieldTemplate, targetTemplate]) {
    if (!t || !String(t).trim()) continue
    // A template that names only the key is the designer saying the key is the name.
    if (/^\s*\{\{\s*id\s*\}\}\s*$/.test(String(t))) {
      const id = hit.id
      if (id != null && String(id).trim()) return String(id).trim()
      continue
    }
    const r = resolveDisplayValue(hit, String(t))
    const s = r == null ? '' : String(r).trim()
    if (s) {
      const viaLabel = labelFor(hit, String(t), '')
      if (viaLabel) return viaLabel
    }
  }
  const l = labelFor(hit, null, '')
  return l || null
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

async function headerFieldsFor(user: User, collection: string, id: string, isAdmin: boolean) {
  try {
    const { resolveLayout } = await import('../routes/collection-layouts.js')
    const pick = await resolveLayout({
      collection,
      item: id,
      role: (user.role as string | null) ?? null,
      isAdmin,
      userId: String(user.id)
    })
    return parseList(pick.row?.header_fields)
  } catch {
    return []
  }
}

export async function buildSearchPreview(
  user: User,
  collection: string,
  id: string,
  isAdmin: boolean
): Promise<SearchPreview | null> {
  let row: Record<string, unknown> | null
  try {
    row = (await readOne(user, collection, id)) as Record<string, unknown> | null
  } catch {
    return null
  }
  if (!row) return null

  const [col, fieldRows, header] = await Promise.all([
    getCollection(collection),
    getFields(collection).catch(() => []),
    headerFieldsFor(user, collection, id, isAdmin)
  ])
  const labelOf = new Map(
    fieldRows.map((f) => [
      f.field,
      String((f as unknown as { label?: string | null }).label ?? '').trim() || titleCase(f.field)
    ])
  )
  const order = previewFieldOrder(row, header, col?.display_template, fieldRows)

  // Many-to-one values are ids: show the related record's label, read as the caller.
  const rels = (await getRelations(collection).catch(() => [])).filter(
    (r) =>
      r.many_collection === collection &&
      order.includes(r.many_field) &&
      r.one_collection &&
      !r.junction_field
  )
  const metaOf = new Map(fieldRows.map((f) => [f.field, f]))
  const relLabels = new Map<string, Map<string, string>>()
  await Promise.all(
    rels.map(async (r) => {
      const v = row?.[r.many_field]
      if (v == null || typeof v === 'object') return
      try {
        const target = r.one_collection as string
        const [targetCol, res] = await Promise.all([
          getCollection(target),
          readItems(user, target, { filter: { id: { _eq: v } }, limit: 1, count: false })
        ])
        const hit = (res.data as Array<Record<string, unknown>>)[0]
        const fieldTemplate = metaOf.get(r.many_field)?.options?.template
        const label = hit
          ? relationLabel(
              hit,
              typeof fieldTemplate === 'string' ? fieldTemplate : null,
              targetCol?.display_template
            )
          : null
        relLabels.set(r.many_field, new Map(label ? [[String(v), label]] : []))
      } catch {
        /* unreadable target — the raw value stays hidden too */
        relLabels.set(r.many_field, new Map())
      }
    })
  )

  const timeZone = await userTimeZone(user).catch(() => 'America/New_York')
  const fields: SearchPreview['fields'] = []
  for (const f of order) {
    const raw = row[f]
    const rel = relLabels.get(f)
    const value = rel ? (rel.get(String(raw)) ?? null) : previewValue(metaOf.get(f), raw, timeZone)
    if (value) fields.push({ label: labelOf.get(f) ?? titleCase(f), value: value.slice(0, 200) })
  }

  const out: SearchPreview = {
    collection,
    id: row.id,
    label: labelFor(
      row,
      col?.display_template,
      collectionTitle(collection, col?.display_name)
    ).slice(0, 120),
    fields
  }

  // State + owners: the record's own instance (record-state.ts), its current step's owners.
  try {
    const probe: Record<string, unknown> = { id: row.id }
    await attachRecordState(collection, [probe])
    const st = probe.$state as RecordState | null
    if (st) {
      out.state = { label: st.label, color: st.color }
      const inst = (await db('nivaro_workflow_instances')
        .where({ id: st.instance_id })
        .first('id', 'current_state')) as { id: string; current_state: string | null } | undefined
      if (inst?.current_state && !st.is_terminal) {
        const owners = await resolveStateOwnersBatch([
          {
            key: 'r',
            stateId: inst.current_state,
            instanceId: inst.id,
            collection,
            itemId: String(row.id)
          }
        ])
        out.owners = (owners.get('r') ?? []).slice(0, OWNER_CAP).map((o) => ({
          id: o.id,
          name: `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim() || o.email
        }))
      }
    }
  } catch {
    /* no pipeline facts — the pane shows the fields */
  }

  for (const k of UPDATED_AT) {
    const v = shown(row[k])
    if (v) {
      out.updated_at = v
      break
    }
  }
  const by = row.user_updated
  if (by != null && typeof by !== 'object') {
    const u = (await db('nivaro_users')
      .where({ id: String(by) })
      .first('first_name', 'last_name')
      .catch(() => undefined)) as
      | { first_name?: string | null; last_name?: string | null }
      | undefined
    const name = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim()
    if (name) out.updated_by = name
  }
  return out
}
