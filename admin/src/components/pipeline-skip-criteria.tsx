import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CollectionFieldPicker } from '@/components/field-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type SkipCondition, type SkipCriteria, type SkipOp } from '@/lib/api'

const OPS: SkipOp[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notin']

function describeCondition(c: SkipCondition): string {
  switch (c.type) {
    case 'no_owners':
      return 'No owners assigned'
    case 'field_compare':
      return `${c.field || '?'} ${c.op} ${String(c.value ?? '')}`
    case 'field_empty':
      return `${c.field || '?'} is empty`
    case 'field_nonempty':
      return `${c.field || '?'} is not empty`
    case 'lookup_compare':
      return `${c.record_field || '?'} ${c.op} ${c.collection || '?'}.${c.compare_column || '?'}`
  }
}

export function PipelineSkipCriteria({
  stateId,
  stateName,
  templateId,
  initialCriteria,
  collection
}: {
  stateId: string
  stateName: string
  templateId: string
  initialCriteria: SkipCriteria | null
  collection?: string
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<'any' | 'all'>(initialCriteria?.mode ?? 'any')
  const [conditions, setConditions] = useState<SkipCondition[]>(initialCriteria?.conditions ?? [])
  const [fieldRelations, setFieldRelations] = useState<
    Record<number, { collection: string; displayField: string }>
  >({})

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', templateId] })

  const save = useMutation({
    mutationFn: (criteria: SkipCriteria | null) =>
      api.patch(`/pipelines/states/${stateId}/skip`, { criteria }).then((r) => r.data),
    onSuccess: (_data, criteria) => {
      invalidate()
      toast.success(criteria ? 'Skip criteria saved' : 'Skip criteria cleared')
    },
    onError: () => toast.error('Failed to save skip criteria')
  })

  const [impact, setImpact] = useState<{
    evaluated: number
    truncated: boolean
    now_skipped: number
    now_required: number
    changes: Array<{
      collection: string
      item: string
      proposed: boolean
      proposed_reasons: string[]
    }>
  } | null>(null)

  // Dry-run the DRAFT criteria against real records in active instances —
  // "30 of 98 sampled records would newly skip this state" before Save,
  // instead of finding out from the approval queue next week.
  const preview = useMutation({
    mutationFn: () =>
      api
        .post(`/pipelines/${templateId}/simulate-impact`, {
          state_id: stateId,
          skip_criteria: conditions.length ? { mode, conditions } : null,
          limit: 200
        })
        .then((r) => r.data.data),
    onSuccess: (data) => setImpact(data),
    onError: () => toast.error('Impact preview failed')
  })

  const addCondition = (type: SkipCondition['type']) => {
    let next: SkipCondition
    switch (type) {
      case 'no_owners':
        next = { type: 'no_owners' }
        break
      case 'field_compare':
        next = { type: 'field_compare', field: '', op: 'eq', value: '' }
        break
      case 'field_empty':
        next = { type: 'field_empty', field: '' }
        break
      case 'field_nonempty':
        next = { type: 'field_nonempty', field: '' }
        break
      case 'lookup_compare':
        next = {
          type: 'lookup_compare',
          collection: '',
          filters: [],
          compare_column: '',
          record_field: '',
          op: 'lt',
          match: 'any'
        }
        break
    }
    setConditions((c) => [...c, next])
  }

  const updateCondition = (idx: number, patch: Partial<SkipCondition>) =>
    setConditions((c) =>
      c.map((cond, i) => (i === idx ? ({ ...cond, ...patch } as SkipCondition) : cond))
    )

  const removeCondition = (idx: number) => setConditions((c) => c.filter((_, i) => i !== idx))

  const clearAll = () => {
    setConditions([])
    setMode('any')
    save.mutate(null)
  }

  return (
    <div className='space-y-2'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex items-center gap-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-800'
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5' />
        )}
        Skip Criteria
        {conditions.length > 0 && (
          <span className='rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700'>
            {conditions.length}
          </span>
        )}
      </button>

      {!expanded && conditions.length === 0 && (
        <p className='text-[12px] text-slate-400'>
          No skip criteria — this state is never auto-skipped.
        </p>
      )}

      {expanded && (
        <div className='space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4'>
          <p className='text-[12px] text-slate-500'>
            When a record enters <span className='font-medium text-slate-700'>{stateName}</span>, it
            is auto-skipped if the criteria below match.
          </p>

          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Match mode</Label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'any' | 'all')}
              className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
            >
              <option value='any'>Skip if ANY condition is true</option>
              <option value='all'>Skip if ALL conditions are true</option>
            </select>
          </div>

          {conditions.length === 0 ? (
            <p className='text-[12px] text-slate-400'>No conditions added yet.</p>
          ) : (
            <div className='space-y-2'>
              {conditions.map((cond, idx) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
                  key={idx}
                  className='rounded-lg border border-slate-200 bg-white p-2.5 space-y-2'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[11px] font-medium uppercase tracking-wide text-slate-500'>
                      {cond.type.replace('_', ' ')}
                    </span>
                    <button
                      type='button'
                      onClick={() => removeCondition(idx)}
                      className='rounded p-1 text-slate-400 hover:text-red-500'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>

                  {cond.type === 'no_owners' && (
                    <p className='text-[12px] text-slate-500'>{describeCondition(cond)}</p>
                  )}

                  {cond.type === 'field_compare' && (
                    <div className='grid gap-2 sm:grid-cols-3'>
                      <CollectionFieldPicker
                        collection={collection ?? ''}
                        value={cond.field}
                        onChange={(picked) => {
                          updateCondition(idx, { field: picked.path.join('.') })
                          setFieldRelations((m) => {
                            const next = { ...m }
                            if (picked.relatedCollection) {
                              next[idx] = {
                                collection: picked.relatedCollection,
                                displayField: picked.path[picked.path.length - 1]
                              }
                            } else {
                              delete next[idx]
                            }
                            return next
                          })
                        }}
                        onClear={() => {
                          updateCondition(idx, { field: '' })
                          setFieldRelations((m) => {
                            const next = { ...m }
                            delete next[idx]
                            return next
                          })
                        }}
                        placeholder='Select field…'
                      />
                      <select
                        value={cond.op}
                        onChange={(e) => updateCondition(idx, { op: e.target.value as SkipOp })}
                        className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
                      >
                        {OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                      {fieldRelations[idx] ? (
                        <RelationValuePicker
                          relatedCollection={fieldRelations[idx].collection}
                          displayField={fieldRelations[idx].displayField}
                          value={cond.value}
                          onChange={(v) => updateCondition(idx, { value: v })}
                        />
                      ) : (
                        <Input
                          value={String(cond.value ?? '')}
                          onChange={(e) => updateCondition(idx, { value: e.target.value })}
                          placeholder='value'
                          className='h-8 text-[12px]'
                        />
                      )}
                    </div>
                  )}

                  {cond.type === 'lookup_compare' && (
                    <div className='space-y-2'>
                      <p className='text-[11px] text-slate-400'>
                        Skip when a matched row in another collection compares true against a
                        record value (e.g. requisition amount below a threshold table amount).
                        Filter values may come from a record field — plain column, dotted M2O
                        path, or an M2M alias (matches any linked id).
                      </p>
                      <div className='grid gap-2 sm:grid-cols-2'>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>Lookup collection</span>
                          <Input
                            value={cond.collection}
                            onChange={(e) => updateCondition(idx, { collection: e.target.value })}
                            placeholder='thresholds'
                            className='h-8 font-mono text-[12px]'
                          />
                        </div>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>Compare column</span>
                          <Input
                            value={cond.compare_column}
                            onChange={(e) =>
                              updateCondition(idx, { compare_column: e.target.value })
                            }
                            placeholder='threshold_amount'
                            className='h-8 font-mono text-[12px]'
                          />
                        </div>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>Record field</span>
                          <Input
                            value={cond.record_field}
                            onChange={(e) => updateCondition(idx, { record_field: e.target.value })}
                            placeholder='requisition_amount'
                            className='h-8 font-mono text-[12px]'
                          />
                        </div>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>
                            Operator (record vs row)
                          </span>
                          <div className='flex gap-2'>
                            <select
                              value={cond.op}
                              onChange={(e) =>
                                updateCondition(idx, { op: e.target.value as SkipOp })
                              }
                              className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
                            >
                              {OPS.map((op) => (
                                <option key={op} value={op}>
                                  {op}
                                </option>
                              ))}
                            </select>
                            <select
                              value={cond.match ?? 'any'}
                              onChange={(e) =>
                                updateCondition(idx, { match: e.target.value as 'any' | 'all' })
                              }
                              className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
                            >
                              <option value='any'>any row</option>
                              <option value='all'>all rows</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      <div className='space-y-1.5'>
                        <div className='flex items-center justify-between'>
                          <span className='text-[10px] uppercase tracking-wide text-slate-400'>
                            Row filters
                          </span>
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            className='h-6 gap-1 text-[11px]'
                            onClick={() =>
                              updateCondition(idx, {
                                filters: [...cond.filters, { column: '', value: '' }]
                              })
                            }
                          >
                            <Plus className='h-3 w-3' />
                            Filter
                          </Button>
                        </div>
                        {cond.filters.map((f, fi) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: positional
                            key={fi}
                            className='grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-1.5'
                          >
                            <Input
                              value={f.column}
                              onChange={(e) =>
                                updateCondition(idx, {
                                  filters: cond.filters.map((x, i) =>
                                    i === fi ? { ...x, column: e.target.value } : x
                                  )
                                })
                              }
                              placeholder='column'
                              className='h-7 font-mono text-[11px]'
                            />
                            <Input
                              value={String(f.value ?? '')}
                              onChange={(e) =>
                                updateCondition(idx, {
                                  filters: cond.filters.map((x, i) =>
                                    i === fi
                                      ? { ...x, value: e.target.value || undefined }
                                      : x
                                  )
                                })
                              }
                              placeholder='static value'
                              className='h-7 text-[11px]'
                            />
                            <Input
                              value={f.record_field ?? ''}
                              onChange={(e) =>
                                updateCondition(idx, {
                                  filters: cond.filters.map((x, i) =>
                                    i === fi
                                      ? { ...x, record_field: e.target.value || undefined }
                                      : x
                                  )
                                })
                              }
                              placeholder='or record field'
                              className='h-7 font-mono text-[11px]'
                            />
                            <button
                              type='button'
                              onClick={() =>
                                updateCondition(idx, {
                                  filters: cond.filters.filter((_, i) => i !== fi)
                                })
                              }
                              className='rounded p-1 text-slate-400 hover:text-red-500'
                            >
                              <Trash2 className='h-3 w-3' />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(cond.type === 'field_empty' || cond.type === 'field_nonempty') && (
                    <CollectionFieldPicker
                      collection={collection ?? ''}
                      value={cond.field}
                      onChange={(picked) => updateCondition(idx, { field: picked.path.join('.') })}
                      onClear={() => updateCondition(idx, { field: '' })}
                      placeholder='Select field…'
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[12px] text-slate-500'>Add condition:</span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => addCondition('no_owners')}
            >
              <Plus className='h-3 w-3' />
              No Owners
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => addCondition('field_compare')}
            >
              <Plus className='h-3 w-3' />
              Field Compare
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => addCondition('lookup_compare')}
            >
              <Plus className='h-3 w-3' />
              Lookup Compare
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => addCondition('field_empty')}
            >
              <Plus className='h-3 w-3' />
              Field Empty
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => addCondition('field_nonempty')}
            >
              <Plus className='h-3 w-3' />
              Field Not Empty
            </Button>
          </div>

          <div className='flex items-center justify-end gap-2 border-t border-slate-200 pt-3'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='text-[12px]'
              disabled={save.isPending}
              onClick={clearAll}
            >
              Clear All
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='text-[12px]'
              disabled={preview.isPending}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                'Preview impact'
              )}
            </Button>
            <Button
              type='button'
              size='sm'
              className='text-[12px]'
              disabled={save.isPending}
              onClick={() => save.mutate({ mode, conditions })}
            >
              {save.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save'}
            </Button>
          </div>
          {impact && (
            <div className='mt-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 text-[12px] dark:border-border dark:bg-background'>
              <p>
                Across {impact.evaluated} active record(s)
                {impact.truncated ? ' (sampled)' : ''}:{' '}
                <span className='font-medium text-amber-600 dark:text-amber-400'>
                  {impact.now_skipped} would newly skip
                </span>
                {' · '}
                <span className='font-medium text-emerald-600 dark:text-emerald-400'>
                  {impact.now_required} would newly require
                </span>{' '}
                this state under the draft criteria.
              </p>
              {impact.changes.slice(0, 6).map((c) => (
                <p key={`${c.collection}-${c.item}`} className='mt-1 text-[11px] text-muted-foreground'>
                  {c.collection}/{c.item}: {c.proposed ? 'skips' : 'requires'}
                  {c.proposed_reasons[0] ? ` — ${c.proposed_reasons[0]}` : ''}
                </p>
              ))}
              {impact.changes.length > 6 && (
                <p className='mt-1 text-[11px] text-muted-foreground'>
                  +{impact.changes.length - 6} more changed records
                </p>
              )}
              {impact.now_skipped === 0 && impact.now_required === 0 && (
                <p className='mt-1 text-[11px] text-muted-foreground'>
                  No record's skip decision changes.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type RelationItem = Record<string, unknown> & { id: string | number }

function RelationValuePicker({
  relatedCollection,
  displayField,
  value,
  onChange
}: {
  relatedCollection: string
  displayField: string
  value: unknown
  onChange: (value: unknown) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['skip-relation-items', relatedCollection],
    queryFn: () =>
      api
        .get(`/items/${relatedCollection}`, { params: { limit: 200 } })
        .then((r) => (r.data?.data ?? []) as RelationItem[]),
    enabled: !!relatedCollection
  })

  if (isLoading) {
    return (
      <div className='flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[12px] text-slate-400'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Loading…
      </div>
    )
  }

  const items = data ?? []

  return (
    <select
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value)}
      className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
    >
      <option value=''>— any —</option>
      {items.map((item) => {
        const label = String(item[displayField] ?? item.id)
        const val = String(item[displayField] ?? item.id)
        return (
          <option key={String(item.id)} value={val}>
            {label}
          </option>
        )
      })}
    </select>
  )
}
