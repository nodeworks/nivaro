/**
 * The watch row's change line ("Moved to Approved · Beth · 2 m") and its quiet "changed"
 * mark, from the newest event of each kind on the record. Pure — rows.ts reads the events
 * (already cut to what the viewer may know: field names they may read, field comments on
 * fields they may read) and hands them here.
 */

export type ChangeKind = 'moved' | 'edited' | 'commented' | 'created'

export interface ChangeEvent {
  kind: ChangeKind
  /** ISO time of the event. */
  at: string
  /** Who did it (user id), when known. */
  by: string | null
  /** moved: the step it moved to; edited: field labels the viewer may read. */
  to?: string | null
  fields?: string[]
}

export interface ChangeIndicator {
  kind: ChangeKind
  at: string
  by: { id: string; name: string; self: boolean } | null
  /** The words before the person: "Moved to Approved", "Changed Amount and Vendor". */
  text: string
  /** Someone else changed it after the person last saw it. */
  changed: boolean
  /** How many of the newest events of each kind are unseen and someone else's. */
  unseen: number
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function fieldListText(labels: string[]): string {
  const list = labels.filter(Boolean)
  if (list.length === 0) return 'Edited'
  if (list.length === 1) return `Changed ${list[0]}`
  if (list.length === 2) return `Changed ${list[0]} and ${list[1]}`
  return `Changed ${list[0]}, ${list[1]} and ${list.length - 2} more`
}

export function eventText(e: ChangeEvent): string {
  switch (e.kind) {
    case 'moved':
      return e.to ? `Moved to ${e.to}` : 'Moved'
    case 'commented':
      return 'Commented'
    case 'created':
      return 'Created'
    default:
      return fieldListText(e.fields ?? [])
  }
}

/**
 * The newest event decides the line. "changed" = an event by SOMEONE ELSE newer than `seenAt`
 * (the person's own writes never light their list). An edit with no field the viewer may
 * read is dropped before it gets here, so a hidden-field write never lights a row.
 */
export function changeIndicator(
  events: Array<ChangeEvent | null | undefined>,
  selfId: string,
  seenAt: string,
  names: Record<string, string>
): ChangeIndicator | null {
  const list = events
    .filter((e): e is ChangeEvent => !!e && Number.isFinite(new Date(e.at).getTime()))
    .sort((a, z) => new Date(z.at).getTime() - new Date(a.at).getTime())
  if (list.length === 0) return null
  const seen = new Date(seenAt).getTime()
  const unseen = list.filter(
    (e) => !sameId(e.by, selfId) && new Date(e.at).getTime() > (Number.isFinite(seen) ? seen : 0)
  )
  const top = list[0]
  const by = top.by
    ? {
        id: top.by,
        name: sameId(top.by, selfId) ? 'You' : (names[top.by.toLowerCase()] ?? 'Someone'),
        self: sameId(top.by, selfId)
      }
    : null
  return {
    kind: top.kind,
    at: new Date(top.at).toISOString(),
    by,
    text: eventText(top),
    changed: unseen.length > 0,
    unseen: unseen.length
  }
}

/** Pick the newest of rows already ordered newest-first per key (rows from a ROW_NUMBER read). */
export function newestBy<T>(rows: T[], key: (r: T) => string): Map<string, T> {
  const out = new Map<string, T>()
  for (const r of rows) {
    const k = key(r)
    if (!out.has(k)) out.set(k, r)
  }
  return out
}

/**
 * Time in the current step against the usual time for it (median of finished stays).
 * `ratio` drives the row's mini timeline; null median = no comparison yet.
 */
export function stepTiming(
  enteredAt: string | Date | null | undefined,
  medianSeconds: number | null | undefined,
  now: number = Date.now()
): { in_step_s: number; usual_s: number | null; ratio: number | null } | null {
  if (!enteredAt) return null
  const t = new Date(enteredAt).getTime()
  if (!Number.isFinite(t)) return null
  const inStep = Math.max(0, Math.round((now - t) / 1000))
  const usual = medianSeconds != null && medianSeconds > 0 ? Math.round(medianSeconds) : null
  return { in_step_s: inStep, usual_s: usual, ratio: usual ? inStep / usual : null }
}
