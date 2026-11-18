import { useQueryClient } from '@tanstack/react-query'
import { useLiveEvent } from '../../lib/live'

/**
 * "Who has opened this record" reads (the owner-opened line, the Viewed-by chip) follow the
 * record's viewers notice (realtime gaps 2026-11-17, minor): someone joining the record room is
 * someone opening it. Listens only — never joins the room itself (the page already has). The
 * view watermark lands a moment after the join, so the re-read waits for the burst to settle.
 */
export const RECORD_OPENED_SETTLE_MS = 3000

/** Whether a `record:viewers` notice is about this record (an older server names none). */
export function viewersNoticeFor(collection: string, item: string) {
  return (p: { collection?: unknown; item?: unknown } | null | undefined): boolean =>
    p?.collection == null || p?.item == null
      ? true
      : p.collection === collection && String(p.item) === item
}

export function useRefreshOnRecordOpened(
  collection: string,
  item: string,
  queryKey: readonly unknown[],
  enabled = true
): void {
  const qc = useQueryClient()
  useLiveEvent('record:viewers', () => void qc.invalidateQueries({ queryKey: [...queryKey] }), {
    enabled: enabled && !!collection && !!item,
    includeOwn: true,
    debounceMs: RECORD_OPENED_SETTLE_MS,
    match: viewersNoticeFor(collection, item)
  })
}
