/**
 * #1193 — what the person saw: their session recording, seeked to 5 s before the moment. Opened
 * by recording id (an issue's replay) or as `for:<user>` (find the recording covering the time).
 * No recording → follow this person from now on, and say whether recording is even on.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ReplayPlayer } from '@/components/replay-player'
import { api } from '@/lib/api'
import { useInspectDetail } from '../../inspect/api'
import type { InspectPanelProps } from '../../registry/inspectables'
import { following } from '../follow-person'
import { BTN, LINK } from '../shared'
import { fmtDuration, fmtStamp, followKey } from './logic'
import { Facts, LoadFailed, Note, Skeleton } from './ui'

interface RecordingWire {
  id: string
  user: string | null
  user_name: string | null
  app: string | null
  clip: boolean
  origin: string | null
  started_at: string | null
  ended_at: string | null
  last_event_at: string | null
  event_count: number
  byte_size: number
  truncated: boolean
  live: boolean
}

type RecordingDetail =
  | {
      none: false
      recording: RecordingWire
      offset_ms: number | null
      clip_distance_ms?: number | null
      recording_on: boolean
    }
  | {
      none: true
      reason: string
      user: string | null
      user_name: string | null
      at: string | null
      recording_on: boolean
    }

function FollowButtons({ user, name }: { user: string; name: string }) {
  const [busy, setBusy] = useState(false)
  const follow = () => {
    following.set({ key: followKey(user), name })
    toast.success(`Following ${name} on the map`)
  }
  const trace = async () => {
    setBusy(true)
    try {
      await api.post('/traffic-map/follow/trace', { caller: followKey(user), requests: 50 })
      toast.success(`Tracing ${name}'s next 50 requests`)
    } catch {
      toast.error('Could not start tracing')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <button type='button' className={BTN} onClick={follow} data-tm-inspect-recording-follow=''>
        Follow this person
      </button>
      <button
        type='button'
        className={BTN}
        onClick={trace}
        disabled={busy}
        data-tm-inspect-recording-trace=''
      >
        Keep their next 50 traces
      </button>
    </div>
  )
}

export default function RecordingPanel(props: InspectPanelProps) {
  const { inspectRef, anchor, windowSec } = props
  const q = useInspectDetail<RecordingDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <Skeleton rows={[60, 100, 100, 40]} />
  if (q.isError || !q.data) return <LoadFailed error={q.error} what='recording' />
  const d = q.data
  if (d.none) {
    const name = d.user_name ?? 'this person'
    return (
      <div className='grid gap-3' data-tm-inspect-recording='none'>
        <p className='text-[13px] font-medium text-[var(--tm-fg)]'>
          No recording of {name}
          {d.at ? ` at ${fmtStamp(d.at)}` : ''}
        </p>
        <Note hook='recording-none'>{d.reason}</Note>
        {d.user && <FollowButtons user={d.user} name={name} />}
        {!d.recording_on && (
          <Note hook='recording-off'>
            To record this person from now on, turn on session recording under{' '}
            <Link to='/session-replays' className={LINK}>
              Session replays
            </Link>
            .
          </Note>
        )}
      </div>
    )
  }
  const r = d.recording
  const start = r.started_at ? Date.parse(r.started_at) : null
  const end = r.last_event_at ?? r.ended_at
  const span = start != null && end ? Date.parse(end) - start : null
  return (
    <div className='grid min-w-0 gap-3' data-tm-inspect-recording={r.id}>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <p className='text-[13px] font-medium text-[var(--tm-fg)]'>
          {r.clip ? 'Error clip' : 'Recording'} of {r.user_name ?? 'someone'}
          {r.live ? (
            <span className='ml-2 rounded-full bg-[var(--tm-error-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--tm-error-ink)]'>
              live
            </span>
          ) : null}
        </p>
        <Link
          to={`/session-replays?recording=${encodeURIComponent(r.id)}${d.offset_ms != null ? `&t=${d.offset_ms}` : ''}`}
          className={`${LINK} text-[12px]`}
          data-tm-inspect-recording-page=''
        >
          Open full page
        </Link>
      </div>
      <Facts
        rows={[
          ['Started', fmtStamp(r.started_at)],
          ['Length', fmtDuration(span)],
          d.offset_ms != null
            ? ['Moment', `${fmtDuration(d.offset_ms)} in · opens 5 s before`]
            : null,
          r.app && !r.clip ? ['App', r.app] : null,
          [
            'Events',
            `${r.event_count.toLocaleString()}${r.truncated ? ' (cut short at the size cap)' : ''}`
          ]
        ]}
      />
      {d.clip_distance_ms ? (
        <Note hook='recording-clip'>
          No full recording covered this moment; this error clip was saved{' '}
          {fmtDuration(d.clip_distance_ms)} away from it.
        </Note>
      ) : null}
      <div className='min-w-0' data-tm-inspect-recording-player=''>
        <ReplayPlayer
          key={`${r.id}:${d.offset_ms ?? 0}`}
          recordingId={r.id}
          startAt={d.offset_ms}
          live={r.live && d.offset_ms == null}
          minHeight={240}
        />
      </div>
    </div>
  )
}
