import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { queryKeys } from '../../lib/query-keys'
import { useUnsavedWork } from '../../lib/unsaved-work'
import {
  cleanQuickFilters,
  mergeQuickFilters,
  type QuickFilterDef,
  quickFilterProblems,
  quickFiltersEqual
} from './config'

export interface DraftFilter {
  /** Local identity for drag, focus and the open popover — never stored. */
  id: string
  def: QuickFilterDef
  /** Added in this edit: its key follows its name. */
  isNew: boolean
}

export type QuickFilterSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

let seq = 0
const nextId = () => `qf${++seq}`

type MetaShape = { browser_config?: Record<string, unknown> | null } & Record<string, unknown>

/**
 * The list's in-place quick-filter editing: a draft of the bar, saved through
 * the SAME admin route Data model → Settings uses (`PATCH /collections/:c`
 * with the whole browser_config — so the save re-reads the stored config and
 * replaces only `quick_filters`, keeping every other setting).
 *
 * Optimistic: the bar shows the saved filters at once; a refused save puts the
 * old bar back, reopens the editor on the same draft and keeps the error.
 */
export function useQuickFilterEditing({
  collection,
  filters,
  onApplied
}: {
  collection: string
  /** The bar as it is now (what Cancel goes back to). */
  filters: QuickFilterDef[]
  /** Runs when the new bar shows (optimistically). Returns an undo for a refused save. */
  onApplied?: (next: QuickFilterDef[], prev: QuickFilterDef[]) => (() => void) | undefined
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DraftFilter[]>([])
  const [status, setStatus] = useState<QuickFilterSaveStatus>('idle')
  const [error, setError] = useState<unknown>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const original = useRef<QuickFilterDef[]>([])
  const savedTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
    },
    []
  )

  const defs = draft.map((d) => d.def)
  const dirty = editing && !quickFiltersEqual(defs, original.current)
  const problemCount = draft.filter((d) => quickFilterProblems(d.def, defs).length > 0).length
  useUnsavedWork(dirty, 'Quick filter changes')

  const start = useCallback(
    (opts: { adding?: boolean } = {}) => {
      original.current = filters
      setDraft(filters.map((def) => ({ id: nextId(), def: { ...def }, isNew: false })))
      setEditing(true)
      setError(null)
      setStatus('idle')
      setOpenId(null)
      setAdding(!!opts.adding || filters.length === 0)
    },
    [filters]
  )

  const cancel = useCallback(() => {
    setEditing(false)
    setError(null)
    setOpenId(null)
    setAdding(false)
    if (status === 'error') setStatus('idle')
  }, [status])

  const add = (def: QuickFilterDef) => {
    const id = nextId()
    setDraft((d) => [...d, { id, def, isNew: true }])
    setAdding(false)
    setOpenId(id)
  }
  const update = (id: string, partial: Partial<QuickFilterDef>) =>
    setDraft((d) =>
      d.map((x) => {
        if (x.id !== id) return x
        const def = { ...x.def, ...partial }
        // `undefined` means "leave it out" — a stored key never holds undefined.
        for (const k of Object.keys(partial) as Array<keyof QuickFilterDef>)
          if (partial[k] === undefined) delete def[k]
        return { ...x, def }
      })
    )
  const remove = (id: string) => {
    setDraft((d) => d.filter((x) => x.id !== id))
    if (openId === id) setOpenId(null)
  }
  const move = (id: string, by: number) =>
    setDraft((d) => {
      const i = d.findIndex((x) => x.id === id)
      const j = i + by
      if (i < 0 || j < 0 || j >= d.length) return d
      const next = [...d]
      const [row] = next.splice(i, 1)
      next.splice(j, 0, row)
      return next
    })
  const reorder = (fromId: string, toId: string) =>
    setDraft((d) => {
      const i = d.findIndex((x) => x.id === fromId)
      const j = d.findIndex((x) => x.id === toId)
      if (i < 0 || j < 0 || i === j) return d
      const next = [...d]
      const [row] = next.splice(i, 1)
      next.splice(j, 0, row)
      return next
    })

  const save = useCallback(async () => {
    const next = cleanQuickFilters(draft.map((d) => d.def))
    const prev = original.current
    const key = ['cbv-collection-meta', collection]
    const before = qc.getQueryData<MetaShape>(key)
    qc.setQueryData<MetaShape | undefined>(key, (old) =>
      old ? { ...old, browser_config: mergeQuickFilters(old.browser_config, next) } : old
    )
    setEditing(false)
    setOpenId(null)
    setAdding(false)
    setError(null)
    setStatus('saving')
    if (savedTimer.current) window.clearTimeout(savedTimer.current)
    const undo = onApplied?.(next, prev)
    try {
      // The route stores browser_config whole: start from what is stored NOW,
      // not from this tab's copy, so a setting changed elsewhere survives.
      const fresh = await client.request<{ data: MetaShape }>(get(`/collections/${collection}`))
      const browserConfig = mergeQuickFilters(fresh.data?.browser_config ?? null, next)
      await client.request(patch(`/collections/${collection}`, { browser_config: browserConfig }))
      original.current = next
      qc.setQueryData<MetaShape>(key, {
        ...(fresh.data ?? before ?? {}),
        browser_config: browserConfig
      })
      // Data model → Settings reads the same row under its own key.
      void qc.invalidateQueries({ queryKey: queryKeys.collectionMeta(collection) })
      setStatus('saved')
      savedTimer.current = window.setTimeout(() => setStatus('idle'), 3000)
    } catch (err) {
      qc.setQueryData(key, before)
      undo?.()
      setEditing(true)
      setStatus('error')
      setError(err)
    }
  }, [client, collection, draft, onApplied, qc])

  return {
    editing,
    draft,
    defs,
    dirty,
    problemCount,
    status,
    error,
    openId,
    setOpenId,
    adding,
    setAdding,
    start,
    cancel,
    add,
    update,
    remove,
    move,
    reorder,
    save
  }
}

export type QuickFilterEditing = ReturnType<typeof useQuickFilterEditing>
