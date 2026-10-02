/**
 * #1191 — "Trace next call": arm the server to keep the next N traces of a route (whatever their
 * speed) and list them as they arrive. The arm id survives the panel being reopened in this tab.
 */
import { useEffect, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { InspectLink } from '../../inspect/InspectLink'
import { BTN, errorOf } from '../shared'
import { armTraceNext, stopArm, useArmStatus } from './api'
import { countdown, fmtMs } from './logic'
import { Note } from './ui'

/** route|caller → arm id, so leaving and coming back keeps showing the same arm. */
const armed = new Map<string, string>()

const COUNTS = [
  { value: '1', label: 'next call' },
  { value: '3', label: 'next 3 calls' },
  { value: '5', label: 'next 5 calls' },
  { value: '10', label: 'next 10 calls' }
]

export function TraceNextControl({ route, caller }: { route: string; caller: string | null }) {
  const [onlyCaller, setOnlyCaller] = useState(false)
  const [count, setCount] = useState('1')
  const key = `${route}|${onlyCaller ? (caller ?? '') : ''}`
  const [armId, setArmId] = useState<string | null>(() => armed.get(key) ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const status = useArmStatus(armId)

  useEffect(() => {
    setArmId(armed.get(key) ?? null)
  }, [key])
  useEffect(() => {
    if (!armId) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [armId])

  const expired =
    (status.error as { response?: { status?: number } } | null)?.response?.status === 404 ||
    (status.data != null && status.data.expires_at <= now)

  async function start() {
    setBusy(true)
    setErr(null)
    try {
      const r = await armTraceNext({
        route,
        caller: onlyCaller ? caller : null,
        count: Number(count),
        ttlSec: 900
      })
      armed.set(key, r.id)
      setArmId(r.id)
    } catch (e) {
      setErr(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  const d = status.data
  return (
    <div className='grid gap-1.5' data-tm-inspect-trace-next={armId ?? ''}>
      {(!armId || expired) && (
        <div className='flex flex-wrap items-center gap-2'>
          <button
            type='button'
            className={BTN}
            disabled={busy}
            onClick={start}
            data-tm-inspect-trace-next-start=''
          >
            {busy ? 'Arming…' : 'Trace'}
          </button>
          <SimpleSelect
            value={count}
            onChange={setCount}
            options={COUNTS}
            ariaLabel='How many calls to trace'
            className='h-7 w-auto gap-1 px-2 text-[12px]'
            triggerProps={{ 'data-tm-inspect-trace-next-count': '' }}
          />
          {caller && (
            <label className='inline-flex items-center gap-1 text-[12px] text-[var(--tm-fg-2)]'>
              <input
                type='checkbox'
                checked={onlyCaller}
                onChange={(e) => setOnlyCaller(e.target.checked)}
                data-tm-inspect-trace-next-caller=''
              />
              only this caller
            </label>
          )}
        </div>
      )}
      {err && <Note tone='error'>{err}</Note>}
      {armId && expired && (
        <Note hook='trace-next-expired'>
          The last trace-next ran out of time (15 minutes) — arm another to keep waiting.
        </Note>
      )}
      {armId && !expired && d && (
        <div className='grid gap-1 text-[12px]'>
          <div className='flex items-center gap-2 text-[var(--tm-fg-2)]'>
            <span>
              {d.done
                ? `Kept ${d.traces.length} of ${d.total}.`
                : `Waiting for ${route} — ${d.remaining} left · ${countdown(d.expires_at, now)}`}
            </span>
            {!d.done && (
              <button
                type='button'
                className={BTN}
                onClick={async () => {
                  await stopArm(armId).catch(() => {})
                  armed.delete(key)
                  setArmId(null)
                }}
                data-tm-inspect-trace-next-stop=''
              >
                Stop
              </button>
            )}
          </div>
          {d.traces.length > 0 && (
            <ul className='grid gap-0.5' data-tm-inspect-trace-next-list=''>
              {d.traces.map((t) => (
                <li key={t.rid} className='flex items-center gap-2'>
                  <InspectLink
                    inspectRef={{
                      kind: 'trace',
                      id: t.rid,
                      at: t.at,
                      label: `Trace ${t.rid.slice(0, 8)}`
                    }}
                  >
                    {new Date(t.at).toTimeString().slice(0, 8)} · {fmtMs(t.ms)}
                  </InspectLink>
                  <span className='text-[var(--tm-muted)]'>
                    {t.status} · process {t.node}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {armId && !expired && !d && status.isLoading && (
        <span className='text-[12px] text-[var(--tm-muted)]'>Armed — waiting…</span>
      )}
    </div>
  )
}
