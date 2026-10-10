import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Frown, Play, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  COMPONENT_LABELS,
  componentChips,
  FRUSTRATION_COMPONENTS,
  type FrustrationComponents,
  type Weights
} from './frustrationLogic'
import { lastDays } from './heatLogic'

/**
 * Worst sessions tab (#1388): the working sessions with the highest
 * frustration score in a date range — who, where they spent the time, what
 * made the score, and the recording when one overlaps. Scored nightly.
 */

interface WorstRow {
  session_id: string
  user: string
  user_name: string | null
  day: string
  session_start: string | null
  session_end: string | null
  score: number
  components: FrustrationComponents
  top_route: string | null
  recording_id: string | null
}

const BASE = '/session-replay-insights'

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'
const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
function minutes(a: string | null, b: string | null): string {
  if (!a || !b) return ''
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60_000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export function WorstSessionsTab({
  onWatch
}: {
  /** Opens the player on that recording, at the session's start. */
  onWatch: (recordingId: string, sessionStart: string | null) => void
}) {
  const [range, setRange] = useState(() => lastDays(7))
  const [showWeights, setShowWeights] = useState(false)
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['replay-worst-sessions', range.from, range.to],
    queryFn: () =>
      api
        .get<{ data: WorstRow[] }>(`${BASE}/worst`, { params: { ...range, limit: 100 } })
        .then((r) => r.data.data)
  })

  return (
    <div
      className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'
      data-testid='replay-worst'
    >
      <div className='mb-3 flex flex-wrap items-center gap-2'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Worst sessions
        </h2>
        <span className='text-[12px] text-slate-400'>
          Scored nightly from rage and dead clicks, client errors, back-and-forth, slow calls and
          abandoned forms
        </span>
        <div className='ml-auto flex items-center gap-1.5 text-[11.5px] text-slate-500'>
          <input
            type='date'
            aria-label='From'
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
            className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
          />
          –
          <input
            type='date'
            aria-label='To'
            value={range.to}
            min={range.from}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
            className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
          />
          <Button
            size='sm'
            variant='outline'
            className='h-7 gap-1.5 text-[12px]'
            aria-expanded={showWeights}
            onClick={() => setShowWeights((v) => !v)}
          >
            <SlidersHorizontal className='h-3 w-3' /> Weights
          </Button>
        </div>
      </div>

      {showWeights && <WeightsEditor />}

      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {isLoading ? (
          <p className='p-4 text-[12px] text-slate-400'>Loading…</p>
        ) : rows.length === 0 ? (
          <div className='p-8 text-center text-slate-400'>
            <Frown className='mx-auto h-6 w-6 opacity-40' />
            <p className='mt-2 text-[12px]'>No frustrated sessions in this range.</p>
          </div>
        ) : (
          <table className='w-full text-left text-[12px]'>
            <thead className='border-b border-slate-100 text-[10.5px] uppercase tracking-wider text-slate-400 dark:border-border/50'>
              <tr>
                <th className='px-4 py-2 font-semibold'>Score</th>
                <th className='px-2 py-2 font-semibold'>Person</th>
                <th className='px-2 py-2 font-semibold'>When</th>
                <th className='px-2 py-2 font-semibold'>Top route</th>
                <th className='px-2 py-2 font-semibold'>What happened</th>
                <th className='px-4 py-2 font-semibold'>
                  <span className='sr-only'>Replay</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.session_id} ${r.day}`}
                  className='border-t border-slate-100 align-top dark:border-border/50'
                >
                  <td className='px-4 py-2'>
                    <div className='flex items-center gap-2'>
                      <span className='w-7 text-right font-semibold tabular-nums text-slate-800 dark:text-foreground'>
                        {r.score}
                      </span>
                      <span
                        className='relative h-1.5 w-16 rounded-full bg-slate-100 dark:bg-muted'
                        aria-hidden
                      >
                        <span
                          className='absolute inset-y-0 left-0 rounded-full bg-rose-500/80'
                          style={{ width: `${r.score}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className='px-2 py-2'>
                    <Link
                      to={`/users/${encodeURIComponent(r.user)}`}
                      className='font-medium text-slate-800 hover:underline dark:text-foreground'
                    >
                      {r.user_name || r.user.slice(0, 8)}
                    </Link>
                  </td>
                  <td className='whitespace-nowrap px-2 py-2 tabular-nums text-slate-500'>
                    {dateLabel(r.session_start)} {clock(r.session_start)}
                    <span className='block text-[10.5px] text-slate-400'>
                      {minutes(r.session_start, r.session_end)}
                    </span>
                  </td>
                  <td className='max-w-[220px] truncate px-2 py-2 font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
                    <span title={r.top_route ?? ''}>{r.top_route ?? '—'}</span>
                  </td>
                  <td className='px-2 py-2'>
                    <div className='flex flex-wrap gap-1'>
                      {componentChips(r.components).map((c) => (
                        <span
                          key={c.key}
                          title={`${c.hint} · ${c.points} point${c.points === 1 ? '' : 's'}`}
                          className='rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-600 dark:border-border dark:text-slate-300'
                        >
                          {c.text}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className='px-4 py-2 text-right'>
                    {r.recording_id ? (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 gap-1.5 text-[12px]'
                        onClick={() => onWatch(r.recording_id as string, r.session_start)}
                      >
                        <Play className='h-3 w-3' /> Watch
                      </Button>
                    ) : (
                      <span className='text-[11px] text-slate-300 dark:text-slate-500'>
                        no recording
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className='mt-3 text-[11px] text-slate-400'>
        A session is one browser tab's run of admin pages on one day. Scores add each signal's
        weight and level off toward 100; hover a chip for what it counts. Admin-only.
      </p>
    </div>
  )
}

function WeightsEditor() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['frustration-weights'],
    queryFn: () =>
      api
        .get<{ data: { weights: Weights; defaults: Weights } }>(`${BASE}/frustration-weights`)
        .then((r) => r.data.data)
  })
  const [draft, setDraft] = useState<Partial<Record<keyof Weights, string>>>({})
  const save = useMutation({
    mutationFn: (weights: Weights | null) => api.put(`${BASE}/frustration-weights`, { weights }),
    onSuccess: () => {
      toast.success('Weights saved — they apply from the next nightly scoring')
      setDraft({})
      qc.invalidateQueries({ queryKey: ['frustration-weights'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Could not save the weights')
  })
  if (!data) return null
  const keys = [...FRUSTRATION_COMPONENTS, 'scale'] as Array<keyof Weights>
  const value = (k: keyof Weights) => draft[k] ?? String(data.weights[k])
  return (
    <section className='mb-4 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <div className='grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-7'>
        {keys.map((k) => (
          <label key={k} className='text-[11px] text-slate-500'>
            <span
              className='block truncate'
              title={k === 'scale' ? undefined : COMPONENT_LABELS[k].hint}
            >
              {k === 'scale' ? 'Scale' : COMPONENT_LABELS[k].many}
            </span>
            <input
              type='number'
              min={k === 'scale' ? 1 : 0}
              max={k === 'scale' ? 1000 : 100}
              step='0.5'
              value={value(k)}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              className={cn(
                'mt-0.5 h-7 w-full rounded-md border border-slate-200 bg-white px-1.5 text-[12px] tabular-nums dark:border-border dark:bg-card',
                draft[k] != null && 'border-nvr-cyan'
              )}
            />
            <span className='text-[10px] text-slate-400'>default {data.defaults[k]}</span>
          </label>
        ))}
      </div>
      <div className='mt-2 flex items-center gap-2'>
        <p className='mr-auto text-[11px] text-slate-400'>
          Each signal adds its weight (at most 10 of a kind); the score is 100 × (1 − e^(−sum ÷
          scale)). A weight of 0 turns a signal off.
        </p>
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          disabled={save.isPending}
          onClick={() => save.mutate(null)}
        >
          Restore defaults
        </Button>
        <Button
          size='sm'
          className='h-7 text-[12px]'
          disabled={save.isPending || Object.keys(draft).length === 0}
          onClick={() =>
            save.mutate(
              Object.fromEntries(keys.map((k) => [k, Number(value(k))])) as unknown as Weights
            )
          }
        >
          Save weights
        </Button>
      </div>
    </section>
  )
}
