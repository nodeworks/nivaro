import { liveQueryMeta } from './live-queries'

/**
 * Dropdown options go live (realtime program 2026-11-14, idea 4).
 *
 * A picker's option list (M2O, M2M, grouped) declares the collection it lists; the live query
 * bridge (live-queries.ts) then marks every cached copy stale when someone creates, changes or
 * deletes a record there — an admin editing a lookup table included. Nothing re-reads on the
 * spot: the list reads again the next time the dropdown opens, so a vendor someone else just made
 * is there then, and an OPEN dropdown never reshuffles under the pointer or the keyboard.
 *
 * The re-read is the picker's own request — as the viewer, with its picker_filter, cascade
 * parents and sort — so permissions and narrowing hold. Aspect notices (`$comments`, `$related`…)
 * never touch option lists (they are not columns). Static choice lists are configuration: they
 * follow the existing config hot-push.
 */
export function pickerOptionsMeta(collection: string | null | undefined) {
  return collection ? liveQueryMeta({ reads: [collection], staleOnly: true }) : undefined
}
