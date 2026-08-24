import { Check, MapPin, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CMSField } from './types'
import { parseJson } from './helpers'
import { Input } from '../ui/input'

/**
 * Field Types & Interfaces sprint — the small structured interfaces:
 * color (#184), rating (#185), duration (#186), range slider (#187),
 * structured address (#206) + geocoding (#208), fiscal period (#207),
 * checklist (#377), date range (#392), countdown chip (#416), input
 * masks (#137), smart date parsing (#138).
 *
 * Cross-field writes (range/date-range end fields, geocoded lat/lng) go
 * through the `nvr:set-field` window event — ItemEditForm listens and routes
 * into handleFieldChange, so rules/visibility/dirty state all apply.
 */

export function setSiblingField(field: string, value: unknown): void {
  window.dispatchEvent(new CustomEvent('nvr:set-field', { detail: { field, value } }))
}

function opts<T>(field: CMSField): T {
  return (parseJson(field.options) ?? {}) as T
}

// ─── Input masks (#137) ──────────────────────────────────────────────────────
// Mask template: # = digit, A = letter, * = any; everything else is a literal
// rendered while typing. STORED value is the raw characters only.
export function applyInputMask(mask: string, raw: string): { display: string; clean: string } {
  const chars = raw.replace(/[^a-zA-Z0-9]/g, '').split('')
  let display = ''
  let clean = ''
  for (const m of mask) {
    if (chars.length === 0) break
    if (m === '#') {
      while (chars.length > 0 && !/\d/.test(chars[0])) chars.shift()
      if (chars.length === 0) break
      const c = chars.shift() as string
      display += c
      clean += c
    } else if (m === 'A') {
      while (chars.length > 0 && !/[a-zA-Z]/.test(chars[0])) chars.shift()
      if (chars.length === 0) break
      const c = chars.shift() as string
      display += c
      clean += c
    } else if (m === '*') {
      const c = chars.shift() as string
      display += c
      clean += c
    } else {
      display += m
    }
  }
  return { display, clean }
}

export function maskFor(field: CMSField): string | null {
  const m = opts<{ input_mask?: string }>(field).input_mask
  return typeof m === 'string' && m.trim() ? m.trim() : null
}

// ─── Smart date entry (#138) ─────────────────────────────────────────────────
// "+30" (days from today), "eom"/"eoy", "today"/"tomorrow", "next friday",
// "friday". Returns yyyy-mm-dd or null when not a shorthand.
export function smartParseDate(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  if (s === 'today') return iso(today)
  if (s === 'tomorrow') return iso(new Date(today.getTime() + 864e5))
  const plus = s.match(/^\+(\d{1,4})$/)
  if (plus) return iso(new Date(today.getTime() + Number(plus[1]) * 864e5))
  if (s === 'eom') return iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))
  if (s === 'eoy') return iso(new Date(today.getFullYear(), 11, 31))
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dm = s.match(/^(?:next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/)
  if (dm) {
    const target = days.findIndex((d) => d.startsWith(dm[1]))
    if (target >= 0) {
      let delta = (target - today.getDay() + 7) % 7
      if (delta === 0 || s.startsWith('next')) delta += delta === 0 ? 7 : 0
      if (delta === 0) delta = 7
      return iso(new Date(today.getTime() + delta * 864e5))
    }
  }
  return null
}

// ─── Color (#184) ────────────────────────────────────────────────────────────
export function ColorField({
  value,
  onChange
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const hex = typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)
    ? value.startsWith('#')
      ? value
      : `#${value}`
    : '#00ceff'
  return (
    <div className='flex items-center gap-2'>
      <input
        type='color'
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        className='h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-0.5'
        aria-label='Pick a color'
      />
      <Input
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder='#00ceff'
        className='w-32 font-mono text-[12.5px]'
      />
      {typeof value === 'string' && (
        <span className='h-6 w-6 rounded-full border border-slate-200' style={{ background: hex }} />
      )}
    </div>
  )
}

// ─── Rating (#185) ───────────────────────────────────────────────────────────
export function RatingField({
  value,
  onChange
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const n = Number(value) || 0
  return (
    <div className='flex items-center gap-1 py-1'>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type='button'
          onClick={() => onChange(i === n ? null : i)}
          aria-label={`${i} star${i === 1 ? '' : 's'}`}
          className='p-0.5'
        >
          <Star
            className={
              i <= n
                ? 'h-5 w-5 fill-amber-400 text-amber-400'
                : 'h-5 w-5 text-slate-300 hover:text-amber-300 dark:text-slate-600'
            }
          />
        </button>
      ))}
      {n > 0 && <span className='ml-1 text-[12px] tabular-nums text-slate-400'>{n}/5</span>}
    </div>
  )
}

// ─── Duration (#186): h:mm entry stored as MINUTES ───────────────────────────
export function DurationField({
  value,
  onChange
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const minutes = Number(value)
  const display = Number.isFinite(minutes) && value != null && value !== ''
    ? `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
    : ''
  const [text, setText] = useState(display)
  useEffect(() => setText(display), [display])
  const commit = () => {
    const t = text.trim()
    if (!t) {
      onChange(null)
      return
    }
    const m = t.match(/^(\d{1,4})(?::([0-5]?\d))?$/)
    if (m) onChange(Number(m[1]) * 60 + Number(m[2] ?? 0))
    else setText(display)
  }
  return (
    <div className='flex items-center gap-2'>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder='h:mm'
        className='w-28 tabular-nums'
      />
      <span className='text-[11.5px] text-slate-400'>
        {Number.isFinite(minutes) && value != null && value !== '' ? `${minutes} min` : 'stored as minutes'}
      </span>
    </div>
  )
}

// ─── Range slider (#187): dual handles, pair via options.range_end_field ────
export function RangeSliderField({
  field,
  value,
  onChange,
  pairedValue
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  pairedValue?: unknown
}) {
  const o = opts<{ range_min?: number; range_max?: number; range_end_field?: string }>(field)
  const min = Number.isFinite(Number(o.range_min)) ? Number(o.range_min) : 0
  const max = Number.isFinite(Number(o.range_max)) ? Number(o.range_max) : 100
  const endField = o.range_end_field
  const lo = Number(value ?? min)
  const hi = Number(pairedValue ?? max)
  return (
    <div className='py-1.5'>
      <div className='flex items-center gap-3'>
        <input
          type='range'
          min={min}
          max={max}
          value={Number.isFinite(lo) ? lo : min}
          onChange={(e) => onChange(Number(e.target.value))}
          className='flex-1 accent-[#00ceff]'
          aria-label={`${field.label ?? field.field} minimum`}
        />
        {endField && (
          <input
            type='range'
            min={min}
            max={max}
            value={Number.isFinite(hi) ? hi : max}
            onChange={(e) => setSiblingField(endField, Number(e.target.value))}
            className='flex-1 accent-[#172940]'
            aria-label={`${field.label ?? field.field} maximum`}
          />
        )}
      </div>
      <p className='mt-1 text-[12px] tabular-nums text-slate-500'>
        {Number.isFinite(lo) ? lo : '—'}
        {endField ? ` – ${Number.isFinite(hi) ? hi : '—'}` : ''}{' '}
        <span className='text-slate-400'>
          (range {min}–{max})
        </span>
      </p>
    </div>
  )
}

// ─── Structured address (#206) + geocoding hook (#208) ───────────────────────
interface AddressValue {
  street?: string
  city?: string
  state?: string
  zip?: string
}
export function AddressField({
  field,
  value,
  onChange,
  apiBase,
  authHeaders
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  apiBase?: string
  authHeaders?: Record<string, string>
}) {
  const o = opts<{ lat_field?: string; lng_field?: string }>(field)
  const addr: AddressValue = (() => {
    if (value && typeof value === 'object') return value as AddressValue
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as AddressValue
      } catch {
        return { street: value }
      }
    }
    return {}
  })()
  const [locating, setLocating] = useState(false)
  const set = (k: keyof AddressValue, v: string) => {
    const next = { ...addr, [k]: v }
    const empty = Object.values(next).every((x) => !x)
    onChange(empty ? null : JSON.stringify(next))
  }
  const geocode = async () => {
    if (!apiBase) return
    setLocating(true)
    try {
      const q = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')
      const res = await fetch(`${apiBase}/geocode`, {
        method: 'POST',
        headers: { ...(authHeaders ?? {}), 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ q })
      })
      const d = (await res.json()) as { data?: { lat?: number; lng?: number } }
      if (d?.data?.lat != null && o.lat_field) setSiblingField(o.lat_field, d.data.lat)
      if (d?.data?.lng != null && o.lng_field) setSiblingField(o.lng_field, d.data.lng)
    } catch {
      /* geocode is best-effort */
    } finally {
      setLocating(false)
    }
  }
  return (
    <div className='space-y-1.5'>
      <Input
        value={addr.street ?? ''}
        onChange={(e) => set('street', e.target.value)}
        placeholder='Street address'
      />
      <div className='flex gap-1.5'>
        <Input
          value={addr.city ?? ''}
          onChange={(e) => set('city', e.target.value)}
          placeholder='City'
          className='flex-1'
        />
        <Input
          value={addr.state ?? ''}
          onChange={(e) => set('state', e.target.value)}
          placeholder='State'
          className='w-20'
        />
        <Input
          value={addr.zip ?? ''}
          onChange={(e) => set('zip', e.target.value)}
          placeholder='ZIP'
          className='w-24'
        />
      </div>
      {(o.lat_field || o.lng_field) && (
        <button
          type='button'
          onClick={() => void geocode()}
          disabled={locating}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-300'
        >
          <MapPin className='h-3 w-3 text-nvr-cyan' />
          {locating ? 'Locating…' : 'Fill coordinates from address'}
        </button>
      )}
    </div>
  )
}

// ─── Fiscal period (#207): FY + quarter, stored "FY2026-Q1" (sorts correctly) ─
export function FiscalPeriodField({
  value,
  onChange
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const m = typeof value === 'string' ? value.match(/^FY(\d{4})-Q([1-4])$/) : null
  const year = m ? Number(m[1]) : new Date().getFullYear()
  const quarter = m ? Number(m[2]) : 1
  const commit = (y: number, q: number) => onChange(`FY${y}-Q${q}`)
  const years = Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 3 + i)
  return (
    <div className='flex items-center gap-1.5'>
      <div className='flex overflow-hidden rounded-md border border-input'>
        {years.slice(2, 6).map((y) => (
          <button
            key={y}
            type='button'
            onClick={() => commit(y, quarter)}
            className={
              m && year === y
                ? 'bg-nvr-cyan/10 px-2 py-1.5 text-[12px] font-semibold text-nvr-navy dark:text-nvr-cyan'
                : 'px-2 py-1.5 text-[12px] text-slate-500 hover:bg-muted'
            }
          >
            FY{String(y).slice(2)}
          </button>
        ))}
      </div>
      <div className='flex overflow-hidden rounded-md border border-input'>
        {[1, 2, 3, 4].map((q) => (
          <button
            key={q}
            type='button'
            onClick={() => commit(year, q)}
            className={
              m && quarter === q
                ? 'bg-nvr-cyan/10 px-2 py-1.5 text-[12px] font-semibold text-nvr-navy dark:text-nvr-cyan'
                : 'px-2 py-1.5 text-[12px] text-slate-500 hover:bg-muted'
            }
          >
            Q{q}
          </button>
        ))}
      </div>
      {m && (
        <button
          type='button'
          onClick={() => onChange(null)}
          className='px-1 text-[12px] text-slate-400 hover:text-red-500'
          aria-label='Clear fiscal period'
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Checklist (#377): [{text, done}] with completion chip ───────────────────
export function ChecklistField({
  value,
  onChange
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const items: Array<{ text: string; done: boolean }> = (() => {
    const raw = typeof value === 'string' ? (() => {
      try {
        return JSON.parse(value)
      } catch {
        return []
      }
    })() : value
    return Array.isArray(raw)
      ? raw.filter((x) => x && typeof x.text === 'string').map((x) => ({ text: x.text, done: !!x.done }))
      : []
  })()
  const [input, setInput] = useState('')
  const commit = (next: Array<{ text: string; done: boolean }>) =>
    onChange(next.length > 0 ? JSON.stringify(next) : null)
  const done = items.filter((i) => i.done).length
  return (
    <div className='rounded-md border border-input bg-background p-2'>
      {items.length > 0 && (
        <p className='mb-1.5 text-[11px] tabular-nums text-slate-400'>
          <span
            className={
              done === items.length
                ? 'rounded-full bg-emerald-100 px-1.5 py-px font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'rounded-full bg-slate-100 px-1.5 py-px font-medium text-slate-500 dark:bg-muted'
            }
          >
            {done}/{items.length} done
          </span>
        </p>
      )}
      <ul className='space-y-1'>
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list editor
          <li key={i} className='group flex items-center gap-2'>
            <button
              type='button'
              onClick={() => commit(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}
              className={
                it.done
                  ? 'flex h-4 w-4 items-center justify-center rounded border border-emerald-500 bg-emerald-500'
                  : 'h-4 w-4 rounded border border-slate-300 hover:border-nvr-cyan dark:border-slate-600'
              }
              aria-label={it.done ? 'Mark not done' : 'Mark done'}
            >
              {it.done && <Check className='h-3 w-3 text-white' />}
            </button>
            <span
              className={
                it.done
                  ? 'flex-1 text-[13px] text-slate-400 line-through'
                  : 'flex-1 text-[13px] text-slate-700 dark:text-slate-200'
              }
            >
              {it.text}
            </span>
            <button
              type='button'
              onClick={() => commit(items.filter((_, j) => j !== i))}
              className='hidden text-slate-300 hover:text-red-500 group-hover:inline'
              aria-label={`Remove ${it.text}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            e.preventDefault()
            commit([...items, { text: input.trim(), done: false }])
            setInput('')
          }
        }}
        placeholder='＋ Add item and press Enter'
        className='mt-1.5 h-7 w-full rounded border border-dashed border-slate-200 bg-transparent px-2 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border'
      />
    </div>
  )
}

// ─── Date range (#392): from/to on paired date columns ───────────────────────
export function DateRangeField({
  field,
  value,
  onChange,
  pairedValue
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  pairedValue?: unknown
}) {
  const endField = opts<{ range_end_field?: string }>(field).range_end_field
  const toDateStr = (v: unknown) =>
    typeof v === 'string' && v ? v.slice(0, 10) : ''
  return (
    <div className='flex items-center gap-2'>
      <Input
        type='date'
        value={toDateStr(value)}
        onChange={(e) => onChange(e.target.value || null)}
        className='w-40'
      />
      <span className='text-slate-400'>→</span>
      {endField ? (
        <Input
          type='date'
          value={toDateStr(pairedValue)}
          onChange={(e) => setSiblingField(endField, e.target.value || null)}
          className='w-40'
        />
      ) : (
        <span className='text-[11.5px] text-amber-600'>set options.range_end_field</span>
      )}
    </div>
  )
}

// ─── Countdown chip (#416): live T-minus for any date value ──────────────────
export function CountdownChip({ value }: { value: unknown }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  if (typeof value !== 'string' || !value) return null
  const target = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(target.getTime())) return null
  const diffMs = target.getTime() - Date.now()
  const past = diffMs < 0
  const abs = Math.abs(diffMs)
  const days = Math.floor(abs / 864e5)
  const hours = Math.floor((abs % 864e5) / 36e5)
  const label = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((abs % 36e5) / 6e4)}m`
  return (
    <span
      className={
        past
          ? 'ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-red-700 dark:bg-red-500/15 dark:text-red-300'
          : days < 3
            ? 'ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
            : 'ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-muted-foreground'
      }
      data-tip={target.toLocaleString()}
    >
      {past ? `T+${label}` : `T−${label}`}
    </span>
  )
}

// ─── Repeater (#141): schema-driven row list with reorder + collapse ─────────
// Rows follow nivaro_fields.repeater_schema ([{key, label, type}]); the value
// is a JSON array stored in the field's own column.
export function RepeaterField({
  field,
  value,
  onChange
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const schema: Array<{ key: string; label?: string; type?: string }> = (() => {
    const raw = parseJson(field.repeater_schema as string | null)
    return Array.isArray(raw) ? (raw as Array<{ key: string }>) : []
  })()
  const rows: Array<Record<string, unknown>> = (() => {
    const raw = typeof value === 'string' ? parseJson(value) : value
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  })()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const commit = (next: Array<Record<string, unknown>>) =>
    onChange(next.length > 0 ? JSON.stringify(next) : null)
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }
  if (schema.length === 0)
    return <p className='text-[12px] text-amber-600'>No repeater schema configured.</p>
  return (
    <div className='space-y-1.5'>
      {rows.map((row, i) => {
        const isCollapsed = collapsed.has(i)
        const summary = schema
          .slice(0, 2)
          .map((c) => String(row[c.key] ?? ''))
          .filter(Boolean)
          .join(' · ')
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
          <div key={i} className='rounded-md border border-slate-200 dark:border-border'>
            <div className='flex items-center gap-1 border-b border-slate-100 bg-slate-50 px-2 py-1 dark:border-border/60 dark:bg-muted/40'>
              <button
                type='button'
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(i)) next.delete(i)
                    else next.add(i)
                    return next
                  })
                }
                className='text-[11px] text-slate-400 hover:text-slate-600'
                aria-label={isCollapsed ? 'Expand row' : 'Collapse row'}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <span className='min-w-0 flex-1 truncate text-[11.5px] text-slate-500'>
                {isCollapsed ? summary || `Row ${i + 1}` : `Row ${i + 1}`}
              </span>
              <button
                type='button'
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className='px-1 text-[12px] text-slate-400 hover:text-slate-700 disabled:opacity-30'
                aria-label='Move up'
              >
                ↑
              </button>
              <button
                type='button'
                onClick={() => move(i, 1)}
                disabled={i === rows.length - 1}
                className='px-1 text-[12px] text-slate-400 hover:text-slate-700 disabled:opacity-30'
                aria-label='Move down'
              >
                ↓
              </button>
              <button
                type='button'
                onClick={() => commit(rows.filter((_, j) => j !== i))}
                className='px-1 text-[12px] text-slate-400 hover:text-red-500'
                aria-label='Remove row'
              >
                ×
              </button>
            </div>
            {!isCollapsed && (
              <div className='grid grid-cols-2 gap-1.5 p-2'>
                {schema.map((col) => (
                  <label key={col.key} className='block'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      {col.label ?? col.key}
                    </span>
                    {col.type === 'boolean' ? (
                      <input
                        type='checkbox'
                        checked={row[col.key] === true}
                        onChange={(e) =>
                          commit(rows.map((r, j) => (j === i ? { ...r, [col.key]: e.target.checked } : r)))
                        }
                        className='mt-1 block h-4 w-4 accent-[#00ceff]'
                      />
                    ) : (
                      <Input
                        type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                        value={String(row[col.key] ?? '')}
                        onChange={(e) =>
                          commit(
                            rows.map((r, j) =>
                              j === i
                                ? {
                                    ...r,
                                    [col.key]:
                                      col.type === 'number'
                                        ? e.target.value === ''
                                          ? null
                                          : Number(e.target.value)
                                        : e.target.value
                                  }
                                : r
                            )
                          )
                        }
                        className='mt-0.5 h-7 text-[12.5px]'
                      />
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <button
        type='button'
        onClick={() => commit([...rows, {}])}
        className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-muted dark:border-border'
      >
        ＋ Add row
      </button>
    </div>
  )
}
