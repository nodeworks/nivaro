import type { ReportWidget, ReportWidgetConfig } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Settings2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn } from '../lib/utils'

/**
 * Lean report-building surface for headless hosts (efp-new): everything the
 * admin builder can configure, minus the drag canvas — widgets reorder and
 * resize with steppers instead. Editable is server-decided (owner/admin);
 * ReportView shows the Edit button only when the report says so.
 */

const WIDGET_TYPES: Array<{ id: ReportWidget['type']; label: string }> = [
  { id: 'kpi', label: 'KPI' },
  { id: 'bar', label: 'Bar' },
  { id: 'line', label: 'Line' },
  { id: 'donut', label: 'Donut' },
  { id: 'table', label: 'Table' },
  { id: 'movers', label: 'Top Movers' },
  { id: 'calc', label: 'Calculated' },
  { id: 'query', label: 'Query' },
  { id: 'divider', label: 'Divider' }
]

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'float'])
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp'])

function newWidget(type: ReportWidget['type'], maxY: number): ReportWidget {
  return {
    id: crypto.randomUUID(),
    type,
    title:
      type === 'divider'
        ? 'Section'
        : type === 'calc'
          ? 'Calculated KPI'
          : type === 'movers'
            ? 'Top movers'
            : `New ${type}`,
    collection: null,
    config:
      type === 'query'
        ? ({ query: { slug: '', display: 'table' } } as ReportWidgetConfig)
        : type === 'calc'
          ? ({ formula: '{{a}} / {{b}}', refs: {} } as ReportWidgetConfig)
          : ({ metric: { aggregate: 'count' } } as ReportWidgetConfig),
    x: 0,
    y: maxY,
    w: type === 'kpi' || type === 'calc' ? 3 : type === 'divider' ? 12 : 6,
    h: type === 'kpi' || type === 'calc' ? 2 : type === 'divider' ? 1 : type === 'query' ? 4 : 3
  }
}

/** Per-card overlay controls rendered while edit mode is on. */
export function WidgetEditBar({
  widget,
  onConfigure,
  onDelete,
  onResize,
  onMove
}: {
  widget: ReportWidget
  onConfigure: () => void
  onDelete: () => void
  onResize: (dw: number, dh: number) => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className='mb-1.5 flex items-center gap-0.5 rounded-md border border-dashed border-[#00ceff80] bg-[#00ceff0d] px-1.5 py-0.5'>
      <button
        type='button'
        title='Widget settings'
        onClick={onConfigure}
        className='rounded p-1 text-[#007a99] hover:bg-[#00ceff1f] dark:text-nvr-cyan'
      >
        <Settings2 className='h-3.5 w-3.5' />
      </button>
      <span className='mx-0.5 text-[10px] uppercase tracking-wide text-slate-400'>{widget.type}</span>
      <span className='ml-auto flex items-center gap-0.5'>
        <button type='button' title='Move earlier' onClick={() => onMove(-1)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          <ChevronUp className='h-3 w-3' />
        </button>
        <button type='button' title='Move later' onClick={() => onMove(1)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          <ChevronDown className='h-3 w-3' />
        </button>
        <button type='button' title='Narrower' onClick={() => onResize(-1, 0)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          <ChevronLeft className='h-3 w-3' />
        </button>
        <button type='button' title='Wider' onClick={() => onResize(1, 0)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          <ChevronRight className='h-3 w-3' />
        </button>
        <span className='px-0.5 text-[10px] tabular-nums text-slate-400'>
          {widget.w}×{widget.h}
        </span>
        <button type='button' title='Shorter' onClick={() => onResize(0, -1)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          −
        </button>
        <button type='button' title='Taller' onClick={() => onResize(0, 1)} className='rounded p-0.5 text-slate-400 hover:text-slate-600'>
          +
        </button>
        <button type='button' title='Remove widget' onClick={onDelete} className='rounded p-0.5 text-slate-400 hover:text-red-500'>
          <Trash2 className='h-3 w-3' />
        </button>
      </span>
    </div>
  )
}

export function AddWidgetBar({ onAdd, maxY }: { onAdd: (w: ReportWidget) => void; maxY: number }) {
  return (
    <div className='flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 dark:border-border'>
      <Plus className='h-3.5 w-3.5 text-slate-400' />
      <span className='text-[11.5px] text-slate-500'>Add widget:</span>
      {WIDGET_TYPES.map((t) => (
        <button
          key={t.id}
          type='button'
          onClick={() => onAdd(newWidget(t.id, maxY))}
          className='rounded-full border border-slate-200 px-2.5 py-0.5 text-[11.5px] text-slate-500 hover:border-[#00ceff66] hover:text-[#007a99] dark:border-border dark:hover:text-nvr-cyan'
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** Commit-on-valid JSON textarea (builder precedent). */
function JsonBox({
  value,
  onChange,
  rows = 2,
  placeholder
}: {
  value: unknown
  onChange: (v: unknown) => void
  rows?: number
  placeholder?: string
}) {
  const [text, setText] = useState(() =>
    value == null ? '' : JSON.stringify(value, null, 0)
  )
  const [invalid, setInvalid] = useState(false)
  return (
    <textarea
      value={text}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        if (!t.trim()) {
          setInvalid(false)
          onChange(undefined)
          return
        }
        try {
          onChange(JSON.parse(t))
          setInvalid(false)
        } catch {
          setInvalid(true)
        }
      }}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      className={cn(
        'w-full rounded-md border bg-white px-2 py-1 font-mono text-[11px] dark:bg-card dark:text-slate-200',
        invalid ? 'border-red-400' : 'border-slate-200 dark:border-border'
      )}
    />
  )
}

const inputCls =
  'h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card dark:text-slate-200'
const selectCls =
  'h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card dark:text-slate-200'

export function WidgetConfigSheet({
  widget,
  allWidgets,
  onChange,
  onClose
}: {
  widget: ReportWidget
  allWidgets: ReportWidget[]
  onChange: (w: ReportWidget) => void
  onClose: () => void
}) {
  const client = useNivaroClient()
  const { data: collections = [] } = useQuery({
    queryKey: ['nvr-collections-registry'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null }> }>(
          get('/collections')
        )
        .then((r) => (r.data ?? []).filter((c) => !c.collection.startsWith('nivaro_'))),
    staleTime: 5 * 60_000
  })
  const { data: fields = [] } = useQuery({
    queryKey: ['nvr-field-config', widget.collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ field: string; label?: string | null; type?: string | null }> }>(
          get(`/field-config/${widget.collection}`)
        )
        .then((r) => (r.data ?? []).filter((f) => !f.field.includes('.'))),
    enabled: !!widget.collection,
    staleTime: 60_000
  })
  const cfg = (widget.config ?? {}) as ReportWidgetConfig & Record<string, unknown>
  const set = (patch: Partial<ReportWidget>) => onChange({ ...widget, ...patch })
  const setCfg = (patch: Record<string, unknown>) =>
    set({ config: { ...cfg, ...patch } as ReportWidgetConfig })

  const numericOpts = fields.filter((f) => NUMERIC_TYPES.has(f.type ?? ''))
  const dateOpts = fields.filter((f) => DATE_TYPES.has(f.type ?? ''))
  const isChart = ['bar', 'line', 'donut', 'movers'].includes(widget.type)
  const needsCollection = !['divider', 'query', 'calc', 'kpi_group'].includes(widget.type)
  const refs = (cfg.refs ?? {}) as Record<string, string>
  const calcCandidates = allWidgets.filter(
    (w) => w.id !== widget.id && w.type !== 'divider' && w.type !== 'calc'
  )

  return (
    <div
      className='fixed inset-0 z-[128] flex justify-end bg-black/30'
      onClick={onClose}
    >
      <div
        className='flex h-full w-[380px] flex-col overflow-y-auto border-l border-slate-200 bg-white p-4 shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-3 flex items-center gap-2'>
          <Settings2 className='h-4 w-4 text-nvr-cyan' />
          <p className='text-[13.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Widget settings
          </p>
          <button type='button' onClick={onClose} className='ml-auto rounded p-1 text-slate-400 hover:text-slate-600'>
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='space-y-3.5'>
          <label className='block space-y-1'>
            <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Title</span>
            <input value={widget.title} onChange={(e) => set({ title: e.target.value })} className={inputCls} />
          </label>

          <div className='space-y-1'>
            <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Type</span>
            <div className='flex flex-wrap gap-1'>
              {WIDGET_TYPES.map((t) => (
                <button
                  key={t.id}
                  type='button'
                  onClick={() => set({ type: t.id })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                    widget.type === t.id
                      ? 'border-[#00ceff] bg-[#00ceff14] text-[#007a99] dark:text-nvr-cyan'
                      : 'border-slate-200 text-slate-400 dark:border-border'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {needsCollection && (
            <label className='block space-y-1'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Collection</span>
              <select
                value={widget.collection ?? ''}
                onChange={(e) => set({ collection: e.target.value || null })}
                className={cn(selectCls, 'w-full')}
              >
                <option value=''>Pick a collection…</option>
                {collections.map((c) => (
                  <option key={c.collection} value={c.collection}>
                    {c.display_name || c.collection}
                  </option>
                ))}
              </select>
            </label>
          )}

          {needsCollection && (
            <div className='flex items-center gap-1.5'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Metric</span>
              <select
                value={cfg.metric?.aggregate ?? 'count'}
                onChange={(e) =>
                  setCfg({ metric: { aggregate: e.target.value as never, field: cfg.metric?.field } })
                }
                className={selectCls}
              >
                {['count', 'sum', 'avg', 'min', 'max'].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              {(cfg.metric?.aggregate ?? 'count') !== 'count' && (
                <select
                  value={cfg.metric?.field ?? ''}
                  onChange={(e) =>
                    setCfg({
                      metric: { aggregate: cfg.metric?.aggregate ?? 'sum', field: e.target.value || undefined }
                    })
                  }
                  className={cn(selectCls, 'min-w-0 flex-1')}
                >
                  <option value=''>Field…</option>
                  {numericOpts.map((f) => (
                    <option key={f.field} value={f.field}>
                      {f.label || f.field}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {isChart && (
            <div className='flex items-center gap-1.5'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Group by</span>
              <select
                value={cfg.dimension?.field ?? ''}
                onChange={(e) =>
                  setCfg({
                    dimension: e.target.value
                      ? { field: e.target.value, bucket: cfg.dimension?.bucket }
                      : null
                  })
                }
                className={cn(selectCls, 'min-w-0 flex-1')}
              >
                <option value=''>Pick a field…</option>
                {fields.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label || f.field}
                  </option>
                ))}
              </select>
              {widget.type !== 'movers' && widget.type !== 'donut' && (
                <select
                  value={cfg.dimension?.bucket ?? ''}
                  onChange={(e) =>
                    setCfg({
                      dimension: cfg.dimension?.field
                        ? { field: cfg.dimension.field, bucket: (e.target.value || undefined) as never }
                        : null
                    })
                  }
                  className={selectCls}
                >
                  <option value=''>Values</option>
                  <option value='day'>Daily</option>
                  <option value='week'>Weekly</option>
                  <option value='month'>Monthly</option>
                </select>
              )}
            </div>
          )}

          {needsCollection && (
            <label className='block space-y-1'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                Date field (report date range)
              </span>
              <select
                value={cfg.date_field ?? ''}
                onChange={(e) => setCfg({ date_field: e.target.value || null })}
                className={cn(selectCls, 'w-full')}
              >
                <option value=''>(none — ignores date range)</option>
                {dateOpts.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label || f.field}
                  </option>
                ))}
              </select>
            </label>
          )}

          {needsCollection && widget.type !== 'table' && (
            <div className='flex items-center gap-1.5'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Compare</span>
              <select
                value={cfg.compare ?? ''}
                onChange={(e) => setCfg({ compare: (e.target.value || null) as never })}
                className={cn(selectCls, 'flex-1')}
              >
                <option value=''>Off</option>
                <option value='previous_period'>Previous period</option>
                <option value='previous_year'>Previous year</option>
              </select>
            </div>
          )}

          {(widget.type === 'bar' || widget.type === 'donut' || widget.type === 'movers') && (
            <label className='flex items-center gap-2'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                {widget.type === 'movers' ? 'Movers each way' : 'Top N'}
              </span>
              <input
                type='number'
                value={cfg.limit ?? (widget.type === 'movers' ? 5 : 12)}
                onChange={(e) => setCfg({ limit: Number(e.target.value) || undefined })}
                className={cn(inputCls, 'w-16')}
              />
            </label>
          )}

          {(widget.type === 'bar' || widget.type === 'line') && (
            <div className='space-y-1'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                Second metric (right axis)
              </span>
              <div className='flex items-center gap-1.5'>
                <select
                  value={cfg.metric2?.aggregate ?? ''}
                  onChange={(e) =>
                    setCfg({
                      metric2: e.target.value
                        ? { aggregate: e.target.value as never, field: cfg.metric2?.field, label: cfg.metric2?.label }
                        : undefined
                    })
                  }
                  className={selectCls}
                >
                  <option value=''>None</option>
                  {['count', 'sum', 'avg', 'min', 'max'].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                {cfg.metric2?.aggregate && cfg.metric2.aggregate !== 'count' && (
                  <select
                    value={cfg.metric2?.field ?? ''}
                    onChange={(e) =>
                      setCfg({
                        metric2: { aggregate: cfg.metric2?.aggregate ?? 'sum', field: e.target.value || undefined, label: cfg.metric2?.label }
                      })
                    }
                    className={cn(selectCls, 'min-w-0 flex-1')}
                  >
                    <option value=''>Field…</option>
                    {numericOpts.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label || f.field}
                      </option>
                    ))}
                  </select>
                )}
                {cfg.metric2?.aggregate && (
                  <input
                    value={cfg.metric2?.label ?? ''}
                    onChange={(e) =>
                      setCfg({
                        metric2: { aggregate: cfg.metric2?.aggregate ?? 'sum', field: cfg.metric2?.field, label: e.target.value || undefined }
                      })
                    }
                    placeholder='Label'
                    className={cn(inputCls, 'w-20')}
                  />
                )}
              </div>
            </div>
          )}

          {widget.type === 'table' && (
            <>
              <label className='block space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                  Columns (comma-separated fields)
                </span>
                <input
                  value={(cfg.columns ?? [])
                    .map((c) => (typeof c === 'string' ? c : c.field))
                    .join(', ')}
                  onChange={(e) =>
                    setCfg({
                      columns: e.target.value
                        .split(',')
                        .map((c) => c.trim())
                        .filter(Boolean)
                    })
                  }
                  className={inputCls}
                />
              </label>
              <div className='flex items-center gap-2'>
                <span className='text-[11.5px] text-slate-500'>Sort</span>
                <input
                  value={cfg.sort ?? ''}
                  onChange={(e) => setCfg({ sort: e.target.value || undefined })}
                  placeholder='-created_at'
                  className={cn(inputCls, 'w-32')}
                />
                <span className='text-[11.5px] text-slate-500'>Limit</span>
                <input
                  type='number'
                  value={cfg.limit ?? 10}
                  onChange={(e) => setCfg({ limit: Number(e.target.value) || 10 })}
                  className={cn(inputCls, 'w-16')}
                />
              </div>
              <label className='block space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                  Highlight rules (JSON)
                </span>
                <JsonBox
                  value={cfg.format_rules}
                  onChange={(v) => setCfg({ format_rules: v })}
                  placeholder='[{"field":"amount","op":"gt","value":50000,"color":"red","scope":"cell"}]'
                />
              </label>
            </>
          )}

          {widget.type === 'calc' && (
            <>
              <label className='block space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Formula</span>
                <input
                  value={(cfg.formula as string) ?? ''}
                  onChange={(e) => setCfg({ formula: e.target.value })}
                  placeholder='{{a}} / {{b}}'
                  className={cn(inputCls, 'font-mono')}
                />
              </label>
              <div className='space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Tokens</span>
                {Object.keys(refs).map((t) => (
                  <div key={t} className='flex items-center gap-1.5'>
                    <span className='w-8 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-center font-mono text-[11.5px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                      {t}
                    </span>
                    <select
                      value={refs[t] ?? ''}
                      onChange={(e) => setCfg({ refs: { ...refs, [t]: e.target.value } })}
                      className={cn(selectCls, 'min-w-0 flex-1')}
                    >
                      <option value=''>Pick a widget…</option>
                      {calcCandidates.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.title || w.type}
                        </option>
                      ))}
                    </select>
                    <button
                      type='button'
                      onClick={() => {
                        const next = { ...refs }
                        delete next[t]
                        setCfg({ refs: next })
                      }}
                      className='rounded p-1 text-slate-300 hover:text-red-500'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </div>
                ))}
                <button
                  type='button'
                  onClick={() => {
                    const tokens = Object.keys(refs)
                    let next = 'a'
                    for (const c of 'abcdefgh') {
                      if (!tokens.includes(c)) {
                        next = c
                        break
                      }
                    }
                    setCfg({ refs: { ...refs, [next]: '' } })
                  }}
                  className='rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 dark:border-border'
                >
                  + Add token
                </button>
                <p className='text-[10.5px] text-amber-600 dark:text-amber-400'>
                  Save before previewing — calc widgets resolve against saved siblings.
                </p>
              </div>
            </>
          )}

          {widget.type === 'query' && (
            <>
              <label className='block space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>Query slug</span>
                <input
                  value={cfg.query?.slug ?? ''}
                  onChange={(e) => setCfg({ query: { ...cfg.query, slug: e.target.value } })}
                  className={cn(inputCls, 'font-mono')}
                />
              </label>
              <label className='block space-y-1'>
                <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                  Query config (JSON — params, display, series…)
                </span>
                <JsonBox
                  value={cfg.query}
                  onChange={(v) => setCfg({ query: v })}
                  rows={5}
                />
              </label>
            </>
          )}

          {needsCollection && (
            <label className='block space-y-1'>
              <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                Filters (JSON)
              </span>
              <JsonBox
                value={cfg.filters}
                onChange={(v) => setCfg({ filters: v })}
                placeholder='[{"field":"workflow_type","op":"eq","value":2}]'
              />
            </label>
          )}

          {(widget.type === 'kpi' || widget.type === 'calc') && (
            <div className='flex items-center gap-2'>
              <span className='text-[11.5px] text-slate-500'>Prefix</span>
              <input
                value={cfg.format?.prefix ?? ''}
                onChange={(e) => setCfg({ format: { ...cfg.format, prefix: e.target.value || undefined } })}
                className={cn(inputCls, 'w-14')}
              />
              <span className='text-[11.5px] text-slate-500'>Decimals</span>
              <input
                type='number'
                value={cfg.format?.decimals ?? ''}
                onChange={(e) =>
                  setCfg({
                    format: {
                      ...cfg.format,
                      decimals: e.target.value === '' ? undefined : Number(e.target.value)
                    }
                  })
                }
                className={cn(inputCls, 'w-14')}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
