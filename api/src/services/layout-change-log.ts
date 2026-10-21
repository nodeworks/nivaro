import { db } from '../db/index.js'
import { csvRow } from '../lib/csv-cell.js'
import { diffForPeople, type LayoutSnapLike, whatsNewLines } from './layout-whats-new.js'
import { withReadGate } from './read-gate.js'

/**
 * The layout change log (#2719): every layout change across all forms in a
 * period, for auditors — who, when, the note and what the change did. A
 * version is the state BEFORE its author's save (layout-versions.ts), so the
 * change is that version against the next one, or against the form as it is
 * now for the newest. Only what History keeps is seen: the newest 30 unnamed
 * versions of a form plus every named one.
 */

type Row = Record<string, unknown>
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const DAY_MS = 86_400_000
export const CHANGE_LOG_MAX_DAYS = 366
export const CHANGE_LOG_MAX_ROWS = 5000

export interface ChangeLogRow {
  at: string
  collection: string
  layout_id: number
  layout: string
  version: number
  version_name: string | null
  who: string
  who_email: string | null
  note: string | null
  summary: string
  sections_added: number
  sections_removed: number
  fields_added: number
  fields_removed: number
  fields_moved: number
  settings_changed: string[]
}

export interface ChangeLogPeriod {
  from: Date
  /** Exclusive: the day after the last day asked for. */
  to: Date
  collection: string | null
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (both days included, UTC); default the last 30 days. */
export function parsePeriod(q: {
  from?: unknown
  to?: unknown
  collection?: unknown
}): ChangeLogPeriod | { error: string } {
  const today = new Date(new Date().toISOString().slice(0, 10))
  const to = isDay(q.to) ? new Date(q.to) : today
  const from = isDay(q.from) ? new Date(q.from) : new Date(to.getTime() - 29 * DAY_MS)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    return { error: 'from and to must be dates (YYYY-MM-DD)' }
  if (from > to) return { error: 'from must be on or before to' }
  if ((to.getTime() - from.getTime()) / DAY_MS >= CHANGE_LOG_MAX_DAYS)
    return { error: `Pick at most ${CHANGE_LOG_MAX_DAYS} days` }
  let collection: string | null = null
  if (q.collection != null && q.collection !== '') {
    if (typeof q.collection !== 'string' || !IDENT.test(q.collection))
      return { error: 'collection is not a collection name' }
    collection = q.collection
  }
  return { from, to: new Date(to.getTime() + DAY_MS), collection }
}

interface Snap {
  layout: Row
  groups: Row[]
  assignments: Row[]
}

const LAYOUT_IGNORE = new Set(['id', 'collection', 'created_at', 'updated_at', 'sort'])
const GROUP_IGNORE = new Set(['id', 'layout_id', 'created_at', 'updated_at', 'sort', 'label'])
const PLACEMENT_IGNORE = new Set(['id', 'layout_id', 'sort', 'group_key'])

const norm = (v: unknown) => {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 100_000)
      try {
        return JSON.stringify(JSON.parse(t))
      } catch {
        return v
      }
  }
  return v ?? null
}
const differs = (a: Row, b: Row, ignore: Set<string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => !ignore.has(k) && JSON.stringify(norm(a[k])) !== JSON.stringify(norm(b[k]))
  )

/** What one change did: the editor's words for fields and sections, plus settings by name. Pure. */
export function summarizeChange(
  from: Snap,
  to: Snap,
  label: (field: string) => string
): Pick<
  ChangeLogRow,
  | 'summary'
  | 'sections_added'
  | 'sections_removed'
  | 'fields_added'
  | 'fields_removed'
  | 'fields_moved'
  | 'settings_changed'
> {
  const w = diffForPeople(from as LayoutSnapLike, to as LayoutSnapLike, {
    label: (f) => label(f)
  })
  const lines = whatsNewLines(w)
  const settings = differs(from.layout ?? {}, to.layout ?? {}, LAYOUT_IGNORE)
  if (settings.length) lines.push(`Form settings: ${settings.join(', ')}`)
  const groupsBefore = new Map((from.groups ?? []).map((g) => [String(g.key ?? g.id), g]))
  let sectionSettings = 0
  for (const g of to.groups ?? []) {
    const old = groupsBefore.get(String(g.key ?? g.id))
    if (old && differs(old, g, GROUP_IGNORE).length) sectionSettings++
  }
  if (sectionSettings)
    lines.push(`${sectionSettings} section${sectionSettings === 1 ? "'s" : "s'"} settings changed`)
  const placed = (s: Snap) => {
    const m = new Map<string, Row>()
    for (const a of s.assignments ?? []) {
      const k = `${a.field}\u0000${a.group_key ?? ''}`
      if (!m.has(k)) m.set(k, a)
    }
    return m
  }
  const pa = placed(from)
  let fieldSettings = 0
  for (const [k, a] of placed(to)) {
    const old = pa.get(k)
    if (old && differs(old, a, PLACEMENT_IGNORE).length) fieldSettings++
  }
  if (fieldSettings)
    lines.push(`${fieldSettings} field${fieldSettings === 1 ? "'s" : "s'"} settings changed`)
  const reordered =
    !lines.length &&
    JSON.stringify((from.assignments ?? []).map((a) => [a.field, a.group_key, a.sort])) !==
      JSON.stringify((to.assignments ?? []).map((a) => [a.field, a.group_key, a.sort]))
  return {
    summary: lines.length
      ? lines.join('; ')
      : reordered
        ? 'Fields or sections reordered'
        : 'No visible change',
    sections_added: w.sections_added.length,
    sections_removed: w.sections_removed.length,
    fields_added: w.added.length,
    fields_removed: w.removed.length,
    fields_moved: w.moved.length,
    settings_changed: settings
  }
}

function parseSnap(raw: unknown): Snap | null {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!s || typeof s !== 'object') return null
    const v = s as Partial<Snap>
    return {
      layout: (v.layout ?? {}) as Row,
      groups: Array.isArray(v.groups) ? v.groups : [],
      assignments: Array.isArray(v.assignments) ? v.assignments : []
    }
  } catch {
    return null
  }
}

async function currentSnap(layoutId: number): Promise<Snap | null> {
  const layout = (await db('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Row
    | undefined
  if (!layout) return null
  const [groups, assignments] = await Promise.all([
    db('nivaro_field_groups')
      .where({ layout_id: layoutId })
      .orderBy([{ column: 'sort' }, { column: 'id' }]),
    db('nivaro_layout_field_assignments')
      .where({ layout_id: layoutId })
      .orderBy([{ column: 'sort' }, { column: 'id' }])
  ])
  return { layout, groups: groups as Row[], assignments: assignments as Row[] }
}

const iso = (v: unknown) => {
  const d = v instanceof Date ? v : new Date(String(v ?? ''))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export interface ChangeLog {
  rows: ChangeLogRow[]
  truncated: boolean
}

/** Every layout change in the period, oldest first. Reads one form at a time. */
export async function buildChangeLog(
  period: ChangeLogPeriod,
  userId: string | null | undefined
): Promise<ChangeLog> {
  return withReadGate(
    userId,
    async () => {
      // Which forms changed in the period (and their collections, when a form is gone: its snapshot).
      let q = db('nivaro_layout_versions as v')
        .leftJoin('nivaro_collection_layouts as l', 'l.id', 'v.layout_id')
        .where('v.created_at', '>=', period.from)
        .where('v.created_at', '<', period.to)
        .groupBy('v.layout_id', 'l.collection')
        .select('v.layout_id', 'l.collection', db.raw('COUNT(*) as n'))
      if (period.collection) q = q.where('l.collection', period.collection)
      const touched = (await q) as Array<{ layout_id: number; collection: string | null }>

      const rows: ChangeLogRow[] = []
      const labelsBy = new Map<string, Map<string, string>>()
      const labelFor = async (collection: string) => {
        let m = labelsBy.get(collection)
        if (!m) {
          const fields = (await db('nivaro_fields')
            .where({ collection })
            .select('field', 'label')) as Array<{ field: string; label: string | null }>
          m = new Map(fields.filter((f) => f.label?.trim()).map((f) => [f.field, String(f.label)]))
          labelsBy.set(collection, m)
        }
        return m
      }
      const authors = new Set<string>()
      const pending: Array<{ row: ChangeLogRow; by: string | null }> = []
      let truncated = false

      for (const t of touched) {
        if (pending.length >= CHANGE_LOG_MAX_ROWS) {
          truncated = true
          break
        }
        const layoutId = Number(t.layout_id)
        // The period's versions plus the first one after it (the state its last change made).
        const versions = (await db('nivaro_layout_versions')
          .where({ layout_id: layoutId })
          .where('created_at', '>=', period.from)
          .orderBy('version', 'asc')
          .select('id', 'version', 'snapshot', 'note', 'name', 'created_by', 'created_at')) as Row[]
        const inPeriod = versions.filter((v) => new Date(String(iso(v.created_at))) < period.to)
        const after = versions.find((v) => !inPeriod.includes(v)) ?? null
        let tail: Snap | null = after ? parseSnap(after.snapshot) : null
        if (!after) tail = await currentSnap(layoutId)
        for (let i = 0; i < inPeriod.length; i++) {
          if (pending.length >= CHANGE_LOG_MAX_ROWS) {
            truncated = true
            break
          }
          const v = inPeriod[i]
          const from = parseSnap(v.snapshot)
          const next = i + 1 < inPeriod.length ? parseSnap(inPeriod[i + 1].snapshot) : tail
          const collection = String(t.collection ?? from?.layout.collection ?? '')
          const labels = collection ? await labelFor(collection) : new Map<string, string>()
          const s =
            from && next
              ? summarizeChange(from, next, (f) => labels.get(f) ?? f)
              : {
                  summary: 'The form was deleted after this',
                  sections_added: 0,
                  sections_removed: 0,
                  fields_added: 0,
                  fields_removed: 0,
                  fields_moved: 0,
                  settings_changed: []
                }
          const by = v.created_by ? String(v.created_by) : null
          if (by) authors.add(by)
          pending.push({
            by,
            row: {
              at: iso(v.created_at),
              collection,
              layout_id: layoutId,
              layout: String((next ?? from)?.layout.name ?? `Layout ${layoutId}`),
              version: Number(v.version),
              version_name: v.name ? String(v.name) : null,
              who: by ? '' : 'System',
              who_email: null,
              note: v.note ? String(v.note) : null,
              ...s
            }
          })
        }
      }

      const people = new Map<string, { name: string; email: string | null }>()
      const ids = [...authors]
      for (let i = 0; i < ids.length; i += 500) {
        const users = (await db('nivaro_users')
          .whereIn('id', ids.slice(i, i + 500))
          .select('id', 'first_name', 'last_name', 'email')) as Row[]
        for (const u of users) {
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
          people.set(String(u.id).toLowerCase(), {
            name: name || String(u.email ?? u.id),
            email: u.email ? String(u.email) : null
          })
        }
      }
      for (const p of pending) {
        if (!p.by) continue
        const who = people.get(p.by.toLowerCase())
        p.row.who = who?.name ?? p.by
        p.row.who_email = who?.email ?? null
      }
      for (const p of pending) rows.push(p.row)
      rows.sort((a, b) => a.at.localeCompare(b.at) || a.layout_id - b.layout_id)
      return { rows, truncated }
    },
    { label: 'layout-change-log' }
  )
}

export const CHANGE_LOG_COLUMNS = [
  'When (UTC)',
  'Collection',
  'Form',
  'Form id',
  'Version',
  'Version name',
  'Who',
  'Email',
  'Note',
  'What changed',
  'Sections added',
  'Sections removed',
  'Fields added',
  'Fields removed',
  'Fields moved',
  'Settings changed'
]

/** The CSV, safe to open in a spreadsheet (csvCell quotes and defuses formulas). */
export function changeLogCsv(log: ChangeLog): string {
  const lines = [csvRow(CHANGE_LOG_COLUMNS)]
  for (const r of log.rows)
    lines.push(
      csvRow([
        r.at,
        r.collection,
        r.layout,
        r.layout_id,
        r.version,
        r.version_name,
        r.who,
        r.who_email,
        r.note,
        r.summary,
        r.sections_added,
        r.sections_removed,
        r.fields_added,
        r.fields_removed,
        r.fields_moved,
        r.settings_changed.join(', ')
      ])
    )
  if (log.truncated)
    lines.push(csvRow([`Stopped at ${CHANGE_LOG_MAX_ROWS} changes: pick a shorter period`]))
  return `﻿${lines.join('\r\n')}\r\n`
}
