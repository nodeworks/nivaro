import { describeRawSource, readRawWriteSources, sourceForField } from './field-write-sources.js'

/**
 * "Beth removed this line" (realtime round 7 #6) — who removed ONE line of a record, for
 * GET /revisions/o2m-removed. Fails closed: it answers only when the caller may see the parent
 * record AND it is proven that the line belonged to that parent when it went.
 *
 *   1. the parent, read as the caller (the route's gate) — not visible → 404;
 *   2. the caller may read the link field on the line collection (field rules) — else nothing;
 *   3. the line is gone (a line still there, under any parent, is not "removed") — else nothing;
 *   4. membership: the line's NEWEST revision names this parent in the link field — else
 *      nothing (no revision = nothing proven);
 *   5. then who: the line's delete activity, else a procedure's announced source, else nothing.
 */

export interface LineRemovedBy {
  at: string
  who: string
  user_id: string | null
  via: 'user' | 'integration' | 'system' | 'procedure' | 'outside' | 'import'
}

export interface LineRemovedDeps {
  /** The parent record, read as the caller. */
  parentVisible(): Promise<boolean>
  /** May the caller read `manyField` on the line collection (field rules)? */
  mayReadLinkField(): Promise<boolean>
  /** The line as stored now (link field only), or null when it no longer exists. */
  currentLine(): Promise<Record<string, unknown> | null>
  /** The line's newest revision snapshot (any action), or null when it has none. */
  lastRevisionData(): Promise<Record<string, unknown> | null>
  /** Who deleted it (newest delete activity), or null. */
  deleteActivity(): Promise<LineRemovedBy | null>
  /** A procedure's announced source for the line, or null. */
  rawSource(): Promise<LineRemovedBy | null>
}

export type LineRemovedAnswer = { status: 404 } | { status: 200; data: LineRemovedBy | null }

export async function lineRemovedAnswer(
  deps: LineRemovedDeps,
  manyField: string,
  parentId: string
): Promise<LineRemovedAnswer> {
  if (!(await deps.parentVisible())) return { status: 404 }
  if (!(await deps.mayReadLinkField())) return { status: 200, data: null }
  if (await deps.currentLine()) return { status: 200, data: null }
  const last = await deps.lastRevisionData()
  if (!last || String(last[manyField] ?? '') !== String(parentId))
    return { status: 200, data: null }
  const by = (await deps.deleteActivity()) ?? (await deps.rawSource())
  return { status: 200, data: by }
}

/** Parse a revision snapshot column (text or object). Pure. */
export function revisionData(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(v))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The announced raw-write source of a line, described for a person. */
export async function rawLineSource(
  collection: string,
  item: string
): Promise<LineRemovedBy | null> {
  const raw = sourceForField(await readRawWriteSources(collection, item), '*')
  if (!raw) return null
  const d = describeRawSource(raw.source)
  return { at: new Date(raw.at).toISOString(), who: d.who, user_id: null, via: d.via }
}
