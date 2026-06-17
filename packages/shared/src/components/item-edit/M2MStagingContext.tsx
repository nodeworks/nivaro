import { createContext, useContext } from 'react'

export interface M2MStagingCtx {
  getStagedLinks: (key: string) => unknown[]
  getStagedUnlinks: (key: string) => Set<unknown>
  stageLink: (key: string, relatedId: unknown) => void
  stageUnlink: (key: string, junctionId: unknown) => void
  unstageLink: (key: string, relatedId: unknown) => void
  unstageUnlink: (key: string, junctionId: unknown) => void
}

export const M2MStagingContext = createContext<M2MStagingCtx | null>(null)

export function useM2MStaging() {
  return useContext(M2MStagingContext)
}
