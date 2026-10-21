import type { Knex } from 'knex'
import { currentTimezone, dayInZone } from './liquid-dates.js'

/**
 * Form resolution and edit rules kept in a layout's `conditions` JSON beside
 * `role_ids` and `testing` (no column of their own):
 *
 *  - `active_window` {from?, until?} (#2714) — the form resolves only on
 *    those days (yyyy-MM-dd, both inclusive, read in the instance zone).
 *    Outside them it leaves the candidate set, as a role restriction does.
 *  - `phone_of` (#2715) — this form is the lighter phone version of that
 *    form: it never wins on its own, and replaces its desktop form when the
 *    client says the screen is small (`viewport=phone` on /active).
 *  - `freeze` {until, reason, by?, by_name?, at?} (#2717) — edits to the
 *    form are refused before `until` (that day it opens again) unless the
 *    save carries an administrator's override note.
 *  - `lazy_sections` (#2713) — section keys whose pickers, grids and
 *    widgets wait until someone opens the section (the record page reads it).
 */

export interface ActiveWindow {
  from: string | null
  until: string | null
}

export interface LayoutFreeze {
  until: string
  reason: string
  by?: string | null
  by_name?: string | null
  at?: string | null
}

export type Viewport = 'phone' | null

export const LAYOUT_FROZEN = 'LAYOUT_FROZEN'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REASON_MAX = 300
const OVERRIDE_MIN = 3
const OVERRIDE_MAX = 300
const LAZY_MAX = 100

const isDay = (v: unknown): v is string =>
  typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

// The stored conditions text (or an already parsed object) as an object.
function obj(raw: unknown): Record<string, unknown> | null {
  let c = raw
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c)
    } catch {
      return null
    }
  }
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : null
}

/** Today in the instance zone (yyyy-MM-dd) — the day every window and freeze is read on. */
export function todayInInstance(now: Date = new Date()): string {
  return dayInZone(now, currentTimezone())
}

export function activeWindowOf(conditions: unknown): ActiveWindow | null {
  const w = obj(conditions)?.active_window as Record<string, unknown> | undefined
  if (!w || typeof w !== 'object') return null
  const from = isDay(w.from) ? w.from : null
  const until = isDay(w.until) ? w.until : null
  return from || until ? { from, until } : null
}

/** 'before' / 'after' the window, 'open' inside it; null when the form has none. */
export function windowState(
  win: ActiveWindow | null,
  today: string
): 'before' | 'open' | 'after' | null {
  if (!win) return null
  if (win.from && today < win.from) return 'before'
  if (win.until && today > win.until) return 'after'
  return 'open'
}

/** Is the form inside its active dates (or has none)? */
export function windowOpen(conditions: unknown, today: string): boolean {
  const s = windowState(activeWindowOf(conditions), today)
  return s === null || s === 'open'
}

/** "15 Dec 2026 to 15 Jan 2027", "from 15 Dec 2026", "until 15 Jan 2027". */
export function windowWords(win: ActiveWindow): string {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    })
  if (win.from && win.until) return `${fmt(win.from)} to ${fmt(win.until)}`
  if (win.from) return `from ${fmt(win.from)}`
  return `until ${fmt(win.until as string)}`
}

/** The desktop form this layout is the phone version of, or null. */
export function phoneOf(conditions: unknown): number | null {
  const v = Number(obj(conditions)?.phone_of)
  return Number.isInteger(v) && v > 0 ? v : null
}

export function freezeOf(conditions: unknown): LayoutFreeze | null {
  const f = obj(conditions)?.freeze as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object' || !isDay(f.until)) return null
  return {
    until: f.until,
    reason: typeof f.reason === 'string' ? f.reason : '',
    by: typeof f.by === 'string' ? f.by : null,
    by_name: typeof f.by_name === 'string' ? f.by_name : null,
    at: typeof f.at === 'string' ? f.at : null
  }
}

/** The freeze in force today, or null (none, or its date has come). */
export function activeFreeze(conditions: unknown, today: string): LayoutFreeze | null {
  const f = freezeOf(conditions)
  return f && today < f.until ? f : null
}

export function lazySectionsOf(conditions: unknown): string[] {
  const v = obj(conditions)?.lazy_sections
  return Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === 'string'))] : []
}

/** The refusal a write gets while the form is frozen, in words. */
export function frozenMessage(f: LayoutFreeze): string {
  const day = new Date(`${f.until}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const why = f.reason.trim() ? `: ${f.reason.trim()}` : ''
  return `This form is frozen until ${day}${why}. An administrator can override with a note.`
}

/** A usable override note (trimmed, capped), or null. */
export function overrideNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.replace(/\s+/g, ' ').trim().slice(0, OVERRIDE_MAX)
  return v.length >= OVERRIDE_MIN ? v : null
}

export type FreezeCheck =
  | { ok: true; override: string | null }
  | { ok: false; error: string; code: typeof LAYOUT_FROZEN; freeze: LayoutFreeze }

/**
 * May a write go to this layout today? Frozen layouts need an override note
 * (the routes are admin-only, so the caller is an administrator).
 */
export function checkFreeze(
  layout: { conditions?: unknown } | null | undefined,
  override: unknown,
  today: string = todayInInstance()
): FreezeCheck {
  const f = activeFreeze(layout?.conditions, today)
  if (!f) return { ok: true, override: null }
  const note = overrideNote(override)
  if (note) return { ok: true, override: note }
  return { ok: false, error: frozenMessage(f), code: LAYOUT_FROZEN, freeze: f }
}

/**
 * Validate the resolution keys of a conditions patch for layout `id` of
 * `collection`. Null = fine; else the refusal in words.
 */
export async function validateResolveConditions(
  q: Knex | Knex.Transaction,
  id: number,
  collection: string,
  conditions: unknown
): Promise<string | null> {
  if (conditions == null) return null
  if (typeof conditions !== 'object' || Array.isArray(conditions))
    return 'conditions must be an object'
  const c = conditions as Record<string, unknown>
  if (c.active_window != null) {
    const w = c.active_window as Record<string, unknown>
    if (typeof w !== 'object' || Array.isArray(w))
      return 'conditions.active_window must be an object'
    for (const k of ['from', 'until'] as const)
      if (w[k] != null && w[k] !== '' && !isDay(w[k]))
        return `conditions.active_window.${k} must be a date (yyyy-mm-dd)`
    if (!isDay(w.from) && !isDay(w.until))
      return 'conditions.active_window needs a from or an until date'
    if (isDay(w.from) && isDay(w.until) && w.from > w.until)
      return 'The active dates end before they start'
  }
  if (c.freeze != null) {
    const f = c.freeze as Record<string, unknown>
    if (typeof f !== 'object' || Array.isArray(f)) return 'conditions.freeze must be an object'
    if (!isDay(f.until)) return 'conditions.freeze.until must be a date (yyyy-mm-dd)'
    if (typeof f.reason !== 'string' || f.reason.trim().length < OVERRIDE_MIN)
      return 'A freeze needs a reason people will read'
    if (f.reason.length > REASON_MAX) return `A freeze reason is at most ${REASON_MAX} characters`
  }
  if (c.lazy_sections != null) {
    if (
      !Array.isArray(c.lazy_sections) ||
      c.lazy_sections.length > LAZY_MAX ||
      c.lazy_sections.some((k) => typeof k !== 'string' || !k)
    )
      return 'conditions.lazy_sections must be a list of section keys'
  }
  if (c.phone_of != null) {
    const target = Number(c.phone_of)
    if (!Number.isInteger(target) || target <= 0) return 'conditions.phone_of must be a layout id'
    if (target === Number(id)) return 'A form cannot be its own phone version'
    const row = (await q('nivaro_collection_layouts')
      .where({ id: target })
      .first('id', 'collection', 'layout_type', 'conditions')) as
      | { id: number; collection: string; layout_type: string | null; conditions: unknown }
      | undefined
    if (!row || row.collection !== collection) return 'The desktop form is not in this collection'
    if (row.layout_type && row.layout_type !== 'grouped')
      return 'Only a record form can have a phone version'
    if (phoneOf(row.conditions) != null) return 'That form is itself a phone version'
    const others = (await q('nivaro_collection_layouts')
      .where({ collection })
      .whereNot({ id: Number(id) })
      .whereNotNull('conditions')
      .select('id', 'name', 'conditions')) as Array<{
      id: number
      name: string
      conditions: unknown
    }>
    const taken = others.find((o) => phoneOf(o.conditions) === target)
    if (taken) return `“${taken.name}” is already the phone version of that form`
    if (others.some((o) => phoneOf(o.conditions) === Number(id)))
      return 'This form has a phone version of its own, so it cannot be one'
  }
  return null
}
