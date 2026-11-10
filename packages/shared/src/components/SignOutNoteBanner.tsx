import { LogOut, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { del, get } from '../lib/commands'
import {
  clearSignOutNote,
  parseSignOutNote,
  readSignOutNote,
  SIGN_OUT_NOTE_KEY,
  SIGN_OUT_NOTE_WINDOW_EVENT,
  type SignOutNote,
  sameSignOutNote,
  signOutNoteHeading
} from '../lib/sign-out-note'

/**
 * The note an administrator left when signing this person out, on the sign-in
 * page (2026-11-10, Rob: "they can CLEARLY see and stays on the login page in
 * case they are away from computer"). A full-width, high-contrast band at the
 * top, the same in light and dark (amber with near-black text), readable from
 * across the room. It stays — through reloads — until they sign in again
 * (SignOutNoteAfterSignIn clears it).
 */
export function SignOutNoteBanner() {
  const [note, setNote] = useState<SignOutNote | null>(() => readSignOutNote())
  useEffect(() => {
    const again = () => setNote(readSignOutNote())
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIGN_OUT_NOTE_KEY) again()
    }
    window.addEventListener(SIGN_OUT_NOTE_WINDOW_EVENT, again)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(SIGN_OUT_NOTE_WINDOW_EVENT, again)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  if (!note) return null
  return (
    <div
      role='alert'
      data-sign-out-note
      className='fixed inset-x-0 top-0 z-[60] border-b-4 border-[#92400e] bg-[#fbbf24] px-4 py-5 text-[#111827] shadow-xl sm:px-8 sm:py-7'
    >
      <div className='mx-auto flex max-w-5xl items-start gap-4'>
        <LogOut className='mt-1 h-8 w-8 shrink-0 sm:h-10 sm:w-10' strokeWidth={2.25} aria-hidden />
        <div className='min-w-0'>
          <p className='text-[15px] font-semibold uppercase tracking-wide sm:text-[17px]'>
            {signOutNoteHeading(note)}
          </p>
          <p className='mt-1.5 break-words text-[22px] font-bold leading-snug sm:text-[30px]'>
            {note.message}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * After the person signs in: the note a sign-out left for them, once. A tab
 * that showed it on the sign-in page already did its job (same note) — the
 * stored copy is cleared quietly; otherwise (no tab was open, another browser)
 * it is shown here until they dismiss it. Either way it is gone afterwards.
 *
 * Shared devices: only the server's answer for THIS signed-in person is ever
 * shown (GET /security/my/sign-out-note reads their own note). The browser's
 * copy — possibly someone else's sign-out — is only compared, then cleared on
 * every sign-in, so it never follows a different person into the app.
 */
export function SignOutNoteAfterSignIn() {
  const client = useOptionalNivaroClient()
  const [note, setNote] = useState<SignOutNote | null>(null)
  useEffect(() => {
    if (!client) return
    let alive = true
    const seen = readSignOutNote()
    clearSignOutNote()
    client
      .request<{ data: unknown }>(get('/security/my/sign-out-note'))
      .then((r) => {
        if (!alive) return
        const server = parseSignOutNote(r?.data)
        if (!server) return
        if (sameSignOutNote(server, seen)) {
          void client.request(del('/security/my/sign-out-note')).catch(() => {})
          return
        }
        setNote(server)
      })
      .catch(() => {
        /* an older server has no notes; nothing to show */
      })
    return () => {
      alive = false
    }
  }, [client])
  if (!note) return null
  const dismiss = () => {
    setNote(null)
    if (client) void client.request(del('/security/my/sign-out-note')).catch(() => {})
  }
  return (
    <div
      role='alertdialog'
      aria-labelledby='sign-out-note-heading'
      data-sign-out-note-after
      className='fixed inset-x-0 top-0 z-[70] border-b-4 border-[#92400e] bg-[#fbbf24] px-4 py-4 text-[#111827] shadow-xl sm:px-8'
    >
      <div className='mx-auto flex max-w-5xl items-start gap-4'>
        <LogOut className='mt-0.5 h-7 w-7 shrink-0' strokeWidth={2.25} aria-hidden />
        <div className='min-w-0 flex-1'>
          <p
            id='sign-out-note-heading'
            className='text-[13px] font-semibold uppercase tracking-wide'
          >
            {signOutNoteHeading(note)}
          </p>
          <p className='mt-1 break-words text-[20px] font-bold leading-snug'>{note.message}</p>
        </div>
        <button
          type='button'
          onClick={dismiss}
          className='inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#111827] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[#1f2937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fbbf24]'
        >
          <X className='h-4 w-4' aria-hidden /> Got it
        </button>
      </div>
    </div>
  )
}
