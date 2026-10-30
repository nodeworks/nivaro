import { Check, ChevronsUpDown, Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { describeCascadeFilter } from '../../../lib/config-sentences'
import { cn } from '../../../lib/utils'
import { ConfigReadBack } from '../../ConfigReadBack'
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
import { useCollectionBody } from '../collection-meta'
import { tintCard } from '../panel-style'

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

const SWITCH_CLS =
  'h-[18px] w-8 border-0 data-[state=checked]:bg-nvr-cyan data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-600 [&>span]:mx-0.5 [&>span]:h-3.5 [&>span]:w-3.5 [&>span]:bg-white [&>span]:shadow-sm [&>span]:data-[state=checked]:translate-x-3.5'

export function CascadeFiltersEditor({
  rules,
  m2oFields,
  relatedCollection,
  fieldLabel,
  onChange
}: {
  rules: CascadeFilterRule[]
  m2oFields: CascadeParentField[]
  relatedCollection?: string | null
  /** The picker's own label, for the read-back sentence. */
  fieldLabel?: string
  onChange: (rules: CascadeFilterRule[]) => void
}) {
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

  const { data: relColMeta } = useCollectionBody(relatedCollection)
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
    <div className='space-y-2'>
      {rules.length > 0 && (
        <div className='space-y-2'>
          {rules.map((rule, idx) => {
            const parentMeta = m2oFields.find((f) => f.field === rule.parent_field)
            const parentLabel = parentMeta?.label ?? rule.parent_field
            const isM2MParent = parentMeta?.kind === 'M2M'
            const isEditing = editingIdx === idx

            if (isEditing) {
              return (
                <div
                  key={idx}
                  className={cn(tintCard, 'space-y-3 p-3 ring-nvr-cyan/40 dark:ring-nvr-cyan/30')}
                >
                  <div>
                    <p className='mb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                      Parent field
                    </p>
                    <Popover open={editPfOpen} onOpenChange={setEditPfOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:bg-muted dark:border-border dark:bg-background dark:text-foreground'
                        >
                          {(() => {
                            const sel = m2oFields.find((f) => f.field === editParentField)
                            return sel ? (
                              <span className='flex items-center gap-1.5'>
                                {sel.label}
                                {sel.kind === 'M2M' && (
                                  <span className='rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'>
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
                          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                          <CommandList>
                            <CommandEmpty className='py-3 text-center text-[12px] text-slate-400'>
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
                                  className='text-[12px]'
                                >
                                  <Check
                                    className={cn(
                                      'mr-1.5 h-3 w-3 shrink-0',
                                      editParentField === item.field ? 'opacity-100' : 'opacity-0'
                                    )}
                                  />
                                  <span className='flex-1'>{item.label}</span>
                                  {item.kind === 'M2M' && (
                                    <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'>
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
                  <div data-setting='field.cascade_filters.filter_column'>
                    <p className='mb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                      Filter column on
                      {relatedCollection ? ` ${relatedCollection}` : ' related table'}
                    </p>
                    {relatedFields.length > 0 ? (
                      <Popover open={editFcOpen} onOpenChange={setEditFcOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type='button'
                            className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[13px] hover:bg-muted dark:border-border dark:bg-background'
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
                              className='h-8 text-[12px]'
                            />
                            <CommandList>
                              <CommandEmpty className='py-3 text-center text-[12px] text-slate-400'>
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
                                    className='font-mono text-[12px]'
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
                        className='h-8 font-mono text-[12px]'
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
              <div key={idx} className={cn(tintCard, 'space-y-2 p-3')}>
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
                    aria-label='Edit filter'
                    data-tip='Edit filter'
                    className='inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-foreground'
                  >
                    <Pencil className='h-3 w-3' />
                  </button>
                  <button
                    type='button'
                    onClick={() => removeRule(idx)}
                    aria-label='Remove filter'
                    data-tip='Remove filter'
                    className='inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-red-600 dark:hover:bg-muted dark:hover:text-red-400'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='-mt-1'>
                  <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {rule.filter_column}
                  </span>
                  {rule.filter_is_m2m && (
                    <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'>
                      M2M filter
                    </span>
                  )}
                </div>
                <div
                  className='flex items-center gap-2 pt-1'
                  data-setting='field.cascade_filters.clear_on_parent_change'
                >
                  <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                    Clear on parent change
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_parent_change}
                    onCheckedChange={(val) => toggleClear(idx, val)}
                    className={SWITCH_CLS}
                  />
                </div>
                <div
                  className='flex items-center gap-2'
                  data-setting='field.cascade_filters.clear_on_unavailable'
                >
                  <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                    Clear if value unavailable
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_unavailable ?? false}
                    onCheckedChange={(val) => toggleUnavailable(idx, val)}
                    className={SWITCH_CLS}
                  />
                </div>
                <div
                  className='flex items-center gap-2'
                  data-setting='field.cascade_filters.show_all_if_no_parent'
                >
                  <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                    Show all options if parent not set
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.show_all_if_no_parent ?? true}
                    onCheckedChange={(val) => toggleShowAll(idx, val)}
                    className={SWITCH_CLS}
                  />
                </div>
                <div
                  className='flex items-center gap-2'
                  data-setting='field.cascade_filters.upstream'
                >
                  <span
                    className='text-[12px] text-slate-600 dark:text-muted-foreground'
                    data-tip="Picking this field fills the parent from the picked record's filter column — the cascade run in reverse. Scalar parents fill only when one value resolves; multi-select parents add every resolved link."
                  >
                    Also fill parent upstream on pick
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.upstream ?? false}
                    onCheckedChange={(val) => toggleUpstream(idx, val)}
                    className={SWITCH_CLS}
                  />
                </div>
                <ConfigReadBack
                  kind='cascade-filter'
                  sentences={describeCascadeFilter(
                    rule,
                    { field: '__picker', relatedCollection },
                    {
                      fields: {
                        __picker: fieldLabel ?? 'This picker',
                        ...Object.fromEntries(m2oFields.map((f) => [f.field, f.label]))
                      },
                      relatedFields: relatedCollection
                        ? {
                            [relatedCollection]: Object.fromEntries(
                              (relColMeta?.fields ?? [])
                                .filter((f: { label?: string | null }) => f.label)
                                .map((f: { field: string; label: string }) => [f.field, f.label])
                            )
                          }
                        : undefined,
                      collections:
                        relatedCollection && relColMeta?.display_name
                          ? { [relatedCollection]: String(relColMeta.display_name) }
                          : undefined
                    }
                  )}
                />
              </div>
            )
          })}
        </div>
      )}

      {!adding && (
        <button
          type='button'
          onClick={openAdd}
          className='flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
        >
          <Plus className='h-3 w-3' />
          {rules.length > 0 ? 'Add another filter' : 'Add cascade filter'}
        </button>
      )}

      {adding && (
        <div
          className={cn(tintCard, 'space-y-3 p-3')}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {/* parent field combobox */}
          <div>
            <p className='mb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Parent field
            </p>
            <Popover open={pfOpen} onOpenChange={setPfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:bg-muted dark:border-border dark:bg-background dark:text-foreground'
                >
                  {(() => {
                    const sel = m2oFields.find((f) => f.field === parentField)
                    return sel ? (
                      <span className='flex items-center gap-1.5'>
                        {sel.label}
                        {sel.kind === 'M2M' && (
                          <span className='rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'>
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
                  <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandEmpty className='py-3 text-center text-[12px] text-slate-400'>
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
                          className='text-[12px]'
                        >
                          <Check
                            className={cn(
                              'mr-1.5 h-3 w-3 shrink-0',
                              parentField === item.field ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <span className='flex-1'>{item.label}</span>
                          {item.kind === 'M2M' && (
                            <span className='ml-1.5 rounded px-1 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'>
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
          <div data-setting='field.cascade_filters.filter_column'>
            <p className='mb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Filter column on{relatedCollection ? ` ${relatedCollection}` : ' related table'}
            </p>
            {relatedFields.length > 0 ? (
              <Popover open={fcOpen} onOpenChange={setFcOpen}>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[13px] hover:bg-muted dark:border-border dark:bg-background'
                  >
                    <span className={filterColumn ? 'font-mono text-slate-700' : 'text-slate-400'}>
                      {filterColumn || 'Select column…'}
                    </span>
                    <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-52 p-0' align='start'>
                  <Command>
                    <CommandInput placeholder='Search columns…' className='h-8 text-[12px]' />
                    <CommandList>
                      <CommandEmpty className='py-3 text-center text-[12px] text-slate-400'>
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
                            className='font-mono text-[12px]'
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
                className='h-8 font-mono text-[12px]'
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
              <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                Clear on parent change
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={clearOnUnavailable}
                onCheckedChange={setClearOnUnavailable}
                className='scale-75'
              />
              <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                Clear if value no longer in options
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={showAllIfNoParent}
                onCheckedChange={setShowAllIfNoParent}
                className='scale-75'
              />
              <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
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
