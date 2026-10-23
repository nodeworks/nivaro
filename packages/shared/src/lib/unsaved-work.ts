import { useEffect } from 'react'
import { getRecordOutbox, subscribeRecordOutbox } from './record-outbox'

/**
 * "Does this tab hold work a reload would lose?" — one registry every form reports to, read by
 * the force-reload banner (a remote reload waits while it is true) and anything else that
 * reloads on its own.
 *
 * Sources: record forms (ItemEditForm unsaved fields, staged lines and links), the layout
 * editor, the payload template editor, a help-video recording, the headless useNivaroForm — and
 * the record outbox: saves queued while offline count until they are sent.
 *
 * A form reports with `useUnsavedWork(dirty, label)`; code holding the answer in a ref
 * registers a getter with `registerUnsavedWork(label, () => …)` and calls
 * `notifyUnsavedWorkChanged()` when it changes (readers also re-check on their own ticks).
 */

interface Source {
  label: string
  dirty: () => boolean
}

const sources = new Map<number, Source>()
const listeners = new Set<() => void>()
let seq = 0

export function notifyUnsavedWorkChanged(): void {
  for (const cb of [...listeners]) {
    try {
      cb()
    } catch {
      /* one listener never stops the rest */
    }
  }
}

/** Report a source of unsaved work; the returned function removes it. */
export function registerUnsavedWork(label: string, dirty: () => boolean): () => void {
  const id = ++seq
  sources.set(id, { label, dirty })
  notifyUnsavedWorkChanged()
  return () => {
    if (sources.delete(id)) notifyUnsavedWorkChanged()
  }
}

function outboxPending(): number {
  try {
    return getRecordOutbox().length
  } catch {
    return 0
  }
}

/** What would be lost, by label (empty = nothing). */
export function unsavedWorkLabels(): string[] {
  const out: string[] = []
  for (const s of sources.values()) {
    let dirty = false
    try {
      dirty = s.dirty()
    } catch {
      dirty = false
    }
    if (dirty && !out.includes(s.label)) out.push(s.label)
  }
  const queued = outboxPending()
  if (queued) out.push(`${queued} save${queued === 1 ? '' : 's'} waiting to be sent`)
  return out
}

export function hasUnsavedWork(): boolean {
  return unsavedWorkLabels().length > 0
}

/** Told when a source comes or goes, or the record outbox changes. */
export function subscribeUnsavedWork(cb: () => void): () => void {
  listeners.add(cb)
  const offOutbox = subscribeRecordOutbox(cb)
  return () => {
    listeners.delete(cb)
    offOutbox()
  }
}

/** A form reports its dirty state while mounted. */
export function useUnsavedWork(dirty: boolean, label = 'Unsaved changes'): void {
  useEffect(() => {
    if (!dirty) return
    return registerUnsavedWork(label, () => true)
  }, [dirty, label])
}

/** Tests only. */
export function __resetUnsavedWorkForTests(): void {
  sources.clear()
  listeners.clear()
}
