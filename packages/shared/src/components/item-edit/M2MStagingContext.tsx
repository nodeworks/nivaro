import { createContext, useContext } from 'react'

export interface M2MStagingCtx {
  getStagedLinks: (key: string) => unknown[]
  getStagedUnlinks: (key: string) => Set<unknown>
  stageLink: (key: string, relatedId: unknown) => void
  stageUnlink: (key: string, junctionId: unknown) => void
  unstageLink: (key: string, relatedId: unknown) => void
  unstageUnlink: (key: string, junctionId: unknown) => void
  /** Which field an auto-filled parent value was DERIVED from (upstream
   *  cascades / cross-record defaults). A cascade rule whose parent was
   *  derived from the rule's own field must not narrow that field's options —
   *  otherwise picking a region locks the region picker into the zone the
   *  pick itself filled. */
  getDerivedOrigin?: (parentField: string) => string | null
}

export const M2MStagingContext = createContext<M2MStagingCtx | null>(null)

export function useM2MStaging() {
  return useContext(M2MStagingContext)
}
