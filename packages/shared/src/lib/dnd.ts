/**
 * Do not disturb (#2114): `preferences.dnd = {until}` holds toasts and sounds on every tab and
 * device of one person until `until` (null = until switched off). The inbox still fills, and a
 * critical notification still breaks through. The server saves it with the rest of the
 * preferences and tells the person's other tabs through their user room (prefs:changed).
 */

export interface DndPref {
  until?: string | null
}

/** Is do not disturb on right now? */
export function isDndActive(
  prefs: Record<string, unknown> | null | undefined,
  now = Date.now()
): boolean {
  const d = prefs?.dnd as DndPref | null | undefined
  if (!d || typeof d !== 'object') return false
  if (d.until && new Date(d.until).getTime() <= now) return false
  return true
}

/** When it ends, or null for "until switched off" / off. */
export function dndUntil(prefs: Record<string, unknown> | null | undefined): Date | null {
  const d = prefs?.dnd as DndPref | null | undefined
  if (!d?.until) return null
  const t = new Date(d.until)
  return Number.isNaN(t.getTime()) ? null : t
}

/** A notification that still gets its toast and sound under do not disturb. */
export function breaksThroughDnd(n: { lane?: string | null } | null | undefined): boolean {
  return n?.lane === 'critical'
}
