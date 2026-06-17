import { createContext, useContext } from 'react'

export interface O2MStagingCtx {
  getPendingRows: (relatedCollection: string, manyField: string) => Record<string, unknown>[]
  queueRow: (relatedCollection: string, manyField: string, data: Record<string, unknown>) => void
  removeRow: (relatedCollection: string, manyField: string, index: number) => void
}

export const O2MStagingContext = createContext<O2MStagingCtx | null>(null)

export function useO2MStaging() {
  return useContext(O2MStagingContext)
}
