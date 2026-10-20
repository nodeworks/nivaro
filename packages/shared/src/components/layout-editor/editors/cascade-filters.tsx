import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../../ui/command'
import { Input } from '../../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Switch } from '../../ui/switch'
import { useEditorApi } from './editor-api'

export interface CascadeFilterRule {
  parent_field: string
  filter_column: string
  clear_on_parent_change: boolean
  clear_on_unavailable: boolean
  filter_is_m2m?: boolean
  show_all_if_no_parent?: boolean
  /** Reverse on pick: choosing this field fills parent_field from the picked
   *  record's filter_column value(s) — upstream cascading. */
  upstream?: boolean
}

export interface CascadeParentField {
  field: string
  label: string
  kind: 'M2O' | 'M2M'
}

export function CascadeFiltersEditor({
  rules,
  m2oFields,
  relatedCollection,
  onChange
}: {
  rules: CascadeFilterRule[]
  m2oFields: CascadeParentField[]
  relatedCollection?: string | null
  onChange: (rules: CascadeFilterRule[]) => void
}) {
  const api = useEditorApi()
  const [adding, setAdding] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [parentField, setParentField] = useState('')
  const [filterColumn, setFilterColumn] = useState('')
  const [fcOpen, setFcOpen] = useState(false)
  const [pfOpen, setPfOpen] = useState(false)
  const [editPfOpen, setEditPfOpen] = useState(false)
  const [editFcOpen, setEditFcOpen] = useState(false)
  const [editParentField, setEditParentField] = useState('')
  const [editFilterColumn, setEditFilterColumn] = useState('')

  const { data: relColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection,
    staleTime: 10 * 60 * 1000
  })
  const relatedFields: string[] = relColMeta?.fields?.map((f: { field: string }) => f.field) ?? []
  const [clearOnChange, setClearOnChange] = useState(true)
  const [clearOnUnavailable, setClearOnUnavailable] = useState(false)
  const [showAllIfNoParent, setShowAllIfNoParent] = useState(true)

  function openAdd() {
    setEditingIdx(null)
    setParentField('')
    setFilterColumn('')
    setClearOnChange(true)
    setClearOnUnavailable(false)
    setShowAllIfNoParent(true)
    setAdding(true)
  }

  function cancelAdd() {
    setAdding(false)
  }

  function computeFilterIsMm(fc: string) {
    const relRels = (relColMeta?.relations ?? []) as Array<{
      one_field?: string
      junction_field?: string
    }>
    return relRels.some((r) => r.one_field === fc && !!r.junction_field)
  }

  function saveAdd() {
    if (!parentField.trim() || !filterColumn.trim()) return
    const fc = filterColumn.trim()
    onChange([
      ...rules,
      {
        parent_field: parentField.trim(),
        filter_column: fc,
        clear_on_parent_change: clearOnChange,
        clear_on_unavailable: clearOnUnavailable,
        filter_is_m2m: computeFilterIsMm(fc),
        show_all_if_no_parent: showAllIfNoParent
      }
    ])
    setAdding(false)
  }

  function openEdit(idx: number) {
    setAdding(false)
    setEditParentField(rules[idx].parent_field)
    setEditFilterColumn(rules[idx].filter_column)
    setEditingIdx(idx)
  }

  function cancelEdit() {
    setEditingIdx(null)
  }

  function saveEdit() {
    if (editingIdx === null) return
    if (!editParentField.trim() || !editFilterColumn.trim()) return
    const fc = editFilterColumn.trim()
    onChange(
      rules.map((r, i) =>
        i === editingIdx
          ? {
              ...r,
              parent_field: editParentField.trim(),
              filter_column: fc,
              filter_is_m2m: computeFilterIsMm(fc)
            }
          : r
      )
    )
    setEditingIdx(null)
  }

  function removeRule(idx: number) {
    onChange(rules.filter((_, i) => i !== idx))
  }

  function toggleClear(idx: number, val: boolean) {
    onChange(
      rules.map((r, i) =>
        i === idx
          ? {
              ...r,
              clear_on_parent_change: val,
              clear_on_unavailable: r.clear_on_unavailable ?? false
            }
          : r
      )
    )
  }

  function toggleUnavailable(idx: number, val: boolean) {
    onChange(rules.map((r, i) => (i === idx ? { ...r, clear_on_unavailable: val } : r)))
  }

  function toggleShowAll(idx: number, val: boolean) {
    onChange(rules.map((r, i) => (i === idx ? { ...r, show_all_if_no_parent: val } : r)))
  }

  function toggleUpstream(idx: number, val: boolean) {
    onChange(rules.map((r, i) => (i === idx ? { ...r, upstream: val } : r)))
  }

  return (
    <div className='mt-4 border-t border-[#e2e8f0] pt-4'>
      <p
        className='mb-2 text-[11px] font-medium text-[#6b7280]'
        style={{ letterSpacing: '0.01em' }}
      >
        Cascade Filters
      </p>

      {rules.length > 0 && (
        <div className='mb-2 space-y-2'>
          {rules.map((rule, idx) => {
            const parentMeta = m2oFields.find((f) => f.field === rule.parent_field)
            const parentLabel = parentMeta?.label ?? rule.parent_field
            const isM2MParent = parentMeta?.kind === 'M2M'
            const isEditing = editingIdx === idx

            if (isEditing) {
              return (
                <div
                  key={idx}
                  className='space-y-2 rounded-md border border-nvr-cyan/40 bg-[#f6f8fa] p-2 dark:border-nvr-cyan/30 dark:bg-muted/40'
                >
                  <div>
                    <p className='mb-1 text-[11px] text-slate-500'>Parent field</p>
                    <Popover open={editPfOpen} onOpenChange={setEditPfOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-muted dark:border-border dark:bg-background dark:text-foreground'
                        >
                          {(() => {
                            const sel = m2oFields.find((f) => f.field === editParentField)
                            return sel ? (
                              <span className='flex items-center gap-1.5'>
                                {sel.label}
                                {sel.kind === 'M2M' && (
                                  <span className='rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700'>
                                    M2M
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className='text-slate-400'>Parent field…</span>
                            )
                          })()}
                          <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className='w-56 p-0' align='start'>
                        <Command>
                          <CommandInput placeholder='Search fields…' className='h-7 text-[11px]' />
                          <CommandList>
                            <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                              No relation fields
                            </CommandEmpty>
                            <CommandGroup>
                              {m2oFields.map((item) => (
                                <CommandItem
                                  key={item.field}
                                  value={item.label}
                                  onSelect={() => {
                                    setEditParentField(item.field)
                                    setEditPfOpen(false)
                                  }}
                                  className='text-[11px]'
                                >
                                  <Check
                                    className={cn(
                                      'mr-1.5 h-3 w-3 shrink-0',
                                      editParentField === item.field ? 'opacity-100' : 'opacity-0'
                                    )}
                                  />
                                  <span className='flex-1'>{item.label}</span>
                                  {item.kind === 'M2M' && (
                                    <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700'>
                                      M2M
                                    </span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div>
                    <p className='mb-1 text-[11px] text-slate-500'>
                      Filter column on
                      {relatedCollection ? ` ${relatedCollection}` : ' related table'}
                    </p>
                    {relatedFields.length > 0 ? (
                      <Popover open={editFcOpen} onOpenChange={setEditFcOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type='button'
                            className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] hover:bg-muted dark:border-border dark:bg-background'
                          >
                            <span
                              className={
                                editFilterColumn ? 'font-mono text-slate-700' : 'text-slate-400'
                              }
                            >
                              {editFilterColumn || 'Select column…'}
                            </span>
                            <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className='w-52 p-0' align='start'>
                          <Command>
                            <CommandInput
                              placeholder='Search columns…'
                              className='h-7 text-[11px]'
                            />
                            <CommandList>
                              <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                                No columns
                              </CommandEmpty>
                              <CommandGroup>
                                {relatedFields.map((f) => (
                                  <CommandItem
                                    key={f}
                                    value={f}
                                    onSelect={() => {
                                      setEditFilterColumn(f)
                                      setEditFcOpen(false)
                                    }}
                                    className='font-mono text-[11px]'
                                  >
                                    <Check
                                      className={cn(
                                        'mr-1.5 h-3 w-3 shrink-0',
                                        editFilterColumn === f ? 'opacity-100' : 'opacity-0'
                                      )}
                                    />
                                    {f}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <Input
                        value={editFilterColumn}
                        onChange={(e) => setEditFilterColumn(e.target.value)}
                        placeholder='e.g. division_id'
                        className='h-7 font-mono text-[11px]'
                      />
                    )}
                  </div>
                  <div className='flex items-center gap-2'>
                    <span className='flex-1' />
                    <button
                      type='button'
                      onClick={cancelEdit}
                      className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-muted'
                    >
                      Cancel
                    </button>
                    <Button
                      size='sm'
                      disabled={!editParentField || !editFilterColumn.trim()}
                      onClick={saveEdit}
                      className='h-7 px-3 py-1.5 text-[12px]'
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )
            }

            return (
              <div
                key={idx}
                className='rounded-md border border-[#e2e8f0] bg-[#f6f8fa] px-3 py-2 dark:border-border dark:bg-muted/40'
              >
                <div
                  className='flex items-center gap-1.5'
                  data-setting='field.cascade_filters.parent_field'
                >
                  <span className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                    {parentLabel}
                  </span>
                  {isM2MParent && (
                    <span className='rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'>
                      M2M
                    </span>
                  )}
                  <span className='flex-1' />
                  <button
                    type='button'
                    onClick={() => openEdit(idx)}
                    className='rounded p-0.5 text-slate-300 transition-colors hover:text-slate-600'
                  >
                    <Pencil className='h-3 w-3' />
                  </button>
                  <button
                    type='button'
                    onClick={() => removeRule(idx)}
                    className='rounded p-0.5 text-slate-300 transition-colors hover:text-red-400'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='mt-1' data-setting='field.cascade_filters.filter_column'>
                  <span className='font-mono text-[11px] text-[#6b7280]'>{rule.filter_column}</span>
                  {rule.filter_is_m2m && (
                    <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'>
                      M2M filter
                    </span>
                  )}
                </div>
                <div
                  className='mt-1.5 flex items-center gap-1.5'
                  data-setting='field.cascade_filters.clear_on_parent_change'
                >
                  <span className='text-[11px] text-slate-400'>Clear on parent change</span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_parent_change}
                    onCheckedChange={(val) => toggleClear(idx, val)}
                    className='scale-75'
                  />
                </div>
                <div
                  className='mt-1 flex items-center gap-1.5'
                  data-setting='field.cascade_filters.clear_on_unavailable'
                >
                  <span className='text-[11px] text-slate-400'>Clear if value unavailable</span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_unavailable ?? false}
                    onCheckedChange={(val) => toggleUnavailable(idx, val)}
                    className='scale-75'
                  />
                </div>
                <div
                  className='mt-1 flex items-center gap-1.5'
                  data-setting='field.cascade_filters.show_all_if_no_parent'
                >
                  <span className='text-[11px] text-slate-400'>
                    Show all options if parent not set
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.show_all_if_no_parent ?? true}
                    onCheckedChange={(val) => toggleShowAll(idx, val)}
                    className='scale-75'
                  />
                </div>
                <div
                  className='mt-1 flex items-center gap-1.5'
                  data-setting='field.cascade_filters.upstream'
                >
                  <span
                    className='text-[11px] text-slate-400'
                    data-tip="Picking this field fills the parent from the picked record's filter column — the cascade run in reverse. Scalar parents fill only when one value resolves; multi-select parents add every resolved link."
                  >
                    Also fill parent upstream on pick
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.upstream ?? false}
                    onCheckedChange={(val) => toggleUpstream(idx, val)}
                    className='scale-75'
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!adding && (
        <button
          type='button'
          onClick={openAdd}
          className='flex items-center gap-1 text-[12px] text-[#00ceff] hover:text-[#00ceff]/80'
        >
          <Plus className='h-3 w-3' />
          {rules.length > 0 ? 'Add another filter' : 'Add cascade filter'}
        </button>
      )}

      {adding && (
        <div
          className='space-y-2 rounded-md border border-[#e2e8f0] bg-[#f6f8fa] p-2 dark:border-border dark:bg-muted/40'
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {/* parent field combobox */}
          <div>
            <p className='mb-1 text-[11px] text-slate-500'>Parent field</p>
            <Popover open={pfOpen} onOpenChange={setPfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-muted dark:border-border dark:bg-background dark:text-foreground'
                >
                  {(() => {
                    const sel = m2oFields.find((f) => f.field === parentField)
                    return sel ? (
                      <span className='flex items-center gap-1.5'>
                        {sel.label}
                        {sel.kind === 'M2M' && (
                          <span className='rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700'>
                            M2M
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className='text-slate-400'>Parent field…</span>
                    )
                  })()}
                  <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-56 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search fields…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                      No relation fields
                    </CommandEmpty>
                    <CommandGroup>
                      {m2oFields.map((item) => (
                        <CommandItem
                          key={item.field}
                          value={item.label}
                          onSelect={() => {
                            setParentField(item.field)
                            setPfOpen(false)
                          }}
                          className='text-[11px]'
                        >
                          <Check
                            className={cn(
                              'mr-1.5 h-3 w-3 shrink-0',
                              parentField === item.field ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <span className='flex-1'>{item.label}</span>
                          {item.kind === 'M2M' && (
                            <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700'>
                              M2M
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {parentField && m2oFields.find((f) => f.field === parentField)?.kind === 'M2M' && (
              <p className='mt-1 text-[11px] text-amber-600 dark:text-amber-400'>
                M2M parent: the first staged selection's value is used as the filter.
              </p>
            )}
          </div>

          {/* filter column */}
          <div>
            <p className='mb-1 text-[11px] text-slate-500'>
              Filter column on{relatedCollection ? ` ${relatedCollection}` : ' related table'}
            </p>
            {relatedFields.length > 0 ? (
              <Popover open={fcOpen} onOpenChange={setFcOpen}>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] hover:bg-muted dark:border-border dark:bg-background'
                  >
                    <span className={filterColumn ? 'font-mono text-slate-700' : 'text-slate-400'}>
                      {filterColumn || 'Select column…'}
                    </span>
                    <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-52 p-0' align='start'>
                  <Command>
                    <CommandInput placeholder='Search columns…' className='h-7 text-[11px]' />
                    <CommandList>
                      <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                        No columns
                      </CommandEmpty>
                      <CommandGroup>
                        {relatedFields.map((f) => (
                          <CommandItem
                            key={f}
                            value={f}
                            onSelect={() => {
                              setFilterColumn(f)
                              setFcOpen(false)
                            }}
                            className='font-mono text-[11px]'
                          >
                            <Check
                              className={cn(
                                'mr-1.5 h-3 w-3 shrink-0',
                                filterColumn === f ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            {f}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <Input
                value={filterColumn}
                onChange={(e) => setFilterColumn(e.target.value)}
                placeholder='e.g. division_id'
                className='h-7 font-mono text-[11px]'
              />
            )}
          </div>

          {/* clear options + actions */}
          <div className='space-y-1.5'>
            <div className='flex items-center gap-2'>
              <Switch
                checked={clearOnChange}
                onCheckedChange={setClearOnChange}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600 dark:text-muted-foreground'>
                Clear on parent change
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={clearOnUnavailable}
                onCheckedChange={setClearOnUnavailable}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600 dark:text-muted-foreground'>
                Clear if value no longer in options
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={showAllIfNoParent}
                onCheckedChange={setShowAllIfNoParent}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600 dark:text-muted-foreground'>
                Show all options if parent not set
              </span>
            </div>
          </div>
          <div className='flex items-center gap-2'>
            <span className='flex-1' />
            <button
              type='button'
              onClick={cancelAdd}
              className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-muted'
            >
              Cancel
            </button>
            <Button
              size='sm'
              disabled={!parentField || !filterColumn.trim()}
              onClick={saveAdd}
              className='h-7 px-3 py-1.5 text-[12px]'
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
