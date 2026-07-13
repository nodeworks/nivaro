import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Crown, GitMerge, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Record merge wizard — side-by-side duplicate resolution. Pick the survivor,
 * then per-field which record's value it keeps. Inbound references (FKs, M2M
 * junction rows) repoint to the survivor server-side; losers land in trash.
 */

interface MergePreview {
  records: Array<Record<string, unknown>>
  fields: string[]
  reference_counts: Record<string, number>
  relations: number
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function MergeSheet({
  collection,
  ids,
  open,
  onOpenChange,
  onMerged
}: {
  collection: string
  ids: string[]
  open: boolean
  onOpenChange: (v: boolean) => void
  onMerged: () => void
}) {
  const queryClient = useQueryClient()
  const [survivor, setSurvivor] = useState<string | null>(null)
  // field → record id whose value wins (absent = survivor's own)
  const [choices, setChoices] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['merge-preview', collection, ids.join(',')],
    queryFn: () =>
      api
        .get<{ data: MergePreview }>('/merge/preview', {
          params: { collection, ids: ids.join(',') }
        })
        .then((r) => r.data.data),
    enabled: open && ids.length >= 2
  })

  useEffect(() => {
    if (open) {
      setSurvivor(null)
      setChoices({})
    }
  }, [open])

  // Default survivor: most-referenced record, else first
  useEffect(() => {
    if (!data || survivor) return
    const best = [...ids].sort(
      (a, b) => (data.reference_counts[b] ?? 0) - (data.reference_counts[a] ?? 0)
    )[0]
    setSurvivor(best)
  }, [data, survivor, ids])

  const records = data?.records ?? []
  const recordById = useMemo(() => new Map(records.map((r) => [String(r.id), r])), [records])

  // Only fields where values actually differ need a decision
  const conflictFields = useMemo(() => {
    if (!data) return []
    return data.fields.filter((f) => {
      const values = new Set(records.map((r) => cellText(r[f])))
      return values.size > 1
    })
  }, [data, records])

  const merge = useMutation({
    mutationFn: () => {
      const fieldChoices: Record<string, unknown> = {}
      for (const [field, fromId] of Object.entries(choices)) {
        if (fromId !== survivor) fieldChoices[field] = recordById.get(fromId)?.[field] ?? null
      }
      return api.post('/merge/', {
        collection,
        survivor_id: survivor,
        loser_ids: ids.filter((id) => id !== survivor),
        field_choices: fieldChoices
      })
    },
    onSuccess: (r) => {
      const d = (r.data as { data: { repointed: number; merged: string[] } }).data
      toast.success(
        `Merged ${d.merged.length} record${d.merged.length === 1 ? '' : 's'} — ${d.repointed} reference${d.repointed === 1 ? '' : 's'} repointed`
      )
      queryClient.invalidateQueries({ queryKey: ['items', collection] })
      onMerged()
      onOpenChange(false)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Merge failed')
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='w-[760px] overflow-y-auto sm:max-w-[760px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <GitMerge className='h-4 w-4 text-nvr-cyan' /> Merge {ids.length} records
          </SheetTitle>
        </SheetHeader>

        {isLoading || !data ? (
          <p className='mt-10 text-center text-[13px] text-slate-400'>Loading preview…</p>
        ) : (
          <div className='mt-4'>
            <p className='mb-3 text-[12px] text-slate-400'>
              Pick the surviving record, then choose which value wins for each differing field.
              Losers move to Trash; their{' '}
              {data.relations > 0 ? 'inbound references repoint' : 'ids retire'}.
            </p>

            {/* Survivor row */}
            <div
              className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
              style={{ gridTemplateColumns: `140px repeat(${ids.length}, 1fr)` }}
            >
              <div className='bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:bg-card'>
                Survivor
              </div>
              {ids.map((id) => (
                <button
                  key={id}
                  type='button'
                  onClick={() => setSurvivor(id)}
                  className={cn(
                    'flex items-center gap-1.5 bg-white px-3 py-2 text-left text-[12px] dark:bg-card',
                    survivor === id
                      ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:bg-slate-50'
                  )}
                >
                  {survivor === id && <Crown className='h-3.5 w-3.5 text-amber-500' />}#{id}
                  <span className='ml-auto text-[10.5px] font-normal text-slate-400'>
                    {data.reference_counts[id] ?? 0} refs
                  </span>
                </button>
              ))}

              {/* Field rows — conflicts only */}
              {conflictFields.map((f) => (
                <FieldRow
                  key={f}
                  field={f}
                  ids={ids}
                  recordById={recordById}
                  chosen={choices[f] ?? survivor ?? ids[0]}
                  onChoose={(fromId) => setChoices((prev) => ({ ...prev, [f]: fromId }))}
                />
              ))}
            </div>

            {conflictFields.length === 0 && (
              <p className='mt-3 text-[12px] text-slate-400'>
                No differing fields — records are identical apart from ids.
              </p>
            )}

            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='outline' size='sm' onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                size='sm'
                disabled={!survivor || merge.isPending}
                onClick={() => merge.mutate()}
                className='gap-1.5'
              >
                {merge.isPending ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <GitMerge className='h-3.5 w-3.5' />
                )}
                Merge into #{survivor}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function FieldRow({
  field,
  ids,
  recordById,
  chosen,
  onChoose
}: {
  field: string
  ids: string[]
  recordById: Map<string, Record<string, unknown>>
  chosen: string
  onChoose: (id: string) => void
}) {
  return (
    <>
      <div className='bg-slate-50 px-3 py-2 font-mono text-[11.5px] text-slate-500 dark:bg-card'>
        {field}
      </div>
      {ids.map((id) => {
        const value = cellText(recordById.get(id)?.[field])
        return (
          <button
            key={id}
            type='button'
            onClick={() => onChoose(id)}
            className={cn(
              'break-all bg-white px-3 py-2 text-left text-[12px] dark:bg-card',
              chosen === id
                ? 'bg-accent font-medium text-nvr-navy dark:bg-accent dark:text-nvr-cyan'
                : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-muted'
            )}
          >
            {value === '' ? <span className='italic text-slate-300'>empty</span> : value}
          </button>
        )
      })}
    </>
  )
}
