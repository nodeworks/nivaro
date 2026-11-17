// Pieces of the Revision history table that need nothing from the panel itself: the people and
// date filters, a field's value over time, and the column-sets menu. Kept apart so the panel
// file stays readable and these can be tested alone.

import { Bookmark, Check, ChevronsUpDown, Share2, Star, Trash2, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const triggerCls =
  'inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
const idle =
  'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200'
const active = 'border-nvr-cyan/50 bg-nvr-cyan/[0.06] text-slate-800 dark:text-slate-100'

// ─── People ─────────────────────────────────────────────────────────────────

export function PeopleFilter({
  people,
  value,
  onChange
}: {
  people: Array<{ name: string; count: number }>
  value: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const label =
    value.size === 0 ? 'Everyone' : value.size === 1 ? [...value][0] : `${value.size} people`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-revision-people-filter
          className={cn(triggerCls, value.size ? active : idle)}
        >
          <Users className='h-3.5 w-3.5 text-slate-400' />
          <span className='max-w-[160px] truncate'>{label}</span>
          <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[260px] p-1'>
        <div className='max-h-[300px] overflow-y-auto'>
          {people.map((p) => {
            const on = value.has(p.name)
            return (
              <button
                key={p.name}
                type='button'
                onClick={() => {
                  const next = new Set(value)
                  if (on) next.delete(p.name)
                  else next.add(p.name)
                  onChange(next)
                }}
                className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                    on
                      ? 'border-nvr-cyan bg-nvr-cyan text-white'
                      : 'border-slate-300 dark:border-slate-600'
                  )}
                >
                  {on && <Check className='h-3 w-3' />}
                </span>
                <span className='min-w-0 flex-1 truncate'>{p.name}</span>
                <span className='tabular-nums text-[11px] text-slate-400'>{p.count}</span>
              </button>
            )
          })}
        </div>
        {value.size > 0 && (
          <button
            type='button'
            onClick={() => onChange(new Set())}
            className='mt-1 w-full rounded-sm border-t border-slate-100 px-2 py-1.5 text-left text-[11.5px] text-slate-500 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted'
          >
            Show everyone
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─── Dates ──────────────────────────────────────────────────────────────────

export function DateRangeFilter({
  from,
  to,
  onChange
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
}) {
  const input =
    'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
  return (
    <span className='inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-slate-500 dark:text-slate-400'>
      <input
        type='date'
        value={from}
        max={to || undefined}
        onChange={(e) => onChange(e.target.value, to)}
        aria-label='Saves from'
        className={input}
      />
      <span>to</span>
      <input
        type='date'
        value={to}
        min={from || undefined}
        onChange={(e) => onChange(from, e.target.value)}
        aria-label='Saves to'
        className={input}
      />
      {(from || to) && (
        <button
          type='button'
          onClick={() => onChange('', '')}
          aria-label='Clear the dates'
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      )}
    </span>
  )
}

/** Inside [from, to] (YYYY-MM-DD, local days, either open). Exported for tests. */
export function inDateRange(ts: string | null, from: string, to: string): boolean {
  if (!from && !to) return true
  if (!ts) return false
  const t = new Date(ts).getTime()
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false
  return true
}

// ─── A field over time ──────────────────────────────────────────────────────

export interface TrendPoint {
  t: string | null
  v: unknown
  /** The value as the table shows it. */
  text: string
}

/** A field's values oldest → newest: a step chart when they are numbers, else the run of values. */
export function FieldTrend({
  label,
  points,
  onClose
}: {
  label: string
  points: TrendPoint[]
  onClose: () => void
}) {
  const nums = points.map((p) =>
    p.v === null || p.v === undefined || p.v === '' ? null : Number(p.v)
  )
  const numeric = points.length > 1 && nums.every((n) => n === null || Number.isFinite(n))
  // Only the changes, for the non-numeric run.
  const runs = useMemo(() => {
    const out: TrendPoint[] = []
    for (const p of points) if (!out.length || out[out.length - 1].text !== p.text) out.push(p)
    return out
  }, [points])
  const W = 640
  const H = 72
  const pad = 6
  let chart: React.ReactNode = null
  if (numeric) {
    const vals = nums.map((n) => n ?? 0)
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const span = hi - lo || 1
    const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (W - pad * 2)
    const y = (v: number) => H - pad - ((v - lo) / span) * (H - pad * 2)
    let d = `M ${x(0)} ${y(vals[0])}`
    for (let i = 1; i < vals.length; i++) d += ` H ${x(i)} V ${y(vals[i])}`
    // The line stretches to the card's width; the dots are HTML so they stay round.
    chart = (
      <div className='relative h-[72px] w-full'>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio='none'
          className='absolute inset-0 h-full w-full'
          role='img'
          aria-label={`${label} over ${points.length} saves, from ${points[0]?.text || 'empty'} to ${
            points[points.length - 1]?.text || 'empty'
          }`}
        >
          <path
            d={d}
            fill='none'
            className='stroke-nvr-cyan'
            strokeWidth={2}
            vectorEffect='non-scaling-stroke'
          />
        </svg>
        {vals.map((v, i) =>
          i === 0 || v !== vals[i - 1] ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: one dot per save, in order
              key={i}
              data-tip={`${points[i].t ? new Date(points[i].t as string).toLocaleString() : ''} — ${points[i].text}`}
              className='absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-nvr-cyan bg-white dark:bg-card'
              style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(v) / H) * 100}%` }}
            />
          ) : null
        )}
      </div>
    )
  }
  return (
    <div
      className='mb-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
      data-field-trend
    >
      <div className='mb-1 flex items-center gap-2'>
        <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
          {label} over time
        </p>
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          {runs.length - 1} change{runs.length - 1 === 1 ? '' : 's'} · {runs[0]?.text || '—'} →{' '}
          {runs[runs.length - 1]?.text || '—'}
        </span>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close'
          className='ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {numeric ? (
        chart
      ) : (
        <ol className='flex flex-wrap items-center gap-1.5 text-[11.5px]'>
          {runs.map((p, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the run of values, in order
              key={i}
              className='flex items-center gap-1.5'
            >
              {i > 0 && <span className='text-slate-300 dark:text-slate-600'>→</span>}
              <span className='rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 dark:bg-muted dark:text-slate-200'>
                {p.text || '—'}
              </span>
              <span className='tabular-nums text-[10.5px] text-slate-400'>
                {p.t ? new Date(p.t).toLocaleDateString() : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ─── Column sets ────────────────────────────────────────────────────────────

export interface MenuColumnSet {
  id?: string
  name: string
  fields: string[]
  default_roles?: string[]
  is_default?: boolean
}

export function ColumnSetsMenu({
  personal,
  shared,
  roleDefaultName,
  isAdmin,
  roles,
  onApply,
  onSavePersonal,
  onDeletePersonal,
  onShare,
  onDeleteShared,
  onSetDefault
}: {
  personal: MenuColumnSet[]
  shared: MenuColumnSet[]
  roleDefaultName: string | null
  isAdmin: boolean
  roles: Array<{ id: string; name: string }>
  onApply: (fields: string[]) => void
  onSavePersonal: (name: string) => void
  onDeletePersonal: (name: string) => void
  onShare: (name: string, roleIds: string[], forEveryone: boolean) => void
  onDeleteShared: (id: string) => void
  /** Admins: make a shared set the collection's default for everyone (null = none). */
  onSetDefault: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [sharing, setSharing] = useState(false)
  const [shareRoles, setShareRoles] = useState<Set<string>>(new Set())
  const [shareDefault, setShareDefault] = useState(false)
  const row =
    'group/set flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
  const heading = 'px-2 pb-1 pt-2 text-[11px] font-medium text-slate-500 dark:text-slate-400'
  const roleName = (id: string) => roles.find((r) => r.id.toUpperCase() === id)?.name ?? 'a role'
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setName('')
          setSharing(false)
          setShareRoles(new Set())
          setShareDefault(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' data-revision-column-sets className={cn(triggerCls, idle)}>
          <Bookmark className='h-3.5 w-3.5 text-slate-400' />
          Column sets
          <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[320px] p-1'>
        <div className='max-h-[360px] overflow-y-auto'>
          <p className={heading}>Yours</p>
          {personal.length === 0 && (
            <p className='px-2 pb-1 text-[11.5px] text-slate-400'>
              Save the columns you have now to come back to them.
            </p>
          )}
          {personal.map((s) => (
            <div key={s.name} className={row}>
              <button
                type='button'
                className='min-w-0 flex-1 truncate text-left'
                onClick={() => {
                  onApply(s.fields)
                  setOpen(false)
                }}
              >
                {s.name}
                <span className='ml-1.5 text-[11px] text-slate-400'>{s.fields.length}</span>
              </button>
              <button
                type='button'
                aria-label={`Delete ${s.name}`}
                onClick={() => onDeletePersonal(s.name)}
                className='rounded p-0.5 text-slate-400 opacity-0 hover:text-red-600 group-hover/set:opacity-100 focus:opacity-100'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
          ))}
          <p className={heading}>
            Shared{roleDefaultName ? ` · you start with ${roleDefaultName}` : ''}
          </p>
          {shared.length === 0 && (
            <p className='px-2 pb-1 text-[11.5px] text-slate-400'>
              {isAdmin ? 'Share a set so everyone can pick it.' : 'None shared yet.'}
            </p>
          )}
          {shared.map((s) => (
            <div key={s.id ?? s.name} className={row}>
              <button
                type='button'
                className='min-w-0 flex-1 truncate text-left'
                onClick={() => {
                  onApply(s.fields)
                  setOpen(false)
                }}
              >
                {s.name}
                <span className='ml-1.5 text-[11px] text-slate-400'>{s.fields.length}</span>
                {s.is_default && (
                  <span className='ml-1.5 rounded bg-nvr-cyan/10 px-1 py-px text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                    Default
                  </span>
                )}
                {isAdmin && s.default_roles?.length ? (
                  <span className='ml-1.5 text-[10.5px] text-slate-500'>
                    default for {s.default_roles.map(roleName).join(', ')}
                  </span>
                ) : null}
              </button>
              {isAdmin && s.id && (
                <button
                  type='button'
                  aria-pressed={!!s.is_default}
                  aria-label={
                    s.is_default
                      ? `${s.name} is the default for everyone — stop`
                      : `Make ${s.name} the default for everyone`
                  }
                  data-tip={
                    s.is_default
                      ? 'Default for everyone (a role’s own default and a person’s own columns win) — click to stop'
                      : 'Make this the default for everyone'
                  }
                  onClick={() => onSetDefault(s.is_default ? null : (s.id as string))}
                  className={cn(
                    'rounded p-0.5 hover:text-amber-600',
                    s.is_default
                      ? 'text-amber-500'
                      : 'text-slate-400 opacity-0 group-hover/set:opacity-100 focus:opacity-100'
                  )}
                >
                  <Star className={cn('h-3.5 w-3.5', s.is_default && 'fill-current')} />
                </button>
              )}
              {isAdmin && s.id && (
                <button
                  type='button'
                  aria-label={`Delete ${s.name}`}
                  onClick={() => onDeleteShared(s.id as string)}
                  className='rounded p-0.5 text-slate-400 opacity-0 hover:text-red-600 group-hover/set:opacity-100 focus:opacity-100'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className='mt-1 border-t border-slate-100 p-2 dark:border-border/60'>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Name the columns you have now…'
            maxLength={60}
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
            aria-label='Column set name'
          />
          {sharing && (
            <div className='mt-2'>
              <button
                type='button'
                onClick={() => setShareDefault((v) => !v)}
                className='mb-1.5 flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                    shareDefault
                      ? 'border-nvr-cyan bg-nvr-cyan text-white'
                      : 'border-slate-300 dark:border-slate-600'
                  )}
                >
                  {shareDefault && <Check className='h-3 w-3' />}
                </span>
                Default for everyone
              </button>
              <p className='mb-1 text-[11px] text-slate-500 dark:text-slate-400'>
                Default for these roles (optional)
              </p>
              <div className='max-h-[120px] overflow-y-auto'>
                {roles.map((r) => {
                  const on = shareRoles.has(r.id)
                  return (
                    <button
                      key={r.id}
                      type='button'
                      onClick={() => {
                        const next = new Set(shareRoles)
                        if (on) next.delete(r.id)
                        else next.add(r.id)
                        setShareRoles(next)
                      }}
                      className='flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                          on
                            ? 'border-nvr-cyan bg-nvr-cyan text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        )}
                      >
                        {on && <Check className='h-3 w-3' />}
                      </span>
                      {r.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className='mt-2 flex items-center gap-1.5'>
            <button
              type='button'
              disabled={!name.trim()}
              onClick={() => {
                onSavePersonal(name.trim())
                setName('')
              }}
              className='rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40'
            >
              Save for me
            </button>
            {isAdmin &&
              (sharing ? (
                <button
                  type='button'
                  disabled={!name.trim()}
                  onClick={() => {
                    onShare(name.trim(), [...shareRoles], shareDefault)
                    setName('')
                    setSharing(false)
                    setShareRoles(new Set())
                    setShareDefault(false)
                  }}
                  className='inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] text-slate-700 disabled:opacity-40 dark:border-border dark:text-slate-200'
                >
                  <Share2 className='h-3.5 w-3.5' />
                  Share with everyone
                </button>
              ) : (
                <button
                  type='button'
                  onClick={() => setSharing(true)}
                  className='inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
                >
                  <Share2 className='h-3.5 w-3.5' />
                  Share…
                </button>
              ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
