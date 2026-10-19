/**
 * Keep tool answers small enough for a model: cut long text, page long lists,
 * and say when something was left out.
 */

/** `text` cut to `max` characters, with an ellipsis when it was longer. */
export function clip(text: unknown, max: number): string | null {
  if (text === null || text === undefined) return null
  const s = String(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** A row with every long string value clipped; nested values above `max` as JSON are
 *  replaced by a short note. */
export function clipRow(row: Record<string, unknown>, max: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string') out[key] = clip(value, max)
    else if (value && typeof value === 'object') {
      const json = JSON.stringify(value)
      out[key] = json.length > max ? `${clip(json, max)} (truncated)` : value
    } else out[key] = value
  }
  return out
}

export interface Page<T> {
  items: T[]
  total: number
  offset: number
  truncated: boolean
}

/** One page of an in-memory list the API answered whole. */
export function pageOf<T>(list: T[], limit: number, offset = 0): Page<T> {
  const start = Math.max(0, Math.trunc(offset))
  const items = list.slice(start, start + limit)
  return { items, total: list.length, offset: start, truncated: start + items.length < list.length }
}

/** "First Last", else the email, else null. */
export function personName(first: unknown, last: unknown, email?: unknown): string | null {
  const name = [first, last].filter((v) => typeof v === 'string' && v.trim()).join(' ')
  if (name) return name
  return typeof email === 'string' && email ? email : null
}
