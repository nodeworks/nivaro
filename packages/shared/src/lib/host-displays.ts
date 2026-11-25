/**
 * Host display rows: a `__host_<key>__` layout placement shows a read-only value the HOST
 * app draws (lib/placement-behaviour.ts isHostDisplayField). The host registers a
 * component under `<key>` once at boot; the record form and the read view hand it the
 * form's live draft (an unsaved record included) and the record id. Nothing is stored or
 * written. An unregistered key shows a dash, so a layout shared by two apps stays safe.
 *
 *   registerHostDisplay('efp-net-terms', NetTermsValue)
 */
import type { ReactNode } from 'react'

export interface HostDisplayProps {
  /** The form's current values (read view: the stored record). */
  draft: Record<string, unknown>
  /** The record id, or null / 'new' while it is being created. */
  itemId: string | null
  collection: string
  /** The placement, `__host_<key>__`. */
  field: string
}

export type HostDisplayComponent = (props: HostDisplayProps) => ReactNode

const registry = new Map<string, HostDisplayComponent>()
const listeners = new Set<() => void>()
let version = 0

export function registerHostDisplay(key: string, component: HostDisplayComponent): void {
  if (!key || typeof component !== 'function') return
  registry.set(key, component)
  version++
  for (const l of listeners) l()
}

export function getHostDisplay(key: string | null | undefined): HostDisplayComponent | null {
  return key ? (registry.get(key) ?? null) : null
}

/** For useSyncExternalStore: a registration after mount redraws the rows. */
export function subscribeHostDisplays(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function hostDisplaysVersion(): number {
  return version
}
