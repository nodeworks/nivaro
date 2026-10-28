import { useEffect, useRef } from 'react'
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
  /** Keep this work through a reload (e.g. store the form's draft, which the page offers to
   *  recover after it): true = safe to reload. Without it, the work holds a pushed reload. */
  saveForReload?: () => boolean | Promise<boolean>
}

export interface UnsavedWorkOptions {
  saveForReload?: () => boolean | Promise<boolean>
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
export function registerUnsavedWork(
  label: string,
  dirty: () => boolean,
  opts: UnsavedWorkOptions = {}
): () => void {
  const id = ++seq
  sources.set(id, { label, dirty, saveForReload: opts.saveForReload })
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

const SAVE_FOR_RELOAD_TIMEOUT_MS = 3000

/**
 * Before a pushed reload (ForceReloadBanner): every dirty source that can keep its work through
 * a reload saves it now. Answers what still holds the reload — sources that cannot, a save that
 * failed or took longer than SAVE_FOR_RELOAD_TIMEOUT_MS, and the record outbox.
 */
export async function prepareForReload(): Promise<string[]> {
  const kept = await Promise.all(
    [...sources.values()].map(async (s): Promise<string | null> => {
      let dirty = false
      try {
        dirty = s.dirty()
      } catch {
        dirty = false
      }
      if (!dirty) return null
      let saved = false
      if (s.saveForReload) {
        try {
          saved = await Promise.race([
            Promise.resolve(s.saveForReload()),
            new Promise<boolean>((r) => setTimeout(() => r(false), SAVE_FOR_RELOAD_TIMEOUT_MS))
          ])
        } catch {
          saved = false
        }
      }
      return saved ? null : s.label
    })
  )
  // In registration order, once each.
  const holding = [...new Set(kept.filter((l): l is string => l != null))]
  const queued = outboxPending()
  if (queued) holding.push(`${queued} save${queued === 1 ? '' : 's'} waiting to be sent`)
  return holding
}

let reloadingForUpdate = false
/** A pushed reload is going ahead with every form's work saved: leave-page prompts stand down
 *  (the page offers the saved drafts back). Lapses if the reload does not happen. */
export function beginReloadForUpdate(): void {
  reloadingForUpdate = true
  setTimeout(() => {
    reloadingForUpdate = false
  }, 5000)
}
export function isReloadingForUpdate(): boolean {
  return reloadingForUpdate
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

/** A form reports its dirty state while mounted (and, optionally, how to keep it through a
 *  pushed reload — the latest function is always the one called). */
export function useUnsavedWork(
  dirty: boolean,
  label = 'Unsaved changes',
  saveForReload?: () => boolean | Promise<boolean>
): void {
  const saveRef = useRef(saveForReload)
  saveRef.current = saveForReload
  const canSave = !!saveForReload
  useEffect(() => {
    if (!dirty) return
    return registerUnsavedWork(
      label,
      () => true,
      canSave ? { saveForReload: () => saveRef.current?.() ?? false } : {}
    )
  }, [dirty, label, canSave])
}

/** Tests only. */
export function __resetUnsavedWorkForTests(): void {
  sources.clear()
  listeners.clear()
  reloadingForUpdate = false
}
