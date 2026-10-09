import { useContext, useEffect, useSyncExternalStore } from 'react'
import { ItemEditAuthContext } from '../../../context'

/**
 * Clean recording mode: while a help video records, the screen being recorded
 * hides what belongs to the author rather than the walkthrough (notification
 * counts, chat, toasts, banners, floating chips) and shows "Demo User" in place
 * of the author's own name, email and photo.
 *
 * Two halves:
 * - `<html data-nvr-recording-clean>` drives CSS: anything tagged
 *   `data-nvr-recording-hide` disappears (`="keep-space"` keeps its box), and
 *   Sonner's toaster is hidden by its own attribute. Hosts that cannot import
 *   this module (a pinned package) read the attribute directly.
 * - `useCleanRecording()` / `useIsRecordingSelf()` for components that swap
 *   content (a name, an avatar).
 *
 * The mode is held, never set: every holder releases on unmount, so a crash
 * or a closed recorder can never leave the page stuck hidden.
 */

export const CLEAN_RECORDING_ATTR = 'data-nvr-recording-clean'
export const RECORDING_HIDE_ATTR = 'data-nvr-recording-hide'

/** What the author reads as while a clean recording runs. */
export const DEMO_USER = {
  name: 'Demo User',
  first_name: 'Demo',
  last_name: 'User',
  initials: 'DU',
  email: 'demo.user@example.com'
} as const

let holders = 0
let selfId: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function apply(on: boolean) {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  if (on) el.setAttribute(CLEAN_RECORDING_ATTR, '1')
  else el.removeAttribute(CLEAN_RECORDING_ATTR)
}

/** Turns clean mode on until the returned release runs (idempotent). Nested
 *  holders count; the mode ends when the last one releases. */
export function beginCleanRecording(): () => void {
  holders += 1
  if (holders === 1) {
    apply(true)
    emit()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    if (holders === 0) {
      apply(false)
      emit()
    }
  }
}

export function isCleanRecording(): boolean {
  return holders > 0
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** True while a clean recording runs. */
export function useCleanRecording(): boolean {
  return useSyncExternalStore(subscribe, isCleanRecording, () => false)
}

/** Holds clean mode while `active` is true. */
export function useCleanScreen(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return beginCleanRecording()
  }, [active])
}

/** Tells shared components who the signed-in person is, so their own photo
 *  reads as Demo User during a clean recording. Hosts call it once they know. */
export function setRecordingSelf(userId: string | number | null | undefined): void {
  const next = userId == null || userId === '' ? null : String(userId).toUpperCase()
  if (next === selfId) return
  selfId = next
  emit()
}

const getSelf = () => selfId

/** True when clean mode runs AND `userId` is the signed-in person (the host's
 *  setRecordingSelf, else the record form's auth context). */
export function useIsRecordingSelf(userId: string | number | null | undefined): boolean {
  const clean = useCleanRecording()
  const registered = useSyncExternalStore(subscribe, getSelf, () => null)
  const auth = useContext(ItemEditAuthContext)
  if (!clean || userId == null || userId === '') return false
  const id = String(userId).toUpperCase()
  const self = registered ?? (auth.userId ? auth.userId.toUpperCase() : null)
  return !!self && id === self
}

/** The setup panel's "Clean screen while recording" choice, per browser. */
export const CLEAN_PREF_KEY = 'nvr_hv_clean_screen'

export function readCleanPref(): boolean {
  try {
    return window.localStorage.getItem(CLEAN_PREF_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeCleanPref(on: boolean): void {
  try {
    window.localStorage.setItem(CLEAN_PREF_KEY, on ? '1' : '0')
  } catch {
    /* private window or blocked storage: the choice lasts this session only */
  }
}

/** Test-only: forget every holder and the registered person. */
export function resetCleanRecordingForTests(): void {
  holders = 0
  selfId = null
  apply(false)
  emit()
}
