import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Check,
  ChevronsUpDown,
  Database,
  ExternalLink,
  FileText,
  Globe,
  Grid3x3,
  GripVertical,
  LayoutDashboard,
  Plus,
  Table2,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useGoBack } from '@/lib/nav'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, type Collection } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { CmsPage, PageWidget } from './PagesAdmin'
import { WIDGET_TYPE_LABELS, WidgetBody } from './PageView'

// ─── Grid constants ───────────────────────────────────────────────────────────

const COLS = 12
const ROW_HEIGHT = 76
const GAP = 16
const MIN_ROWS = 8

// ─── Widget palette ───────────────────────────────────────────────────────────

const PALETTE: {
  type: PageWidget['type']
  icon: typeof Table2
  defaults: Pick<PageWidget, 'w' | 'h' | 'config'>
}[] = [
  { type: 'table', icon: Table2, defaults: { w: 6, h: 4, config: { limit: 10 } } },
  {
    type: 'kpi',
    icon: BarChart3,
    defaults: { w: 3, h: 2, config: { aggregate: 'count', label: '' } }
  },
  {
    type: 'markdown',
    icon: FileText,
    defaults: { w: 4, h: 3, config: { content: '## Section\nWrite **markdown** here.' } }
  },
  { type: 'iframe', icon: Globe, defaults: { w: 6, h: 4, config: { url: '' } } },
  { type: 'recent-activity', icon: Activity, defaults: { w: 4, h: 4, config: { limit: 10 } } },
  {
    type: 'query',
    icon: Database,
    defaults: { w: 12, h: 6, config: { query_slug: '', params: {}, table: { totals: true } } }
  },
  {
    type: 'matrix',
    icon: Grid3x3,
    defaults: {
      w: 12,
      h: 6,
      config: {
        target_collection: '',
        option_collection: '',
        key_field: '',
        value_field: '',
        scope_fields: []
      }
    }
  },
  {
    type: 'record-grid',
    icon: Grid3x3,
    defaults: {
      w: 12,
      h: 6,
      config: { collection: '', scope: [], month_sets: [], columns: [] }
    }
  }
]

// ─── Generic combobox (shadcn Popover + Command) ─────────────────────────────

function Combobox({
  value,
  onChange,
  options,
  placeholder,
  allowClear,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  allowClear?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn('h-8 w-full justify-between px-2.5 text-[12.5px] font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1.5 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value='__none__'
                  onSelect={() => {
                    onChange('')
                    setOpen(false)
                  }}
                  className='text-[12.5px] text-muted-foreground'
                >
                  <Check className={cn('mr-2 h-3 w-3', !value ? 'opacity-100' : 'opacity-0')} />—
                  none —
                </CommandItem>
              )}
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function useCollectionFields(collection: string) {
  const { data } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  return ((data?.fields ?? []) as Array<{ field: string; type: string; hidden?: boolean }>).filter(
    (f) => !f.hidden
  )
}

// ─── Filters editor ───────────────────────────────────────────────────────────

interface FilterRule {
  field: string
  op: string
  value?: unknown
}

const FILTER_OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' }
]

function FiltersEditor({
  collection,
  filters,
  onChange
}: {
  collection: string
  filters: FilterRule[]
  onChange: (f: FilterRule[]) => void
}) {
  const fields = useCollectionFields(collection)
  const fieldOptions = fields.map((f) => ({ value: f.field, label: f.field }))

  return (
    <div className='space-y-2'>
      {filters.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable filter rows
        <div key={i} className='flex items-center gap-1.5'>
          <Combobox
            value={f.field}
            onChange={(v) => onChange(filters.map((x, j) => (j === i ? { ...x, field: v } : x)))}
            options={fieldOptions}
            placeholder='Field…'
            className='flex-1'
          />
          <Combobox
            value={f.op}
            onChange={(v) => onChange(filters.map((x, j) => (j === i ? { ...x, op: v } : x)))}
            options={FILTER_OPS}
            className='w-24 shrink-0'
          />
          {f.op !== 'null' && f.op !== 'nnull' && (
            <Input
              value={String(f.value ?? '')}
              onChange={(e) =>
                onChange(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
              placeholder='value'
              className='h-8 w-24 text-[12px]'
            />
          )}
          <button
            type='button'
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
            className='shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10'
            aria-label='Remove filter'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange([...filters, { field: '', op: 'eq', value: '' }])}
        className='flex items-center gap-1 text-[12px] text-slate-500 transition-colors hover:text-nvr-cyan dark:text-slate-400'
      >
        <Plus className='h-3.5 w-3.5' /> Add filter
      </button>
    </div>
  )
}

// ─── Config panel ─────────────────────────────────────────────────────────────

/** Escape-hatch JSON editors share one chrome with the standard Input. */
const JSON_FIELD =
  'w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] leading-relaxed text-slate-700 transition-colors focus-visible:border-nvr-cyan focus-visible:outline-none dark:text-slate-300'

const PANEL_LABEL = 'text-[11px] font-medium text-slate-500 dark:text-slate-400'

const PANEL_HINT = 'text-[11px] leading-relaxed text-slate-400'

function WidgetConfigPanel({
  widget,
  collections,
  onChange,
  onRemove,
  onClose
}: {
  widget: PageWidget
  collections: Collection[]
  onChange: (config: Record<string, unknown>) => void
  onRemove: () => void
  onClose: () => void
}) {
  const cfg = widget.config ?? {}
  const collection = String(cfg.collection ?? '')
  const fields = useCollectionFields(collection)
  const fieldOptions = fields.map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))
  const collectionOptions = collections.map((c) => ({
    value: c.collection,
    label: c.display_name ?? c.collection
  }))

  const set = (k: string, v: unknown) => onChange({ ...cfg, [k]: v })

  const numericFieldOptions = fields
    .filter((f) => ['integer', 'bigInteger', 'float', 'decimal'].includes(f.type))
    .map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))

  const columns: string[] = Array.isArray(cfg.columns) ? (cfg.columns as string[]) : []

  return (
    <div className='flex h-full flex-col'>
      <div className='flex h-[45px] shrink-0 items-center gap-2 border-b border-slate-200 px-4 dark:border-border'>
        <p className='truncate text-[12px] font-semibold text-slate-800 dark:text-slate-200'>
          {WIDGET_TYPE_LABELS[widget.type]}
        </p>
        <span className='text-[11px] text-slate-400'>settings</span>
        <button
          type='button'
          onClick={onClose}
          className='-mr-1 ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          aria-label='Close panel'
        >
          <X className='h-4 w-4' />
        </button>
      </div>

      <div className='flex-1 space-y-5 overflow-y-auto p-4'>
        {widget.type !== 'kpi' && widget.type !== 'markdown' && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>Label</Label>
            <Input
              value={String(cfg.label ?? '')}
              onChange={(e) => set('label', e.target.value)}
              placeholder={WIDGET_TYPE_LABELS[widget.type]}
              className='h-8 text-[12.5px]'
              disabled={cfg.hide_label === true}
            />
            <p className={PANEL_HINT}>Card header text. Empty = collection name or widget type.</p>
            <label className='flex items-center gap-2 pt-1 text-[12px] text-slate-600 dark:text-slate-300'>
              <input
                type='checkbox'
                checked={cfg.hide_label === true}
                onChange={(e) => set('hide_label', e.target.checked)}
                className='h-3.5 w-3.5 accent-[#00ceff]'
              />
              Hide header entirely
            </label>
          </div>
        )}

        {(widget.type === 'table' || widget.type === 'kpi') && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>Collection</Label>
            <Combobox
              value={collection}
              onChange={(v) =>
                onChange({
                  ...cfg,
                  collection: v,
                  // collection-specific config resets
                  ...(widget.type === 'table'
                    ? { columns: [], filters: [] }
                    : { field: '', filters: [] })
                })
              }
              options={collectionOptions}
              placeholder='Select collection…'
            />
          </div>
        )}

        {widget.type === 'kpi' && (
          <>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Aggregate</Label>
              <Combobox
                value={String(cfg.aggregate ?? 'count')}
                onChange={(v) => set('aggregate', v || 'count')}
                options={[
                  { value: 'count', label: 'count' },
                  { value: 'sum', label: 'sum' },
                  { value: 'avg', label: 'avg' }
                ]}
              />
            </div>
            {String(cfg.aggregate ?? 'count') !== 'count' && (
              <div className='space-y-1.5'>
                <Label className={PANEL_LABEL}>Field</Label>
                <Combobox
                  value={String(cfg.field ?? '')}
                  onChange={(v) => set('field', v)}
                  options={numericFieldOptions}
                  placeholder={collection ? 'Select field…' : 'Select collection first'}
                />
              </div>
            )}
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Label</Label>
              <Input
                value={String(cfg.label ?? '')}
                onChange={(e) => set('label', e.target.value)}
                placeholder='e.g. Open tickets'
                className='h-8 text-[12.5px]'
              />
            </div>
          </>
        )}

        {widget.type === 'table' && (
          <>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Columns</Label>
              <div className='flex flex-wrap gap-1'>
                {columns.map((c) => (
                  <span
                    key={c}
                    className='inline-flex items-center gap-1 rounded border border-nvr-cyan bg-accent px-1.5 py-0.5 font-mono text-[11px] text-nvr-navy dark:text-nvr-cyan'
                  >
                    {c}
                    <button
                      type='button'
                      onClick={() =>
                        set(
                          'columns',
                          columns.filter((x) => x !== c)
                        )
                      }
                      className='opacity-50 hover:opacity-100'
                      aria-label={`Remove ${c}`}
                    >
                      <X className='h-2.5 w-2.5' />
                    </button>
                  </span>
                ))}
              </div>
              <Combobox
                value=''
                onChange={(v) => {
                  if (v && !columns.includes(v)) set('columns', [...columns, v])
                }}
                options={fieldOptions.filter((f) => !columns.includes(f.value))}
                placeholder={collection ? '+ Add column…' : 'Select collection first'}
              />
              <p className={PANEL_HINT}>Empty = first columns automatically.</p>
            </div>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Limit</Label>
              <Input
                type='number'
                min={1}
                max={100}
                value={Number(cfg.limit ?? 10)}
                onChange={(e) =>
                  set('limit', Math.max(1, Math.min(100, Number(e.target.value) || 10)))
                }
                className='h-8 w-24 text-[12.5px]'
              />
            </div>
          </>
        )}

        {(widget.type === 'table' || widget.type === 'kpi') && collection && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>Filters</Label>
            <FiltersEditor
              collection={collection}
              filters={Array.isArray(cfg.filters) ? (cfg.filters as FilterRule[]) : []}
              onChange={(f) => set('filters', f)}
            />
          </div>
        )}

        {widget.type === 'markdown' && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>Content (markdown)</Label>
            <Textarea
              value={String(cfg.content ?? '')}
              onChange={(e) => set('content', e.target.value)}
              rows={12}
              spellCheck={false}
              className='font-mono text-[12px]'
              placeholder={'## Heading\n- bullet\n**bold** and [links](https://…)'}
            />
          </div>
        )}

        {widget.type === 'iframe' && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>URL</Label>
            <Input
              value={String(cfg.url ?? '')}
              onChange={(e) => set('url', e.target.value)}
              placeholder='https://example.com/embed'
              className='h-8 font-mono text-[12px]'
            />
            <p className={PANEL_HINT}>Rendered in a sandboxed iframe.</p>
          </div>
        )}

        {widget.type === 'query' && (
          <>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Custom query slug</Label>
              <Input
                value={String(cfg.query_slug ?? '')}
                onChange={(e) => set('query_slug', e.target.value)}
                placeholder='project-type-allocations'
                className='h-8 font-mono text-[12px]'
              />
            </div>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Params (JSON)</Label>
              <textarea
                defaultValue={JSON.stringify(cfg.params ?? {}, null, 2)}
                onBlur={(e) => {
                  try {
                    set('params', JSON.parse(e.target.value || '{}'))
                  } catch {
                    /* keep last valid */
                  }
                }}
                rows={3}
                className={JSON_FIELD}
              />
            </div>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Table config (JSON)</Label>
              <textarea
                defaultValue={JSON.stringify(cfg.table ?? { totals: true }, null, 2)}
                onBlur={(e) => {
                  try {
                    set('table', JSON.parse(e.target.value || '{}'))
                  } catch {
                    /* keep last valid */
                  }
                }}
                rows={8}
                className={JSON_FIELD}
              />
              <p className={PANEL_HINT}>
                columns: [{'{'}field|formula, label, format: currency|number|percent, sum{'}'}] ·
                group_by · totals
              </p>
            </div>
          </>
        )}

        {widget.type === 'matrix' && (
          <div className='space-y-1.5'>
            <Label className={PANEL_LABEL}>Matrix config (JSON)</Label>
            <textarea
              defaultValue={JSON.stringify(widget.config ?? {}, null, 2)}
              onBlur={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value || '{}')
                  for (const [k, v] of Object.entries(parsed)) set(k, v)
                } catch {
                  /* keep last valid */
                }
              }}
              rows={12}
              className={JSON_FIELD}
            />
            <p className={PANEL_HINT}>
              target_collection · option_collection · option_label · option_filter ($scope tokens) ·
              key_field · value_field · value_format · scope_fields: [{'{'}field, collection, label
              {'}'}]
            </p>
          </div>
        )}

        {widget.type === 'recent-activity' && (
          <>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Collection (optional)</Label>
              <Combobox
                value={collection}
                onChange={(v) => set('collection', v || undefined)}
                options={collectionOptions}
                placeholder='All collections (admin)'
                allowClear
              />
              <p className={PANEL_HINT}>Unscoped activity is visible to admins only.</p>
            </div>
            <div className='space-y-1.5'>
              <Label className={PANEL_LABEL}>Limit</Label>
              <Input
                type='number'
                min={1}
                max={50}
                value={Number(cfg.limit ?? 10)}
                onChange={(e) =>
                  set('limit', Math.max(1, Math.min(50, Number(e.target.value) || 10)))
                }
                className='h-8 w-24 text-[12.5px]'
              />
            </div>
          </>
        )}
      </div>

      <div className='shrink-0 border-t border-slate-200 p-3 dark:border-border'>
        <button
          type='button'
          onClick={onRemove}
          className='inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[12px] font-medium text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400'
        >
          <Trash2 className='h-3.5 w-3.5' />
          Remove widget
        </button>
      </div>
    </div>
  )
}

// ─── Drag / resize math ───────────────────────────────────────────────────────

interface DragState {
  id: string
  mode: 'move' | 'resize'
  startClientX: number
  startClientY: number
  orig: { x: number; y: number; w: number; h: number }
}

// ─── Main builder page ────────────────────────────────────────────────────────

export function PageEditPage() {
  const { id } = useParams<{ id: string }>()
  const goBack = useGoBack('/pages-admin')
  const qc = useQueryClient()
  const canvasRef = useRef<HTMLDivElement>(null)

  const [widgets, setWidgets] = useState<PageWidget[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const dragRef = useRef<DragState | null>(null)

  const { data: page, isLoading } = useQuery({
    queryKey: ['page-by-id', id],
    queryFn: () => api.get<{ data: CmsPage }>(`/pages/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () => api.get('/collections?tables_only=true').then((r) => r.data.data as Collection[])
  })
  const collections = collectionsData ?? []

  useEffect(() => {
    if (page) {
      setWidgets(page.layout?.widgets ?? [])
      setDirty(false)
    }
  }, [page])

  const saveMut = useMutation({
    mutationFn: () => api.patch(`/pages/${id}`, { layout: { columns: COLS, widgets } }),
    onSuccess: () => {
      setDirty(false)
      qc.invalidateQueries({ queryKey: ['pages'] })
      qc.invalidateQueries({ queryKey: ['page-by-id', id] })
      if (page) qc.invalidateQueries({ queryKey: ['page-widget-data', page.slug] })
      toast.success('Page layout saved')
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to save layout'
      )
  })

  const updateWidgets = (next: PageWidget[]) => {
    setWidgets(next)
    setDirty(true)
  }

  const patchWidget = (wid: string, patch: Partial<PageWidget>) =>
    updateWidgets(widgets.map((w) => (w.id === wid ? { ...w, ...patch } : w)))

  const addWidget = (type: PageWidget['type']) => {
    const def = PALETTE.find((p) => p.type === type)
    if (!def) return
    const bottom = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0)
    const widget: PageWidget = {
      id: crypto.randomUUID(),
      type,
      x: 0,
      y: bottom,
      w: def.defaults.w,
      h: def.defaults.h,
      config: { ...def.defaults.config }
    }
    updateWidgets([...widgets, widget])
    setSelectedId(widget.id)
  }

  // ── Pointer drag/resize ──────────────────────────────────────────────────────

  const beginDrag = (e: React.PointerEvent, widget: PageWidget, mode: 'move' | 'resize') => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setSelectedId(widget.id)
    dragRef.current = {
      id: widget.id,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      orig: { x: widget.x, y: widget.y, w: widget.w, h: widget.h }
    }
  }

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const canvas = canvasRef.current
    if (!drag || !canvas) return

    const cellW = (canvas.clientWidth + GAP) / COLS
    const cellH = ROW_HEIGHT + GAP
    const dxCells = Math.round((e.clientX - drag.startClientX) / cellW)
    const dyCells = Math.round((e.clientY - drag.startClientY) / cellH)

    setWidgets((prev) =>
      prev.map((w) => {
        if (w.id !== drag.id) return w
        if (drag.mode === 'move') {
          const x = Math.max(0, Math.min(COLS - w.w, drag.orig.x + dxCells))
          const y = Math.max(0, drag.orig.y + dyCells)
          if (x === w.x && y === w.y) return w
          setDirty(true)
          return { ...w, x, y }
        }
        const width = Math.max(1, Math.min(COLS - w.x, drag.orig.w + dxCells))
        const height = Math.max(1, drag.orig.h + dyCells)
        if (width === w.w && height === w.h) return w
        setDirty(true)
        return { ...w, w: width, h: height }
      })
    )
  }

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current) {
      ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
      dragRef.current = null
    }
  }

  const selected = widgets.find((w) => w.id === selectedId) ?? null
  const totalRows = Math.max(MIN_ROWS, widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0) + 2)

  if (isLoading || !page) {
    return (
      <div className='flex flex-1 min-h-0 flex-col p-8'>
        <Skeleton className='mb-4 h-8 w-72' />
        <Skeleton className='h-64 w-full rounded-xl' />
      </div>
    )
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5 px-6 py-2.5'>
          <Link
            to='/pages-admin'
            onClick={(e) => { e.preventDefault(); goBack() }}
            title='Back to pages'
            className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          >
            <ArrowLeft className='h-4 w-4' />
          </Link>
          <LayoutDashboard className='h-4 w-4 shrink-0 text-nvr-cyan' />
          <h1 className='truncate text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            {page.name}
          </h1>
          <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-muted dark:text-slate-400'>
            /p/{page.slug}
          </span>
          {dirty && (
            <span className='inline-flex shrink-0 items-center gap-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
              <span className='h-1.5 w-1.5 rounded-full bg-amber-500' />
              Unsaved
            </span>
          )}
          <div className='ml-auto flex shrink-0 items-center gap-1.5'>
            <Button asChild size='sm' variant='outline' className='h-8 gap-1.5 text-[12px]'>
              <Link to={`/p/${page.slug}`}>
                <ExternalLink className='h-3.5 w-3.5' />
                View
              </Link>
            </Button>
            <Button
              size='sm'
              // Idle save reads as an inert outline control — a disabled solid
              // primary is white-on-pale-cyan and barely legible.
              variant={dirty ? 'default' : 'outline'}
              className='h-8 gap-1.5 text-[12px]'
              disabled={!dirty || saveMut.isPending}
              onClick={() => saveMut.mutate()}
            >
              {saveMut.isPending ? 'Saving…' : 'Save layout'}
            </Button>
          </div>
        </div>

        {/* Widget palette */}
        <div className='flex items-center gap-1 overflow-x-auto border-t border-slate-100 px-6 py-2 dark:border-border/60'>
          <span className='mr-1.5 shrink-0 text-[11px] font-medium uppercase tracking-wider text-slate-400'>
            Add
          </span>
          {PALETTE.map((p) => {
            const Icon = p.icon
            return (
              <button
                key={p.type}
                type='button'
                onClick={() => addWidget(p.type)}
                title={`Add ${WIDGET_TYPE_LABELS[p.type]} widget`}
                className='inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:border-nvr-cyan hover:bg-accent hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-accent dark:hover:text-nvr-cyan'
              >
                <Icon className='h-3.5 w-3.5' />
                {WIDGET_TYPE_LABELS[p.type]}
              </button>
            )
          })}
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Canvas */}
        <div className='flex flex-1 flex-col overflow-y-auto bg-slate-50 p-5 dark:bg-background'>
          {widgets.length === 0 && (
            <div className='m-auto flex max-w-sm flex-col items-center gap-2 py-16 text-center'>
              <span className='flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400 dark:border-border'>
                <Plus className='h-4 w-4' />
              </span>
              <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
                No widgets yet
              </p>
              <p className='text-[12px] leading-relaxed text-slate-400'>
                Pick a widget above to drop it on the canvas. Drag a widget by its header to move
                it, and pull the corner handle to resize.
              </p>
            </div>
          )}
          <div
            ref={canvasRef}
            className={cn('relative grid select-none', widgets.length === 0 && 'hidden')}
            style={{
              gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_HEIGHT}px`,
              gap: `${GAP}px`,
              minHeight: totalRows * (ROW_HEIGHT + GAP)
            }}
          >
            {widgets.map((w) => {
              const isSelected = selectedId === w.id
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: click-to-select convenience; selection is also set via the keyboard-focusable drag handle
                <div
                  key={w.id}
                  role='presentation'
                  onClick={() => setSelectedId(w.id)}
                  className={cn(
                    'group/widget relative flex min-h-0 flex-col overflow-hidden rounded-lg border bg-white transition-colors dark:bg-card',
                    isSelected
                      ? 'border-nvr-cyan ring-2 ring-accent'
                      : 'border-slate-200 hover:border-slate-300 dark:border-border dark:hover:border-slate-600'
                  )}
                  style={{
                    gridColumn: `${w.x + 1} / span ${w.w}`,
                    gridRow: `${w.y + 1} / span ${w.h}`
                  }}
                >
                  {/* Drag handle header */}
                  <div
                    onPointerDown={(e) => beginDrag(e, w, 'move')}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    className={cn(
                      'flex shrink-0 cursor-grab items-center gap-1.5 border-b px-2 py-1 transition-colors active:cursor-grabbing',
                      isSelected
                        ? 'border-slate-100 bg-accent/60 dark:border-border'
                        : 'border-slate-100 dark:border-border/70'
                    )}
                    style={{ touchAction: 'none' }}
                  >
                    <GripVertical className='h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover/widget:text-slate-400 dark:text-slate-600' />
                    <span className='shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
                      {WIDGET_TYPE_LABELS[w.type]}
                    </span>
                    {typeof w.config?.collection === 'string' && w.config.collection && (
                      <span className='truncate font-mono text-[10.5px] text-slate-400 dark:text-slate-500'>
                        {w.config.collection}
                      </span>
                    )}
                  </div>

                  {/* Live preview */}
                  <div className='pointer-events-none min-h-0 flex-1'>
                    <WidgetBody slug={page.slug} widget={w} />
                  </div>

                  {/* Resize handle */}
                  <div
                    onPointerDown={(e) => beginDrag(e, w, 'resize')}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    className={cn(
                      'absolute bottom-0 right-0 z-10 h-5 w-5 cursor-nwse-resize p-1 opacity-0 transition-opacity group-hover/widget:opacity-100',
                      isSelected && 'opacity-100'
                    )}
                    style={{ touchAction: 'none' }}
                    title='Resize'
                  >
                    <svg
                      viewBox='0 0 12 12'
                      className={cn(
                        'h-full w-full',
                        isSelected ? 'text-nvr-cyan' : 'text-slate-400 dark:text-slate-500'
                      )}
                      aria-hidden='true'
                    >
                      <path
                        d='M11 1v10H1'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='1.5'
                        strokeLinecap='round'
                      />
                    </svg>
                  </div>
                </div>
              )
            })}
          </div>
          {widgets.length > 0 && (
            <p className='mt-3 shrink-0 text-[11px] leading-relaxed text-slate-400'>
              Data widgets (table, KPI, activity) preview the last saved configuration — save to
              refresh their data.
            </p>
          )}
        </div>

        {/* Config panel */}
        {selected && (
          <aside className='flex w-[320px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-border dark:bg-card'>
            <WidgetConfigPanel
              key={selected.id}
              widget={selected}
              collections={collections}
              onChange={(config) => patchWidget(selected.id, { config })}
              onRemove={() => {
                updateWidgets(widgets.filter((w) => w.id !== selected.id))
                setSelectedId(null)
              }}
              onClose={() => setSelectedId(null)}
            />
          </aside>
        )}
      </div>
    </div>
  )
}
