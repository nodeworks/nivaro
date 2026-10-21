/**
 * Form resolution and edit rules a layout keeps in its `conditions` JSON
 * beside `role_ids` and `testing` — the client half of
 * api/src/services/layout-resolve-rules.ts (the server decides; these read
 * and write the settings and phrase them):
 *
 *  - `active_window` {from?, until?} (#2714): the form resolves only on those days.
 *  - `phone_of` (#2715): this form is the phone version of that form.
 *  - `freeze` {until, reason, by?, by_name?, at?} (#2717): edits refused before `until`.
 *  - `lazy_sections` (#2713): sections whose pickers, grids and widgets wait until opened.
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

/** Layout `conditions` with every key kept (role_ids, testing, the keys above). */
export type LayoutConditionsBag = ({ role_ids?: string[] } & Record<string, unknown>) | null

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v)

export function conditionsObject(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** `conditions` with one key set (null removes it), every other key kept. */
export function conditionsWithKey(
  conditions: unknown,
  key: string,
  value: unknown
): LayoutConditionsBag {
  const next: Record<string, unknown> = { ...(conditionsObject(conditions) ?? {}) }
  if (value == null) delete next[key]
  else next[key] = value
  return Object.keys(next).length > 0 ? next : null
}

/** Today on this device, yyyy-mm-dd (the server reads the instance zone; a day apart at most). */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function activeWindowOf(conditions: unknown): ActiveWindow | null {
  const w = conditionsObject(conditionsObject(conditions)?.active_window)
  if (!w) return null
  const from = isDay(w.from) ? w.from : null
  const until = isDay(w.until) ? w.until : null
  return from || until ? { from, until } : null
}

export type WindowState = 'before' | 'open' | 'after'

export function windowState(win: ActiveWindow | null, today: string): WindowState | null {
  if (!win) return null
  if (win.from && today < win.from) return 'before'
  if (win.until && today > win.until) return 'after'
  return 'open'
}

/** "15 Dec 2026" — a stored day, never shifted by the device zone. */
export function dayWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

/** "15 Dec 2026 – 15 Jan 2027", "from 15 Dec 2026", "until 15 Jan 2027". */
export function windowWords(win: ActiveWindow): string {
  if (win.from && win.until) return `${dayWords(win.from)} – ${dayWords(win.until)}`
  if (win.from) return `from ${dayWords(win.from)}`
  return `until ${dayWords(win.until as string)}`
}

/** The `conditions` patch for the active dates (both empty = no window). */
export function activeWindowPatch(conditions: unknown, win: ActiveWindow) {
  const from = win.from || null
  const until = win.until || null
  return {
    conditions: conditionsWithKey(
      conditions,
      'active_window',
      from || until ? { ...(from ? { from } : {}), ...(until ? { until } : {}) } : null
    )
  }
}

export function phoneOf(conditions: unknown): number | null {
  const v = Number(conditionsObject(conditions)?.phone_of)
  return Number.isInteger(v) && v > 0 ? v : null
}

export function phoneOfPatch(conditions: unknown, desktopId: number | null) {
  return { conditions: conditionsWithKey(conditions, 'phone_of', desktopId) }
}

export function freezeOf(conditions: unknown): LayoutFreeze | null {
  const f = conditionsObject(conditionsObject(conditions)?.freeze)
  if (!f || !isDay(f.until)) return null
  return {
    until: f.until,
    reason: typeof f.reason === 'string' ? f.reason : '',
    by: typeof f.by === 'string' ? f.by : null,
    by_name: typeof f.by_name === 'string' ? f.by_name : null,
    at: typeof f.at === 'string' ? f.at : null
  }
}

/** The freeze in force on `today` (it lifts on its `until` day), or null. */
export function activeFreeze(conditions: unknown, today: string = localDay()): LayoutFreeze | null {
  const f = freezeOf(conditions)
  return f && today < f.until ? f : null
}

export function freezePatch(conditions: unknown, freeze: LayoutFreeze | null) {
  return { conditions: conditionsWithKey(conditions, 'freeze', freeze) }
}

/** What a refused save says (the server's words arrive with code LAYOUT_FROZEN). */
export const LAYOUT_FROZEN = 'LAYOUT_FROZEN'

export function lazySectionsOf(conditions: unknown): string[] {
  const v = conditionsObject(conditions)?.lazy_sections
  return Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === 'string'))] : []
}

/** The `conditions` patch that turns "load when opened" on or off for one section. */
export function lazySectionPatch(conditions: unknown, key: string, on: boolean) {
  const cur = lazySectionsOf(conditions).filter((k) => k !== key)
  const next = on ? [...cur, key] : cur
  return { conditions: conditionsWithKey(conditions, 'lazy_sections', next.length ? next : null) }
}

/** The screen class the record page reports to /active: phones get a form's phone version. */
export const PHONE_QUERY = '(max-width: 639px)'

export function currentViewport(): 'phone' | null {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches
      ? 'phone'
      : null
  } catch {
    return null
  }
}
