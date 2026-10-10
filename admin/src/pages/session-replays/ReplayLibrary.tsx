/**
 * Session Replays → Library (#1415): clips saved from the player, each a cut
 * of a recording kept past retention. Search by name, description or tag,
 * filter by tag, play a clip in place, delete it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Play, Search, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ReplayPlayer } from '@/components/replay-player'
import { CLIPS_QUERY_KEY } from '@/components/replay-player/RangeBar'
import { fmtSpan } from '@/components/replay-player/range'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

export interface ReplayClip {
  id: string
  name: string
  description: string | null
  tags: string[]
  recording: string
  source_recording: string | null
  from_ms: number
  to_ms: number
  duration_ms: number
  saved_by: string | null
  saved_by_name?: string | null
  user_name?: string | null
  created_at: string
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function ReplayLibrary() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const q = useDebounced(search.trim(), 250)

  const { data: clips = [], isLoading } = useQuery({
    queryKey: [CLIPS_QUERY_KEY, q, tag],
    queryFn: () => {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (tag) params.set('tag', tag)
      const qs = params.toString()
      return api
        .get<{ data: ReplayClip[] }>(`/session-replay-clips${qs ? `?${qs}` : ''}`)
        .then((r) => r.data.data)
    }
  })
  // Tag chips from the unfiltered library, so picking one does not hide the rest.
  const { data: all = [] } = useQuery({
    queryKey: [CLIPS_QUERY_KEY, '', null],
    queryFn: () => api.get<{ data: ReplayClip[] }>('/session-replay-clips').then((r) => r.data.data)
  })
  const tags = useMemo(() => [...new Set(all.flatMap((c) => c.tags))].sort(), [all])

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/session-replay-clips/${id}`),
    onSuccess: (_d, id) => {
      toast.success('Clip deleted')
      setConfirmDelete(null)
      if (playing === id) setPlaying(null)
      qc.invalidateQueries({ queryKey: [CLIPS_QUERY_KEY] })
    },
    onError: () => toast.error('Could not delete the clip')
  })

  return (
    <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <div className='relative w-72'>
          <Search className='pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400' />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search clips by name, description or tag'
            aria-label='Search clips'
            className='h-8 pl-8 text-[12.5px]'
          />
        </div>
        {tags.map((t) => (
          <button
            key={t}
            type='button'
            onClick={() => setTag(tag === t ? null : t)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11.5px]',
              tag === t
                ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border'
            )}
          >
            #{t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className='text-[12px] text-slate-400'>Loading…</p>
      ) : clips.length === 0 ? (
        <div className='max-w-md py-10'>
          <Library className='h-8 w-8 text-slate-300' />
          <p className='mt-3 text-[13px] text-slate-500'>
            {q || tag
              ? 'No clips match.'
              : 'No clips yet. Select a range under a replay’s timeline and choose Save clip — saved clips stay here after their recording expires.'}
          </p>
        </div>
      ) : (
        <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          {clips.map((c, i) => (
            <div
              key={c.id}
              className={cn(i > 0 && 'border-t border-slate-100 dark:border-border/50')}
            >
              <div className='group flex items-start gap-3 px-4 py-2.5'>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-baseline gap-2'>
                    <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                      {c.name}
                    </span>
                    <span className='text-[11.5px] tabular-nums text-slate-500'>
                      {fmtSpan(c.duration_ms)}
                    </span>
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className='rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-500 dark:bg-muted'
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                  {c.description && (
                    <p className='mt-0.5 text-[12px] text-slate-500'>{c.description}</p>
                  )}
                  <p className='mt-0.5 text-[11px] text-slate-400'>
                    {c.user_name ? `${c.user_name}’s session · ` : ''}saved{' '}
                    {c.saved_by_name ? `by ${c.saved_by_name} ` : ''}
                    {formatRelative(c.created_at)}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 gap-1.5 text-[12px]'
                  onClick={() => setPlaying(playing === c.id ? null : c.id)}
                >
                  {playing === c.id ? (
                    <>
                      <Square className='h-3 w-3' /> Close
                    </>
                  ) : (
                    <>
                      <Play className='h-3 w-3' /> Play
                    </>
                  )}
                </Button>
                {confirmDelete === c.id ? (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-[11.5px] text-red-500 hover:border-red-200 hover:bg-red-50'
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  >
                    Confirm
                  </Button>
                ) : (
                  <button
                    type='button'
                    aria-label={`Delete clip ${c.name}`}
                    className='p-1.5 text-slate-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 focus:opacity-100'
                    onClick={() => setConfirmDelete(c.id)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
              {playing === c.id && (
                <div className='px-4 pb-4'>
                  <ReplayPlayer recordingId={c.recording} minHeight={320} panel='stacked' />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
