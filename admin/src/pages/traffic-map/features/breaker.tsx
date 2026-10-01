import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { callerLabel } from '../EventTicker'
import { Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import { apiError, INPUT, inMapOnly, isObj, TwoClickButton, useTmRoute } from './ops-common'

/**
 * Circuit breaker (#1157): during an incident, refuse (503) or rate-limit (429) one entity or one
 * caller for a while — every replica honours it, and it lifts on its own. Callers get the code
 * TRAFFIC_BREAKER_OPEN. Sign-in, health and the Traffic Map itself are never broken.
 */

export interface Breaker {
  kind: 'entity' | 'caller'
  target: string
  mode: 'refuse' | 'limit'
  limit: number | null
  until: number
  reason: string
  by: string | null
  by_name: string | null
  at: number
}
interface BreakerList {
  breakers: Breaker[]
  available: boolean
}

const KEY = ['breakers'] as const

function useBreakers(): { list: Breaker[]; available: boolean } {
  const { data } = useTmRoute<BreakerList>(KEY, '/breakers', 10_000)
  const ok = isObj(data) && Array.isArray(data.breakers)
  return { list: ok ? data.breakers : [], available: ok ? data.available !== false : true }
}

export function untilPhrase(until: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((until - now) / 60_000))
  const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return min <= 0 ? `until ${at} (under a minute)` : `until ${at} (${min} min)`
}

export function breakerTargetOf(
  sel: Selection
): { kind: 'entity' | 'caller'; target: string } | null {
  if (sel.kind === 'entity' && /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(sel.id))
    return { kind: 'entity', target: sel.id }
  if (sel.kind === 'caller' && /^(k\d+|u[0-9A-F-]{36})$/.test(sel.id))
    return { kind: 'caller', target: sel.id }
  return null
}

const SEG =
  'px-2 py-[2px] text-[11.5px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
const SEG_ON = 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
const SEG_OFF = 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
}) {
  return (
    <fieldset
      className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
      aria-label={label}
    >
      {options.map(([v, l], i) => (
        <button
          key={String(v)}
          type='button'
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            SEG,
            i > 0 && 'border-l border-[var(--tm-line)]',
            value === v ? SEG_ON : SEG_OFF
          )}
        >
          {l}
        </button>
      ))}
    </fieldset>
  )
}

function useBreakerWrites() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['traffic-map', 'ops', ...KEY] })
  const close = async (b: { kind: string; target: string }) => {
    try {
      await api.delete(
        `/traffic-map/breakers?kind=${b.kind}&target=${encodeURIComponent(b.target)}`
      )
      toast.success('Breaker closed — traffic flows again')
    } catch (e) {
      toast.error(apiError(e))
    }
    refresh()
  }
  return { refresh, close }
}

export function BreakerSection({ sel }: { sel: Selection }) {
  const t = breakerTargetOf(sel)
  const { list, available } = useBreakers()
  const { refresh, close } = useBreakerWrites()
  const [mode, setMode] = useState<'refuse' | 'limit'>('limit')
  const [limit, setLimit] = useState('60')
  const [minutes, setMinutes] = useState<number>(15)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  if (!t) return null
  const open = list.find((b) => b.kind === t.kind && b.target === t.target)
  const limitN = Number(limit)
  const valid =
    reason.trim().length > 0 &&
    (mode === 'refuse' || (Number.isInteger(limitN) && limitN >= 1 && limitN <= 100_000))
  const submit = async () => {
    setBusy(true)
    try {
      await api.post('/traffic-map/breakers', {
        kind: t.kind,
        target: t.target,
        mode,
        limit: mode === 'limit' ? limitN : undefined,
        minutes,
        reason
      })
      toast.success(
        mode === 'refuse'
          ? `Refusing ${t.kind === 'caller' ? 'this caller' : 'this endpoint'} for ${minutes} min`
          : `Limited to ${limitN} a minute for ${minutes} min`
      )
      setReason('')
      refresh()
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title='Circuit breaker'>
      {open ? (
        <div
          className='grid gap-1.5 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-2.5 py-2 text-[12px]'
          data-tm-breaker-open={`${open.kind}:${open.target}`}
        >
          <div className='font-medium text-[var(--tm-error-ink)]'>
            {open.mode === 'refuse'
              ? 'Refusing every request'
              : `Limited to ${open.limit} a minute`}{' '}
            {untilPhrase(open.until)}
          </div>
          <div className='text-[var(--tm-fg-2)]'>
            {open.reason}
            {open.by_name ? ` — ${open.by_name}` : ''}
          </div>
          <div>
            <TwoClickButton
              id='tm-breaker-close'
              label='Close the breaker'
              armedLabel='Click again to let traffic through'
              onConfirm={() => void close(open)}
            />
          </div>
        </div>
      ) : !available ? (
        <p className='text-[12px] text-[var(--tm-muted)]'>
          Breakers need Redis, which is not connected.
        </p>
      ) : (
        <div className='grid gap-2 text-[12px]' data-tm-breaker-form={`${t.kind}:${t.target}`}>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            During an incident, hold back{' '}
            {t.kind === 'caller' ? 'this caller' : 'requests to this endpoint'} on every node. It
            lifts on its own; callers get TRAFFIC_BREAKER_OPEN.
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <Segmented
              label='What to do'
              value={mode}
              onChange={setMode}
              options={[
                ['limit', 'Rate-limit'],
                ['refuse', 'Refuse all']
              ]}
            />
            {mode === 'limit' && (
              <label className='flex items-center gap-1.5 text-[var(--tm-fg-2)]'>
                <input
                  type='number'
                  min={1}
                  max={100000}
                  className={cn(INPUT, 'w-[72px] tabular-nums')}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  aria-label='Requests a minute'
                />
                a minute
              </label>
            )}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[var(--tm-fg-2)]'>For</span>
            <Segmented
              label='For how long'
              value={minutes}
              onChange={setMinutes}
              options={[
                [5, '5 min'],
                [15, '15 min'],
                [60, '1 hour']
              ]}
            />
          </div>
          <input
            className={INPUT}
            placeholder='Why (kept in the activity log)'
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            aria-label='Reason'
          />
          <div>
            <TwoClickButton
              id='tm-breaker-open'
              danger
              label={mode === 'refuse' ? 'Refuse requests' : 'Apply the limit'}
              armedLabel='Click again to open the breaker'
              disabled={busy || !valid}
              onConfirm={() => void submit()}
            />
          </div>
        </div>
      )}
    </Section>
  )
}

/** Header: open breakers at a glance (hidden when none). */
export function BreakersToolbarItem() {
  const { list } = useBreakers()
  const { catalog, setSelection } = useTrafficMap()
  const { close } = useBreakerWrites()
  if (!list.length) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-breakers'
          className='inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-2.5 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-error-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          {list.length} {list.length === 1 ? 'breaker' : 'breakers'} open
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] p-0'>
        <ul className='divide-y divide-border text-[12px]'>
          {list.map((b) => (
            <li key={`${b.kind}:${b.target}`} className='grid gap-1 px-3 py-2'>
              <button
                type='button'
                className='truncate text-left font-medium hover:underline'
                onClick={() =>
                  setSelection(
                    b.kind === 'entity'
                      ? { kind: 'entity', id: b.target }
                      : { kind: 'caller', id: b.target }
                  )
                }
              >
                {b.kind === 'caller' ? callerLabel(catalog, b.target) : b.target}
              </button>
              <span className='text-muted-foreground'>
                {b.mode === 'refuse' ? 'Refusing' : `${b.limit}/min`} {untilPhrase(b.until)} ·{' '}
                {b.reason}
              </span>
              <span>
                <button
                  type='button'
                  className='rounded-md border border-border px-2 py-[2px] text-[11.5px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  onClick={() => void close(b)}
                >
                  Close now
                </button>
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

register(inspectorPanels, {
  id: 'breaker',
  order: 90,
  applies: (sel) => breakerTargetOf(sel) !== null,
  Component: ({ sel }) => <BreakerSection sel={sel} />
})
register(toolbarItems, {
  id: 'breakers',
  order: 50,
  slot: 'status',
  Component: inMapOnly(BreakersToolbarItem)
})
