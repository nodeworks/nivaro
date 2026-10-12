import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitMerge, Scissors, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** Mirrors the API's IssueGroup (services/issue-groups.ts). */
export interface IssueGroup {
  lead: { id: number; title: string; severity: string; occurrences: number }
  total_occurrences: number
  variants: Array<{
    id: number
    title: string
    severity: string
    occurrences: number
    similarity: number
    manual?: boolean
  }>
  adjusted?: boolean
}

const SEV_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  error: 'bg-orange-500',
  warning: 'bg-amber-400',
  info: 'bg-sky-400'
}

/**
 * Open issues clustered by meaning (#1861): ten variants of one bug read as one problem with
 * the variants underneath. Admins correct the clustering: split a variant (or a lead) out to
 * stand alone, or tick groups and merge them into the first one ticked. Corrections persist
 * on the server and apply on top of every later re-clustering.
 */
export function IssueGroupsView({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<number[]>([]) // lead ids, in tick order
  const { data, isLoading, isError } = useQuery<IssueGroup[]>({
    queryKey: ['issue-groups'],
    queryFn: () => api.get('/ai-explain/issue-groups').then((r) => r.data.data),
    staleTime: 60_000
  })
  const adjust = useMutation({
    mutationFn: (body: { op: string; ids?: number[]; into?: number }) =>
      api.post('/ai-explain/issue-groups/overrides', body).then((r) => r.data.data as IssueGroup[]),
    onSuccess: (groups) => {
      qc.setQueryData(['issue-groups'], groups)
      setPicked([])
    },
    onError: () => toast.error('Could not change the grouping')
  })
  const groups = data ?? []
  const multi = groups.filter((g) => g.variants.length > 0)

  const mergePicked = () => {
    const [into, ...rest] = picked
    const ids = rest.flatMap((lead) => {
      const g = groups.find((x) => x.lead.id === lead)
      return g ? [g.lead.id, ...g.variants.map((v) => v.id)] : []
    })
    if (into != null && ids.length > 0) adjust.mutate({ op: 'merge', ids, into })
  }

  if (isLoading) {
    return (
      <div className='space-y-2 p-6'>
        {[1, 2, 3].map((i) => (
          <div key={i} className='h-14 animate-pulse rounded-lg bg-muted' />
        ))}
      </div>
    )
  }
  if (isError) {
    return (
      <p className='p-6 text-[12px] text-muted-foreground'>
        Issues could not be grouped right now. The list view still works.
      </p>
    )
  }
  return (
    <div className='space-y-3 p-6' data-issue-groups=''>
      <div className='flex flex-wrap items-center gap-3'>
        <p className='text-[12px] text-muted-foreground'>
          {groups.length} problem{groups.length === 1 ? '' : 's'} from{' '}
          {groups.reduce((n, g) => n + 1 + g.variants.length, 0)} open issues
          {multi.length > 0 && <> · {multi.length} with variants</>}. Grouping is by meaning, so a
          wrong call is yours to fix.
        </p>
        <span className='ml-auto flex items-center gap-2'>
          {picked.length > 1 && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-[12px]'
              disabled={adjust.isPending}
              onClick={mergePicked}
            >
              <GitMerge className='mr-1 h-3 w-3' /> Merge {picked.length} groups into the first
            </Button>
          )}
          {groups.some((g) => g.adjusted) && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ op: 'reset' })}
            >
              <Undo2 className='mr-1 h-3 w-3' /> Reset my changes
            </Button>
          )}
        </span>
      </div>
      {groups.length === 0 && (
        <p className='py-16 text-center text-[12px] text-muted-foreground'>No open issues.</p>
      )}
      {groups.map((g) => (
        <div
          key={g.lead.id}
          data-issue-group={g.lead.id}
          className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        >
          <div className='flex items-start gap-3 px-3 py-2.5'>
            <input
              type='checkbox'
              aria-label={`Select group ${g.lead.title}`}
              className='mt-1 h-3.5 w-3.5'
              checked={picked.includes(g.lead.id)}
              onChange={(e) =>
                setPicked((p) =>
                  e.target.checked ? [...p, g.lead.id] : p.filter((x) => x !== g.lead.id)
                )
              }
            />
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[g.lead.severity] ?? 'bg-slate-300'}`}
              title={g.lead.severity}
            />
            <div className='min-w-0 flex-1'>
              <button
                type='button'
                className='block max-w-full truncate text-left text-[13px] font-medium hover:underline'
                onClick={() => onOpen(g.lead.id)}
              >
                {g.lead.title}
              </button>
              <p className='text-[11px] text-muted-foreground'>
                {g.total_occurrences} occurrence{g.total_occurrences === 1 ? '' : 's'}
                {g.variants.length > 0 && (
                  <>
                    {' '}
                    · {g.variants.length} variant{g.variants.length === 1 ? '' : 's'}
                  </>
                )}
                {g.adjusted && <> · adjusted by an admin</>}
              </p>
            </div>
            {g.variants.length > 0 && (
              <Button
                size='sm'
                variant='ghost'
                className='h-7 text-[11.5px]'
                disabled={adjust.isPending}
                title='Make every issue in this group stand alone'
                onClick={() =>
                  adjust.mutate({ op: 'split', ids: [g.lead.id, ...g.variants.map((v) => v.id)] })
                }
              >
                <Scissors className='mr-1 h-3 w-3' /> Split all
              </Button>
            )}
          </div>
          {g.variants.length > 0 && (
            <ul className='border-t border-slate-100 dark:border-border/60'>
              {g.variants.map((v) => (
                <li
                  key={v.id}
                  className='flex items-center gap-3 px-3 py-1.5 pl-12 text-[12px] hover:bg-slate-50 dark:hover:bg-muted/40'
                >
                  <button
                    type='button'
                    className='min-w-0 flex-1 truncate text-left hover:underline'
                    onClick={() => onOpen(v.id)}
                  >
                    {v.title}
                  </button>
                  <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>
                    {v.occurrences}x
                    {v.manual ? ' · moved here' : ` · ${Math.round(v.similarity * 100)}% alike`}
                  </span>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-2 text-[11px]'
                    disabled={adjust.isPending}
                    onClick={() => adjust.mutate({ op: 'split', ids: [v.id] })}
                  >
                    <Scissors className='mr-1 h-3 w-3' /> Split out
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
