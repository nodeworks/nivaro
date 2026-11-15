/**
 * A line removed under you (realtime round 7, item 6) — the pure parts. Someone else (or a
 * procedure) deletes the grid line this person has open in its editor, or has focus in:
 * focus goes to the next line, a calm note says who removed it, and the person's unsaved
 * input for it is kept in a chip they can copy or put back as a new line.
 */

/** Who removed a line, as GET /revisions/o2m-removed answers it. */
export interface LineRemovedBy {
  at: string
  who: string
  user_id?: string | null
  via: 'user' | 'integration' | 'system' | 'procedure' | 'outside' | 'import'
}

const SKIP = new Set(['id', 'sort', 'date_created', 'date_updated', 'user_created', 'user_updated'])

/**
 * What the person had typed into the line and not saved: the editor's draft and any staged
 * (pending-mode) edit, against the line as it was last stored. Pure.
 */
export function unsavedLineChanges(
  stored: Record<string, unknown> | null | undefined,
  draft: Record<string, unknown> | null | undefined,
  staged: Record<string, unknown> | null | undefined,
  skip: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const base = stored ?? {}
  const consider = (src: Record<string, unknown> | null | undefined) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (SKIP.has(k) || skip.has(k) || k.startsWith('$') || k.startsWith('__')) continue
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) continue
      const was = base[k]
      if (String(v ?? '') === String(was ?? '')) {
        delete out[k]
        continue
      }
      out[k] = v
    }
  }
  consider(staged)
  consider(draft)
  return out
}

/** The line focus moves to: the next one still there after the removed one, else the one
 *  before it, else none. Pure. */
export function nextLineAfter(
  order: readonly string[],
  stillThere: ReadonlySet<string>,
  removedId: string
): string | null {
  const i = order.indexOf(removedId)
  if (i < 0) return null
  for (let j = i + 1; j < order.length; j++) if (stillThere.has(order[j])) return order[j]
  for (let j = i - 1; j >= 0; j--) if (stillThere.has(order[j])) return order[j]
  return null
}

/** "Beth removed this line", "A procedure (reforecast) removed this line", … Pure. */
export function removedLineText(
  by: LineRemovedBy | null | undefined,
  selfId?: string | null
): string {
  if (!by) return 'This line was removed'
  if (by.user_id && selfId && by.user_id.toUpperCase() === selfId.toUpperCase())
    return 'You removed this line in another tab'
  if (by.via === 'outside') return 'This line was removed outside the app'
  const who = String(by.who ?? '').trim()
  if (!who) return 'This line was removed'
  return `${who.charAt(0).toUpperCase()}${who.slice(1)} removed this line`
}

/** The values a "Restore as new line" starts from: the line as it was, with the person's
 *  input over it; a linked record becomes its id, nested lists are left out. Pure. */
export function restorableLine(
  stored: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries({ ...stored, ...changes })) {
    if (Array.isArray(v)) continue
    if (v !== null && typeof v === 'object') {
      const id = (v as { id?: unknown }).id
      if (id != null) out[k] = id
      continue
    }
    out[k] = v
  }
  return out
}

/** The person's kept input as text, one "Label: value" per line (for Copy). Pure. */
export function unsavedLineText(
  changes: Record<string, unknown>,
  labelOf: (field: string) => string
): string {
  return Object.entries(changes)
    .map(([k, v]) => `${labelOf(k)}: ${v == null ? '' : String(v)}`)
    .join('\n')
}
