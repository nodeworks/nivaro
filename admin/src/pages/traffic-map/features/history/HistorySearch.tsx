/**
 * #2175 — search the traffic history: "when did this caller last hit this route", "first time this
 * error appeared", "busiest hour for this partner last month". Structured fields only (the server
 * binds every value); each answer links to its moment on the map — the map's own rewind for the
 * last minutes, the time-lapse before that.
 */
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { callerLabel, fmtCount, fmtMs } from '../../EventTicker'
import { requestMapRewind } from '../../RewindBar'
import { BTN, errorOf, INPUT, LINK, Note } from '../shared'
import { fmtMoment, historyStore, RING_MS, type SearchAnswer, type SearchHit } from './shared'

type Kind = SearchAnswer['kind']
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'last_hit', label: 'Last time…' },
  { value: 'first_error', label: 'First time this error…' },
  { value: 'busiest_hour', label: 'Busiest hour…' }
]
const DAYS = [
  { value: '1', label: 'last day' },
  { value: '7', label: 'last 7 days' },
  { value: '14', label: 'last 14 days' },
  { value: '31', label: 'last month' }
]

function openMoment(ms: number): void {
  if (Date.now() - ms <= RING_MS && requestMapRewind(ms) !== 'unavailable') return
  historyStore.openAt(ms)
}

function HitRow({ hit, kind, primary }: { hit: SearchHit; kind: Kind; primary?: boolean }) {
  const { catalog } = useTrafficMap()
  return (
    <li className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5' data-tm-search-hit={hit.at}>
      <span className={primary ? 'font-medium' : 'text-[var(--tm-fg-2)]'}>
        {kind === 'busiest_hour'
          ? `${fmtMoment(hit.at)}–${new Date(hit.until ?? hit.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
          : new Date(hit.at).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })}
      </span>
      {hit.n != null && (
        <span className='tabular-nums text-[var(--tm-muted)]'>{fmtCount(hit.n)} requests</span>
      )}
      {hit.route && (
        <span className='font-mono text-[11px] text-[var(--tm-fg-2)]'>{hit.route}</span>
      )}
      {hit.status != null && (
        <span className='tabular-nums text-[var(--tm-muted)]'>{hit.status}</span>
      )}
      {hit.latency_ms != null && (
        <span className='tabular-nums text-[var(--tm-muted)]'>{fmtMs(hit.latency_ms)}</span>
      )}
      {hit.caller && (
        <span className='text-[var(--tm-muted)]'>by {callerLabel(catalog, hit.caller)}</span>
      )}
      <button
        type='button'
        className={LINK}
        onClick={() => openMoment(hit.at)}
        data-tm-search-open=''
      >
        Open this moment
      </button>
    </li>
  )
}

export function HistorySearch() {
  const { selection } = useTrafficMap()
  const [kind, setKind] = useState<Kind>('last_hit')
  const [days, setDays] = useState('7')
  const [caller, setCaller] = useState('')
  const [entity, setEntity] = useState('')
  const [route, setRoute] = useState('')
  const [error, setError] = useState('')
  const [partner, setPartner] = useState('')
  // Start from the map's selection: a caller, an entity or a partner.
  useEffect(() => {
    if (!selection) return
    if (selection.kind === 'caller') setCaller(selection.id)
    else if (selection.kind === 'entity') {
      setEntity(selection.id)
      if (selection.caller) setCaller(selection.caller)
    } else if (selection.kind === 'down' && selection.id.startsWith('ext:'))
      setPartner(selection.id)
  }, [selection])
  const m = useMutation({
    mutationFn: async () => {
      const params: Record<string, string> = { kind, days }
      if (caller.trim()) params.caller = caller.trim()
      if (entity.trim()) params.entity = entity.trim()
      if (route.trim()) params.route = route.trim()
      if (kind === 'first_error' && error.trim()) params.error = error.trim()
      if (kind === 'busiest_hour' && partner.trim()) {
        params.partner = partner.trim()
        delete params.caller
        delete params.entity
        delete params.route
      }
      return ((await api.get('/traffic-map/history/search', { params }))?.data?.data ??
        null) as SearchAnswer | null
    }
  })
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    mono = true
  ) => (
    <label className='grid min-w-0 gap-0.5 text-[11.5px] text-[var(--tm-muted)]' htmlFor={id}>
      {label}
      <input
        id={id}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        className={`${INPUT} min-w-0 ${mono ? 'font-mono text-[11.5px]' : ''}`}
        spellCheck={false}
        autoComplete='off'
      />
    </label>
  )
  const a = m.data
  return (
    <div className='grid gap-3 p-3.5' data-tm-search=''>
      <form
        className='grid gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
      >
        <div className='flex flex-wrap items-center gap-2'>
          <SimpleSelect
            value={kind}
            onChange={(v) => setKind(v as Kind)}
            options={KINDS}
            ariaLabel='Question'
            triggerProps={{ id: 'tm-search-kind' }}
            className='h-7 w-auto min-w-[170px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
          />
          <SimpleSelect
            value={days}
            onChange={setDays}
            options={DAYS}
            ariaLabel='Range'
            triggerProps={{ id: 'tm-search-days' }}
            className='h-7 w-auto min-w-[120px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
          />
          <button type='submit' className={BTN} disabled={m.isPending} id='tm-search-go'>
            {m.isPending ? 'Searching…' : 'Search'}
          </button>
        </div>
        <div className='grid gap-2 min-[700px]:grid-cols-2 min-[1200px]:grid-cols-4'>
          {kind === 'busiest_hour' &&
            field(
              'tm-search-partner',
              'Partner (searches its outbound calls)',
              partner,
              setPartner,
              'ext:3'
            )}
          {field(
            'tm-search-caller',
            'Caller',
            caller,
            setCaller,
            'u<user id>, k<api key id> or anon'
          )}
          {field('tm-search-entity', 'Node', entity, setEntity, 'items/workflows')}
          {field('tm-search-route', 'Route', route, setRoute, 'GET /api/items/workflows/:id')}
          {kind === 'first_error' &&
            field('tm-search-error', 'Error text', error, setError, 'Request timeout', false)}
        </div>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Select a node or caller on the map to fill these in. Any field left blank matches
          everything.
        </p>
      </form>
      {m.isError && <Note tone='error'>{errorOf(m.error)}</Note>}
      {a && (
        <div className='text-[12px]' data-tm-search-answer={a.kind}>
          {!a.hit ? (
            <Note>Nothing matched in that range.</Note>
          ) : (
            <>
              <p className='mb-1 text-[var(--tm-muted)]'>
                {fmtCount(a.count)} matching requests in the range.
                {a.kind === 'first_error' && a.more.length ? ' First and latest:' : ''}
                {a.kind === 'busiest_hour' && a.more.length ? ' Busiest first:' : ''}
              </p>
              <ul className='grid gap-1'>
                <HitRow hit={a.hit} kind={a.kind} primary />
                {a.more.map((h) => (
                  <HitRow key={h.at} hit={h} kind={a.kind} />
                ))}
              </ul>
            </>
          )}
          {a.note && <Note>{a.note}</Note>}
          {a.source === 'store' && (
            <p className='m-0 text-[11.5px] text-[var(--tm-muted)]' data-tm-search-source='store'>
              Answered from the long-history store, which keeps the request log past its 14 days.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
