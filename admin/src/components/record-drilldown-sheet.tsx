import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { cn, formatDate, titleCase } from '@/lib/utils'

// Drill-down sheet: a detailed view of any record, rendered from the target
// collection's DETAIL layout (layout_type='detail'; explicit layoutId beats the
// active default). Without a detail layout it falls back to the collection's
// active grouped layout rendered fully read-only. Scalar fields are editable
// inline when the layout doesn't mark them read-only — saves go through the
// normal items PATCH, so RBAC / row security / lock rules enforce server-side.

interface FieldConfigRow {
  field: string
  type: string
  label: string | null
  hidden: boolean
  readonly: boolean
  interface: string | null
  display: string | null
  display_options: Record<string, unknown> | null
  options: Record<string, unknown> | null
  computed_type: string | null
  group_key: string | null
  sort: number
  layout_assigned: boolean
  is_visible?: boolean | number | null
}

interface DetailLayoutResponse {
  layout: { id: number; name: string }
  groups: Array<{ key: string; label: string; sort: number }>
  assignments: unknown[]
}

const EDITABLE_TYPES = new Set([
  'string',
  'text',
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'boolean',
  'date',
  'dateTime',
  'datetime'
])

// Minimal dayjs-style token formatter for the datetime display's format string.
function formatDateToken(v: string, fmt: string): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MMM/g, MONTHS[d.getMonth()])
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/\bD\b/g, String(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
}

// Number formatting from the layout field chip settings (options.format:
// int | decimal | currency, with options.currency / options.precision).
function formatNumberBody(f: Pick<FieldConfigRow, 'type' | 'options'>, v: unknown): string | null {
  if (!['integer', 'bigInteger', 'decimal', 'float'].includes(f.type)) return null
  const num = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(num)) return null
  const opts = f.options ?? {}
  if (opts.format === 'currency') {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: String(opts.currency || 'USD')
      }).format(num)
    } catch {
      return num.toLocaleString()
    }
  }
  if (opts.format === 'decimal') {
    const precision = Number(opts.precision ?? 2)
    return num.toLocaleString(undefined, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision
    })
  }
  if (opts.format === 'int') return Math.round(num).toLocaleString()
  return null
}

// Field display settings (Data Model field chip -> Display + number format)
// applied at render: currency/decimal/int number formats, formatted-value
// (prefix/suffix), label (choice text + colors), datetime (format string),
// boolean (custom labels).
function displayValue(
  f: Pick<FieldConfigRow, 'type' | 'display' | 'display_options' | 'options'>,
  v: unknown
): string {
  const type = f.type
  const opts = f.display_options ?? {}
  if (v == null || v === '') return '—'
  if (f.display === 'boolean' || type === 'boolean') {
    if (f.display === 'boolean') {
      return v ? String(opts.true_label ?? 'Yes') : String(opts.false_label ?? 'No')
    }
    return v ? 'Yes' : 'No'
  }
  if (f.display === 'label') {
    return String(v)
  }
  const numberBody = formatNumberBody(f, v)
  if (f.display === 'formatted-value') {
    const num = typeof v === 'number' ? v : Number(v)
    const body =
      numberBody ??
      (!Number.isNaN(num) && ['integer', 'bigInteger', 'decimal', 'float'].includes(type)
        ? num.toLocaleString()
        : String(v))
    return `${opts.prefix ?? ''}${body}${opts.suffix ?? ''}`
  }
  if (numberBody != null) return numberBody
  if (type === 'date' || type === 'dateTime' || type === 'datetime') {
    if (f.display === 'datetime' && typeof opts.format === 'string' && opts.format) {
      return formatDateToken(String(v), opts.format)
    }
    return formatDate(String(v))
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// Label display: matched choice renders as a colored pill.
function LabelPill({
  choices,
  value
}: {
  choices: Array<{ value: string; text: string; background?: string; foreground?: string }>
  value: unknown
}) {
  const match = choices.find((c) => String(c.value) === String(value))
  if (!match) return <>{String(value)}</>
  return (
    <span
      className='inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium'
      style={{
        backgroundColor: match.background || 'rgba(0,206,255,0.12)',
        color: match.foreground || 'inherit'
      }}
    >
      {match.text || String(value)}
    </span>
  )
}

function InlineEditor({
  field,
  value,
  onSave,
  onCancel,
  saving
}: {
  field: FieldConfigRow
  value: unknown
  onSave: (v: unknown) => void
  onCancel: () => void
  saving: boolean
}) {
  const [draft, setDraft] = useState(() =>
    value == null ? '' : field.type === 'boolean' ? String(!!value) : String(value)
  )

  function commit() {
    if (field.type === 'boolean') return onSave(draft === 'true')
    if (['integer', 'bigInteger', 'decimal', 'float'].includes(field.type)) {
      if (draft.trim() === '') return onSave(null)
      const n = Number(draft)
      if (Number.isNaN(n)) {
        toast.error('Not a number')
        return
      }
      return onSave(n)
    }
    return onSave(draft.trim() === '' ? null : draft)
  }

  if (field.type === 'boolean') {
    return (
      <span className='flex items-center gap-2'>
        <input
          type='checkbox'
          checked={draft === 'true'}
          onChange={(e) => setDraft(String(e.target.checked))}
          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
        />
        <Button size='sm' className='h-6 px-2 text-[11px]' onClick={commit} disabled={saving}>
          {saving ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Save'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-2 text-[11px]'
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </span>
    )
  }

  const inputType =
    field.type === 'date'
      ? 'date'
      : field.type === 'dateTime' || field.type === 'datetime'
        ? 'datetime-local'
        : ['integer', 'bigInteger', 'decimal', 'float'].includes(field.type)
          ? 'number'
          : 'text'

  return (
    <span className='flex items-center gap-1.5'>
      <Input
        autoFocus
        type={inputType}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') onCancel()
        }}
        className='h-7 max-w-[240px] text-[12px]'
      />
      <Button size='sm' className='h-7 px-2 text-[11px]' onClick={commit} disabled={saving}>
        {saving ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Save'}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        className='h-7 px-2 text-[11px]'
        onClick={onCancel}
        disabled={saving}
      >
        Cancel
      </Button>
    </span>
  )
}

export function RecordDrilldownSheet({
  collection,
  itemId,
  layoutId,
  title,
  onClose
}: {
  collection: string
  itemId: string
  layoutId?: number | null
  title?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [editingField, setEditingField] = useState<string | null>(null)

  const { data: detailLayout, isLoading: layoutLoading } = useQuery<DetailLayoutResponse | null>({
    queryKey: ['drilldown-layout', collection, layoutId ?? null],
    queryFn: () =>
      api
        .get(`/collection-layouts/detail/${collection}`, {
          params: layoutId ? { layout_id: layoutId } : {}
        })
        .then((r) => r.data.data ?? null)
  })

  const hasDetailLayout = !!detailLayout

  const { data: fields = [], isLoading: fieldsLoading } = useQuery<FieldConfigRow[]>({
    queryKey: ['drilldown-fields', collection, detailLayout?.layout.id ?? 'fallback'],
    enabled: !layoutLoading,
    queryFn: () =>
      api
        .get(`/field-config/${collection}`, {
          params: detailLayout ? { layout_id: detailLayout.layout.id } : {}
        })
        .then((r) => (r.data.data ?? []) as FieldConfigRow[])
  })

  const {
    data: item,
    isLoading: itemLoading,
    error: itemError
  } = useQuery<Record<string, unknown>>({
    queryKey: ['drilldown-item', collection, itemId],
    queryFn: () => api.get(`/items/${collection}/${itemId}`).then((r) => r.data.data)
  })

  const saveMut = useMutation({
    mutationFn: ({ field, value }: { field: string; value: unknown }) =>
      api.patch(`/items/${collection}/${itemId}`, { [field]: value }),
    onSuccess: () => {
      setEditingField(null)
      qc.invalidateQueries({ queryKey: ['drilldown-item', collection, itemId] })
      qc.invalidateQueries({ queryKey: ['queue-items'] })
    },
    onError: (err: { response?: { status?: number; data?: { error?: string } } }) => {
      const status = err.response?.status
      toast.error(
        status === 403
          ? 'No permission to edit this field'
          : (err.response?.data?.error ?? 'Save failed')
      )
    }
  })

  // Reset edit state when the target record changes.
  useEffect(() => {
    setEditingField(null)
  }, [])

  // With a detail layout, the layout IS the field selection: only assigned,
  // visible fields render. Without one (fallback), show everything not hidden.
  const visibleFields = fields
    .filter((f) => !f.hidden && f.field !== 'id' && !f.field.startsWith('__'))
    .filter((f) => (hasDetailLayout ? f.layout_assigned && f.is_visible !== false && f.is_visible !== 0 : true))
    .sort((a, b) => a.sort - b.sort)

  const groups = detailLayout?.groups ?? []
  const grouped = new Map<string | null, FieldConfigRow[]>()
  for (const f of visibleFields) {
    const key = f.group_key && groups.some((g) => g.key === f.group_key) ? f.group_key : null
    const list = grouped.get(key) ?? []
    list.push(f)
    grouped.set(key, list)
  }
  const sections: Array<{ key: string | null; label: string | null; fields: FieldConfigRow[] }> = [
    ...(grouped.has(null) ? [{ key: null, label: null, fields: grouped.get(null) ?? [] }] : []),
    ...groups
      .filter((g) => grouped.has(g.key))
      .sort((a, b) => a.sort - b.sort)
      .map((g) => ({ key: g.key as string | null, label: g.label, fields: grouped.get(g.key) ?? [] }))
  ]

  const loading = layoutLoading || fieldsLoading || itemLoading

  function fieldEditable(f: FieldConfigRow): boolean {
    // Fallback rendering (no detail layout) is always read-only; with a detail
    // layout, the assignment's readonly override (merged into f.readonly by
    // field-config) plus computed fields gate editing. RBAC enforces on PATCH.
    if (!hasDetailLayout) return false
    if (f.readonly || f.computed_type) return false
    return EDITABLE_TYPES.has(f.type)
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='flex w-[440px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[440px]'>
        <SheetHeader className='shrink-0 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <SheetTitle className='flex items-center justify-between gap-2 pr-6 text-[14px]'>
            <span className='truncate'>{title || `${titleCase(collection)} · ${itemId}`}</span>
            <Link
              to={`/collections/${collection}/${itemId}`}
              className='flex shrink-0 items-center gap-1 text-[11px] font-normal text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              Open record <ExternalLink className='h-3 w-3' />
            </Link>
          </SheetTitle>
          <p className='text-left text-[11px] text-slate-400'>
            {titleCase(collection)}
            {detailLayout ? ` · ${detailLayout.layout.name}` : ''}
          </p>
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3'>
          {loading ? (
            <div className='space-y-2'>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className='h-8 animate-pulse rounded bg-slate-100 dark:bg-muted' />
              ))}
            </div>
          ) : itemError ? (
            <p className='py-8 text-center text-[12px] text-slate-400'>
              Record unavailable — it may have been deleted or you may not have access.
            </p>
          ) : (
            <div className='space-y-4'>
              {sections.map((section) => (
                <div key={section.key ?? '__top__'}>
                  {section.label && (
                    <p className='mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
                      {section.label}
                    </p>
                  )}
                  <div className='gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
                    {section.fields.map((f) => {
                      const editable = fieldEditable(f)
                      const isEditing = editingField === f.field
                      return (
                        <div
                          key={f.field}
                          className='group/row flex items-start gap-3 bg-white px-3 py-2 dark:bg-card'
                        >
                          <span className='w-[120px] shrink-0 pt-px text-[11px] text-slate-500 dark:text-muted-foreground'>
                            {f.label || titleCase(f.field)}
                          </span>
                          <span className='min-w-0 flex-1 text-[12px] text-slate-700 dark:text-slate-200'>
                            {isEditing ? (
                              <InlineEditor
                                field={f}
                                value={item?.[f.field]}
                                saving={saveMut.isPending}
                                onSave={(v) => saveMut.mutate({ field: f.field, value: v })}
                                onCancel={() => setEditingField(null)}
                              />
                            ) : (
                              <span className='flex items-start justify-between gap-2'>
                                <span className={cn('break-words', item?.[f.field] == null && 'text-slate-300 dark:text-muted-foreground')}>
                                  {f.display === 'label' &&
                                  Array.isArray(f.display_options) &&
                                  item?.[f.field] != null ? (
                                    <LabelPill
                                      choices={f.display_options as Array<{ value: string; text: string; background?: string; foreground?: string }>}
                                      value={item[f.field]}
                                    />
                                  ) : (
                                    displayValue(f, item?.[f.field])
                                  )}
                                </span>
                                {editable && (
                                  <button
                                    type='button'
                                    aria-label={`Edit ${f.label || f.field}`}
                                    onClick={() => setEditingField(f.field)}
                                    className='shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-opacity hover:text-slate-600 group-hover/row:opacity-100 dark:hover:text-slate-200'
                                  >
                                    <Pencil className='h-3 w-3' />
                                  </button>
                                )}
                              </span>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {!hasDetailLayout && (
                <p className='text-[10px] text-slate-400'>
                  Read-only view. Create a “Detail (drill-down)” layout on {titleCase(collection)}{' '}
                  to customize this panel and enable inline editing.
                </p>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
