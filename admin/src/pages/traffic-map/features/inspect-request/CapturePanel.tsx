/**
 * #1213 — "Capture next…": hold the next N matching requests (their traces and request bodies, in
 * memory only, whoever the caller) and list them as they arrive. The toolbar entry arms one; the
 * capture panel watches it.
 */
import { Radio } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { useTrafficMap } from '../../context'
import { inspectErrorOf } from '../../inspect/api'
import { shortId } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import { openInspect } from '../../inspect/stack'
import type { InspectPanelProps } from '../../registry/inspectables'
import { BTN, errorOf, INPUT } from '../shared'
import { armCapture, type CaptureDetail, stopArm, useLiveDetail } from './api'
import { countdown, fmtMs } from './logic'
import { Facts, Note, PanelSkeleton, Section, StatusPill, Tag } from './ui'

const TTLS = [
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
  { value: '900', label: '15 minutes' }
]

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function CapturePanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useLiveDetail<CaptureDetail>(
    inspectRef,
    anchor,
    windowSec,
    (d) => !!d && d.expires_at > Date.now()
  )
  const live = !!q.data && q.data.expires_at > Date.now()
  const now = useNow(live)
  if (q.isLoading) return <PanelSkeleton />
  if (q.error) {
    const e = inspectErrorOf(q.error)
    return (
      <Note tone={e.status === 404 ? 'muted' : 'error'} hook='capture-gone'>
        {e.status === 404
          ? 'This capture has ended. Captured requests and their bodies are held in memory only until the capture’s time runs out, then dropped — start another from “Capture next…”.'
          : e.message}
      </Note>
    )
  }
  const d = q.data
  if (!d) return <PanelSkeleton />
  const left = d.expires_at - now
  return (
    <div className='grid gap-4' data-tm-inspect-capture={d.id}>
      <Section
        title='What it catches'
        hook='capture-spec'
        aside={
          !d.done && left > 0 ? (
            <button
              type='button'
              className={BTN}
              data-tm-inspect-capture-stop=''
              onClick={async () => {
                try {
                  await stopArm(d.id)
                  await q.refetch()
                } catch (e) {
                  toast.error(errorOf(e))
                }
              }}
            >
              Stop
            </button>
          ) : null
        }
      >
        <Facts
          items={[
            d.spec.route && [
              'Route',
              <span key='r' className='font-mono'>
                {d.spec.route}
              </span>
            ],
            d.spec.caller && [
              'Caller',
              <InspectLink key='c' inspectRef={{ kind: 'caller', id: d.spec.caller }}>
                {d.spec.caller}
              </InspectLink>
            ],
            d.spec.entity && [
              'Entity',
              <InspectLink key='e' inspectRef={{ kind: 'entity', id: d.spec.entity }}>
                {d.spec.entity}
              </InspectLink>
            ],
            ['Caught', `${d.entries.length} of ${d.total}`],
            [
              'Time left',
              left > 0
                ? `${countdown(d.expires_at, now)}${d.done ? ' (count reached — kept until then)' : ''}`
                : 'ended'
            ]
          ]}
        />
        <p className='text-[11px] text-[var(--tm-muted)]'>
          Bodies are held in this API’s memory only, credentials masked, 64 KB each — never written
          to the API log — and dropped when the time runs out.
        </p>
      </Section>
      <Section title='Requests' hook='capture-entries'>
        {d.entries.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]' data-tm-inspect-capture-empty=''>
            {left > 0
              ? 'Nothing matched yet — waiting for the next call…'
              : 'Nothing matched before it ended.'}
          </p>
        ) : (
          <ul className='grid gap-1' data-tm-inspect-capture-list=''>
            {d.entries.map((e) => (
              <li key={e.rid} className='grid gap-0.5 text-[12px]'>
                <div className='flex min-w-0 items-center gap-2'>
                  <StatusPill status={e.status} />
                  <InspectLink
                    inspectRef={{ kind: 'request', id: e.rid, at: e.at, label: e.route }}
                    className='font-mono text-[11.5px]'
                  >
                    {e.method} {e.path}
                  </InspectLink>
                  <span className='ml-auto shrink-0 tabular-nums text-[var(--tm-muted)]'>
                    {fmtMs(e.ms)} · {new Date(e.at).toTimeString().slice(0, 8)}
                  </span>
                </div>
                <div className='flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-[var(--tm-muted)]'>
                  {e.has_body ? (
                    <Tag tip='Open the request to read it'>
                      body {Math.ceil(e.body_bytes / 1024)} KB
                    </Tag>
                  ) : (
                    <span>{e.body_note ?? 'no body'}</span>
                  )}
                  <InspectLink
                    inspectRef={{
                      kind: 'trace',
                      id: e.rid,
                      at: e.at,
                      label: `Trace ${shortId(e.rid)}`
                    }}
                    className='text-[11px]'
                  >
                    trace
                  </InspectLink>
                  <span data-tip='The API process whose memory holds the trace'>
                    · process {e.node}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

/** Toolbar entry: arm a capture, prefilled from the selected node. */
export function CaptureNextToolbar() {
  const { selection } = useTrafficMap()
  const [open, setOpen] = useState(false)
  const [route, setRoute] = useState('')
  const [caller, setCaller] = useState('')
  const [entity, setEntity] = useState('')
  const [count, setCount] = useState('10')
  const [ttl, setTtl] = useState('300')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    if (selection?.kind === 'entity') setEntity(selection.id)
    if (selection?.kind === 'caller') setCaller(selection.id)
  }, [open, selection])

  async function start() {
    setBusy(true)
    setErr(null)
    try {
      const n = Number(count)
      const r = await armCapture({
        route: route.trim() || null,
        caller: caller.trim() || null,
        entity: entity.trim() || null,
        count: Number.isFinite(n) ? n : 10,
        ttlSec: Number(ttl)
      })
      setOpen(false)
      openInspect(
        {
          kind: 'capture',
          id: r.id,
          label: `Capture ${[route, caller, entity].filter((s) => s.trim()).join(' · ') || shortId(r.id)}`
        },
        { root: true }
      )
    } catch (e) {
      setErr(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={BTN}
          data-tm-inspect-capture-open=''
          data-tip='Hold the next matching requests — traces and bodies, in memory only'
        >
          <Radio className='h-3.5 w-3.5' aria-hidden='true' />
          Capture next…
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[320px] p-2'>
        <form
          className='traffic-map grid gap-2'
          data-tm-inspect-capture-form=''
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <span className='text-[12px] font-medium text-[var(--tm-fg)]'>
            Capture the next requests
          </span>
          <p className='text-[11.5px] text-[var(--tm-fg-2)]'>
            Fill in at least one. Matching requests keep their trace and request body, whoever made
            them — held in memory only until the time runs out.
          </p>
          <label className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
            Route
            <input
              className={INPUT}
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              placeholder='GET /api/items/workflows/:id'
              data-tm-inspect-capture-route=''
            />
          </label>
          <label className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
            Caller
            <input
              className={INPUT}
              value={caller}
              onChange={(e) => setCaller(e.target.value)}
              placeholder='k12 for an API key, u<user id> for a person'
              data-tm-inspect-capture-caller=''
            />
          </label>
          <label className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
            Entity
            <input
              className={INPUT}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder='items/workflows'
              data-tm-inspect-capture-entity=''
            />
          </label>
          <div className='flex items-end gap-2'>
            <label className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
              How many
              <input
                className={`${INPUT} w-20`}
                type='number'
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                data-tm-inspect-capture-count=''
              />
            </label>
            <div className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
              <span>For up to</span>
              <SimpleSelect
                value={ttl}
                onChange={setTtl}
                options={TTLS}
                ariaLabel='How long the capture runs'
                className='h-7 w-auto gap-1 px-2 text-[12px]'
                triggerProps={{ 'data-tm-inspect-capture-ttl': '' }}
              />
            </div>
          </div>
          {err && <Note tone='error'>{err}</Note>}
          <button
            type='submit'
            className={BTN}
            disabled={busy || (!route.trim() && !caller.trim() && !entity.trim())}
            data-tm-inspect-capture-start=''
          >
            {busy ? 'Starting…' : 'Start capturing'}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
