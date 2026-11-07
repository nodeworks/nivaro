// The "<name> changed this record while you had it open" banner (army6 L44).
// Leaf module — no React, unit-tested directly (stale-banner.test.ts).

export type StaleBannerMode =
  /** Nothing of the person's is on the form: take the newer record, no banner. */
  | 'auto-refresh'
  /** The person's own edits still differ from the newer record: they may overwrite it. */
  | 'review'
  /** Unsaved work, but none of the person's edited fields differs from the newer record. */
  | 'refresh'

/** Whether a field the person edited still holds a value other than the latest record's.
 *  `latest` = the record as last read (undefined = not read: every edit counts). */
export function touchedEditsDiffer(
  touched: Iterable<string>,
  draft: Record<string, unknown>,
  latest: Record<string, unknown> | undefined,
  equal: (a: unknown, b: unknown) => boolean
): boolean {
  for (const k of touched) {
    if (k.startsWith('__')) continue
    if (!latest) return true
    if (!equal(draft[k], latest[k])) return true
  }
  return false
}

/**
 * What the banner does once someone else saved. "…or your edits may overwrite theirs" only
 * while the form is dirty AND an edited field still differs from the latest value — never on
 * a clean form that already took the newer values, nor after the conflict was settled.
 */
export function staleBannerMode(s: { dirty: boolean; editsDiffer: boolean }): StaleBannerMode {
  if (!s.dirty) return 'auto-refresh'
  return s.editsDiffer ? 'review' : 'refresh'
}
