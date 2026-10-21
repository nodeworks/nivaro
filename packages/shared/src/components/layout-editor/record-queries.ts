import type { QueryClient } from '@tanstack/react-query'

/** What a record page renders from that a layout edit can change, keyed by collection. */
const RECORD_LAYOUT_KEYS = [
  'active-layout',
  'summary-layout',
  'file-layouts',
  'field-config',
  'drilldown-layout',
  'addendum-layout'
] as const

/**
 * After Edit layout mode closes, the record page re-reads its layouts, read and
 * file views and field settings. Hosts call it once the editor's `saved`
 * promise settles (LayoutEditor onBack), so the refetch sees the last save.
 */
export function invalidateRecordLayoutQueries(qc: QueryClient, collection: string) {
  for (const key of RECORD_LAYOUT_KEYS) void qc.invalidateQueries({ queryKey: [key, collection] })
  // Keyed by layout id, not collection.
  void qc.invalidateQueries({ queryKey: ['layout-meta'] })
}
