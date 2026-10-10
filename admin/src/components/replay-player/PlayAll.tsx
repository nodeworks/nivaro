/**
 * Follow a record across recordings (#1398). "Play all" on a record's replay
 * search (#1374) stitches every recording that opened the record into one
 * timeline: oldest first, each trimmed to the visit plus a minute either
 * side, one ReplayPlayer per segment that hands over to the next when its
 * window ends. The strip on top names the person and time of each segment;
 * under it, the record's revision at that moment (and any saved during the
 * segment) links to the change in the activity log.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, type Revision } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { ReplayPlayer } from './index'
import {
  fmtLength,
  planSegments,
  type RecordVisit,
  revisionAt,
  revisionsWithin
} from './play-all-logic'

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function revisionWho(r: Revision): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ')
  return n || r.user_email || 'System'
}

function RevisionLink({ rev, label }: { rev: Revision; label: string }) {
  const when = rev.timestamp
    ? `${formatDate(rev.timestamp)} ${clock(Date.parse(rev.timestamp))}`
    : ''
  const text = `${label} · ${rev.action ?? 'change'} by ${revisionWho(rev)}${when ? ` · ${when}` : ''}`
  return rev.activity != null ? (
    <Link
      to={`/activity/${rev.activity}`}
      target='_blank'
      className='text-nvr-navy hover:underline dark:text-nvr-cyan'
    >
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  )
}

export function PlayAll({
  collection,
  item,
  visits
}: {
  collection: string
  item: string
  visits: RecordVisit[]
}) {
  const segments = useMemo(() => planSegments(visits), [visits])
  const [index, setIndex] = useState(0)
  const [autoNext, setAutoNext] = useState(true)
  const seg = segments[Math.min(index, segments.length - 1)]

  // Same key and shape as the record's Revisions panel — one cache.
  const { data: revisions = [] } = useQuery({
    queryKey: ['revisions', collection, item],
    queryFn: () =>
      api
        .get('/revisions', { params: { collection, item } })
        .then((r) => (r.data.data ?? []) as Revision[]),
    staleTime: 30_000
  })

  const atVisit = seg ? revisionAt(revisions, seg.visitFrom) : null
  const during = seg ? revisionsWithin(revisions, seg.from, seg.to) : []

  const autoNextRef = useRef(autoNext)
  autoNextRef.current = autoNext
  const onEnd = useCallback(() => {
    if (!autoNextRef.current) return
    setIndex((i) => (i + 1 < segments.length ? i + 1 : i))
  }, [segments.length])
  const span = useMemo(() => (seg ? { from: seg.from, to: seg.to, onEnd } : null), [seg, onEnd])

  if (!seg) {
    return <p className='py-10 text-center text-[13px] text-slate-400'>Nothing to play.</p>
  }

  return (
    <div className='mt-3'>
      <ol className='flex gap-1.5 overflow-x-auto pb-1' aria-label='Segments'>
        {segments.map((s, i) => (
          <li key={`${s.recordingId}:${s.from}`} className='shrink-0'>
            <button
              type='button'
              onClick={() => setIndex(i)}
              aria-current={i === index ? 'step' : undefined}
              className={cn(
                'rounded-md border px-2 py-1 text-left text-[11.5px]',
                i === index
                  ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                  : i < index
                    ? 'border-slate-200 text-slate-400 dark:border-border'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300'
              )}
            >
              <span className='block font-medium'>
                {i + 1}. {s.person}
              </span>
              <span className='block tabular-nums text-[10.5px] opacity-80'>
                {formatDate(new Date(s.visitFrom))} {clock(s.visitFrom)} ·{' '}
                {fmtLength(s.to - s.from)}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]'>
        <Button
          size='sm'
          variant='outline'
          className='h-7 w-7 p-0'
          aria-label='Previous segment'
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          <ChevronLeft className='h-3.5 w-3.5' />
        </Button>
        <span className='font-medium text-slate-800 dark:text-foreground'>
          {index + 1} of {segments.length} — {seg.person}, {clock(seg.visitFrom)}–
          {clock(seg.visitTo)}
        </span>
        <Button
          size='sm'
          variant='outline'
          className='h-7 w-7 p-0'
          aria-label='Next segment'
          disabled={index >= segments.length - 1}
          onClick={() => setIndex((i) => Math.min(segments.length - 1, i + 1))}
        >
          <ChevronRight className='h-3.5 w-3.5' />
        </Button>
        <span className='ml-auto flex items-center gap-1.5 text-[11.5px] text-slate-500'>
          Play the next one automatically
          <Switch
            checked={autoNext}
            onCheckedChange={setAutoNext}
            aria-label='Play the next segment automatically'
          />
        </span>
      </div>

      <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-slate-500'>
        <History className='h-3 w-3' />
        {atVisit ? (
          <RevisionLink rev={atVisit} label='Record as they found it' />
        ) : (
          <span>No revision of the record before this visit.</span>
        )}
        {during.slice(0, 3).map((r) => (
          <RevisionLink key={String(r.id)} rev={r} label='Saved here' />
        ))}
      </div>

      <ReplayPlayer
        key={`${seg.recordingId}:${seg.from}`}
        recordingId={seg.recordingId}
        span={span}
      />
    </div>
  )
}
