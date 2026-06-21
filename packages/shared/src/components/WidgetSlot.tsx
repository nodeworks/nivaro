import { useEffect, useState } from 'react'

export interface InputBinding {
  key: string
  binding_type: 'item_field' | 'static' | 'url_param'
  binding_value: string
}

function StripCell({ label, value, display, loading }: {
  label: string
  value?: unknown
  display: Record<string, unknown>
  loading?: boolean
}) {
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = loading ? null : formatStatValue(value, (display.format ?? '') as string)
  return (
    <div className='flex flex-col justify-start px-4 py-2.5 min-w-0 gap-1'>
      <span className='text-[9px] font-medium uppercase tracking-wider leading-none truncate text-slate-400 dark:text-slate-500'>{label}</span>
      <span className='flex items-baseline gap-0.5 text-[13px] font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-100'>
        {loading ? (
          <span className='animate-pulse inline-block h-3.5 w-16 rounded bg-slate-200 dark:bg-slate-700' />
        ) : (
          <>
            {prefix && <span className='text-[11px] text-slate-500 dark:text-slate-400'>{prefix}</span>}
            {formatted}
            {suffix && <span className='text-[11px] text-slate-500 dark:text-slate-400'>{suffix}</span>}
          </>
        )}
      </span>
    </div>
  )
}

function StripDisplay({ data, label, loading, widgetConfig }: {
  data: Record<string, unknown> | null
  label: string
  loading?: boolean
  widgetConfig?: Record<string, unknown> | null
}) {
  const wrapper = 'flex items-stretch divide-x divide-slate-200 dark:divide-border border-r border-slate-200 dark:border-border'

  if (data && 'values' in data) {
    const values = (data.values ?? []) as Array<{ value: unknown; label: string; display: Record<string, unknown> }>
    if (values.length === 0) return null
    return (
      <div className={wrapper}>
        {values.map((v, i) => (
          <StripCell key={i} label={v.label} value={v.value} display={v.display ?? {}} loading={false} />
        ))}
      </div>
    )
  }

  if (loading) {
    const vf = (widgetConfig?.value_fields as Array<{ label?: string; prefix?: string; suffix?: string; format?: string }> | undefined) ?? []
    const sections = vf.length > 0 ? vf : [{ label }]
    return (
      <div className={wrapper}>
        {sections.map((v, i) => (
          <StripCell
            key={i}
            label={v.label ?? label}
            display={{ prefix: v.prefix ?? '', suffix: v.suffix ?? '', format: v.format ?? '' }}
            loading={true}
          />
        ))}
      </div>
    )
  }

  if (!data) return null
  const display = (data.display ?? {}) as Record<string, unknown>
  return (
    <div className={wrapper}>
      <StripCell label={label} value={data.value} display={display} loading={false} />
    </div>
  )
}

interface WidgetSlotProps {
  widgetId: number
  inputBindings?: InputBinding[]
  itemDraft?: Record<string, unknown>
  itemCollection?: string
  ready?: boolean
  label?: string
  defaultExpanded?: boolean
  apiBase?: string
  compact?: boolean
  strip?: boolean
}

function resolveDraftPath(draft: Record<string, unknown>, path: string): unknown {
  // Try exact key first (simple field names with no dots)
  if (Object.prototype.hasOwnProperty.call(draft, path)) return draft[path] ?? null
  // Walk dotted path — if we hit a scalar mid-path (M2O FK value), return it directly
  const parts = path.split('.')
  let val: unknown = draft
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return val ?? null
    val = (val as Record<string, unknown>)[p]
  }
  return val ?? null
}

function resolveInputs(bindings: InputBinding[], draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const b of bindings) {
    if (b.binding_type === 'item_field') {
      out[b.key] = resolveDraftPath(draft, b.binding_value)
    } else if (b.binding_type === 'static') {
      out[b.key] = b.binding_value
    } else if (b.binding_type === 'url_param') {
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search)
        out[b.key] = sp.get(b.binding_value) ?? null
      }
    }
  }
  return out
}

interface WidgetDef {
  id: number
  name: string
  widget_type: string
  inputs: Array<{ key: string; label: string; type: string; required?: boolean }> | null
  config: ({ compact_style?: string } & Record<string, unknown>) | null
}

function StatDisplay({ data }: { data: Record<string, unknown> }) {
  const display = (data.display ?? {}) as Record<string, unknown>
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = formatStatValue(data.value, (display.format ?? '') as string)
  return (
    <div className='flex items-baseline gap-1'>
      {prefix && <span className='text-[13px] text-slate-500'>{prefix}</span>}
      <span className='text-2xl font-semibold text-slate-900 dark:text-slate-100'>{formatted}</span>
      {suffix && <span className='text-[13px] text-slate-500'>{suffix}</span>}
    </div>
  )
}

function PillSection({ label, value, display, dark, loading }: {
  label: string
  value?: unknown
  display: Record<string, unknown>
  dark: boolean
  loading?: boolean
}) {
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = loading ? null : formatStatValue(value, (display.format ?? '') as string)
  return (
    <div className='flex flex-col justify-center px-2.5 py-1 min-w-0 gap-0.5'>
      <span className={`text-[9px] font-medium uppercase tracking-wider leading-none truncate ${dark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</span>
      <span className={`flex items-baseline gap-0.5 text-[13px] font-semibold tabular-nums leading-none ${dark ? 'text-slate-100' : 'text-slate-900'}`}>
        {loading ? (
          <span className={`animate-pulse inline-block h-3 w-14 rounded ${dark ? 'bg-slate-600' : 'bg-slate-200'}`} />
        ) : (
          <>
            {prefix && <span className={`text-[10px] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{prefix}</span>}
            {formatted}
            {suffix && <span className={`text-[10px] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{suffix}</span>}
          </>
        )}
      </span>
    </div>
  )
}

function PillDisplay({ data, label, style, loading, widgetConfig }: {
  data: Record<string, unknown> | null
  label: string
  style: 'pill-dark' | 'pill-light'
  loading?: boolean
  widgetConfig?: Record<string, unknown> | null
}) {
  const dark = style === 'pill-dark'
  const base = dark
    ? 'flex items-stretch divide-x divide-slate-700 rounded-md bg-slate-800/90 border border-slate-700 overflow-hidden'
    : 'flex items-stretch divide-x divide-slate-200 rounded-md bg-white border border-slate-200 overflow-hidden dark:bg-card dark:border-border dark:divide-border'

  // Multi-value — use render data if available, else fall back to config value_fields for skeleton labels
  if (data && 'values' in data) {
    const values = (data.values ?? []) as Array<{ value: unknown; label: string; display: Record<string, unknown> }>
    if (values.length === 0) return null
    return (
      <div className={base}>
        {values.map((v, i) => (
          <PillSection key={i} label={v.label} value={v.value} display={v.display ?? {}} dark={dark} loading={false} />
        ))}
      </div>
    )
  }

  if (loading) {
    // Skeleton: derive sections from widget config value_fields
    const vf = (widgetConfig?.value_fields as Array<{ label?: string; prefix?: string; suffix?: string; format?: string }> | undefined) ?? []
    const sections = vf.length > 0 ? vf : [{ label }]
    return (
      <div className={base}>
        {sections.map((v, i) => (
          <PillSection
            key={i}
            label={v.label ?? label}
            display={{ prefix: v.prefix ?? '', suffix: v.suffix ?? '', format: v.format ?? '' }}
            dark={dark}
            loading={true}
          />
        ))}
      </div>
    )
  }

  if (!data) return null
  const display = (data.display ?? {}) as Record<string, unknown>
  return (
    <div className={base}>
      <PillSection label={label} value={data.value} display={display} dark={dark} loading={false} />
    </div>
  )
}

function formatStatValue(value: unknown, format: string): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    if (format === 'currency') return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    if (format === 'integer') return new Intl.NumberFormat().format(Math.round(value))
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
  return String(value)
}

function MultiStatDisplay({ data }: { data: Record<string, unknown> }) {
  const values = (data.values ?? []) as Array<{ value: unknown; label: string; display: Record<string, unknown> }>
  if (values.length === 0) return <p className='text-[12px] text-slate-400'>No values</p>
  return (
    <div className='grid gap-3' style={{ gridTemplateColumns: `repeat(${Math.min(values.length, 3)}, minmax(0, 1fr))` }}>
      {values.map((v, i) => {
        const prefix = (v.display?.prefix ?? '') as string
        const suffix = (v.display?.suffix ?? '') as string
        const format = (v.display?.format ?? '') as string
        return (
          <div key={i} className='flex flex-col gap-0.5'>
            {v.label && <span className='text-[11px] text-slate-400 dark:text-slate-500'>{v.label}</span>}
            <div className='flex items-baseline gap-0.5'>
              {prefix && <span className='text-[12px] text-slate-500'>{prefix}</span>}
              <span className='text-xl font-semibold text-slate-900 dark:text-slate-100'>{formatStatValue(v.value, format)}</span>
              {suffix && <span className='text-[12px] text-slate-500'>{suffix}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ListDisplay({ data }: { data: Record<string, unknown> }) {
  const rows = (data.rows ?? []) as Array<Record<string, unknown>>
  const fields = (data.fields ?? []) as string[]
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>No items</p>
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='border-b border-slate-100'>
            {fields.map(f => <th key={f} className='py-1 pr-3 text-left font-medium text-slate-500'>{f}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className='border-b border-slate-50'>
              {fields.map(f => <td key={f} className='py-1 pr-3 text-slate-700'>{String(row[f] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ActionButtonsDisplay({ data, widgetId, inputs, apiBase, onAction }: {
  data: Record<string, unknown>
  widgetId: number
  inputs: Record<string, unknown>
  apiBase: string
  onAction?: (result: unknown) => void
}) {
  const buttons = (data.buttons ?? []) as Array<Record<string, unknown>>
  const [loading, setLoading] = useState<number | null>(null)

  const handleClick = async (idx: number) => {
    setLoading(idx)
    try {
      const workspace = typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const res = await fetch(`${apiBase}/widgets-internal/${widgetId}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(workspace ? { 'x-workspace': workspace } : {})
        },
        credentials: 'include',
        body: JSON.stringify({ button_index: idx, inputs })
      })
      const json = await res.json() as { data: unknown }
      const result = json.data as Record<string, unknown>
      if (result?.redirect_url) {
        try {
          const u = new URL(result.redirect_url as string, window.location.origin)
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            window.location.href = u.toString()
          }
        } catch { /* invalid URL — ignore */ }
      }
      onAction?.(result)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className='flex flex-wrap gap-2'>
      {buttons.map((btn, i) => {
        const style = (btn.style ?? 'secondary') as string
        const base = 'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50'
        const cls = style === 'primary'
          ? `${base} bg-nvr-cyan text-white hover:bg-nvr-cyan/90`
          : style === 'danger'
          ? `${base} bg-red-500 text-white hover:bg-red-600`
          : `${base} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
        return (
          <button
            key={i}
            type='button'
            className={cls}
            disabled={loading !== null}
            onClick={() => handleClick(i)}
          >
            {loading === i ? '…' : String(btn.label ?? `Action ${i + 1}`)}
          </button>
        )
      })}
    </div>
  )
}

export function WidgetSlot({
  widgetId,
  inputBindings = [],
  itemDraft = {},
  itemCollection,
  ready = true,
  label,
  defaultExpanded = true,
  apiBase = '/api',
  compact = false,
  strip = false
}: WidgetSlotProps) {
  const [open, setOpen] = useState(defaultExpanded)
  const [widget, setWidget] = useState<WidgetDef | null>(null)
  const [renderData, setRenderData] = useState<Record<string, unknown> | null>(null)
  const [defLoading, setDefLoading] = useState(true)
  const [renderLoading, setRenderLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const inputs = resolveInputs(inputBindings, itemDraft)
  const inputsKey = JSON.stringify(inputs) + (itemCollection ?? '')

  useEffect(() => {
    if (!ready) return
    const workspace = typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(workspace ? { 'x-workspace': workspace } : {})
    }

    let cancelled = false

    async function load() {
      setDefLoading(true)
      setRenderLoading(true)
      setLoading(true)
      setError(null)
      try {
        const defRes = await fetch(`${apiBase}/widgets-internal/${widgetId}`, { credentials: 'include', headers })
        if (cancelled) return
        if (!defRes.ok) throw new Error('Widget not found')
        const defJson = await defRes.json() as { data: WidgetDef }
        if (!cancelled) { setWidget(defJson.data); setDefLoading(false) }

        const renderRes = await fetch(`${apiBase}/widgets-internal/${widgetId}/render`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ inputs, draft: itemDraft, bindings: inputBindings, item_collection: itemCollection })
        })
        if (cancelled) return
        if (!renderRes.ok) throw new Error('Render failed')
        const renderJson = await renderRes.json() as { data: Record<string, unknown> }
        if (!cancelled) { setRenderData(renderJson.data); setRenderLoading(false) }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    const timer = setTimeout(load, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [widgetId, apiBase, inputsKey, ready])

  const title = label || widget?.name || `Widget ${widgetId}`

  if (compact) {
    const compactStyle = (widget?.config?.compact_style as string | undefined) ?? 'default'
    const isPill = compactStyle === 'pill-dark' || compactStyle === 'pill-light'

    if (error) return <span className='text-[11px] text-red-400' title={error}>!</span>

    // Strip mode: dedicated band below header, full-height cells with dividers
    if (strip) {
      if (defLoading) {
        return (
          <div className='flex flex-col justify-center border-r border-slate-200 dark:border-border px-4 py-2.5 w-36'>
            <span className='animate-pulse h-2 w-10 rounded bg-slate-200 dark:bg-slate-700 mb-1' />
            <span className='animate-pulse h-3.5 w-20 rounded bg-slate-200 dark:bg-slate-700' />
          </div>
        )
      }
      return (
        <StripDisplay
          data={renderLoading ? null : (renderData ?? null)}
          label={label || widget!.name}
          loading={renderLoading}
          widgetConfig={widget!.config}
        />
      )
    }

    if (isPill) {
      // Skeleton until widget def loads
      if (defLoading) {
        return (
          <div className={`animate-pulse h-8 w-36 rounded-md ${compactStyle === 'pill-dark' ? 'bg-slate-700 border border-slate-700' : 'bg-slate-100 border border-slate-200'}`} />
        )
      }
      return (
        <PillDisplay
          data={renderLoading ? null : (renderData ?? null)}
          label={label || widget!.name}
          style={compactStyle as 'pill-dark' | 'pill-light'}
          loading={renderLoading}
          widgetConfig={widget!.config}
        />
      )
    }

    // Default compact style — show label skeleton while def loads, value skeleton while rendering
    if (defLoading) {
      return <div className='animate-pulse h-4 w-20 rounded bg-slate-200' />
    }
    return (
      <div className='flex items-center gap-1.5'>
        {renderLoading ? (
          <div className='flex items-baseline gap-1'>
            <div className='animate-pulse h-5 w-20 rounded bg-slate-200' />
          </div>
        ) : (
          renderData && widget && (
            <>
              {(widget.widget_type === 'stat' || (widget.widget_type === 'custom-query' && 'value' in renderData)) && <StatDisplay data={renderData} />}
              {widget.widget_type === 'custom-query' && 'values' in renderData && <MultiStatDisplay data={renderData} />}
              {widget.widget_type === 'action-buttons' && (
                <ActionButtonsDisplay data={renderData} widgetId={widgetId} inputs={inputs} apiBase={apiBase} />
              )}
            </>
          )
        )}
      </div>
    )
  }

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        className='flex w-full items-center justify-between px-4 py-3 text-left'
        onClick={() => setOpen(o => !o)}
      >
        <span className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>{title}</span>
        <span className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3 dark:border-border'>
          {loading && <p className='text-[12px] text-slate-400'>Loading…</p>}
          {error && <p className='text-[12px] text-red-500'>{error}</p>}
          {!loading && !error && renderData && widget && (
            <>
              {(widget.widget_type === 'stat' || (widget.widget_type === 'custom-query' && 'value' in renderData)) && <StatDisplay data={renderData} />}
              {widget.widget_type === 'custom-query' && 'values' in renderData && <MultiStatDisplay data={renderData} />}
              {(widget.widget_type === 'list' || (widget.widget_type === 'custom-query' && 'rows' in renderData)) && <ListDisplay data={renderData} />}
              {widget.widget_type === 'action-buttons' && (
                <ActionButtonsDisplay
                  data={renderData}
                  widgetId={widgetId}
                  inputs={inputs}
                  apiBase={apiBase}
                />
              )}
              {!['stat', 'list', 'action-buttons', 'custom-query'].includes(widget.widget_type) && (
                <pre className='whitespace-pre-wrap text-[11px] text-slate-500'>{JSON.stringify(renderData, null, 2)}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
