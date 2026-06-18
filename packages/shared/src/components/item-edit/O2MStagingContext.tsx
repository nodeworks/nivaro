import { createContext, useContext } from 'react'

export interface O2MStagingCtx {
  getPendingRows: (relatedCollection: string, manyField: string) => Record<string, unknown>[]
  queueRow: (relatedCollection: string, manyField: string, data: Record<string, unknown>) => void
  removeRow: (relatedCollection: string, manyField: string, index: number) => void
  updateRow: (relatedCollection: string, manyField: string, index: number, data: Record<string, unknown>) => void
  reorderRows: (relatedCollection: string, manyField: string, fromIdx: number, toIdx: number) => void
  // Pending edits/deletes for existing rows (saveMode='pending')
  getPendingEdits: (relatedCollection: string, manyField: string) => Map<string, Record<string, unknown>>
  getPendingDeletes: (relatedCollection: string, manyField: string) => Set<string>
  queueEdit: (relatedCollection: string, manyField: string, rowId: string, changes: Record<string, unknown>) => void
  queueDelete: (relatedCollection: string, manyField: string, rowId: string) => void
  cancelPendingEdit: (relatedCollection: string, manyField: string, rowId: string) => void
  cancelPendingDelete: (relatedCollection: string, manyField: string, rowId: string) => void
}

export const O2MStagingContext = createContext<O2MStagingCtx | null>(null)

export function useO2MStaging() {
  return useContext(O2MStagingContext)
}
