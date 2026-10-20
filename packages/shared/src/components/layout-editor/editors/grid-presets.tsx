import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Input } from '../../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useEditorApi } from './editor-api'
import { NUMERIC_FIELD_TYPES } from './row-rule-row'

// _key is a client-only React list key (never serialized — save() reads only
// the named fields below), so reordering keeps identity stable across moves.
export type ColumnPresetItem = { name: string; columns: string[]; _key: string }
export type DrawerRelationItem = { field: string; sumField: string; capField: string; _key: string }
export type PresetFieldOption = { field: string; label: string }
// One group per relatedCollection layout columns (heading undefined) plus one group
// per configured drawer relation offering "relationField.memberField" dot tokens.
export type PresetOptionGroup = { heading?: string; options: PresetFieldOption[] }

// Module-level (not per-render) so useMemo deps referencing them are stable —
// mirrors InlineTableField's NON_DISPLAY_TYPES/SENTINEL_FIELDS/SPECIAL_GROUP_KEYS predicate.
export const PRESET_NON_DISPLAY_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])
export const PRESET_SENTINEL_FIELDS = new Set([
  '__pipeline__',
  '__comments__',
  '__tasks__',
  '__addendums__',
  '__referenced_by__',
  '__related_records__',
  '__owners__',
  '__pdf__',
  '__subtitle__'
])
export const PRESET_SPECIAL_GROUP_KEYS = new Set(['__apply_values__', '__create_with_defaults__'])
export const isM2MIfacePreset = (ifc: string | null | undefined) =>
  ifc === 'select-multiple-m2m' || (ifc ?? '').endsWith('-m2m')

export function ColumnPresetRow({
  preset,
  optionGroups,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast
}: {
  preset: ColumnPresetItem
  optionGroups: PresetOptionGroup[]
  onChange: (p: ColumnPresetItem) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const [colsOpen, setColsOpen] = useState(false)
  const allOptions = useMemo(() => optionGroups.flatMap((g) => g.options), [optionGroups])
  // Stored columns not present in the current option set (layout changed, drawer
  // relation removed, etc.) — surfaced as removable warning chips, never silently dropped.
  const staleTokens = preset.columns.filter((c) => !allOptions.some((o) => o.field === c))
  return (
    <div className='space-y-1.5 rounded border border-slate-200 p-2 dark:border-border'>
      <div className='flex items-center gap-1.5'>
        <Input
          data-setting='field.column_presets.name'
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          placeholder='Preset name'
          className='h-7 flex-1 text-[11px]'
        />
        <button
          type='button'
          onClick={onMoveUp}
          disabled={isFirst}
          className='shrink-0 text-slate-400 hover:text-nvr-cyan disabled:opacity-30 disabled:hover:text-slate-400'
        >
          <ChevronUp className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onMoveDown}
          disabled={isLast}
          className='shrink-0 text-slate-400 hover:text-nvr-cyan disabled:opacity-30 disabled:hover:text-slate-400'
        >
          <ChevronDown className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onRemove}
          className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
        >
          ✕
        </button>
      </div>
      <Popover open={colsOpen} onOpenChange={setColsOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-setting='field.column_presets.columns'
            className='w-full flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-left hover:border-slate-400 dark:bg-card dark:border-border'
          >
            <span
              className={cn(
                'truncate',
                preset.columns.length ? 'text-slate-700 dark:text-foreground' : 'text-slate-400'
              )}
            >
              {preset.columns.length
                ? preset.columns
                    .map((f) => allOptions.find((o) => o.field === f)?.label || f)
                    .join(', ')
                : 'No columns selected'}
            </span>
            <ChevronDown className='h-3.5 w-3.5 text-slate-400 ml-1 shrink-0' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-72 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
            <CommandList className='max-h-[260px]'>
              {optionGroups.map((group, gi) => (
                <CommandGroup key={group.heading ?? `__layout_${gi}`} heading={group.heading}>
                  {group.options.map((f) => {
                    const checked = preset.columns.includes(f.field)
                    return (
                      <CommandItem
                        key={f.field}
                        value={`${f.label} ${f.field}`}
                        onSelect={() =>
                          onChange({
                            ...preset,
                            columns: checked
                              ? preset.columns.filter((x) => x !== f.field)
                              : [...preset.columns, f.field]
                          })
                        }
                        className='text-[11px] flex items-center gap-2'
                      >
                        <Check
                          className={cn('h-3 w-3 shrink-0', checked ? 'opacity-100' : 'opacity-0')}
                        />
                        <span className='flex-1 truncate'>{f.label}</span>
                        <span className='font-mono text-[11px] text-slate-400 shrink-0'>
                          {f.field}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {staleTokens.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {staleTokens.map((token) => (
            <span
              key={token}
              title='Not in the current layout or relation set'
              className='inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-700/60 dark:bg-amber-400/10 dark:text-amber-300'
            >
              {token}
              <button
                type='button'
                onClick={() =>
                  onChange({ ...preset, columns: preset.columns.filter((x) => x !== token) })
                }
                className='text-amber-500 hover:text-amber-800'
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function DrawerRelationRow({
  entry,
  relationOptions,
  capFieldOptions,
  onChange,
  onRemove
}: {
  entry: DrawerRelationItem
  relationOptions: Array<{ value: string; label: string; collection: string }>
  capFieldOptions: Array<{ field: string; label?: string | null }>
  onChange: (e: DrawerRelationItem) => void
  onRemove: () => void
}) {
  const api = useEditorApi()
  const [fieldOpen, setFieldOpen] = useState(false)
  const [sumOpen, setSumOpen] = useState(false)
  const [capOpen, setCapOpen] = useState(false)

  // sum_field is summed over the GRANDCHILD rows the relation points at
  // (NestedRelationEditor reads it off each nested row), not the child row
  // itself — so its options must come from the selected relation's target
  // collection, resolved fresh per entry.
  const grandCollection = relationOptions.find((r) => r.value === entry.field)?.collection ?? null
  const { data: grandFields = [] } = useQuery<
    Array<{ field: string; label?: string | null; type?: string; hidden?: boolean }>
  >({
    queryKey: ['field-config-all', grandCollection],
    queryFn: () => api.get(`/field-config/${grandCollection}`).then((r) => r.data.data ?? []),
    enabled: !!grandCollection,
    staleTime: 5 * 60 * 1000
  })
  const sumFieldOptions = useMemo(
    () =>
      grandFields.filter(
        (f) => !f.hidden && f.field !== 'id' && NUMERIC_FIELD_TYPES.has(f.type ?? '')
      ),
    [grandFields]
  )

  return (
    <div className='space-y-1.5 rounded border border-slate-200 p-2 dark:border-border'>
      <div className='flex items-center gap-1.5'>
        <Popover open={fieldOpen} onOpenChange={setFieldOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0 dark:bg-card dark:border-border'
            >
              {entry.field ? (
                (relationOptions.find((f) => f.value === entry.field)?.label ?? entry.field)
              ) : (
                <span className='text-slate-400'>relation…</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-56 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  {relationOptions.map((f) => (
                    <CommandItem
                      key={f.value}
                      value={f.value}
                      onSelect={() => {
                        // Changing the relation changes the grandchild collection,
                        // so a previously-chosen sum_field can no longer be valid.
                        onChange({ ...entry, field: f.value, sumField: '' })
                        setFieldOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <button
          type='button'
          onClick={onRemove}
          className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
        >
          ✕
        </button>
      </div>
      <div className='flex items-center gap-1.5' data-setting='field.drawer_relations.hint'>
        <span className='text-[11px] text-slate-400 shrink-0 w-6'>sum</span>
        <Popover open={sumOpen} onOpenChange={setSumOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              disabled={!grandCollection}
              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0 disabled:opacity-50 disabled:hover:border-slate-200 dark:bg-card dark:border-border'
            >
              {entry.sumField ? (
                (sumFieldOptions.find((f) => f.field === entry.sumField)?.label ?? entry.sumField)
              ) : (
                <span className='text-slate-400'>
                  {grandCollection ? 'none' : 'select relation first'}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-48 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  <CommandItem
                    value='__none__'
                    onSelect={() => {
                      onChange({ ...entry, sumField: '' })
                      setSumOpen(false)
                    }}
                    className='text-[12px] text-slate-500'
                  >
                    — None
                  </CommandItem>
                  {sumFieldOptions.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={f.field}
                      onSelect={() => {
                        onChange({ ...entry, sumField: f.field })
                        setSumOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label || f.field}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <span className='text-[11px] text-slate-400 shrink-0 w-6'>cap</span>
        <Popover open={capOpen} onOpenChange={setCapOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0 dark:bg-card dark:border-border'
            >
              {entry.capField ? (
                (capFieldOptions.find((f) => f.field === entry.capField)?.label ?? entry.capField)
              ) : (
                <span className='text-slate-400'>none</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-48 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  <CommandItem
                    value='__none__'
                    onSelect={() => {
                      onChange({ ...entry, capField: '' })
                      setCapOpen(false)
                    }}
                    className='text-[12px] text-slate-500'
                  >
                    — None
                  </CommandItem>
                  {capFieldOptions.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={f.field}
                      onSelect={() => {
                        onChange({ ...entry, capField: f.field })
                        setCapOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label || f.field}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
