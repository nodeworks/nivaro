/**
 * The Resolution notes box beside a live issue (realtime gap R4, 2026-11-17).
 *
 * The saved notes can change while the box is open (another admin's save reaches the list's
 * live refresh). The box adopts them only when it holds no unsaved typing; otherwise the
 * typing stays and the newer saved text waits behind "Take theirs / Keep mine". A change that
 * is this box's own save (the text it last sent) never asks. Pure — exported for tests.
 */
export interface NotesSync {
  /** What the box shows next. */
  draft: string
  /** Saved text that differs from the typing, offered as "Take theirs"; null = nothing to ask. */
  theirs: string | null
}

export function notesOnServerChange(
  draft: string,
  prevSaved: string,
  nextSaved: string,
  lastSent: string | null
): NotesSync {
  // No unsaved typing: follow the saved copy.
  if (draft === prevSaved) return { draft: nextSaved, theirs: null }
  // Already the same text, or this box's own save landing while the person typed on.
  if (draft === nextSaved || (lastSent != null && nextSaved === lastSent))
    return { draft, theirs: null }
  return { draft, theirs: nextSaved }
}
