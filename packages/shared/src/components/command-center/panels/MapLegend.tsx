import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { EMPTY_FILTERS, useCc } from '../state'
import { FAINT, FOCUS, MUTED } from '../theme'
import type { CcFilters, GeoPin, MapLayerKind } from '../types'
import { MAP_COLORS } from './map-shared'

/**
 * CC-12 — what the map's colours mean (always in words, never colour alone) and the filter chips
 * bound to the board's filters (state, SLA, owner). The server applies the filters to /geo.
 */

function PinSwatch({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className='relative inline-flex h-3.5 w-3 shrink-0 items-center justify-center'
      aria-hidden='true'
    >
      {pulse && (
        <span
          className='absolute inset-0 rounded-full motion-safe:animate-ping'
          style={{ background: `${color}55` }}
        />
      )}
      <svg width='12' height='15' viewBox='0 0 24 30' className='relative' aria-hidden='true'>
        <path
          d='M12 0C5.4 0 0 5.4 0 12c0 8.4 12 18 12 18s12-9.6 12-18C24 5.4 18.6 0 12 0z'
          fill={color}
          stroke='#fff'
          strokeWidth='2'
        />
      </svg>
    </span>
  )
}

const LAYER_KEY: Record<MapLayerKind, { color: string; text: string }> = {
  sla_heat: { color: MAP_COLORS.breached, text: 'SLA heat — larger, stronger dots are breached' },
  activity: { color: MAP_COLORS.activity, text: 'Changed in the last 15 minutes' },
  out_today: { color: MAP_COLORS.out, text: 'Out of office today' }
}

export function MapLegend({
  states,
  layers,
  showPeople
}: {
  states: Array<{ key: string; label: string; color: string | null }>
  layers: MapLayerKind[]
  showPeople: boolean
}) {
  return (
    <section
      className='w-[240px] space-y-1.5 rounded-lg border border-[var(--cc-border)] bg-[var(--cc-panel)] p-2.5 text-[11.5px] text-[var(--cc-text)] shadow-lg'
      aria-label='Map key'
    >
      <p className='font-semibold text-[var(--cc-strong)]'>Map key</p>
      {states.slice(0, 6).map((s) => (
        <p key={s.key} className='flex items-center gap-2'>
          <PinSwatch color={s.color ?? MAP_COLORS.ok} /> {s.label}
        </p>
      ))}
      {states.length === 0 && (
        <p className='flex items-center gap-2'>
          <PinSwatch color={MAP_COLORS.ok} /> A record (no pipeline step)
        </p>
      )}
      <p className='flex items-center gap-2'>
        <PinSwatch color={MAP_COLORS.warning} /> SLA warning — due soon
      </p>
      <p className='flex items-center gap-2'>
        <PinSwatch color={MAP_COLORS.breached} pulse /> SLA breached — overdue (pulses)
      </p>
      <p className='flex items-center gap-2'>
        <span
          className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-white text-[8px] font-bold text-white'
          style={{ background: MAP_COLORS.breached }}
          aria-hidden='true'
        >
          3
        </span>
        Group of records — takes the colour of the worst one
      </p>
      {showPeople && (
        <p className='flex items-center gap-2'>
          <span
            className='h-4 w-4 shrink-0 rounded-full'
            style={{
              background: `${MAP_COLORS.people}45`,
              border: `2px dashed ${MAP_COLORS.people}`
            }}
            aria-hidden='true'
          />
          People online at an office or in a region
        </p>
      )}
      {layers.map((l) => (
        <p key={l} className='flex items-center gap-2'>
          <span
            className='h-3 w-3 shrink-0 rounded-full'
            style={{
              background: `${LAYER_KEY[l].color}88`,
              border: `1.5px solid ${LAYER_KEY[l].color}`
            }}
            aria-hidden='true'
          />
          {LAYER_KEY[l].text}
        </p>
      ))}
    </section>
  )
}

const chip = (on: boolean) =>
  cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
    FOCUS,
    on
      ? 'border-nvr-cyan bg-nvr-cyan/15 font-medium text-[var(--cc-strong)]'
      : 'border-[var(--cc-border)] text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]'
  )

const SLA_CHIPS: Array<{ key: 'breached' | 'warning' | 'ok'; label: string; color: string }> = [
  { key: 'breached', label: 'Breached', color: MAP_COLORS.breached },
  { key: 'warning', label: 'Warning', color: MAP_COLORS.warning },
  { key: 'ok', label: 'On time', color: MAP_COLORS.people }
]

/** Filter chips bound to useCc().filters. */
export function MapFilters({
  states,
  pins
}: {
  states: Array<{ key: string; label: string; color: string | null }>
  pins: GeoPin[]
}) {
  const cc = useCc()
  const f = cc.filters
  const set = (patch: Partial<CcFilters>) => cc.setFilters({ ...f, ...patch })
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const active = f.states.length > 0 || f.sla.length > 0 || !!f.owner
  // Keep chosen states listed even when the filtered answer no longer carries them.
  const stateChips = useMemo(() => {
    const seen = new Map(states.map((s) => [s.key, s]))
    for (const k of f.states) if (!seen.has(k)) seen.set(k, { key: k, label: k, color: null })
    return [...seen.values()]
  }, [states, f.states])
  if (stateChips.length === 0 && pins.length === 0 && !active) return null
  return (
    <fieldset className='relative m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 border-b border-[var(--cc-border)] px-3 py-1.5'>
      <legend className='sr-only'>Map filters</legend>
      {stateChips.length > 0 && <span className={`text-[11px] ${FAINT}`}>Step</span>}
      {stateChips.map((s) => {
        const on = f.states.includes(s.key)
        return (
          <button
            key={s.key}
            type='button'
            aria-pressed={on}
            onClick={() => set({ states: toggle(f.states, s.key) })}
            className={chip(on)}
          >
            <span
              className='h-2 w-2 rounded-full'
              style={{ background: s.color ?? MAP_COLORS.ok }}
              aria-hidden='true'
            />
            {s.label}
          </button>
        )
      })}
      <span className={`ml-1 text-[11px] ${FAINT}`}>SLA</span>
      {SLA_CHIPS.map((s) => {
        const on = f.sla.includes(s.key)
        return (
          <button
            key={s.key}
            type='button'
            aria-pressed={on}
            onClick={() => set({ sla: toggle(f.sla, s.key) })}
            className={chip(on)}
          >
            <span
              className='h-2 w-2 rounded-full'
              style={{ background: s.color }}
              aria-hidden='true'
            />
            {s.label}
          </button>
        )
      })}
      <OwnerPicker pins={pins} value={f.owner} onChange={(owner) => set({ owner })} />
      {active && (
        <button
          type='button'
          onClick={() => cc.setFilters(EMPTY_FILTERS)}
          className={cn('ml-auto text-[11px] underline-offset-2 hover:underline', MUTED, FOCUS)}
        >
          Clear filters
        </button>
      )}
    </fieldset>
  )
}

function OwnerPicker({
  pins,
  value,
  onChange
}: {
  pins: GeoPin[]
  value: string | null
  onChange: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [known, setKnown] = useState<Record<string, string>>({})
  const owners = useMemo(() => {
    const count = new Map<string, { id: string; name: string; n: number }>()
    for (const p of pins)
      for (const o of p.owners ?? []) {
        const cur = count.get(o.id) ?? { ...o, n: 0 }
        cur.n++
        count.set(o.id, cur)
      }
    return [...count.values()].sort((a, z) => z.n - a.n || a.name.localeCompare(z.name))
  }, [pins])
  const name = value
    ? (owners.find((o) => o.id === value)?.name ?? known[value] ?? 'Chosen person')
    : null
  if (owners.length === 0 && !value) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={chip(!!value)}
          aria-label={name ? `Owner: ${name}` : 'Filter by owner'}
        >
          {name ? `Owner: ${name}` : 'Any owner'}
          {value ? (
            <X
              className='h-3 w-3'
              aria-hidden='true'
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
              }}
            />
          ) : (
            <ChevronsUpDown className='h-3 w-3' aria-hidden='true' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Find an owner…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              Nobody matches
            </CommandEmpty>
            {owners.map((o) => (
              <CommandItem
                key={o.id}
                value={`${o.name} ${o.id}`}
                onSelect={() => {
                  setKnown((k) => ({ ...k, [o.id]: o.name }))
                  onChange(value === o.id ? null : o.id)
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', value === o.id ? 'opacity-100' : 'opacity-0')}
                />
                <span className='flex-1 truncate'>{o.name}</span>
                <span className='text-[11px] tabular-nums text-muted-foreground'>{o.n}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
