/**
 * Bulk "Update field" preview + outcome sentences (2026-11-13). Pure: the bar
 * asks `POST /items/:c/bulk-update?dry_run=1` (the server reads every record
 * as the person, in batches) and words the answer here; the write's own
 * answer is worded by `bulkUpdateOutcome`.
 */
import { plainErrorText } from '../../lib/safe-error'

export type BulkLinkMode = 'append' | 'replace' | 'remove'

/** The value a to-many field's bulk write sends (the items service's alias shapes). */
export function bulkLinksValue(
  mode: BulkLinkMode,
  ids: Array<string | number>
):
  | { create: Array<string | number> }
  | { set: Array<string | number> }
  | { delete: Array<string | number> } {
  const seen = new Set<string>()
  const list = ids.filter((id) => {
    const k = String(id).toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return mode === 'replace'
    ? { set: list }
    : mode === 'remove'
      ? { delete: list }
      : { create: list }
}

export interface BulkUpdatePreviewAnswer {
  would_update: number
  skipped: number
  refused: number
  refused_reason: string | null
  unreadable: number
  links_added?: number
  links_removed?: number
  links_unknown?: boolean
}

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

/**
 * One line for the preview: what changes, then what is left alone and why.
 *   "Changes 12 records · 3 already hold it · 1 refused — locked on its form"
 *   "Adds 2 links to 14 records · 3 records already have them"
 *   "Removes 21 links and adds 28 across 14 records"
 */
export function bulkPreviewSentence(
  p: BulkUpdatePreviewAnswer,
  opts: { mode?: BulkLinkMode | null } = {}
): { headline: string; notes: string[] } {
  const notes: string[] = []
  let headline: string
  const added = p.links_added ?? 0
  const removed = p.links_removed ?? 0
  if (opts.mode && !p.links_unknown) {
    if (p.would_update === 0) headline = 'Nothing would change'
    else if (opts.mode === 'append')
      headline = `Adds ${n(added, 'link')} to ${n(p.would_update, 'record')}`
    else if (opts.mode === 'remove')
      headline = `Removes ${n(removed, 'link')} from ${n(p.would_update, 'record')}`
    else
      headline =
        added && removed
          ? `Removes ${n(removed, 'link')} and adds ${added.toLocaleString()} across ${n(p.would_update, 'record')}`
          : added
            ? `Adds ${n(added, 'link')} across ${n(p.would_update, 'record')}`
            : `Removes ${n(removed, 'link')} across ${n(p.would_update, 'record')}`
    if (p.skipped)
      notes.push(
        opts.mode === 'remove'
          ? `${n(p.skipped, 'record')} ${p.skipped === 1 ? 'has' : 'have'} none of them`
          : opts.mode === 'append'
            ? `${n(p.skipped, 'record')} already ${p.skipped === 1 ? 'has' : 'have'} them`
            : `${n(p.skipped, 'record')} already ${p.skipped === 1 ? 'matches' : 'match'}`
      )
  } else {
    headline =
      p.would_update === 0 ? 'Nothing would change' : `Changes ${n(p.would_update, 'record')}`
    if (p.links_unknown)
      notes.push('you cannot read the current links, so this counts every record')
    if (p.skipped)
      notes.push(`${n(p.skipped, 'record')} already ${p.skipped === 1 ? 'holds' : 'hold'} it`)
  }
  if (p.refused)
    notes.push(
      `${n(p.refused, 'record')} refused${p.refused_reason ? ` — ${p.refused_reason}` : ''}`
    )
  if (p.unreadable) notes.push(`${n(p.unreadable, 'record')} you cannot open`)
  return { headline, notes }
}

export interface BulkUpdateAnswer {
  updated: number
  skipped?: number
  refused?: number
  refused_reason?: string
  failed?: number
  failures?: Array<{ id: string | number; reason: string }>
  links_added?: number
  links_removed?: number
}

/** The bar's note after the write: every record that did not change is named with why. */
export function bulkUpdateOutcome(res: BulkUpdateAnswer): string {
  const parts = [`Updated ${n(res.updated, 'record')}`]
  if (res.links_added || res.links_removed) {
    const l: string[] = []
    if (res.links_added) l.push(`${n(res.links_added, 'link')} added`)
    if (res.links_removed) l.push(`${n(res.links_removed, 'link')} removed`)
    parts[0] += ` (${l.join(', ')})`
  }
  if (res.skipped) parts.push(`${res.skipped.toLocaleString()} already there`)
  if (res.refused)
    parts.push(
      `${res.refused.toLocaleString()} refused — ${plainErrorText(res.refused_reason ?? 'locked on its form', 'locked on its form')}`
    )
  if (res.failed) {
    // Server reasons are sentences (a lock, a refusal); anything raw reads plainly.
    const raw = res.failures?.[0]?.reason
    const first = raw ? plainErrorText(raw, 'could not be changed') : null
    parts.push(`${res.failed.toLocaleString()} not changed${first ? ` — ${first}` : ''}`)
  }
  return parts.join(' · ')
}
