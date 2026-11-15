import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type LiveBatch, useLiveRecord } from '../../lib/live'

/**
 * Live record title (rt3 #15). A record's heading, browser tab name and breadcrumb all read
 * its display template; someone else renaming it already re-reads the record (RecordLiveSync).
 * Two gaps are closed here:
 *
 * - A number that arrives from a partner or a procedure right after THIS person created or
 *   saved the record: its event lands inside the person's own-write window and is dropped as
 *   their own echo, so the heading kept "(no number)". When an own-looking event names a
 *   heading field that is EMPTY on screen, it cannot be this tab's echo — the record is re-read.
 * - The heading's linked names ("{{project.name}}") were cached under the record id only, so a
 *   changed link kept the old name; `headingLinksKey` carries the link ids.
 *
 * The heading text changing after the first render gets a short, subtle fade (none with
 * reduced motion) — no toast, no flash.
 */

/** Top-level field names a display template reads (`{{project.name}}` → project). */
export function headingFieldNames(template: string | null | undefined): string[] {
  if (!template) return []
  const out: string[] = []
  for (const m of template.matchAll(/\{\{\s*([A-Za-z_][\w]*)/g))
    if (!out.includes(m[1])) out.push(m[1])
  return out
}

const isEmpty = (v: unknown) => v == null || v === ''

/**
 * Whether a batch the live hooks would drop as this tab's own may still carry a heading value
 * this tab never wrote: it names a heading field that is empty on screen. Pure.
 */
export function ownBatchFillsHeading(
  batch: Pick<LiveBatch, 'own' | 'changedFields' | 'deleted'>,
  headingFields: readonly string[],
  row: Record<string, unknown> | null | undefined
): boolean {
  if (!batch.own || batch.deleted || !row || headingFields.length === 0) return false
  const named = batch.changedFields
  // An own event with no field names (a create) — any empty heading field may be filling in.
  const candidates = named === null ? headingFields : headingFields.filter((f) => named.includes(f))
  return candidates.some((f) => isEmpty(row[f]))
}

/** The heading-links query key: the record plus the ids of the links the template reads. */
export function headingLinksKey(
  collection: string,
  itemId: string,
  paths: readonly string[],
  row: Record<string, unknown> | null | undefined
): unknown[] {
  const heads = [...new Set(paths.map((p) => p.split('.')[0]))]
  const ids = heads.map((h) => {
    const v = row?.[h]
    return v != null && typeof v === 'object'
      ? String((v as { id?: unknown }).id ?? '')
      : String(v ?? '')
  })
  return ['item-heading-links', collection, itemId, paths.join(','), ids.join('|')]
}

/** Re-read the record when an own-looking event may have filled an empty heading field. */
export function useLiveHeadingFill(
  collection: string | null | undefined,
  itemId: string | null | undefined,
  template: string | null | undefined,
  row: Record<string, unknown> | null | undefined,
  enabled: boolean
): void {
  const qc = useQueryClient()
  const rowRef = useRef(row)
  rowRef.current = row
  const fields = headingFieldNames(template)
  useLiveRecord(
    enabled && fields.length > 0 ? collection : null,
    itemId,
    (batch) => {
      if (!collection || itemId == null) return
      if (!ownBatchFillsHeading(batch, fields, rowRef.current)) return
      void qc.invalidateQueries({ queryKey: ['item', collection, String(itemId)] })
    },
    { includeOwn: true, match: (ev) => ev.own }
  )
}

/** A key that changes when `text` changes after it first settled (for a re-keyed fade). */
export function useChangeKey(text: string | null | undefined): number {
  const [n, setN] = useState(0)
  const prev = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (prev.current !== undefined && prev.current && text && prev.current !== text)
      setN((x) => x + 1)
    if (text) prev.current = text
  }, [text])
  return n
}

/** The fade a changed heading gets (injected once; reduced motion = none). */
export const LIVE_TITLE_FADE_CSS =
  '@keyframes nvr-live-title-in{from{opacity:.35}to{opacity:1}}[data-live-title-changed]{animation:nvr-live-title-in .6s ease-out both}@media (prefers-reduced-motion:reduce){[data-live-title-changed]{animation:none}}'

let fadeCssInjected = false
function injectFadeCss() {
  if (fadeCssInjected || typeof document === 'undefined') return
  fadeCssInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-nvr-live-title', '')
  el.textContent = LIVE_TITLE_FADE_CSS
  document.head.appendChild(el)
}

/** The heading text: when it changes live it fades in quietly where it stands. */
export function LiveTitleText({ text }: { text: string | null | undefined }) {
  const n = useChangeKey(text)
  useEffect(() => {
    if (n > 0) injectFadeCss()
  }, [n])
  return (
    <span key={n} data-live-title-changed={n > 0 ? '' : undefined}>
      {text}
    </span>
  )
}
