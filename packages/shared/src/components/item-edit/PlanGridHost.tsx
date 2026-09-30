import { createContext, type ReactNode, useContext } from 'react'

/**
 * What a host may put in place of a plan grid's generic parts (#842). Core
 * stays domain-free: a host that has a richer history for a collection (a
 * forecast history with restores and accuracy) renders it here; returning
 * null keeps the generic row-history sheet.
 */
export interface PlanGridRowHistoryArgs {
  /** The plan rows' collection ("forecasts"). */
  collection: string
  /** The record the grid belongs to. */
  parentId: string
  /** The saved row, when there is one. */
  rowId: string | null
  /** The row's key value ("2026"). */
  key: string
  /** The row's category id when the key is split by category, else null. */
  category: string | null
  categoryLabel: (id: string | number) => string
  onClose: () => void
}

export interface PlanGridHost {
  renderRowHistory?: (args: PlanGridRowHistoryArgs) => ReactNode | null
}

export const PlanGridHostContext = createContext<PlanGridHost | null>(null)

export function usePlanGridHost(): PlanGridHost | null {
  return useContext(PlanGridHostContext)
}
