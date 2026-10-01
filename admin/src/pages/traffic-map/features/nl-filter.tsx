import { Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { callerLabel, entityLabel } from '../EventTicker'
import { defaultFilters } from '../model'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { type Filters, type Kind, LANE_LABEL, type Lane, type TrafficCatalog } from '../types'
import { BTN, errorOf, INPUT } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1133 — natural-language filter. One small AI call turns "writes by integrations to
 * forecasts in the last 5 minutes" into the map's own filters; the compiled chips show first and
 * nothing changes until Apply. The model only picks from the callers and entities on the map now
 * (the server checks every value again).
 */
export interface NlResult {
  lanes: string[] | null
  kinds: string[] | null
  caller: string | null
  caller_kind: string | null
  window: number | null
  entity: string | null
  summary: string
}
const KIND_TEXT: Record<string, string> = {
  key: 'API keys',
  machine: 'integration accounts',
  person: 'signed-in people',
  cron: 'scheduled jobs',
  source: 'imports and other sources',
  anon: 'requests with no credentials'
}

/** Callers of one kind among the ones the map holds. */
export function callersOfKind(keys: string[], cat: TrafficCatalog | null, kind: string): string[] {
  return keys.filter((k) => {
    const c = cat?.callers[k]?.kind
    if (c) return c === kind
    if (kind === 'source') return /^[a-z]+:/.test(k)
    if (kind === 'cron') return k === 'cron'
    if (kind === 'anon') return k === 'anon'
    if (kind === 'key') return /^k\d+$/.test(k)
    return false
  })
}

/** The compiled result applied onto the current filters (anything null keeps its value). */
export function applyNl(
  cur: Filters,
  r: NlResult,
  callerKeys: string[],
  cat: TrafficCatalog | null
): Filters {
  const next: Filters = { ...cur }
  if (r.lanes?.length) next.types = new Set(r.lanes as Lane[])
  if (r.kinds?.length) next.kinds = new Set(r.kinds as Kind[])
  if (r.window === 60 || r.window === 300 || r.window === 900) next.win = r.window
  if (r.caller) {
    next.caller = r.caller
    next.callers = undefined
  } else if (r.caller_kind) {
    next.caller = ''
    next.callers = callersOfKind(callerKeys, cat, r.caller_kind)
  }
  return next
}

const CHIP =
  'inline-flex items-center rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2 py-[2px] text-[11.5px] text-[var(--tm-fg)]'

function NlFilter() {
  const { model, catalog, win, filters, setFilters, setSelection } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [res, setRes] = useState<NlResult | null>(null)
  if (frozen) return null

  const callerKeys = model.callerKeys()
  const compile = async () => {
    if (!prompt.trim()) return
    setBusy(true)
    setErr(null)
    setRes(null)
    try {
      const all = { ...defaultFilters(), win }
      const vocabulary = {
        callers: callerKeys
          .map((k) => ({ key: k, n: model.callerSum(k, win)[0] }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 80)
          .map(({ key }) => ({
            key,
            label: callerLabel(catalog, key),
            kind: catalog?.callers[key]?.kind ?? (/^[a-z]+:/.test(key) ? 'source' : 'person')
          })),
        entities: model.hot(win, all, 150).map((r) => ({
          key: r.key,
          label: entityLabel(catalog, r.lane, r.entity)
        }))
      }
      const r = await api.post('/traffic-map/nl-filter', { prompt, vocabulary })
      setRes(r.data.data as NlResult)
    } catch (e) {
      setErr(errorOf(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = () => {
    if (!res) return
    setFilters((f) => applyNl(f, res, callerKeys, catalog))
    if (res.entity) setSelection({ kind: 'entity', id: res.entity })
    setOpen(false)
    setRes(null)
  }
  const chips: string[] = []
  if (res) {
    if (res.lanes?.length)
      chips.push(`Show ${res.lanes.map((l) => LANE_LABEL[l as Lane] ?? l).join(', ')}`)
    if (res.kinds?.length) chips.push(`Kinds ${res.kinds.join(', ')}`)
    if (res.caller) chips.push(`Caller ${callerLabel(catalog, res.caller)}`)
    else if (res.caller_kind) {
      const n = callersOfKind(callerKeys, catalog, res.caller_kind).length
      chips.push(`Callers: ${KIND_TEXT[res.caller_kind] ?? res.caller_kind} (${n} on the map)`)
    }
    if (res.window) chips.push(`Window ${Math.round(res.window / 60)}m`)
    if (res.entity) {
      const cut = res.entity.indexOf('/')
      chips.push(
        `Select ${entityLabel(catalog, res.entity.slice(0, cut), res.entity.slice(cut + 1))}`
      )
    }
  }
  const group = filters.callers?.length ? filters.callers : null
  return (
    <>
      {group ? (
        <span
          className={cn(CHIP, 'gap-1.5 bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]')}
          id='tm-caller-group'
        >
          {group.length} {group.length === 1 ? 'caller' : 'callers'}
          <button
            type='button'
            aria-label='Clear the caller group'
            className='rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onClick={() => setFilters((f) => ({ ...f, callers: undefined }))}
          >
            <X className='h-3 w-3' aria-hidden='true' />
          </button>
        </span>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            id='tm-nl'
            className={BTN}
            aria-label='Describe a view'
            title='Describe a view in your own words'
          >
            <Sparkles className='h-3.5 w-3.5' aria-hidden='true' />
            <span className='hidden 2xl:inline'>Describe a view</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[380px] p-3'>
          <form
            className='traffic-map grid gap-2 text-[12px] text-[var(--tm-fg)]'
            onSubmit={(e) => {
              e.preventDefault()
              void compile()
            }}
          >
            <label htmlFor='tm-nl-input' className='font-medium'>
              What do you want to see?
            </label>
            <input
              id='tm-nl-input'
              className={cn(INPUT, 'h-8 w-full')}
              value={prompt}
              maxLength={400}
              placeholder='writes by integrations to forecasts in the last 5 minutes'
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className='flex items-center gap-2'>
              <button type='submit' className={BTN} disabled={busy || !prompt.trim()} id='tm-nl-go'>
                {busy ? 'Reading…' : 'Turn into filters'}
              </button>
              <span className='text-[11.5px] text-[var(--tm-muted)]'>
                One AI call; nothing changes until you apply.
              </span>
            </div>
            {err ? (
              <p role='alert' className='text-[12px] text-[var(--tm-error-ink)]' id='tm-nl-error'>
                {err}
              </p>
            ) : null}
            {res ? (
              <div className='grid gap-1.5' id='tm-nl-result'>
                {res.summary ? <p className='text-[var(--tm-fg-2)]'>{res.summary}</p> : null}
                {chips.length ? (
                  <ul className='flex flex-wrap gap-1'>
                    {chips.map((c) => (
                      <li key={c} className={CHIP} data-tm-nl-chip=''>
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='text-[var(--tm-muted)]'>
                    Nothing on the map matched; try other words.
                  </p>
                )}
                <div className='flex gap-1.5'>
                  <button
                    type='button'
                    className={BTN}
                    disabled={!chips.length}
                    onClick={apply}
                    id='tm-nl-apply'
                  >
                    Apply
                  </button>
                  <button type='button' className={BTN} onClick={() => setRes(null)}>
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
          </form>
        </PopoverContent>
      </Popover>
    </>
  )
}

register(toolbarItems, { id: 'nl-filter', order: 2, slot: 'lead', Component: NlFilter })
