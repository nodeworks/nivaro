import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

export interface O2MStagingCtx {
  getPendingRows: (relatedCollection: string, manyField: string) => Record<string, unknown>[]
  queueRow: (relatedCollection: string, manyField: string, data: Record<string, unknown>) => void
  removeRow: (relatedCollection: string, manyField: string, index: number) => void
  updateRow: (
    relatedCollection: string,
    manyField: string,
    index: number,
    data: Record<string, unknown>
  ) => void
  reorderRows: (
    relatedCollection: string,
    manyField: string,
    fromIdx: number,
    toIdx: number
  ) => void
  // Pending edits/deletes for existing rows (saveMode='pending')
  getPendingEdits: (
    relatedCollection: string,
    manyField: string
  ) => Map<string, Record<string, unknown>>
  getPendingDeletes: (relatedCollection: string, manyField: string) => Set<string>
  queueEdit: (
    relatedCollection: string,
    manyField: string,
    rowId: string,
    changes: Record<string, unknown>
  ) => void
  queueDelete: (relatedCollection: string, manyField: string, rowId: string) => void
  cancelPendingEdit: (relatedCollection: string, manyField: string, rowId: string) => void
  cancelPendingDelete: (relatedCollection: string, manyField: string, rowId: string) => void
}

export const O2MStagingContext = createContext<O2MStagingCtx | null>(null)

export function useO2MStaging() {
  return useContext(O2MStagingContext)
}

/**
 * Lets a grid publish the rows it is CURRENTLY showing (saved rows merged with
 * staged edits, deletes and new rows, with write-computed fields applied) so a
 * parent-level rollup can be recomputed live — see live-rollups.ts.
 *
 * Publishing rather than reading: the grid already owns this merge, and its
 * react-query key varies per grid (row filters are part of it), so reaching in
 * from outside would be guesswork. A grid that is not mounted publishes
 * nothing, and the rollup falls back to the stored value.
 */
export interface LiveRowsCtx {
  report: (
    relatedCollection: string,
    fkField: string,
    rows: Record<string, unknown>[] | null
  ) => void
  rows: Map<string, Record<string, unknown>[]>
}

export const LiveRowsContext = createContext<LiveRowsCtx | null>(null)

export function useLiveRows() {
  return useContext(LiveRowsContext)
}

/**
 * A self-contained LiveRowsContext value for a surface that hosts its OWN
 * grids — the addendum create sheet. Its grid must not publish into the record
 * form's context: the form's grid for the same relation is often mounted too
 * (the lines tab), and two grids alternating different row sets under one key
 * defeat the content-signature guard and re-set state until React gives up
 * ("Maximum update depth exceeded" the moment the sheet opens).
 */
export function useLocalLiveRows(): LiveRowsCtx {
  const [rows, setRows] = useState<Map<string, Record<string, unknown>[]>>(new Map())
  const sigRef = useRef(new Map<string, string>())
  const report = useCallback<LiveRowsCtx['report']>((relatedCollection, fkField, list) => {
    const key = `${relatedCollection}.${fkField}`
    if (list === null) {
      if (!sigRef.current.has(key)) return
      sigRef.current.delete(key)
      setRows((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
      return
    }
    // Content, not identity — a grid rebuilds its merged array every render.
    let sig = ''
    try {
      sig = JSON.stringify(list)
    } catch {
      sig = String(list.length)
    }
    if (sigRef.current.get(key) === sig) return
    sigRef.current.set(key, sig)
    setRows((prev) => new Map(prev).set(key, list))
  }, [])
  return useMemo(() => ({ rows, report }), [rows, report])
}

/**
 * Client-staged (unsaved) changes to a grid's GRANDCHILD relation rows
 * (unit allocations under workflow lines), published per grid and grouped by
 * grandchild collection — so a record-scoped widget (the Deployments rollup)
 * can reflect pending rows and queued allocation edits before the parent
 * record saves. Created rows may carry literal dotted keys
 * ('workflow_line.deployment_type') giving the parent-line context when the
 * line itself is unsaved.
 */
export interface StagedRelOps {
  created: Record<string, unknown>[]
  updated: Array<{ id: string | number; values: Record<string, unknown> }>
  deleted: Array<string | number>
}

export interface StagedRelationsCtx {
  report: (gridKey: string, byCollection: Record<string, StagedRelOps> | null) => void
  byGrid: Map<string, Record<string, StagedRelOps>>
}

export const StagedRelationsContext = createContext<StagedRelationsCtx | null>(null)

export function useStagedRelations() {
  return useContext(StagedRelationsContext)
}
