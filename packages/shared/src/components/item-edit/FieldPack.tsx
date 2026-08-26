import { Check, Loader2, MapPin, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CMSField } from './types'
import { parseJson } from './helpers'
import { setSiblingField } from './PolishFields'
import { formatPhone, normalizePhone } from '../../lib/validation-rules'
import { Input } from '../ui/input'

/**
 * Field interface pack (#663 / #520 / #518):
 *   progress  — int 0-100, slider + % readout
 *   rating    — 1..N stars (options.rating_max, default 5)
 *   color     — preset swatch grid + hex input + native picker
 *   phone     — NANP/international normalizer, blur validation, E.164-ish store
 *   email     — type=email input with blur validation
 *   address-autocomplete — Nominatim suggestions via POST /geocode/suggest,
 *     stores display_name; options.address_latlng_fields = {lat, lng} writes
 *     the picked coordinates onto sibling fields via the nvr:set-field event
 *     (ItemEditForm already listens — same channel as range/date-range/geocode).
 *
 * Read-only twins for the structured interfaces live here too so FieldRenderer's
 * readonly branch shows a real rendering instead of raw JSON/numbers.
 */

function fieldOpts<T>(field: CMSField): T {
  return (parseJson(field.options) ?? {}) as T
}

// ─── Progress (#663) ─────────────────────────────────────────────────────────

export function ProgressField({
  value,
  onChange,
  readOnly
}: {
  value: unknown
  onChange: (v: unknown) => void
  readOnly?: boolean
}) {
  const n = Math.max(0, Math.min(100, Number(value)))
  const pct = Number.isFinite(n) && value != null && value !== '' ? Math.round(n) : null
  return (
    <div className='flex min-h-[36px] items-center gap-3 py-1'>
      {readOnly ? (
        <span className='relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
          <span
            className='absolute inset-y-0 left-0 rounded-full bg-nvr-cyan'
            style={{ width: `${pct ?? 0}%` }}
          />
        </span>
      ) : (
        <input
          type='range'
          min={0}
          max={100}
          step={1}
          value={pct ?? 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className='flex-1 accent-[#00ceff]'
          aria-label='Progress percentage'
        />
      )}
      <span className='w-12 text-right text-[12px] tabular-nums text-slate-500 dark:text-slate-400'>
        {pct === null ? '—' : `${pct}%`}
      </span>
      {!readOnly && pct !== null && (
        <button
          type='button'
          onClick={() => onChange(null)}
          className='px-1 text-[12px] text-slate-400 hover:text-red-500'
          aria-label='Clear progress'
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Rating with configurable max (#663) ─────────────────────────────────────

export function RatingScaleField({
  value,
  onChange,
  max = 5,
  readOnly
}: {
  value: unknown
  onChange: (v: unknown) => void
  max?: number
  readOnly?: boolean
}) {
  const limit = Number.isFinite(Number(max)) && Number(max) >= 2 ? Math.min(10, Number(max)) : 5
  const n = Number(value) || 0
  return (
    <div className='flex min-h-[36px] items-center gap-1 py-1'>
      {Array.from({ length: limit }, (_, i) => i + 1).map((i) => (
        <button
          key={i}
          type='button'
          disabled={readOnly}
          onClick={() => !readOnly && onChange(i === n ? null : i)}
          aria-label={`${i} star${i === 1 ? '' : 's'}`}
          className='p-0.5 disabled:cursor-default'
        >
          <Star
            className={
              i <= n
                ? 'h-5 w-5 fill-amber-400 text-amber-400'
                : readOnly
                  ? 'h-5 w-5 text-slate-200 dark:text-slate-700'
                  : 'h-5 w-5 text-slate-300 hover:text-amber-300 dark:text-slate-600'
            }
          />
        </button>
      ))}
      {n > 0 && (
        <span className='ml-1 text-[12px] tabular-nums text-slate-400'>
          {n}/{limit}
        </span>
      )}
    </div>
  )
}

// ─── Color with swatch grid (#663) ───────────────────────────────────────────

const DEFAULT_SWATCHES = [
  '#00ceff',
  '#172940',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b'
]

export function ColorPackField({
  field,
  value,
  onChange,
  readOnly
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  readOnly?: boolean
}) {
  const presets = fieldOpts<{ presets?: string[] }>(field).presets
  const swatches = (Array.isArray(presets) && presets.length > 0 ? presets : DEFAULT_SWATCHES)
    .map((s) => String(s).trim())
    .filter((s) => /^#?[0-9a-f]{3,8}$/i.test(s))
    .map((s) => (s.startsWith('#') ? s : `#${s}`))
  const current = typeof value === 'string' ? value : ''
  const hex = /^#?[0-9a-f]{6}$/i.test(current)
    ? current.startsWith('#')
      ? current
      : `#${current}`
    : '#00ceff'
  if (readOnly) {
    return (
      <div className='flex min-h-[36px] items-center gap-2'>
        {current ? (
          <>
            <span
              className='h-5 w-5 rounded-full border border-slate-200 dark:border-border'
              style={{ background: hex }}
            />
            <span className='font-mono text-[12.5px] text-slate-600 dark:text-slate-300'>
              {current}
            </span>
          </>
        ) : (
          <span className='text-sm italic text-muted-foreground'>—</span>
        )}
      </div>
    )
  }
  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap items-center gap-1'>
        {swatches.map((sw) => (
          <button
            key={sw}
            type='button'
            onClick={() => onChange(sw)}
            aria-label={`Pick ${sw}`}
            className={
              current.toLowerCase() === sw.toLowerCase()
                ? 'flex h-6 w-6 items-center justify-center rounded-full ring-2 ring-nvr-cyan ring-offset-1 ring-offset-background'
                : 'h-6 w-6 rounded-full border border-black/10 hover:scale-110 dark:border-white/15'
            }
            style={{ background: sw }}
          >
            {current.toLowerCase() === sw.toLowerCase() && (
              <Check className='h-3 w-3 text-white drop-shadow' />
            )}
          </button>
        ))}
      </div>
      <div className='flex items-center gap-2'>
        <input
          type='color'
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className='h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-0.5'
          aria-label='Pick a custom color'
        />
        <Input
          value={current}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder='#00ceff'
          className='w-32 font-mono text-[12.5px]'
        />
        {current && (
          <span
            className='h-6 w-6 rounded-full border border-slate-200 dark:border-border'
            style={{ background: hex }}
          />
        )}
      </div>
    </div>
  )
}

// ─── Phone (#520) ────────────────────────────────────────────────────────────

export function PhoneField({
  value,
  onChange,
  placeholder,
  readOnly
}: {
  value: unknown
  onChange: (v: unknown) => void
  placeholder?: string
  readOnly?: boolean
}) {
  // Local text while typing; normalize + store on blur. The stored value is
  // the E.164-ish digit form; the input shows the friendly display form.
  const stored = typeof value === 'string' ? value : value == null ? '' : String(value)
  const [text, setText] = useState(() => (stored ? formatPhone(stored) : ''))
  const [error, setError] = useState<string | null>(null)
  const prevStored = useRef(stored)
  useEffect(() => {
    if (prevStored.current !== stored) {
      prevStored.current = stored
      setText(stored ? formatPhone(stored) : '')
      setError(null)
    }
  }, [stored])
  if (readOnly) {
    return (
      <div className='flex min-h-[36px] items-center'>
        {stored ? (
          <span className='text-sm tabular-nums'>{formatPhone(stored)}</span>
        ) : (
          <span className='text-sm italic text-muted-foreground'>—</span>
        )}
      </div>
    )
  }
  const commit = () => {
    const n = normalizePhone(text)
    if (!text.trim()) {
      setError(null)
      if (stored) onChange(null)
      return
    }
    if (n.valid) {
      setError(null)
      setText(n.display)
      if (n.stored !== stored) onChange(n.stored)
    } else {
      setError('Enter a valid phone number — e.g. (312) 555-0100 or +44 20 7946 0958')
      if (n.stored !== stored) onChange(n.stored)
    }
  }
  return (
    <div>
      <Input
        type='tel'
        inputMode='tel'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder={placeholder ?? '+1 (___) ___-____'}
        className={error ? 'border-red-400 focus-visible:ring-red-400' : undefined}
        aria-invalid={!!error}
      />
      {error && <p className='mt-0.5 text-[11px] text-red-500'>{error}</p>}
    </div>
  )
}

// ─── Email (#520) ────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function EmailField({
  value,
  onChange,
  placeholder
}: {
  value: unknown
  onChange: (v: unknown) => void
  placeholder?: string
}) {
  const strVal = value == null ? '' : String(value)
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <Input
        type='email'
        inputMode='email'
        autoComplete='off'
        value={strVal}
        onChange={(e) => {
          onChange(e.target.value || null)
          if (error) setError(null)
        }}
        onBlur={(e) => {
          const v = e.target.value.trim()
          setError(v && !EMAIL_RE.test(v) ? 'Enter a valid email address' : null)
        }}
        placeholder={placeholder ?? 'name@example.com'}
        className={error ? 'border-red-400 focus-visible:ring-red-400' : undefined}
        aria-invalid={!!error}
      />
      {error && <p className='mt-0.5 text-[11px] text-red-500'>{error}</p>}
    </div>
  )
}

// ─── Address autocomplete (#518) ─────────────────────────────────────────────

type AddressSuggestion = { display_name: string; lat?: string; lon?: string }

export function AddressAutocompleteField({
  field,
  value,
  onChange,
  apiBase,
  authHeaders,
  credentials,
  placeholder
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  apiBase?: string
  authHeaders?: Record<string, string>
  credentials?: RequestCredentials
  placeholder?: string
}) {
  const latLng = fieldOpts<{ address_latlng_fields?: { lat?: string; lng?: string } }>(
    field
  ).address_latlng_fields
  const strVal = value == null ? '' : String(value)
  const [text, setText] = useState(strVal)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const prevValue = useRef(strVal)
  useEffect(() => {
    if (prevValue.current !== strVal) {
      prevValue.current = strVal
      setText(strVal)
    }
  }, [strVal])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const fetchSuggestions = (q: string) => {
    if (!apiBase || q.trim().length < 4) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    fetch(`${apiBase}/geocode/suggest`, {
      method: 'POST',
      headers: { ...(authHeaders ?? {}), 'content-type': 'application/json' },
      credentials: credentials ?? 'include',
      body: JSON.stringify({ q: q.trim() })
    })
      .then((r) => r.json())
      .then((d: { data?: AddressSuggestion[] }) => {
        if (seq !== seqRef.current) return
        const rows = Array.isArray(d?.data) ? d.data : []
        setSuggestions(rows)
        setOpen(rows.length > 0)
      })
      .catch(() => {
        /* suggestions are best-effort */
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false)
      })
  }
  const onInput = (v: string) => {
    setText(v)
    onChange(v || null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 300)
  }
  const pick = (s: AddressSuggestion) => {
    setText(s.display_name)
    onChange(s.display_name)
    setOpen(false)
    setSuggestions([])
    // Sibling coordinate fields via nvr:set-field — ItemEditForm routes it
    // through handleFieldChange so rules/visibility/dirty state all apply.
    const lat = Number(s.lat)
    const lng = Number(s.lon)
    if (latLng?.lat && Number.isFinite(lat)) setSiblingField(latLng.lat, lat)
    if (latLng?.lng && Number.isFinite(lng)) setSiblingField(latLng.lng, lng)
  }
  return (
    <div ref={rootRef} className='relative'>
      <div className='relative'>
        <Input
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder={placeholder ?? 'Start typing an address…'}
          autoComplete='off'
        />
        <span className='pointer-events-none absolute inset-y-0 right-2 flex items-center'>
          {loading ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />
          ) : (
            <MapPin className='h-3.5 w-3.5 text-slate-300 dark:text-slate-600' />
          )}
        </span>
      </div>
      {open && suggestions.length > 0 && (
        <div className='absolute left-0 right-0 z-[60] mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-background py-1 shadow-lg dark:border-border'>
          {suggestions.map((s) => (
            <button
              key={s.display_name}
              type='button'
              onClick={() => pick(s)}
              className='flex w-full items-start gap-1.5 px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
            >
              <MapPin className='mt-0.5 h-3 w-3 shrink-0 text-nvr-cyan' />
              <span className='min-w-0 flex-1'>{s.display_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Read-only twins for the PolishFields interfaces ─────────────────────────

export function DurationReadOnly({ value }: { value: unknown }) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || value == null || value === '') {
    return (
      <div className='flex min-h-[36px] items-center'>
        <span className='text-sm italic text-muted-foreground'>—</span>
      </div>
    )
  }
  return (
    <div className='flex min-h-[36px] items-center gap-2'>
      <span className='text-sm tabular-nums'>
        {Math.floor(minutes / 60)}:{String(Math.round(minutes % 60)).padStart(2, '0')}
      </span>
      <span className='text-[11.5px] text-slate-400'>({minutes} min)</span>
    </div>
  )
}

export function ChecklistReadOnly({ value }: { value: unknown }) {
  const items: Array<{ text: string; done: boolean }> = (() => {
    const raw =
      typeof value === 'string'
        ? (() => {
            try {
              return JSON.parse(value)
            } catch {
              return []
            }
          })()
        : value
    return Array.isArray(raw)
      ? raw
          .filter((x) => x && typeof x.text === 'string')
          .map((x) => ({ text: x.text, done: !!x.done }))
      : []
  })()
  if (items.length === 0) {
    return (
      <div className='flex min-h-[36px] items-center'>
        <span className='text-sm italic text-muted-foreground'>—</span>
      </div>
    )
  }
  const done = items.filter((i) => i.done).length
  return (
    <div className='py-1'>
      <p className='mb-1 text-[11px] tabular-nums text-slate-400'>
        {done}/{items.length} done
      </p>
      <ul className='space-y-0.5'>
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional static list
          <li key={i} className='flex items-center gap-2'>
            <span
              className={
                it.done
                  ? 'flex h-3.5 w-3.5 items-center justify-center rounded border border-emerald-500 bg-emerald-500'
                  : 'h-3.5 w-3.5 rounded border border-slate-300 dark:border-slate-600'
              }
            >
              {it.done && <Check className='h-2.5 w-2.5 text-white' />}
            </span>
            <span
              className={
                it.done
                  ? 'text-[13px] text-slate-400 line-through'
                  : 'text-[13px] text-slate-700 dark:text-slate-200'
              }
            >
              {it.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
