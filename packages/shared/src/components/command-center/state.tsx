import { createContext, useContext } from 'react'
import type { CcFilters, CcPublicConfig, Snapshot } from './types'

/**
 * One board-wide state every panel reads: the lenses (region focus, rewind instant), the map's
 * filters, the record open in the peek panel and the shell's modes. The shell
 * (CommandCenterView) owns it; panels never keep a second copy of these.
 */
export interface CcState {
  isAdmin: boolean
  /** Signed wallboard link in use (read-only board; no actions, no peek writes). */
  kiosk: string | null
  config: CcPublicConfig | null
  snapshot: Snapshot | null
  snapshotError: boolean
  /** When the snapshot last arrived (ms epoch) — freshness. */
  updatedAt: number | null

  region: string | null
  setRegion: (id: string | null) => void
  /** Rewind instant (ms epoch); null = live. */
  at: number | null
  setAt: (ms: number | null) => void

  mapCollection: string | null
  setMapCollection: (key: string) => void
  filters: CcFilters
  setFilters: (f: CcFilters) => void

  peek: { collection: string; id: string } | null
  setPeek: (p: { collection: string; id: string } | null) => void
  /** Fly the map to a point (people pane, region picker, attention rows). */
  focusMap: (p: { lat: number; lng: number; zoom?: number }) => void
  mapFocus: { lat: number; lng: number; zoom?: number; nonce: number } | null

  tv: boolean
  setTv: (on: boolean) => void

  navigate: (path: string) => void
  recordUrl: (collection: string, id: string) => string
}

export const EMPTY_FILTERS: CcFilters = { states: [], sla: [], owner: null }

export const CcContext = createContext<CcState | null>(null)

export function useCc(): CcState {
  const v = useContext(CcContext)
  if (!v) throw new Error('useCc outside the Command Center')
  return v
}
