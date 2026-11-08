/**
 * Does a record move (Submit, Approve, Send back…) have to save first?
 *
 * The header dirty flag covers typed FIELDS only. Staged lines — a line edit
 * kept with the line's own Save, a forecast cell, a new forecast year, a
 * removed row — and staged links never set it, so a move used to go ahead on
 * the stored amounts while the screen showed the new ones (army11 f1: owners
 * were mailed $101.50 for a request the creator had made $600.50). Anything
 * the Leave dialog would count as unsaved is saved before the move.
 */
export function unsavedBeforeMove(s: {
  isDirty: boolean
  staged: { total: number } | null | undefined
}): boolean {
  return s.isDirty || (s.staged?.total ?? 0) > 0
}

/**
 * After the move's own save: may the record move now? Not while a line was
 * refused, a change waits on its reason, or a line met someone else's newer
 * save and the Theirs / Mine chooser is open (army11 review #3: the move went
 * ahead on the other person's amounts while the chooser asked).
 */
export function moveBlockedAfterSave(s: {
  childRefused: boolean
  lineConflicts?: number | null
  reasonWaiting?: boolean | null
  chooserOpen?: boolean
}): boolean {
  return s.childRefused || (s.lineConflicts ?? 0) > 0 || !!s.reasonWaiting || !!s.chooserOpen
}

/** The field error that appeared since the last check (a new field, or a new
 *  message on one) — what the form's polite live region reads out. */
export function newFieldError(
  prev: Record<string, string>,
  next: Record<string, string>
): { field: string; message: string } | null {
  for (const [field, message] of Object.entries(next))
    if (message && prev[field] !== message) return { field, message }
  return null
}
