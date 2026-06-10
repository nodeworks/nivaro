import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, PencilLine } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated'
])

const SCALAR_TYPES = new Set(['string', 'text', 'integer', 'float', 'boolean', 'date', 'datetime'])

function toLocalDatetime(value: unknown): string {
  if (!value) return ''
  try {
    return new Date(String(value)).toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

function ScalarInput({
  field,
  value,
  onChange
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const strVal = value === null || value === undefined ? '' : String(value)

  if (field.type === 'boolean') {
    return (
      <div className='flex items-center gap-2'>
        <input
          type='checkbox'
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className='h-4 w-4 rounded accent-nvr-cyan'
        />
        <span className='text-[12px] text-slate-500'>{value ? 'Yes' : 'No'}</span>
      </div>
    )
  }
  if (field.type === 'datetime' || field.interface === 'datetime') {
    return (
      <Input
        type='datetime-local'
        className='h-8 text-[12px]'
        value={toLocalDatetime(value)}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
      />
    )
  }
  if (field.type === 'date') {
    return (
      <Input
        type='date'
        className='h-8 text-[12px]'
        value={strVal.slice(0, 10)}
        onChange={(e) => onChange(e.target.value || null)}
      />
    )
  }
  if (field.type === 'integer' || field.type === 'float') {
    return (
      <Input
        type='number'
        step={field.type === 'float' ? 'any' : '1'}
        className='h-8 text-[12px]'
        value={strVal}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    )
  }
  return (
    <Input
      className='h-8 text-[12px]'
      value={strVal}
      onChange={(e) => onChange(e.target.value || null)}
    />
  )
}

/**
 * Wraps an M2O relation picker with an expand chevron that reveals a
 * collapsible inline sub-form for the related item (first ~6 editable scalar
 * fields), saved via a direct PATCH on the related item. Collapsed by default
 * and fully independent of the parent form's dirty state.
 */
export function InlineRelationEditor({
  relatedCollection,
  relatedId,
  children
}: {
  relatedCollection: string
  relatedId: unknown
  children: React.ReactNode
}) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)

  const hasTarget = relatedId !== null && relatedId !== undefined && relatedId !== ''

  const { data: relatedMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: expanded && hasTarget,
    staleTime: 10 * 60 * 1000
  })

  const { data: relatedItem, isLoading } = useQuery({
    queryKey: ['item', relatedCollection, String(relatedId)],
    queryFn: () => api.get(`/items/${relatedCollection}/${relatedId}`).then((r) => r.data.data),
    enabled: expanded && hasTarget
  })

  // Reset local draft whenever the fetched item (or the target id) changes.
  useEffect(() => {
    if (relatedItem) {
      setDraft(relatedItem as Record<string, unknown>)
      setDirty(false)
    }
  }, [relatedItem])

  const fields: CMSField[] = relatedMeta?.fields ?? []
  const relations: CMSRelation[] = relatedMeta?.relations ?? []
  const fkFields = new Set(
    relations.filter((r) => r.many_collection === relatedCollection).map((r) => r.many_field)
  )

  const editableScalars = fields
    .filter(
      (f) =>
        !f.hidden &&
        !f.readonly &&
        !f.computed_formula &&
        !SYSTEM_FIELDS.has(f.field) &&
        !fkFields.has(f.field) &&
        SCALAR_TYPES.has(f.type)
    )
    .slice(0, 6)

  const saveMut = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch(`/items/${relatedCollection}/${relatedId}`, patch).then((r) => r.data.data),
    onSuccess: (updated) => {
      setDraft(updated as Record<string, unknown>)
      setDirty(false)
      qc.invalidateQueries({ queryKey: ['item', relatedCollection, String(relatedId)] })
      qc.invalidateQueries({ queryKey: ['items', relatedCollection] })
      toast.success('Related item saved')
    },
    onError: () => toast.error('Failed to save related item')
  })

  const handleSave = () => {
    const patch: Record<string, unknown> = {}
    for (const f of editableScalars) patch[f.field] = draft[f.field] ?? null
    saveMut.mutate(patch)
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-1.5'>
        <div className='min-w-0 flex-1'>{children}</div>
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasTarget}
          className={cn(
            'shrink-0 rounded-md border border-slate-200 p-1.5 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600 disabled:opacity-30',
            expanded && 'bg-nvr-cyan/10 text-nvr-cyan border-nvr-cyan/30'
          )}
          title={hasTarget ? 'Edit related item inline' : 'No related item selected'}
          aria-label='Toggle inline editor'
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
          />
        </button>
      </div>

      {expanded && hasTarget && (
        <div className='rounded-lg border border-slate-200 bg-slate-50/60'>
          <div className='flex items-center justify-between border-b border-slate-200 px-3 py-2'>
            <span className='flex items-center gap-1.5 text-[11px] font-medium text-slate-500'>
              <PencilLine className='h-3 w-3' />
              Editing {titleCase(relatedCollection)}
              <span className='font-mono text-slate-400'>#{String(relatedId)}</span>
            </span>
            {dirty && <span className='text-[10px] font-medium text-amber-500'>unsaved</span>}
          </div>
          {isLoading ? (
            <p className='px-3 py-4 text-[12px] text-slate-400'>Loading…</p>
          ) : editableScalars.length === 0 ? (
            <p className='px-3 py-4 text-[12px] text-slate-400'>No editable scalar fields.</p>
          ) : (
            <div className='space-y-3 p-3'>
              <div className='grid grid-cols-2 gap-3'>
                {editableScalars.map((f) => (
                  <div key={f.field} className={cn(f.type === 'text' && 'col-span-2')}>
                    <Label className='mb-1 block text-[11px] text-slate-500'>
                      {titleCase(f.field)}
                    </Label>
                    <ScalarInput
                      field={f}
                      value={draft[f.field]}
                      onChange={(v) => {
                        setDraft((d) => ({ ...d, [f.field]: v }))
                        setDirty(true)
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className='flex justify-end'>
                <Button
                  type='button'
                  size='sm'
                  className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                  disabled={!dirty || saveMut.isPending}
                  onClick={handleSave}
                >
                  {saveMut.isPending ? 'Saving…' : 'Save related item'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
