/**
 * Fields a rollback / line restore left as they are because the caller may
 * not write them (field allow-list, approval edit lock). The answer carries
 * them as `skipped_fields` — said, so "Rolled back" is not read as a full
 * restore.
 */
export function restoreSkippedNote(res: unknown): string | null {
  const r = res as { skipped_fields?: unknown; data?: { skipped_fields?: unknown } } | null
  const raw = r?.data?.skipped_fields ?? r?.skipped_fields
  if (!Array.isArray(raw) || raw.length === 0) return null
  const names = [...new Set(raw.map((f) => String(f).replace(/_/g, ' ')))]
  const shown = names.slice(0, 5).join(', ')
  const more = names.length > 5 ? ` and ${names.length - 5} more` : ''
  return `Not restored (you can't change ${names.length === 1 ? 'it' : 'them'}): ${shown}${more}`
}
