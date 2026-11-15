import { queryKeys, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'

/**
 * "Allow merging" for one collection (merge records, 2026-11-14) —
 * `browser_config.merge_records.mode`. On by default for every collection, on its own
 * (independent of the duplicate warning); turning it off stores `mode: 'off'`, turning it
 * back on removes the key. The server reads the same rule (services/record-merge/rules.ts
 * mergeSettingOf).
 */

interface CollectionMeta {
  browser_config:
    | (Record<string, unknown> & {
        merge_records?: { mode?: 'on' | 'off' }
      })
    | null
}

export function MergeRecordsSetting({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: col } = useQuery({
    queryKey: queryKeys.collectionMeta(tableName),
    queryFn: () =>
      api.get<{ data: CollectionMeta }>(`/collections/${tableName}`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })
  const bc = col?.browser_config ?? {}
  const on = bc.merge_records?.mode !== 'off'

  const save = useMutation({
    mutationFn: async (mode: 'off' | null) => {
      const next = { ...(col?.browser_config ?? {}) } as Record<string, unknown>
      if (mode) next.merge_records = { mode }
      else delete next.merge_records
      await api.patch(`/collections/${tableName}`, {
        browser_config: Object.keys(next).length ? next : null
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.collectionMeta(tableName) })
      void qc.invalidateQueries({ queryKey: ['record-merge-allowed', tableName] })
      toast.success('Merging setting saved')
    },
    onError: (e) => toastError(e, 'Could not save the merging setting')
  })

  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-merge-records-setting
    >
      <div className='flex items-start justify-between gap-4 px-4 py-3'>
        <div className='min-w-0'>
          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            Allow merging
          </p>
          <p className='mt-0.5 max-w-[72ch] text-[12px] leading-relaxed text-slate-500 dark:text-slate-400'>
            People who may change and delete these records can merge duplicates: pick each value
            from any record, keep one and send the others to the trash (restorable, with an undo for
            24 hours). Offered from a list selection, a record’s ⋯ menu and the duplicate warning.
          </p>
          <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
            On by default. Turn it off where these records must never be merged.
          </p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={(v) => save.mutate(v ? null : 'off')}
          disabled={save.isPending || col === undefined}
          aria-label='Allow merging'
          data-merge-records-toggle
        />
      </div>
    </div>
  )
}
