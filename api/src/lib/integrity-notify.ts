/**
 * Whether storing a record's integrity result should tell the record's viewers
 * to re-read it: a write always may have moved it; a live check (run on every
 * record open) only when its findings differ from the stored row — none stored
 * counts as different; a sweep never.
 */
export function integrityChangedFor(
  source: 'write' | 'live' | 'sweep',
  previousFindings: string | null | undefined,
  payload: string
): boolean {
  if (source === 'sweep') return false
  if (source === 'write') return true
  return previousFindings !== payload
}
