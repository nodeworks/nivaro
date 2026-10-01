import { createContext, type Dispatch, type SetStateAction, useContext } from 'react'
import type { TrafficModel } from './model'
import type { Filters, Selection, TrafficCatalog } from './types'

/**
 * Everything a plug-in feature (registry/*) needs from the page. `model` is mutable; `tick`
 * changes once per applied frame or snapshot — memoise model reads on it.
 */
export interface TrafficMapContextValue {
  model: TrafficModel
  filters: Filters
  setFilters: Dispatch<SetStateAction<Filters>>
  selection: Selection | null
  setSelection: Dispatch<SetStateAction<Selection | null>>
  catalog: TrafficCatalog | null
  tick: number
  /** filters.win, for convenience. */
  win: 60 | 300 | 900
  paused: boolean
  /** The first snapshot has loaded. */
  ready: boolean
}

export const TrafficMapContext = createContext<TrafficMapContextValue | null>(null)

export function useTrafficMap(): TrafficMapContextValue {
  const v = useContext(TrafficMapContext)
  if (!v) throw new Error('useTrafficMap() must be used inside the Traffic Map page')
  return v
}
