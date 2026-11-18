import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Open the record's Integrations dialog (ExternalRequestsChip) from elsewhere on the record
 * page — the pipeline notice of a refused push points at it ("send it again from
 * Integrations"). The chip registers itself while mounted, so a caller offers the link only
 * where there is a chip to open; the header mounts one per layout (inline below lg, docked
 * at lg), and only the one on screen answers.
 */

export const OPEN_INTEGRATIONS_EVENT = 'nvr:open-integrations'

export interface OpenIntegrationsRequest {
  collection: string
  item: string
  /** The request whose row should open and scroll into view. */
  submissionId?: number | null
  /** Set by the chip that answered. */
  handled?: boolean
  /** Second pass: no chip on screen answered, so the first one mounted does. */
  force?: boolean
}

const keyOf = (collection: string, item: string | number) => `${collection}\u0000${String(item)}`
const mounted = new Map<string, number>()
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Whether an Integrations chip for this record is mounted (the link has something to open). */
export function useIntegrationsOpenable(collection: string, item: string | number): boolean {
  const key = keyOf(collection, item)
  return useSyncExternalStore(
    subscribe,
    () => (mounted.get(key) ?? 0) > 0,
    () => false
  )
}

/** Ask the record's Integrations chip to open its dialog. True when one did. */
export function openRecordIntegrations(
  collection: string,
  item: string | number,
  submissionId?: number | null
): boolean {
  if (typeof window === 'undefined') return false
  const detail: OpenIntegrationsRequest = { collection, item: String(item), submissionId }
  window.dispatchEvent(new CustomEvent(OPEN_INTEGRATIONS_EVENT, { detail }))
  if (!detail.handled) {
    detail.force = true
    window.dispatchEvent(new CustomEvent(OPEN_INTEGRATIONS_EVENT, { detail }))
  }
  return detail.handled === true
}

/**
 * The chip's side: registers while mounted and opens on request. `visible` says whether
 * this copy of the chip is the one on screen.
 */
export function useIntegrationsOpener(
  collection: string,
  item: string,
  visible: () => boolean,
  onOpen: (submissionId: number | null) => void
): void {
  const open = useRef(onOpen)
  open.current = onOpen
  const isVisible = useRef(visible)
  isVisible.current = visible
  useEffect(() => {
    const key = keyOf(collection, item)
    mounted.set(key, (mounted.get(key) ?? 0) + 1)
    emit()
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<OpenIntegrationsRequest>).detail
      if (!d || d.handled || d.collection !== collection || d.item !== String(item)) return
      if (!d.force && !isVisible.current()) return
      d.handled = true
      open.current(d.submissionId ?? null)
    }
    window.addEventListener(OPEN_INTEGRATIONS_EVENT, on)
    return () => {
      window.removeEventListener(OPEN_INTEGRATIONS_EVENT, on)
      const n = (mounted.get(key) ?? 1) - 1
      if (n > 0) mounted.set(key, n)
      else mounted.delete(key)
      emit()
    }
  }, [collection, item])
}
