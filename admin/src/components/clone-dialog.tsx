import { Copy, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { type CMSField, type CMSRelation, api } from '@/lib/api'
import { findM2ORelation } from '@/lib/relations'
import { RelationPicker } from '@/components/relation-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn, titleCase } from '@/lib/utils'

const SKIP_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
])

function toLocalDatetime(value: unknown): string {
  if (!value) return ''
  try { return new Date(String(value)).toISOString().slice(0, 16) } catch { return '' }
}

function isCloneable(f: CMSField, relations: CMSRelation[], collection: string) {
  if (SKIP_FIELDS.has(f.field)) return false
  if (f.computed_type) return false
  const iface = f.interface ?? ''
  if (['sub_rows', 'repeater', 'rich_text', 'file', 'image', 'o2m', 'm2m', 'm2a'].includes(iface)) return false
  if (['sub_rows', 'repeater', 'rich_text'].includes(f.type)) return false
  // skip O2M virtual fields (no DB column)
  const isO2M = relations.some(
    (r) => r.one_collection === collection && r.one_field === f.field
  )
  if (isO2M) return false
  return true
}

function isSubRowField(f: CMSField) {
  return f.interface === 'sub_rows' || f.type === 'sub_rows'
}

interface FieldState {
  include: boolean
  value: unknown
}

// Inline field input — mirrors ItemEdit's FieldInput but simplified
function CloneFieldInput({
  field,
  value,
  onChange,
  collection,
  relations,
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  collection: string
  relations: CMSRelation[]
}) {
  const m2o = findM2ORelation(relations, collection, field.field)
  if (m2o) {
    return (
      <RelationPicker
        relatedCollection={m2o.one_collection!}
        value={value}
        onChange={onChange}
      />
    )
  }

  if (field.type === 'boolean') {
    return (
      <div className='flex items-center gap-2'>
        <input
          type='checkbox'
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className='h-4 w-4 accent-nvr-cyan rounded'
        />
        <span className='text-[12px] text-slate-500'>{Boolean(value) ? 'Yes' : 'No'}</span>
      </div>
    )
  }

  if (field.type === 'datetime' || field.interface === 'datetime') {
    return (
      <Input
        type='datetime-local'
        value={toLocalDatetime(value)}
        onChange={(e) =>
          onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
        }
        className='h-7 text-[12px]'
      />
    )
  }

  if (field.type === 'date') {
    const strVal = value ? String(value).slice(0, 10) : ''
    return (
      <Input
        type='date'
        value={strVal}
        onChange={(e) => onChange(e.target.value || null)}
        className='h-7 text-[12px]'
      />
    )
  }

  if (field.type === 'integer' || field.type === 'bigInteger') {
    return (
      <Input
        type='number'
        step='1'
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className='h-7 text-[12px]'
      />
    )
  }

  if (field.type === 'float' || field.type === 'decimal' || field.type === 'double') {
    return (
      <Input
        type='number'
        step='any'
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className='h-7 text-[12px]'
      />
    )
  }

  return (
    <Input
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value || null)}
      className='h-7 text-[12px]'
      placeholder='(empty)'
    />
  )
}

interface Props {
  collection: string
  itemId: string
  fields: CMSField[]
  relations: CMSRelation[]
  currentValues: Record<string, unknown>
  onSuccess: (newId: string | number) => void
}

export function CloneDialog({ collection, itemId, fields, relations, currentValues, onSuccess, triggerClassName }: Props & { triggerClassName?: string }) {
  const [open, setOpen] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [fieldStates, setFieldStates] = useState<Record<string, FieldState>>({})
  const [subRowIncludes, setSubRowIncludes] = useState<Record<string, boolean>>({})

  const cloneableFields = fields.filter((f) => isCloneable(f, relations, collection))
  const subRowFields = fields.filter(isSubRowField)

  function openFresh() {
    const init: Record<string, FieldState> = {}
    for (const f of cloneableFields) {
      init[f.field] = { include: true, value: currentValues[f.field] ?? null }
    }
    setFieldStates(init)
    const srInit: Record<string, boolean> = {}
    for (const f of subRowFields) srInit[f.field] = true
    setSubRowIncludes(srInit)
    setOpen(true)
  }

  function setFieldValue(field: string, value: unknown) {
    setFieldStates((s) => ({ ...s, [field]: { ...s[field], value } }))
  }

  function toggleInclude(field: string) {
    setFieldStates((s) => ({ ...s, [field]: { ...s[field], include: !s[field].include } }))
  }

  function resetValue(field: string) {
    setFieldStates((s) => ({
      ...s,
      [field]: { ...s[field], value: currentValues[field] ?? null },
    }))
  }

  function isDirty(field: string, state: FieldState): boolean {
    const orig = currentValues[field] ?? null
    return JSON.stringify(state.value) !== JSON.stringify(orig)
  }

  async function handleClone() {
    setCloning(true)
    try {
      const field_overrides: Record<string, unknown> = {}
      const exclude_fields: string[] = []

      for (const f of cloneableFields) {
        const state = fieldStates[f.field]
        if (!state) continue
        if (!state.include) { exclude_fields.push(f.field); continue }
        if (isDirty(f.field, state)) field_overrides[f.field] = state.value
      }

      const include_sub_rows = subRowFields
        .filter((f) => subRowIncludes[f.field])
        .map((f) => f.field)

      const res = await api.post<{ data: { id: string | number } }>(
        `/items/${collection}/${itemId}/clone`,
        { field_overrides, exclude_fields, include_sub_rows }
      )

      toast.success('Item cloned')
      setOpen(false)
      onSuccess(res.data.data.id)
    } catch {
      toast.error('Failed to clone item')
    } finally {
      setCloning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) openFresh(); else setOpen(false) }}>
      <DialogTrigger asChild>
        <Button size='sm' variant='outline' className={triggerClassName}>
          <Copy className='mr-1.5 h-3.5 w-3.5' />
          Clone
        </Button>
      </DialogTrigger>

      <DialogContent className='flex max-h-[85vh] max-w-lg flex-col overflow-hidden'>
        <DialogHeader className='shrink-0 px-6 pt-6'>
          <DialogTitle className='text-[15px]'>Clone item</DialogTitle>
        </DialogHeader>

        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-4'>
          <div className='space-y-4'>
            {/* Cloneable fields */}
            {cloneableFields.length > 0 && (
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                  Field values
                </p>
                <div className='space-y-2'>
                  {cloneableFields.map((f) => {
                    const state = fieldStates[f.field]
                    if (!state) return null
                    const dirty = isDirty(f.field, state)
                    return (
                      <div key={f.field} className='flex items-start gap-2'>
                        <Switch
                          checked={state.include}
                          onCheckedChange={() => toggleInclude(f.field)}
                          className='mt-1 shrink-0 scale-75'
                        />
                        <Label className={cn(
                          'mt-1.5 w-32 shrink-0 truncate text-[12px]',
                          !state.include && 'text-slate-400 line-through',
                        )}>
                          {titleCase(f.field)}
                        </Label>
                        <div className={cn('flex-1', !state.include && 'pointer-events-none opacity-40')}>
                          <CloneFieldInput
                            field={f}
                            value={state.value}
                            onChange={(v) => setFieldValue(f.field, v)}
                            collection={collection}
                            relations={relations}
                          />
                        </div>
                        {dirty && state.include && (
                          <button
                            type='button'
                            title='Reset to original'
                            onClick={() => resetValue(f.field)}
                            className='mt-1.5 shrink-0 text-slate-400 hover:text-slate-600'
                          >
                            <RotateCcw className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Sub-rows */}
            {subRowFields.length > 0 && (
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                  Sub-rows
                </p>
                <div className='space-y-2'>
                  {subRowFields.map((f) => (
                    <div key={f.field} className='flex items-center gap-2'>
                      <Switch
                        checked={!!subRowIncludes[f.field]}
                        onCheckedChange={(v) =>
                          setSubRowIncludes((s) => ({ ...s, [f.field]: v }))
                        }
                        className='shrink-0 scale-75'
                      />
                      <Label className='text-[12px]'>
                        Include <span className='font-mono'>{f.field}</span> sub-rows
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className='shrink-0 border-t border-slate-100 px-6 py-4 dark:border-border'>
          <Button variant='outline' size='sm' onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size='sm' disabled={cloning} onClick={handleClone}>
            <Copy className='mr-1.5 h-3.5 w-3.5' />
            {cloning ? 'Cloning…' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
