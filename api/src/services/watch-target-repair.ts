/**
 * Repair for watch notifications filed under the wrong record (2026-10-26).
 *
 * Before the fix in hooks/notification-subscriptions.ts (rowOwnerRelationsOf),
 * a watch on a pipeline-bound record (a workflow) was treated as a ROW of the
 * first record it linked to (its project): the notification row was stored with
 * collection/item = the project and `target.query = row=<collection>:<id>`, and
 * its subject read "<collection> <label> on <project>". The watched record is
 * still in that query, so the row can be put back on it.
 *
 * Pure: the script (scripts/repair-watch-targets.ts) reads the rows and labels.
 */

export interface WatchRowIn {
  id: string | number
  collection: string | null
  item: string | null
  subject: string | null
  target: string | null
  detail: string | null
}

export interface WatchRowFix {
  id: string | number
  collection: string
  item: string
  target: string
  subject?: string
  detail?: string
}

/** The watched record named by a stored `row=<collection>:<id>` query. */
export function watchedFromTarget(
  target: string | null
): { collection: string; id: string } | null {
  if (!target) return null
  let t: { query?: unknown } | null = null
  try {
    t = JSON.parse(target)
  } catch {
    return null
  }
  const q = typeof t?.query === 'string' ? t.query : ''
  const m = /^row=([^&]+)$/.exec(q)
  if (!m) return null
  const ref = decodeURIComponent(m[1])
  const i = ref.indexOf(':')
  if (i <= 0 || i === ref.length - 1) return null
  return { collection: ref.slice(0, i), id: ref.slice(i + 1) }
}

/**
 * The fix for one row, or null when it is not a misfiled watch: the query must
 * name a collection in `bound` (pipeline-bound — a record of its own) other
 * than the one the row is filed under. `labels` = the watched record's label
 * and the wrongly used parent's label; the subject / why text is rewritten
 * only where the exact "<collection> <own> on <parent>" phrase appears.
 */
export function repairWatchRow(
  row: WatchRowIn,
  bound: Set<string>,
  labels?: { own: string; parent: string }
): WatchRowFix | null {
  const watched = watchedFromTarget(row.target)
  if (!watched || !bound.has(watched.collection)) return null
  if (row.collection === watched.collection && String(row.item) === watched.id) return null
  const fix: WatchRowFix = {
    id: row.id,
    collection: watched.collection,
    item: watched.id,
    target: JSON.stringify({
      kind: 'record',
      collection: watched.collection,
      id: watched.id,
      action: 'open'
    })
  }
  if (labels) {
    const phrase = `${watched.collection.replace(/_/g, ' ')} ${labels.own} on ${labels.parent}`
    if (row.subject?.includes(phrase))
      fix.subject = row.subject.split(phrase).join(labels.own).slice(0, 255)
    if (row.detail?.includes(phrase)) {
      const d = row.detail.split(phrase).join(labels.own)
      try {
        JSON.parse(d)
        fix.detail = d
      } catch {
        /* never store broken JSON */
      }
    }
  }
  return fix
}
