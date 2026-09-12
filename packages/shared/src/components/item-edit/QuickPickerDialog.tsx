import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { QuickPicker } from './QuickPicker'
import type { ActiveLayoutData, CMSField, CMSRelation } from './types'

/**
 * The quick picker BEFORE a record exists — the "+ New" menus open it, and on
 * Create the host navigates to the new-record page with the picks in
 * `?prefill=` (scalars) plus `__links` (M2M ids keyed by staging key, the key
 * ItemEditForm's initialLinks resolves). Reads the layout's `quick_picker`
 * steps itself, so hosts only need the collection (and optional layout slug).
 */

export function useQuickPickerSteps(
  collection: string | null | undefined,
  layoutSlug?: string | null
): { steps: string[]; layoutId: number | null; loading: boolean } {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery<ActiveLayoutData | null>({
    queryKey: ['active-layout', collection ?? '', layoutSlug ?? null, 'new'],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get('/collection-layouts/active', {
            collection: collection as string,
            ...(layoutSlug ? { slug: layoutSlug } : {})
          })
        )
        .then((r) => r.data)
        .catch(() => null),
    enabled: !!collection,
    staleTime: 60_000
  })
  const steps = useMemo(() => {
    const raw = data?.layout?.quick_picker
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  }, [data])
  return { steps, layoutId: data?.layout?.id ?? null, loading: isLoading }
}

export interface QuickPickerDialogProps {
  collection: string
  layoutSlug?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the picks: scalar values + `__links` (staging key → ids). */
  onDone: (prefill: Record<string, unknown>) => void
  /** Noun for the title + button ("workflow"). */
  noun?: string
  /**
   * Element to anchor beside (the "+ New" button). With an anchor the picker
   * is a compact popover next to it; without one it falls back to a dialog.
   */
  anchorEl?: HTMLElement | null
}

export function QuickPickerDialog({
  collection,
  layoutSlug,
  open,
  onOpenChange,
  onDone,
  noun = 'record',
  anchorEl
}: QuickPickerDialogProps) {
  const client = useNivaroClient()
  const { steps, layoutId } = useQuickPickerSteps(open ? collection : null, layoutSlug)
  const { data: fieldConfig = [] } = useQuery<CMSField[]>({
    queryKey: ['field-config', collection, layoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(`/field-config/${collection}`, layoutId ? { layout_id: String(layoutId) } : {})
        )
        .then((r) => r.data ?? []),
    enabled: open && !!collection,
    staleTime: 60_000
  })
  const { data: relations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['relations-for', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    enabled: open && !!collection,
    staleTime: 300_000
  })
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [links, setLinks] = useState<Record<string, string[]>>({})

  const fieldLabels = useMemo(
    () => Object.fromEntries(fieldConfig.map((f) => [f.field, f.label || titleCase(f.field)])),
    [fieldConfig]
  )
  const fieldOptionFilters = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const f of fieldConfig) {
      try {
        const o = typeof f.options === 'string' ? JSON.parse(f.options) : f.options
        if (o?.option_filter && typeof o.option_filter === 'object') out[f.field] = o.option_filter
      } catch {
        /* ignore */
      }
    }
    return out
  }, [fieldConfig])
  const stagingKeyFor = useCallback(
    (field: string): string => {
      const r = relations.find(
        (rel) => rel.one_collection === collection && rel.one_field === field
      )
      if (!r) return field
      const jf =
        r.junction_field ??
        relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id)?.many_field
      return r.one_field ?? `${r.many_collection}.${jf ?? ''}`
    },
    [relations, collection]
  )
  const getM2M = useCallback((field: string) => links[field] ?? [], [links])

  const reset = () => {
    setDraft({})
    setLinks({})
  }
  const finish = () => {
    const linkPayload: Record<string, string[]> = {}
    for (const [field, ids] of Object.entries(links))
      if (ids.length) linkPayload[stagingKeyFor(field)] = ids
    onDone({ ...draft, ...(Object.keys(linkPayload).length ? { __links: linkPayload } : {}) })
    reset()
  }

  const body = (
    <>
      {steps.length > 0 && fieldConfig.length > 0 && relations.length > 0 && (
        <QuickPicker
          collection={collection}
          itemId='new'
          steps={steps}
          fieldConfig={fieldConfig}
          relations={relations}
          draft={draft}
          getM2M={getM2M}
          onChange={(field, value) => setDraft((d) => ({ ...d, [field]: value }))}
          onM2MChange={(field, ids) => setLinks((l) => ({ ...l, [field]: ids }))}
          fieldLabels={fieldLabels}
          fieldOptionFilters={fieldOptionFilters}
          onFinish={finish}
          finishLabel={`Create ${noun}`}
        />
      )}
    </>
  )
  const handleOpenChange = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }

  if (anchorEl) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverAnchor virtualRef={{ current: anchorEl }} />
        <PopoverContent
          align='end'
          sideOffset={6}
          className='w-[440px] max-w-[calc(100vw-24px)] p-3'
          data-quick-picker-dialog
        >
          <p className='mb-2 text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            New {noun}
          </p>
          {body}
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='max-w-[540px]' data-quick-picker-dialog>
        <DialogHeader>
          <DialogTitle className='text-[15px]'>New {noun}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
