/**
 * Sign-out note (2026-11-10, Rob): the message an administrator left when
 * signing a person out (api services/sign-out-note.ts). The person's open tabs
 * receive it on the socket (`session:signed-out-note`), keep it in
 * localStorage and show it on the sign-in page until they sign in again —
 * so someone away from their desk reads it when they come back.
 *
 * efp-new's socket layer writes the same key and shape (twin: efp-new
 * src/lib/sign-out-note.ts) so it works before it pins a package with this.
 */

export const SIGN_OUT_NOTE_EVENT = 'session:signed-out-note'
export const SIGN_OUT_NOTE_KEY = 'nvr:signout-note'
/** Window event: a note was just stored (the sign-in page shows it at once). */
export const SIGN_OUT_NOTE_WINDOW_EVENT = 'nvr:signed-out-note'

/** How long a browser keeps a note — the server keeps it as long (api sign-out-note.ts). */
export const SIGN_OUT_NOTE_KEEP_MS = 14 * 24 * 60 * 60 * 1000

export interface SignOutNote {
  /** The person signed out (upper-case id) — a shared browser shows it on the sign-in page
   *  (anyone walking up sees why), but never carries it into someone else's sign-in. */
  user_id: string | null
  message: string
  by_name: string | null
  /** ISO time of the sign-out. */
  at: string
}

export function parseSignOutNote(v: unknown): SignOutNote | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.message !== 'string' || !o.message.trim()) return null
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null
  return {
    user_id: typeof o.user_id === 'string' && o.user_id ? o.user_id.toUpperCase() : null,
    message: o.message.trim().slice(0, 280),
    by_name: typeof o.by_name === 'string' && o.by_name.trim() ? o.by_name.trim() : null,
    at: o.at
  }
}

export function saveSignOutNote(note: SignOutNote): void {
  try {
    localStorage.setItem(SIGN_OUT_NOTE_KEY, JSON.stringify(note))
  } catch {
    /* private mode / storage off: the sign-in page simply has nothing to show */
  }
  try {
    window.dispatchEvent(new CustomEvent(SIGN_OUT_NOTE_WINDOW_EVENT, { detail: note }))
  } catch {
    /* no window (tests) */
  }
}

export function readSignOutNote(): SignOutNote | null {
  try {
    const raw = localStorage.getItem(SIGN_OUT_NOTE_KEY)
    const note = raw ? parseSignOutNote(JSON.parse(raw)) : null
    // Older than the server keeps it: gone.
    if (note && Date.now() - Date.parse(note.at) > SIGN_OUT_NOTE_KEEP_MS) {
      clearSignOutNote()
      return null
    }
    return note
  } catch {
    return null
  }
}

export function clearSignOutNote(): void {
  try {
    localStorage.removeItem(SIGN_OUT_NOTE_KEY)
  } catch {
    /* nothing stored */
  }
}

/** Two notes are the same sign-out (same moment, same text). */
export function sameSignOutNote(a: SignOutNote | null, b: SignOutNote | null): boolean {
  return (
    !!a &&
    !!b &&
    a.at === b.at &&
    a.message === b.message &&
    (a.user_id ?? '') === (b.user_id ?? '')
  )
}

/**
 * "Signed out by Rob Lee at 3:42 PM" — today's time alone, another day's
 * with its date ("on Nov 9 at 3:42 PM"); 12-hour, the viewer's own time zone.
 */
export function signOutNoteHeading(note: SignOutNote, now: Date = new Date()): string {
  const at = new Date(note.at)
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameDay = at.toDateString() === now.toDateString()
  const when = sameDay
    ? `at ${time}`
    : `on ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
  return `Signed out by ${note.by_name ?? 'an administrator'} ${when}`
}
